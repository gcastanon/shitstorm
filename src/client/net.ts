import { Client, Room } from "colyseus.js";
import type { Tuning } from "../shared/tuning";
import type { InputCommand } from "../shared/types";
import type { StructureBox } from "../shared/structures";
import type { AsteroidSim } from "../shared/asteroids";
import type { ProjectileSim } from "../shared/projectiles";

export interface RemoteSnapshotPlayer {
  id: string;
  name: string;
  character: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  lastSeq: number;
  health: number;
  maxHealth: number;
  invulnUntilTick: number;
  /** Ability counters, in ticks. The predictor reconciles against these. */
  dashTicks: number;
  dashCdTicks: number;
  attackCdTicks: number;
  specialCdTicks: number;
  specialTicks: number;
  pullTicks: number;
  pullAnchorX: number;
  pullAnchorY: number;
  pullDecayTicks: number;
  hookActive: boolean;
  hookX: number;
  hookY: number;
  /** How many allies this player is carrying. The ids are not needed to draw it. */
  swallowedCount: number;
  carriedBy: string;
  lifeState: number;
  skulls: number;
  reviveTicks: number;
  /** Perk ids taken, and the three currently offered. Only ids cross the wire —
   *  both sides fold them into numbers with the same applyPerks. */
  perks: string[];
  offer: string[];
  hasPicked: boolean;
  /** Whether this player has spent their one pause this level. */
  pauseUsed: boolean;
  /** The ultimate, its upgrades, and its once-per-level charge. Ids only, same
   *  as perks — both sides derive the effect from them. */
  ultimateId: string;
  ultimateUpgrades: string[];
  ultReady: boolean;
  ultTicks: number;
  /** Bumped every time this player's ultimate actually fires, echoes included.
   *  The only thing that can carry an instant ultimate's cast to the client. */
  ultCasts: number;
  /** Counters for the Dungeon Master's summary, level and run side by side. */
  stats: PlayerStats;
}

export interface PlayerStats {
  lvlDamageTaken: number; runDamageTaken: number;
  lvlChunksKilled: number; runChunksKilled: number;
  lvlDowns: number; runDowns: number;
  lvlSkulls: number; runSkulls: number;
  lvlRevives: number; runRevives: number;
  lvlDownedTicks: number; runDownedTicks: number;
  lvlUltimates: number; runUltimates: number;
  lvlLives: number; runLives: number;
}

export interface TeamStats {
  lvlChunksSpawned: number; runChunksSpawned: number;
  lvlChunksKilled: number; runChunksKilled: number;
  lvlStructuresLost: number; runStructuresLost: number;
  lvlTicks: number; runTicks: number;
}

export interface Snapshot {
  /** Local receive time in ms (performance.now clock). */
  t: number;
  tick: number;
  players: Map<string, RemoteSnapshotPlayer>;
}

export class NetClient {
  room!: Room;
  tuning!: Tuning;
  snapshots: Snapshot[] = [];
  /**
   * Structures in server array order. Prediction resolves collision in this
   * exact order, so it must never be re-sorted or filtered in place.
   */
  structures: StructureBox[] = [];
  /**
   * Latest known sewage, plus when it arrived. Not interpolated from history:
   * chunks travel in perfectly straight lines, so extrapolating forward from the
   * newest snapshot is exact, and it keeps them in the same timeframe as the
   * predicted local player. Interpolating them instead would draw them 100ms
   * behind the player dodging them.
   */
  asteroids: AsteroidSim[] = [];
  /** Arrows, extrapolated the same way and from the same snapshot as sewage. */
  projectiles: ProjectileSim[] = [];
  /** When the newest snapshot arrived, which both of the above extrapolate from. */
  snapshotAt = 0;
  serverTick = 0;
  rttMs = 0;
  /** OUTCOME_PLAYING / OUTCOME_WON / OUTCOME_LOST, and when the level ends. */
  outcome = 0;
  levelEndTick = 0;
  level = 1;
  pendingLevel = 1;
  intermissionEndTick = 0;
  /** Extra lives the party has left. Shared, so this is one number for everyone. */
  lives = 0;
  /**
   * The boss, or null on an ordinary level. Not predicted — server-owned like
   * the sewage it is made of, and drawn from the newest snapshot.
   */
  boss: {
    kind: string; x: number; y: number; hp: number; maxHp: number;
    radius: number; phase: number; razing: boolean;
  } | null = null;
  /** The DM's live difficulty slider. */
  bossDifficulty = 1;
  /** A level the DM has armed a jump to, or 0. */
  forcedNextLevel = 0;
  /** Cover is indestructible for the rest of this level (Consecrate), and turns
   *  sewage away rather than eating it (Spires). */
  coverWarded = false;
  coverReflects = false;

  /** The party's run score, and the breakdown of the last level's award. */
  score = 0;
  lastScore = { chunks: 0, boss: 0, huts: 0, walls: 0, total: 0, level: 0 };

  /** True when this client joined as the Dungeon Master. */
  isDm = false;
  dmPresent = false;
  dmName = "";
  /** The DM is only watching, so levels start on their own. */
  dmPassive = false;
  /** Who paused, and their name. Empty when the game is running. */
  pausedBy = "";
  pausedByName = "";
  team: TeamStats = {
    lvlChunksSpawned: 0, runChunksSpawned: 0,
    lvlChunksKilled: 0, runChunksKilled: 0,
    lvlStructuresLost: 0, runStructuresLost: 0,
    lvlTicks: 0, runTicks: 0,
  };
  /** Wave state. wavePhaseEndTick is what the lull countdown reads. */
  waveIndex = 0;
  waveSpawning = true;
  wavePhaseEndTick = 0;

  private pingTimer?: ReturnType<typeof setInterval>;

  get sessionId() {
    return this.room.sessionId;
  }

  async connect(endpoint: string, character: string, name: string, role?: "dm"): Promise<void> {
    const client = new Client(endpoint);
    this.isDm = role === "dm";
    this.room = await client.joinOrCreate("arena", { character, name, role });

    // Tuning arrives from the server, so the client never holds its own copy.
    const tuning = await new Promise<Tuning>((resolve) => {
      this.room.onMessage("tuning", (t: Tuning) => resolve(t));
    });
    this.tuning = tuning;

    // Poll state rather than binding schema callbacks: MapSchema.forEach is
    // stable across Colyseus versions, the callback API is not.
    this.room.onStateChange((state: any) => {
      const players = new Map<string, RemoteSnapshotPlayer>();
      state.players.forEach((p: any, id: string) => {
        players.set(id, {
          id,
          name: p.name,
          character: p.character,
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          aim: p.aim,
          lastSeq: p.lastSeq,
          health: p.health,
          maxHealth: p.maxHealth,
          invulnUntilTick: p.invulnUntilTick,
          dashTicks: p.dashTicks,
          dashCdTicks: p.dashCdTicks,
          attackCdTicks: p.attackCdTicks,
          specialCdTicks: p.specialCdTicks,
          specialTicks: p.specialTicks,
          pullTicks: p.pullTicks,
          pullAnchorX: p.pullAnchorX,
          pullAnchorY: p.pullAnchorY,
          pullDecayTicks: p.pullDecayTicks,
          hookActive: p.hookActive,
          hookX: p.hookX,
          hookY: p.hookY,
          swallowedCount: p.swallowedIds?.length ?? 0,
          carriedBy: p.carriedBy,
          lifeState: p.lifeState,
          skulls: p.skulls,
          reviveTicks: p.reviveTicks,
          perks: [...(p.perks ?? [])],
          offer: [...(p.offer ?? [])],
          hasPicked: !!p.hasPicked,
          pauseUsed: !!p.pauseUsed,
          ultimateId: p.ultimateId ?? "",
          ultimateUpgrades: [...(p.ultimateUpgrades ?? [])],
          ultReady: !!p.ultReady,
          ultTicks: p.ultTicks ?? 0,
          ultCasts: p.ultCasts ?? 0,
          stats: {
            lvlDamageTaken: p.lvlDamageTaken, runDamageTaken: p.runDamageTaken,
            lvlChunksKilled: p.lvlChunksKilled, runChunksKilled: p.runChunksKilled,
            lvlDowns: p.lvlDowns, runDowns: p.runDowns,
            lvlSkulls: p.lvlSkulls, runSkulls: p.runSkulls,
            lvlRevives: p.lvlRevives, runRevives: p.runRevives,
            lvlDownedTicks: p.lvlDownedTicks, runDownedTicks: p.runDownedTicks,
            lvlUltimates: p.lvlUltimates, runUltimates: p.runUltimates,
            lvlLives: p.lvlLives, runLives: p.runLives,
          },
        });
      });
      // Structures change rarely, but rebuilding the array is ~20 objects and
      // avoids holding live schema references inside the simulation.
      this.structures = state.structures.map((s: any) => ({
        id: s.id, kind: s.kind,
        x: s.x, y: s.y, w: s.w, h: s.h,
        hp: s.hp, maxHp: s.maxHp,
      }));

      this.asteroids = state.asteroids.map((a: any) => ({
        id: a.id, tier: a.tier, hits: a.hits ?? 1, x: a.x, y: a.y, vx: a.vx, vy: a.vy,
      }));
      this.projectiles = state.projectiles.map((p: any) => ({
        id: p.id, owner: p.owner, x: p.x, y: p.y, vx: p.vx, vy: p.vy, travelled: 0,
      }));
      this.snapshotAt = performance.now();
      this.serverTick = state.tick;
      this.outcome = state.outcome;
      this.levelEndTick = state.levelEndTick;
      this.level = state.level;
      this.lives = state.lives ?? 0;
      this.score = state.score ?? 0;
      this.bossDifficulty = state.bossDifficulty ?? 1;
      this.forcedNextLevel = state.forcedNextLevel ?? 0;
      // Consecrate's two states. coverReflects has been synced since Spires was
      // built, with a comment saying the client would draw warded cover
      // differently — it never did until now.
      this.coverWarded = !!state.coverWarded;
      this.coverReflects = !!state.coverReflects;
      const b = state.boss;
      this.boss = b && b.kind
        ? {
          kind: b.kind, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp,
          radius: b.radius, phase: b.phase, razing: !!b.razing,
        }
        : null;
      this.lastScore = {
        chunks: state.lastScoreChunks ?? 0,
        boss: state.lastScoreBoss ?? 0,
        huts: state.lastScoreHuts ?? 0,
        walls: state.lastScoreWalls ?? 0,
        total: state.lastScoreTotal ?? 0,
        level: state.lastScoreLevel ?? 0,
      };
      this.pendingLevel = state.pendingLevel;
      this.intermissionEndTick = state.intermissionEndTick;
      this.dmPresent = !!state.dm?.present;
      this.dmName = state.dm?.name ?? "";
      this.dmPassive = !!state.dm?.passive;
      this.pausedBy = state.pausedBy ?? "";
      this.pausedByName = state.pausedByName ?? "";
      this.team = {
        lvlChunksSpawned: state.lvlChunksSpawned, runChunksSpawned: state.runChunksSpawned,
        lvlChunksKilled: state.lvlChunksKilled, runChunksKilled: state.runChunksKilled,
        lvlStructuresLost: state.lvlStructuresLost, runStructuresLost: state.runStructuresLost,
        lvlTicks: state.lvlTicks, runTicks: state.runTicks,
      };
      this.waveIndex = state.waveIndex;
      this.waveSpawning = state.waveSpawning;
      this.wavePhaseEndTick = state.wavePhaseEndTick;

      this.snapshots.push({ t: performance.now(), tick: state.tick, players });
      // Keep ~1s of history; more than that is only useful for lag compensation.
      const cutoff = performance.now() - 1000;
      while (this.snapshots.length > 2 && this.snapshots[0].t < cutoff) this.snapshots.shift();
    });

    this.room.onMessage("pong", (sentAt: number) => {
      this.rttMs = performance.now() - sentAt;
    });
    this.pingTimer = setInterval(() => this.room.send("ping", performance.now()), 1000);
  }

  sendInput(cmd: InputCommand) {
    this.room.send("input", cmd);
  }

  dispose() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.room?.leave();
  }
}

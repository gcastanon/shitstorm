import { Room } from "@colyseus/core";
import type { Client } from "@colyseus/core";
import {
  GameState, Player, Structure, Asteroid, addStat, resetStats,
  OUTCOME_PLAYING, OUTCOME_WON, OUTCOME_LOST, OUTCOME_WAITING, OUTCOME_COUNTDOWN,
} from "./GameState";
import { ReviveSystem } from "./ReviveSystem";
import { LIFE_ALIVE, LIFE_DEAD, LIFE_DOWNED } from "../shared/types";
import { applyPerks, meleeSweep, perkById, rollOffer } from "../shared/perks";
import {
  arrowStormCount, cathedralRadiusMul, devourHealMul, devourRadiusMul, hasUpgrade,
  slowStormFactor, ultimateById, ultimateDurationSec, ultimateEchoSec, ultimatesFor,
  upgradeById, upgradesFor,
  DEVOUR_HEAL_PER_CHUNK, DEVOUR_REACH_MUL, REBIRTH_HEALTH_BONUS, RECKONING_PHASE_SEC,
} from "../shared/ultimates";
import { TIER_LARGE } from "../shared/asteroids";
import { mulberry32, isStanding } from "../shared/structures";
import { scoreForLevel } from "../shared/score";
import { BossSystem } from "./BossSystem";
import { BOSS_CLOG, BOSS_NONE } from "../shared/types";
import { nextBossLevel } from "../shared/boss";

/** Hit points one Salvage trigger puts back into a damaged structure. */
const SALVAGE_REPAIR = 10;
import { loadTuning } from "./tuningLoader";
import { fixedDtSec, secToTicks, spawnPoint, stepPlayer, throneBubbleRadius } from "../shared/sim";
import { isCharacterId, type CharacterId, type InputCommand } from "../shared/types";
import { generateLayout, type StructureBox } from "../shared/structures";
import { AsteroidSystem, type Bubble } from "./AsteroidSystem";
import { ProjectileSystem } from "./ProjectileSystem";
import { GrappleSystem } from "./GrappleSystem";
import { SwallowSystem, addHealth } from "./SwallowSystem";
import type { Tier } from "../shared/asteroids";
import type { Tuning } from "../shared/tuning";

interface JoinOptions {
  character?: string;
  name?: string;
  /** "dm" joins as the Dungeon Master; anything else joins as a player. */
  role?: string;
}

export class ArenaRoom extends Room<GameState> {
  private tuning!: Tuning;
  private fixedDtMs = 1000 / 30;
  private accumulator = 0;
  private queues = new Map<string, InputCommand[]>();
  private joinIndex = 0;
  /** Plain mirror of state.structures, so the sim never walks schema objects. */
  private boxes: StructureBox[] = [];
  private asteroids!: AsteroidSystem;
  private bosses!: BossSystem;
  /** A wipe the DM skipped away from still resets the run; see endLevel. */
  private restartOnNextStart = false;
  private projectiles!: ProjectileSystem;
  private grapples!: GrappleSystem;
  private swallows!: SwallowSystem;
  private revives!: ReviveSystem;

  override onCreate() {
    this.tuning = loadTuning();
    // Room for the three characters plus a Dungeon Master. onJoin still caps
    // players at maxPlayers itself, because this number alone would otherwise
    // let a fourth *player* in and put them on top of someone's spawn.
    this.maxClients = this.tuning.player.maxPlayers + 1;
    this.fixedDtMs = 1000 / this.tuning.net.tickHz;

    this.setState(new GameState());
    this.setPatchRate(1000 / this.tuning.net.patchHz);

    this.buildLayout(this.tuning.level.seed);
    this.asteroids = new AsteroidSystem(this.tuning, this.state, this.tuning.level.seed);
    this.bosses = new BossSystem(this.tuning, this.state);
    this.projectiles = new ProjectileSystem(this.tuning, this.state);
    this.grapples = new GrappleSystem(this.tuning, this.state);
    this.swallows = new SwallowSystem(this.tuning, this.state);
    this.revives = new ReviveSystem(this.tuning, this.state);

    // Open waiting to be started rather than mid-level. With no DM connected
    // advanceIntermission starts it on the next tick anyway.
    this.state.outcome = OUTCOME_WAITING;
    this.state.pendingLevel = 1;

    this.onMessage("input", (client, cmd: InputCommand) => {
      const q = this.queues.get(client.sessionId);
      if (!q || !isValidCommand(cmd)) return;
      // Cap the backlog. A client that floods gets its oldest inputs dropped
      // rather than banking movement to spend later.
      if (q.length > this.tuning.net.maxCommandsPerTick * 8) q.shift();
      q.push(cmd);
    });

    this.onMessage("ping", (client, sentAt: number) => {
      client.send("pong", sentAt);
    });

    // Debug helper. M4 removes this once downed/revive is real. The split hook
    // that used to live here is gone: the attack button does that job now.
    this.onMessage("dm:start", (client) => {
      if (client.sessionId !== this.state.dm.sessionId) return;
      if (this.state.outcome !== OUTCOME_WAITING) return;
      this.startLevel(this.state.pendingLevel);
    });

    /**
     * Pause and resume.
     *
     * A room message rather than a button bit, and that is forced rather than
     * chosen: BINDINGS map to the bitmask, the bitmask arrives through the
     * command queue, and a pause is precisely the thing that stops the queue
     * being consumed — an unpause sent that way could never arrive. Message
     * handlers run outside fixedTick, so they still work while frozen.
     */
    this.onMessage("pause:toggle", (client) => this.togglePause(client.sessionId));

    /**
     * The Dungeon Master's boss difficulty slider.
     *
     * Stored rather than applied: BossSystem reads it every tick, so dragging it
     * mid-fight takes effect on the next one. Clamped here as well as on read,
     * because a client is not trusted with a number this powerful.
     */
    /**
     * Jump the run to the next boss level. A testing tool, and deliberately the
     * DM's alone.
     *
     * Two paths, because it is useful in both places. Pressed while the room is
     * waiting to start, it retargets the level about to begin. Pressed mid-level
     * it arms `forcedNextLevel`, which endLevel honours — otherwise endLevel
     * would overwrite pendingLevel with level + 1 the moment the level finished
     * and the press would silently do nothing.
     */
    this.onMessage("dm:skipToBoss", (client) => this.skipToBoss(client.sessionId));

    this.onMessage("dm:difficulty", (client, value: number) => {
      if (client.sessionId !== this.state.dm.sessionId) return;
      const { difficultyMin, difficultyMax } = this.tuning.boss;
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      this.state.bossDifficulty = Math.max(difficultyMin, Math.min(difficultyMax, v));
      console.log(`[arena ${this.roomId}] boss difficulty -> ${this.state.bossDifficulty}`);
    });

    // Watching rather than running it. Same sender check as dm:start — nobody
    // but the DM decides whether the door is being held.
    this.onMessage("dm:passive", (client, on: boolean) => {
      if (client.sessionId !== this.state.dm.sessionId) return;
      this.state.dm.passive = !!on;
      console.log(`[arena ${this.roomId}] DM is now ${on ? "passive" : "running the room"}`);
    });

    this.onMessage("perk:pick", (client, id: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hasPicked) return;
      // Only something actually offered to this player. A client asking for a
      // perk it was not shown gets ignored rather than trusted.
      if (typeof id !== "string" || !p.offer.includes(id)) return;
      this.takePerk(p, id);
    });

    this.onMessage("debug:heal", (client) => {
      if (!this.tuning.debug.allowHealthReset) return;
      const p = this.state.players.get(client.sessionId);
      if (p) p.health = p.maxHealth;
    });

    this.setSimulationInterval((deltaMs) => this.onSimulate(deltaMs));

    console.log(`[arena ${this.roomId}] created; ${this.tuning.net.tickHz}Hz tick, ${this.tuning.net.patchHz}Hz patch`);
  }

  override onJoin(client: Client, options: JoinOptions = {}) {
    const name = (options.name ?? "").slice(0, 16);

    if (options.role === "dm") {
      // One at a time. Rejecting is kinder than silently seating them as a
      // player, which is not what they asked for.
      if (this.state.dm.present) throw new Error("this room already has a Dungeon Master");

      this.state.dm.sessionId = client.sessionId;
      this.state.dm.name = name || `dm-${client.sessionId.slice(0, 4)}`;
      this.state.dm.present = true;

      client.send("tuning", this.tuning);
      console.log(`[arena ${this.roomId}] + ${this.state.dm.name} as DUNGEON MASTER`);
      return;
    }

    if (this.state.players.size >= this.tuning.player.maxPlayers) {
      throw new Error("this room is full");
    }

    const character: CharacterId = isCharacterId(options.character) ? options.character : "ranger";
    const spawn = spawnPoint(this.joinIndex++, this.tuning);

    const p = new Player();
    p.sessionId = client.sessionId;
    p.name = name || `player-${client.sessionId.slice(0, 4)}`;
    p.character = character;
    p.x = spawn.x;
    p.y = spawn.y;
    p.maxHealth = this.tuning.player.startHealth;
    p.health = p.maxHealth;

    this.recomputeMods(p);
    this.state.players.set(client.sessionId, p);
    this.queues.set(client.sessionId, []);

    // Clients never hardcode tuning; they get the server's copy on join.
    client.send("tuning", this.tuning);
    console.log(`[arena ${this.roomId}] + ${p.name} as ${character} (${this.clients.length}/${this.maxClients})`);
  }

  override onLeave(client: Client) {
    if (this.state.dm.sessionId === client.sessionId) {
      this.state.dm.sessionId = "";
      this.state.dm.name = "";
      this.state.dm.present = false;
      // Whatever was waiting on them is now unblocked, since the auto-start
      // fallback applies the moment no DM is connected.
      console.log(`[arena ${this.roomId}] - dungeon master left`);
      return;
    }

    // Only the pauser can lift a pause, so a pauser who leaves would freeze the
    // room forever. This is not a second unpauser — it is the case where the one
    // person who could press the key no longer exists.
    if (this.state.pausedBy === client.sessionId) {
      this.state.pausedBy = "";
      this.state.pausedByName = "";
      console.log(`[arena ${this.roomId}] the paused player left; resuming`);
    }

    // Break any swallow this player was half of, in both directions. A Druid who
    // disconnects mid-swallow would otherwise leave a passenger with carriedBy
    // still set — no input, no movement, and nobody left to release them.
    const leaving = this.state.players.get(client.sessionId);
    if (leaving) {
      for (const id of [...leaving.swallowedIds] as string[]) {
        const passenger = this.state.players.get(id);
        if (passenger) passenger.carriedBy = "";
      }
    }
    this.state.players.forEach((p) => {
      if (p.carriedBy === client.sessionId) p.carriedBy = "";
      const i = p.swallowedIds.indexOf(client.sessionId);
      if (i >= 0) p.swallowedIds.splice(i, 1);
      if (p.swallowedIds.length === 0 && p.swallowUntilTick > 0) {
        p.swallowUntilTick = 0;
        p.specialTicks = 0;
      }
    });

    this.state.players.delete(client.sessionId);
    this.queues.delete(client.sessionId);
    console.log(`[arena ${this.roomId}] - ${client.sessionId}`);
  }

  override onDispose() {
    console.log(`[arena ${this.roomId}] disposed`);
  }

  /**
   * Accumulator loop. setSimulationInterval fires on a best-effort timer, so we
   * convert its jittery delta into a whole number of fixed steps. Everything in
   * the game must run inside fixedTick, never here.
   */
  private onSimulate(deltaMs: number) {
    this.accumulator += deltaMs;
    let guard = 0;
    while (this.accumulator >= this.fixedDtMs && guard++ < 10) {
      this.accumulator -= this.fixedDtMs;
      this.fixedTick();
    }
    if (guard >= 10) this.accumulator = 0; // recover from a long stall
  }

  private fixedTick() {
    // Paused. Returning before tick++ is the whole mechanism, and it is chosen
    // rather than a set of "if paused, skip" guards because every deadline in
    // this game is an absolute tick — levelEndTick, wavePhaseEndTick,
    // invulnUntilTick, swallowUntilTick, ultEchoTick, slowUntilTick,
    // coverPhaseUntilTick, intermissionEndTick. A clock that does not advance
    // leaves all eight correct on resume with no bookkeeping, and cannot be
    // broken by a ninth being added later.
    //
    // Command queues are deliberately left alone. The client stops producing, so
    // only the two or three already in flight remain, and they drain and get
    // acked normally. Dropping them unacked would leave the client replaying
    // them forever, which is a permanent divergence rather than a frame of lag.
    if (this.state.pausedBy !== "") return;

    const dt = fixedDtSec(this.tuning);
    this.state.tick++;

    // Cleared before any input is read, so a player who sends nothing this tick
    // simply stops counting as a reviver rather than coasting on a stale flag.
    this.state.players.forEach((p) => { p.revivingIntent = false; });

    this.state.players.forEach((p, sessionId) => {
      const q = this.queues.get(sessionId);
      if (!q) return;

      let consumed = 0;
      while (q.length > 0 && consumed < this.tuning.net.maxCommandsPerTick) {
        const cmd = q.shift()!;
        // stepPlayer owns movement and the cooldown counters, both of which the
        // client predicts. It only reports that an ability fired; turning that
        // into world state is this side's job alone.
        const fired = stepPlayer(p as any, cmd, dt, this.tuning, this.boxes);
        p.aim = cmd.aim;
        p.lastSeq = cmd.seq;

        if (fired.dashStarted) this.onDashStarted(p);
        if (fired.attackFired) this.resolveAttack(p, cmd.aim);
        if (fired.specialFired) this.resolveSpecial(p, cmd.aim);
        if (fired.ultimateFired) this.resolveUltimate(p, cmd.aim);
        if (fired.lifeClaimed) this.claimLife(p);

        // Reviving asks for someone stood still doing nothing, which is exactly
        // an empty command.
        p.revivingIntent = cmd.move.x === 0 && cmd.move.y === 0 && cmd.buttons === 0;

        consumed++;
      }

      // Deliberately no fallback step when the queue is starved. Advancing a
      // player on a tick the client never sent a command for makes the server's
      // state unreproducible from the command stream, and the client's replay
      // then converges to a permanently wrong position. Network jitter means
      // some ticks get 0 commands and the next gets 2; maxCommandsPerTick lets
      // the catch-up happen, and the end position is identical either way.
      //
      // Systems that must run every tick regardless of input (sewage movement,
      // collision, regen) belong outside this loop. See the asteroid update below.
    });

    // Once the level is decided the world stops: no new sewage, no damage, no
    // revive progress. Players keep their movement so they can walk around the
    // result rather than being frozen mid-stride, and the intermission counts
    // down on the same fixed step as everything else.
    if (this.state.outcome !== OUTCOME_PLAYING) {
      this.advanceIntermission();
      return;
    }

    this.asteroids.update(dt, this.boxes, {
      onStructureHit: (id, damage) => this.damageStructure(id, damage),
      onPlayerHit: (sessionId, damage, tier) => this.damagePlayer(sessionId, damage, tier),
      onSpawn: () => { this.state.lvlChunksSpawned++; this.state.runChunksSpawned++; },
    }, this.activeBubbles());

    this.updateBoss(dt);

    this.state.lvlTicks++;
    this.state.runTicks++;

    // Both of these advance every tick for the same reason sewage does: an
    // arrow or a hook must not hang in the air because an input queue ran dry.
    this.projectiles.update(dt, this.boxes, {
      onAsteroidHit: (asteroidId, projectileId, heading, owner, destroys) => {
        // The arrow's own id is the swing id, so the two fragments it creates
        // are immune to it and cannot be chained by the same shot.
        if (destroys) this.asteroids.removeById(asteroidId);
        else this.asteroids.splitById(asteroidId, projectileId, heading);
        const shooter = this.state.players.get(owner);
        if (shooter) this.creditKill(shooter);
      },
      hitsBoss: (x, y, r) => this.bosses.hits(x, y, r),
      onBossHit: (owner) => {
        this.hurtBoss(this.tuning.boss.arrowDamage, this.state.players.get(owner) ?? null);
      },
    });

    this.grapples.update(dt, this.boxes, {
      onAsteroidAnchor: (asteroidId, ranger) => this.detonate(asteroidId, ranger),
      hitsBoss: (x, y) => this.bosses.hits(x, y, 0),
      onBossAnchor: (ranger) => this.hurtBoss(this.tuning.boss.grappleDamage, ranger),
    });

    this.swallows.update(dt, (druid) => {
      // cooldownStartsOnRelease. Starting it here rather than on the press is
      // what makes a full swallow cycle 20s: 5s carrying, then 15s of cooldown.
      const sp = this.tuning.characters[druid.character].special;
      if (sp.kind === "swallow") druid.specialCdTicks = secToTicks(sp.cooldownSec, this.tuning);
    });

    this.revives.update();
    this.tickUltimates(dt);
    this.applyRegen(dt);
    this.checkOutcome();
  }

  /**
   * Spend one of the party's shared extra lives.
   *
   * Routed through ReviveSystem.forceRevive, which was written for the Rebirth
   * ultimate and is already the single entry point that undoes death — a life
   * must not grow a second one beside it.
   */
  private claimLife(p: Player) {
    if (p.lifeState === LIFE_ALIVE) return;
    if (this.state.lives <= 0) return;

    this.state.lives--;
    addStat(p, "Lives");
    // Full health rather than the revivedHealthFraction a teammate pickup gives:
    // a life costs a scarce resource three people share, so it buys a reset.
    this.revives.forceRevive(p, true);
    console.log(
      `[arena ${this.roomId}] ${p.name} spent a life (${this.state.lives} left)`,
    );
  }

  /**
   * Jump the run to the next boss level. A testing tool, and the DM's alone.
   *
   * A method rather than a closure in the handler so a probe drives the real
   * decision — the same reason togglePause is one. A test that re-implements
   * this would agree with itself while disagreeing with the game.
   */
  skipToBoss(sessionId: string) {
    if (sessionId !== this.state.dm.sessionId) return;

    const target = nextBossLevel(this.tuning, this.state.level);
    this.state.forcedNextLevel = target;
    // Pressed while the room is already waiting, it retargets the level about to
    // begin. Pressed mid-level, endLevel picks it up — without which endLevel
    // would overwrite pendingLevel and the press would silently do nothing.
    if (this.state.outcome === OUTCOME_WAITING) this.state.pendingLevel = target;

    console.log(`[arena ${this.roomId}] DM armed a skip to level ${target}`);
  }

  /**
   * Pause, or resume a pause you called.
   *
   * A method rather than a closure inside the message handler so it can be
   * driven directly by a probe. A test that re-implements this decision instead
   * would agree with itself perfectly while disagreeing with the game, which is
   * how the predictor's character bug survived for as long as it did.
   */
  togglePause(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p) return; // the DM watches; they do not get to stop the game

    if (this.state.pausedBy !== "") {
      // Only the player who called it may lift it.
      if (this.state.pausedBy !== sessionId) return;
      this.state.pausedBy = "";
      this.state.pausedByName = "";
      console.log(`[arena ${this.roomId}] ${p.name} resumed`);
      return;
    }

    // One each per level, and only while there is something to pause.
    if (p.pauseUsed) return;
    if (this.state.outcome !== OUTCOME_PLAYING && this.state.outcome !== OUTCOME_COUNTDOWN) return;

    p.pauseUsed = true;
    this.state.pausedBy = sessionId;
    this.state.pausedByName = p.name;
    console.log(`[arena ${this.roomId}] ${p.name} paused`);
  }

  /**
   * Win and lose.
   *
   * Nobody standing is a loss only once the extra lives are gone. Ending the
   * level the instant the last player went down would mean nobody ever got the
   * chance to press the button — the lives would be useless in exactly the
   * situation they exist for. With lives left the world keeps running around the
   * fallen, sewage and skulls included, which is what makes spending one urgent
   * rather than free.
   *
   * The timer branch has to check standing too, or a party lying on the floor
   * with lives in hand would win by outlasting the clock. "Any player surviving
   * the timer wins" has always meant somebody upright; that was implicit while
   * all-down ended the level on the spot, and has to be said out loud now.
   *
   * The empty-room guard matters because a room with nobody in it trivially has
   * nobody standing.
   */
  private checkOutcome() {
    if (this.state.outcome !== OUTCOME_PLAYING) return;

    const occupied = this.state.players.size > 0;
    const nobodyStanding = occupied && this.revives.allDown();

    if (this.tuning.level.allThreeDownedIsLoss && nobodyStanding && this.state.lives <= 0) {
      this.endLevel(OUTCOME_LOST, "nobody left standing, no lives left");
      return;
    }

    if (this.state.tick >= this.state.levelEndTick) {
      if (nobodyStanding) this.endLevel(OUTCOME_LOST, "time ran out with nobody standing");
      // On a boss level the timer is a deadline, not a survival test: outlasting
      // it with the thing still alive is a loss, not a win.
      else if (this.bosses.active) this.endLevel(OUTCOME_LOST, `the ${this.state.boss.kind} outlasted them`);
      else this.endLevel(OUTCOME_WON, `survived ${this.tuning.level.durationSec}s`);
    }
  }

  private endLevel(outcome: number, why: string) {
    // Idempotent. checkOutcome already guards itself and fixedTick returns early
    // once a level is decided, so nothing reaches here twice today — but this
    // also awards score and deals perk offers, and a second call would pay both
    // again. Cheap insurance against a future caller that does not know that.
    if (this.state.outcome !== OUTCOME_PLAYING) return;

    this.state.outcome = outcome;
    // Settle what a start would begin right away rather than at awaitStart, so
    // the Dungeon Master's button reads "Start level 4" the moment level 3 ends
    // instead of offering level 3 again while the perks are being picked.
    this.state.pendingLevel = outcome === OUTCOME_WON ? this.state.level + 1 : 1;

    // A skip the DM armed during the level wins over both of those, including
    // after a wipe — a run that has to crawl back from level 1 is exactly what
    // the button exists to avoid.
    //
    // Deliberately NOT cleared here. awaitStart runs after this and sets
    // pendingLevel itself, so a skip consumed at this point would be silently
    // overwritten a moment later — which is exactly what it did until a browser
    // run showed the button arming correctly and the run going to level 2
    // anyway. It is consumed in startLevel, where it is actually used.
    //
    // A wipe skipped away from still has to count as a restart, or startLevel
    // would take `restarting` from `level <= 1`, see level 10, and leave the
    // players who just died lying dead through the boss they were sent to.
    if (this.state.forcedNextLevel > 0) {
      this.state.pendingLevel = this.state.forcedNextLevel;
      if (outcome === OUTCOME_LOST) this.restartOnNextStart = true;
    }
    this.state.intermissionEndTick =
      this.state.tick + secToTicks(this.tuning.level.intermissionSec, this.tuning);

    // Clearing a level earns everyone still standing a pick, and scores the
    // level. A wipe earns nothing — the run is over and about to restart from
    // scratch, score included.
    if (outcome === OUTCOME_WON) {
      this.state.intermissionEndTick =
        this.state.tick + secToTicks(this.tuning.level.choiceTimeoutSec, this.tuning);
      this.awardScore();
      this.dealOffers();
    }

    const label = outcome === OUTCOME_WON ? "WON" : "LOST";
    console.log(`[arena ${this.roomId}] level ${this.state.level} ${label} at tick ${this.state.tick}: ${why}`);
  }

  /**
   * The boss, advanced outside the input loop like the sewage it is made of.
   *
   * The Cathedral is the one thing that stops the Clog: a throne shell blocks
   * sewage, and a boss is sewage, so eight seconds of it is eight seconds the
   * Clog does not advance. It still sheds while held, which makes the shell a
   * way to buy time rather than a way to ignore the fight. It is not reflected —
   * a bubble turning the Clog around would end the level by accident.
   */
  private updateBoss(dt: number) {
    if (!this.bosses.active) return;

    const b = this.state.boss;
    const blocked = b.kind === BOSS_CLOG
      && this.activeBubbles().some((s) => Math.hypot(b.x - s.x, b.y - s.y) <= s.radius + b.radius);

    const ev = {
      onSpit: (x: number, y: number, heading: number) => {
        this.asteroids.spawnAt(x, y, heading);
        this.state.lvlChunksSpawned++;
        this.state.runChunksSpawned++;
      },
      onRaze: (id: string) => {
        const s = this.state.structures.find((x) => x.id === id);
        if (s) this.damageStructure(id, s.hp);
      },
      onTownLost: () => this.endLevel(OUTCOME_LOST, "the Clog finished the town"),
    };

    // update() handles the Wellspring and does the difficulty retune for both;
    // the Clog needs `blocked` passed through, so it retunes and then steps.
    if (b.kind === BOSS_CLOG) {
      this.bosses.retuneNow();
      this.bosses.updateClog(dt, ev, blocked);
    } else {
      this.bosses.update(dt, ev);
    }
  }

  /** Everything that hurts a boss lands here, so one place sees it die. */
  private hurtBoss(amount: number, by: Player | null) {
    if (!this.bosses.active) return;
    if (!this.bosses.damage(amount)) return;

    // Deliberately not credited as a chunk kill: "sewage destroyed" is a count
    // of chunks, and quietly adding one for a boss would make that column lie.
    void by;
    console.log(`[arena ${this.roomId}] ${this.state.boss.kind} destroyed at tick ${this.state.tick}`);
    this.endLevel(OUTCOME_WON, `${this.state.boss.kind} destroyed`);
  }

  /**
   * Score a cleared level and add it to the run.
   *
   * The three components are stored, not just the total, because the breakdown
   * shown to players has to be the one that was actually awarded. Recomputing it
   * client-side would read a house count that startLevel is about to rebuild.
   */
  private awardScore() {
    // Counted by kind: a hut is the town, a wall is cover, and they are worth
    // different amounts.
    let huts = 0, walls = 0;
    this.state.structures.forEach((s) => {
      if (!isStanding(s)) return;
      if (s.kind === "hut") huts++;
      else walls++;
    });

    const award = scoreForLevel(
      this.tuning, this.state.lvlChunksKilled, huts, walls, this.state.level,
      this.bosses.isBossLevel(this.state.level),
    );

    this.state.lastScoreChunks = award.chunks;
    this.state.lastScoreBoss = award.boss;
    this.state.lastScoreHuts = award.huts;
    this.state.lastScoreWalls = award.walls;
    this.state.lastScoreTotal = award.total;
    this.state.lastScoreLevel = this.state.level;
    this.state.score += award.total;

    console.log(
      `[arena ${this.roomId}] level ${this.state.level} scored ${award.total}`
      + ` (${this.state.lvlChunksKilled} sewage, ${huts} huts, ${walls} walls, x${award.mul})`
      + ` — run total ${this.state.score}`,
    );
  }

  /**
   * Roll three perks for everyone who can still use them.
   *
   * Seeded from the level rather than Math.random, so a given run rolls the same
   * offers every time and a bug is reproducible. Dead players are skipped: they
   * are out for the rest of the run, so an offer would be a decision with no
   * effect that the gate below would then have to wait for.
   */
  private dealOffers() {
    const rng = mulberry32((this.tuning.level.seed ^ (this.state.level * 0x9e3779b1)) >>> 0);

    this.state.players.forEach((p) => {
      p.offer.clear();
      p.hasPicked = false;

      if (p.lifeState === LIFE_DEAD) {
        p.hasPicked = true;
        return;
      }
      for (const id of this.offerFor(p, rng)) p.offer.push(id);
      // Nothing left to offer — everything they can take, they have.
      if (p.offer.length === 0) p.hasPicked = true;
    });
  }

  /**
   * What this player is offered for clearing this level.
   *
   * Every fifth level hands out an ultimate instead of a perk: the choice at 5,
   * then an upgrade to it at 10 and 15. Those levels are special enough without
   * also handing out a perk. Everything downstream — the cards, the pick
   * message, the timeout, the DM's gate — is the same pipeline either way,
   * because these are all just ids.
   */
  private offerFor(p: Player, rng: () => number): string[] {
    const count = this.tuning.level.perkOfferCount;
    const milestone = this.state.level % 5 === 0;

    if (milestone && p.ultimateId === "") {
      return ultimatesFor(p.character).map((u) => u.id);
    }
    if (milestone) {
      const left = upgradesFor(p.ultimateId, [...p.ultimateUpgrades] as string[]);
      // Every upgrade taken already: fall through to a perk rather than nothing.
      if (left.length > 0) return left.slice(0, count).map((u) => u.id);
    }
    return rollOffer(p.character, [...p.perks] as string[], rng, count);
  }

  private takePerk(p: Player, id: string) {
    // One pipeline, three destinations.
    if (ultimateById(id)) {
      p.ultimateId = id;
      p.ultReady = true;
    } else if (upgradeById(id)) {
      p.ultimateUpgrades.push(id);
    } else {
      p.perks.push(id);
    }

    p.hasPicked = true;
    p.offer.clear();
    this.recomputeMods(p);

    const label = perkById(id)?.name ?? ultimateById(id)?.name ?? upgradeById(id)?.name ?? id;
    console.log(`[arena ${this.roomId}] ${p.name} took ${label}`);
  }

  /**
   * Fold this player's perks into numbers.
   *
   * The client does exactly the same thing from the same synced ids, which is
   * what keeps the values stepPlayer reads identical on both sides. Max health
   * is applied here too, topping the player up by whatever the increase was so a
   * mid-run Thick Skin is felt immediately rather than at the next heal.
   */
  private recomputeMods(p: Player) {
    p.mods = applyPerks(([...p.perks] as string[]));

    // startHealth, not the character's maxHealth: onJoin has always used the
    // former for everyone, and switching now would be a balance change wearing
    // a perk's clothes.
    const next = this.tuning.player.startHealth + p.mods.maxHealthAdd;
    const gained = next - p.maxHealth;
    p.maxHealth = next;
    if (gained > 0 && p.lifeState === LIFE_ALIVE) p.health = Math.min(next, p.health + gained);
  }

  /** True once nobody is still deciding. */
  private everyonePicked(): boolean {
    let waiting = false;
    this.state.players.forEach((p) => { if (!p.hasPicked) waiting = true; });
    return !waiting;
  }

  /**
   * The intermission, run from the tick loop rather than a timer so it obeys the
   * same fixed step as everything else.
   *
   * A win carries the run forward; a wipe restarts it at level one. Either way
   * the transition happens on its own — there is no ready-up, and adding one
   * would need a lobby this scaffold does not have.
   */
  private advanceIntermission() {
    if (this.state.outcome === OUTCOME_PLAYING) return;

    // The countdown between a level being built and sewage starting to fly. The
    // world is already frozen by the caller, so this only has to wait.
    if (this.state.outcome === OUTCOME_COUNTDOWN) {
      if (this.state.tick < this.state.intermissionEndTick) return;
      this.goLive();
      return;
    }

    if (this.state.outcome === OUTCOME_WAITING) {
      // A DM holds the door — unless they have said they are only watching.
      // Nobody in that chair also means nobody to hold it, which is what keeps
      // solo play and the bot soak from stalling here forever.
      const held = this.tuning.level.requireDmToStart
        && this.state.dm.present
        && !this.state.dm.passive;
      if (held) return;
      this.startLevel(this.state.pendingLevel);
      return;
    }

    if (this.state.outcome === OUTCOME_WON) {
      // Everyone has chosen, or the clock ran out and the choice gets made for
      // whoever is still deliberating. The timeout is what stops one player —
      // or one dead connection — holding the whole room at the level-up screen.
      const timedOut = this.state.tick >= this.state.intermissionEndTick;
      if (!this.everyonePicked() && !timedOut) return;
      if (timedOut) {
        this.state.players.forEach((p) => {
          if (!p.hasPicked && p.offer.length > 0) this.takePerk(p, p.offer[0]!);
          p.hasPicked = true;
        });
      }
      // The timeout auto-*picks*; it no longer auto-*starts*. Everyone having
      // chosen hands the decision to the Dungeon Master rather than rolling on.
      this.awaitStart(this.state.level + 1);
      return;
    }

    if (this.state.tick < this.state.intermissionEndTick) return;
    this.awaitStart(1);
  }

  /** Park in the start screen with the next level queued up. */
  private awaitStart(level: number) {
    this.state.outcome = OUTCOME_WAITING;
    // An armed skip outranks whatever would have come next, on both the win path
    // (level + 1) and the wipe path (1).
    this.state.pendingLevel = this.state.forcedNextLevel > 0 ? this.state.forcedNextLevel : level;
    this.state.intermissionEndTick = 0;
    // The resolved level, not the argument — a skip may have redirected it, and
    // logging what was asked for rather than what will happen is how you end up
    // debugging the wrong thing.
    console.log(`[arena ${this.roomId}] waiting to start level ${this.state.pendingLevel}`);
  }

  /**
   * Begin a level. Level 1 is a fresh run: the town is rebuilt and everybody is
   * restored. Any later level inherits the arena as it was left, because
   * structures.repairableBetweenLevels is false, and inherits everyone's life
   * state, because level.deathPersistsAcrossLevels is true. That inheritance is
   * the entire payoff for reviving somebody.
   *
   * This builds the level but does not start it: it ends in OUTCOME_COUNTDOWN,
   * and goLive() below is what lets the sewage fly. Doing every reset first is
   * the point of the countdown — those seconds are spent looking at the rebuilt
   * town from your own spawn, not at a blank screen.
   */
  private startLevel(level: number) {
    // Normally "level 1 is a fresh run". The exception is a wipe the DM skipped
    // away from: the run still ended, so everything still resets, it just does
    // not start at level 1.
    const restarting = level <= 1 || this.restartOnNextStart;
    this.restartOnNextStart = false;
    // Consumed here, where it is finally acted on, rather than in endLevel —
    // awaitStart runs in between and reads it.
    this.state.forcedNextLevel = 0;
    this.state.level = level;
    this.state.pendingLevel = level;
    this.state.outcome = OUTCOME_COUNTDOWN;
    this.state.intermissionEndTick =
      this.state.tick + secToTicks(this.tuning.level.countdownSec, this.tuning);

    // Level counters start fresh; run counters only when the run does.
    this.state.lvlChunksSpawned = 0;
    this.state.lvlChunksKilled = 0;
    this.state.lvlStructuresLost = 0;
    this.state.lvlTicks = 0;
    if (restarting) {
      this.state.runChunksSpawned = 0;
      this.state.runChunksKilled = 0;
      this.state.runStructuresLost = 0;
      this.state.runTicks = 0;
      // A run score dies with the run.
      this.state.score = 0;
      this.state.lastScoreChunks = 0;
      this.state.lastScoreBoss = 0;
      this.state.lastScoreHuts = 0;
      this.state.lastScoreWalls = 0;
      this.state.lastScoreTotal = 0;
      this.state.lastScoreLevel = 0;
    }
    // levelEndTick is deliberately NOT set here. It is set in goLive, so the
    // countdown is not quietly taken out of the level's own clock.

    // A level never begins paused, whatever was happening when the last one ended.
    this.state.pausedBy = "";
    this.state.pausedByName = "";

    // Effects that only last a level.
    this.state.slowFactor = 1;
    this.state.slowUntilTick = 0;
    this.state.coverWarded = false;
    this.state.coverPhaseUntilTick = 0;
    if (restarting) {
      this.state.coverReflects = false;
      this.state.coverRebuildsEachLevel = false;
      // Lives are a whole-run resource, so this is the only place they come
      // back. Refilling them per level would make being down cost nothing.
      this.state.lives = this.tuning.level.extraLives;
    }

    const rebuild = restarting
      || this.tuning.structures.repairableBetweenLevels
      || this.state.coverRebuildsEachLevel;
    if (rebuild) this.buildLayout(this.tuning.level.seed);

    this.asteroids.reset();
    this.projectiles.clear();
    this.state.players.forEach((p) => this.resetForLevel(p, restarting));

    // Boss levels replace their waves with one enormous thing. Seeded off the
    // level so a given run meets it in the same place every time, the way the
    // town layout and the perk offers already are.
    this.bosses.clear();
    if (this.bosses.isBossLevel(level)) {
      this.bosses.spawn(level, mulberry32((this.tuning.level.seed ^ (level * 0x85ebca6b)) >>> 0));
    }

    console.log(
      `[arena ${this.roomId}] level ${level} built, counting down at tick ${this.state.tick}`,
    );
  }

  /**
   * The countdown is over — let the sewage fly.
   *
   * The level clock starts here rather than in startLevel, so the three seconds
   * spent reading "3, 2, 1" are not three seconds of the level you were given.
   */
  private goLive() {
    this.state.outcome = OUTCOME_PLAYING;
    this.state.intermissionEndTick = 0;
    // A boss level runs on its own clock: the timer is a deadline to kill it by
    // rather than a duration to survive, so it needs to be longer.
    const secs = this.bosses.isBossLevel(this.state.level)
      ? this.tuning.boss.durationSec
      : this.tuning.level.durationSec;
    this.state.levelEndTick = this.state.tick + secToTicks(secs, this.tuning);
    console.log(`[arena ${this.roomId}] level ${this.state.level} begins at tick ${this.state.tick}`);
  }

  /**
   * Clear everything transient so nothing survives a level boundary mid-flight:
   * a hook still travelling, a passenger still swallowed, a dash mid-stride.
   * Life state is deliberately not in that list unless the run itself restarted.
   */
  private resetForLevel(p: Player, restarting: boolean) {
    p.dashTicks = 0; p.dashCdTicks = 0;
    p.attackCdTicks = 0;
    p.specialCdTicks = 0; p.specialTicks = 0;
    p.pullTicks = 0; p.pullDecayTicks = 0; p.pullAnchorId = "";
    p.hookActive = false;
    p.swallowedIds.clear(); p.carriedBy = ""; p.swallowUntilTick = 0;
    p.reviveTicks = 0;
    p.invulnUntilTick = 0;
    p.vx = 0; p.vy = 0;
    p.healthFrac = 0;

    p.offer.clear();
    p.hasPicked = false;
    // One pause each, per level.
    p.pauseUsed = false;

    // The once-per-level charge. Anyone holding an ultimate gets it back.
    p.ultReady = p.ultimateId !== "";
    p.ultTicks = 0;
    p.ultEchoTick = 0;

    resetStats(p, "lvl");
    if (restarting) resetStats(p, "run");

    if (restarting) {
      // A wipe ends the run, and the build goes with it — ultimate included.
      p.perks.clear();
      p.ultimateId = "";
      p.ultimateUpgrades.clear();
      p.ultReady = false;
      this.recomputeMods(p);
      p.lifeState = LIFE_ALIVE;
      p.skulls = 0;
      p.health = p.maxHealth;
    } else if (p.lifeState === LIFE_ALIVE && this.tuning.level.healToFullBetweenLevels) {
      p.health = p.maxHealth;
    }
  }

  /**
   * Passive regeneration. Outside the input loop, like everything else that must
   * happen whether or not a player is sending commands — a Druid does not stop
   * healing because their connection hiccuped.
   */
  private applyRegen(dt: number) {
    this.state.players.forEach((p) => {
      const rate = (this.tuning.characters[p.character]?.passiveRegenPerSec ?? 0) + p.mods.regenAdd;
      if (rate > 0) addHealth(p, rate * dt);

      // Verdant spills the Druid's regeneration onto anyone standing close.
      if (!p.mods.verdant || rate <= 0) return;
      const reach = this.tuning.downed.reviveRadius;
      this.state.players.forEach((other) => {
        if (other.sessionId === p.sessionId) return;
        if (Math.hypot(other.x - p.x, other.y - p.y) > reach) return;
        addHealth(other, rate * dt);
      });
    });
  }

  /**
   * A grappled chunk goes up. With Harpoon it takes its neighbours with it,
   * which is the difference between the grapple removing one threat and it
   * clearing a pocket of space to stand in.
   */
  private detonate(asteroidId: string, ranger: Player) {
    const at = this.asteroids.byId(asteroidId);
    const x = at?.x ?? 0;
    const y = at?.y ?? 0;
    this.asteroids.removeById(asteroidId);
    this.creditKill(ranger);
    if (!ranger.mods.harpoon || !at) return;

    const sp = this.tuning.characters[ranger.character].special;
    if (sp.kind !== "grapple") return;
    for (const near of this.asteroids.within(x, y, sp.harpoonBlastRadius)) {
      this.asteroids.removeById(near.id);
      this.creditKill(ranger);
    }
  }

  /**
   * One chunk taken off the board by this player.
   *
   * Credited at the call site rather than inside AsteroidSystem, because the
   * room already knows who is responsible at all three of them — the swinger,
   * the Ranger holding the hook, the owner of the arrow — and the system would
   * have to be told.
   */
  private creditKill(p: Player) {
    addStat(p, "ChunksKilled");
    this.state.lvlChunksKilled++;
    this.state.runChunksKilled++;

    // Scavenger. addHealth refuses anyone who is not LIFE_ALIVE, so a downed
    // player cannot heal their way back up off a kill they could not have made.
    if (p.mods.healPerKill > 0) addHealth(p, p.mods.healPerKill);

    // Salvage. Counted off the player's own running kill total rather than a new
    // field: lvlRunKills already exists, is already reset per level, and a
    // separate counter would be a second thing that could drift from it.
    const every = p.mods.salvageEvery;
    if (every > 0 && p.lvlChunksKilled % every === 0) this.salvage();
  }

  /**
   * Salvage: put a repair into whichever piece of cover needs it most.
   *
   * The most damaged *standing* structure, not the most damaged outright — a
   * flattened hut is rubble and this is a repair, not a rebuild. Masons is still
   * the only thing that brings cover back from zero.
   */
  private salvage() {
    let worst: Structure | null = null;
    this.state.structures.forEach((s) => {
      if (!isStanding(s) || s.hp >= s.maxHp) return;
      if (!worst || s.hp / s.maxHp < worst.hp / worst.maxHp) worst = s;
    });
    if (!worst) return;

    const target = worst as Structure;
    target.hp = Math.min(target.maxHp, target.hp + SALVAGE_REPAIR);
    this.syncBoxes();
  }

  /**
   * The parts of an ultimate that keep happening: delayed repeats, the slow
   * expiring, and the two that chew through sewage while they run.
   *
   * Outside the input loop with everything else that must not stall when a
   * player's commands dry up — an ultimate is not something to lose halfway
   * through because of a hiccup.
   */
  private tickUltimates(dt: number) {
    if (this.state.slowUntilTick > 0 && this.state.tick >= this.state.slowUntilTick) {
      this.state.slowFactor = 1;
      this.state.slowUntilTick = 0;
    }

    this.state.players.forEach((p) => {
      const ups = [...p.ultimateUpgrades] as string[];

      // Echo and Rally.
      if (p.ultEchoTick > 0 && this.state.tick >= p.ultEchoTick) {
        p.ultEchoTick = 0;
        this.fireUltimate(p, p.ultimateId, ups, p.aim);
      }

      if (p.ultTicks <= 0) return;

      if (p.ultimateId === "devour") this.tickDevour(p, ups, dt);
      if (p.ultimateId === "cathedral" && hasUpgrade(ups, "reliquary")) {
        this.healInBubble(p, ups, dt);
      }
      if (p.ultimateId === "grove") {
        if (hasUpgrade(ups, "thorns")) {
          const r = this.tuning.player.radius + this.tuning.asteroids.large.radius;
          for (const a of this.asteroids.within(p.x, p.y, r)) {
            this.asteroids.removeById(a.id);
            this.creditKill(p);
          }
        }
        // Bloom. Done while they are still inside rather than on release: a
        // passenger is invulnerable in there, so the moment is invisible either
        // way, and this does not depend on which of the several release paths
        // SwallowSystem happens to take.
        if (hasUpgrade(ups, "bloom")) {
          for (const id of [...p.swallowedIds] as string[]) {
            const passenger = this.state.players.get(id);
            if (passenger && passenger.lifeState === LIFE_DOWNED) {
              this.revives.forceRevive(passenger, true);
            }
          }
        }
      }
    });
  }

  /** Devour eats what comes close and turns it into health for the team. */
  private tickDevour(p: Player, ups: string[], dt: number) {
    const atk = this.tuning.characters[p.character].attack;
    const base = atk.kind === "melee" ? atk.reach : this.tuning.player.radius * 4;
    const reach = base * DEVOUR_REACH_MUL * devourRadiusMul(ups);

    // The maw cannot swallow a boss whole. removeById would delete it outright,
    // which is the single strongest argument for a boss not being a chunk.
    if (this.bosses.hits(p.x, p.y, reach)) {
      this.hurtBoss(this.tuning.boss.devourDamage * dt, p);
    }

    const eaten = this.asteroids.within(p.x, p.y, reach);
    if (eaten.length === 0) return;

    for (const a of eaten) {
      this.asteroids.removeById(a.id);
      this.creditKill(p);
    }

    const heal = eaten.length * DEVOUR_HEAL_PER_CHUNK * devourHealMul(ups);
    this.state.players.forEach((ally) => {
      addHealth(ally, heal);
      // Feast also drags people off the floor a little.
      if (hasUpgrade(ups, "feast") && ally.lifeState === LIFE_DOWNED && ally.skulls > 0) {
        ally.skulls = Math.max(0, ally.skulls - 1);
      }
    });
  }

  /** Reliquary: anyone sheltering in the cathedral is healed while it stands. */
  private healInBubble(p: Player, ups: string[], dt: number) {
    const sp = this.tuning.characters[p.character].special;
    if (sp.kind !== "throne") return;
    const radius = throneBubbleRadius(this.tuning, sp, p.mods) * cathedralRadiusMul(ups);
    const rate = p.maxHealth / ultimateDurationSec("cathedral", ups);

    this.state.players.forEach((ally) => {
      if (Math.hypot(ally.x - p.x, ally.y - p.y) > radius) return;
      addHealth(ally, rate * dt);
    });
  }

  /**
   * An ultimate went off.
   *
   * stepPlayer has already spent the charge and started the clock, both of which
   * are predicted. What is left is the world, which only this side may touch.
   */
  private resolveUltimate(p: Player, aim: number) {
    const id = p.ultimateId;
    const ups = [...p.ultimateUpgrades] as string[];
    addStat(p, "Ultimates");
    console.log(`[arena ${this.roomId}] ${p.name} used ${ultimateById(id)?.name ?? id}`);

    // Sustained ones are handled per-tick in tickUltimates; these resolve now.
    this.fireUltimate(p, id, ups, aim);

    const echo = ultimateEchoSec(id, ups);
    if (echo > 0) p.ultEchoTick = this.state.tick + secToTicks(echo, this.tuning);
  }

  /** The instant half of an ultimate, which Echo and Rally repeat. */
  private fireUltimate(p: Player, id: string, ups: string[], aim: number) {
    if (id === "reckoning") this.reckoning(p, ups);
    if (id === "consecrate") this.consecrate(ups);
    if (id === "arrow-storm") this.arrowStorm(p, ups, aim);
    if (id === "rebirth") this.rebirth(p, ups);
    if (id === "slow-storm") {
      this.state.slowFactor = slowStormFactor(ups);
      this.state.slowUntilTick =
        this.state.tick + secToTicks(ultimateDurationSec(id, ups), this.tuning);
    }
    if (id === "grove") this.grove(p);
  }

  /** Every chunk turns around and speeds up. */
  private reckoning(p: Player, ups: string[]) {
    // A boss is not turned around. Reversing it would push it back out of the
    // arena and end the level by accident, so it takes damage instead.
    this.hurtBoss(this.tuning.boss.reckoningDamage, p);

    const doubling = hasUpgrade(ups, "doubling");
    for (const a of [...this.state.asteroids] as Asteroid[]) {
      a.vx *= -2;
      a.vy *= -2;
      if (doubling && a.tier === TIER_LARGE) {
        this.asteroids.splitById(a.id, `reck-${this.state.tick}`, Math.atan2(a.vy, a.vx));
        this.creditKill(p);
      }
    }
    // Unhallowed lets them leave through the town on the way out.
    if (hasUpgrade(ups, "unhallowed")) {
      this.state.coverPhaseUntilTick =
        this.state.tick + secToTicks(RECKONING_PHASE_SEC, this.tuning);
    }
  }

  /** Rebuild the town, and ward it for the rest of the level. */
  private consecrate(ups: string[]) {
    const doubled = hasUpgrade(ups, "ramparts");
    this.state.structures.forEach((s) => {
      s.maxHp = doubled ? s.maxHp * 2 : s.maxHp;
      s.hp = s.maxHp;
    });
    this.syncBoxes();
    this.state.coverWarded = true;
    if (hasUpgrade(ups, "spires")) this.state.coverReflects = true;
    if (hasUpgrade(ups, "bedrock")) this.state.coverRebuildsEachLevel = true;
  }

  /** Arrows in every direction at once. */
  private arrowStorm(p: Player, ups: string[], aim: number) {
    const atk = this.tuning.characters[p.character].attack;
    if (atk.kind !== "ranged") return;

    const n = arrowStormCount(ups);
    // One arrow per bearing: the volley is the fan, so a Split Shot on top of
    // it would only smear each spoke.
    const m = {
      ...p.mods,
      pierceCount: Infinity, arrowsPerShot: 1, homingArrows: false, arrowsPhaseWalls: true,
    };
    if (hasUpgrade(ups, "barbed")) m.destroyLarge = true;
    for (let i = 0; i < n; i++) {
      this.projectiles.spawn(p.sessionId, p.x, p.y, aim + (i / n) * Math.PI * 2, atk, m);
    }
  }

  /** Everybody up, and one back from the dead. */
  private rebirth(p: Player, ups: string[]) {
    const all = hasUpgrade(ups, "second-life");
    let raised = 0;

    this.state.players.forEach((other) => {
      if (other.lifeState === LIFE_DOWNED) {
        this.revives.forceRevive(other, true);
      } else if (other.lifeState === LIFE_DEAD && (all || raised === 0)) {
        this.revives.forceRevive(other, true);
        raised++;
      }
      if (hasUpgrade(ups, "communion")) {
        other.maxHealth += REBIRTH_HEALTH_BONUS;
        other.health = Math.min(other.maxHealth, other.health + REBIRTH_HEALTH_BONUS);
      }
      if (hasUpgrade(ups, "renewal")) {
        other.specialCdTicks = 0;
        other.ultReady = true;
      }
    });
    // Renewal refreshing the caster would let them chain instantly, which is
    // exactly what it says on the card.
    if (hasUpgrade(ups, "renewal")) p.ultReady = true;
  }

  /** Swallow everyone at once. */
  private grove(druid: Player) {
    this.state.players.forEach((other) => {
      if (other.sessionId === druid.sessionId) return;
      if (other.carriedBy !== "" || other.lifeState === LIFE_DEAD) return;
      druid.swallowedIds.push(other.sessionId);
      other.carriedBy = druid.sessionId;
      other.dashTicks = 0;
      other.pullTicks = 0;
      other.vx = 0;
      other.vy = 0;
    });
    druid.swallowUntilTick =
      this.state.tick + secToTicks(ultimateDurationSec("grove", [...druid.ultimateUpgrades] as string[]), this.tuning);
  }

  /** Inside a bubble belonging to a Warlock who took Sanctuary. */
  private shelteredByThrone(p: Player): boolean {
    let safe = false;
    this.state.players.forEach((w) => {
      if (safe || w.sessionId === p.sessionId || w.specialTicks <= 0 || !w.mods.sanctuary) return;
      const sp = this.tuning.characters[w.character].special;
      if (sp.kind !== "throne") return;
      if (Math.hypot(p.x - w.x, p.y - w.y) <= throneBubbleRadius(this.tuning, sp, w.mods)) safe = true;
    });
    return safe;
  }

  /**
   * Throne shells currently standing. Rebuilt every tick from player state
   * rather than tracked as its own entity: the throne roots its caster, so the
   * shell cannot move, and specialTicks is already the authority on how long it
   * lasts. Collected out here, not in the input loop — a Warlock who stops
   * sending input must not have his bubble blink out.
   */
  private activeBubbles(): Bubble[] {
    const out: Bubble[] = [];
    this.state.players.forEach((p, sessionId) => {
      const sp = this.tuning.characters[p.character].special;
      if (sp.kind !== "throne" || !sp.bubbleBlocksAsteroids) return;

      // The Cathedral is the same shell several times over, so it goes through
      // the same reflection path rather than getting one of its own.
      const cathedral = p.ultTicks > 0 && p.ultimateId === "cathedral";
      if (!cathedral && p.specialTicks <= 0) return;

      const base = throneBubbleRadius(this.tuning, sp, p.mods);
      const radius = cathedral
        ? base * cathedralRadiusMul([...p.ultimateUpgrades] as string[])
        : base;
      out.push({ ownerSessionId: sessionId, x: p.x, y: p.y, radius });
    });
    return out;
  }

  /**
   * Dash i-frames. Every character currently has `dash.invulnerable: false`, so
   * this does nothing today — it is wired anyway so flipping the tuning key is
   * the whole change, rather than a key that silently means nothing.
   */
  private onDashStarted(p: Player) {
    const c = this.tuning.characters[p.character];
    // Dash Ward turns this on for a player whose tuning leaves it off.
    if (!c.dash.invulnerable && !p.mods.dashInvuln) return;
    const until = this.state.tick + secToTicks(c.dash.durationSec, this.tuning);
    p.invulnUntilTick = Math.max(p.invulnUntilTick, until);
  }

  /**
   * A melee sweep: every chunk in the arc splits, Large into two Small and Small
   * into nothing. One swingId for the whole sweep, so the fragments this swing
   * creates are immune to it and a single press cannot chain a Large to dust.
   *
   * A ranged attack launches an arrow instead, which resolves over the following
   * ticks in ProjectileSystem rather than instantly here.
   */
  private resolveAttack(p: Player, aim: number) {
    const atk = this.tuning.characters[p.character].attack;
    const m = p.mods;

    if (atk.kind === "ranged") {
      this.projectiles.spawn(p.sessionId, p.x, p.y, aim, atk, m);
      return;
    }

    // Cleave sweeps the whole circle; Gape widens the Druid's bite; Reach
    // lengthens both. The client draws the arc from this same function.
    const { reach, arcDegrees } = meleeSweep(atk, m);

    // The boss is caught by the same sweep, measured the same way.
    if (this.bosses.inArc(p.x, p.y, aim, reach, arcDegrees)) {
      this.hurtBoss(this.tuning.boss.meleeDamage, p);
    }

    const swingId = `${p.sessionId}-${this.state.tick}`;
    for (const target of this.asteroids.inArc(p.x, p.y, aim, reach, arcDegrees, swingId)) {
      // Demolition takes a Large off the board instead of turning it into two
      // Smalls, which is the whole point of it.
      if (m.destroyLarge) this.asteroids.removeById(target.id);
      // Fan the fragments off the line running from the swinger to the chunk, so
      // they leave sideways rather than into the face of whoever just hit it.
      else this.asteroids.splitById(target.id, swingId, Math.atan2(target.y - p.y, target.x - p.x));
      this.creditKill(p);
    }
  }

  /**
   * Warlock throne. stepPlayer has already rooted him and started the clock,
   * because both of those are movement and therefore predicted; what is left is
   * the half the client must not guess at.
   *
   * The bubble itself is not created here — activeBubbles rebuilds it from
   * specialTicks every tick, so it survives a Warlock who stops sending input.
   *
   * The grapple fires a hook whose flight and landing are server-only, for the
   * same reason: where it lands depends on world state the client has no copy
   * of. Swallow still resolves to nothing; it lands with the Druid.
   */
  private resolveSpecial(p: Player, aim: number) {
    const sp = this.tuning.characters[p.character].special;

    if (sp.kind === "grapple") {
      this.grapples.fire(p, aim);
      return;
    }

    if (sp.kind === "swallow") {
      // Nothing burned a cooldown on the press, so a grab that catches nobody
      // has to cost one here or the button is free to mash.
      if (!this.swallows.swallow(p)) {
        p.specialTicks = 0;
        p.specialCdTicks = secToTicks(sp.cooldownSec, this.tuning);
      }
      return;
    }

    if (sp.kind !== "throne") return;

    if (sp.casterInvulnerable) {
      const until = this.state.tick + secToTicks(sp.durationSec + p.mods.throneDurAdd, this.tuning);
      p.invulnUntilTick = Math.max(p.invulnUntilTick, until);
    }
  }

  private damageStructure(id: string, damage: number) {
    const s = this.state.structures.find((x) => x.id === id);
    if (!s || s.hp <= 0) return;
    // Consecrate wards the town for the rest of the level.
    if (this.state.coverWarded) return;
    const wasStanding = s.hp > 0;
    s.hp = Math.max(0, s.hp - damage);
    if (wasStanding && s.hp <= 0) {
      this.state.lvlStructuresLost++;
      this.state.runStructuresLost++;
      // The Wellspring drinks the town. Hooked on the transition to zero, not on
      // damage, so chipping a wall feeds it nothing.
      this.bosses.onStructureLost();
    }
    // Collision reads this.boxes, so a wall that just fell must stop blocking
    // on the very next tick rather than whenever the next full resync happens.
    this.syncBoxes();
  }

  private damagePlayer(sessionId: string, damage: number, _tier: Tier) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    if (p.lifeState === LIFE_DEAD) return;
    if (p.invulnUntilTick > this.state.tick) return;
    // Sanctuary: standing inside a Warlock's bubble that has it stops sewage
    // reaching you at all, so it is checked before the mercy window is spent.
    if (this.shelteredByThrone(p)) return;

    // Brief mercy window so a cluster of fragments cannot delete a player in
    // three consecutive ticks. It applies to skulls too, or a Large splitting
    // over a downed player would burn all three of them in as many ticks.
    const mercy = this.tuning.player.hitInvulnSec + p.mods.hitInvulnAdd;
    p.invulnUntilTick = this.state.tick + secToTicks(mercy, this.tuning);

    if (p.lifeState === LIFE_DOWNED) {
      // Tier stops mattering once you are on the floor: any hit is one skull.
      this.revives.addSkull(p);
      addStat(p, "Skulls");
      return;
    }

    const dealt = Math.round(damage * p.mods.damageTakenMul);
    p.health = Math.max(0, p.health - dealt);
    addStat(p, "DamageTaken", dealt);

    // cancelOnDamage: taking a hit drops the hook and ramps any pull down. No
    // kind check needed — cancel is a no-op for anyone without a grapple.
    this.grapples.cancel(p);

    if (p.health <= 0) {
      this.revives.goDown(p);
      addStat(p, "Downs");
    }
  }

  private buildLayout(seed: number) {
    this.state.seed = seed;
    this.state.structures.clear();
    for (const b of generateLayout(this.tuning, seed)) {
      const s = new Structure();
      s.id = b.id; s.kind = b.kind;
      s.x = b.x; s.y = b.y; s.w = b.w; s.h = b.h;
      s.hp = b.hp; s.maxHp = b.maxHp;
      this.state.structures.push(s);
    }
    this.syncBoxes();
    console.log(`[arena ${this.roomId}] layout seed ${seed}: ${this.state.structures.length} structures`);
  }

  /** Refresh the plain array the simulation reads. Call after any hp change. */
  private syncBoxes() {
    this.boxes = this.state.structures.map((s) => ({
      id: s.id,
      kind: s.kind as StructureBox["kind"],
      x: s.x, y: s.y, w: s.w, h: s.h,
      hp: s.hp, maxHp: s.maxHp,
    }));
  }
}

function isValidCommand(cmd: unknown): cmd is InputCommand {
  if (typeof cmd !== "object" || cmd === null) return false;
  const c = cmd as Record<string, unknown>;
  const m = c.move as Record<string, unknown> | undefined;
  return (
    typeof c.seq === "number" && Number.isFinite(c.seq) &&
    typeof c.aim === "number" && Number.isFinite(c.aim) &&
    typeof c.buttons === "number" &&
    !!m && typeof m.x === "number" && Number.isFinite(m.x) &&
    typeof m.y === "number" && Number.isFinite(m.y)
  );
}

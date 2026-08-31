import { stepPlayer } from "../shared/sim";
import type { Tuning } from "../shared/tuning";
import {
  freshAbilityState,
  type CharacterId,
  type InputCommand,
  type PlayerSimState,
  type StepEvents,
} from "../shared/types";
import type { StructureBox } from "../shared/structures";
import { applyPerks } from "../shared/perks";

/** The authoritative fields a reconcile snaps back to. */
export interface ServerPlayerView {
  /**
   * Authoritative, and it has to be here.
   *
   * The predictor is built before the first snapshot is guaranteed to have
   * arrived, so its constructor can only guess the character — and a wrong guess
   * means stepPlayer predicts with another character's speed, accel and
   * cooldowns for the whole run. Adopting the server's answer on the first
   * reconcile closes that race.
   */
  character: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashTicks: number;
  dashCdTicks: number;
  attackCdTicks: number;
  specialCdTicks: number;
  specialTicks: number;
  pullTicks: number;
  pullAnchorX: number;
  pullAnchorY: number;
  pullDecayTicks: number;
  carriedBy: string;
  lifeState: number;
  health: number;
  maxHealth: number;
  perks: string[];
  ultimateId: string;
  ultimateUpgrades: string[];
  ultReady: boolean;
  ultTicks: number;
}

const NO_EVENTS: StepEvents = {
  dashStarted: false, attackFired: false, specialFired: false, ultimateFired: false,
  lifeClaimed: false,
};

/**
 * Client-side prediction with server reconciliation.
 *
 * Every command is applied locally the instant it is created, then kept in a
 * pending list. When the server reports the state it produced for seq N, we
 * snap to that state and replay every command after N. Because replay uses the
 * same stepPlayer the server ran, a correct client converges to zero error.
 */
export class Predictor {
  state: PlayerSimState;
  pending: InputCommand[] = [];
  lastError = 0;
  enabled = true;
  /** What the most recent local step fired, for the swing/dash visuals. */
  lastEvents: StepEvents = NO_EVENTS;
  /** The perk list the current mods were built from, so they rebuild only on change. */
  private perkKey = "";

  constructor(character: CharacterId, x: number, y: number, private tuning: Tuning) {
    this.state = { x, y, vx: 0, vy: 0, character, ...freshAbilityState() };
  }

  applyLocal(cmd: InputCommand, dt: number, structures: readonly StructureBox[]): StepEvents {
    if (!this.enabled) return NO_EVENTS;
    this.pending.push(cmd);
    this.lastEvents = stepPlayer(this.state, cmd, dt, this.tuning, structures);
    if (this.pending.length > 240) this.pending.shift();
    return this.lastEvents;
  }

  reconcile(
    server: ServerPlayerView,
    lastSeq: number,
    dt: number,
    structures: readonly StructureBox[],
  ) {
    if (!this.enabled) {
      this.state.x = server.x; this.state.y = server.y;
      this.state.vx = server.vx; this.state.vy = server.vy;
      this.snapAbilities(server);
      return;
    }

    const dx = this.state.x - server.x;
    const dy = this.state.y - server.y;
    this.lastError = Math.sqrt(dx * dx + dy * dy);

    this.state.x = server.x;
    this.state.y = server.y;
    this.state.vx = server.vx;
    this.state.vy = server.vy;
    this.snapAbilities(server);

    // prevButtons has to be rewound too, not just the numbers. It drives rising
    // edge detection, and at this point it holds the buttons from our newest
    // command — which is in the future relative to the state we just snapped to.
    // Leaving it there makes the first replayed press look like a held button
    // and silently swallows a dash. The correct value is the buttons of the last
    // command the server actually consumed.
    const lastAcked = this.lastCommandUpTo(lastSeq);
    if (lastAcked) this.state.prevButtons = lastAcked.buttons;

    this.pending = this.pending.filter((c) => c.seq > lastSeq);
    // Replay uses the CURRENT structure list. A wall that fell during the replay
    // window makes this replay against slightly wrong geometry for a frame; the
    // next reconcile corrects it.
    for (const c of this.pending) stepPlayer(this.state, c, dt, this.tuning, structures);
  }

  /**
   * Dash direction is deliberately not snapped: it is not synced, and the client
   * derived it from the same command the server did, so the local copy is
   * already right.
   *
   * The grapple anchor is the opposite case and must be snapped. The client
   * cannot know where a hook landed — that depends on asteroid positions it does
   * not simulate — so it learns the anchor here and predicts the pull from the
   * next replay onward. The visible cost is that a pull starts about one RTT
   * late locally, which is the correct trade: guessing an anchor would mean
   * yanking the player somewhere the server never agreed to.
   */
  private snapAbilities(server: ServerPlayerView) {
    // The constructor had to guess this before any snapshot existed. Everything
    // stepPlayer reads about a character hangs off it, so take the server's.
    if (server.character && server.character !== this.state.character) {
      this.state.character = server.character as CharacterId;
    }
    this.state.dashTicks = server.dashTicks;
    this.state.dashCdTicks = server.dashCdTicks;
    this.state.attackCdTicks = server.attackCdTicks;
    this.state.specialCdTicks = server.specialCdTicks;
    this.state.specialTicks = server.specialTicks;
    this.state.pullTicks = server.pullTicks;
    this.state.pullAnchorX = server.pullAnchorX;
    this.state.pullAnchorY = server.pullAnchorY;
    this.state.pullDecayTicks = server.pullDecayTicks;
    // Being swallowed is entirely the server's call, and while it holds, replay
    // below is a no-op by design: the passenger's position comes from whatever
    // the Druid did, which arrives here only as reconciled state.
    this.state.carriedBy = server.carriedBy;
    // Going down, dying, and being revived are all the server's calls; the
    // client only replays what they mean for movement.
    this.state.lifeState = server.lifeState;

    // Health is not predicted, but Adrenaline makes speed depend on it, so the
    // replay uses whatever the last snapshot said.
    this.state.health = server.health;
    this.state.maxHealth = server.maxHealth;

    // Perks arrive as ids and are folded into numbers here, with the same
    // function the server used. Rebuilt only when the list actually changes —
    // it changes once per level, not once per tick.
    const key = server.perks.join(",");
    if (key !== this.perkKey) {
      this.perkKey = key;
      this.state.mods = applyPerks(server.perks);
    }

    // The ultimate is predicted the same way — its ids fold into an overlay on
    // those mods inside stepPlayer — but which one you hold, and whether the
    // charge is spent, are the server's to say.
    this.state.ultimateId = server.ultimateId;
    this.state.ultimateUpgrades = server.ultimateUpgrades;
    this.state.ultReady = server.ultReady;
    this.state.ultTicks = server.ultTicks;
  }

  private lastCommandUpTo(seq: number): InputCommand | undefined {
    let found: InputCommand | undefined;
    for (const c of this.pending) {
      if (c.seq > seq) break;
      found = c;
    }
    return found;
  }
}

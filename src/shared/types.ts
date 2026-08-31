import type { Vec2 } from "./math";
import { noMods, type PerkMods } from "./perks";

export type CharacterId = "ranger" | "druid" | "warlock";
export const CHARACTER_IDS: CharacterId[] = ["ranger", "druid", "warlock"];

/**
 * Life state. Health reaching zero puts you down rather than killing you;
 * skulls accumulated while down are what kill. Death persists across levels,
 * which is what gives reviving a payoff.
 */
export const LIFE_ALIVE = 0;
export const LIFE_DOWNED = 1;
export const LIFE_DEAD = 2;

/**
 * What the level is currently doing. Lives here rather than in GameState so the
 * client can read it without importing server code.
 *
 * WAITING deliberately shares this field rather than getting a "phase" of its
 * own: every existing `outcome !== OUTCOME_PLAYING` check already means "the
 * level is not running", so the world freeze, the timer bar, the music and the
 * revive clock all behave correctly for it without being touched.
 */
export const OUTCOME_PLAYING = 0;
export const OUTCOME_WON = 1;
export const OUTCOME_LOST = 2;
export const OUTCOME_WAITING = 3;
/**
 * The level is built and everyone is on their spawn, but sewage has not started
 * flying yet.
 *
 * Another value on this field rather than a phase of its own, for exactly the
 * reason WAITING was: the world freeze, the hidden timer bar, the silent
 * spawner, the paused revive clock and the music all key off
 * `outcome !== OUTCOME_PLAYING`, so a new value inherits every one of them
 * without any of them being touched.
 */
export const OUTCOME_COUNTDOWN = 4;

/**
 * Which boss a level is running, or BOSS_NONE for an ordinary level of waves.
 *
 * Here rather than in GameState for the same reason the outcome constants are:
 * the client reads it to pick a sprite and a name without importing server code.
 */
export const BOSS_NONE = "";
export const BOSS_CLOG = "clog";
export const BOSS_WELLSPRING = "wellspring";

/** Button bitmask. Settled in M0 so M3 could add abilities without touching the wire format. */
export const BTN = {
  DASH: 1 << 0,
  ATTACK: 1 << 1,
  SPECIAL: 1 << 2,
  ULTIMATE: 1 << 3,
} as const;

/**
 * One fixed-timestep input frame. Produced by the client at tickHz, applied by
 * the client immediately (prediction) and by the server authoritatively.
 */
export interface InputCommand {
  seq: number;
  move: Vec2;
  aim: number;
  buttons: number;
}

/**
 * The minimal per-player state the shared simulation touches.
 *
 * Everything below the movement fields is ability bookkeeping. It lives here,
 * rather than server-side, because dash is movement: the client has to be able
 * to reproduce it exactly from the command stream or prediction fights the
 * server. All of it is counted in ticks and advanced inside stepPlayer.
 */
export interface PlayerSimState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  character: CharacterId;

  /** Ticks left in the active dash; 0 when not dashing. */
  dashTicks: number;
  /** Heading frozen at dash activation, unit length. Only read while dashing. */
  dashDirX: number;
  dashDirY: number;

  /** Ticks until each ability may fire again. 0 means ready. */
  dashCdTicks: number;
  attackCdTicks: number;
  specialCdTicks: number;

  /**
   * Ticks left on an active special. Predicted, because a special that roots the
   * caster — the Warlock's throne does — is movement, and movement the client
   * cannot reproduce is movement prediction fights.
   */
  specialTicks: number;

  /**
   * Grapple pull. The anchor is chosen by the server — where a hook lands
   * depends on world state the client does not simulate — but once it is known,
   * the movement it produces is ordinary predicted movement, so it runs here.
   * The client learns the anchor at the next reconcile and converges from there.
   */
  pullTicks: number;
  pullAnchorX: number;
  pullAnchorY: number;
  /** Ticks of ramp-down after an anchor is lost mid-pull, e.g. its wall fell. */
  pullDecayTicks: number;

  /**
   * Session id of the Druid currently carrying this player, or "" for nobody.
   *
   * The only field here whose effect this side cannot predict at all. A swallowed
   * player is parked on the Druid every tick by the server, and where the Druid
   * goes follows from the Druid's command stream, which this client has no copy
   * of. So the sim's whole job for a passenger is to stop: no input, no movement,
   * no abilities, and let reconcile place them.
   */
  carriedBy: string;

  /**
   * Perk effects, folded to plain numbers.
   *
   * Recomputed only when the perk list changes, never per tick. The server owns
   * the list and syncs the ids; both sides run applyPerks over them, so the
   * numbers stepPlayer reads are identical on both without the numbers
   * themselves ever going over the wire.
   */
  mods: PerkMods;

  /**
   * Current health, needed by stepPlayer only because Adrenaline makes speed
   * depend on it. Not predicted — the server owns damage — so the client uses
   * whatever the last reconcile gave it. A hit landing mid-replay can mispredict
   * speed for about one round trip, which reconcile then corrects, the same way
   * a grapple anchor does.
   */
  health: number;
  maxHealth: number;

  /**
   * LIFE_ALIVE / LIFE_DOWNED / LIFE_DEAD. Predicted, because it gates movement:
   * downed players crawl and dead ones do not move at all. The server owns the
   * transitions — reaching zero health, taking skulls, being revived — and the
   * client learns them through reconcile.
   */
  lifeState: number;

  /**
   * The ultimate this player chose at level 5, the upgrades taken since, whether
   * the once-per-level charge is spent, and how long the active one has left.
   *
   * All four are here rather than server-side because several ultimates change
   * movement or cooldowns, so stepPlayer has to see them — and because the
   * client derives the same effect from the same ids, exactly as it does perks.
   */
  ultimateId: string;
  ultimateUpgrades: string[];
  ultReady: boolean;
  ultTicks: number;

  /** Buttons held on the previous command, so abilities fire on press not hold. */
  prevButtons: number;
}

/**
 * Fresh ability bookkeeping. Four places build a PlayerSimState — the server on
 * join, the predictor, the verifier's mirror, and any future test harness — and
 * if any of them initialised these differently the divergence would look like a
 * prediction bug rather than a typo.
 */
export function freshAbilityState() {
  return {
    dashTicks: 0,
    dashDirX: 0,
    dashDirY: 0,
    dashCdTicks: 0,
    attackCdTicks: 0,
    specialCdTicks: 0,
    specialTicks: 0,
    pullTicks: 0,
    pullAnchorX: 0,
    pullAnchorY: 0,
    pullDecayTicks: 0,
    carriedBy: "",
    lifeState: LIFE_ALIVE,
    prevButtons: 0,
    mods: noMods(),
    health: 100,
    maxHealth: 100,
    ultimateId: "",
    ultimateUpgrades: [],
    ultReady: false,
    ultTicks: 0,
  };
}

/**
 * What a single step fired. The server acts on these to produce world effects;
 * the client throws them away, because world effects are not predicted.
 */
export interface StepEvents {
  dashStarted: boolean;
  attackFired: boolean;
  specialFired: boolean;
  ultimateFired: boolean;
  /**
   * A downed or dead player pressed special to spend one of the party's shared
   * extra lives.
   *
   * An event and nothing else: stepPlayer changes no state for it, so it costs
   * prediction nothing and both sides compute it identically. Whether a life is
   * actually available, and what spending one does, is the server's alone.
   */
  lifeClaimed: boolean;
}

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === "string" && (CHARACTER_IDS as string[]).includes(v);
}

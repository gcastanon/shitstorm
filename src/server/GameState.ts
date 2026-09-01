import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { noMods, type PerkMods } from "../shared/perks";

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("string") character = "ranger";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("number") aim = 0;
  /** Highest input seq the server has consumed. Drives client reconciliation. */
  @type("uint32") lastSeq = 0;
  @type("boolean") connected = true;
  @type("int16") health = 100;
  @type("int16") maxHealth = 100;
  /** Server tick until which further sewage hits are ignored. */
  @type("uint32") invulnUntilTick = 0;

  /**
   * Ability bookkeeping, all counted in ticks and all advanced inside
   * stepPlayer. Synced so the HUD can be corrected and so remote players can be
   * drawn mid-dash; the client predicts its own copy and reconciles against
   * these. uint16 because a 15s special is 450 ticks, well past a byte.
   */
  @type("uint8") dashTicks = 0;
  @type("uint16") dashCdTicks = 0;
  @type("uint16") attackCdTicks = 0;
  @type("uint16") specialCdTicks = 0;
  /** Ticks left on an active special. Drives the throne bubble on every client. */
  @type("uint16") specialTicks = 0;

  /**
   * Server-only sim state, deliberately undecorated so it never goes over the
   * wire — same reasoning as Asteroid.swingId. The client derives all three from
   * the command stream it already has, so sending them would be pure waste.
   */
  dashDirX = 0;
  dashDirY = 0;
  prevButtons = 0;

  /**
   * Grapple. The pull half is simulation state that stepPlayer reads; the hook
   * half is pure presentation, synced so every client can draw the line.
   */
  @type("uint16") pullTicks = 0;
  @type("number") pullAnchorX = 0;
  @type("number") pullAnchorY = 0;
  @type("uint8") pullDecayTicks = 0;

  @type("boolean") hookActive = false;
  @type("number") hookX = 0;
  @type("number") hookY = 0;

  /** Server-only hook flight, never synced — clients only need where it is. */
  hookVx = 0;
  hookVy = 0;
  hookTravelled = 0;
  /** Which structure the pull is anchored to, so its collapse can cancel it. */
  pullAnchorId = "";

  /**
   * Druid swallow. `swallowedIds` is who this Druid is carrying; `carriedBy` is
   * who is carrying this player. Both sides of the pair are synced because both
   * render differently.
   *
   * A list rather than a single id because Second Stomach raises the capacity;
   * one deadline covers the whole mouthful, so they all come out together.
   */
  @type(["string"]) swallowedIds = new ArraySchema<string>();
  @type("string") carriedBy = "";

  /**
   * LIFE_ALIVE / LIFE_DOWNED / LIFE_DEAD, plus the skulls that turn the second
   * into the third. Synced because every client draws all three differently and
   * the loss condition is read off them.
   */
  @type("uint8") lifeState = 0;
  @type("uint8") skulls = 0;

  /**
   * Revive progress on this player, in ticks, out of downed.reviveSeconds.
   * Server-owned and advanced outside the input loop: it decides something for
   * somebody else, so it must not ride on anyone's command stream.
   */
  @type("uint16") reviveTicks = 0;

  /**
   * Whether this player held still and pressed nothing on their last consumed
   * command. Server-only, and cleared every tick before input is read, so a
   * player who sends nothing simply stops counting as a reviver.
   */
  revivingIntent = false;

  /**
   * Absolute tick the swallow must end by, server-only.
   *
   * The authority on release, deliberately not the predicted specialTicks
   * counter: that one only advances when the Druid sends input, and a Druid
   * whose client hangs would otherwise trap a teammate indefinitely. A player
   * pausing their own root is self-correcting; a player pausing someone else's
   * captivity is not.
   */
  swallowUntilTick = 0;

  /**
   * Fractional health carried between ticks. Regen is 1.5/sec against an int16
   * health field, which is 0.05 per tick — without this it truncates to nothing
   * every tick and passive regen silently does not exist.
   */
  healthFrac = 0;

  /**
   * Perks taken this run, and the three currently on offer.
   *
   * Only the ids are synced. Both sides fold them into numbers with the same
   * applyPerks, so the effective values stepPlayer reads match without any of
   * those numbers crossing the wire.
   */
  @type(["string"]) perks = new ArraySchema<string>();
  @type(["string"]) offer = new ArraySchema<string>();
  @type("boolean") hasPicked = false;

  /**
   * The ultimate chosen at level 5 and the upgrades taken at 10 and 15.
   *
   * `ultReady` is the once-per-level charge, refilled by startLevel; `ultTicks`
   * counts down an active one. Both are predicted, so the ring empties on the
   * frame the button goes down rather than a round trip later.
   */
  @type("string") ultimateId = "";
  @type(["string"]) ultimateUpgrades = new ArraySchema<string>();
  @type("boolean") ultReady = false;
  @type("uint16") ultTicks = 0;
  /**
   * How many times this player's ultimate has actually fired. Wraps freely — the
   * client only ever compares it with the previous snapshot's value.
   *
   * Synced because nothing else can carry a cast. `ultTicks` stays 0 for the four
   * instant ultimates, and `ultReady` goes true→false only on the *first* cast,
   * so an Echo or Rally firing a second time would be invisible to a client
   * diffing either of them. One byte buys a cast moment for all nine.
   */
  @type("uint8") ultCasts = 0;

  /** Absolute tick an Echo or Rally fires the effect a second time, 0 for none. */
  ultEchoTick = 0;

  /** Whether this player has spent their one pause this level. Synced so the
   *  HUD can say whether pressing Esc will do anything. */
  @type("boolean") pauseUsed = false;

  /** Derived from `perks`, recomputed only when that list changes. */
  mods: PerkMods = noMods();

  /**
   * What this player did, for the Dungeon Master's end-of-level summary.
   *
   * Every counter comes in a `lvl` and a `run` pair: the first is cleared when a
   * level starts, the second only when the run restarts. Use `addStat` rather
   * than touching them directly so the two can never drift apart.
   */
  @type("uint32") lvlDamageTaken = 0;
  @type("uint32") lvlChunksKilled = 0;
  @type("uint16") lvlDowns = 0;
  @type("uint16") lvlSkulls = 0;
  @type("uint16") lvlRevives = 0;
  @type("uint32") lvlDownedTicks = 0;
  @type("uint16") lvlUltimates = 0;
  @type("uint16") lvlLives = 0;

  @type("uint32") runDamageTaken = 0;
  @type("uint32") runChunksKilled = 0;
  @type("uint16") runDowns = 0;
  @type("uint16") runSkulls = 0;
  @type("uint16") runRevives = 0;
  @type("uint32") runDownedTicks = 0;
  @type("uint16") runUltimates = 0;
  @type("uint16") runLives = 0;
}

export type StatKey =
  | "DamageTaken" | "ChunksKilled" | "Downs" | "Skulls" | "Revives" | "DownedTicks"
  | "Ultimates" | "Lives";

/** Bump a level counter and its run counter together. */
export function addStat(p: Player, key: StatKey, n = 1) {
  const anyP = p as unknown as Record<string, number>;
  anyP[`lvl${key}`] = (anyP[`lvl${key}`] ?? 0) + n;
  anyP[`run${key}`] = (anyP[`run${key}`] ?? 0) + n;
}

/** Clear one scope of a player's counters. */
export function resetStats(p: Player, scope: "lvl" | "run") {
  const anyP = p as unknown as Record<string, number>;
  for (const key of ["DamageTaken", "ChunksKilled", "Downs", "Skulls", "Revives", "DownedTicks", "Ultimates", "Lives"]) {
    anyP[`${scope}${key}`] = 0;
  }
}

/**
 * The Dungeon Master: a fourth connection that does not play.
 *
 * Deliberately not a Player. Keeping them out of `state.players` means the loss
 * condition, sewage targeting, spawn indexing, perk offers, the revive scan and
 * the swallow scan all keep working untouched — none of them has to learn about
 * a body that isn't there.
 */
export class Dm extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("boolean") present = false;
  /**
   * Watching rather than running it. The panel, the summary and the start button
   * all behave exactly as before; the only thing that changes is that levels no
   * longer wait to be started. Synced because the players' banner names whoever
   * they are waiting for, and in passive mode they are waiting for nobody.
   */
  @type("boolean") passive = false;
}

/**
 * A Ranger arrow. Server-owned and not predicted, exactly like sewage: the
 * client extrapolates it along its line for rendering and the server alone
 * decides what it hits.
 */
export class Projectile extends Schema {
  @type("string") id = "";
  @type("string") owner = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;

  /**
   * Server-only, deliberately undecorated. Range and piercing are stamped on at
   * spawn rather than looked up later, because perks make them differ per
   * shooter and an arrow outlives the shot that fired it.
   */
  travelled = 0;
  maxRange = 0;
  /** Hits this arrow can still survive. Infinity for the Ranger's ultimates. */
  pierceLeft = 0;
  /** Hunting Shot. The client still draws arrows straight, so a curve shows up
   *  as the line correcting itself each snapshot rather than as a smooth arc. */
  homing = false;
  /** Flies through cover rather than being stopped by it (Arrow Storm). */
  phaseWalls = false;
  /** Takes a Large off the board instead of splitting it (Demolition, Barbed). */
  destroys = false;
}

/**
 * A chunk of incoming sewage. Radius and damage are looked up from tuning by
 * tier rather than synced, since they never vary per chunk.
 */
export class Asteroid extends Schema {
  @type("string") id = "";
  @type("uint8") tier = 0;
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;

  /**
   * Hits left before it breaks, from the tier at spawn.
   *
   * Synced, unlike everything else about a tier, because it is the one thing
   * that varies per chunk — and because "why didn't that die?" is the first
   * question the armoured type provokes. The client draws it cracked once this
   * has dropped below the tier's full value.
   */
  @type("uint8") hits = 1;

  /**
   * Server-only, deliberately not decorated so it never goes over the wire.
   * M3 sets this on split children so one melee sweep cannot chain through the
   * fragments it just created.
   */
  swingId?: string;
}

/**
 * The Clog or the Gullet.
 *
 * Deliberately its own entity rather than a third asteroid tier. As a chunk it
 * would inherit every "affects all sewage" ability for free, and most of those
 * would be wrong: Devour calls removeById on everything in its radius and would
 * delete a boss outright, Reckoning would fling it backwards, and the throne
 * bubble would bounce it away. Nine ultimates say "every chunk"; keeping the
 * boss separate turns each of those into a decision someone had to write down.
 *
 * One at a time, so this is a field rather than a collection.
 */
export class Boss extends Schema {
  /** BOSS_NONE when no boss is running; otherwise BOSS_CLOG or BOSS_GULLET. */
  @type("string") kind = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("int32") hp = 0;
  @type("int32") maxHp = 0;
  /** Synced because the client draws the sprite at exactly this, like every
   *  other hitbox in the game. */
  @type("number") radius = 0;
  /** 0 before the half-health phase, 1 after. Both bosses latch it and neither
   *  clears it — the Gullet can heal back above half and stays enraged. */
  @type("uint8") phase = 0;
  /** The Clog has arrived and started pulling the town down. */
  @type("boolean") razing = false;

  /**
   * Health before the Dungeon Master's difficulty slider, server-only.
   *
   * `maxHp` is this times the live difficulty, so dragging the slider changes
   * how much fight is left. Kept separately because scaling `maxHp` off itself
   * would compound every tick.
   */
  baseMaxHp = 0;

  /** Server-only timers, undecorated so they never go over the wire. */
  shedTimer = 0;
  razeTimer = 0;
  /** Absolute tick the Clog last shed from being hit. An absolute tick rather
   *  than a countdown because damage arrives from outside the boss update, so
   *  there is no dt to subtract. */
  hitShedTick = -1e9;
  /** The Gullet's next summon, which pattern it is on, how far through it is,
   *  and the bearing the emitter has rotated to. Server-only: the client sees
   *  the chunks, which is the whole of what a pattern looks like. */
  summonTimer = 0;
  patternIndex = 0;
  patternStep = 0;
  summonAngle = 0;
}

/**
 * A hut or wall. Synced rather than regenerated client-side: the client could
 * rebuild the same layout from the seed, but then two code paths would have to
 * stay in agreement forever. One authoritative list is cheaper to trust.
 */
export class Structure extends Schema {
  @type("string") id = "";
  @type("string") kind = "hut";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") w = 0;
  @type("number") h = 0;
  @type("number") hp = 0;
  @type("number") maxHp = 0;
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  /** Array order is load-bearing: collision resolves in this order on both sides. */
  @type([Structure]) structures = new ArraySchema<Structure>();
  @type([Asteroid]) asteroids = new ArraySchema<Asteroid>();
  @type([Projectile]) projectiles = new ArraySchema<Projectile>();
  @type("uint32") tick = 0;
  @type("uint32") seed = 0;

  /** Wave the level is on, whether it is spawning or in its lull, and the tick
   *  the current phase ends. The client counts the lull down from that. */
  @type("uint8") waveIndex = 0;
  @type("boolean") waveSpawning = true;
  @type("uint32") wavePhaseEndTick = 0;

  /**
   * Sewage speed multiplier, driven by Slow the Storm. 1 is normal. Applies to
   * chunks alone — players are untouched, which is the whole point of it.
   */
  @type("number") slowFactor = 1;
  /** Absolute tick the slow ends. */
  slowUntilTick = 0;
  /** Cover cannot be destroyed for the rest of this level (Consecrate). Synced
   *  so indestructible cover does not look identical to cover about to fall. */
  @type("boolean") coverWarded = false;
  /** Cover turns sewage away instead of eating it (Spires). Synced so the client
   *  can draw warded cover differently. */
  @type("boolean") coverReflects = false;
  /** Cover is rebuilt at the start of every later level (Bedrock). Survives a level. */
  coverRebuildsEachLevel = false;
  /** Until this tick, sewage ignores walls entirely (Unhallowed). */
  coverPhaseUntilTick = 0;

  /**
   * Extra lives left, shared by the whole party.
   *
   * Synced because it is a resource three people have to decide about together,
   * so all three need to see it drop. Spent by pressing special while down or
   * dead; refilled only when a wipe restarts the run. While any remain, nobody
   * standing is not yet a loss — see checkOutcome.
   */
  @type("uint8") lives = 0;

  /**
   * The party's running score, and the breakdown of what the last cleared level
   * added to it.
   *
   * The three components are stored rather than recomputed for display, because
   * startLevel rebuilds the town: a client counting standing houses live would
   * show a breakdown for a town that no longer exists by the time anyone reads
   * it. These are what was actually awarded.
   */
  @type("uint32") score = 0;
  @type("uint32") lastScoreChunks = 0;
  @type("uint32") lastScoreBoss = 0;
  @type("uint32") lastScoreHuts = 0;
  @type("uint32") lastScoreWalls = 0;
  @type("uint32") lastScoreTotal = 0;
  /** The level the last award was for, so the breakdown can name it. */
  @type("uint16") lastScoreLevel = 0;

  /**
   * Session id of whoever paused, or "" when running.
   *
   * Deliberately its own field rather than another `outcome` value: a pause
   * happens *during* a level and must not overwrite the outcome it interrupts.
   * Only the player named here can lift it — see ArenaRoom's pause handler.
   */
  @type("string") pausedBy = "";
  /** Their name, so everyone's overlay can say who stopped the game. */
  @type("string") pausedByName = "";

  /** OUTCOME_PLAYING / OUTCOME_WON / OUTCOME_LOST / OUTCOME_WAITING / OUTCOME_COUNTDOWN. */
  @type("uint8") outcome = 0;
  /** Absolute tick the level ends on. Surviving to it wins. */
  @type("uint32") levelEndTick = 0;
  /** 1-based, and the level just played or currently running. */
  @type("uint16") level = 1;
  /**
   * The level a start would begin. Held apart from `level` so the Dungeon Master
   * reads a summary of the level that just ended while the button offers the
   * next one.
   */
  @type("uint16") pendingLevel = 1;

  @type(Dm) dm = new Dm();
  @type(Boss) boss = new Boss();

  /**
   * The Dungeon Master's live difficulty slider, 1 being the tuned value.
   *
   * Scales the Clog's speed and the Gullet's healing — the one number that
   * decides how hard each fight is. Read every tick rather than sampled at
   * spawn, so dragging it mid-fight takes effect immediately. Survives a level
   * boundary and a wipe: it is the DM's preference, not run state.
   */
  @type("number") bossDifficulty = 1;

  /**
   * A level the Dungeon Master has forced the run to jump to next, or 0.
   *
   * A testing tool: the DM's "skip to level" arms this, and endLevel honours it
   * in place of the level that would otherwise come. Synced so the DM's panel
   * can show which level is armed rather than the DM having to remember.
   */
  @type("uint16") forcedNextLevel = 0;

  /** Team counters, same lvl/run split as the per-player ones. */
  @type("uint32") lvlChunksSpawned = 0;
  @type("uint32") lvlChunksKilled = 0;
  @type("uint16") lvlStructuresLost = 0;
  @type("uint32") lvlTicks = 0;

  @type("uint32") runChunksSpawned = 0;
  @type("uint32") runChunksKilled = 0;
  @type("uint16") runStructuresLost = 0;
  @type("uint32") runTicks = 0;
  /** While an outcome is showing, the tick the next level starts on. */
  @type("uint32") intermissionEndTick = 0;
}

export {
  OUTCOME_PLAYING, OUTCOME_WON, OUTCOME_LOST, OUTCOME_WAITING, OUTCOME_COUNTDOWN,
  OUTCOME_VICTORY,
} from "../shared/types";

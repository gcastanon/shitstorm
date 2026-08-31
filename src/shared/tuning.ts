/**
 * Types for tuning.json. The server loads the JSON from disk and sends it to
 * clients on join, so neither side hardcodes a number.
 */
export interface DashTuning {
  speed: number; durationSec: number; cooldownSec: number; invulnerable: boolean;
}

/**
 * Melee and ranged attacks carry different fields, so this is a discriminated
 * union rather than a bag of optionals: narrowing on `kind` is what lets the
 * server read `reach` without a cast and stops it reading `reach` off a bow.
 */
export interface MeleeAttackTuning {
  kind: "melee";
  cooldownSec: number;
  reach: number;
  arcDegrees: number;
  windupSec: number;
  activeSec: number;
  splitsLarge: boolean;
  destroysSmall: boolean;
  passesThroughAllies: boolean;
}

export interface RangedAttackTuning {
  kind: "ranged";
  cooldownSec: number;
  projectileSpeed: number;
  projectileRadius: number;
  maxRange: number;
  splitsLarge: boolean;
  destroysSmall: boolean;
  consumedOnHit: boolean;
  passesThroughAllies: boolean;
  passesThroughBubble: boolean;
}

export type AttackTuning = MeleeAttackTuning | RangedAttackTuning;

/**
 * Specials, same discriminated-union treatment as attacks. Only the throne is
 * built; the other two are typed from tuning.json so that filling them in is a
 * matter of writing code against fields that already have shapes.
 */
export interface ThroneSpecialTuning {
  kind: "throne";
  cooldownSec: number;
  durationSec: number;
  rootsCaster: boolean;
  casterInvulnerable: boolean;
  bubbleRadiusPlayerWidths: number;
  bubbleBlocksAsteroids: boolean;
  bubbleBlocksPlayers: boolean;
  bubbleBlocksProjectiles: boolean;
  reflectedSewageHurtsAllies: boolean;
  reflectPreservesSpeed: boolean;
}

export interface GrappleSpecialTuning {
  kind: "grapple";
  cooldownSec: number;
  /** The Ranger plants his feet while the hook is out. */
  rootsCaster: boolean;
  hookSpeed: number;
  maxRange: number;
  pullSpeed: number;
  cancelOnDamage: boolean;
  cooldownOnMiss: boolean;
  asteroidAnchorDetonates: boolean;
  anchorLostVelocityDecaySec: number;
  /** Blast radius when the Harpoon perk is held. Unused without it. */
  harpoonBlastRadius: number;
}

export interface SwallowSpecialTuning {
  kind: "swallow";
  cooldownSec: number;
  cooldownStartsOnRelease: boolean;
  durationSec: number;
  grabRadius: number;
  capacity: number;
  passengerRegenPerSec: number;
  passengerInvulnerable: boolean;
  passengerLosesInput: boolean;
  canSwallowDowned: boolean;
  swallowingDownedBlocksSkulls: boolean;
  swallowingDoesNotRevive: boolean;
  releaseInvulnSec: number;
  releaseOnDruidDeath: boolean;
}

export type SpecialTuning = ThroneSpecialTuning | GrappleSpecialTuning | SwallowSpecialTuning;

export interface CharacterTuning {
  displayName: string;
  color: string;
  maxHealth: number;
  speed: number;
  accel: number;
  passiveRegenPerSec?: number;
  dash: DashTuning;
  attack: AttackTuning;
  special: SpecialTuning;
}

export interface DownedTuning {
  skullsToDie: number;
  skullsPerAsteroidHit: number;
  crawlSpeedMultiplier: number;
  resetSkullsOnRevive: boolean;
  reviveSeconds: number;
  reviveRadius: number;
  reviveDecayMultiplier: number;
  reviverMayUseAbilities: boolean;
  revivedHealthFraction: number;
  revivedInvulnSec: number;
}

export interface WavesTuning {
  /** Expected waves in a level. Waves keep cycling past it; this caps escalation
   *  and is what the HUD counts against. */
  countPerLevel: number;
  spawnSec: number;
  /** Quiet gap between waves. 0 disables lulls entirely. */
  lullSec: number;
  /** Each wave divides the spawn interval by this, compounding. */
  intensityPerWave: number;
}

export interface TierTuning {
  radius: number;
  speedMin: number;
  speedMax: number;
  playerDamage: number;
  wallDamage: number;
  skullsWhenDowned: number;
}

export interface Tuning {
  net: { tickHz: number; patchHz: number; maxCommandsPerTick: number; interpDelayMs: number };
  arena: { width: number; height: number; padding: number };
  boss: {
    /** Level numbers that are boss fights instead of waves. */
    levels: number[];
    /** The clog/wellspring hp values are for one player. Each extra player
     *  present at spawn adds this much of the base again. */
    hpPerExtraPlayer: number;
    /** Replaces level.durationSec on a boss level. */
    durationSec: number;
    /** The DM's live slider is clamped to this range. */
    difficultyMin: number;
    difficultyMax: number;
    meleeDamage: number;
    arrowDamage: number;
    grappleDamage: number;
    devourDamage: number;
    reckoningDamage: number;
    clog: {
      hp: number; radius: number; speed: number; shedSec: number;
      phaseAtHealthFraction: number; phaseSpeedMul: number; phaseShedMul: number;
      razeSec: number;
    };
    wellspring: {
      hp: number; radius: number; pumpSec: number; pumpCount: number;
      healPerStructureLost: number;
    };
  };
  score: {
    perBossKill: number;
    perChunkDestroyed: number;
    /** A hut is the town; a wall is cover. They are deliberately not worth the same. */
    perHutStanding: number;
    perWallStanding: number;
    /** The level multiplier climbs by this much per level past the first. */
    levelMulStep: number;
  };
  level: {
    durationSec: number;
    /** Seconds between a level being started and sewage flying. Not part of
     *  durationSec — levelEndTick is set when the countdown ends. */
    countdownSec: number;
    seed: number;
    /** One pool shared by the whole party, spent by pressing special while down
     *  or dead. Refilled only when a wipe restarts the run. */
    extraLives: number;
    allThreeDownedIsLoss: boolean;
    deathPersistsAcrossLevels: boolean;
    /** Pause between a level ending and the next one starting. */
    intermissionSec: number;
    /** How long the level-up screen waits before picking for you. One player
     *  must never be able to hold the others up indefinitely. */
    choiceTimeoutSec: number;
    perkOfferCount: number;
    /** Whether a connected Dungeon Master gates the start of each level. With no
     *  DM connected the level starts on its own either way. */
    requireDmToStart: boolean;
    /** Whether survivors start the next level topped up. Downed and dead
     *  players are unaffected either way — that is what persists. */
    healToFullBetweenLevels: boolean;
  };
  player: { radius: number; maxPlayers: number; hitInvulnSec: number; startHealth: number };
  downed: DownedTuning;
  waves: WavesTuning;
  characters: Record<string, CharacterTuning>;
  asteroids: {
    large: TierTuning;
    small: TierTuning;
    split: { childCount: number; spreadDegrees: number; speedMultiplier: number; childrenImmuneToSameSwing: boolean };
    consumedOnPlayerHit: boolean;
    consumedOnWallHit: boolean;
    collideWithEachOther: boolean;
    spawn: {
      intervalStartSec: number; intervalMinSec: number; rampSec: number;
      largeChance: number; offscreenMargin: number; aimJitterDegrees: number;
      targetInset: number; maxAlive: number;
      /** Level-1 speed multiplier, and the compounding climb from there. Capped
       *  by speedMaxMul so sewage never outruns what a player can react to. */
      speedStartMul: number; speedPerLevel: number; speedMaxMul: number;
      /** The spawn interval is DIVIDED by this, compounding per level. */
      intervalPerLevel: number;
    };
  };
  structures: {
    /** The centred box every structure is placed inside. Everything outside it
     *  is open ground — see townBox() in structures.ts. */
    townWidth: number;
    townHeight: number;
    hut: { hp: number; width: number; height: number };
    wall: { hp: number; width: number; height: number };
    hutCount: number;
    wallCount: number;
    minGap: number;
    spawnClearRadius: number;
    repairableBetweenLevels: boolean;
    [k: string]: any;
  };
  friendlyFire: Record<string, boolean>;
  debug: {
    allowStructureDamage: boolean;
    damageReach: number;
    /** M4 removes this along with the R key, once downed/revive is real. */
    allowHealthReset: boolean;
  };
}

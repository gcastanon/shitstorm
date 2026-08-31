/**
 * Level-up perks.
 *
 * Shared, not server-only, and that is the whole point: several perks change how
 * a player moves, so `stepPlayer` has to see them. Both sides derive the same
 * `PerkMods` from the same list of ids with the same function, which is what
 * keeps prediction honest — only the ids go over the wire, and the arithmetic
 * that turns them into numbers lives here where both sides run it.
 *
 * A perk is either numeric, in which case taking it again stacks, or a flag, in
 * which case it leaves your pool once taken because a second copy would do
 * nothing.
 */

export interface PerkMods {
  // --- read by stepPlayer, and therefore predicted ---
  /** Seconds added to the dash cooldown. Negative shortens it. */
  dashCdAdd: number;
  /**
   * Attack as fast as the tick rate allows.
   *
   * A flag rather than the multiplier this used to be. Nothing scales attack
   * speed any more — no perk, no upgrade — so a multiplier would imply a
   * spectrum nothing populates. Exactly one thing sets this, and it is an
   * ultimate that suspends the cooldown outright.
   */
  noAttackCooldown: boolean;
  specialCdAdd: number;
  specialCdMul: number;
  speedMul: number;
  dashDistMul: number;
  /** Replaces downed.crawlSpeedMultiplier outright when non-zero. */
  crawlOverride: number;
  /** Extra speed multiplier applied only below half health. */
  lowHealthSpeedMul: number;
  /** The throne stops rooting its caster. */
  noRoot: boolean;

  // --- server-side ---
  maxHealthAdd: number;
  damageTakenMul: number;
  hitInvulnAdd: number;
  skullsAdd: number;
  reviveSpeedMul: number;
  reviveFullHealth: boolean;
  dashInvuln: boolean;
  reachMul: number;
  destroyLarge: boolean;
  regenAdd: number;
  /** Health returned for each chunk you destroy (Scavenger). */
  healPerKill: number;
  /** Chunks destroyed between cover repairs, or 0 for never (Salvage). */
  salvageEvery: number;

  throneRadiusAdd: number;
  throneDurAdd: number;
  sanctuary: boolean;
  cleave: boolean;

  /**
   * Arrows loosed per press. A count rather than the flag it started as,
   * because Windrunner's Fan wants five and Split Shot wants three. Everything
   * that raises it does so with `Math.max`, which keeps applyPerks
   * order-independent.
   */
  arrowsPerShot: number;
  /**
   * How many hits an arrow survives. Zero is consumed by the first chunk it
   * touches; one goes through that chunk and is stopped by the next.
   *
   * A count rather than the flag it started as, so Piercing can stack. Infinity
   * is a legitimate value and is what the two Ranger ultimates use — it stays
   * server-side on the projectile, so it never has to survive being synced.
   */
  pierceCount: number;
  /** Arrows curve toward the nearest chunk (Hunting Shot). */
  homingArrows: boolean;
  /** Arrows fly through cover instead of being stopped by it (Arrow Storm). */
  arrowsPhaseWalls: boolean;
  harpoon: boolean;
  arrowMul: number;

  swallowDurAdd: number;
  swallowCapAdd: number;
  passengerRegenMul: number;
  grabRadiusMul: number;
  biteArcAdd: number;
  verdant: boolean;
}

export function noMods(): PerkMods {
  return {
    dashCdAdd: 0, noAttackCooldown: false, specialCdAdd: 0, specialCdMul: 1,
    speedMul: 1, dashDistMul: 1, crawlOverride: 0, lowHealthSpeedMul: 1, noRoot: false,

    maxHealthAdd: 0, damageTakenMul: 1, hitInvulnAdd: 0, skullsAdd: 0,
    reviveSpeedMul: 1, reviveFullHealth: false, dashInvuln: false,
    reachMul: 1, destroyLarge: false, regenAdd: 0,
    healPerKill: 0, salvageEvery: 0,

    throneRadiusAdd: 0, throneDurAdd: 0, sanctuary: false, cleave: false,

    arrowsPerShot: 1, pierceCount: 0, homingArrows: false, arrowsPhaseWalls: false,
    harpoon: false, arrowMul: 1,

    swallowDurAdd: 0, swallowCapAdd: 0, passengerRegenMul: 1,
    grabRadiusMul: 1, biteArcAdd: 0, verdant: false,
  };
}

export interface PerkDef {
  id: string;
  name: string;
  text: string;
  /** Undefined means every character may be offered it. */
  character?: string;
  /** Flags are offered once; numeric perks stack. */
  flag?: boolean;
  apply(m: PerkMods): void;
}

export const PERKS: PerkDef[] = [
  // --- generic, sim-side ---
  { id: "quick-feet", name: "Quick Feet", text: "-0.5s dash cooldown",
    apply: (m) => { m.dashCdAdd -= 0.5; } },
  { id: "long-legs", name: "Long Legs", text: "+10% move speed",
    apply: (m) => { m.speedMul *= 1.1; } },
  { id: "deep-breath", name: "Deep Breath", text: "-2s special cooldown",
    apply: (m) => { m.specialCdAdd -= 2; } },
  { id: "bounding", name: "Bounding", text: "+40% dash distance",
    apply: (m) => { m.dashDistMul *= 1.4; } },
  { id: "crawler", name: "Crawler", text: "Crawl at 70% speed instead of 40%", flag: true,
    apply: (m) => { m.crawlOverride = 0.7; } },
  { id: "adrenaline", name: "Adrenaline", text: "+25% move speed below half health", flag: true,
    apply: (m) => { m.lowHealthSpeedMul = 1.25; } },

  // --- generic, server-side ---
  { id: "thick-skin", name: "Thick Skin", text: "+25 max health",
    apply: (m) => { m.maxHealthAdd += 25; } },
  { id: "bulwark", name: "Bulwark", text: "Sewage does 25% less damage to you",
    apply: (m) => { m.damageTakenMul *= 0.75; } },
  { id: "second-wind", name: "Second Wind", text: "+0.4s invulnerability after a hit",
    apply: (m) => { m.hitInvulnAdd += 0.4; } },
  { id: "iron-will", name: "Iron Will", text: "+1 skull before you die",
    apply: (m) => { m.skullsAdd += 1; } },
  { id: "field-medic", name: "Field Medic", text: "Revive allies 40% faster",
    apply: (m) => { m.reviveSpeedMul *= 1.4; } },
  { id: "die-hard", name: "Die Hard", text: "Revived at full health", flag: true,
    apply: (m) => { m.reviveFullHealth = true; } },
  { id: "dash-ward", name: "Dash Ward", text: "Invulnerable for the whole dash", flag: true,
    apply: (m) => { m.dashInvuln = true; } },
  { id: "reach", name: "Reach", text: "+25% melee reach and arrow range",
    apply: (m) => { m.reachMul *= 1.25; } },
  { id: "demolition", name: "Demolition", text: "Attacks destroy Large sewage instead of splitting it", flag: true,
    apply: (m) => { m.destroyLarge = true; } },
  { id: "regrowth", name: "Regrowth", text: "Regain 2 health per second",
    apply: (m) => { m.regenAdd += 2; } },
  { id: "scavenger", name: "Scavenger", text: "Destroying sewage heals you 1 health",
    apply: (m) => { m.healPerKill += 1; } },
  // Zero means "not taken", so the first one has to set the threshold rather
  // than subtract from it. Every stack after halves the wait instead of raising
  // the repair — twice as often, not twice as much. Still order-independent,
  // because every copy is the same perk and only the count can vary.
  { id: "salvage", name: "Salvage", text: "Every 8 chunks you destroy repairs your most damaged cover",
    apply: (m) => { m.salvageEvery = m.salvageEvery === 0 ? 8 : Math.max(1, m.salvageEvery - 4); } },

  // --- Warlock ---
  { id: "wider-throne", name: "Wider Throne", text: "+1 player-width throne radius", character: "warlock",
    apply: (m) => { m.throneRadiusAdd += 1; } },
  { id: "longer-reign", name: "Longer Reign", text: "+1.5s throne duration", character: "warlock",
    apply: (m) => { m.throneDurAdd += 1.5; } },
  { id: "unmoored", name: "Unmoored", text: "The throne no longer roots you", character: "warlock", flag: true,
    apply: (m) => { m.noRoot = true; } },
  { id: "sanctuary", name: "Sanctuary", text: "Allies in your bubble take no sewage damage", character: "warlock", flag: true,
    apply: (m) => { m.sanctuary = true; } },
  { id: "cleave", name: "Cleave", text: "Your melee sweeps a full circle", character: "warlock", flag: true,
    apply: (m) => { m.cleave = true; } },

  // --- Ranger ---
  { id: "split-shot", name: "Split Shot", text: "Fire three arrows in a spread", character: "ranger", flag: true,
    apply: (m) => { m.arrowsPerShot = Math.max(m.arrowsPerShot, 3); } },
  { id: "piercing", name: "Piercing", text: "Arrows pass through one more chunk", character: "ranger",
    apply: (m) => { m.pierceCount += 1; } },
  { id: "zip-line", name: "Zip Line", text: "Halve the grapple cooldown", character: "ranger",
    apply: (m) => { m.specialCdMul *= 0.5; } },
  { id: "harpoon", name: "Harpoon", text: "Grappled sewage detonates everything near it", character: "ranger", flag: true,
    apply: (m) => { m.harpoon = true; } },
  { id: "fletching", name: "Fletching", text: "+50% arrow speed and range", character: "ranger",
    apply: (m) => { m.arrowMul *= 1.5; } },

  // --- Druid ---
  { id: "bigger-gulp", name: "Bigger Gulp", text: "+1s swallow duration", character: "druid",
    apply: (m) => { m.swallowDurAdd += 1; } },
  { id: "second-stomach", name: "Second Stomach", text: "Swallow two allies at once", character: "druid", flag: true,
    apply: (m) => { m.swallowCapAdd += 1; } },
  { id: "rapid-digestion", name: "Rapid Digestion", text: "Passengers heal twice as fast", character: "druid",
    apply: (m) => { m.passengerRegenMul *= 2; } },
  { id: "gape", name: "Gape", text: "+50% grab radius, +40 degree bite", character: "druid",
    apply: (m) => { m.grabRadiusMul *= 1.5; m.biteArcAdd += 40; } },
  { id: "verdant", name: "Verdant", text: "Your regeneration also heals nearby allies", character: "druid", flag: true,
    apply: (m) => { m.verdant = true; } },
];

/**
 * The reach and arc a melee swing actually covers, after perks.
 *
 * Shared because the server sweeps it and the client draws it, and those two
 * disagreeing is exactly the class of bug this project has spent its whole life
 * avoiding. Cleave and Reach and Gape all change what a swing hits; if the arc
 * on screen still came from raw tuning, the drawing would be lying about the
 * hitbox — which is the one thing the debug view has never done.
 */
export function meleeSweep(
  atk: { reach: number; arcDegrees: number },
  m: PerkMods,
): { reach: number; arcDegrees: number } {
  return {
    reach: atk.reach * m.reachMul,
    arcDegrees: m.cleave ? 360 : atk.arcDegrees + m.biteArcAdd,
  };
}

const BY_ID = new Map(PERKS.map((p) => [p.id, p]));

export function perkById(id: string): PerkDef | undefined {
  return BY_ID.get(id);
}

/**
 * Fold a list of taken perk ids into numbers.
 *
 * Order-independent by construction — every perk either adds or multiplies, so
 * the same set always produces the same mods no matter what sequence they were
 * picked in. That matters because the client rebuilds this from a synced list
 * whose order it does not control.
 */
export function applyPerks(ids: readonly string[]): PerkMods {
  const m = noMods();
  for (const id of ids) BY_ID.get(id)?.apply(m);
  return m;
}

/**
 * How many times a stacking perk may be taken.
 *
 * Flags were always once-only; this is the same idea for the numeric ones, which
 * could otherwise be taken every level for the whole run. Enforced here rather
 * than at each call site so rollOffer, dealOffers and the card screen all
 * inherit it — they every one go through offerPool.
 */
export const MAX_STACKS = 3;

/** Perks this character could still be offered, given what they already hold. */
export function offerPool(character: string, taken: readonly string[]): PerkDef[] {
  return PERKS.filter((p) => {
    if (p.character !== undefined && p.character !== character) return false;
    if (p.flag) return !taken.includes(p.id);
    return taken.filter((id) => id === p.id).length < MAX_STACKS;
  });
}

/**
 * Three distinct perks, drawn with a caller-supplied RNG so the roll is
 * reproducible from the level seed rather than from Math.random.
 */
export function rollOffer(character: string, taken: readonly string[], rng: () => number, count = 3): string[] {
  const pool = offerPool(character, taken);
  const picked: string[] = [];
  // Partial Fisher-Yates over a copy: cheap, and cannot repeat a perk.
  const bag = pool.slice();
  for (let i = 0; i < count && bag.length > 0; i++) {
    const j = Math.floor(rng() * bag.length);
    picked.push(bag[j]!.id);
    bag.splice(j, 1);
  }
  return picked;
}

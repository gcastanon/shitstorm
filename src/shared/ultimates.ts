import type { PerkMods } from "./perks";

/**
 * Ultimates: one enormous ability per class, once per level, unlocked by
 * surviving to level 5 and improved at 10 and 15.
 *
 * Shared rather than server-only for the same reason perks are: some of them
 * change how the player moves or attacks, so `stepPlayer` has to see them. The
 * ids are synced and both sides derive the effect from the same functions here.
 *
 * Effects split the usual way. Anything that changes the caster's own movement
 * or cooldowns goes through `ultimateMods`, which layers onto the perk mods and
 * is therefore predicted. Anything that changes the world — reversing sewage,
 * rebuilding cover, raising the dead — is read off these definitions by the
 * server alone.
 */

export interface UltimateDef {
  id: string;
  name: string;
  text: string;
  character: string;
  /** Seconds it stays active. Zero resolves instantly on the press. */
  durationSec: number;
  /** Whether it pins the caster in place while it runs. */
  roots?: boolean;
}

export const ULTIMATES: UltimateDef[] = [
  // --- Warlock ---
  {
    id: "cathedral", character: "warlock", durationSec: 8, roots: true,
    name: "Cathedral",
    text: "A throne four times the size for 8s. Everything it touches is turned away, allies included.",
  },
  {
    id: "reckoning", character: "warlock", durationSec: 0,
    name: "Reckoning",
    text: "Every chunk on screen reverses and doubles speed. The storm goes back the way it came.",
  },
  {
    id: "consecrate", character: "warlock", durationSec: 0,
    name: "Consecrate",
    text: "All cover is rebuilt, and none of it can be destroyed for the rest of the level.",
  },

  // --- Ranger ---
  {
    id: "arrow-storm", character: "ranger", durationSec: 0,
    name: "Arrow Storm",
    text: "Thirty-six piercing arrows at once, in every direction, straight through walls.",
  },
  {
    id: "slow-storm", character: "ranger", durationSec: 5,
    name: "Slow the Storm",
    text: "All sewage crawls at a quarter speed for 5s. You do not.",
  },
  {
    id: "windrunner", character: "ranger", durationSec: 8,
    name: "Windrunner",
    text: "For 8s the bow has no cooldown, arrows pierce, and every shot is three.",
  },

  // --- Druid ---
  {
    id: "devour", character: "druid", durationSec: 5, roots: true,
    name: "Devour the Storm",
    text: "The maw opens wide for 5s. Anything that comes close is eaten, and every mouthful heals the team.",
  },
  {
    id: "grove", character: "druid", durationSec: 4,
    name: "Grove",
    text: "Swallow the whole team at once. For 4s nobody can be touched, and everybody heals.",
  },
  {
    id: "rebirth", character: "druid", durationSec: 0,
    name: "Rebirth",
    text: "Every downed ally stands up at full health, and one of the dead comes back.",
  },
];

export interface UpgradeDef {
  id: string;
  /** The ultimate this improves. Only offered to someone holding it. */
  ultimate: string;
  name: string;
  text: string;
}

export const UPGRADES: UpgradeDef[] = [
  { id: "nave", ultimate: "cathedral", name: "Nave", text: "+50% radius" },
  { id: "vigil", ultimate: "cathedral", name: "Vigil", text: "+4 seconds" },
  { id: "reliquary", ultimate: "cathedral", name: "Reliquary", text: "Allies inside heal to full over the duration" },

  { id: "doubling", ultimate: "reckoning", name: "Doubling", text: "Reversed chunks break apart as they turn" },
  { id: "unhallowed", ultimate: "reckoning", name: "Unhallowed", text: "Reversed chunks pass through walls" },
  { id: "echo", ultimate: "reckoning", name: "Echo", text: "It happens again three seconds later" },

  { id: "ramparts", ultimate: "consecrate", name: "Ramparts", text: "Rebuilt cover has double health and survives into the next level" },
  { id: "spires", ultimate: "consecrate", name: "Spires", text: "Cover turns sewage away like a throne" },
  { id: "bedrock", ultimate: "consecrate", name: "Bedrock", text: "Cover is rebuilt at the start of every later level too" },

  { id: "quiver", ultimate: "arrow-storm", name: "Quiver", text: "Twice the arrows" },
  { id: "barbed", ultimate: "arrow-storm", name: "Barbed", text: "Arrows destroy chunks outright instead of breaking them apart" },
  { id: "rally", ultimate: "arrow-storm", name: "Rally", text: "It fires again four seconds later" },

  { id: "stillness", ultimate: "slow-storm", name: "Stillness", text: "A tenth speed instead of a quarter" },
  { id: "long-hour", ultimate: "slow-storm", name: "Long Hour", text: "+4 seconds" },
  { id: "dilation", ultimate: "slow-storm", name: "Dilation", text: "You move 25% faster while it lasts" },

  { id: "gale", ultimate: "windrunner", name: "Gale", text: "+5 seconds" },
  { id: "fan", ultimate: "windrunner", name: "Fan", text: "Five arrows a shot instead of three" },
  { id: "hunting-shot", ultimate: "windrunner", name: "Hunting Shot", text: "Arrows curve toward the nearest chunk" },

  { id: "gullet", ultimate: "devour", name: "Gullet", text: "+60% radius" },
  { id: "feast", ultimate: "devour", name: "Feast", text: "Twice the healing, and downed allies lose a skull" },
  { id: "endless", ultimate: "devour", name: "Endless", text: "+4 seconds" },

  { id: "deep-roots", ultimate: "grove", name: "Deep Roots", text: "+3 seconds" },
  { id: "bloom", ultimate: "grove", name: "Bloom", text: "Anyone downed comes out revived at full health" },
  { id: "thorns", ultimate: "grove", name: "Thorns", text: "Chunks that touch you while it lasts are destroyed" },

  { id: "communion", ultimate: "rebirth", name: "Communion", text: "Everyone revived gains +25 max health for the rest of the run" },
  { id: "second-life", ultimate: "rebirth", name: "Second Life", text: "Every dead player comes back, not one" },
  { id: "renewal", ultimate: "rebirth", name: "Renewal", text: "Everyone's special and ultimate are ready again" },
];

const ULT_BY_ID = new Map(ULTIMATES.map((u) => [u.id, u]));
const UP_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export const ultimateById = (id: string) => ULT_BY_ID.get(id);
export const upgradeById = (id: string) => UP_BY_ID.get(id);

/** True if `id` names anything in this file, perk pools aside. */
export function isUltimateChoice(id: string): boolean {
  return ULT_BY_ID.has(id) || UP_BY_ID.has(id);
}

export const ultimatesFor = (character: string) =>
  ULTIMATES.filter((u) => u.character === character);

/** Upgrades still available for the ultimate this player holds. */
export function upgradesFor(ultimateId: string, taken: readonly string[]): UpgradeDef[] {
  return UPGRADES.filter((u) => u.ultimate === ultimateId && !taken.includes(u.id));
}

const has = (ups: readonly string[], id: string) => ups.includes(id);

/** How long it runs, after upgrades. Zero still means instant. */
export function ultimateDurationSec(id: string, ups: readonly string[]): number {
  const u = ULT_BY_ID.get(id);
  if (!u || u.durationSec === 0) return 0;

  let d = u.durationSec;
  if (id === "cathedral" && has(ups, "vigil")) d += 4;
  if (id === "slow-storm" && has(ups, "long-hour")) d += 4;
  if (id === "windrunner" && has(ups, "gale")) d += 5;
  if (id === "devour" && has(ups, "endless")) d += 4;
  if (id === "grove" && has(ups, "deep-roots")) d += 3;
  return d;
}

export function ultimateRoots(id: string): boolean {
  return ULT_BY_ID.get(id)?.roots === true;
}

/**
 * What an active ultimate does to the caster's own numbers.
 *
 * Layered on top of the perk mods inside stepPlayer, so it is predicted exactly
 * as perks are — no second mechanism, and the client derives it from the same
 * synced ids the server used.
 */
export function ultimateMods(id: string, ups: readonly string[], m: PerkMods): void {
  if (id === "windrunner") {
    // The one thing in the game that touches attack speed, and it does not scale
    // it — it suspends it. The floor in secToTicks turns this into one arrow per
    // tick rather than an infinite loop.
    m.noAttackCooldown = true;
    // Unlimited, not a tier: this is once per level and eight seconds long.
    m.pierceCount = Infinity;
    m.arrowsPerShot = Math.max(m.arrowsPerShot, windrunnerArrows(ups));
    if (has(ups, "hunting-shot")) m.homingArrows = true;
  }
  if (id === "slow-storm" && has(ups, "dilation")) {
    m.speedMul *= 1.25;
  }
}

// --- world effects, read by the server ---

/** Sewage speed multiplier while Slow the Storm runs. */
export const slowStormFactor = (ups: readonly string[]) => (has(ups, "stillness") ? 0.1 : 0.25);

/** Cathedral bubble radius, as a multiple of the normal throne bubble. */
export const cathedralRadiusMul = (ups: readonly string[]) => (has(ups, "nave") ? 6 : 4);

export const arrowStormCount = (ups: readonly string[]) => (has(ups, "quiver") ? 72 : 36);

/** Arrows per shot during Windrunner. */
export const windrunnerArrows = (ups: readonly string[]) => (has(ups, "fan") ? 5 : 3);

/** Seconds until an ultimate fires a second time, or 0 for never. */
export function ultimateEchoSec(id: string, ups: readonly string[]): number {
  if (id === "reckoning" && has(ups, "echo")) return 3;
  if (id === "arrow-storm" && has(ups, "rally")) return 4;
  return 0;
}

export const devourRadiusMul = (ups: readonly string[]) => (has(ups, "gullet") ? 1.6 : 1);
export const devourHealMul = (ups: readonly string[]) => (has(ups, "feast") ? 2 : 1);

/**
 * How far Devour reaches, composed in one place.
 *
 * Shared for the same reason `throneBubbleRadius` and `cathedralRadiusMul` are:
 * the client draws the maw at exactly this, and a maw drawn anywhere but where
 * the server actually eats is worse than no maw at all. The server used to
 * compose it inline in `tickDevour`, which is precisely how the two would drift.
 *
 * The fallback covers a non-melee caster — nothing offers Devour to one today,
 * but `tickDevour` has always had the branch and deleting it here would move a
 * decision without meaning to.
 */
export function devourReach(
  atk: { kind: string; reach?: number },
  playerRadius: number,
  ups: readonly string[],
): number {
  const base = atk.kind === "melee" ? (atk.reach ?? 0) : playerRadius * 4;
  return base * DEVOUR_REACH_MUL * devourRadiusMul(ups);
}

/** How long Unhallowed lets reversed sewage ignore walls. */
export const RECKONING_PHASE_SEC = 3;
/** Max health each ally gains from Communion. */
export const REBIRTH_HEALTH_BONUS = 25;
/** Devour's reach, as a multiple of the Druid's melee reach. */
export const DEVOUR_REACH_MUL = 4;
/** Health restored per chunk eaten by Devour. */
export const DEVOUR_HEAL_PER_CHUNK = 4;
/** How fast a Hunting Shot arrow turns toward its target, in radians a second. */
export const HUNTING_TURN_RATE = 6;
/** How far a Hunting Shot arrow looks for something to curve toward. */
export const HUNTING_SEEK_RANGE = 320;

export { has as hasUpgrade };

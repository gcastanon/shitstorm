import { clamp } from "./math";
import { isStanding, type StructureBox } from "./structures";
import type { Tuning } from "./tuning";

/**
 * Wire-cheap tier codes. Radius, speed, damage, toughness and what a chunk
 * breaks into all come from tuning, looked up by name.
 *
 * A table rather than the pair of constants and the ternary this used to be.
 * Every tier-shaped decision — what it breaks into, how many hits it takes, when
 * it starts appearing, which sprite it wears — now lives beside the numbers in
 * `tuning.json` instead of being a second ternary somewhere else.
 *
 * **Order is load-bearing.** `pickTier` walks this array, so putting `large`
 * first with the two original weights summing to 1 makes the level 1-4 draw
 * bit-identical to the `rng() < largeChance` it replaced. Reordering it would
 * silently reshuffle every seeded run.
 */
export const TIER_LARGE = 0;
export const TIER_SMALL = 1;
/** Armoured: two hits, then it breaks into Smalls. From level 5. */
export const TIER_CRUST = 2;
/** Breaks into two Large rather than two Small. From level 15. */
export const TIER_BOLUS = 3;
export type Tier = 0 | 1 | 2 | 3;

export const TIER_NAMES = ["large", "small", "crust", "bolus"] as const;
export type TierName = (typeof TIER_NAMES)[number];
export const TIERS: Tier[] = [TIER_LARGE, TIER_SMALL, TIER_CRUST, TIER_BOLUS];

export const tierName = (tier: Tier): TierName => TIER_NAMES[tier] ?? "small";
export const tierCfg = (t: Tuning, tier: Tier) => t.asteroids[tierName(tier)];
export const tierRadius = (t: Tuning, tier: Tier) => tierCfg(t, tier).radius as number;
/** Hits this tier survives. One for everything except the armoured type. */
export const tierHits = (t: Tuning, tier: Tier) => Math.max(1, tierCfg(t, tier).hits);

/** The tier a name refers to, or null. */
export function tierByName(name: string): Tier | null {
  const i = TIER_NAMES.indexOf(name as TierName);
  return i < 0 ? null : (i as Tier);
}

/** What this tier breaks into when its last hit lands, or null for nothing. */
export function tierSplitsInto(t: Tuning, tier: Tier): Tier | null {
  const into = tierCfg(t, tier).splitsInto;
  return into ? tierByName(into) : null;
}

/**
 * Which tier the next chunk is, weighted, among those the level has unlocked.
 *
 * Consumes exactly one value from `rng`, and at levels below the first
 * `fromLevel` the weights are the original two summing to 1 — so a seeded run
 * before level 5 draws precisely what it drew before this existed.
 */
export function pickTier(t: Tuning, level: number, rng: () => number): Tier {
  let total = 0;
  for (const tier of TIERS) {
    const cfg = tierCfg(t, tier);
    if (level >= cfg.fromLevel) total += cfg.weight;
  }
  if (total <= 0) return TIER_SMALL;

  let r = rng() * total;
  for (const tier of TIERS) {
    const cfg = tierCfg(t, tier);
    if (level < cfg.fromLevel) continue;
    r -= cfg.weight;
    if (r < 0) return tier;
  }
  return TIER_SMALL;
}

export interface AsteroidSim {
  id: string;
  tier: Tier;
  /** Hits left before it breaks. Part of the sim shape rather than bolted on by
   *  the server, so split children carry their own toughness out of
   *  `splitAsteroid` and the client can draw a cracked one. */
  hits: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** True once the chunk has drifted far enough out that it can never come back. */
export function isOutOfPlay(a: AsteroidSim, t: Tuning): boolean {
  const m = t.asteroids.spawn.offscreenMargin * 2;
  return a.x < -m || a.x > t.arena.width + m || a.y < -m || a.y > t.arena.height + m;
}

/** Circle vs circle. */
export function circlesOverlap(
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): boolean {
  const dx = ax - bx, dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/** Circle vs AABB, for sewage hitting a hut. */
export function circleHitsBox(cx: number, cy: number, r: number, b: StructureBox): boolean {
  const nx = cx - clamp(cx, b.x - b.w / 2, b.x + b.w / 2);
  const ny = cy - clamp(cy, b.y - b.h / 2, b.y + b.h / 2);
  return nx * nx + ny * ny <= r * r;
}

/** First standing structure this chunk is touching, or null. */
export function firstStructureHit(
  a: AsteroidSim,
  t: Tuning,
  boxes: readonly StructureBox[],
): StructureBox | null {
  const r = tierRadius(t, a.tier);
  for (const b of boxes) {
    if (!isStanding(b)) continue;
    if (circleHitsBox(a.x, a.y, r, b)) return b;
  }
  return null;
}

/**
 * Split a chunk whose last hit has landed.
 *
 * What it yields comes from the tier's own `splitsInto`: Large and the armoured
 * crust yield two Small, the bolus yields two **Large** — which then split
 * again, so one bolus is seven hits and four fragments — and Small yields
 * nothing. Children are sped up slightly, so clearing a wave makes the field
 * faster and messier rather than simply smaller; through a bolus that compounds
 * twice, and its final fragments fly at 1.32x what it did.
 *
 * `awayAngle` is the direction pointing from the attacker toward the chunk, and
 * the fan is measured off it. That is what stops a swing spraying the fragments
 * it just made into the face of whoever made them: at a spread of 90 the
 * children leave exactly perpendicular to the attacker, so neither one closes on
 * them from any angle of attack, and anything under 90 angles them further away.
 * A spread above 90 would aim them back at the attacker.
 *
 * Omitting it falls back to fanning off the chunk's own heading, which is the
 * behaviour anything that does not know who struck the chunk still gets.
 *
 * Returns [] for a tier that breaks into nothing, which is the caller's signal
 * that it just died.
 */
export function splitAsteroid(
  a: AsteroidSim,
  t: Tuning,
  makeId: () => string,
  awayAngle?: number,
): AsteroidSim[] {
  const into = tierSplitsInto(t, a.tier);
  if (into === null) return [];

  const cfg = t.asteroids.split;
  const speed = Math.hypot(a.vx, a.vy) * cfg.speedMultiplier;
  const axis = awayAngle ?? Math.atan2(a.vy, a.vx);
  const spread = (cfg.spreadDegrees * Math.PI) / 180;
  const count: number = cfg.childCount;

  const out: AsteroidSim[] = [];
  for (let i = 0; i < count; i++) {
    // Fan evenly across the spread: two children land at -spread and +spread.
    const frac = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const ang = axis + frac * spread;
    out.push({
      id: makeId(),
      tier: into,
      hits: tierHits(t, into),
      x: a.x,
      y: a.y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
    });
  }
  return out;
}

/** Straight-line advance. Sewage never accelerates or curves. */
export function stepAsteroid(a: AsteroidSim, dt: number) {
  a.x += a.vx * dt;
  a.y += a.vy * dt;
}

/**
 * Reflect a chunk off a structure, for Consecrate's Spires.
 *
 * Same idea as the bubble, but the normal comes from the closest point on the
 * box rather than from a centre, so a chunk clipping a wall's end leaves along
 * the end rather than straight back. A chunk whose centre is inside the box has
 * no usable normal — that only happens to something spawned on top of cover —
 * so it is left alone and the caller consumes it as usual.
 */
export function reflectOffBox(a: AsteroidSim, b: StructureBox, t: Tuning): boolean {
  const hw = b.w / 2, hh = b.h / 2;
  const px = Math.max(b.x - hw, Math.min(a.x, b.x + hw));
  const py = Math.max(b.y - hh, Math.min(a.y, b.y + hh));

  let nx = a.x - px, ny = a.y - py;
  const len = Math.hypot(nx, ny);
  if (len === 0) return false;
  nx /= len; ny /= len;

  const vn = a.vx * nx + a.vy * ny;
  if (vn < 0) {
    a.vx -= 2 * vn * nx;
    a.vy -= 2 * vn * ny;
  }
  // Park it clear of the face, so it cannot reflect again next tick.
  const r = tierRadius(t, a.tier);
  a.x = px + nx * (r + 0.5);
  a.y = py + ny * (r + 0.5);
  return true;
}

/**
 * Reflect a chunk off the Warlock's bubble. Mirror the velocity about the
 * contact normal, preserving speed. Used in M3; lives here so the reflection and
 * the movement it reflects stay in one file.
 */
export function reflectOffCircle(
  a: AsteroidSim,
  cx: number,
  cy: number,
  bubbleRadius: number,
  t: Tuning,
) {
  let nx = a.x - cx, ny = a.y - cy;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;

  const vn = a.vx * nx + a.vy * ny;
  if (vn < 0) {
    a.vx -= 2 * vn * nx;
    a.vy -= 2 * vn * ny;
  }
  // Park it just outside the shell so it cannot reflect twice on consecutive ticks.
  const r = tierRadius(t, a.tier);
  a.x = cx + nx * (bubbleRadius + r + 0.5);
  a.y = cy + ny * (bubbleRadius + r + 0.5);
}

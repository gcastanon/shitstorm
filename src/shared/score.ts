import type { Tuning } from "./tuning";

/**
 * The party's score.
 *
 * One number for the whole run, not one each: half of it comes from how much of
 * the town is left standing, which nobody achieves alone.
 *
 * Shared rather than server-only for the same reason `applyPerks` and
 * `ultimateMods` are. The server awards the total and the client renders the
 * breakdown that explains it, and if those were two separate pieces of
 * arithmetic they would eventually disagree about why a player scored what they
 * scored — which is worse than having no breakdown at all.
 */

export interface LevelScore {
  /** Points from sewage destroyed, before the multiplier. */
  chunks: number;
  /** Flat points for killing a boss, before the multiplier. Zero on a normal level. */
  boss: number;
  /** Points from huts left standing, before the multiplier. */
  huts: number;
  /** Points from walls left standing, before the multiplier. */
  walls: number;
  /** The level multiplier the three were scaled by. */
  mul: number;
  /** What the level actually awarded. */
  total: number;
}

/**
 * How much a cleared level is worth.
 *
 * The multiplier climbs by a flat step per level rather than scaling with the
 * level number directly: a straight `x level` makes level 20 worth twenty times
 * level 1 and turns the whole score into a measure of how deep you got. A
 * quarter-step per level still rewards depth without drowning out everything
 * that happened on the way.
 */
export function scoreForLevel(
  t: Tuning,
  chunksKilled: number,
  hutsStanding: number,
  wallsStanding: number,
  level: number,
  bossKilled = false,
): LevelScore {
  const s = t.score;
  const mul = 1 + s.levelMulStep * Math.max(0, level - 1);

  const n = (v: number) => Math.max(0, Math.round(v));
  const chunks = n(chunksKilled) * s.perChunkDestroyed;
  const huts = n(hutsStanding) * s.perHutStanding;
  const walls = n(wallsStanding) * s.perWallStanding;
  const boss = bossKilled ? s.perBossKill : 0;

  return { chunks, boss, huts, walls, mul, total: Math.round((chunks + boss + huts + walls) * mul) };
}

/** Thousands separators, so a five-figure score is readable at a glance. */
export function formatScore(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

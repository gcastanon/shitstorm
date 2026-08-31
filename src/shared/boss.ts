import { BOSS_CLOG, BOSS_NONE, BOSS_WELLSPRING } from "./types";
import type { Tuning } from "./tuning";

/**
 * Which levels are boss fights, and which boss each one runs.
 *
 * Shared because the Dungeon Master's "skip to next boss" button has to label
 * itself with the level it will actually send everyone to. A client working that
 * out from its own copy of the rule would eventually disagree with the server
 * about which level is a boss — the same reason perks and scoring live here.
 */

export function isBossLevel(t: Tuning, level: number): boolean {
  return t.boss.levels.includes(level);
}

export function bossKindFor(t: Tuning, level: number): string {
  if (!isBossLevel(t, level)) return BOSS_NONE;
  // The first boss level is the Clog and every later one the Wellspring, so a
  // third entry in the list needs no second table.
  return level === t.boss.levels[0] ? BOSS_CLOG : BOSS_WELLSPRING;
}

/**
 * The next boss level strictly after `level`, wrapping to the first once they
 * are all behind you — so the button keeps working on a deep run instead of
 * going dead after level 20.
 */
export function nextBossLevel(t: Tuning, level: number): number {
  const levels = [...t.boss.levels].sort((a, b) => a - b);
  if (levels.length === 0) return level + 1;
  return levels.find((l) => l > level) ?? levels[0]!;
}

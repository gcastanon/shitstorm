import { BOSS_CLOG, BOSS_GULLET, BOSS_NONE } from "./types";
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

/**
 * What a boss is called, for anything a player reads.
 *
 * Here because three places want it — the health bar, the DM's difficulty label
 * and the DM's skip buttons — and the first two had already grown their own
 * copies of the same ternary.
 */
export function bossName(kind: string): string {
  if (kind === BOSS_CLOG) return "THE CLOG";
  if (kind === BOSS_GULLET) return "THE GULLET";
  return "";
}

export function bossKindFor(t: Tuning, level: number): string {
  if (!isBossLevel(t, level)) return BOSS_NONE;
  // The first boss level is the Clog and every later one the Gullet, so a third
  // entry in the list needs no second table.
  return level === t.boss.levels[0] ? BOSS_CLOG : BOSS_GULLET;
}

/** True for the last boss in the list — clearing it finishes the run. */
export function isFinalBossLevel(t: Tuning, level: number): boolean {
  const levels = [...t.boss.levels].sort((a, b) => a - b);
  return levels.length > 0 && level === levels[levels.length - 1];
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tuning } from "../shared/tuning";

const TUNING_PATH = resolve(process.cwd(), "tuning.json");

let cached: Tuning | null = null;

/** Read tuning.json from disk. Restart the server to pick up edits; no rebuild needed. */
export function loadTuning(): Tuning {
  if (cached) return cached;
  const raw = readFileSync(TUNING_PATH, "utf8");
  cached = JSON.parse(raw) as Tuning;
  return cached;
}

export function tuningPath() {
  return TUNING_PATH;
}

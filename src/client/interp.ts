import { lerp } from "../shared/math";
import type { RemoteSnapshotPlayer, Snapshot } from "./net";

/**
 * Entity interpolation. Remote players render interpDelayMs in the past so
 * there are always two snapshots to blend between, which hides the 20Hz patch
 * rate. Raising the delay smooths jitter at the cost of visual latency.
 */
export function sampleRemote(
  snapshots: Snapshot[],
  id: string,
  renderTime: number,
): RemoteSnapshotPlayer | null {
  if (snapshots.length === 0) return null;

  let older: Snapshot | null = null;
  let newer: Snapshot | null = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].t <= renderTime) {
      older = snapshots[i];
      newer = snapshots[i + 1] ?? null;
      break;
    }
  }

  // Render time is behind everything we have: show the oldest we know about.
  if (!older) {
    return snapshots[0].players.get(id) ?? null;
  }
  const a = older.players.get(id);
  if (!a) return null;
  if (!newer) return a; // extrapolation is deliberately not done in M0

  const b = newer.players.get(id);
  if (!b) return a;

  const span = newer.t - older.t;
  const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - older.t) / span)) : 0;

  return {
    ...a,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    aim: lerpAngle(a.aim, b.aim, t),
  };
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

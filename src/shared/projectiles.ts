import type { Tuning } from "./tuning";

/**
 * Arrows and grapple hooks. Both are straight-line travellers with a range
 * limit, so they share a step function and differ only in what the server does
 * when one touches something.
 *
 * Neither is predicted. Like sewage, the server alone decides what they hit and
 * the client extrapolates them along their line purely for rendering.
 */
export interface ProjectileSim {
  id: string;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Distance covered so far, against which maxRange is checked. */
  travelled: number;
}

export function stepProjectile(p: ProjectileSim, dt: number): void {
  const dx = p.vx * dt;
  const dy = p.vy * dt;
  p.x += dx;
  p.y += dy;
  p.travelled += Math.hypot(dx, dy);
}

/** True once it has run out of range or left the arena entirely. */
export function projectileSpent(p: ProjectileSim, maxRange: number, t: Tuning): boolean {
  if (p.travelled >= maxRange) return true;
  return p.x < 0 || p.x > t.arena.width || p.y < 0 || p.y > t.arena.height;
}

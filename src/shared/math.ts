export interface Vec2 { x: number; y: number }

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Return a copy scaled down to unit length if it is longer than 1. */
export function clampUnit(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len > 1) return { x: v.x / len, y: v.y / len };
  return { x: v.x, y: v.y };
}

export function dist(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

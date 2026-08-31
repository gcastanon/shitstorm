import { clamp } from "./math";
import { spawnPoint } from "./sim";
import type { Tuning } from "./tuning";

export type StructureKind = "hut" | "wall";

/** Axis-aligned box with hit points. x/y is the CENTRE, w/h are full extents. */
export interface StructureBox {
  id: string;
  kind: StructureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
}

/**
 * Takes anything with hit points rather than a full StructureBox, so the
 * server's `Structure` schema can be tested with it directly. It only ever
 * looked at `hp`, and a second copy of `hp > 0` is exactly the kind of thing
 * that later disagrees with this one.
 */
export const isStanding = (b: { hp: number }) => b.hp > 0;

/** Deterministic PRNG. Same seed gives the same town on every machine. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shortest distance from a point to a box surface; 0 if the point is inside.
 *
 * Takes the geometry rather than a full StructureBox, so the server's
 * `Structure` schema can be measured with it directly — same reasoning as
 * isStanding above, and the same alternative avoided: a second copy of this
 * arithmetic that could disagree with this one.
 */
export function pointToBoxDistance(
  b: { x: number; y: number; w: number; h: number },
  px: number,
  py: number,
) {
  const dx = Math.max(Math.abs(px - b.x) - b.w / 2, 0);
  const dy = Math.max(Math.abs(py - b.y) - b.h / 2, 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Gap between two boxes; 0 if they touch or overlap. */
export function boxGap(a: StructureBox, b: StructureBox) {
  const dx = Math.max(Math.abs(a.x - b.x) - (a.w + b.w) / 2, 0);
  const dy = Math.max(Math.abs(a.y - b.y) - (a.h + b.h) / 2, 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/** The town's bounds. x/y is the CENTRE, w/h the full extents. */
export interface TownBox { x: number; y: number; w: number; h: number; }

/**
 * The centred box every structure lives inside.
 *
 * The single definition of "the town", read by the layout generator, by the
 * sewage spawner that aims at it, and by the client that draws the ground
 * differently inside it. Same reasoning as drawing structures from their literal
 * collision boxes: three copies of this rectangle would eventually disagree, and
 * the disagreement would be invisible until sewage started aiming at ground the
 * houses had moved off.
 *
 * Everything outside it is open ground — the ring you cross to intercept a chunk
 * before it reaches a house.
 */
export function townBox(t: Tuning): TownBox {
  const { width, height, padding } = t.arena;
  const w = t.structures.townWidth;
  const h = t.structures.townHeight;

  // The old layout kept structures minGap from the arena edge so nobody could be
  // pinched between a wall and the boundary. A town inset by at least that much
  // makes the constraint automatic, and this is what guarantees the inset.
  const need = padding + t.structures.minGap;
  if (w > width - need * 2 || h > height - need * 2) {
    throw new Error(
      `town ${w}x${h} does not leave ${need}px clear inside a ${width}x${height} arena`,
    );
  }

  return { x: width / 2, y: height / 2, w, h };
}

/**
 * Lay out a ramshackle town. Rejection sampling with three constraints, all of
 * which exist to keep the arena navigable rather than to look pretty:
 *   - everything inside the town box, so the ring around it stays open
 *   - nothing within spawnClearRadius of a spawn point
 *   - minGap between any two structures, so no gap is too narrow to walk
 *
 * There is deliberately no arena-edge constraint any more: townBox() guarantees
 * the box is inset far enough that a structure at the town's edge still cannot
 * pinch anyone against the boundary. So structures may sit right on the town's
 * edge, which is what keeps the outer houses exposed to the ring rather than
 * tucked behind an invisible margin.
 *
 * Seeded, so a given level seed always produces the same town.
 */
export function generateLayout(t: Tuning, seed = t.level.seed): StructureBox[] {
  const rng = mulberry32(seed);
  const out: StructureBox[] = [];

  const town = townBox(t);
  const minGap = t.structures.minGap;
  const spawnClear = t.structures.spawnClearRadius;
  const spawns = [0, 1, 2].map((i) => spawnPoint(i, t));

  const plan: StructureKind[] = [
    ...Array<StructureKind>(t.structures.hutCount).fill("hut"),
    ...Array<StructureKind>(t.structures.wallCount).fill("wall"),
  ];

  for (const kind of plan) {
    const cfg = t.structures[kind];
    for (let attempt = 0; attempt < 300; attempt++) {
      // Walls are long and thin, so half of them stand on end.
      const vertical = kind === "wall" && rng() < 0.5;
      const w = vertical ? cfg.height : cfg.width;
      const h = vertical ? cfg.width : cfg.height;

      const minX = town.x - town.w / 2 + w / 2;
      const maxX = town.x + town.w / 2 - w / 2;
      const minY = town.y - town.h / 2 + h / 2;
      const maxY = town.y + town.h / 2 - h / 2;
      if (maxX <= minX || maxY <= minY) break;

      const box: StructureBox = {
        id: `${kind}-${out.length}`,
        kind,
        x: minX + rng() * (maxX - minX),
        y: minY + rng() * (maxY - minY),
        w, h,
        hp: cfg.hp,
        maxHp: cfg.hp,
      };

      if (spawns.some((s) => pointToBoxDistance(box, s.x, s.y) < spawnClear)) continue;
      if (out.some((o) => boxGap(box, o) < minGap)) continue;

      out.push(box);
      break;
    }
  }

  return out;
}

/**
 * Push a circle out of one box and kill the velocity component heading into the
 * surface. The tangential component survives, which is what makes a player slide
 * along a wall instead of sticking to it.
 */
export function resolveCircleVsBox(
  p: { x: number; y: number; vx: number; vy: number },
  radius: number,
  b: StructureBox,
): boolean {
  const hx = b.w / 2, hy = b.h / 2;
  const dx = p.x - b.x, dy = p.y - b.y;

  // Closest point on the box to the circle centre, in box-local space.
  const cx = clamp(dx, -hx, hx);
  const cy = clamp(dy, -hy, hy);

  let nx = dx - cx, ny = dy - cy;
  const d2 = nx * nx + ny * ny;
  if (d2 > radius * radius) return false;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    const penetration = radius - d;
    p.x += nx * penetration;
    p.y += ny * penetration;
  } else {
    // Centre is inside the box. Eject along the axis of least penetration.
    const overlapX = hx - Math.abs(dx);
    const overlapY = hy - Math.abs(dy);
    if (overlapX < overlapY) {
      const s = dx >= 0 ? 1 : -1;
      p.x = b.x + s * (hx + radius);
      nx = s; ny = 0;
    } else {
      const s = dy >= 0 ? 1 : -1;
      p.y = b.y + s * (hy + radius);
      nx = 0; ny = s;
    }
  }

  const intoSurface = p.vx * nx + p.vy * ny;
  if (intoSurface < 0) {
    p.vx -= intoSurface * nx;
    p.vy -= intoSurface * ny;
  }
  return true;
}

/**
 * Resolve against every standing structure. Iterated twice because resolving
 * one box can push the circle into its neighbour, which is common in corners.
 * Boxes are visited in array order, so server and client must hold the same
 * order or prediction will diverge.
 */
export function resolveCircleVsBoxes(
  p: { x: number; y: number; vx: number; vy: number },
  radius: number,
  boxes: readonly StructureBox[],
  iterations = 2,
): void {
  for (let i = 0; i < iterations; i++) {
    let touched = false;
    for (const b of boxes) {
      if (!isStanding(b)) continue;
      if (resolveCircleVsBox(p, radius, b)) touched = true;
    }
    if (!touched) return;
  }
}

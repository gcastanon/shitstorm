import { ArraySchema } from "@colyseus/schema";
import { GameState, Projectile } from "./GameState";
import { circleHitsBox, circlesOverlap, tierRadius, type Tier } from "../shared/asteroids";
import { projectileSpent, stepProjectile, type ProjectileSim } from "../shared/projectiles";
import { isStanding, type StructureBox } from "../shared/structures";
import type { RangedAttackTuning, Tuning } from "../shared/tuning";
import type { PerkMods } from "../shared/perks";
import { HUNTING_SEEK_RANGE, HUNTING_TURN_RATE } from "../shared/ultimates";

/** Angle between neighbouring arrows in a fan. Presentation-adjacent, not balance. */
const FAN_STEP = 0.18;

/**
 * `n` evenly spaced angles centred on `aim`.
 *
 * Kept as a spacing rather than a total width so a five-arrow Windrunner fan
 * covers more sky than a three-arrow Split Shot instead of just crowding the
 * same wedge with more arrows.
 */
function fanAngles(aim: number, n: number): number[] {
  if (n <= 1) return [aim];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(aim + (i - (n - 1) / 2) * FAN_STEP);
  return out;
}

export interface ProjectileEvents {
  /**
   * An arrow reached a chunk. The room turns this into a split.
   *
   * `heading` is the arrow's direction of travel, which is the axis the
   * fragments fan off — the shooter is somewhere back along that line, so
   * perpendicular to it is away from them.
   */
  /** The arrow reached the boss. Tested after chunks, so a chunk in front of it
   *  still absorbs the shot. Returns whether the arrow is spent. */
  onBossHit?(owner: string): void;
  /** Whether this point is inside the boss. */
  hitsBoss?(x: number, y: number, radius: number): boolean;

  onAsteroidHit(
    asteroidId: string, projectileId: string, heading: number, owner: string,
    /** The arrow removes a Large outright rather than splitting it. Carried on
     *  the arrow rather than looked up from the shooter, because an arrow
     *  outlives the shot — and Arrow Storm's Barbed volley is not the shooter's
     *  ordinary mods. */
    destroys: boolean,
  ): void;
}

/**
 * Ranger arrows.
 *
 * Runs every fixed tick regardless of input, for the same reason sewage does: a
 * starved input queue must never freeze an arrow in mid-air.
 *
 * Not predicted. The client extrapolates arrows along their line exactly the way
 * it extrapolates sewage, and the server alone decides what they hit.
 */
export class ProjectileSystem {
  private nextId = 1;

  constructor(private t: Tuning, private state: GameState) {}

  get count() { return this.state.projectiles.length; }

  /**
   * Launch arrows from the shooter along their aim.
   *
   * Split Shot fires a fan of three; Fletching scales speed and range together
   * so a faster arrow also flies further rather than just dying sooner.
   */
  spawn(owner: string, x: number, y: number, aim: number, atk: RangedAttackTuning, m: PerkMods) {
    const speed = atk.projectileSpeed * m.arrowMul;

    for (const a of fanAngles(aim, m.arrowsPerShot)) {
      const p = new Projectile();
      p.id = `p${this.nextId++}`;
      p.owner = owner;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxRange = atk.maxRange * m.arrowMul * m.reachMul;
      // A bow that tuning says is never consumed on hit stays that way, which is
      // what "overrides rather than replaces" meant when this was a flag.
      p.pierceLeft = atk.consumedOnHit ? m.pierceCount : Infinity;
      p.homing = m.homingArrows;
      p.phaseWalls = m.arrowsPhaseWalls;
      p.destroys = m.destroyLarge;
      this.state.projectiles.push(p);
    }
  }

  update(dt: number, boxes: readonly StructureBox[], ev: ProjectileEvents) {
    const atk = this.rangedTuning();
    if (!atk) return;

    // Backwards: arrows are removed mid-loop when they connect.
    for (let i = this.state.projectiles.length - 1; i >= 0; i--) {
      const a = this.state.projectiles[i];
      if (!a) continue;

      if (a.homing) this.steer(a, dt);
      stepProjectile(a as unknown as ProjectileSim, dt);

      if (projectileSpent(a as unknown as ProjectileSim, a.maxRange, this.t)) {
        this.state.projectiles.splice(i, 1);
        continue;
      }

      // Chunks before walls: the arrow exists to hit sewage, and at 24px of
      // travel per tick the two can only tie in a genuinely ambiguous frame.
      const hitChunk = this.firstAsteroidHit(a.x, a.y, atk.projectileRadius);
      if (hitChunk) {
        ev.onAsteroidHit(hitChunk, a.id, Math.atan2(a.vy, a.vx), a.owner, a.destroys);
        // Spend one pierce, or stop here. Infinity decrements to Infinity, which
        // is exactly what the Ranger's ultimates want.
        if (a.pierceLeft <= 0) this.state.projectiles.splice(i, 1);
        else a.pierceLeft--;
        continue;
      }

      // The boss, after chunks: something in front of it still catches the shot.
      // It spends a pierce like anything else, so a piercing volley rakes it.
      if (ev.hitsBoss?.(a.x, a.y, atk.projectileRadius)) {
        ev.onBossHit?.(a.owner);
        if (a.pierceLeft <= 0) this.state.projectiles.splice(i, 1);
        else a.pierceLeft--;
        continue;
      }

      // Walls stop arrows but take no damage from them. Nothing in the design
      // gives the Ranger a way to demolish cover, and structure damage is a
      // debug-only path that stays off.
      if (!a.phaseWalls && this.firstStandingBox(a.x, a.y, atk.projectileRadius, boxes)) {
        this.state.projectiles.splice(i, 1);
        continue;
      }

      // Allies and the throne bubble are deliberately not tested at all —
      // passesThroughAllies and passesThroughBubble are both true, so the
      // cheapest correct implementation is to never look.
    }
  }

  clear() {
    this.state.projectiles = new ArraySchema<Projectile>();
  }

  /**
   * The one ranged attack in the game. Looked up once per tick rather than per
   * arrow, and by kind rather than by character id, so a second bow-user later
   * needs no change here.
   */
  private rangedTuning(): RangedAttackTuning | null {
    for (const c of Object.values(this.t.characters)) {
      if (c.attack.kind === "ranged") return c.attack;
    }
    return null;
  }

  /**
   * Bend a Hunting Shot arrow toward the nearest chunk.
   *
   * Turn rate rather than a snap to the target angle: an arrow that instantly
   * faces its chunk reads as a guided missile and can double back on the
   * Ranger. Speed is preserved, so range and travel are unaffected.
   */
  private steer(a: Projectile, dt: number) {
    let best: { x: number; y: number } | null = null;
    let bestD = HUNTING_SEEK_RANGE;
    for (const c of this.state.asteroids) {
      const d = Math.hypot(c.x - a.x, c.y - a.y);
      if (d < bestD) { bestD = d; best = { x: c.x, y: c.y }; }
    }
    if (!best) return;

    const speed = Math.hypot(a.vx, a.vy);
    if (speed === 0) return;

    const cur = Math.atan2(a.vy, a.vx);
    const want = Math.atan2(best.y - a.y, best.x - a.x);
    // Shortest way round, so an arrow never turns 350 degrees to go 10.
    let diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const max = HUNTING_TURN_RATE * dt;
    diff = Math.max(-max, Math.min(max, diff));

    a.vx = Math.cos(cur + diff) * speed;
    a.vy = Math.sin(cur + diff) * speed;
  }

  private firstAsteroidHit(x: number, y: number, r: number): string | null {
    for (const a of this.state.asteroids) {
      if (circlesOverlap(x, y, r, a.x, a.y, tierRadius(this.t, a.tier as Tier))) return a.id;
    }
    return null;
  }

  private firstStandingBox(x: number, y: number, r: number, boxes: readonly StructureBox[]) {
    for (const b of boxes) {
      if (!isStanding(b)) continue;
      if (circleHitsBox(x, y, r, b)) return b;
    }
    return null;
  }
}

import { GameState, Player } from "./GameState";
import { circleHitsBox, circlesOverlap, tierRadius, type Tier } from "../shared/asteroids";
import { secToTicks } from "../shared/sim";
import { isStanding, type StructureBox } from "../shared/structures";
import type { GrappleSpecialTuning, Tuning } from "../shared/tuning";

export interface GrappleEvents {
  /**
   * The hook reached a chunk. Anchoring to sewage detonates it instead.
   *
   * Carries the Ranger as well as the chunk, because whether the detonation
   * takes its neighbours with it is a property of who fired the hook.
   */
  onAsteroidAnchor(asteroidId: string, ranger: Player): void;

  /** Whether the hook is inside the boss. Optional: most levels have none. */
  hitsBoss?(x: number, y: number): boolean;
  /** The hook buried itself in the boss and the Ranger is being hauled in. */
  onBossAnchor?(ranger: Player): void;
}

/**
 * The Ranger's grapple.
 *
 * Split across the prediction line the same way the throne is. The hook flight
 * and what it lands on are server-only, because where it lands depends on
 * asteroid positions the client does not simulate. The *pull* it produces is
 * ordinary movement, so it lives in stepPlayer and the client predicts it from
 * the anchor as soon as a reconcile tells it where that anchor is.
 *
 * Runs every tick outside the input loop: a hook must not hang in the air
 * because its owner's input queue ran dry.
 */
export class GrappleSystem {
  constructor(private t: Tuning, private state: GameState) {}

  /** Fire a hook from the Ranger along their aim. The cooldown is already spent. */
  fire(p: Player, aim: number) {
    const sp = this.tuningFor(p);
    if (!sp) return;

    p.hookActive = true;
    p.hookX = p.x;
    p.hookY = p.y;
    p.hookVx = Math.cos(aim) * sp.hookSpeed;
    p.hookVy = Math.sin(aim) * sp.hookSpeed;
    p.hookTravelled = 0;
  }

  /**
   * Drop everything in flight and ramp any pull down to nothing. Called when the
   * Ranger takes damage, which cancelOnDamage asks for, and when an anchor stops
   * existing underneath him.
   */
  cancel(p: Player) {
    const sp = this.tuningFor(p);
    p.hookActive = false;
    // Ends the root too: specialTicks is the predicted "hook is out" clock.
    p.specialTicks = 0;

    if (p.pullTicks > 0 && sp) {
      p.pullTicks = 0;
      p.pullAnchorId = "";
      p.pullDecayTicks = secToTicks(sp.anchorLostVelocityDecaySec, this.t);
    }
  }

  update(dt: number, boxes: readonly StructureBox[], ev: GrappleEvents) {
    this.state.players.forEach((p) => {
      const sp = this.tuningFor(p);
      if (!sp) return;

      this.expireLostAnchor(p, boxes);
      if (p.hookActive) this.stepHook(p, sp, dt, boxes, ev);
    });
  }

  /**
   * A pull whose wall fell out from under it. The anchor point still exists as
   * coordinates, but yanking toward rubble is not what the player asked for, so
   * it decays instead. This is the case anchorLostVelocityDecaySec exists for.
   */
  private expireLostAnchor(p: Player, boxes: readonly StructureBox[]) {
    if (p.pullTicks <= 0 || p.pullAnchorId === "") return;
    const box = boxes.find((b) => b.id === p.pullAnchorId);
    if (box && isStanding(box)) return;
    this.cancel(p);
  }

  private stepHook(
    p: Player,
    sp: GrappleSpecialTuning,
    dt: number,
    boxes: readonly StructureBox[],
    ev: GrappleEvents,
  ) {
    const dx = p.hookVx * dt;
    const dy = p.hookVy * dt;
    p.hookX += dx;
    p.hookY += dy;
    p.hookTravelled += Math.hypot(dx, dy);

    // The boss first of all: it is the biggest thing on the board, and a hook
    // that visibly buries itself in it must not sail through to a wall behind.
    // It anchors rather than detonating — a grapple removes a Large outright,
    // and letting that reach a boss would end the fight on one press.
    if (ev.hitsBoss?.(p.hookX, p.hookY)) {
      this.dropHook(p);
      p.pullAnchorX = p.hookX;
      p.pullAnchorY = p.hookY;
      p.pullAnchorId = "";
      p.pullTicks = secToTicks(sp.maxRange / sp.pullSpeed, this.t) + 1;
      p.pullDecayTicks = 0;
      ev.onBossAnchor?.(p);
      return;
    }

    // Sewage next: a chunk in front of a wall should detonate rather than let
    // the hook pass through it to anchor on the wall behind.
    const chunk = this.firstAsteroidHit(p.hookX, p.hookY);
    if (chunk) {
      this.dropHook(p);
      if (sp.asteroidAnchorDetonates) ev.onAsteroidAnchor(chunk, p);
      // No anchor and so no pull: detonating a chunk spends the grapple.
      return;
    }

    const box = this.firstStandingBox(p.hookX, p.hookY, boxes);
    if (box) {
      this.dropHook(p);
      p.pullAnchorX = p.hookX;
      p.pullAnchorY = p.hookY;
      p.pullAnchorId = box.id;
      // A cap, not a duration: the pull normally ends on arrival. One extra tick
      // absorbs the rounding so a full-range shot cannot stop a hair short.
      p.pullTicks = secToTicks(sp.maxRange / sp.pullSpeed, this.t) + 1;
      p.pullDecayTicks = 0;
      return;
    }

    // A miss costs the full cooldown, which was already spent on the press, so
    // there is nothing to do here but drop the hook.
    if (p.hookTravelled >= sp.maxRange || this.outOfArena(p.hookX, p.hookY)) {
      this.dropHook(p);
    }
  }

  /**
   * End the hook's flight, however it ended. Clearing specialTicks is what
   * unroots the Ranger: stepPlayer roots him for as long as that clock runs, and
   * the client is predicting against the maximum flight time until this lands.
   */
  private dropHook(p: Player) {
    p.hookActive = false;
    p.specialTicks = 0;
  }

  private outOfArena(x: number, y: number) {
    return x < 0 || x > this.t.arena.width || y < 0 || y > this.t.arena.height;
  }

  private tuningFor(p: Player): GrappleSpecialTuning | null {
    const sp = this.t.characters[p.character]?.special;
    return sp && sp.kind === "grapple" ? sp : null;
  }

  private firstAsteroidHit(x: number, y: number): string | null {
    for (const a of this.state.asteroids) {
      if (circlesOverlap(x, y, 0, a.x, a.y, tierRadius(this.t, a.tier as Tier))) return a.id;
    }
    return null;
  }

  private firstStandingBox(x: number, y: number, boxes: readonly StructureBox[]) {
    for (const b of boxes) {
      if (!isStanding(b)) continue;
      if (circleHitsBox(x, y, 0, b)) return b;
    }
    return null;
  }
}

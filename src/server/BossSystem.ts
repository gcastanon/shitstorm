import { Boss, GameState, Structure } from "./GameState";
import { isStanding, pointToBoxDistance, townBox } from "../shared/structures";
import { BOSS_CLOG, BOSS_NONE, BOSS_WELLSPRING } from "../shared/types";
import { bossKindFor, isBossLevel } from "../shared/boss";
import type { Tuning } from "../shared/tuning";

/** What the room has to act on, since only it may end a level or spawn sewage. */
export interface BossEvents {
  /** The Clog sheds a chunk from its wake, or the Wellspring pumps one out. */
  onSpit(x: number, y: number, heading: number): void;
  /** The Clog pulled a building down. */
  onRaze(structureId: string): void;
  /** Nothing is left standing — the Clog has finished the town. */
  onTownLost(): void;
}

/**
 * The Clog and the Wellspring.
 *
 * Runs every fixed tick from outside the input loop, beside AsteroidSystem and
 * for the same reason: a boss must not stop advancing because one player's
 * command queue ran dry.
 *
 * The difficulty slider is read here, every tick, rather than sampled when the
 * boss spawns — that is what lets the Dungeon Master drag it mid-fight and see
 * it take effect.
 */
export class BossSystem {
  constructor(private t: Tuning, private state: GameState) {}

  private get boss(): Boss { return this.state.boss; }

  /** True on a level whose waves are replaced by a boss. */
  isBossLevel(level: number): boolean {
    return isBossLevel(this.t, level);
  }

  /** Which boss a level runs, or BOSS_NONE. */
  kindFor(level: number): string {
    return bossKindFor(this.t, level);
  }

  clear() {
    const b = this.boss;
    b.kind = BOSS_NONE;
    b.hp = 0; b.maxHp = 0; b.baseMaxHp = 0; b.radius = 0;
    b.phase = 0; b.razing = false;
    b.vx = 0; b.vy = 0;
    b.shedTimer = 0; b.razeTimer = 0; b.pumpTimer = 0;
  }

  get active(): boolean { return this.boss.kind !== BOSS_NONE && this.boss.hp > 0; }

  /**
   * Put a boss on the board.
   *
   * The Clog comes in from an edge aimed at the town; the Wellspring erupts in
   * the middle of it. Both aim at townBox rather than the arena centre, which is
   * the same rectangle the sewage spawner and the ground rendering read.
   */
  spawn(level: number, rand: () => number) {
    this.clear();
    const kind = this.kindFor(level);
    if (kind === BOSS_NONE) return;

    const b = this.boss;
    const town = townBox(this.t);
    b.kind = kind;

    if (kind === BOSS_CLOG) {
      const cfg = this.t.boss.clog;
      b.baseMaxHp = this.scaledHp(cfg.hp);
      b.maxHp = Math.max(1, Math.round(b.baseMaxHp * this.difficulty()));
      b.hp = b.maxHp;
      b.radius = cfg.radius;

      // Just outside one edge, so it is visibly incoming rather than already
      // among the houses.
      const m = cfg.radius + 40;
      const edge = Math.floor(rand() * 4);
      const along = rand();
      if (edge === 0) { b.x = along * this.t.arena.width; b.y = -m; }
      else if (edge === 1) { b.x = this.t.arena.width + m; b.y = along * this.t.arena.height; }
      else if (edge === 2) { b.x = along * this.t.arena.width; b.y = this.t.arena.height + m; }
      else { b.x = -m; b.y = along * this.t.arena.height; }

      const ang = Math.atan2(town.y - b.y, town.x - b.x);
      b.vx = Math.cos(ang);
      b.vy = Math.sin(ang);
      b.shedTimer = cfg.shedSec;
      return;
    }

    const cfg = this.t.boss.wellspring;
    b.baseMaxHp = this.scaledHp(cfg.hp);
    b.maxHp = Math.max(1, Math.round(b.baseMaxHp * this.difficulty()));
    b.hp = b.maxHp;
    b.radius = cfg.radius;
    b.x = town.x;
    b.y = town.y;
    b.pumpTimer = cfg.pumpSec;
  }

  /**
   * Boss health for the size of the party.
   *
   * The tuned numbers are for one player; each extra adds `hpPerExtraPlayer` of
   * that again, so a boss built to be a real fight for three is not an
   * impossible wall for one.
   *
   * Fixed at spawn rather than tracked live. A health bar that jumps when
   * somebody joins or rage-quits mid-fight is worse than one that is slightly
   * wrong, and a boss whose maximum moves under you cannot be read at all.
   * Floored at one player so an empty room does not produce a zero-health boss
   * that dies to the first arrow.
   */
  private scaledHp(base: number): number {
    const players = Math.max(1, this.state.players.size);
    return Math.round(base * (1 + this.t.boss.hpPerExtraPlayer * (players - 1)));
  }

  /** The DM's slider, clamped. Read fresh every time it is used. */
  private difficulty(): number {
    const { difficultyMin, difficultyMax } = this.t.boss;
    return Math.max(difficultyMin, Math.min(difficultyMax, this.state.bossDifficulty));
  }

  /**
   * Take damage. Everything that hurts a boss comes through here, so there is
   * one place that can see it die.
   */
  damage(amount: number): boolean {
    const b = this.boss;
    if (!this.active || amount <= 0) return false;
    b.hp = Math.max(0, b.hp - Math.round(amount));

    if (b.kind === BOSS_CLOG && b.phase === 0
      && b.hp <= b.maxHp * this.t.boss.clog.phaseAtHealthFraction) {
      b.phase = 1;
    }
    return b.hp <= 0;
  }

  /** The Wellspring drinks whenever the town loses a building. */
  onStructureLost() {
    const b = this.boss;
    if (b.kind !== BOSS_WELLSPRING || b.hp <= 0) return;
    const heal = this.t.boss.wellspring.healPerStructureLost * this.difficulty();
    b.hp = Math.min(b.maxHp, b.hp + Math.round(heal));
  }

  update(dt: number, ev: BossEvents) {
    if (!this.active) return;
    this.retune();
    if (this.boss.kind === BOSS_CLOG) this.updateClog(dt, ev);
    else this.updateWellspring(dt, ev);
  }

  /**
   * Follow the difficulty slider with the health bar.
   *
   * The **fraction** is preserved, not the absolute value: a party that has taken
   * the boss to half stays at half when the Dungeon Master eases off, and only
   * the numbers come down. Rescaling `hp` instead would either hand back progress
   * or delete it, and the bar would jump either way — which is the thing that
   * makes a live control unreadable.
   *
   * Recomputed from `baseMaxHp` rather than from `maxHp`, or every tick would
   * compound the last one.
   */
  /** The Clog is stepped directly by the room, which has to retune it first. */
  retuneNow() { if (this.active) this.retune(); }

  private retune() {
    const b = this.boss;
    if (b.baseMaxHp <= 0) return;

    const want = Math.max(1, Math.round(b.baseMaxHp * this.difficulty()));
    if (want === b.maxHp) return;

    const frac = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    b.maxHp = want;
    // Floored at 1 while it is still alive: a slider drag must never be what
    // kills a boss, or the DM could end the fight by fidgeting.
    b.hp = Math.max(1, Math.min(want, Math.round(frac * want)));
  }

  /**
   * The Clog closes on the town, shedding sewage, and starts pulling buildings
   * down when it arrives.
   *
   * `blocked` is the Cathedral holding it: a throne shell is a wall as far as
   * this is concerned, so eight seconds of it is eight seconds the Clog does not
   * advance. It still sheds, so the shell buys time rather than safety.
   */
  updateClog(dt: number, ev: BossEvents, blocked = false) {
    const b = this.boss;
    const cfg = this.t.boss.clog;
    const town = townBox(this.t);

    const speed = cfg.speed * this.difficulty() * (b.phase === 1 ? cfg.phaseSpeedMul : 1);
    // Sewage speed is scaled by Slow the Storm, and a boss is sewage.
    const factor = this.state.slowFactor || 1;

    // Arrived once its edge is inside the town.
    const insideX = Math.abs(b.x - town.x) <= town.w / 2 + b.radius;
    const insideY = Math.abs(b.y - town.y) <= town.h / 2 + b.radius;
    if (!b.razing && insideX && insideY) {
      b.razing = true;
      b.razeTimer = cfg.razeSec;
    }

    // Once it is in among the houses it goes after whichever is nearest, rather
    // than parking on the town's edge. It arrived on a heading aimed at the
    // middle, and stopping dead there made it look like it had got stuck on
    // something. Steering keeps it moving and makes the next building it is
    // coming for obvious.
    if (b.razing) {
      const next = this.nearestStanding(b.x, b.y);
      if (next) {
        const ang = Math.atan2(next.y - b.y, next.x - b.x);
        b.vx = Math.cos(ang);
        b.vy = Math.sin(ang);
      }
    }

    if (!blocked) {
      b.x += b.vx * speed * factor * dt;
      b.y += b.vy * speed * factor * dt;
    }

    const shedEvery = cfg.shedSec * (b.phase === 1 ? cfg.phaseShedMul : 1);
    b.shedTimer -= dt;
    if (b.shedTimer <= 0) {
      b.shedTimer += shedEvery;
      ev.onSpit(b.x, b.y, Math.random() * Math.PI * 2);
    }

    if (!b.razing) return;

    // Nothing left anywhere: the town is gone and the level with it.
    if (!this.nearestStanding(b.x, b.y)) {
      ev.onTownLost();
      return;
    }

    // It can only pull down what it is actually on top of. This used to raze the
    // nearest standing building with no distance test at all, so a Clog sitting
    // in one corner flattened houses clean across the town.
    const target = this.touching(b.x, b.y, b.radius);
    if (!target) {
      // Travelling between buildings. Reset rather than bank the timer, or it
      // would arrive with a raze already owed and take one instantly.
      b.razeTimer = cfg.razeSec;
      return;
    }

    b.razeTimer -= dt;
    if (b.razeTimer > 0) return;
    b.razeTimer += cfg.razeSec;
    ev.onRaze(target.id);
  }

  /** The Wellspring sits in the town and pumps. */
  private updateWellspring(dt: number, ev: BossEvents) {
    const b = this.boss;
    const cfg = this.t.boss.wellspring;

    b.pumpTimer -= dt;
    if (b.pumpTimer > 0) return;
    b.pumpTimer += cfg.pumpSec;

    for (let i = 0; i < cfg.pumpCount; i++) {
      ev.onSpit(b.x, b.y, Math.random() * Math.PI * 2);
    }
  }

  /**
   * A standing building this disc is actually overlapping.
   *
   * Distance is measured to the box's surface, the same way sewage and melee
   * measure it, so "touching" means what it looks like.
   */
  private touching(x: number, y: number, radius: number): Structure | null {
    let best: Structure | null = null;
    let bestD = Infinity;
    this.state.structures.forEach((s) => {
      if (!isStanding(s)) return;
      const d = pointToBoxDistance(s, x, y);
      if (d <= radius && d < bestD) { bestD = d; best = s; }
    });
    return best;
  }

  private nearestStanding(x: number, y: number): Structure | null {
    let best: Structure | null = null;
    let bestD = Infinity;
    this.state.structures.forEach((s) => {
      if (!isStanding(s)) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best;
  }

  /** Whether a point is inside the boss, for melee and arrows. */
  hits(x: number, y: number, radius: number): boolean {
    const b = this.boss;
    if (!this.active) return false;
    const rr = b.radius + radius;
    const dx = b.x - x, dy = b.y - y;
    return dx * dx + dy * dy <= rr * rr;
  }

  /**
   * Whether a melee sweep caught the boss.
   *
   * Reach is measured to the boss's edge and the bearing to its centre, exactly
   * as AsteroidSystem.inArc does for a chunk — so a swing that looks like it
   * connects, connects.
   */
  inArc(x: number, y: number, aim: number, reach: number, arcDegrees: number): boolean {
    const b = this.boss;
    if (!this.active) return false;

    const dx = b.x - x, dy = b.y - y;
    const dist = Math.hypot(dx, dy) - b.radius;
    if (dist > reach) return false;
    if (arcDegrees >= 360) return true;

    let delta = Math.atan2(dy, dx) - aim;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta) <= (arcDegrees * Math.PI) / 180 / 2;
  }
}

import { ArraySchema } from "@colyseus/schema";
import { Asteroid, GameState } from "./GameState";
import {
  TIER_LARGE, TIER_SMALL, isOutOfPlay, firstStructureHit, reflectOffBox, reflectOffCircle,
  splitAsteroid, stepAsteroid, tierCfg, tierRadius, type AsteroidSim, type Tier,
} from "../shared/asteroids";
import { mulberry32, townBox, type StructureBox } from "../shared/structures";
import { secToTicks } from "../shared/sim";
import type { Tuning } from "../shared/tuning";

export interface AsteroidEvents {
  onStructureHit(structureId: string, damage: number): void;
  onPlayerHit(sessionId: string, damage: number, tier: Tier): void;
  /** A chunk entered play, for the Dungeon Master's counters. */
  onSpawn?(): void;
}

/** An active Warlock throne shell, as far as sewage is concerned. */
export interface Bubble {
  ownerSessionId: string;
  x: number;
  y: number;
  radius: number;
}

/**
 * Owns everything sewage-related: spawning, movement, and what happens when a
 * chunk touches something.
 *
 * Runs every fixed tick regardless of player input. This is exactly the class of
 * system the comment in ArenaRoom.fixedTick warns must live outside the input
 * loop, because a starved input queue must never stall the world.
 *
 * Not part of client prediction. Clients extrapolate sewage along its straight
 * line for rendering, but the server alone decides what is hit.
 */
export class AsteroidSystem {
  private rng: () => number;
  private nextId = 1;
  private spawnTimer = 0;
  private elapsedSec = 0;
  /** Seconds into the current phase, which is also what the ramp reads. */
  private phaseSec = 0;

  constructor(private t: Tuning, private state: GameState, seed: number) {
    // Offset from the layout seed so the town and the sewage are not correlated.
    this.rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.state.waveSpawning = true;
    this.state.waveIndex = 0;
    this.state.wavePhaseEndTick = secToTicks(this.t.waves.spawnSec, this.t);
  }

  get elapsed() { return this.elapsedSec; }
  get count() { return this.state.asteroids.length; }
  get waveIndex() { return this.state.waveIndex; }
  get spawning() { return this.state.waveSpawning; }

  /**
   * Current spawn interval.
   *
   * The ramp is measured against the wave rather than the level: each wave
   * builds from intervalStartSec toward intervalMinSec on its own, and
   * intensityPerWave tightens the whole curve as waves go by. Those are
   * deliberately separate knobs — one shapes a wave, one escalates between
   * them — because a single ramp owning both fights itself the way structure
   * hp and sewage density already do.
   */
  currentInterval(): number {
    const s = this.t.asteroids.spawn;
    const w = this.t.waves;

    const progress = s.rampSec > 0 ? Math.min(1, this.phaseSec / s.rampSec) : 1;
    const base = s.intervalStartSec + (s.intervalMinSec - s.intervalStartSec) * progress;

    // Escalation is capped at countPerLevel so a level that runs long — or a
    // durationSec that outlasts the schedule — cannot spiral into a solid wall.
    const step = Math.min(this.state.waveIndex, Math.max(0, w.countPerLevel - 1));
    return (base / Math.pow(w.intensityPerWave, step)) / this.levelIntervalDiv();
  }

  /**
   * How much tighter the interval is for being on a later level.
   *
   * A third escalation on top of the two above, and deliberately a different
   * axis from both: rampSec shapes a wave, intensityPerWave escalates between
   * waves, and this escalates between levels. Uncapped on purpose — a run deep
   * enough to feel it is a run that has earned the wall.
   */
  private levelIntervalDiv(): number {
    return Math.pow(this.t.asteroids.spawn.intervalPerLevel, Math.max(0, this.state.level - 1));
  }

  /**
   * Chunk speed for being on a later level.
   *
   * Capped, unlike the interval, because the two failure modes are different: a
   * denser storm is still readable, and a fast enough chunk simply cannot be
   * reacted to no matter how good you are. Sewage crosses the ring in about a
   * second at 1x, and speedMaxMul is what keeps that from collapsing.
   */
  private levelSpeedMul(): number {
    const s = this.t.asteroids.spawn;
    const mul = s.speedStartMul * Math.pow(s.speedPerLevel, Math.max(0, this.state.level - 1));
    return Math.min(s.speedMaxMul, mul);
  }

  /**
   * Advance the wave clock. Waves cycle indefinitely rather than stopping after
   * countPerLevel: the level ends on its own timer, and running out of schedule
   * partway through should not leave a dead, sewage-free arena.
   */
  private advancePhase(dt: number) {
    const w = this.t.waves;
    this.phaseSec += dt;

    if (this.state.waveSpawning) {
      if (this.phaseSec < w.spawnSec) return;
      this.state.waveSpawning = false;
      this.phaseSec = 0;
      this.state.wavePhaseEndTick = this.state.tick + secToTicks(w.lullSec, this.t);
      return;
    }

    if (this.phaseSec < w.lullSec) return;
    this.state.waveSpawning = true;
    this.state.waveIndex = Math.min(255, this.state.waveIndex + 1);
    this.phaseSec = 0;
    this.state.wavePhaseEndTick = this.state.tick + secToTicks(w.spawnSec, this.t);
  }

  update(dt: number, boxes: readonly StructureBox[], ev: AsteroidEvents, bubbles: readonly Bubble[] = []) {
    // Slow the Storm scales the step the chunks take, and nothing else. Spawning
    // and the wave clock run at real time — it slows the sewage, not the level.
    const chunkDt = dt * (this.state.slowFactor || 1);

    this.elapsedSec += dt;
    this.advancePhase(dt);

    // Nothing new during a lull. Chunks already in the air keep flying, so the
    // arena drains over the four to seven seconds one takes to cross rather
    // than snapping clean — the start of a lull is still dangerous, and judging
    // when it is safe to commit to a revive is the interesting part.
    if (this.state.waveSpawning) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer += this.currentInterval();
        if (this.state.asteroids.length < this.t.asteroids.spawn.maxAlive) {
          this.spawn();
          ev.onSpawn?.();
        }
      }
    } else {
      // Reset rather than bank: a lull must not end with a burst of spawns that
      // the timer accumulated while nothing was allowed out.
      this.spawnTimer = 0;
    }

    // Iterate backwards: chunks are removed mid-loop on contact.
    for (let i = this.state.asteroids.length - 1; i >= 0; i--) {
      const a = this.state.asteroids[i];
      if (!a) continue;
      stepAsteroid(a as unknown as AsteroidSim, chunkDt);

      if (isOutOfPlay(a as unknown as AsteroidSim, this.t)) {
        this.state.asteroids.splice(i, 1);
        continue;
      }

      // Unhallowed sends reversed sewage out through the town rather than into
      // it, so cover is skipped entirely while it lasts.
      const phasing = this.state.tick < this.state.coverPhaseUntilTick;
      const box = phasing ? null : firstStructureHit(a as unknown as AsteroidSim, this.t, boxes);
      if (box) {
        // Spires turns cover into a wall of thrones: it bounces chunks instead
        // of eating them, and takes no damage for it.
        if (this.state.coverReflects
          && reflectOffBox(a as unknown as AsteroidSim, box, this.t)) continue;

        ev.onStructureHit(box.id, tierCfg(this.t, a.tier as Tier).wallDamage);
        if (this.t.asteroids.consumedOnWallHit) this.state.asteroids.splice(i, 1);
        continue;
      }

      // Bubbles are tested before players, which is the whole point of one: the
      // chunk has to bounce off the shell before it can reach anybody inside.
      // A reflected chunk stays alive and keeps its speed, so it is now an
      // ordinary hazard travelling the other way — including toward teammates,
      // which is exactly what reflectedSewageHurtsAllies asks for.
      const bubble = this.firstBubbleHit(a, bubbles);
      if (bubble) {
        reflectOffCircle(a as unknown as AsteroidSim, bubble.x, bubble.y, bubble.radius, this.t);
        continue;
      }

      const hitPlayer = this.findPlayerHit(a);
      if (hitPlayer) {
        ev.onPlayerHit(hitPlayer, tierCfg(this.t, a.tier as Tier).playerDamage, a.tier as Tier);
        if (this.t.asteroids.consumedOnPlayerHit) this.state.asteroids.splice(i, 1);
        continue;
      }
    }
  }

  /** Apply an attack to one chunk: Large becomes two Small, Small dies. */
  splitById(id: string, swingId?: string, awayAngle?: number): boolean {
    const idx = this.state.asteroids.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    const a = this.state.asteroids[idx];
    if (!a) return false;

    const children = splitAsteroid(a as unknown as AsteroidSim, this.t, () => this.makeId(), awayAngle);
    this.state.asteroids.splice(idx, 1);

    for (const c of children) {
      const child = new Asteroid();
      child.id = c.id; child.tier = c.tier;
      child.x = c.x; child.y = c.y; child.vx = c.vx; child.vy = c.vy;
      // Immunity marker so the swing that created these cannot also destroy them.
      if (this.t.asteroids.split.childrenImmuneToSameSwing) child.swingId = swingId;
      this.state.asteroids.push(child);
    }
    return true;
  }

  /**
   * Every chunk inside a melee arc, nearest first.
   *
   * Reach is measured to the chunk's edge rather than its centre, so a Large
   * connects when it looks like it should. Chunks carrying `swingId` are skipped:
   * that is the marker splitById stamps on children, and it stops one sweep from
   * chaining through the fragments it just created.
   *
   * Returns a plain array — state.asteroids is never sorted or filtered in place.
   */
  inArc(
    x: number, y: number, aim: number,
    reach: number, arcDegrees: number,
    swingId?: string,
  ): Asteroid[] {
    const half = (arcDegrees * Math.PI) / 180 / 2;
    const found: { a: Asteroid; d: number }[] = [];

    for (const a of this.state.asteroids) {
      if (swingId !== undefined && a.swingId === swingId) continue;

      const dx = a.x - x, dy = a.y - y;
      const d = Math.hypot(dx, dy);
      if (d > reach + tierRadius(this.t, a.tier as Tier)) continue;

      // A chunk sitting on top of the player has no meaningful bearing, so skip
      // the arc test rather than let atan2 of ~zero decide it.
      if (d > 1e-6) {
        // Wrap the bearing difference into [-PI, PI] so the arc still works
        // across the seam where aim flips sign.
        const raw = Math.atan2(dy, dx) - aim;
        const diff = Math.atan2(Math.sin(raw), Math.cos(raw));
        if (Math.abs(diff) > half) continue;
      }

      found.push({ a, d });
    }

    found.sort((p, q) => p.d - q.d);
    return found.map((e) => e.a);
  }

  /**
   * Destroy a chunk outright, leaving no children even for a Large. This is not
   * the same as splitting it: the grapple detonates what it anchors to, which is
   * the only thing in the game that removes a Large without producing fragments.
   */
  removeById(id: string): boolean {
    const idx = this.state.asteroids.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.state.asteroids.splice(idx, 1);
    return true;
  }

  byId(id: string): Asteroid | null {
    return this.state.asteroids.find((a) => a.id === id) ?? null;
  }

  /** Every chunk within a radius. Returns a plain array — state is never sorted
   *  or filtered in place. */
  within(x: number, y: number, radius: number): Asteroid[] {
    const out: Asteroid[] = [];
    for (const a of this.state.asteroids) {
      if (Math.hypot(a.x - x, a.y - y) <= radius) out.push(a);
    }
    return out;
  }

  nearestTo(x: number, y: number, maxDist: number): Asteroid | null {
    let best: Asteroid | null = null;
    let bestD = maxDist;
    for (const a of this.state.asteroids) {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  clear() {
    this.state.asteroids = new ArraySchema<Asteroid>();
  }

  /**
   * Wipe the air and put the wave clock back to the start of wave one. Called
   * between levels: a new level should open on a calm arena, not inherit the
   * chunks and the escalation the last one ended with.
   */
  reset() {
    this.clear();
    this.elapsedSec = 0;
    this.phaseSec = 0;
    this.spawnTimer = 0;
    this.state.waveIndex = 0;
    this.state.waveSpawning = true;
    this.state.wavePhaseEndTick = this.state.tick + secToTicks(this.t.waves.spawnSec, this.t);
  }

  /**
   * First bubble whose shell this chunk is touching.
   *
   * reflectOffCircle parks a bounced chunk a full chunk-radius plus a hair
   * outside the shell, so it cannot re-trigger this test on the next tick and
   * rattle in place.
   */
  private firstBubbleHit(a: Asteroid, bubbles: readonly Bubble[]): Bubble | null {
    if (bubbles.length === 0) return null;
    const r = tierRadius(this.t, a.tier as Tier);
    for (const b of bubbles) {
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy <= (b.radius + r) * (b.radius + r)) return b;
    }
    return null;
  }

  private findPlayerHit(a: Asteroid): string | null {
    const ar = tierRadius(this.t, a.tier as Tier);
    const pr = this.t.player.radius;
    const reach = (ar + pr) * (ar + pr);

    let hit: string | null = null;
    this.state.players.forEach((p, id) => {
      if (hit) return;
      if (p.invulnUntilTick > this.state.tick) return;
      const dx = a.x - p.x, dy = a.y - p.y;
      if (dx * dx + dy * dy <= reach) hit = id;
    });
    return hit;
  }

  /**
   * Launch a chunk from just outside one edge, aimed at the town.
   *
   * The town rather than the arena interior, which is what gives the open ring
   * around it a point: sewage converges on the houses, so the ring is quiet
   * unless you deliberately stand in a lane between an edge and the town — and
   * standing in that lane is the whole interception game.
   *
   * aimJitterDegrees still scatters the heading at the source, and the flight
   * from an edge to the town is long, so a real share of chunks miss the town
   * and cross the ring anyway. That is deliberate: going out should not be free.
   */
  private spawn() {
    const s = this.t.asteroids.spawn;
    const W = this.t.arena.width, H = this.t.arena.height;
    const m = s.offscreenMargin;
    const town = townBox(this.t);

    const edge = Math.floor(this.rng() * 4);
    const along = this.rng();
    let x = 0, y = 0;
    if (edge === 0) { x = along * W; y = -m; }
    else if (edge === 1) { x = W + m; y = along * H; }
    else if (edge === 2) { x = along * W; y = H + m; }
    else { x = -m; y = along * H; }

    // targetInset trims each edge of the TARGET REGION, which is now the town
    // and used to be the whole arena. Same key, same meaning, different region —
    // a value tuned against the old arena means something else here.
    const inset = s.targetInset;
    const pick = (centre: number, extent: number) =>
      centre - extent / 2 + extent * (inset + this.rng() * (1 - inset * 2));
    const tx = pick(town.x, town.w);
    const ty = pick(town.y, town.h);

    const jitter = ((this.rng() * 2 - 1) * s.aimJitterDegrees * Math.PI) / 180;
    const ang = Math.atan2(ty - y, tx - x) + jitter;

    const tier: Tier = this.rng() < s.largeChance ? TIER_LARGE : TIER_SMALL;
    const cfg = tierCfg(this.t, tier);
    // Stamped at spawn rather than applied per tick, so a chunk keeps the speed
    // it was launched with even if the level ends around it — and so split
    // children inherit it for free through splitAsteroid's speedMultiplier.
    const speed = (cfg.speedMin + this.rng() * (cfg.speedMax - cfg.speedMin)) * this.levelSpeedMul();

    const a = new Asteroid();
    a.id = this.makeId();
    a.tier = tier;
    a.x = x; a.y = y;
    a.vx = Math.cos(ang) * speed;
    a.vy = Math.sin(ang) * speed;
    this.state.asteroids.push(a);
  }

  /**
   * Put one chunk at a point, on a heading. What a boss sheds or pumps.
   *
   * Separate from spawn() because that one is about the wave system — it picks
   * an edge, aims at the town and is throttled by the spawn interval. This is
   * somebody else's chunk arriving on somebody else's schedule.
   */
  spawnAt(x: number, y: number, heading: number, tier: Tier = TIER_SMALL) {
    if (this.state.asteroids.length >= this.t.asteroids.spawn.maxAlive) return;

    const cfg = tierCfg(this.t, tier);
    const speed = (cfg.speedMin + this.rng() * (cfg.speedMax - cfg.speedMin)) * this.levelSpeedMul();

    const a = new Asteroid();
    a.id = this.makeId();
    a.tier = tier;
    a.x = x; a.y = y;
    a.vx = Math.cos(heading) * speed;
    a.vy = Math.sin(heading) * speed;
    this.state.asteroids.push(a);
  }

  private makeId() {
    return `a${this.nextId++}`;
  }
}

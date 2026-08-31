import type { NetClient } from "./net";
import { LIFE_ALIVE, LIFE_DEAD, LIFE_DOWNED, OUTCOME_WON } from "../shared/types";

/**
 * Turns the state stream into one-off events, so effects can fire on things
 * happening rather than on things being true.
 *
 * Deliberately derived client-side by diffing snapshots instead of having the
 * server broadcast effect messages. Presentation should not get a say in the
 * wire format, and a missed splat costs nothing — whereas a new message type
 * for every visual flourish is how netcode rots.
 *
 * The cost is honest and worth naming: snapshots arrive at patchHz, so anything
 * that starts and finishes between two of them is invisible here. That is fine
 * for particles and would not be fine for anything the simulation reads.
 */
export type FxEvent =
  | { kind: "chunkDied"; x: number; y: number }
  | { kind: "arrowDied"; x: number; y: number }
  | { kind: "structureHit"; x: number; y: number }
  | { kind: "structureDown"; x: number; y: number }
  | { kind: "playerHurt"; x: number; y: number; self: boolean }
  | { kind: "playerDowned"; x: number; y: number; self: boolean }
  | { kind: "playerRevived"; x: number; y: number; self: boolean }
  | { kind: "playerDied"; x: number; y: number; self: boolean }
  // These three carry the player id as well as a position, because the scene
  // attaches an animation to that specific body rather than just spraying
  // particles at a point.
  | { kind: "attack"; id: string; x: number; y: number; ranged: boolean; aim: number }
  | { kind: "dash"; id: string; x: number; y: number }
  | { kind: "special"; id: string; x: number; y: number; special: string }
  | { kind: "waveStart" }
  | { kind: "levelStart"; level: number }
  | { kind: "outcome"; won: boolean };

interface PrevPlayer {
  x: number; y: number;
  health: number;
  lifeState: number;
  dashTicks: number;
  specialTicks: number;
  attackCd: number;
  hookActive: boolean;
  swallowedCount: number;
}

export class EventDiffer {
  private players = new Map<string, PrevPlayer>();
  private chunks = new Map<string, { x: number; y: number }>();
  private arrows = new Map<string, { x: number; y: number }>();
  private structureHp = new Map<string, number>();
  private outcome = 0;
  private level = 0;
  private waveSpawning = true;
  private primed = false;

  /**
   * Ability starts are reported for everyone except the local player, whose own
   * effects are driven from the predictor instead so they land on the frame the
   * button went down rather than a round trip later.
   */
  diff(net: NetClient): FxEvent[] {
    const out: FxEvent[] = [];
    const snap = net.snapshots[net.snapshots.length - 1];
    if (!snap) return out;

    const first = !this.primed;
    this.primed = true;

    // --- players ---
    const seen = new Set<string>();
    snap.players.forEach((p, id) => {
      seen.add(id);
      const self = id === net.sessionId;
      const was = this.players.get(id);
      this.players.set(id, {
        x: p.x, y: p.y,
        health: p.health,
        lifeState: p.lifeState,
        dashTicks: p.dashTicks,
        specialTicks: p.specialTicks,
        attackCd: p.attackCdTicks,
        hookActive: p.hookActive,
        swallowedCount: p.swallowedCount,
      });
      if (!was || first) return;

      if (p.health < was.health) out.push({ kind: "playerHurt", x: p.x, y: p.y, self });

      if (p.lifeState !== was.lifeState) {
        if (p.lifeState === LIFE_DOWNED) out.push({ kind: "playerDowned", x: p.x, y: p.y, self });
        else if (p.lifeState === LIFE_DEAD) out.push({ kind: "playerDied", x: p.x, y: p.y, self });
        else if (p.lifeState === LIFE_ALIVE && was.lifeState === LIFE_DOWNED) {
          out.push({ kind: "playerRevived", x: p.x, y: p.y, self });
        }
      }

      if (self) return;

      // A cooldown that went up can only mean the ability just fired.
      if (p.attackCdTicks > was.attackCd) {
        const ranged = net.tuning.characters[p.character]?.attack.kind === "ranged";
        out.push({ kind: "attack", id, x: p.x, y: p.y, ranged, aim: p.aim });
      }
      if (p.dashTicks > was.dashTicks) out.push({ kind: "dash", id, x: p.x, y: p.y });
      if (p.specialTicks > was.specialTicks || (p.hookActive && !was.hookActive) ||
          p.swallowedCount > was.swallowedCount) {
        const special = net.tuning.characters[p.character]?.special.kind ?? "";
        out.push({ kind: "special", id, x: p.x, y: p.y, special });
      }
    });
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);

    // --- sewage and arrows ---
    // A chunk that vanished while still inside the arena hit something. One that
    // vanished outside simply left, and gets no splat.
    this.reap(this.chunks, net.asteroids, net, out, "chunkDied", first);
    this.reap(this.arrows, net.projectiles, net, out, "arrowDied", first);

    // --- structures ---
    for (const s of net.structures) {
      const was = this.structureHp.get(s.id);
      this.structureHp.set(s.id, s.hp);
      if (was === undefined || first || s.hp >= was) continue;
      out.push(s.hp <= 0
        ? { kind: "structureDown", x: s.x, y: s.y }
        : { kind: "structureHit", x: s.x, y: s.y });
    }

    // --- level flow ---
    if (!first && net.waveSpawning && !this.waveSpawning) out.push({ kind: "waveStart" });
    this.waveSpawning = net.waveSpawning;

    if (!first && net.level !== this.level) out.push({ kind: "levelStart", level: net.level });
    this.level = net.level;

    if (!first && net.outcome !== this.outcome && net.outcome !== 0) {
      out.push({ kind: "outcome", won: net.outcome === OUTCOME_WON });
    }
    this.outcome = net.outcome;

    return out;
  }

  private reap(
    prev: Map<string, { x: number; y: number }>,
    live: readonly { id: string; x: number; y: number }[],
    net: NetClient,
    out: FxEvent[],
    kind: "chunkDied" | "arrowDied",
    first: boolean,
  ) {
    const seen = new Set<string>();
    for (const e of live) {
      seen.add(e.id);
      prev.set(e.id, { x: e.x, y: e.y });
    }
    for (const [id, at] of [...prev]) {
      if (seen.has(id)) continue;
      prev.delete(id);
      if (first) continue;
      if (at.x < 0 || at.x > net.tuning.arena.width) continue;
      if (at.y < 0 || at.y > net.tuning.arena.height) continue;
      out.push({ kind, x: at.x, y: at.y } as FxEvent);
    }
  }
}

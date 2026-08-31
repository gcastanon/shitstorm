import { GameState, Player } from "./GameState";
import { secToTicks } from "../shared/sim";
import { LIFE_ALIVE, LIFE_DEAD } from "../shared/types";
import type { SwallowSpecialTuning, Tuning } from "../shared/tuning";

/**
 * The Druid's swallow.
 *
 * The only ability where one player's state is driven by another player's
 * commands, which is why almost all of it is here rather than in stepPlayer:
 * a passenger's client cannot predict where its Druid is going.
 *
 * Runs every tick outside the input loop. That is not a style choice here — the
 * release deadline is absolute and server-owned precisely so a Druid who stops
 * sending input cannot hold a teammate captive forever.
 */
export class SwallowSystem {
  constructor(private t: Tuning, private state: GameState) {}

  /**
   * Try to swallow the nearest ally in range. Returns false if nobody was close
   * enough, which the room turns into an immediate cooldown — a miss should cost
   * something, and cooldownStartsOnRelease means nothing started it on press.
   */
  swallow(druid: Player): boolean {
    const sp = this.tuningFor(druid);
    if (!sp) return false;
    if (druid.swallowedIds.length >= sp.capacity + druid.mods.swallowCapAdd) return false;

    const target = this.nearestAlly(druid, sp.grabRadius * druid.mods.grabRadiusMul);
    if (!target) return false;

    druid.swallowedIds.push(target.sessionId);
    // One deadline for the whole mouthful: grabbing a second ally does not
    // extend the first one's stay.
    if (druid.swallowedIds.length === 1) {
      druid.swallowUntilTick = this.state.tick
        + secToTicks(sp.durationSec + druid.mods.swallowDurAdd, this.t);
    }
    target.carriedBy = druid.sessionId;

    // Cancel anything the passenger had in flight. They have no input now, so a
    // dash or a pull left running would drag them out of the Druid.
    target.dashTicks = 0;
    target.pullTicks = 0;
    target.pullDecayTicks = 0;
    target.vx = 0;
    target.vy = 0;
    return true;
  }

  update(dt: number, onRelease: (druid: Player) => void) {
    this.state.players.forEach((druid) => {
      if (druid.swallowedIds.length === 0) return;

      const sp = this.tuningFor(druid);
      if (!sp) {
        this.clear(druid);
        onRelease(druid);
        return;
      }

      // releaseOnDruidDeath, and the absolute deadline. Both are checked here
      // rather than off the predicted counter for the reason in the class note.
      const druidDead = sp.releaseOnDruidDeath && druid.health <= 0;
      if (druidDead || this.state.tick >= druid.swallowUntilTick) {
        this.release(druid, sp);
        onRelease(druid);
        return;
      }

      const regen = sp.passengerRegenPerSec * druid.mods.passengerRegenMul;
      for (const id of ([...druid.swallowedIds] as string[])) {
        const passenger = this.state.players.get(id);
        // Left the room mid-meal; drop that one and keep the rest.
        if (!passenger) {
          this.drop(druid, id);
          continue;
        }

        // Ride along. The passenger is the Druid, positionally.
        passenger.x = druid.x;
        passenger.y = druid.y;
        passenger.vx = 0;
        passenger.vy = 0;

        if (sp.passengerInvulnerable) {
          passenger.invulnUntilTick = Math.max(passenger.invulnUntilTick, this.state.tick + 1);
        }
        if (regen > 0) addHealth(passenger, regen * dt);
      }

      if (druid.swallowedIds.length === 0) {
        this.clear(druid);
        onRelease(druid);
      }
    });
  }

  private release(druid: Player, sp: SwallowSpecialTuning) {
    // Everyone pops out where the Druid is standing.
    for (const id of ([...druid.swallowedIds] as string[])) {
      const passenger = this.state.players.get(id);
      if (!passenger) continue;
      passenger.x = druid.x;
      passenger.y = druid.y;
      passenger.invulnUntilTick = Math.max(
        passenger.invulnUntilTick,
        this.state.tick + secToTicks(sp.releaseInvulnSec, this.t),
      );
      passenger.carriedBy = "";
    }
    this.clear(druid);
  }

  /** Remove one passenger without ending the swallow. */
  private drop(druid: Player, id: string) {
    const i = druid.swallowedIds.indexOf(id);
    if (i >= 0) druid.swallowedIds.splice(i, 1);
    const passenger = this.state.players.get(id);
    if (passenger) passenger.carriedBy = "";
  }

  private clear(druid: Player) {
    for (const id of ([...druid.swallowedIds] as string[])) {
      const passenger = this.state.players.get(id);
      if (passenger) passenger.carriedBy = "";
    }
    druid.swallowedIds.clear();
    druid.swallowUntilTick = 0;
    druid.specialTicks = 0;
  }

  private nearestAlly(druid: Player, radius: number): Player | null {
    let best: Player | null = null;
    let bestD = radius;

    this.state.players.forEach((other) => {
      if (other.sessionId === druid.sessionId) return;
      // Nobody gets swallowed twice, and a Druid carrying someone cannot be eaten
      // into a chain.
      if (other.carriedBy !== "" || other.swallowedIds.length > 0) return;
      // canSwallowDowned is true, so a downed ally is a valid grab — sheltering
      // one is the point. A dead one is not; nothing brings them back.
      if (other.lifeState === LIFE_DEAD) return;

      const d = Math.hypot(other.x - druid.x, other.y - druid.y);
      if (d < bestD) { bestD = d; best = other; }
    });

    return best;
  }

  private tuningFor(p: Player): SwallowSpecialTuning | null {
    const sp = this.t.characters[p.character]?.special;
    return sp && sp.kind === "swallow" ? sp : null;
  }
}

/**
 * Add fractional health to an int16 field without losing the remainder. Regen
 * rates are per-second and small; truncating every tick would zero them out.
 */
export function addHealth(p: Player, amount: number) {
  // swallowingDoesNotRevive: a downed passenger regenerating past zero must not
  // quietly stand back up. Life state is the only thing that decides that, and
  // only ReviveSystem changes it.
  if (p.lifeState !== LIFE_ALIVE) return;
  if (p.health >= p.maxHealth) { p.healthFrac = 0; return; }

  p.healthFrac += amount;
  const whole = Math.floor(p.healthFrac);
  if (whole <= 0) return;

  p.healthFrac -= whole;
  p.health = Math.min(p.maxHealth, p.health + whole);
}

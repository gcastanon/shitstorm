import { GameState, Player, addStat } from "./GameState";
import { secToTicks } from "../shared/sim";
import { LIFE_ALIVE, LIFE_DEAD, LIFE_DOWNED } from "../shared/types";
import type { Tuning } from "../shared/tuning";

/**
 * Downing, dying, and being brought back.
 *
 * Every clock in here is server-owned and runs outside the input loop. That is
 * the rule M3 arrived at the hard way: a predicted timer is fine when it only
 * governs its own player, because pausing your own root is self-correcting. A
 * revive timer governs the person being revived, so it cannot ride on anyone's
 * command stream — a reviver whose client hung would otherwise freeze a
 * teammate's only way back up.
 */
export class ReviveSystem {
  constructor(private t: Tuning, private state: GameState) {}

  /** Health hit zero. Down, not dead — skulls are what kill. */
  goDown(p: Player) {
    if (p.lifeState !== LIFE_ALIVE) return;
    p.lifeState = LIFE_DOWNED;
    p.health = 0;
    p.reviveTicks = 0;
    // Nothing in flight survives going down.
    p.dashTicks = 0;
    p.pullTicks = 0;
    p.pullDecayTicks = 0;
    p.specialTicks = 0;
    p.hookActive = false;
    p.vx = 0;
    p.vy = 0;
  }

  /**
   * A hit that lands on someone already down. Any tier counts the same — one
   * skull — which is what the design means by size not mattering once you are
   * on the floor.
   */
  addSkull(p: Player) {
    if (p.lifeState !== LIFE_DOWNED) return;
    // Iron Will buys extra skulls, so the limit is per player rather than global.
    const limit = this.t.downed.skullsToDie + p.mods.skullsAdd;
    p.skulls = Math.min(limit, p.skulls + this.t.downed.skullsPerAsteroidHit);
    if (p.skulls >= limit) {
      p.lifeState = LIFE_DEAD;
      p.reviveTicks = 0;
    }
  }

  /**
   * Put someone back on their feet regardless of how far gone they were.
   *
   * The only thing in the game that undoes death, which is why it is a separate
   * entry point rather than a flag on revive(): nothing should reach it except
   * an ultimate deliberately built to break that rule.
   */
  forceRevive(p: Player, full: boolean) {
    if (p.lifeState === LIFE_ALIVE) return;
    p.lifeState = LIFE_ALIVE;
    p.skulls = 0;
    p.reviveTicks = 0;
    p.health = full
      ? p.maxHealth
      : Math.max(1, Math.round(p.maxHealth * this.t.downed.revivedHealthFraction));
    p.invulnUntilTick = Math.max(
      p.invulnUntilTick,
      this.state.tick + secToTicks(this.t.downed.revivedInvulnSec, this.t),
    );
  }

  update() {
    const d = this.t.downed;
    const goal = secToTicks(d.reviveSeconds, this.t);

    this.state.players.forEach((p) => {
      if (p.lifeState !== LIFE_DOWNED) {
        p.reviveTicks = 0;
        return;
      }

      addStat(p, "DownedTicks");

      // A swallowed player is inside a Druid and out of everyone's reach.
      const reviver = p.carriedBy === "" ? this.findReviver(p) : null;

      if (reviver) {
        // Field Medic is a property of whoever is doing the work, not of the
        // person on the floor.
        p.reviveTicks = Math.min(goal, p.reviveTicks + reviver.mods.reviveSpeedMul);
        if (p.reviveTicks >= goal) {
          this.revive(p);
          // Credited to whoever was standing there when it completed.
          addStat(reviver, "Revives");
        }
      } else {
        // Breaking off costs more than it gained, so a reviver cannot chip away
        // at it between dodges.
        p.reviveTicks = Math.max(0, p.reviveTicks - d.reviveDecayMultiplier);
      }
    });
  }

  private revive(p: Player) {
    const d = this.t.downed;
    p.lifeState = LIFE_ALIVE;
    p.reviveTicks = 0;
    if (d.resetSkullsOnRevive) p.skulls = 0;
    p.health = p.mods.reviveFullHealth
      ? p.maxHealth
      : Math.max(1, Math.round(p.maxHealth * d.revivedHealthFraction));
    p.invulnUntilTick = Math.max(
      p.invulnUntilTick,
      this.state.tick + secToTicks(d.revivedInvulnSec, this.t),
    );
  }

  /**
   * Somebody alive, in range, holding still, and using nothing.
   *
   * "Holding still" is read off revivingIntent rather than off velocity: intent
   * is cleared every tick before input is consumed, so a player who stops
   * sending commands stops reviving. Reading velocity instead would let a
   * disconnected client stand there and finish the job.
   */
  private findReviver(downed: Player): Player | null {
    const d = this.t.downed;
    let found: Player | null = null;

    this.state.players.forEach((other) => {
      if (found) return;
      if (other.sessionId === downed.sessionId) return;
      if (other.lifeState !== LIFE_ALIVE) return;
      if (other.carriedBy !== "") return;
      if (!other.revivingIntent) return;
      // reviverMayUseAbilities is false, so anything still running disqualifies.
      if (!d.reviverMayUseAbilities && this.isBusy(other)) return;

      const dist = Math.hypot(other.x - downed.x, other.y - downed.y);
      if (dist <= d.reviveRadius) found = other;
    });

    return found;
  }

  private isBusy(p: Player): boolean {
    return p.dashTicks > 0 || p.specialTicks > 0 || p.pullTicks > 0
      || p.hookActive || p.swallowedIds.length > 0;
  }

  /** True when nobody is still on their feet, which loses the level outright. */
  allDown(): boolean {
    let anyAlive = false;
    this.state.players.forEach((p) => {
      if (p.lifeState === LIFE_ALIVE) anyAlive = true;
    });
    return !anyAlive;
  }

  anyDead(): boolean {
    let dead = false;
    this.state.players.forEach((p) => { if (p.lifeState === LIFE_DEAD) dead = true; });
    return dead;
  }
}

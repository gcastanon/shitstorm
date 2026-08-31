import { clamp, clampUnit } from "./math";
import {
  BTN, LIFE_ALIVE, LIFE_DEAD,
  type InputCommand, type PlayerSimState, type StepEvents,
} from "./types";
import type { SpecialTuning, ThroneSpecialTuning, Tuning } from "./tuning";
import type { PerkMods } from "./perks";
import { ultimateDurationSec, ultimateMods, ultimateRoots } from "./ultimates";
import { resolveCircleVsBoxes, type StructureBox } from "./structures";

/**
 * A player's effective numbers: their perks, plus their ultimate while it runs.
 *
 * Exported because the client draws from it too — a swing arc or a cooldown ring
 * during Windrunner has to match what the server is actually doing.
 */
export function activeMods(p: PlayerSimState): PerkMods {
  if (p.ultTicks <= 0 || p.ultimateId === "") return p.mods;
  const m = { ...p.mods };
  ultimateMods(p.ultimateId, p.ultimateUpgrades, m);
  return m;
}

/** Seconds to whole ticks, floored at 1 so a tiny value can never mean "every tick". */
export function secToTicks(sec: number, t: Tuning): number {
  return Math.max(1, Math.round(sec * t.net.tickHz));
}

/**
 * How long a special stays active. Specials without a duration are instant.
 *
 * The grapple is the awkward case: its root really ends when the hook resolves,
 * and only the server knows when that is. What both sides *can* agree on is the
 * longest the hook could possibly be out, so the client predicts the root
 * against that ceiling and a reconcile cuts it short the moment the hook lands.
 */
export function specialDurationTicks(sp: SpecialTuning, t: Tuning, m?: PerkMods): number {
  // Ceiling, not rounding: the hook needs ceil(range / step) ticks to time out,
  // and a root that rounded down would hand the Ranger a free tick of movement
  // while his hook was still in the air.
  if (sp.kind === "grapple") {
    return Math.max(1, Math.ceil((sp.maxRange / sp.hookSpeed) * t.net.tickHz));
  }
  if (!("durationSec" in sp)) return 0;

  const add = sp.kind === "throne" ? (m?.throneDurAdd ?? 0)
    : sp.kind === "swallow" ? (m?.swallowDurAdd ?? 0)
    : 0;
  return secToTicks(Math.max(0, sp.durationSec + add), t);
}

/**
 * A special's cooldown after perks. Additive and multiplicative modifiers both
 * apply, floored at zero so no stack can make it negative.
 */
export function specialCooldownSec(base: number, m: PerkMods): number {
  return Math.max(0, (base + m.specialCdAdd) * m.specialCdMul);
}

/** Whether an active special pins its caster in place. Only the throne does. */
export function specialRootsCaster(sp: SpecialTuning): boolean {
  return "rootsCaster" in sp && sp.rootsCaster;
}

/**
 * Throne bubble radius, in pixels.
 *
 * The design says three player-*widths*, so the conversion is radius * 2. That
 * is a unit conversion rather than a tunable, which is why the 2 is here and not
 * in tuning.json. It lands at 108px against a 96px Warlock melee reach, and
 * reflected chunks are parked a further chunk-radius outside the shell — which
 * is what makes "an enthroned Warlock swinging hits nothing" true without a
 * special case anywhere.
 */
export function throneBubbleRadius(t: Tuning, sp: ThroneSpecialTuning, m?: PerkMods): number {
  const widths = sp.bubbleRadiusPlayerWidths + (m?.throneRadiusAdd ?? 0);
  return widths * t.player.radius * 2;
}

/**
 * The single movement function. The server runs it to produce authoritative
 * state; the client runs the identical code to predict the local player. Any
 * divergence between those two call sites is a bug, so never fork this.
 *
 * Deterministic by construction: no Math.exp, no Math.random, no wall clock.
 * dt is always the fixed step (1 / net.tickHz).
 *
 * Returns what the step fired. The server turns those into world effects; the
 * client discards them, because world effects are not predicted.
 */
export function stepPlayer(
  p: PlayerSimState,
  cmd: InputCommand,
  dt: number,
  t: Tuning,
  structures: readonly StructureBox[] = [],
): StepEvents {
  const c = t.characters[p.character];
  const events: StepEvents = {
    dashStarted: false, attackFired: false, specialFired: false, ultimateFired: false,
    lifeClaimed: false,
  };

  // Rising edge only. Without this a held button re-fires every tick, which for
  // dash means an unbroken 900px/s sprint for as long as you lean on the key.
  const pressed = cmd.buttons & ~p.prevButtons;
  p.prevButtons = cmd.buttons;

  // Cooldowns advance once per command consumed, not once per server tick.
  //
  // That distinction is the whole reason this lives inside stepPlayer rather
  // than outside the input loop with the sewage. The client replays the command
  // stream to predict; anything that advances on ticks the client cannot replay
  // drifts permanently, which is the same wedge the idle-tick fallback caused.
  // Jitter makes the wall-clock drain rate wobble slightly, but both sides
  // wobble identically, and that is what prediction actually requires.
  if (p.dashCdTicks > 0) p.dashCdTicks--;
  if (p.attackCdTicks > 0) p.attackCdTicks--;
  if (p.specialCdTicks > 0) p.specialCdTicks--;

  // Swallowed. passengerLosesInput is total: no movement, no abilities, not even
  // collision of its own. The server parks the passenger on the Druid every tick,
  // and this side cannot predict that because it follows from another player's
  // command stream. Cooldowns above still drain, so a rescued player comes out
  // ready rather than owing time for having been eaten.
  if (p.carriedBy !== "") {
    p.vx = 0;
    p.vy = 0;
    return events;
  }

  // Spending one of the party's shared extra lives.
  //
  // Placed here on purpose, and the position is load-bearing in both directions.
  // It is *after* the swallow return above, because passengerLosesInput is total
  // and a passenger genuinely has no input to press. It is *before* the dead
  // return below, because a life brings back the dead as well as the downed, and
  // that return would otherwise leave a dead player with no way to ask.
  //
  // Deliberately not gated on specialCdTicks: this is not the special ability,
  // it only shares the button. Gating it would mean a Warlock who enthroned just
  // before going down could not spend a life.
  if (p.lifeState !== LIFE_ALIVE && (pressed & BTN.SPECIAL) !== 0) {
    events.lifeClaimed = true;
  }

  // Dead players are inert. Nothing here revives them — only the server, and
  // only through a spent life or the Rebirth ultimate.
  if (p.lifeState === LIFE_DEAD) {
    p.vx = 0;
    p.vy = 0;
    return events;
  }

  // Downed players crawl and cannot use anything. Everything below reads this,
  // so there is exactly one place that decides what being down costs you.
  const canAct = p.lifeState === LIFE_ALIVE;

  const move = clampUnit(cmd.move);

  // Perk mods, with an active ultimate layered on top. Composed per step rather
  // than stored, so `p.mods` stays purely the perks and the overlay cannot get
  // stuck on when the ultimate ends.
  const m = activeMods(p);

  // The ultimate fires on a rising edge and only with a charge, which
  // startLevel refills. Everything it does to the world is the server's job;
  // this only spends the charge and starts the clock, both of which are
  // predicted so the ring empties on the frame you press it.
  if (canAct && (pressed & BTN.ULTIMATE) !== 0 && p.ultReady && p.ultimateId !== "") {
    p.ultReady = false;
    p.ultTicks = secToTicks(ultimateDurationSec(p.ultimateId, p.ultimateUpgrades), t);
    // A duration of zero means it resolves instantly; secToTicks floors at one
    // tick, so clear it rather than leaving a one-tick "active" flicker.
    if (ultimateDurationSec(p.ultimateId, p.ultimateUpgrades) === 0) p.ultTicks = 0;
    events.ultimateFired = true;
  }
  if (p.ultTicks > 0) p.ultTicks--;

  if (canAct && (pressed & BTN.DASH) !== 0 && p.dashCdTicks === 0 && p.dashTicks === 0) {
    // Dash the way you are moving. Standing still, dash the way you are aiming,
    // so a dash is never swallowed just because the player let go of WASD.
    const len = Math.hypot(move.x, move.y);
    p.dashDirX = len > 0 ? move.x / len : Math.cos(cmd.aim);
    p.dashDirY = len > 0 ? move.y / len : Math.sin(cmd.aim);
    p.dashTicks = secToTicks(c.dash.durationSec, t);
    // Cooldown floors at one tick: a stack of Quick Feet must shorten the wait,
    // never turn dash into a button you can hold.
    p.dashCdTicks = secToTicks(Math.max(0, c.dash.cooldownSec + m.dashCdAdd), t);
    events.dashStarted = true;
  }

  // Special activation happens before movement so a root takes hold on the tick
  // it was pressed, rather than letting one more step of drift through.
  if (canAct && (pressed & BTN.SPECIAL) !== 0 && p.specialCdTicks === 0 && p.specialTicks === 0) {
    const sp = c.special;
    // cooldownStartsOnRelease: the Druid's swallow deliberately does not begin
    // its cooldown here. The server starts it when the passenger pops out, which
    // is what makes a full cycle 20s rather than 15. Re-firing meanwhile is
    // blocked by the specialTicks guard above, not by the cooldown.
    if (!("cooldownStartsOnRelease" in sp && sp.cooldownStartsOnRelease)) {
      p.specialCdTicks = secToTicks(specialCooldownSec(sp.cooldownSec, m), t);
    }
    const dur = specialDurationTicks(sp, t, m);
    if (dur > 0) p.specialTicks = dur;
    // Enthroning mid-dash cancels the dash outright; otherwise its leftover
    // ticks would resume when the throne dropped, three seconds later.
    if (specialRootsCaster(c.special)) p.dashTicks = 0;
    events.specialFired = true;
  }

  // Unmoored removes the root without touching the duration, so the bubble still
  // runs its full time — the Warlock just walks around inside it. An ultimate
  // that roots does so on its own terms and is not affected by Unmoored.
  const rooted =
    (p.specialTicks > 0 && specialRootsCaster(c.special) && !m.noRoot)
    || (p.ultTicks > 0 && ultimateRoots(p.ultimateId));
  if (p.specialTicks > 0) p.specialTicks--;

  if (rooted) {
    // The throne pins the Warlock. Velocity is zeroed rather than merely
    // ignored, so he does not slide off on stored momentum when it drops.
    p.vx = 0;
    p.vy = 0;
  } else if (p.pullTicks > 0) {
    // Grapple pull. The anchor came from the server, but from here it is plain
    // deterministic movement, so both sides run it and the client only lags by
    // the one reconcile it takes to learn where the hook landed.
    const dx = p.pullAnchorX - p.x;
    const dy = p.pullAnchorY - p.y;
    const d = Math.hypot(dx, dy);
    p.pullTicks--;

    if (d <= t.player.radius) {
      // Arrived. Drop the velocity rather than let it carry him past the wall
      // he just yanked himself against.
      p.pullTicks = 0;
      p.vx = 0;
      p.vy = 0;
    } else {
      const sp = c.special;
      const pullSpeed = sp.kind === "grapple" ? sp.pullSpeed : 0;
      p.vx = (dx / d) * pullSpeed;
      p.vy = (dy / d) * pullSpeed;
    }
  } else if (p.pullDecayTicks > 0) {
    // The anchor went away mid-flight — its wall fell, or he took a hit. Ramp
    // the inherited speed to exactly zero rather than cutting it dead.
    const f = (p.pullDecayTicks - 1) / p.pullDecayTicks;
    p.vx *= f;
    p.vy *= f;
    p.pullDecayTicks--;
  } else if (p.dashTicks > 0) {
    // A dash overrides the accel lerp outright rather than adding to it, so its
    // distance is exactly speed * duration no matter what the player was doing
    // when it started. Predictable dodge length matters more than momentum here.
    p.vx = p.dashDirX * c.dash.speed * m.dashDistMul;
    p.vy = p.dashDirY * c.dash.speed * m.dashDistMul;
    p.dashTicks--;
  } else {
    // Crawling is the only thing a downed player can still do.
    const crawl = m.crawlOverride > 0 ? m.crawlOverride : t.downed.crawlSpeedMultiplier;
    const hurt = p.maxHealth > 0 && p.health * 2 < p.maxHealth;
    const speed = (canAct ? c.speed : c.speed * crawl)
      * m.speedMul
      * (hurt ? m.lowHealthSpeedMul : 1);

    const desiredX = move.x * speed;
    const desiredY = move.y * speed;

    // Linear approach to the desired velocity, clamped so a large dt cannot overshoot.
    const k = Math.min(1, c.accel * dt);
    p.vx += (desiredX - p.vx) * k;
    p.vy += (desiredY - p.vy) * k;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Structures first, then the arena boundary. A structure can eject the player
  // toward the edge, and the boundary must get the final say so nobody ends up
  // outside the arena. generateLayout keeps structures a full minGap off the
  // edge precisely so this ordering cannot pinch anyone.
  resolveCircleVsBoxes(p, t.player.radius, structures);
  clampToArena(p, t);

  // Attack only burns its cooldown here. What it actually does is world state —
  // splitting sewage — which the server alone owns. Firing the cooldown on both
  // sides is what keeps the HUD instant. Special is handled above instead,
  // because a rooting special has to affect this step's movement.
  // Attack reads the button as *held*, not as a rising edge: holding the button
  // swings as fast as the cooldown allows, which is what a player expects of an
  // attack and never of the other two. Dash and special stay edge-triggered
  // above, because auto-dashing or auto-enthroning on a held key is nobody's
  // intent. The rate is governed entirely by attackCdTicks.
  if (canAct && (cmd.buttons & BTN.ATTACK) !== 0 && p.attackCdTicks === 0) {
    // Straight from tuning: no perk or upgrade can change attack rate. The one
    // exception is Windrunner, which does not scale the cooldown but removes it
    // — secToTicks floors at one tick, so that is one arrow per tick.
    p.attackCdTicks = secToTicks(m.noAttackCooldown ? 0 : c.attack.cooldownSec, t);
    events.attackFired = true;
  }

  return events;
}

/** Hard arena boundary. Structures are handled by resolveCircleVsBoxes. */
export function clampToArena(p: PlayerSimState, t: Tuning): void {
  const r = t.player.radius;
  const pad = t.arena.padding;
  const minX = pad + r, maxX = t.arena.width - pad - r;
  const minY = pad + r, maxY = t.arena.height - pad - r;

  const nx = clamp(p.x, minX, maxX);
  const ny = clamp(p.y, minY, maxY);
  if (nx !== p.x) p.vx = 0;
  if (ny !== p.y) p.vy = 0;
  p.x = nx;
  p.y = ny;
}

export function fixedDtSec(t: Tuning): number {
  return 1 / t.net.tickHz;
}

/** Deterministic spawn points spread around the arena centre. */
export function spawnPoint(index: number, t: Tuning) {
  const cx = t.arena.width / 2;
  const cy = t.arena.height / 2;
  const offsets = [
    { x: -140, y: 60 },
    { x: 0, y: -80 },
    { x: 140, y: 60 },
  ];
  const o = offsets[index % offsets.length];
  return { x: cx + o.x, y: cy + o.y };
}

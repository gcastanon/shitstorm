import { readFileSync } from "node:fs";
import { Client } from "colyseus.js";
import { fixedDtSec, spawnPoint, stepPlayer } from "../shared/sim";
import type { Tuning } from "../shared/tuning";
import {
  BTN, LIFE_ALIVE, LIFE_DEAD, LIFE_DOWNED, freshAbilityState,
  type CharacterId, type StepEvents,
} from "../shared/types";
import { BINDINGS } from "../client/input";
import { applyPerks } from "../shared/perks";
import { mulberry32, type StructureBox } from "../shared/structures";

/**
 * Controls, checked before anything else and without needing a server.
 *
 * This exists because a mis-bound control is invisible to every other check in
 * the project. Determinism passes happily while a key does the wrong thing —
 * both sides agree perfectly on the wrong ability — and the bot sends raw
 * bitmasks, so it never exercises a keyboard at all. The only thing that ever
 * catches it is a person playing the game and being surprised.
 *
 * Two halves, because the bug can live in either:
 *   - bitmask -> ability, in stepPlayer
 *   - key -> bitmask, in the client's BINDINGS
 */
function verifyControls(t: Tuning): boolean {
  const dt = fixedDtSec(t);
  const fails: string[] = [];
  // Given an ultimate and a charge, or the ULTIMATE button would fire nothing
  // and its isolation check would pass for the wrong reason.
  const fresh = () => ({
    x: 400, y: 300, vx: 0, vy: 0, character: "warlock" as CharacterId,
    ...freshAbilityState(),
    ultimateId: "cathedral", ultReady: true,
  });
  const cmd = (buttons: number, seq = 1) => ({ seq, move: { x: 0, y: 0 }, aim: 0, buttons });

  /** Every ability a single step reported, by name. */
  const fired = (ev: StepEvents) => [
    ev.dashStarted && "dash", ev.attackFired && "attack",
    ev.specialFired && "special", ev.ultimateFired && "ultimate",
    ev.lifeClaimed && "life",
  ].filter(Boolean) as string[];

  // Each bit alone must move exactly one ability.
  for (const [name, bit, want] of [
    ["DASH", BTN.DASH, "dash"],
    ["ATTACK", BTN.ATTACK, "attack"],
    ["SPECIAL", BTN.SPECIAL, "special"],
    ["ULTIMATE", BTN.ULTIMATE, "ultimate"],
  ] as const) {
    const ev = stepPlayer(fresh(), cmd(bit), dt, t, []);
    if (fired(ev).length !== 1 || fired(ev)[0] !== want) {
      fails.push(`${name} fired [${fired(ev).join(",")}], expected only ${want}`);
    }
  }

  // Special now means two different things depending on whether you are on your
  // feet. That is exactly the shape of bug this block exists for, so each of the
  // three life states gets asserted rather than assumed.
  for (const [state, life, want] of [
    ["alive", LIFE_ALIVE, "special"],
    ["downed", LIFE_DOWNED, "life"],
    ["dead", LIFE_DEAD, "life"],
  ] as const) {
    const p = fresh();
    p.lifeState = life;
    const ev = stepPlayer(p, cmd(BTN.SPECIAL), dt, t, []);
    const got = fired(ev);
    if (got.length !== 1 || got[0] !== want) {
      fails.push(`SPECIAL while ${state} fired [${got.join(",")}], expected only ${want}`);
    }
  }

  // Holding it down must not drain the party's lives one per tick.
  {
    const p = fresh();
    p.lifeState = LIFE_DOWNED;
    let claims = 0;
    for (let i = 0; i < 60; i++) {
      if (stepPlayer(p, cmd(BTN.SPECIAL, i + 1), dt, t, []).lifeClaimed) claims++;
    }
    if (claims !== 1) fails.push(`holding SPECIAL while downed claimed ${claims} lives, expected 1`);
  }

  // A swallowed player has no input at all, so the prompt must never appear for
  // one — passengerLosesInput is total, and this is the assertion that says so.
  {
    const p = fresh();
    p.lifeState = LIFE_DOWNED;
    p.carriedBy = "someone";
    if (stepPlayer(p, cmd(BTN.SPECIAL), dt, t, []).lifeClaimed) {
      fails.push("a swallowed player claimed a life; passengerLosesInput is meant to be total");
    }
  }

  // Holding must repeat attack and nothing else.
  const held = (bit: number) => {
    const p = fresh();
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const ev = stepPlayer(p, cmd(bit, i + 1), dt, t, []);
      if ((bit === BTN.DASH && ev.dashStarted) || (bit === BTN.ATTACK && ev.attackFired) ||
          (bit === BTN.SPECIAL && ev.specialFired) || (bit === BTN.ULTIMATE && ev.ultimateFired)) n++;
    }
    return n;
  };
  if (held(BTN.DASH) !== 1) fails.push(`holding DASH fired ${held(BTN.DASH)} times, expected 1`);
  if (held(BTN.SPECIAL) !== 1) fails.push(`holding SPECIAL fired ${held(BTN.SPECIAL)} times, expected 1`);
  if (held(BTN.ATTACK) < 2) fails.push(`holding ATTACK fired ${held(BTN.ATTACK)} times, expected it to repeat`);
  // Once per level: holding it must not spend a charge it no longer has.
  if (held(BTN.ULTIMATE) !== 1) fails.push(`holding ULTIMATE fired ${held(BTN.ULTIMATE)} times, expected 1`);

  if (!(BTN.DASH === 1 && BTN.ATTACK === 2 && BTN.SPECIAL === 4 && BTN.ULTIMATE === 8)) {
    fails.push(`bit values drifted: ${BTN.DASH}/${BTN.ATTACK}/${BTN.SPECIAL}/${BTN.ULTIMATE}`);
  }

  // Perks have to actually reach stepPlayer, and the same set has to fold to the
  // same numbers however it was ordered — the client rebuilds mods from a synced
  // list whose order it does not control, so order-dependence would desync it.
  const runWith = (ids: string[]) => {
    const p = fresh();
    p.mods = applyPerks(ids);
    for (let i = 0; i < 40; i++) {
      stepPlayer(p, { seq: i + 1, move: { x: 1, y: 0 }, aim: 0, buttons: 0 }, dt, t, []);
    }
    return p.x;
  };
  const plain = runWith([]);
  if (!(runWith(["long-legs"]) > plain + 0.01)) {
    fails.push("long-legs did not change how far the player moved");
  }
  if (runWith(["long-legs", "quick-feet"]) !== runWith(["quick-feet", "long-legs"])) {
    fails.push("perk order changed the result; applyPerks must be order-independent");
  }

  // Every ability bound exactly once, and no input on two abilities.
  const seen = new Map<string, string>();
  for (const b of BINDINGS) {
    for (const input of [...b.keys, ...(b.mouse ? [`${b.mouse} mouse`] : [])]) {
      const owner = seen.get(input);
      if (owner) fails.push(`${input} is bound to both ${owner} and ${b.label}`);
      seen.set(input, b.label);
    }
    if (b.keys.length === 0 && !b.mouse) fails.push(`${b.label} has no binding at all`);
  }
  for (const bit of [BTN.DASH, BTN.ATTACK, BTN.SPECIAL]) {
    if (!BINDINGS.some((b) => b.button === bit)) fails.push(`bitmask ${bit} has no BINDINGS entry`);
  }

  for (const b of BINDINGS) {
    const inputs = [...b.keys, ...(b.mouse ? [`${b.mouse} mouse`] : [])];
    console.log(`controls      ${b.label.padEnd(8)} <- ${inputs.join(", ")}`);
  }
  for (const f of fails) console.log(`controls      FAIL: ${f}`);
  return fails.length === 0;
}

/**
 * Determinism check. Joins an empty room, drives it with a known input stream,
 * replays the same commands locally through the same stepPlayer, and compares.
 *
 * Any non-zero divergence means the client's prediction will fight the server,
 * so run this after touching anything in src/shared.
 *
 * The input stream presses buttons as well as moving. It has to: dash is the
 * one ability that moves the player, so a run that never dashes would report a
 * clean pass while saying nothing at all about the ability system — the same
 * vacuous pass the first collision sweep produced by never leaving the spawn
 * clearing. The dash count below is what makes the result mean something.
 *
 *   npm run verify     (needs a server on 2567 and an empty room)
 */
const ENDPOINT = process.env.SERVER ?? "ws://localhost:2567";

/**
 * The character here is load-bearing, not a preference.
 *
 * This check replays the command stream from spawn with no server state
 * injected, which only works for abilities whose whole effect is derivable from
 * the commands. Dash and the throne qualify. The Ranger's grapple does not: its
 * anchor depends on where a hook landed among moving sewage, which no pure
 * replay can know, so a Ranger run would diverge by design and the failure would
 * mean nothing. Grapple pull correctness is a separate question — that both
 * sides move identically *given* an anchor — and belongs in its own probe.
 */
const CHARACTER: CharacterId = "warlock";
const RUN_MS = 9000;

/** Press cadences, in ticks. Both are shorter than the matching cooldown, so
 *  most presses are correctly swallowed and the rest fire on the exact tick the
 *  server picks — which is the part worth testing. */
const DASH_EVERY = 20;
/**
 * Attack is *held* from this sequence onward rather than tapped.
 *
 * Tapping would pass this check identically whether attack is edge-triggered or
 * repeat-on-hold, which is exactly the vacuous pass the notes warn about. Holding
 * it means the observed attack count has to match the cooldown rate, and that is
 * an assertion only the repeat path can satisfy.
 */
const ATTACK_HELD_FROM = 40;
/** The verifier runs as the Warlock, so this enthrones him: three seconds
 *  rooted in the middle of the run. If the client mispredicted the root it
 *  would drift by most of an arena width, which makes this the sharpest single
 *  assertion in the file. */
const SPECIAL_EVERY = 30;

(async () => {
  // Controls first, off the tuning file on disk, so a mis-bound key is caught in
  // milliseconds and without a server rather than by someone playing the game.
  const onDisk: Tuning = JSON.parse(readFileSync("tuning.json", "utf8"));
  if (!verifyControls(onDisk)) {
    console.log("divergence    n/a  FAIL (controls)");
    process.exit(1);
  }

  const room = await new Client(ENDPOINT).joinOrCreate("arena", { character: CHARACTER, name: "verify" });
  const tuning: Tuning = await new Promise((r) => room.onMessage("tuning", r));
  const dt = fixedDtSec(tuning);

  const spawn = spawnPoint(0, tuning);
  const mirror = { ...spawn, vx: 0, vy: 0, character: CHARACTER, ...freshAbilityState() };

  // Long legs in pseudorandom directions, so the run crosses the whole town and
  // grinds along walls and hut corners. A tight orbit or a straight line would
  // pass this test without ever touching collision resolution.
  const rng = mulberry32(7);
  let seq = 1;
  let angle = 0;
  const sent: any[] = [];
  const iv = setInterval(() => {
    if (seq % 40 === 1) angle = rng() * Math.PI * 2;

    // Held buttons must fall back to 0 between presses or the rising edge never
    // re-arms, and the run would fire exactly one dash however long it ran.
    let buttons = 0;
    if (seq % DASH_EVERY === 0) buttons |= BTN.DASH;
    if (seq >= ATTACK_HELD_FROM) buttons |= BTN.ATTACK;
    if (seq % SPECIAL_EVERY === 0) buttons |= BTN.SPECIAL;

    const cmd = { seq: seq++, move: { x: Math.cos(angle), y: Math.sin(angle) }, aim: angle, buttons };
    sent.push(cmd);
    room.send("input", cmd);
  }, 1000 / tuning.net.tickHz);

  setTimeout(() => {
    clearInterval(iv);
    const me: any = (room.state as any).players.get(room.sessionId);

    const boxes: StructureBox[] = (room.state as any).structures.map((s: any) => ({
      id: s.id, kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h, hp: s.hp, maxHp: s.maxHp,
    }));

    // Mirror whatever perks the server says this player holds. Nothing grants
    // any inside a run this short, so today this is a no-op — but it means the
    // replay honours them the moment one is granted rather than silently
    // diverging by however much the perk was worth.
    mirror.mods = applyPerks([...(me.perks ?? [])]);
    mirror.health = me.health;
    mirror.maxHealth = me.maxHealth;

    let dashes = 0;
    let attacks = 0;
    let specials = 0;
    let rootedTicks = 0;
    for (const c of sent) {
      if (c.seq > me.lastSeq) break;
      const fired = stepPlayer(mirror, c, dt, tuning, boxes);
      if (fired.dashStarted) dashes++;
      if (fired.attackFired) attacks++;
      if (fired.specialFired) specials++;
      if (mirror.specialTicks > 0) rootedTicks++;
    }

    const err = Math.hypot(mirror.x - me.x, mirror.y - me.y);

    // Holding attack must produce one swing per cooldown, so the count is
    // predictable rather than merely non-zero. Allow one either way for where
    // the held stretch starts and stops relative to a cooldown boundary.
    const cdTicks = Math.max(1, Math.round(tuning.characters[CHARACTER].attack.cooldownSec * tuning.net.tickHz));
    const heldTicks = Math.max(0, me.lastSeq - ATTACK_HELD_FROM + 1);
    const expectedAttacks = Math.floor(heldTicks / cdTicks) + 1;
    const rateOk = heldTicks > cdTicks * 2 && Math.abs(attacks - expectedAttacks) <= 1;

    // A run that never dashed or never enthroned cannot say anything about the
    // abilities that move the player, so it fails regardless of how small the
    // divergence came out.
    const meaningful = dashes > 0 && specials > 0 && rootedTicks > 0 && rateOk;
    const pass = err < 0.001 && meaningful;

    console.log(`structures    ${boxes.length} (seed ${(room.state as any).seed})`);
    console.log(`spawn         x=${spawn.x.toFixed(3)} y=${spawn.y.toFixed(3)}`);
    console.log(`server        x=${me.x.toFixed(3)} y=${me.y.toFixed(3)}  lastSeq=${me.lastSeq}`);
    console.log(`local replay  x=${mirror.x.toFixed(3)} y=${mirror.y.toFixed(3)}`);
    console.log(`acked         ${me.lastSeq}/${sent.length} commands`);
    console.log(`dashes        ${dashes}${dashes > 0 ? "" : "  (FAIL: nothing exercised the dash path)"}`);
    console.log(`attacks       ${attacks} held over ${heldTicks} ticks, expected ~${expectedAttacks} at ${cdTicks}-tick cooldown${rateOk ? "" : "  (FAIL: hold-to-repeat rate wrong)"}`);
    console.log(`thrones       ${specials}, rooted for ${rootedTicks} ticks${rootedTicks > 0 ? "" : "  (FAIL: never enthroned)"}`);
    console.log(`cooldowns     dash ${mirror.dashCdTicks}=${me.dashCdTicks}  atk ${mirror.attackCdTicks}=${me.attackCdTicks}  ${mirror.dashCdTicks === me.dashCdTicks && mirror.attackCdTicks === me.attackCdTicks ? "match" : "MISMATCH"}`);
    console.log(`divergence    ${err.toFixed(6)}px  ${pass ? "PASS" : "FAIL"}`);

    room.leave();
    setTimeout(() => process.exit(pass ? 0 : 1), 300);
  }, RUN_MS);
})().catch((e) => { console.error(e.message); process.exit(1); });

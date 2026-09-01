# SHITSTORM — working notes

Three-player co-op survival in an underdark town. Sewage flies in from off-screen; players dodge it, break it, and hide behind huts.

**The game is called SHITSTORM. The folder, the npm package and the word "sewage" are not.** The rename was deliberately player-facing only: renaming the working directory would break every path in this file, the running server and the tooling, and "sewage" is still the right word for what is flying at you.

See @README.md for architecture, netcode explanation, commands, and the full design ruleset. This file holds the things the code and README can't tell you: why decisions were made, what has already been tried and rejected, and what still needs answering.

**Current state: everything through M5 is done, plus an 8-bit art pass, level-up perks, chiptune music, a level timer bar, a Dungeon Master role, ultimates, and a map redesign that puts the town in the middle of open ground.** Every mechanic in the design rules exists and every perk that changes how a character acts is reflected in what gets drawn. The tree is clean: `npm run typecheck`, `npm run verify` and `npm run build` all pass, `tuning.json` is at its real values, and the only script in the project root is `hitcheck.ts`, which is meant to be there.

**What to do next, in the order I would do it:**

1. **Playtest.** Nothing has been played by a human for several features now — perks, music, the timer bar and the safe-split change have all only been driven headlessly and in a scripted browser.
2. **The tuning pass.** Deferred by decision, described below, with sweep tables already measured so it can be quick.
3. Optional leftovers: hut variety, and `/run-skill-generator` to capture the browser recipe below as a real project skill. (The bitmap font that used to be listed here exists now — see the victory banner section.)

**One balance pass has now happened**, on knobs the designer named directly — level length, sewage speed and rate, and the difficulty ramp across a run. See the extra-lives section near the end. The broader sweep below is still deferred. The mechanics were built first by decision, and the numbers are known to be off — most obviously that the wave rework left cover erosion at zero. Do not re-raise tuning as a blocker or "fix" a number in passing; the sweep tables below exist so the knobs can be turned deliberately when that pass happens. `npx tsx hitcheck.ts` reproduces them.

**Work from this file's directory (`sewage-storm/`), not its parent.** The repo nests the project one level down: `package.json`, `tuning.json`, and `tsconfig.json` all live here, and `loadTuning` resolves `tuning.json` from `process.cwd()` (`src/server/tuningLoader.ts`). Every command below assumes this directory — run one from the parent and npm finds no package at all.

## Hard rules

These are not style preferences. Breaking any of them causes bugs that are painful to diagnose later.

1. **Never fork `stepPlayer`.** Server and client run the identical function from `src/shared/sim.ts`. That identity is the entire basis of client-side prediction. If the two sides ever run different movement code, prediction fights the server forever.

2. **Run `npm run verify` after touching anything in `src/shared/`.** It drives a real room, replays the same inputs locally, and asserts the divergence is `0.000000px`. A non-zero result means prediction is broken, even if the game still looks fine.

3. **Structure array order is load-bearing.** Collision resolves boxes in array order on both sides. Never sort, filter, or reorder `state.structures` or its client mirror in place.

4. **Systems that must run every tick go outside the input loop.** `ArenaRoom.fixedTick` only advances a player when a command is available for them. Sewage movement, collision, and regen must not live in that loop, or a starved input queue stalls the world. `AsteroidSystem.update` is the model to copy.

   **Ability cooldowns are the one deliberate exception**, and they are counted inside `stepPlayer` rather than outside. Dash is movement, so rule 1 puts it in the shared sim, and a cooldown the client cannot replay would gate a predicted dash on a number only the server knows — the idle-tick wedge all over again. So all three cooldowns tick once per *command consumed*, never per server tick. Jitter makes the wall-clock drain rate wobble, but both sides wobble identically, which is the only property prediction needs. The rule's real target is world state; a player's own timers pausing while they send nothing is invisible and self-correcting.

5. **The server never advances a player on a tick with no input.** See the gotcha below. Do not "fix" the resulting stutter by adding a fallback step.

6. **Keep the fixed timestep.** Everything simulates at `net.tickHz`. Never simulate off a variable frame delta.

7. **No number literals in game code.** Everything goes in `tuning.json`, which the server reads at boot and sends to clients on join.

## Gotchas already hit

Do not re-derive these the hard way.

- **Idle-tick fallback breaks prediction.** An earlier server stepped players with an empty input on ticks where no command had arrived, to smooth coasting. It put a permanent ~0.002px/tick wedge between server and client, because those extra steps aren't in the command stream the client replays. Jitter means some ticks get zero commands and the next gets two; `maxCommandsPerTick` absorbs the catch-up and the end position is identical.

- **Collision tests can pass vacuously.** The first collision sweep reported a clean pass with *zero wall contacts* — the test drove a tight orbit that never left the spawn clearing. Any movement test must take long legs across the arena and log its contact count, or it proves nothing.

- **Colyseus 0.15 is CommonJS.** Node's ESM named-export detection can't see through it, so the project is deliberately **not** `"type": "module"`. `tsx` compiles the server to CJS; Vite handles the client as ESM independently. Don't "fix" this.

- **Do not run `npm audit fix --force`.** It upgrades Colyseus to 0.18 across three major versions and breaks the schema callback API. The remaining 3 advisories are all `nanoid@2` under `@colyseus/core`, and all three require an attacker-controlled `size` argument. Colyseus calls `generateId()` zero-arg at all 15 call sites. Unreachable. Revisit around M4.

- **Two ports in development, one in production.** `5173` (Vite) serves the page and `2567` (Colyseus) is the game server. **When `dist/client` exists, the server serves it from 2567 as well**, so a deployment is one process on one port — and the client derives its endpoint from `location`, which means `wss:` comes for free on an HTTPS page and nothing is baked in at build time. That last part matters: the old hardcoded `ws://host:2567` was silently blocked as mixed content by any browser on an HTTPS page, which is a failure with no error message in the game. `import.meta.env.DEV` is what tells the two cases apart, so `vite dev` still reaches across to 2567.

- **Reconcile has to rewind `prevButtons`, not just the numbers.** Abilities fire on a rising edge, so the edge detector's previous-buttons value is simulation state like any other. At reconcile time the client's copy holds the buttons from its *newest* command, which is ahead of the state being snapped to; replaying from there makes the first replayed press look like a held button and silently eats a dash. `Predictor.reconcile` rewinds it to the buttons of the last command the server actually acked. Anything else edge-triggered in M4 has the same problem.

- **"Standing still" must be read off intent, not velocity.** A revive needs the reviver stood there doing nothing, and the obvious implementation — check that their speed is near zero — hands the revive to anyone whose client has disconnected, because a player sending no input has no velocity either. `revivingIntent` is set only from an actually-empty consumed command and cleared for everyone at the top of every tick, so not sending input stops the revive rather than completing it. It also avoids inventing a speed threshold, which would have been a tuning number describing a bug.

- **The mercy window has to cover skulls too.** `hitInvulnSec` was added so a cluster of fragments could not delete a player in three consecutive ticks; the identical argument applies to a downed player, where three ticks would burn all three skulls and kill them outright. `damagePlayer` sets the invulnerability window *before* branching on life state, so both paths get it.

- **The loss check needs an empty-room guard.** "Nobody is standing" is trivially true of a room with no players in it, so a fresh or emptied room would lose instantly. `checkOutcome` requires `players.size > 0`.

- **Fractional regen against an int16 health field silently does nothing.** Passive regen is 1.5/sec, which at 30Hz is 0.05 per tick. Written straight to `health` it truncates to zero every single tick and the ability quietly does not exist. `Player.healthFrac` carries the remainder between ticks and `addHealth` is the only thing that should ever touch `health` for a regen. Any future per-tick trickle — the passenger's 4/sec, downed bleed-out in M4 — has exactly this trap.

- **A predicted timer must not govern anyone but its own player.** Rule 4's argument for keeping ability cooldowns in `stepPlayer` is that a player who stops sending input only pauses their *own* timers, which is self-correcting. Swallow breaks that: the release deadline governs someone else's captivity, so a Druid whose client hangs would trap a teammate indefinitely. `Player.swallowUntilTick` is therefore an absolute server tick checked every tick outside the input loop, and the predicted `specialTicks` is only the Druid's HUD mirror. Apply the same test to anything M4 adds: if a timer decides something for another player, it cannot live in the command stream.

- **`onLeave` has to break a swallow from both directions.** A Druid disconnecting mid-swallow leaves a passenger with `carriedBy` still set — no input, no movement, and nobody left to release them. The room clears both sides of the pair before deleting the player.

- **`npm run verify` cannot cover the grapple, and its character is load-bearing.** The check replays the command stream from spawn with no server state injected, so it only covers abilities whose whole effect follows from the commands. Dash and the throne qualify; the grapple does not, because its anchor depends on where a hook landed among moving sewage. Switch `CHARACTER` in the verifier to `ranger` and a grapple run will diverge by design, and the failure will mean nothing. Anything future whose effect depends on world state has the same shape: predict it from server-supplied state via reconcile, and prove it with a probe instead.

- **The hook can anchor inside a wall.** It travels 1150px/s, which is 38px per tick, so it can be well past a wall's face on the tick the hit is detected. The rope end is then drawn slightly inside the wall and the pull stops the Ranger about 34px from the anchor rather than the 18px his radius implies. Cosmetic, and measured, not guessed. Fixing it means substepping the hook or clamping the anchor to the box surface; neither is worth doing until it actually looks wrong in play.

- **A determinism run that never presses a button proves nothing.** Same shape as the vacuous collision pass below. `npm run verify` now presses dash and attack on a fixed cadence, counts what actually fired, and fails outright if the dash count is zero — a clean `0.000000px` from a run that never dashed says nothing about the ability system.

- **The throne's "no special case needed" claim rests on three numbers, and it is now measured.** Bubble radius is 108px (3 player-*widths*, so `radius * 2`), Warlock melee reach is 96px, and `reflectOffCircle` parks a bounced chunk at `bubbleRadius + chunkRadius + 0.5` — 125.5px for a Small, 142.5px for a Large. Melee resolves reach-to-*edge*, so it needs 113px and 130px respectively. Every margin is about 12px. Enthroned melee therefore hits nothing, exactly as the design assumed, but the headroom is thin: raise `reach`, drop `bubbleRadiusPlayerWidths`, or make the parking distance tighter and an enthroned Warlock silently starts shredding the sewage he is hiding from.

- **Special means two different things now.** Upright it fires your ability; down or dead it spends one of the party's shared extra lives. `stepPlayer` raises `lifeClaimed` for the second case *before* the `LIFE_DEAD` early return — that return sits above all button handling, so a life that revives the dead would never have been reachable below it — and *after* the `carriedBy` return, because a swallowed passenger genuinely has no input. It is deliberately not gated on `specialCdTicks`: a Warlock who enthroned just before going down must still be able to spend a life. `npm run verify` asserts all three life states plus the swallow case.

- **A per-wave ramp longer than a wave never completes.** `rampSec` used to run across the whole level; it now restarts each spawn window. At `rampSec 38` against a `spawnSec` of 16 it only ever gets 42% of the way from `intervalStartSec` to `intervalMinSec`, so the tightest interval the game can reach is not the one written in tuning. Any ramp measured against a phase must be checked against that phase's length, or the knob quietly means something other than what it says. Keep `rampSec` at or below `spawnSec` unless a deliberately unfinished ramp is the intent.

- **Half the walls are standing on end.** `generateLayout` swaps a wall's `width` and `height` on a coin flip (`src/shared/structures.ts`, the `vertical` line), so a wall is 128×32 *or* 32×128. Anything drawn per-structure must read `b.w` / `b.h` rather than the tuning dimensions — the first sprite pass drew every wall horizontally and only the `H` overlay caught it, because the hitbox outline was vertical and the art was not. Rotate the sprite by exactly 90°; stretching one axis to fit would make its pixels non-square.

- **`spreadDegrees` is measured off the attacker, not off the chunk.** Fragments used to fan around the parent's heading, which meant hitting a chunk flying at you sprayed both halves into your face — the attack punished you for using it. The fan is now measured from the direction pointing away from whoever struck it, so **90 is the maximum safe value**: at 90 the fragments leave perpendicular to the attacker, below 90 they angle further away, and above 90 they aim back at them. Anything reading that key expecting the old meaning will be wrong. `splitAsteroid` still falls back to heading-relative when no attacker angle is passed, which is what callers that do not know who hit the chunk get.

- **Standing walls eat sewage.** `consumedOnWallHit` means cover absorbs chunks, so *raising* structure hp *lowers* on-screen sewage density. The two knobs fight each other and must be tuned jointly, never one at a time.

- **`targetInset` trims the town, not the arena.** It used to mean "aim at the middle 64% of the arena"; since the map redesign it means "aim at the middle 64% of the *town box*". Same key, same shape of meaning, different region — so the shipped 0.18 was tuned against something that no longer exists, and any reasoning about it that predates the town is wrong. Same trap `spreadDegrees` sprang. Measured: 26.8% of aim points land in the town's centre ninth against ~5.5% in each corner ninth. That understates what the outer houses actually take, though, because a chunk aimed at the centre still flies *over* the outer houses to get there and is consumed by the first one it hits.

## Testing discipline

Verification here is empirical, not by inspection. Every milestone so far has been validated by writing a script that drives the system headlessly and running it with `npx tsx`. Nothing here depends on rendering, so it is all cheap to drive. Delete the one-off probes; keep any script that answers a question still open below.

- `npm run verify` — controls first (no server needed, fails fast), then networked determinism. The single most important check.
- `npm run bot -- 3` — headless soak. Catches crashes three browser tabs never will.
- **The predictor used to guess its own character, and sometimes guessed wrong.** `Predictor` is constructed in `ArenaScene.create`, which can run before the first snapshot arrives, so `me?.character ?? "ranger"` fell through to the default. Everything `stepPlayer` reads about a character hangs off that field — speed, accel, every cooldown, whether the attack is melee or ranged — so a Warlock could spend a whole run being predicted as a Ranger. It reconciles position every snapshot, so it never looked obviously broken; what it did was quietly mispredict and silently skip the melee arc, because a Ranger has no arc to draw. `reconcile` now takes the character from the server. **`npm run verify` cannot catch this** — the verifier builds its own mirror with the right character and never touches `Predictor`. Anything the predictor guesses at construction has the same shape of bug.

- **There is no repo, and git is not installed on this machine.** Not on PATH, not in Program Files, no GitHub Desktop bundle — checked. `.gitignore` and `.gitattributes` are already correct and sit in `sewage-storm/`, which is where a repo should be rooted if one is ever wanted; `winget install --id Git.Git -e` is the missing step, and it was offered and deliberately declined. Until then nothing here is recoverable, so do not lean on "I can revert that" when weighing a risky edit — there is nothing to revert to.

- **Controls are the one thing no automated check here was ever able to see.** Determinism passes happily while a key does the wrong thing — both sides agree perfectly on the wrong ability — and the bot sends raw bitmasks, so it never touches a keyboard. For a long stretch Shift dashed while the docs and I both said what the *bitmask* did, and the only possible detector was somebody playing the game and being surprised. Two fixes, both in place: key bindings are a single declared table (`BINDINGS` in `src/client/input.ts`) that `buttons()` derives from, and `npm run verify` now asserts controls **before it connects to anything** — each bit fires exactly one ability, holding repeats attack and only attack, no input bound to two abilities, no ability left unbound. It prints the live mapping on every run. If you change a binding, that output is the thing to read.

- **Driving the client in a browser needs held keys, not presses.** The client samples input once per 33ms tick, so a zero-length synthetic keypress — Puppeteer's `keyboard.press()`, Playwright's equivalent — lands between two samples and is never seen. It fails silently: the ability simply does not fire and the page logs nothing. Hold for ~150ms instead. A human cannot hit a key fast enough to trigger this, so it only ever bites automation.

- `npx tsx hitcheck.ts` — the balance sweep. Three idle players, a 90s level, 8 seeds; prints player hits, time to first hit, peak sewage on screen, and cover left standing. Every number in the open questions below came from this script, and it is the shape to copy for any new balance question. Balance is judged across 8 seeds, never from a single run.

Before claiming something works, drive it and print numbers.

### Driving the real client in a browser

Rendering, input and audio are invisible to every headless check here — `verify` and the bot never construct a scene or touch a keyboard. Several real bugs were only ever caught this way, so it is worth the setup:

```
npm run dev                          # from sewage-storm/, Vite on 5173
npm i puppeteer-core --prefix <scratch>   # NOT into this repo
node <scratch>/drive.js
```

Chrome is already installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`; `puppeteer-core` drives it without downloading a browser. Launch headless with `--no-sandbox --enable-unsafe-swiftshader`, click `button[data-char="warlock"]` to enter, then wait on `#game canvas`.

Four things that cost real time to work out:

- **Hold keys, never `press()`.** Input is sampled once per 33ms tick, so a zero-length synthetic keypress lands between two samples and is silently never seen. `keyboard.down` / wait 150ms / `keyboard.up`.
- **Anchor screenshot clips at the canvas corner.** A clip that runs off the page gets silently slid rather than erroring, and the crop is then somewhere you did not ask for. Walking into a corner (`KeyW`+`KeyA`) clamps the player to a known position to frame against.
- **Short-lived flashes need the constant lengthening, not faster screenshots.** `SWING_FLASH_MS` is 130ms and a screenshot takes longer than that; temporarily raise it, capture, restore.
- **Chrome's WebAudio CDP domain reports whether audio is really running** — `WebAudio.enable`, then `contextCreated`/`contextChanged` give you `state=running`. That is the only headless proof the music started; whether it sounds good still needs ears.

When guessing twice about a rendering bug, stop and put a temporary field in the HUD instead. That is what found the predictor character bug in one shot after two wrong theories.

## Locked design decisions

Full ruleset is in @README.md under "Design rules this scaffold assumes". Summary of what is settled and must not be quietly changed:

- Two asteroid tiers. Attacks split Large into two Small and destroy Small. Attacks are the **only** source of splitting — wall and player hits consume the chunk.
- Split children carry a `swingId` so one melee sweep can't chain through the fragments it just created. The field exists on `Asteroid` and is deliberately not synced.
- Warlock's throne bubble is 3 player-widths, blocks and reflects asteroids, lets players and arrows through, roots him, makes him invulnerable. Melee reach is far shorter than the bubble radius, so an enthroned Warlock swinging hits nothing — no special case needed.
- Druid swallow removes the passenger's input entirely. The passenger gets no say. Cooldown starts on release, so a full cycle is 20s.
- Ranger grapple: full cooldown on a miss, cancels if he takes damage, detonates asteroid anchors outright.
- Friendly fire is **sewage only**, including reflected sewage. Arrows and melee pass through allies.
- Downed: 3 skulls, crawl at 40%, revive takes 5s of standing still with no abilities, progress decays at 2x if the reviver breaks off.
- All three players downed is a loss **only once the party's extra lives are gone**. Ending the level the moment the last player fell would mean nobody could ever reach the button.
- Death persists across levels — that's what gives reviving a payoff. **Two things deliberately break this**: the Rebirth ultimate, and spending an extra life. Both were confirmed by the designer as the point rather than an oversight; do not "fix" either back.

## Open questions

Do not resolve these unilaterally; they need playtest input.

- **Is dodging fun?** M2 exists to answer this. If it isn't fun with placeholder circles, no character ability will save it.
- **Sewage density.** Current tuning was swept against *idle* players standing at spawn. Real players move and have no attack yet.
All of these are **deferred to a single tuning pass**, by decision, now that the mechanics exist. They are recorded with numbers so that pass can be quick; they are not blockers and should not be raised as such.

- **Cover erosion rate.** Still ~0% after the map redesign (15.9 of 16 standing). Players can now go out and defend the town, which is a new lever on this that did not exist when the numbers below were swept — but nothing was retuned, so the sweep table is still the starting point. M2 destroyed ~44% of cover in a 90s level. The wave rework drops that to **0%** at the shipped numbers — no structure is ever destroyed. The sweep table in the M4 waves section has the knobs and what each one costs.

- ~~**Should an unaided revive be possible?**~~ **Settled: no.** `lullSec` is 3 against a 5s revive, so an unaided revive cannot fit, deliberately. Extra lives replaced it — see the section below. The Warlock's throne, a Druid swallow, or a life are how somebody gets picked up.
- **Asteroid-vs-asteroid collisions.** Currently off; chunks pass through each other. `asteroids.collideWithEachOther` exists in tuning but is not implemented. The original design never asked for it, and bouncing sewage makes trajectories unreadable.

## Debug scaffolding to remove

- ~~`debug:split` and the `K` key~~ — gone. The attack button does that job now, and `debug.allowSplitNearest` / `debug.splitReach` went with it.
- `debug:heal` and the `R` key were slated for deletion in M4 and have deliberately been **kept**: downed/revive replaced their design purpose, but an instant top-up is genuinely useful while turning balance knobs. Delete them once the tuning pass is done.
- `tuning.debug.allowStructureDamage` and `damageReach` are dead keys: false, no handler, nothing reads them. Harmless, but they are not a feature you can switch on.

## M3: what the ability system does and does not do

Built and verified. Buttons were already in the wire format from M0, so nothing on the network changed.

- **Dash** is fully live and predicted. It overrides the accel lerp outright rather than adding to it, so dash distance is exactly `speed * duration` regardless of what the player was doing — predictable dodge length beats momentum here. It dashes along the move vector, or along aim when standing still, so a dash is never swallowed for letting go of WASD.
- **Attack repeats while the button is held**, at whatever rate `attackCdTicks` allows. It is the one ability that reads the button as held rather than as a rising edge; dash and special stay edge-triggered, because auto-dashing or auto-enthroning on a held key is nobody's intent.
- **Attack** resolves as a melee arc sweep on the server: `AsteroidSystem.inArc` collects chunks by reach-to-edge and bearing, one `swingId` per swing so a sweep cannot chain through its own fragments.
- **Special** is wired end to end — button, cooldown, HUD. `ArenaRoom.resolveSpecial` is the one place each character fills in; only the throne is filled in so far.

### Warlock throne

Split across the two sides along the prediction line, which is the pattern every remaining special should copy:

- **Predicted, in `stepPlayer`:** the root and the `specialTicks` clock. Rooting is movement, so the client has to reproduce it or it drifts by most of an arena width over three seconds. Enthroning mid-dash cancels the dash, or its leftover ticks would resume when the throne dropped.
- **Server only:** invulnerability, and the bubble itself. `ArenaRoom.activeBubbles` rebuilds the shell from `specialTicks` every tick, outside the input loop, so a Warlock who stops sending input does not have his bubble blink out. `AsteroidSystem` tests bubbles *before* players — the bounce has to happen before a chunk can reach anyone inside.
- Reflected chunks stay alive and keep their speed, so they are ordinary hazards travelling the other way. That is `reflectedSewageHurtsAllies` satisfied by construction rather than by a rule, and `reflectPreservesSpeed` likewise: mirroring a vector preserves its length.
- Measured with an A/B probe, 8 seeds, 30s, no invulnerability so the shell was the only protection: **0 hits enthroned against 1.6 unshielded**, 3.5 reflections a run, closest approach 125.4px against 44.1px. That was `reflectOffCircle`'s first ever driving.

### Ranger

Two jobs that share nothing.

- **Bow.** `ProjectileSystem` owns arrows, the first entity that is neither a player nor a chunk. Not predicted: like sewage, the server decides what they hit and the client extrapolates them along their line from the same snapshot. An arrow's own id doubles as its swing id, so the two fragments it makes are immune to it. Walls stop arrows and take no damage — nothing in the design lets the Ranger demolish cover.
- **Grapple.** The Ranger is **rooted while the hook is out** — `rootsCaster: true` in tuning, the same key the throne uses. The root's end is not predictable (only the server knows when the hook resolves), so `specialDurationTicks` gives the client the *ceiling*: the longest the hook could possibly fly. The client roots against that and a reconcile cuts it short the moment the hook lands. Ceiling, not rounding — rounding down handed the Ranger a free tick of movement before a miss resolved.
- `GrappleSystem` flies the hook and picks the anchor; `stepPlayer` runs the pull. That split is forced: where a hook lands depends on moving sewage the client does not simulate, but the movement an anchor produces is ordinary predicted movement. The client learns the anchor at the next reconcile and pulls from there, so a pull starts about one RTT late locally. Guessing instead would mean yanking the player somewhere the server never agreed to.
- `cooldownOnMiss` is satisfied by construction, since the cooldown is spent on the press and nothing refunds it. `cancelOnDamage` calls `GrappleSystem.cancel` from `damagePlayer`. An anchor whose wall falls mid-pull is caught by `expireLostAnchor`, which is the case `anchorLostVelocityDecaySec` exists for.
- Measured with a probe: arrow splits a Large into exactly two Small and is consumed; a wall stops an arrow at full hp; an arrow dies at 29 ticks against a predicted 30; the hook anchors and hauls the Ranger 234px; a chunk in the hook's path is removed outright leaving zero fragments; cancel mid-pull decays to exactly zero speed over 8 ticks.

**Settled: the grapple detonates sewage — destroyed, no children.** `AsteroidSystem.removeById`, not `splitById`. This is the only thing in the game that removes a Large without producing fragments, and it is deliberate rather than an oversight. Confirmed by the designer after the ambiguous wording was raised; do not "fix" it into a split.

### Druid

The only ability where one player's state is driven by another player's commands, which is why nearly all of it is server-side.

- **Swallow.** `SwallowSystem` owns it. A passenger's `carriedBy` makes `stepPlayer` stop dead: no movement, no abilities, no collision. That is the whole of `passengerLosesInput`, and it has to work that way because a passenger's client cannot predict where its Druid is going — it has no copy of the Druid's command stream. Cooldowns still drain while swallowed, so a rescued player comes out ready rather than owing time for having been eaten.
- **`cooldownStartsOnRelease` is real, not decorative.** `stepPlayer` skips the cooldown on the press for any special that declares it, and the server sets it when the passenger pops out. That is what makes a full cycle 20s rather than 15. Re-firing meanwhile is blocked by a `specialTicks === 0` guard, not by the cooldown.
- **Passive regen** runs outside the input loop with everything else that must not stall.
- Measured: passenger tracks the Druid to 0.000px across 60 ticks of fighting the input; released at 150 ticks against a predicted 150; cooldown reads 0 while carrying and 15s on release; an empty grab still burns the cooldown; a Druid hitting 0 hp spits the passenger out the same tick.

**Not implementable yet:** `canSwallowDowned`, `swallowingDownedBlocksSkulls`, and `swallowingDoesNotRevive` all describe the downed state, which does not exist until M4. Those three keys are inert, and swallowing currently does nothing special for a player at 0 health.

Deliberately not built, so nobody goes looking for them:

- **`windupSec` and `activeSec` are unimplemented.** Melee resolves instantly on the press. Those keys are feel work, not correctness.
- **Dash i-frames are wired but off.** Every character has `dash.invulnerable: false`; `onDashStarted` honours the key so flipping it is the whole change.
- **Cooldowns are debug text, not a real indicator.** The HUD strip above the canvas reads `dash / atk / spc` in seconds, which is enough to confirm the system works and nothing more — you have to look away from your character to read it. A proper in-world indicator (a ring on the player, pips, a flash on ready) is wanted and belongs with M4's HUD. Purely a rendering job: `specialCdTicks` is already predicted and sits on `Predictor.state`, so nothing on the network or in the sim has to change.

## M4: downed, revive, and the level result

`lifeState` on the player is the single authority: `LIFE_ALIVE` / `LIFE_DOWNED` / `LIFE_DEAD`. Health reaching zero puts you down; skulls taken while down are what kill. Nothing else may change it — `ReviveSystem` owns every transition.

- **Predicted, in `stepPlayer`:** crawl speed and the ability lockout, both gated on one `canAct` flag so there is exactly one place that decides what being down costs you. Dead players are inert.
- **Server only, outside the input loop:** revive progress, skulls, and the outcome. `ReviveSystem` advances everything; the client just renders it.
- **Revive requires standing still and using nothing**, read off `Player.revivingIntent` — set from a genuinely empty command, and cleared for everyone at the top of every tick before any input is consumed.
- Measured: crawl 98.0 against 245.0 full speed, a ratio of 0.400 against a tuned 0.4; revive completes at 150 ticks against a tuned 5s; revived at 60/120 hp; progress decays 30 → 10 across 10 ticks, exactly the 2x multiplier. Both outcomes driven over the network — `LOST at tick 1100` in a three-bot soak, and `WON at tick 240` against a temporarily shortened 8s level.

**The Druid's three downed keys are now real.** `canSwallowDowned` works (dead allies are excluded — nothing brings them back), and `swallowingDownedBlocksSkulls` and `swallowingDoesNotRevive` both fall out of existing behaviour rather than needing code: a passenger is invulnerable so takes no skulls, and `addHealth` refuses to touch anyone who is not `LIFE_ALIVE`, so regen cannot quietly stand a downed passenger back up.

## M4: waves

A wave is a spawn window followed by a lull. During a lull nothing new spawns, but chunks already in the air keep flying, so the arena drains over the four to seven seconds a chunk takes to cross rather than snapping clean. Judging when it is actually safe to commit to a revive is meant to be part of the decision.

Two knobs, deliberately separate, because one ramp owning both fights itself: `asteroids.spawn.rampSec` shapes the build *within* a wave, and `waves.intensityPerWave` compounds between them. Escalation is capped at `countPerLevel` so a long level cannot spiral into a solid wall. Waves cycle indefinitely — running out of schedule must not leave a dead, sewage-free arena.

**`lullSec` is deliberately still an open knob, not a decision.** `0` removes lulls entirely; anything below `downed.reviveSeconds` makes unaided revives impossible on purpose, which would make the Warlock's throne or a Druid swallow the only way to pick someone up. The code does not care either way.

### The wave rework made the game much easier, and this is not yet fixed

Measured, 8 seeds, 90s, 3 idle players, against an M2 baseline of ~44% of cover destroyed:

```
rampSec 38 (shipped)   hits  6.6   peak 13.3   cover  0% lost   safe 5.6s
rampSec 24             hits  8.4   peak 15.0   cover  2% lost   safe 5.5s
rampSec 16             hits 10.9   peak 23.6   cover 10% lost   safe 5.1s
rampSec 10             hits 19.9   peak 37.5   cover 45% lost   safe 5.0s
rampSec  6             hits 32.6   peak 47.6   cover 65% lost   safe 4.8s
```

`rampSec` is 38s but a wave only spawns for 16s, and the ramp now **restarts every wave** — so it never gets near `intervalMinSec` and the level never reaches the pressure M2 had. At the shipped numbers *nothing is ever destroyed*, which directly contradicts the design target of an arena that gets more dangerous. `rampSec 10` restores the old baseline; `rampSec 16` with `intensityPerWave 1.4` gives 32%. **Left at the shipped values deliberately — cover erosion is a listed open question and not mine to settle.**

The lull is also far more expensive than it looks, because it removes 27% of the level's spawning *and* lets the arena drain before the next wave starts from empty:

```
lullSec  0   cover 95% lost   safe 0.0s        (at rampSec 16 / intensity 1.4)
lullSec  4   cover 53% lost   safe 2.8s
lullSec  6   cover 32% lost   safe 4.8s
lullSec  8   cover 30% lost   safe 5.4s
lullSec 10   cover 10% lost   safe 9.0s
```

"safe" is seconds per lull with no chunk within reach of a player — the window a revive actually has, as opposed to the stricter fully-empty-arena figure `hitcheck` prints. Note 6 and 8 barely differ in difficulty but sit on opposite sides of the 5s revive, so the revive rule can be chosen almost independently of difficulty. **4.8s at the shipped 6s lull is a knife edge**: unaided revives fail by a fifth of a second, which will read as random rather than as a rule.

## M4: level progression

A level ends, an intermission counts down on the fixed step like everything else, and the next one starts on its own. There is no ready-up — that would need a lobby this scaffold does not have.

- **A win carries the run forward.** The town is *not* rebuilt, because `structures.repairableBetweenLevels` is false, so damage accumulates across levels. Life state carries too, because `deathPersistsAcrossLevels` is true — a teammate you failed to revive is still down when the next level opens, and that inheritance is the entire payoff for reviving anyone. `healToFullBetweenLevels` tops up survivors only; downed and dead players are untouched by it.
- **A wipe restarts at level one**, which is the one path that rebuilds the town and restores everybody to `LIFE_ALIVE`.
- `resetForLevel` clears everything transient at a boundary — a hook still travelling, a passenger still swallowed, a dash mid-stride — so nothing survives into a level it was not started in. Life state is deliberately absent from that list unless the run itself restarted.
- Driven end to end at a shortened 6s level: `level 1 WON at tick 180` → `level 2 begins at tick 240` chaining cleanly through six levels, the 60-tick gap being the intermission. The wipe path was forced separately with a temporary health drop: `LOST at tick 384` → `level 1 begins at tick 444` → 372 ticks of real play before the next wipe, which is what proves the life-state restore actually happened rather than the room losing again on tick one.

## M4: the cooldown indicator

Dash, attack, and special as three arcs around your own player, fed from the predictor so an arc empties on the frame you press the button rather than a round trip later. Self only — three of these on every player would be noise. Active beats ready: a running dash or throne shows full and bright even though the cooldown underneath is at zero. It replaced the `dash / atk / spc` text in the HUD strip, which is now gone.

## M5: presentation

Deliberately cheesy and entirely client-side. **If every line of it were deleted the game would play identically** — nothing in `src/shared` or `src/server` changed for M5, and `npm run verify` still reports `0.000000px`. That separation is what lets the art be as silly as it likes.

**Nothing was added to the asset pipeline, because there isn't one.** Sound is synthesized from oscillators and filtered noise in `audio.ts`; the particle texture is a white dot generated at boot; the favicon is an inline data URI. No files to load, none to 404, none to keep in sync.

### The hitbox rule survived contact

Bodies are still drawn at exactly `player.radius`, structures are still their literal collision rectangles, the melee arc still uses the server's `reach` and `arcDegrees`, and the throne bubble is still the radius sewage reflects off. `H` still overlays the truth.

Two places where decoration could have lied, and what was done instead:

- **Downed players were briefly drawn at 0.8x radius** to read as prone. That makes sewage look like it connects early, and skulls are the worst possible thing to be wrong about. The body went back to full radius and the *shadow* went wide and flat instead — the shadow is the only part of a player that is not a hitbox, so it is the only part allowed to deform.
- **Sewage lumps are drawn strictly inside the true radius.** Decoration may make a chunk look smaller than its hitbox, never bigger; under-drawing produces "why did that miss", over-drawing produces "that clearly hit me", and only one of those is survivable.

### Effects come from diffing state, not from new messages

`events.ts` derives one-off events by comparing consecutive snapshots — health dropping, a chunk vanishing inside the arena, a structure's hp falling, a cooldown counter jumping up. **No server changes and no new message types.** Presentation does not get a say in the wire format, and a missed splat costs nothing.

The honest cost: snapshots arrive at `patchHz`, so anything starting and finishing between two of them is invisible to this. Fine for particles, and would not be fine for anything the simulation reads. The local player's own abilities bypass it entirely and fire from the predictor, so they land on the frame the button went down.

Sounds are capped per kind per frame. A Large splitting over a wall can end four chunks in one snapshot, and four identical thuds on the same millisecond is a click, not four times the feedback.

### Verifying rendering needs a browser

The headless tools cannot reach any of this — `verify` and the bot soak never construct a scene, so a Phaser API mistake in `create()` would blank the game with every check still green. It was driven for real in Chrome via `puppeteer-core`: join, move, dash, swing, enthrone, wait for a wave, screenshot, read `console`. That caught the stale `MILESTONE 0` header and two favicon 404s, and confirmed facing reads at all four compass points.

There is no project skill for this yet and it needed a driver written from scratch plus `puppeteer-core` installed outside the repo. `/run-skill-generator` would capture it.

## The 8-bit art pass

Sprites are generated at boot in `src/client/pixels.ts` — no asset files, same stance as the synthesized audio. `ArenaScene` draws entities as pooled `Image`s keyed by id (the pattern the `labels` Map has used since M0) and keeps immediate-mode Graphics for everything that is debug or UI.

### One art pixel is exactly two screen pixels, and that is forced

For pixels to read as coherent 8-bit they must be a *uniform* size everywhere, which means the art pixel has to divide every hitbox dimension exactly. Those are 36 (player diameter), 96 (hut), 128×32 (wall), 68 and 34 (sewage) — **GCD 2**. So `PIXEL = 2`, an effective 640×360. Anything chunkier would mean changing hitbox sizes, and those are balance.

If a hitbox dimension ever changes, recheck this. An odd number anywhere drops the GCD to 1 and the whole art scale collapses.

### Which shapes are generated and which are drawn

- **Anything that *is* a hitbox is generated from the hitbox** — bodies and sewage fill a disc computed from the radius collision uses, so the silhouette cannot drift a pixel from it. Sewage is drawn as a coiled turd, but every coil is clipped to that disc by `Pix.ellipseIn`: the detail inside can be any shape it likes while the outline stays exactly what collides. A coil wide enough to read would otherwise bulge past the radius. Rotation is free for both, because a rotated disc covers identical pixels; that is what lets downed players visibly lie down and chunks each sit at their own angle without either becoming a lie.
- **Only decoration is hand-authored** as string art: weapons, roofs, floor tiles, the arrow.

Verified in a browser with `H` on: every hitbox outline lands on its sprite edge.

### The weapon

Each character carries one — bow, toothy maw, big sword — positioned along the aim angle. `weaponStyle` in `pixels.ts` decides how each animates, and it is keyed on the character rather than on `attack.kind`, because how a weapon moves is a property of the art: the Druid swings nothing, it bites.

The maw is one jaw sprite drawn twice, the lower one flipped, both hinged on the same point so the teeth meet when it shuts. Its bite runs longer than the Druid's 0.12s `activeSec` purely to be legible — a jaw that opens and closes inside four frames only flickers — and still finishes well inside the 0.6s cooldown, so bites never overlap. It is the facing indicator, so the body never rotates and needs only one sprite per character.

The swing is **cosmetic**. The hit resolves on the server the instant the button goes down; the sweep is drawn *across* that moment rather than leading up to it, so it never shows a strike that has not landed. That is also why it uses `activeSec` but not `windupSec` — a wind-up would draw a delay the simulation does not have. The aim is frozen at the moment of the swing rather than tracked live, because that is the angle the hit actually resolved at.

### The throne

An actual throne sprite appears under the Warlock while he is enthroned, drawn behind the body and lifted so he reads as sitting in it. It is a prop in the `props` pool keyed by player id, so it vanishes on its own when `specialTicks` runs out and the pool sweeps it.

Its cushion is violet, not red: the Warlock himself is red, and a red cushion behind a red body made the throne disappear at exactly the moment it was supposed to appear.

The throne collides with nothing. The thing that actually stops sewage is still the bubble, still a vector circle at exactly `throneBubbleRadius`.

## Perks

Clearing a level offers every surviving player three random bonuses, and they pick their own. 33 of them live in `src/shared/perks.ts`: 18 generic, 5 per character. Numeric perks stack; flags leave that player's pool once taken. A wipe clears them along with the rest of the run.

**Balance is explicitly not a concern here** — the numbers are first guesses and several are probably absurd. That was the brief.

### Only the ids cross the wire

`Player.perks` is an `ArraySchema<string>`. Both sides fold it into a `PerkMods` of plain numbers with the same `applyPerks`, and `stepPlayer` reads those numbers instead of raw tuning. Nothing derived is synced, so the two sides cannot disagree about what a perk is worth — and `applyPerks` is order-independent by construction, which matters because the client rebuilds from a list whose order it does not control. `npm run verify` asserts both that a perk changes what `stepPlayer` computes and that reordering a list does not change the result.

Mods are rebuilt only when the list changes, never per tick.

### The drawing follows the perks

Everything a perk changes about how a character *acts* is drawn from that player's mods, not from raw tuning: melee reach and arc, the throne bubble radius, the cooldown ring totals, and the skull pips. `meleeSweep` in `perks.ts` is shared so the arc the client draws is the arc the server swept — the same reason structures are drawn as their literal collision boxes.

Remote players' perks are synced too, so a teammate's wider throne and extra skull pips render correctly. `ArenaScene.modsFor` memoises the fold per player on the list it came from; the list changes once a level, not once a tick.

A cooldown ring needs the *modified* cooldown as its total, not the tuning one. Shorten a cooldown without shortening what it is measured against and the ring never reads as full even when the ability is ready.

### The usual line, in the usual place

- **Predicted, read by `stepPlayer`:** speeds, cooldowns, dash distance, crawl, and Unmoored.
- **Server only:** health, damage taken, invulnerability, skulls, revive, reach, projectiles, throne, swallow, structure repair.

**One perk crosses that line awkwardly and it is worth knowing.** Adrenaline makes move speed depend on current health, and health is server-owned and not predicted. A hit landing mid-replay mispredicts speed for about a round trip before reconcile corrects it. Same shape as the grapple anchor, accepted rather than accidental — and it is the only reason `health` is on `PlayerSimState` at all.

### The level-up gate

`advanceIntermission` will not start the next level until everyone has picked, **or** `level.choiceTimeoutSec` expires and it picks for whoever is still deciding. Dead players are marked picked immediately — they are out for the run, so waiting on them would be waiting forever. The timeout exists for the same reason the swallow release is server-owned: one player must never be able to hold the others up.

The screen is a DOM overlay (`src/client/perkScreen.ts`), not drawn in the canvas, matching how character select already works. `npm run bot` picks randomly, without which every soak past level 1 would only be testing the timeout.

Second Stomach forced `swallowedId` to become `swallowedIds`, a list — one deadline covers the whole mouthful, so grabbing a second ally does not extend the first one's stay.

## Music

`src/client/music.ts`, synthesized like the effects — no asset files. Three layers keyed off state the client already has: bass alone through a lull, drums once a spawn window opens, a lead arpeggio from the second wave on. A lull going audibly quiet is the point rather than decoration; it is the window a revive has to fit inside.

`Sfx` owns it and routes it through the same master gain, so **`M` mutes music and effects together** without either knowing about the other, and it can only start after the gesture that creates the context.

**Scheduling is lookahead, and it has to be.** A coarse 25ms timer queues every note falling in the next 120ms against absolute `AudioContext.currentTime`. One `setTimeout` per note drifts audibly within seconds, because timer callbacks are not millisecond-accurate and the error accumulates. The timer decides *what* to queue; the audio clock decides *when* it sounds.

Headless checks can confirm a running `AudioContext` exists — Chrome's WebAudio CDP domain reports `state=running` — and that nothing throws. They cannot tell you whether it sounds good. That part needs ears.

## The level timer bar

A plain bar across the top of the arena, drawn in `ArenaScene` with the debug `Graphics` because it is UI. Colours by remaining fraction on the same thresholds `drawHealthBar` uses so the two read as one system, and hides once the outcome is decided. The `time 62s` HUD text stays; the bar is the thing you can actually read while dodging.

## The Dungeon Master

A fourth role that does not play. They watch the whole arena, start each level, and get a summary when it ends.

### The DM is not a Player, and that is the whole design

`state.players` still means "the three characters"; the DM lives in `state.dm`. Making them a `Player` would have meant adding "unless they're the DM" to `allDown()`, `findPlayerHit`, `nearestAlly`, `inArc`, `spawnPoint` indexing, perk offers, the revive scan and the swallow scan — nine places where missing one is a live bug, like the loss condition never firing or sewage aiming at a body that isn't there. Keeping them apart meant **none of those systems changed at all**.

`maxClients` is `maxPlayers + 1`, and `onJoin` caps *players* at `maxPlayers` itself — `maxClients` alone would let a fourth player in and drop them on someone's spawn.

### Levels wait

`OUTCOME_WAITING` shares the `outcome` field rather than being a separate phase, because every `outcome !== OUTCOME_PLAYING` check already means "the level is not running" — the world freeze, timer bar, music and revive clock all handled it for free. Only the banner needed new wording, and it needed it: without a WAITING branch it fell through and read **WIPED**.

`level.requireDmToStart` gates it, but **a level with no DM connected always starts on its own regardless**. That is not a convenience — without it `npm run bot -- 3` deadlocks at a start screen forever and the soak stops testing anything.

The perk timeout still auto-*picks*; it no longer auto-*starts*. `pendingLevel` is settled at `endLevel`, not at `awaitStart`, so the button reads "Start level 4" the moment level 3 ends rather than offering level 3 again while perks are being chosen.

### Statistics

Per player and team-wide, each as a level counter and a run counter. Kills are credited at the call site — `resolveAttack` knows the swinger, `detonate` already takes the Ranger, and the arrow path needed only the projectile's existing `owner` — so `AsteroidSystem` never had to learn who was responsible.

Two things worth knowing if you extend this:

- **`DmPanel` memoises its table.** It runs every frame, and rebuilding a table of DOM nodes at 60fps made the page unresponsive enough that Puppeteer's `evaluate` timed out on it. Same memo `PerkScreen` uses.
- **Two game clients need two browsers, not two tabs.** Both render through swiftshader, and two software WebGL contexts in one browser starve each other until the background tab stops responding. Background-throttling flags are not enough.

## Ultimates

One enormous ability per class, once per level, on **Shift**. Special stays on right mouse (and `E`). You choose one of your class's three when level 5 is cleared, and improve it at 10 and 15 — two of three upgrades by the end, so runs diverge. Nine ultimates and 27 upgrades live in `src/shared/ultimates.ts`.

**Balance is explicitly not a concern here either.** These are meant to be game-breaking, and two of them deliberately break a locked design rule: Rebirth and Second Life undo permanent death. That is the point of an ultimate, and it was confirmed rather than assumed.

### They ride the perk pipeline, because they are just ids

`offerFor` picks the pool by level — `level % 5 === 0` offers the three class ultimates, or three upgrades to the one you took, and every other level offers perks — and `takePerk` routes the chosen id to `ultimateId`, `ultimateUpgrades` or `perks`. Everything downstream came free: the offer/hasPicked gate, `perk:pick` validation, the timeout auto-pick, the DM's start gate and the card overlay all work unchanged. **A milestone level offers no perk**; that is a one-line change if it should offer both.

Consequences worth knowing: level 20 offers the single upgrade you have left, and level 25 falls through to a perk. Both are the fallthrough working, not a gap.

### The same prediction line, with one new trick

An active ultimate contributes a **`PerkMods` overlay** rather than a second mechanism. `p.mods` stays perks-only and `activeMods` in `sim.ts` layers `ultimateMods` on top while `ultTicks > 0`, so Windrunner's zero cooldown, the Cathedral's root and Dilation's speed are all predicted with no new machinery — both sides derive it from the same synced ids with the same function. `ArenaScene.modsFor` composes it the same way, so what gets drawn is what the simulation is using.

World effects stay server-side: Reckoning, Consecrate, Arrow Storm, Rebirth, Grove's mass swallow, Devour's eating. Slow the Storm is `state.slowFactor`, which `AsteroidSystem` multiplies its **chunk** `dt` by — spawning and the wave clock stay at real time, because it slows the sewage, not the level.

`ultReady` is refilled in `startLevel` and spent in `stepPlayer` on the rising edge. Echo and Rally are absolute server ticks (`ultEchoTick`), like every other timer that must survive a starved input queue.

### Three things this pass fixed on the way past

- **`destroyLarge` never applied to arrows.** It was read only in `resolveAttack`, so Demolition on a Ranger did nothing — a pre-existing gap that Barbed would have inherited. It is now stamped on the `Projectile` at spawn and carried through `onAsteroidHit`, which is the right place anyway: an arrow outlives the shot, and Arrow Storm's volley is not the shooter's ordinary mods.
- **`splitShot` became `arrowsPerShot`.** Windrunner's Fan wants five arrows and Split Shot wants three, so a boolean could not express it. Everything that raises it uses `Math.max`, which is what keeps `applyPerks` order-independent — `verify` asserts that.
- **Bloom is applied while the passenger is still inside**, not on release. A passenger is invulnerable in there so the moment is invisible either way, and it avoids depending on which of `SwallowSystem`'s several release paths runs.

### How it was verified

- `npm run verify` — `0.000000px`, and the controls block prints `ultimate <- ShiftLeft, ShiftRight` against `special <- KeyE, right mouse`. That block fails outright if an input lands on two abilities, which is the exact mistake worth guarding when a key moves.
- **A probe over the offer pools**, driving the real `dealOffers` / `takePerk` for all three classes across 16 levels: 5 offers exactly that class's three ultimates and nothing else, 10 offers three upgrades for the one taken, 15 offers the remaining two, every other level offers perks, and each class ends holding one ultimate and two upgrades.
- **A probe asserting every upgrade changes something measurable**, base against upgraded, 27 of 27. It caught a real one: Barbed read `0 -> 0` because the piercing volley shredded the fragments too — a vacuous pass in exactly the shape this file keeps warning about. Stopping at the first hit gives `2 -> 0`, which is the actual claim.
- **`npm run bot -- 3`** at a shortened 10s level: 18 levels, zero errors, all three classes handed an ultimate at 5, using it, and taking upgrades at 10 and 15.
- **A browser run** to level 21: the card screen reads "choose an ultimate" at 5, Shift fires it, a second press in the same level does nothing, it recharges every level, and Vigil moves the duration from 215 to 335 ticks — 8s to 12s, exactly. No console errors.

Both probes were throwaway and are deleted, as the discipline above says. The browser driver needed `window.__net` exposed from `main.ts`; that hook was temporary and has been removed.

## The map: a town in the middle of open ground

The arena is **1600×1200** and the town is a **1000×720** box in the centre, leaving a ring of open ground 300px wide left and right, 240px top and bottom. Sewage is aimed at the town box, not at the arena.

That geometry exists to create a choice the old map could not offer. The town used to fill the whole arena, so there was nowhere to stand that was not already among the houses, and cover eroded with nothing you could do about it except be somewhere else. Now you can shelter behind a hut, **or** walk out into the ring and stand in a lane between an arena edge and the town to break a chunk before it lands — out in the open, away from every piece of cover, which is what the choice costs.

### One rectangle, three readers

`townBox(t)` in `src/shared/structures.ts` is the only definition. `generateLayout` places inside it, `AsteroidSystem.spawn` aims at it, and `ArenaScene` draws the ground differently inside it. Three copies of that rectangle would eventually disagree, and the disagreement would be invisible until sewage started aiming at ground the houses had moved off.

`townBox` throws if the box is not inset from the arena by at least `padding + minGap`. That inset is what replaced the old edge constraint in `generateLayout`: structures may now sit right on the town's edge — which is what keeps the outer houses exposed to the ring rather than tucked behind an invisible margin — and they still cannot pinch anyone against the arena boundary, because the ring is between them.

### The ground is two textures

`pixels.ts` generates an `outskirts` tile beside the existing `floor`: darker, no grout, quieter. `ArenaScene` lays the outskirts edge to edge and the town paving on top at exactly `townBox`. Without this the redesign reads as "the map got emptier" rather than "there is a town, and there is outside the town". Client-only, generated at boot, no asset files — same stance as the rest of M5.

### Measured, not assumed

- **The town fits.** 128 seeds, all 16 structures placed every time, min gap achieved 56.1px against a tuned 56, nothing within `spawnClearRadius` of a spawn, nothing overflowing the box. This was the risk in the change: rejection sampling gives up silently after 300 attempts, so a town that is slightly too tight just has fewer buildings and still looks fine.
- **97.8% of chunks cross the town.** I expected the ring to catch a lot of strays, because `aimJitterDegrees` is applied at the source and the flight is now much longer. It does not: the town is big enough that a 22° cone from an edge still lands on it. Only **2.3%** miss into the ring. So the ring is quiet, and going out is safe *unless you put yourself in a lane* — which is exactly the intended shape, but it is quieter than I predicted in the plan.
- **The whole arena is still visible and walkable.** Driven in a browser: walked from the spawn plaza out past the town edge, on to the west clamp at x=42 (`padding + radius`, exactly), and back in. Hitbox overlay confirms outlines land on sprite edges at the outermost houses. No console errors.

### What it cost

- **Everything renders 31% smaller.** `Phaser.Scale.FIT` keeps the whole arena on screen, so 1600×1200 on a 1400×900 window renders at 1200×900 against the old 1400×788. A follow camera would avoid it and would break both reading incoming sewage and the DM's whole job, so it was rejected.
- **Peak sewage on screen nearly doubled**, 13.3 → 22.4, purely because flights are longer and more chunks are in the air at once for the same spawn rate. `maxAlive` is 90, so it is not acting as a cap — that was a flagged worry and the number settles it.
- **A lull drains much more slowly.** `hitcheck` now reports 1.4s of fully-clear arena per 6s lull. Same cause.

### The new balance baseline

Replaces the M2/M4 figures above; 8 seeds, 90s, 3 idle players, shipped tuning:

```
player hits per level   8.3     (was 6.6 on the old map)
first hit at            21.9s
peak sewage on screen   22.4    (was 13.3)
cover at end            15.9/16 standing
fully-clear per lull    1.4s of 6s
```

Player hits went **up** on a bigger map, because sewage now converges on the town where the players are instead of scattering across the whole arena. Cover erosion is still ~0%, which is the same open question it has been since the wave rework — unchanged by this pass and still not settled here.

## Extra lives, shorter levels, and a difficulty ramp across the run

The first deliberate balance pass, on knobs the designer named directly. Levels run 45s with
the wave clock halved to match (four waves of 8s spawning and a 3s lull), sewage starts at half
speed and half rate and climbs with the level number, and the party gets three shared extra
lives.

### The ramp

`speedStartMul` / `speedPerLevel` / `speedMaxMul` and `intervalPerLevel`, all in
`asteroids.spawn`, read by `AsteroidSystem`. Three escalations now stack and they are
deliberately separate axes: `rampSec` shapes a wave, `intensityPerWave` escalates between
waves, `intervalPerLevel` escalates between levels.

Speed is capped and the interval is not, because the failure modes differ — a denser storm is
still readable, and a fast enough chunk cannot be reacted to however good you are.

Measured: speed 0.50× at level 1, 0.93× at 9, capped at 1.75× by 20. Interval at a wave's start
0.86s at level 1 down to 0.20s by 20.

### `rampSec` had to move, and it changed the answer

`spawnSec` halved to 8, and CLAUDE.md's own gotcha says a ramp longer than its phase never
completes — at `rampSec 38` it would have got 21% of the way to `intervalMinSec`, so halving
`intervalMinSec` would have meant nothing. Setting `rampSec` to 8 fixes that, and fixing it
*raises* the effective rate, because the ramp now actually reaches its floor.

That mattered: with the interval keys merely doubled the measured rate was **72% of the old
one, not 50%**. The keys were then set from the measurement — `intervalStartSec` 0.86 and
`intervalMinSec` 0.26 — which lands it at exactly 50%. Doubling the two obvious knobs would
have quietly missed the target by a fifth. **If you touch any of these four, re-measure the
per-second rate rather than reasoning about the keys.**

### Lives

`GameState.lives`, one shared pool, `level.extraLives` deep, refilled only in the `restarting`
branch of `startLevel`. Spent by pressing special while down or dead, which routes through
`ReviveSystem.forceRevive(p, true)` — the entry point the Rebirth ultimate already used, so
there is still exactly one thing in the codebase that undoes death.

**The blocker this hit is the interesting part.** `checkOutcome` ended the level the instant
`allDown()` was true, so the moment the last player went down the level was already over and
nobody could ever press the button — lives would have been useless in precisely the situation
they exist for. Two changes: nobody standing is a loss only at zero lives, and the timer branch
now checks that somebody is upright, or a party lying on the floor with lives in hand would win
by outlasting the clock. That second one was implicit before and had to be said out loud.

### Showing it

`lives ●●○` in the HUD strip always; the party's pool in the DM's footer and a "lives spent"
row per player in their table. When you are down or dead, a panel in the arena with big skull
pips, life pips, and the prompt — pinned to the bottom of the arena and flipping to the top
when you are lying in the lower third, which is what keeps it off you.

The key in the prompt comes from `bindingLabel()` over the `BINDINGS` table, not from a string
beside it. A prompt naming the wrong button is the exact bug this project already shipped once,
when Shift dashed for weeks while the docs said otherwise.

### Verified

- `npm run verify` — `0.000000px`, with new controls assertions: SPECIAL fires `special` when
  alive and `life` when downed or dead, holding it claims exactly once, and a swallowed player
  claims nothing.
- **Lives probe**, 9 assertions, all passing — including the three that cover the blocker: all
  down with lives left stays PLAYING, all down at zero lives is LOST, and the timer with nobody
  standing is LOST rather than WON.
- **Ramp probe** — speed and interval monotonic across levels 1→30, speed capped at 1.75×, and
  the spawn-rate measurement above.
- **Soak**: 3 bots, zero errors. The first run spent no lives at all because the game is now
  easy enough that bots never fall over — a vacuous pass. Re-run with health temporarily
  dropped, it logged `bot-0 spent a life (2 left)` then `bot-2 spent a life (1 left)` across
  two levels, which is the whole network path and confirms the pool is per-run.
- **Browser**: went down for real, panel appeared reading `DOWNED — PRESS E OR RIGHT MOUSE TO
  SPEND A LIFE` with 3 empty skulls and 3 life pips; pressing E revived at full health with the
  pool at 2; walking to the bottom of the arena and going down again moved the panel to the top.

### The new baseline

```
player hits per level   0.9     (was 8.3)
first hit at            37.1s
peak sewage on screen   21.6
cover at end            16.0/16
fully-clear per lull    0.0s of 3s
```

**This is now very easy for idle players** — 0.9 hits in a level, and cover takes nothing at
all. That is the direct consequence of the requested numbers, not a bug, and the ramp is what
is meant to answer it by level 8 or so. The figures above are for level 1; nothing has measured
what level 10 or 15 actually feels like, and that is the obvious next thing to sweep.

`lullSec` is no longer an open question: at 3s an unaided revive cannot fit, by decision. Lives
are the mechanic that replaces it.

## Passive DM, the countdown, the score, and the cabinet

### A fifth outcome value paid for itself again

`OUTCOME_COUNTDOWN` is the three seconds between a level being built and sewage starting to fly. It is another value on `outcome` rather than a phase of its own, and that was the whole design: `fixedTick` freezes the world on `outcome !== OUTCOME_PLAYING`, and so do the timer bar, the spawner, the revive clock and the music — so a new value inherited every one of them with **none of them touched**. Same reasoning as `OUTCOME_WAITING`, and it held a second time.

`startLevel` now builds the level and ends in `COUNTDOWN`; `goLive()` sets `PLAYING`. **`levelEndTick` is set in `goLive`, not in `startLevel`** — otherwise the three seconds of "3, 2, 1" would be quietly taken out of the 45 seconds you were given. The probe asserted exactly that.

Players still move during the countdown, because the input loop runs before the freeze check. That is deliberate: you get to reposition before the first wave.

### Passive DM is one condition

`Dm.passive`, synced, set by a `dm:passive` message with the same sender check `dm:start` uses. The gate in `advanceIntermission` gains `&& !this.state.dm.passive`. Nothing else about the role changed — same panel, same table, same button.

The one thing that would have gone stale: the players' banner reads `waiting for {dmName}`, which is a lie in passive mode. It reads `starting` instead.

### Score

`src/shared/score.ts`, run by both sides, for the same reason `applyPerks` is: the server awards the total and the client renders the breakdown explaining it, and two copies of that arithmetic would eventually disagree about why somebody scored what they scored.

`(10 × sewage destroyed + 100 × houses standing) × (1 + 0.25 × (level − 1))`. A flat quarter-step per level rather than `× level`: multiplying by the level number makes the score mostly a measure of how deep you got and drowns out everything that happened on the way.

**The three components are stored, not recomputed.** `startLevel` rebuilds the town, so a client counting standing houses live would explain the award with numbers that no longer apply by the time anyone reads them. `lastScoreChunks` / `lastScoreHouses` / `lastScoreTotal` are a snapshot of what was actually awarded, and the probe checks they still add up after a rebuild.

Score is a run resource: it resets only in the `restarting` branch of `startLevel`, beside lives and perks.

### The cabinet

`index.html`, pure CSS — neon title, scanlines, vignette, glowing fighter cards in each character's own tuning colour. No font files and no images, because there is no asset pipeline and adding one for a title would make it the only asset in the repo.

Three things worth not breaking:

- **`button[data-char="..."]` and `button[data-role="dm"]` are load-bearing.** `main.ts` binds to them and every Puppeteer driver in the recipe above clicks them. Restyle freely; leave the attributes.
- **The scanline overlay needs `pointer-events: none`.** It covers the whole cabinet, so without it the layer eats every click and nothing is selectable.
- The flicker and blink sit behind `prefers-reduced-motion`. A full-screen flicker is an accessibility problem, not a decoration.

`.dm-sub` was missing `white-space: pre-line` and had been since the DM panel was built — its footer composes lines with `\n` and they had all been running together. Fixed in passing.

### Verified

- `npm run verify` — `0.000000px`. The countdown does not disturb prediction, because players are stepped before the freeze check either way.
- **Score probe**: multiplier exactly 1 / 1.25 / 1.5 / 3.25 / 5.75 at levels 1 / 2 / 3 / 10 / 20; the stored breakdown still explains the award after the town is rebuilt; a win carries the total, a wipe zeroes it.
- **Phase probe**: an active DM held `WAITING` for 600 ticks and flipping passive released it on the next tick; an empty DM chair never holds; `startLevel` lands in `COUNTDOWN` with `levelEndTick` still 0; zero chunks spawn during the count; and the level runs its full 1350 ticks afterwards.
- **Soak**: 3 bots, zero errors, countdown exactly 90 ticks every level, score accumulating 1670 → 3720 → 6165 with the right multipliers.
- **Browser**: entry screen screenshotted and looked at; selectors intact; countdown caught at `outcome=4`; score awarded. A second browser process as DM held the level for 6s, then ticking Passive DM started it — no console errors in either client.

## Hut/wall scoring, a readable upgrade screen, and a doubled attack rate

### Huts and walls are not worth the same

`perHouseStanding` split into `perHutStanding: 150` and `perWallStanding: 50` — a hut is the town, a wall is cover that happens to be destructible. `Structure.kind` was already `"hut" | "wall"` and already synced, so `awardScore` only had to count them separately. A full 7-hut/9-wall town pays 1,500 against the old flat 1,600, so nothing else in the scoring needed recalibrating.

`lastScoreHouses` became `lastScoreHuts` / `lastScoreWalls`, still a snapshot for the reason already recorded: `startLevel` rebuilds the town, so a live count would explain the award with numbers that no longer apply.

### The attack rate doubled, and that broke a constant nobody would have noticed

Cooldowns halved: ranger `0.45 → 0.225`, druid `0.6 → 0.3`, warlock `0.7 → 0.35`.

**`BITE_SEC` was a trap waiting to spring.** The comment on it said the Druid's 0.24s bite sat "well under the 0.6s attack cooldown, so bites never overlap" — a hand-picked constant validated against a tuning value it had no connection to. At a 0.3s cooldown the headroom was nearly gone, and **two stacks of Fast Hands (`attackCdMul *= 0.85`) put the cooldown under 0.24s**, at which point the jaw reopens before it has finished shutting.

The fix is `swingSeconds()` in `ArenaScene.ts`, which clamps any attack animation to `cooldownSec * attackCdMul * 0.8`. Self-correcting for every perk stack and every future tuning change, which a second hand-picked constant would not have been.

**The floor in it is required, not defensive.** Windrunner sets `attackCdMul = 0`; without `SWING_MIN_SEC` the progress calculation divides by zero. The probe asserts that case explicitly.

If you shorten a cooldown again, you do not need to touch the animation. If you add a *new* animation constant, clamp it the same way.

### The level-up screen

Three changes, all because it is read under a 30-second clock:

- **The timer is a draining bar**, recolouring on the same 0.5 / 0.25 thresholds `drawHealthBar` uses, so a bar running out reads the same way everywhere in the game. It was 11px grey text.
- **`YOUR BUILD`** lists every perk and your ultimate with its effect text, upgrades indented under the ultimate. `defFor(id)` already resolved all three pools, so this needed no new data. Memoised on the id list — `DmPanel` proved what rebuilding a DOM list every frame does to this page.
- **The pick handler clears that memo.** Taking a perk changes the list while the screen is still up, and without it the new perk would not appear until something else happened to change.

### Controls come from BINDINGS, in both places

`controlPairs()` / `renderControls()` in `input.ts`, beside `bindingLabel`. The entry screen and the level-up screen both call it, at 15px with keycaps rather than 11px `#475569`.

Derived rather than written twice, for the reason already in this file: Shift dashed for weeks while the docs said it cast the special, and the lesson was that a control's description must come from the table that decides what the control does.

`controlPairs` shows **one input per action** — the mouse button when there is one, so special reads `RMB` and not `E OR RMB`. `bindingLabel` still returns the full mapping wherever the whole truth is wanted, and `verify` still prints it.

### Verified

- `npm run verify` — `0.000000px`, and its held-attack line went from **8 attacks over 154 ticks at a 21-tick cooldown to 14 at 11 ticks**. That expectation is derived from tuning, so it tracked the change on its own.
- **Score probe**: full town 1,500; losing one hut costs exactly 150 and one wall exactly 50; a mixed 5/7-hut, 6/9-wall town scored right through the real room; ruined structures excluded; the breakdown unchanged after a rebuild.
- **Attack probe**: 1.95× / 2.00× / 1.87× more attacks over 300 held ticks for ranger / druid / warlock. Animation fits inside the gap at 0, 1, 2 and 3 Fast Hands stacks for all three — the druid at 2 stacks is 0.173s in a 0.217s gap, which is the case the old fixed constant would have broken. Windrunner returns the 0.05s floor rather than dividing by zero.
- **Soak**: 3 bots, zero errors, huts and walls counted separately in the level logs.
- **Browser**: entry and level-up controls both read `WASD move · MOUSE aim · LMB attack · RMB special · SPACE dash · SHIFT ultimate`; the timer bar drained 30s/99.6% → 26s/86% over four seconds; the build list showed the perk taken a level earlier with its effect text.

## Pause, weapons that grow, and attack speed leaving the game

### Pause freezes the clock, not the systems

`fixedTick` returns before `this.state.tick++` while `state.pausedBy` is set. That is the whole
mechanism, and it was chosen over a set of "if paused, skip" guards for one reason: **every
deadline in this game is an absolute tick.** `levelEndTick`, `wavePhaseEndTick`,
`invulnUntilTick`, `swallowUntilTick`, `ultEchoTick`, `slowUntilTick`, `coverPhaseUntilTick`,
`intermissionEndTick` — a clock that does not advance leaves all eight correct on resume with no
bookkeeping, and cannot be broken by a ninth being added later. The probe asserted all eight.

- **Esc is a room message, not a `BINDINGS` bit, and that is forced.** BINDINGS map to the button
  bitmask, the bitmask travels in the command queue, and pausing is exactly what stops that queue
  being consumed — an unpause sent that way could never arrive. `KEYS` in `input.ts` holds it, so
  it is still declared rather than a bare string.
- **The command queues are deliberately not cleared.** The client stops producing, so only the
  two or three already in flight remain and they drain and get acked normally. Dropping them
  unacked would leave the client replaying them forever — a permanent divergence rather than one
  frame of stale input.
- **Only the pauser can resume**, by decision. `onLeave` clears a pause whose owner disconnected;
  that is not a second unpauser, it is the case where the one person who could press the key no
  longer exists, and without it the room freezes for good.
- `togglePause(sessionId)` is a method, not a closure in the handler, so the probe drives the
  real decision. A probe that re-implements it would agree with itself perfectly while disagreeing
  with the game — which is how the predictor's character bug survived.

### Nothing *scales* attack speed any more; one ultimate suspends it

Fast Hands is gone and **`attackCdMul` is deleted from `PerkMods`** — a mod nothing can move is a
lie in the type, the same complaint this file already makes about `debug.allowStructureDamage`.
`stepPlayer` reads `c.attack.cooldownSec` straight from tuning.

**Windrunner keeps its no-cooldown clause**, as `noAttackCooldown: boolean`. A flag, not the old
multiplier, and the distinction is the point: no perk or upgrade scales attack rate, so a
multiplier would imply a spectrum nothing populates. Exactly one thing sets this, and it does not
scale the cooldown — it removes it. `secToTicks` floors at one tick, so that is one arrow per
tick and not an infinite loop. Measured: 240 arrows over 240 held ticks, against 14 normally.

Three places read the flag, and all three need it: `stepPlayer` for the cooldown itself, the
cooldown ring's *total* (or the arc reads as permanently unready while the bow empties), and
`swingSeconds`. **The floor in `swingSeconds` is what makes Windrunner safe** — its cooldown is a
single tick, so without one the animation length would collapse toward zero and the progress
calculation would divide by it. The floor is 0.05s against a 0.033s tick, so an animation still
outlives the tick that started it.

Cooldowns: druid and warlock unified at **0.3s**, ranger **0.6s**. Measured over 600 held ticks:
ranger 34, druid 67, warlock 67 — the melee pair identical, the bow at 0.507× their rate.

Two replacements, both generic, both server-side, both triggered from `creditKill` where the
kill is already credited:

- **Scavenger** — 1 health per chunk, stacking.
- **Salvage** — a 10hp repair every 8 chunks, halving to every 4 when stacked. It repairs the
  most damaged **standing** structure; rubble stays rubble, because Masons is the only thing that
  brings cover back from zero. `salvageEvery` is 0 when untaken, so the first copy sets 8 rather
  than subtracting from it — otherwise one perk would have meant a repair every chunk.

### The weapon shows its reach

`drawSwing` — the yellow arc, and the circle Cleave turned it into — is deleted along with
`swingUntilMs` and `SWING_FLASH_MS`. `reachScale()` scales the sword and the maw by
`meleeSweep(atk, m).reach / atk.reach`, from the same function the server sweeps with, so a
weapon that looks longer is a weapon that hits further.

**This is the one place the art's uniform pixel size is deliberately broken.** `PIXEL = 2`
everywhere else; Reach at 1.25× puts a sword on 2.5, two stacks on 3.1. Allowed because a weapon
collides with nothing — decoration is the only thing permitted to deform — and checked in a
browser rather than assumed: at 3.1× the blade still reads as clean chunky pixels.

The pale ring still drawn around a Druid is Verdant's heal radius, not the removed arc.

### Verified

- `npm run verify` — `0.000000px`; its held-attack line now reads 18 attacks at a 9-tick warlock
  cooldown.
- **Pause probe**: 600 ticks paused with `tick` and all eight deadlines unchanged and no sewage
  movement; resume advances by exactly one; a second player cannot lift someone else's pause;
  a second pause in the same level is refused; `resetForLevel` restores it; `onLeave` clears a
  stranded one. Driven through the real `togglePause` and the real `onLeave`.
- **Perk probe**: `fast-hands` absent from `PERKS` and never produced by `rollOffer` across 400
  seeds × 3 characters; `attackCdMul` absent from `noMods()`; Windrunner keeps piercing and its
  fan; Scavenger 1 and 2 per kill; Salvage at 8 and at 4, skipping rubble, silent without the perk.
- **Windrunner probe**: 240 arrows over 240 held ticks against 14 normally; every perk applied at
  once still leaves `noAttackCooldown` false; another ultimate does not set it; the animation
  falls back to its 0.05s floor rather than dividing by a one-tick cooldown.
- **Soak**: 3 bots, zero errors, Salvage picked and used.
- **Browser**: subtitle reads "endless shit"; controls include `ESC pause (once a level)`; Esc
  froze the server tick at 148 across two seconds, a second Esc resumed it, a third was refused;
  sword and maw both visibly larger after Reach, with no arc.

## Tiered piercing, a stack cap, weaker cover — and a pause bug I shipped

### The pause froze the server and not the screen

`ArenaScene.asteroidLeadSec()` returns `(now - snapshotAt)/1000 + rtt/2`. While paused the server
sends no patches, so `snapshotAt` stops moving while the wall clock does not, and the lead grows
without bound — **sewage slid across the arena at full speed on a stopped server.** It returns 0
while `net.pausedBy !== ""`.

Remote players needed nothing: `sampleRemote` interpolates *between* snapshots and clamps at the
newest, so they stop on their own. Only asteroids extrapolate forward without limit.

**Why the probe missed it, and what replaced it.** Last pass's pause probe asserted the server's
chunk positions did not move. They did not — that half was correct and is still correct. The bug
was entirely in the drawing, which no server-side probe can see. The replacement compares
*screenshots* of the canvas, and runs a **control first**: the same interval without pausing.
That control matters more than the assertion. The first version of this check clipped a
700×300 slice of arena and both the control and the paused case came back byte-identical — with
eight chunks in a 1600×1200 arena, that window had nothing moving in it and the check could not
have failed. Over the whole canvas: **control 100% of bytes differ, paused 0.00%.**

Anything whose symptom is on screen needs a check that looks at the screen, and any such check
needs a control proving it can fail.

### Piercing is a tier

`PerkMods.piercing` → `pierceCount: number`, the hits an arrow *survives*. Zero is consumed by
the first chunk; three reaches four. Measured against a corridor of chunks: 1 / 2 / 3 / 4.

`Projectile.pierce` → `pierceLeft`, stamped at spawn and decremented where the arrow used to be
spliced. Both are server-only and undecorated, so **`Infinity` is a legal value** and is what
Windrunner and Arrow Storm use — capping a once-per-level ultimate was a nerf nobody asked for.
A bow whose tuning says `consumedOnHit: false` also gets `Infinity`, preserving that override.

**A probe trap worth remembering**: the first run had every "unlimited" case stopping at exactly
6, which looked like a pierce bug and was a `maxRange` bug in the probe — the corridor of chunks
was longer than the bow could shoot. The probe now throws if the corridor exceeds the range,
rather than silently measuring the wrong thing.

### Stacking perks cap at three

`MAX_STACKS = 3`, enforced in `offerPool`, which every consumer already goes through — `rollOffer`,
`dealOffers`, the card screen. Flags stay once-only. Verified across 300 seeds × 3 characters ×
40 levels: no perk ever offered a fourth time.

Salvage's own stacking (`8 → 4 → 1`) means three stacks is a repair every chunk. That is the cap
working, not a bug.

### Masons is deleted, and it never worked

`m.repairCover` was set by the perk and **read by nothing** — it appeared only in `perks.ts`, in
the field, the default and the `apply`. `startLevel` rebuilds on `restarting ||
repairableBetweenLevels || coverRebuildsEachLevel` and never consulted it. So Masons was an inert
card for its whole life, and this deleted dead code rather than a working perk.

Cover now comes back only through Consecrate's Ramparts and Bedrock, and Salvage.

### Cover has half the hit points

`hut.hp` 120 → 60, `wall.hp` 85 → 42. A wall now dies in 14 Large hits instead of 29, a hut in
20 instead of 40.

**The 8-seed `hitcheck` baseline is unchanged at 16.0/16 cover standing, and that is the metric
being blind rather than the change doing nothing.** Three idle players over 45s never destroy a
structure at either hp, so a count of survivors cannot see it. If cover erosion needs measuring,
`hitcheck` has to report total structure hp lost, not how many reached zero.

### The attack-range circle: nothing left to remove

`drawSwing` went last pass. Grepping every `strokeCircle`, `strokeRect` and `lineBetween` in
`ArenaScene` finds no range indicator: a player gets the body outline at the hitbox radius, the
dash ring at `r+5`, the carrying ring at `r+9`, four cooldown arcs at `r+7`, an aim line, and —
if they took Verdant — its heal ring, which the designer has said to keep. A perkless Druid
screenshotted mid-bite shows only the body outline and the arcs.

### Verified

- `npm run verify` — `0.000000px`.
- **Pierce/stack probe**: tiers 1/2/3/4; Windrunner and Arrow Storm 15 of 15; `consumedOnHit:
  false` 12 of 12; every stacking perk drops out at exactly 3 and not before; flags still once;
  `masons` and `repairCover` both gone.
- **Pause, in a browser**: control 100% byte difference, paused 0.00%, with 11 chunks on screen.
- **Soak**: 3 bots, zero errors.

## Boss fights: the Clog at 10, the Wellspring at 20

> **Superseded in part.** The Wellspring was replaced by **the Gullet** — see "The Gullet replaces
> the Wellspring at level 20" near the end of this file. Everything here about the Clog, the
> difficulty slider, party health scaling and the skip button still stands; the Wellspring's own
> section does not. Kept because the rulings table and the vacuous-pass notes are still the record
> of why a boss is its own entity.

Levels named in `boss.levels` replace their waves with one enormous thing. The level is won by
killing it and lost if the timer runs out with it alive, so `boss.durationSec` replaces
`level.durationSec` there. Both are still milestone levels, so they still pay an ultimate
upgrade — level 20 is the last one a build ever gets. A wipe restarts the run exactly as any
level does, which was a deliberate decision and therefore no code.

### A boss is its own entity, and that is the whole design

Making it a third asteroid tier would have been far less code — melee, arrows, the grapple and
every ultimate would have found it for free. **That is exactly why not.** `Devour` calls
`removeById` on everything `within` its radius and would have deleted a boss outright;
`Reckoning` would have flung it backwards out of the arena; the throne bubble would have bounced
it away. Nine ultimates say "every chunk", and a separate `Boss` turns each of those into a
ruling somebody had to write:

| | |
| --- | --- |
| Devour, Reckoning, grapple anchor | **Damage.** Never remove, never reverse |
| Throne bubble | Does not reflect it |
| Cathedral | **Does hold the Clog** while the shell stands. It still sheds, so the shell buys time rather than safety |
| Slow the Storm | Slows it. It is sewage |

Every one is asserted individually in the probe, because they are the cases the cheap
implementation would have got wrong silently.

### The DM's difficulty slider

`state.bossDifficulty`, synced, set by a `dm:difficulty` message with the same sender check
`dm:start` uses and clamped on both write and read. It scales **the Clog's speed**, **the
Wellspring's healing**, and **both bosses' health**.

Health follows the slider live, and the **fraction** is what is preserved rather than the number:
a party that has taken a boss to half stays at half when the DM eases off, and only the totals
come down. Rescaling `hp` to keep the absolute value would either hand back progress or delete
it, and the bar would jump either way — which is precisely what makes a live control unreadable.
`Boss.baseMaxHp` holds the pre-slider value so the recompute cannot compound itself every tick,
and `hp` is floored at 1 while alive so a slider drag is never what kills a boss.

**`BossSystem` reads it every tick rather than sampling it at spawn** — that is what makes it
live. Measured: 0.5× / 1× / 2× moved the Clog 51 / 102 / 204px over three seconds, and changing
it mid-fight took the same boss from 34px/s to 102px/s.

It lives in `#dm-live`, **outside `#dmpanel`**, because the panel is hidden while a level runs
and a boss slider you cannot reach during the boss fight would be useless. The handle is
corrected from synced state every frame except while the DM has hold of it, or an arriving
snapshot would snap it out from under their finger.

### Boss health scales with the party

The `hp` values in tuning are **for one player**; `boss.hpPerExtraPlayer` adds that much of the
base again for each additional player, so at 1 the Clog is 2400 / 4800 / 7200 for one, two and
three. A boss built to be a real fight for three would otherwise be an impossible wall for one.

**Fixed at spawn, not tracked live.** A health bar whose maximum moves when somebody joins or
quits mid-fight cannot be read at all. Floored at one player, or an empty room — which the bot
soak and every probe start as — would spawn a zero-health boss that dies to the first arrow.

### Skip to next boss

A testing button in `#dm-live`, DM-only, working from `nextBossLevel` in `src/shared/boss.ts` —
shared so the button's label cannot promise a level the server would not actually go to. It
wraps past the last boss, so it keeps working on a deep run.

Two paths, because it is useful in both places. Pressed while the room is waiting, it retargets
the level about to begin. Pressed mid-level it arms `forcedNextLevel`, which the level end
honours.

**Two things about it are load-bearing and both were found by running it, not by reading it:**

- **`forcedNextLevel` is consumed in `startLevel`, not in `endLevel`.** `awaitStart` runs between
  the two and sets `pendingLevel` itself, so a skip applied and cleared in `endLevel` was silently
  overwritten a moment later. The browser showed the button arming correctly and the run going to
  level 2 anyway. The probe missed it because it called `endLevel` and `startLevel` directly and
  never went through the intermission; it now drives `advanceIntermission` as well.
- **A wipe skipped away from still counts as a restart.** `startLevel` takes "fresh run" from
  `level <= 1`, so skipping a wipe to level 10 would have left the players who just died lying
  dead through the boss they were sent to fight. `restartOnNextStart` covers it. Skipping away
  from a *win* keeps the build, which is what you want when testing with perks.

### The Clog

Enters from an edge aimed at the town, sheds a chunk from its wake on a timer, speeds up and
sheds faster below half health. Arriving, it razes the nearest standing building every
`razeSec`; an empty town loses the level.

Its radius is **136** — 272px across, four times a Large chunk and wider than two huts. That has
to stay an even diameter: `pixels.ts` bakes the sprite at `radius * 2 / PIXEL` art pixels, and an
odd number would put the art on a half-pixel grid while every other sprite in the game sits on
whole ones.

**While razing it steers toward the nearest standing building rather than stopping.** The first
version gated movement on `!razing`, so it parked on the town's edge the moment it arrived and
read as having got stuck on something. Steering keeps it moving and makes the building it is
coming for next obvious. The Cathedral still holds it — that check is on `blocked`, not on
whether it is razing.

**It only pulls down what it is touching.** The first version razed the *nearest standing*
building with no distance test at all, so a Clog in one corner flattened houses clean across the
town. `touching()` measures to the box surface with `pointToBoxDistance`, the same way sewage and
melee measure it, so "touching" means what it looks like. While travelling between buildings the
raze timer **resets rather than banks**, or it would arrive with a raze already owed and take one
the instant it made contact.

`AsteroidSystem.spawnAt` is new and separate from `spawn()` on purpose: `spawn` is the wave
system's — it picks an edge, aims at the town, and is throttled by the spawn interval. What a
boss sheds is somebody else's chunk on somebody else's schedule.

### The Wellspring

Sits in the town square and pumps. **Heals `healPerStructureLost` × difficulty whenever a
building is destroyed** — hooked on the transition to zero in `damageStructure`, not on damage,
so chipping a wall feeds it nothing. There is no "unkillable" state: a team that lets the town go
simply cannot out-damage the healing, which is the mechanic rather than a rule.

### Two vacuous passes caught while writing the checks

Both worth remembering, because both looked like passes:

- **The Slow-the-Storm assertion measured 1px against 0px and passed.** The helper it used parks
  the boss on top of the player, which is inside the town, so it was already razing and standing
  still — a boss that never moves is trivially "slowed". Rewritten to keep it out in the ring and
  assert it actually travelled first: 68px → 17px, exactly 0.25×.
- **The browser driver photographed an empty arena.** The Clog spawns `radius + 40` *outside* the
  wall, so screenshotting on arrival at level 10 gets a full health bar and no boss. It now waits
  until the boss is inside the arena bounds. Same driver later reported "SLIDER DID NOT CHANGE THE
  CLOG" when the slider was working perfectly — it had arrived and started razing, which stops it
  moving. It now says so instead of failing.

### Verified

- `npm run verify` — `0.000000px`.
- **Boss probe**: levels 10 and 20 spawn a boss and 9/11/19/21 do not; melee lands in reach and
  not at 900px; the phase flips at exactly half; zero health wins; razing takes one building per
  interval and an empty town loses; the timer with it alive loses; the Wellspring heals 0 on a
  scratch and exactly `healPerStructureLost` on a loss, doubling at 2×; a kill pays
  `perBossKill` through the level multiplier; and every ruling in the table above.
- **Soak**: 3 bots, zero errors.
- **Raze/scale probe**: with a 136 radius it destroys the building it is sitting on (0px) and
  leaves one 428px away standing; travelling to a building and arriving does not raze on contact,
  it waits a full interval; an empty town still loses. Health is 1200/2400/4800 at 0.5×/1×/2× and
  composes with the party (three players at 0.5× is 3600); dragging 2× → 0.5× on a half-killed
  boss took it from 2400/4800 to 600/1200, holding 50% exactly; the slider at its floor leaves it
  alive.
- **Clog probe**: health 2400/4800/7200 for one, two and three players and 3000/6000/9000 for the
  Wellspring; an empty room gets the one-player value; two players joining mid-fight leave `maxHp`
  where it was. While razing it moves a steady 34px/s where it used to sit at 0, closes on the
  nearest building, gets through a six-building town, and is still held by the Cathedral.
- **Skip probe**: the target from levels 1/9/10/15/20/30 is 10/10/20/20/10/10; pressed while
  waiting it retargets immediately; pressed mid-level it survives `endLevel` *and* `awaitStart`;
  a player pressing it is refused; a wipe skipped away from arrives alive with a cleared build,
  a win skipped away from arrives with the build intact.
- **Browser**, two processes: the DM's live strip is on screen *during* play, the Clog appears at
  level 10 at 2400/2400 with its health bar, its hitbox outline lands on the sprite edge with `H`
  on, and dragging the DM's slider took it from 34.6px/s to 86.7px/s on the player's screen. The
  skip button read "Skip to next boss (level 10)", armed to "Skipping to level 10", landed the run
  on level 10 with the Clog, and a second press from there armed level 20. A razing Clog moved
  115/3/82/68/24px per 1.2s on screen and took the town from 16 buildings to 14 — the 3px sample
  is a turn toward a new target, not a stall. At radius 136 its hitbox outline still lands exactly
  on the sprite edge, checked with `H` on.

## Winning the run, and a pixel font at last

### Beating level 20 ends the run

`OUTCOME_VICTORY`, another value on `outcome` so it inherits the world freeze and the hidden
timer bar like every other one. `isFinalBossLevel` in `src/shared/boss.ts` decides it from the
last entry in `boss.levels`, so a third boss level later needs no new logic.

The final level is **scored first**, so the number on the banner includes the boss they just put
down. No perks are dealt — there is no level left to spend them on — and the banner holds for
`level.victoryHoldSec` before the room queues a fresh run at level 1, which is the wipe path with
a better feeling attached.

### The banner is the bitmap font this file has wanted for a long time

A 5×7 glyph set (A–Z, 0–9, and a little punctuation) baked one glyph at a time in `pixels.ts`,
white so it can be tinted. The outcome banner was the last smoothly-antialiased thing in a game
made of hard 2px squares, and it was the one screen anybody would sit and look at.

**Baked per glyph rather than per string on purpose.** The banner rolls a rainbow along the word
and runs a sine wave through the letters, and per-letter phase is the whole reason an arcade
victory screen reads as one. A whole-string texture could not do it.

### Movement is 80% of what it was

`characters.*.speed`: 265/235/245 → 212/188/196, exactly 0.8 each. Crawling follows for free
since it is a multiple of `speed` — measured 77px/s against a tuned 78.

### A measurement that was really measuring a wall

The speed probe drove each character flat out from the middle of the arena and compared distance
travelled. All three "measured" 758px however fast they were, because 758px was the distance to
`clampToArena`. Two of the three passed on tolerance anyway. It now starts hard against the west
side. **Any probe that drives a player across the arena has to account for the clamp**, or it is
timing a wall.

### Verified

- `npm run verify` — `0.000000px`.
- **Speed/victory probe**: all three characters at exactly 0.800 of their old speed and covering
  the distance that implies; crawl follows; level 10's boss still ends in an ordinary WON that
  queues level 11 while level 20's ends in VICTORY that queues level 1; the final level is scored
  and pays its boss bonus; no perk cards are dealt; the banner holds for `victoryHoldSec` and the
  new run really is fresh.
- **Browser**: skipped to 10, then 20, killed the Wellspring, and the banner came up — chunky
  "YOU WON!", the rainbow and the wave both visibly moved between two screenshots a beat apart,
  "THE STORM IS BEATEN / FINAL SCORE 37,433" underneath, the DM panel standing down for it.

## Mute that really stops, a HUD for players, and the restart button

### Mute suspends the context; it does not turn it down

`toggleMute` was setting the master gain to zero, which leaves every oscillator running and the
music scheduler queueing notes nobody hears. It now stops the music and calls `ctx.suspend()`,
and resumes on unmute. The gain still moves too, so the first frame after a resume cannot leak.

**Two things had to change with it, and neither is obvious:**

- **`unlock()` is called on every keypress**, since it exists to satisfy the gesture requirement
  and cannot know which press is the first. Without a `!this.muted` guard the very next key after
  `M` resumed the context that `M` had just suspended — silent, because the gain was zero, but
  running, which is exactly the thing being fixed.
- **`ArenaScene` passes `!this.sfx.muted` into `music.update`.** The scheduler is told every frame
  whether it should be playing; stopping it inside `toggleMute` alone would have had it restart on
  the next frame.

### The HUD strip is for players now, and `F3` gets the rest back

It carried fps, rtt, tick, pending commands, prediction error and six toggle states in front of
everybody, all of it developer text. The split is by audience rather than by taste: level, score,
time, wave, hp, lives, whether your pause is spent and how much town is left are always shown;
everything else is behind `showDebug`, off by default.

Nothing was deleted — the diagnostics have caught real bugs and the toggle-state readouts are how
you tell whether `P` or `X` is currently on. `structures` reads as `town` in the visible strip.

### Restart game

`dm:restart` → `ArenaRoom.restartRun`, DM-only with the same sender check `dm:start` uses. It
clears `pausedBy`, `forcedNextLevel` and `restartOnNextStart`, then calls `startLevel(1)` — which
already means "fresh run" everywhere else in the room, so lives, score, perks, ultimates, the town
and everybody's life state all come back on their own. **A restart is the wipe path without the
wipe**, and deliberately not a new one; a second reset routine would drift out of step with the
first the moment anything new became part of a run.

It is a method rather than a closure in the handler, for the reason already in this file: a probe
has to drive the real decision.

**Clearing a live pause is not optional.** `startLevel` does not touch `pausedBy`, so restarting
out of a paused room would have built level 1 and left it frozen, with the countdown stopped and
the only person who could resume it possibly gone.

Two clicks in `dmPanel`, arming for four seconds and then lapsing. It sits directly under two
buttons that are not destructive, and it throws away a run with no undo.

### Verified

- `npm run verify` — `0.000000px`. Nothing in `src/shared` changed, but the restart goes through
  `startLevel`.
- **Restart probe**, driving the real `restartRun` from a run at level 14 with a build, a spent
  pause, a dead player, a ruined town, an armed boss skip and 42,000 points: everything resets,
  the room lands in `COUNTDOWN`, the tick advances again afterwards, and a player pressing it is
  refused.
- **Browser, two processes.** The audio state went `running → suspended → running` on the CDP
  WebAudio domain, and **stayed suspended through a later keypress** — that is the `unlock` guard,
  and it is the assertion worth keeping. The strip read `level 1 score 0 time 37s wave 1/4 LULL
  2.5s hp 100 lives ●●● pause ready (ESC) town 16/16` with no diagnostics, `F3` brought them back
  and removed them again.
- **The first restart check was vacuous and is worth recording.** It clicked the button on a run
  that was already at level 1 with no score, so "level 1, score 0" afterwards proved nothing. The
  replacement plays level 1 out, takes a perk, arms a boss skip, and only then restarts: level 2 /
  1,500 points / 1 perk / skip armed for 10 → level 1 / 0 / 0 / 0. Same trap as the pause
  screenshot diff and the speed probe that measured a wall.
- **Soak**: 3 bots, zero errors.

## A level never runs with nobody in it

A Dungeon Master alone in a room could start the game. Three ways in, and the
first two were both reachable from the DM screen with no players connected:

- **Pressing Start.** `dm:start` checked the sender and the outcome, and nothing else.
- **Ticking Passive DM.** That drops the `requireDmToStart` gate, and `advanceIntermission`'s
  WAITING branch then started the level with no further test.
- **The last player leaving mid-level.** The room survives an empty player list for as long as a
  DM is still connected, so the level kept running over an empty town.

**The third one could never end.** `checkOutcome` requires `players.size > 0` — a guard that
exists so a fresh room does not lose instantly — which means a level with nobody in it cannot be
won *or* lost. It runs until somebody joins or the DM restarts it.

`canStartLevel()` is the predicate, and it is deliberately about `state.players` rather than about
clients: **the DM does not count and structurally cannot**, because the role was kept out of
`state.players` from the start. That separation is what made this a two-line fix instead of nine.

The other direction is a separate guard in `onLeave`, not the same one, so both were checked
independently. It sets `restartOnNextStart` before parking, because an armed boss skip can
redirect `awaitStart` away from level 1 and `startLevel` reads "fresh run" off the level number —
without it, the next person to arrive would inherit the abandoned run's score.

`restartRun` parks at the start screen rather than starting, when it is pressed in an empty room.
The reset is deferred rather than skipped: `pendingLevel` 1 makes the eventual `startLevel` a
fresh run anyway.

The DM's Start button reads **"Waiting for a player to join"** and is disabled, and the footer
says so too — a server that silently refuses a live-looking button is the same class of problem
as a prompt naming the wrong key.

### Verified

- **Empty-room probe**, driving the real `fixedTick`, `onLeave` and `restartRun`: 600 ticks with a
  passive DM alone stays WAITING; a player joining that room goes COUNTDOWN → PLAYING; Start is
  refused empty and accepted with one player; the last player leaving mid-level parks it and it
  stays parked for 300 ticks; the next arrival gets level 1 at score 0, not the abandoned run.
- **Both guards were disabled in turn to confirm the probe fails without them** — stubbing
  `canStartLevel` to `true` produced 5 failures, disabling the `onLeave` branch produced 3
  (including the abandoned score at 5,000). A guard nobody has watched fail is not verified.
- **The probe's own setup assertions caught it being vacuous first.** Two blocks asserted things
  about a level that had never started, because a fresh harness has an *active* DM holding the
  door and ticking alone leaves it in WAITING. `beginLevel()` exists for that.
- `npm run verify` — `0.000000px`. **Soak**: 3 bots, 150s, no errors — the case worth watching,
  since the soak depends on a room with no DM starting on its own.
- **Browser**: a DM joining an empty room saw a disabled "Waiting for a player to join", clicking
  it anyway left the room on the start screen, and ticking Passive DM still did not start it after
  four seconds. A druid then joined and the level ran — `level 1 score 0 time 42s`.

## The DM's roster

Who is in the room, live, at the top of `#dm-live`. The summary table only
exists *between* levels, so during one the DM could not see who was connected, who was on the
floor, or whether a seat had quietly emptied — and since a level now cannot start without a
player, an empty seat is the difference between a run that proceeds and one that does not.

**Nothing was added to the wire format.** `name`, `character`, `health`, `maxHealth`, `lifeState`,
`skulls`, `carriedBy` and `hasPicked` are all already synced for other reasons, so this is a pure
client-side read — the same stance as every other piece of presentation in the project.

- **Empty seats are drawn**, dimmed, rather than only counted. `1/3` is a number the DM has to
  notice; two grey rows are a shape they cannot miss.
- **The dot is the character's own tuning colour**, the one the cabinet and the sprite already
  use, so a row is identified at a glance rather than read.
- **A downed player shows skull pips, not health.** Health is zero by definition down there;
  skulls are what is actually about to kill them.
- **Health bars use `drawHealthBar`'s 0.5 / 0.25 thresholds**, so they recolour at the same
  points as every other health readout in the game.
- Between levels the condition column flips to `choosing…` for anyone who has not picked — the
  same question the Start button is gated behind.
- Memoised on a key of the fields it renders, like `DmPanel`'s table and `PerkScreen`. `update()`
  runs every frame, and rebuilding this DOM at 60fps is what made this page unresponsive the
  first time.

### Verified

- **Browser, three processes**, reading the rendered DOM rather than the state behind it: an
  empty room shows `0/3` and three open seats; a named warlock joining shows `Gil warlock
  100/100` with a red dot and two seats left; a druid joining makes it `2/3` with a distinct
  violet dot; damage moves the row to `hurt` and the bar to 40%; going down flips it to `down
  ···`; a skull turns it to `down ☠··`; a disconnect drops the row and returns the seat.
- **Two probe assumptions were wrong, not the code.** It expected the warlock at 120/120 —
  `onJoin` has always used `player.startHealth` (100), not the character's `maxHealth`. And the
  temporary `debug:hurt` hook clamped its own damage with a stray `Math.max(1, health - hp)`, so
  the "kill him" step did 1 damage and the downed row was never reached; the run before the fix
  reported the roster broken when it was the probe.
- A temporary `debug:hurt` message and the `window.__net` hook made the downed and skull states
  reachable. **Both are removed**, as the discipline above requires.
- `npm run verify` — `0.000000px`. `npm run build` clean. **Soak**: 3 bots, 120s, no errors.

## One of each seat

Four seats — three fighters and the Dungeon Master — and one occupant each. A seat somebody is
already in is greyed out on the cabinet with their name under it, and the server refuses it
outright.

**The DM chair is a seat like any other and must stay one.** `onJoin` has always refused a second
Dungeon Master (`this room already has a Dungeon Master`), but the button was the one option that
let you click it and find out. `markSeat()` handles all four, and the `.taken` style is keyed on
`#menu button.taken` rather than `.chars button.taken` so it covers the DM's button too.

**A cabinet describing the fighters was tried first and rejected by the designer as clutter.** The
entry screen is meant to be a row of three bright cards, not a spec sheet — do not re-add
descriptions, ultimate lists or role blurbs to it. What was actually wanted was this: the option
you cannot take should not look like an option.

### The check that decides is on the server

`onJoin` looks up `playerByCharacter` and throws. That is the only thing that actually enforces
one-of-each, and it has to be, because the cabinet's information is a matchmaking snapshot that
can be a moment stale and two people can click the same card at the same instant.

The refusal names who has it, and `main.ts` no longer wraps every join error in "Is the server
running?" — that sentence is nonsense for a message the server just spoke.

### The greying-out reads matchmaking metadata, and it has to

The entry screen has not joined anything, so it has **no synced state at all** — this is the one
screen in the game that cannot read `GameState`. `setMetadata({ taken, dm })` publishes the seats
to matchmaking and `client.getAvailableRooms("arena")` reads them back, polled every 2s.
`publishSeats()` is called from every path that changes who is sitting where: a player joining,
the DM joining, and both kinds of leave.

Two consequences worth knowing:

- **A poll, not a feed.** There is no push channel before you join, so a card can be up to two
  seconds stale. That is exactly why the server check exists rather than being redundant.
- **It picks the room a join would land in** — the first with space, which is what Colyseus fills
  before making a new one. With the single room this game normally has, that is the room. If
  matchmaking is unreachable it leaves every card enabled rather than locking a player out of a
  game they might be able to join; the connect attempt then reports the real problem.

The polling stops on join and restarts if the join is refused, so a card you were just refused
does not sit there still looking available.

### Verified

- **Seat probe**, driving the real `onJoin` and `onLeave`: a second druid is refused with a
  message naming Ana, and the room still has one player; the other two characters are unaffected;
  the seat frees the moment its holder leaves; **the DM joining with `character: "druid"` does not
  hold the druid** (the role ignores the character it is sent, and that had to be asserted rather
  than assumed); the published metadata gains and loses entries on join and leave, including the
  DM's; and a garbage character id still falls back to the ranger *and* occupies that seat.
- **Stubbing the guard out produced 7 failures**, so the probe is not vacuous.
- **Browser, three cabinets**: an empty room disables nothing; Ana joining as druid turns that
  card grey and dashed with `Ana` under it while the other two keep their colours; clicking it
  does nothing; a free character still joins; a third cabinet sees two taken; and Ana
  disconnecting brings the druid back with the stale name gone. Screenshot read.
- **The DM chair, same shape**: free and gold with nobody in it; grey, dashed and reading `Gil`
  once he takes it; the three fighters untouched by a DM being present; clicking it does nothing;
  gold again when he disconnects, with the name gone — **and then actually takeable**, which is
  the assertion that separates "greyed out correctly" from "greyed out permanently".
- `npm run verify` — `0.000000px`. `npm run build` clean. **Soak**: 3 bots, 120s, no errors —
  worth watching here, because the bots would now be refused if they picked the same character.

## The Gullet replaces the Wellspring at level 20

The Wellspring was passive twice over — it pumped ordinary sewage from a different origin, and its
healing was something that happened *to* the players rather than something they acted on. It was
also the last thing a run ever showed you.

**The Gullet** is a slavering mouth in the town square that *summons* sewage to itself in dense
patterns and heals off everything that reaches it. For nineteen levels sewage is a thing you
dodge; here it is a thing you have to go out and stop. That inversion is the whole point.

### Patterns are made of straight lines, and that is not a compromise

Chunks are extrapolated client-side along a straight line from the newest snapshot, and that is
exact only because "chunks never accelerate or curve". A homing or curving tribute chunk would
desync and stay desynced.

So **the shape comes from where and when chunks are emitted, never from a curved path** — the
bullet-hell trick, where a rotating emitter firing straight shots traces a spiral. Three patterns,
cycled deterministically:

| | |
| --- | --- |
| **Spiral** | One chunk per step, bearing advanced `turnDeg` each time |
| **Spokes** | `count` chunks at once on even bearings, the set rotated a little per volley |
| **Wall** | A contiguous arc of `count` over `arcDeg`, fired together, the bearing jumping per volley |

**No RNG anywhere in it.** A pattern that is random is not a pattern, and it makes the fight
identical every run the way the seeded town already is. The emitter's bearing carries over between
patterns rather than resetting, so it sweeps continuously instead of snapping.

`stepAsteroid` was not touched, nothing in `src/shared` changed shape, and `npm run verify` is
still `0.000000px`. That is the payoff for the constraint.

### Three numbers that are load-bearing

- **`summonRadius` 700.** `isOutOfPlay` culls at `offscreenMargin * 2` = 160px beyond the arena. A
  700 ring around (800, 600) reaches y = −100 and y = 1300, both inside that. Past ~750 the top
  and bottom of every pattern is deleted the instant it spawns — silently. The probe walks all 360
  bearings and asserts none is culled.
- **`tributeSpeed` 130, its own number.** Tier speed at level 20 is ~400–630px/s after the level
  multiplier, which crosses the ring in about a second: unreadable and impossible to intercept.
  `AsteroidSystem.spawnAt` gained an optional speed override that bypasses the tier range *and*
  the level multiplier; omitting it leaves the Clog's shedding exactly as it was.
- **Peak is 75 chunks against `maxAlive` 90.** `spawnAt` returns silently at the cap, so denser
  patterns would not error — they would just quietly stop arriving. That is the headroom.

### Cover blocks tribute, and the town is eaten alive

Settled with the designer, and it needed no code: `consumedOnWallHit` was already true, so the
town is a shield around the boss's food. Measured — 72 shots fired from the ring: **58 reached it
across open ground against 8 through an intact town.**

Over a full 120s fight the town goes from **16 standing to 0**, so the shield erodes completely
within the fight and the pressure escalates on its own with no phase logic doing it. Consecrate,
Ramparts and Salvage are genuinely powerful for this one level. Players block tribute too, since
`consumedOnPlayerHit` is already true — taking a chunk to deny a heal is a real choice.

Other things that suddenly matter, all by construction: Reckoning reverses tribute *away*, Slow
the Storm buys seconds against everything in flight, Devour eats an incoming arm, and a throne
parked on the Gullet bounces tribute off the shell.

### ⚠ Waves are now off on BOTH boss levels, and level 10 changed

The docs claimed "boss levels replace their waves" from the day bosses were added. **The code
never did it** — `asteroids.update` runs unconditionally, so 10 and 20 ran a boss *on top of* full
waves. For the Gullet that would have been fatal: waves aim at the town centre, which is exactly
where it sits, so it would have healed off chunks nobody summoned and players could not reliably
intercept.

`AsteroidSystem.wavesEnabled` is set in `startLevel`. **This is a real balance change to a Clog
fight that already worked**, measured over a 45s window, 8 seeds, 3 idle players:

```
                       waves on    waves off
chunks spawned            200.0         40.0
peak sewage on screen      28.5          3.9
cover lost (of 16)          8.1          7.5
```

Cover loss barely moved because the Clog's razing was doing nearly all of it. What changed is the
storm around the fight: level 10 is now a duel with the Clog rather than a duel in a downpour.
**Deliberately not retuned** — `clog.shedSec` (1.1) is the knob, and roughly 0.16 would restore the
old on-screen density. That is a separate decision. Levels 1–9 are untouched: `hitcheck` still
reports 0.9 hits, peak 21.6, cover 16.0/16.

### Numbers, and one thing worth knowing about the old boss

`hp` is **1400**, which is 4200 at three players. The probe now prints the party's whole damage
budget so the number is not a guess: ~46.7 dps uninterrupted, ~5600 damage across the 120s — so
4200 leaves headroom for about 117 chunks fed before it becomes unwinnable.

**The Wellspring's 3000 base was 9000 at three players, against that same ~5600 budget.** It was
very likely unkillable by a full party, which may be much of why it felt bad. Not investigated
further; recorded because it is the kind of thing that explains a design complaint.

### Naming

`BOSS_GULLET = "gullet"`. Devour's *upgrade* id is also `gullet` — different namespaces, an
upgrade id is never compared against a boss kind, so there is no runtime conflict, but both carry
a comment because grepping the word finds both.

Sprite radius **72**, a 144px diameter, even as `PIXEL = 2` requires. Teeth are drawn as stacks of
shrinking rows walking inward along each bearing — that is how you get a triangle on a pixel grid
without rotation, which would land on half pixels — and every one is clipped inside the collision
radius by `ellipseIn`, so decoration still never looks bigger than the hitbox.

### Verified

- `npm run typecheck`, `npm run verify` — `0.000000px`, `npm run build` clean.
- **Gullet probe**, driving the real room: patterns emit 1 / 10 / 14 per step, the wall spans
  exactly 90°, the spiral turns exactly 26° per step, all three appear within 60s; every chunk's
  velocity points at the centre to within 0.0000 rad at exactly 130px/s; 0 of 360 ring bearings
  are culled at spawn; a chunk in the mouth is removed and heals exactly `healPerChunk`; one 8px
  outside is left alone; healing clamps at `maxHp`; the slider scales both healing and health
  live; health scales with the party; phase latches at half and survives a heal to full; a kill
  ends the run in VICTORY and the timer with it alive is a LOSS.
- **Stubbing the drink out produced 5 failures**, including the "the control could not have
  failed" guard built into the cover test. The probe is not vacuous.
- **Browser, two processes**: skipped to 10 then 20, the Gullet appeared at 1400/1400 with its bar
  reading `THE GULLET`, the HUD showed `BOSS` instead of a wave counter, 24→41→30 chunks converging
  on screen, and the hitbox outline landed exactly on the sprite edge with `H` on.
- **The first browser heal check was vacuous** — it watched the bar at full health, where healing
  clamps and cannot show. Rewritten to swing at the Gullet for 9s first: `1322 → 1334 → 1382 →
  1400`, climbing in 12s, which is `healPerChunk` exactly.
- **The soak cannot reach level 20 and that is a limitation of the soak.** Bots never aim at a
  boss, so they lose at the Clog every run, even with boss hp dropped to 150. Three bots ran
  clean through level 10 twice with waves suppressed and no errors; the full-length fight is
  covered by a 120s headless run instead — peak 75/90 chunks, 1506 spawned, town 16 → 0, no throw.

## The Clog sheds when it is hit

Every hit has a `hitShedChance` of knocking a chunk loose. Rolled in
`BossSystem.rollHitShed()` and spawned by `hurtBoss`, which was already the single funnel every
source of boss damage goes through — melee, arrows, the grapple anchor, Devour, Reckoning.

**This is what fills the arena now, instead of a flat timer.** Pressure tracks how hard the party
is actually fighting: standing off the Clog keeps the screen clear and costs you the level, and
laying into it buys the damage with sewage. It also answers the density hole that came with
switching waves off, and it answers it in the right place — the flat `shedSec` would have put the
storm back whether or not anybody was fighting.

Measured over 45s, 8 seeds:

```
                          chunks   peak on screen
waves on, idle             200.0             28.5   (before waves were suppressed)
waves off, idle             40.0              3.9   (the hole this fills)
waves off, party fighting  139.5             11.3   (now)
```

The earlier baseline could not see any of this, because it used **idle** players who never
attack — so it had to be re-measured with damage driven on the real party cadence, two melee at
their cooldown plus a bow at half that.

### Two things it must not do

- **The Gullet must never shed on hit.** It sits on top of whatever appears at its own position
  and would swallow it the same tick, healing itself for being attacked. The guard is a kind
  check, and dropping it in a probe run produced **1723 sheds in 5000 hits** — so it is the single
  most load-bearing line in the feature.
- **`hitShedMinSec` is not defensive padding.** Every arrow is its own damage event, so Arrow
  Storm lands 36 on one tick and Windrunner sustains ~90 a second for eight seconds. Without a
  floor one ultimate buries the screen and `spawnAt` starts silently dropping chunks at
  `maxAlive`. At 0.12s a 36-arrow volley sheds **1**, and Windrunner's eight seconds shed 55
  against a ceiling of 67 — so it caps the volleys and barely touches a melee pair at 6.7 hits/sec.

The roll happens **before** the damage is applied, so a killing blow can still spit — the mass is
coming apart, and the last hit is the one most likely to be doing it.

`hitShedTick` is an absolute server tick rather than a countdown, because damage arrives from
outside the boss update and there is no `dt` to subtract there. Same reason `invulnUntilTick` and
`ultEchoTick` are absolute.

### Verified

- **Shed probe**, driving the real `rollHitShed` and `hurtBoss`: 34.5% of 20,000 hits against a
  tuned 35%; a 36-hit tick sheds 1; Windrunner's 8s sheds 55 under a 67 ceiling; **the Gullet
  sheds 0 in 5000 hits**; a dead Clog sheds 0; and a hit through `hurtBoss` really does put a
  chunk in the air with the spawn counters advancing.
- **Dropping the Clog-only guard produced the Gullet failure above**, so that assertion is not
  vacuous.
- `npm run verify` — `0.000000px`. `npm run build` clean.

## Abilities you can see

The Druid's Devour says "the maw opens wide", eats everything within **296px** (474 with Gullet),
and drew nothing at all. Auditing the rest found the gap was much wider.

### What the audit found

Specials were fine — the throne draws its shell at the exact reflect radius, the grapple draws
rope and hook, the swallow draws a ring. **Ultimates were 1 of 9.** Only Cathedral drew anything.
Four (Reckoning, Arrow Storm, Windrunner, Rebirth) had self-evident world effects but nothing
marking the cast; Slow the Storm and Consecrate were partly invisible; **Devour and Grove were
completely invisible** — Grove swallows the whole team for 4s of invulnerability and looked
exactly like eating one ally.

Two cross-cutting finds:

- **No ultimate made a sound or an effect.** `audio.ts` had nothing for them, `EventDiffer` had no
  ultimate event, and **`fired.ultimateFired` was never handled anywhere in the client**. Pressing
  Shift produced an emptying cooldown arc and nothing else — for the once-per-level ability.
- **A dead sync.** `coverReflects` has been `@type("boolean")` since Spires was built, carrying the
  comment *"Synced so the client can draw warded cover differently"*. Nothing ever read it.

### The organising rule

Two categories, so nothing gets missed and nothing gets invented twice:

- **Every ultimate gets a cast moment** — sound, burst in the caster's colour, 120ms shake.
- **Every *durational* ultimate marks its caster for its whole duration.** Cathedral already did;
  Devour, Grove, Slow the Storm and Windrunner now do. The four instant ones need only the cast.

### The cast needed a counter, not a diffed cooldown

`EventDiffer` infers abilities from counters going up, and **nothing existing could carry this**:
`ultTicks` stays 0 for the four instant ultimates, and `ultReady` falls only on the *first* cast —
so an Echo or Rally firing again three seconds later was undetectable either way.

`Player.ultCasts`, one `@type("uint8")`, incremented in `fireUltimate` — already the single funnel
every cast and every echo passes through. Compared with `!==` rather than `>` so the byte wrapping
past 255 still reads as a cast.

**It is emitted for the local player too**, unlike every other ability in `EventDiffer`. Your own
first cast comes from the predictor so it lands on the frame you press it, but an Echo fires with
no input behind it and the predictor cannot know — so the scene drops the duplicate with a 900ms
window, comfortably longer than a round trip and far shorter than Echo's three seconds.

### Devour: one shared radius, then a spinning maw

`devourReach()` moved into `src/shared/ultimates.ts` and both sides call it. Same rule
`throneBubbleRadius` and `cathedralRadiusMul` already follow: the server used to compose it inline
in `tickDevour`, which is exactly how the two drift.

The maw grows to that radius and **spins at 3.5 rev/s**, chewing four times a revolution. The spin
is the honest part: Devour eats in a full circle, so a big mouth pointing along aim would promise a
cone. Whirling it makes the swept area the eaten area, with no extra ring drawn.

**The hinge must not scale, and the first version got this wrong.** Scaling the hinge along with
the jaws flung the mouth out to the rim, where it read as a pink slab orbiting the Druid rather
than a mouth opening from them. The hinge stays at `radius + 5` and only the jaw length scales,
by `(reach - hinge) / MAW_JAW_PX` — 8.5× at 296, 14.1× at 474.

Devour's radius is also now on the `H` overlay. `H` is the contract that shows the truth and
Devour had none to show.

### Verified

- `npm run typecheck`, `npm run verify` — `0.000000px`, `npm run build` clean.
- **Probe**: `devourReach` against what `tickDevour` *actually* eats, found by binary-searching a
  chunk's distance through the real method rather than recomputing the formula — 296.0/296.0 and
  473.6/473.6. `ultCasts` bumps for all nine, bumps again on an Echo while `ultTicks` stays 0
  throughout, and wraps 255 → 0.
- **A shared function makes the agreement test vacuous on its own, and this caught it.** Stubbing
  `devourReach` to return the plain reach left both sides agreeing at 74 vs 74 — the *sanity*
  assertions ("it should be much larger than ordinary reach", "Gullet should grow it") are what
  went red. Worth remembering when testing anything both sides derive from one function.
- **Browser, all twelve cases** through a temporary `debug:ult` hook: every one bumped `ultCasts`,
  Consecrate reported `warded true/false` and Spires `true/true`, Grove swallowed an ally. Two
  frames a beat apart confirm the maw really rotates and chews. Screenshots read. **Hook removed.**
- **The probe's own Echo assertion was wrong first time** — it demanded three distinct cast counts
  when one press produces exactly two, the press and the echo. The data (`1 1 1 1 1 2 2 2 2 2`)
  was right; the expectation was not.
- **Soak**: 3 bots, 420s. The first 160s run reached only level 4 and exercised nothing, because
  ultimates unlock at 5 — the longer run used **nine ultimates across all three classes** with no
  errors. A soak that never reaches level 5 says nothing about this.

## Skip to any level

> **Superseded by the section below.** The two boss buttons became a number box:
> `bossName` and the validation-not-correction stance survive, the buttons do not.

## The DM picks which boss to skip to

One button per boss level instead of a single "next boss". The old one worked from
`nextBossLevel`, so from level 12 it could only ever offer 20 — going back to the Clog to test a
change to it meant restarting the run first.

`skipToBoss(sessionId, level?)` takes the level now. **It still validates**: a level that is not in
`boss.levels` falls back to the next boss rather than being obeyed, so a message cannot send the
run somewhere that is not a boss fight. Omitting the level keeps the old behaviour, which is what
makes the change backwards-compatible with anything still sending the bare message.

The buttons are built from `tuning.boss.levels` and named through `bossKindFor` + `bossName`, so a
third boss level would grow its own button with nothing in `dmPanel` to change, and a button
cannot label itself as the wrong fight.

**`bossName(kind)` is new in `src/shared/boss.ts`** because the display string had already been
copied into the health bar and the difficulty label, and this would have been a third. All three
read it now.

### Verified

- **Skip probe**, driving the real `skipToBoss`: both boss levels are armable from levels 1, 3, 9,
  10, 12, 20 and 24; **asking for 10 from level 12 works**, which is the case the old button could
  not do; non-boss levels (7, 11, 0, −5, 999) are all refused and fall back; omitting the level
  reproduces the old behaviour; pressed while waiting it retargets `pendingLevel`; a player is
  refused; and the run actually arrives — armed 10 lands on the Clog, armed 20 on the Gullet,
  driven through `endLevel` and the intermission where the `awaitStart` bug used to live.
- **Stubbing the choice out produced 11 failures**, including `level 20 spawned "clog"`.
- **Browser**: two buttons reading `Skip to THE CLOG (level 10)` and `Skip to THE GULLET (level
  20)`, neither armed at first; clicking the Gullet armed only it; clicking the Clog moved the
  arming; the run then landed on 20 with the Gullet. Screenshot read.
- `npm run verify` — `0.000000px`. `npm run build` clean.

## Two more sewage types, at levels 5 and 15

Levels used to differ only in speed and density. Two new tiers give a run something new to learn
partway through:

| | |
| --- | --- |
| **crust**, from level 5 | Armoured: two hits, then two Small. Four hits to clear one |
| **bolus**, from level 15 | One hit and it is two **Large**, which split again. Seven hits and four fragments from one spawn |

### The tier pair became a tier table

`Tier` was `0 \| 1` and `tierName` was a ternary. Both are a table now, because two more hard
ternaries in `splitAsteroid`, `spawn` and the sprite lookup is how this rots. Each tier's tuning
block carries its own rules — `hits`, `splitsInto`, `fromLevel`, `weight` — so a decision lives
beside the numbers rather than in a third place.

`weight` + `fromLevel` replaced `spawn.largeChance`.

**`TIERS` order is load-bearing.** `pickTier` walks it, and with `large` first and the two original
weights summing to 1, a level below 5 draws **bit-identical** to the `rng() < largeChance` it
replaced. That is why `hitcheck` still reports 0.9 hits / peak 21.6 / cover 16.0/16 exactly.
Reordering that array would silently reshuffle every seeded run.

### `splitById` became `hitById`, and `hits` had to go on the wire

A hit no longer necessarily breaks anything, so the old name was a lie. It decrements `hits` and
only removes and spawns children at zero.

`Asteroid.hits` is `@type("uint8")` — **synced**, unlike everything else about a tier, because it
is the one thing that varies per chunk and because "why didn't that die?" is the first question the
armoured type provokes. The client swaps to a cracked sprite once it drops.

A chunk that survives is stamped with the swing that hit it, exactly as children are, so one melee
sweep cannot strip both layers. **Arrow Storm's 36 arrows are 36 separate hits and will** — an
ultimate behaving like one, noted rather than guarded.

### Demolition and Barbed were already right; their text was wrong

`resolveAttack` does `if (m.destroyLarge) removeById(target.id)` regardless of tier, so
destroy-outright has always removed whatever it hit. The cards said "Large chunks", which was loose
before and would have been actively wrong from level 15. **The text changed, not the code.**
Doubling was the one genuinely Large-only rule and now reads "anything with a `splitsInto`".

### Measured, because the chain was the risk

`hitcheck` gained a per-level sweep. Idle players, 8 seeds, 45s:

```
  level   hits   peak/90  cover      alive at the end, by tier
      1    0.9    21.6   16.0/16     large 3.5  small 4.1     <- the recorded baseline, unmoved
      5    2.1    21.8   16.0/16     large 1.5  small 3.6  crust 1.0
     15    4.6    24.1   14.4/16     large 1.4  small 1.9  crust 1.1  bolus 1.0
     20    7.9    30.5   11.3/16     large 1.9  small 1.6  crust 1.8  bolus 1.3
```

**Idle players never break a bolus, so those peaks cannot see the chain at all.** Driven with three
players swinging at their real rates instead: peak **5.4 → 14.4 → 48.1 → 58.5** at levels 1/5/15/20,
against a `maxAlive` of 90. So attacking a bolus field genuinely fills the screen, and still does
not hit the cap. Not tuned in this pass.

Worth noting for the long-standing cover-erosion question: cover finally moves at high levels —
14.4/16 at 15 and 11.3/16 at 20, where it was 16.0/16 everywhere before.

### Verified

- `npm run verify` — `0.000000px`. `npm run build` clean.
- **`hitcheck` is the regression gate and it reproduced level 1 exactly**, down to the per-player
  health strings.
- **Tier probe**: every diameter even; 200k draws per level give 44.9/55.1 below level 5, no crust
  before 5, no bolus before 15, both present after; a crust survives hit one with `hits` down and
  gives two Small on hit two; a bolus gives two Large; the whole chain is 7 hits ending in 4 Small
  at 1.322× its speed; one swing cannot double-hit a survivor; every tier breaks into what its
  tuning says; `removeById` takes a crust and a bolus outright.
- **Forcing `tierHits` to 1 produced 3 failures.** Note the printed summary line was *identical*
  either way — the assertions did the work, not the output.
- **Browser**: all five sprites in a row (large, small, crust, cracked crust, bolus), each hitbox
  outline landing exactly on its edge with `H` on; then a real level 15 sampled 14 times over 21s
  saw all four tiers. **The first attempt failed on the sample, not the code** — one snapshot of
  five chunks against a 12.7%-weight tier proves nothing.
- **Soak**: bots never damage a boss, so no soak gets past level 10 while one exists. With
  `boss.levels` temporarily emptied they reached **level 26** with zero errors, which is what
  actually exercises the bolus chains. Every temporary tuning override was restored and checked
  back to its shipped value.

## Skip to a level the DM types

The two boss buttons became a number box and one **Skip**. Boss levels are no longer the only
places worth reaching — level 5 is where the armoured crust starts and 15 where the bolus does —
and a debugging tool should go where you point it.

`dm:skipToBoss` → `dm:skipToLevel`, and `skipToBoss(sessionId, level?)` → `skipToLevel(sessionId,
level)`. Both paths through `endLevel` and `awaitStart` are unchanged; only the target is.

### It refuses rather than corrects

A level outside `1..MAX_SKIP_LEVEL`, a fraction, `NaN`, `Infinity` — all rejected outright, and
importantly **a rejected skip leaves an existing arming alone**. Clamping would have been one line
shorter and wrong: a debugging tool that quietly sends you somewhere other than where you asked is
worse than one that does nothing. The probe asserts the refusal *and* that the previous arming
survives it.

`MAX_SKIP_LEVEL` is 999, well inside `forcedNextLevel`'s uint16, so a typo cannot arm level 40000
and leave the room waiting for it forever.

### The caption says what is at the target

Built from the same tables the game spawns from: `isBossLevel`/`bossName` for a boss, and each
tier's own `fromLevel` for the new sewage — so it reads `(THE GULLET)` at 20, `(crust starts here)`
at 5, `(bolus starts here)` at 15, and nothing at 7. It cannot promise the wrong thing because it
is reading the same numbers the spawner does.

**The number box is never written to from the panel.** It is a field the DM is typing in, and
correcting it from synced state every frame would fight their keystrokes — the same reason the
difficulty slider is left alone mid-drag.

**`nextBossLevel` is deleted.** Nothing needed it once the fallback went, and leaving a function
that nothing calls is what the Masons perk was.

### Verified

- **Skip probe**, driving the real `skipToLevel`: 11 targets from 4 different current levels all
  arm; 0, −1, −50, 1000, 5000, 1.5, `NaN` and `Infinity` are all refused with nothing armed; a
  refused skip leaves an earlier arming intact; pressed while waiting it retargets `pendingLevel`;
  a player is refused; and the run really arrives at 2, 5, 10, 15 and 20 with the right boss (or
  none), driven through `endLevel` and the intermission.
- **Replacing the guard with a clamp produced 9 failures**, which is the assertion that the
  refuse-don't-correct stance is real and not just a comment.
- **Browser**: the caption named the Clog at 10, crust at 5, bolus at 15, the Gullet at 20 and
  nothing at 7; Skip armed 13 and the button read `Armed: 13`; typing 15 and pressing Enter
  retargeted it; the run landed on 15 with crusts alive on screen.
- **The first browser run failed on my own input helper**, not the code — a triple-click select
  left `1013` in the box, the server clamped it to 999, and every caption assertion then
  "failed" while describing 999 perfectly correctly. Set `.value` and dispatch `input` instead of
  typing into a number field.
- `npm run verify` — `0.000000px`. `npm run build` clean.

## Next

The tuning pass described at the top of this file, and playtesting. The boss numbers in
`tuning.json` are first guesses like everything else — in particular Devour does 30/sec against
2400 hit points, which is about 6% of the Clog for a whole ultimate. Mechanics first was a deliberate call; the numbers are waiting — and there are now nine ultimates and 27 upgrades of unswept numbers on top of the 33 perks.

# SHITSTORM

Three-player co-op survival in a ramshackle underdark town. Sewage flies in from off-screen; you dodge it, break it, and hide behind huts.

The folder and the npm package are still called `sewage-storm`, and so is the stuff flying at you. Only the game got renamed.

**This is Milestone 2.** Server-authoritative movement with client-side prediction, a generated town of huts and walls you collide with and slide along, and sewage flying in from off-screen that damages both. No character abilities yet — this milestone exists to answer one question: **is dodging sewage fun?**

## Running it

```bash
npm install
npm run dev
```

Then open **`http://localhost:5173`** in three tabs, pick a character in each. A fourth tab can **Join as Dungeon Master** — a role that does not play: they watch the whole arena, decide when each level begins, and get a summary of it afterwards. With a DM connected nothing starts until they say so; with none, levels start on their own. A DM who only wants to watch can tick **Passive DM**, which leaves their screen exactly as it was but stops levels waiting on them.

Every level opens with a three-second countdown over the rebuilt town, so you can see where you are before the first wave.

**Levels 10 and 20 are boss fights.** At 10 you meet **the Clog** — an enormous mass grinding in from the edge, shedding sewage the whole way. If it reaches the town it starts pulling buildings down one at a time, grinding from one to the next until nothing is left. At 20, **the Wellspring** erupts in the town square and pumps; it heals every time a building falls, so the fight is a race between hurting it and holding the town. Both are won by killing them and lost if the timer runs out first, and both scale their health to the size of the party, so a boss is a real fight for three without being a wall for one. **Kill the Wellspring and the run is over — you have won it**, and the game says so. The Dungeon Master has a **difficulty slider they can drag mid-fight** — it scales the Clog's speed and the Wellspring's healing — and a **Skip to next boss** button that sends the run straight to level 10 or 20, for testing them without playing nine levels first.

| Control | Does |
| --- | --- |
| `WASD` / arrows | Move |
| `Space` | Dash — fires along your movement, or along aim if you are standing still |
| Left mouse | Attack — **hold it** to keep swinging as fast as the cooldown allows. Druid and Warlock sweep a melee arc at the same rate; the Ranger looses an arrow at half that, trading rate for range. Both split Large sewage into two Small and destroy Small. No bonus scales attack speed — a melee weapon grows instead, so a longer sword really does reach further. The Ranger's Windrunner ultimate is the one exception, and it removes the cooldown outright rather than shortening it |
| `Shift` | Ultimate — one enormous ability, once per level, unlocked at level 5 |
| `Esc` | Pause, for everyone. One each per level, and only the player who called it can resume |
| Right mouse or `E` | **While down or dead:** spend one of the party's three shared extra lives and come straight back at full health. Otherwise, special. Warlock's throne roots him, makes him invulnerable, and raises a shell that bounces sewage back out — including at teammates. Ranger plants his feet, fires a hook at the first thing in front of him and hauls himself to it, detonating any sewage it catches. Druid swallows a nearby ally for 5s: they lose all input and come out healed |

Dash, attack, and special each show as an arc around your own player, filling as they come off cooldown and glowing while active. The HUD strip above the canvas carries the level number, the level timer, and the current wave.

Clearing a level offers each surviving player a choice of **three random bonuses** — a shorter cooldown, a wider throne, a maw that holds two people. Numeric ones stack up to three times and then stop being offered; one-off flags are offered once. A wipe clears the lot along with the run. The choice screen shows a draining timer, everything you already hold and what it does, and the controls.

Clear **level 5** and the choice is an **ultimate** instead: one enormous ability, usable once per level, bound to `Shift`. The Warlock raises a cathedral four times the size of his throne, sends the whole storm back the way it came, or rebuilds the town and makes it indestructible. The Ranger looses thirty-six arrows at once through walls, slows every chunk on screen to a crawl, or spends eight seconds firing with no cooldown at all. The Druid opens the maw wide enough to eat the storm and heal the team on it, swallows everybody at once, or stands the fallen back up — including the dead. Levels **10** and **15** offer upgrades to the one you took, two of three by the end.

Surviving the timer clears the level and the next one starts once everybody has chosen. The town is **not** rebuilt between levels — the only things that put cover back are the Warlock's Consecrate ultimate and the Salvage perk, which mends one damaged structure at a time — and nobody is picked up for you — damage to cover and to your team carries forward, which is what makes reviving somebody worth the five seconds. All three down loses the run and restarts it at level one.

A bar across the top of the arena shows how much of the level is left, and the music thins out during a lull and builds back as a wave comes in.

The town sits in the middle of the map with **open ground all the way around it**, and sewage is aimed at the town rather than scattered over the arena. So you have a choice every wave: shelter among the houses, or walk out into the ring and stand in a chunk's path to break it before it lands. Out there you are in the open with nothing to hide behind — the ground is drawn darker so you can see where cover ends.

Sewage arrives in **waves**: a spawn window, then a lull where nothing new comes in. Chunks already in the air keep flying during a lull, so the arena drains rather than snapping clean — the HUD counts the lull down, and judging when it is actually safe to stand still is the point.

Run out of health and you go **down** rather than dying: you crawl at 40% speed, cannot use anything, and show a revive bar with three skull pips. Any sewage that hits you while down spends one skull. A teammate revives you by standing within range for five seconds using nothing at all — moving or using an ability loses progress at twice the rate it was gained. Three skulls and you are dead for good.

The lull between waves is shorter than a revive takes, so picking somebody up unaided is not really on the table. What is: the party shares **three extra lives** for the whole run. Press your special while down — or even after three skulls have killed you — to spend one and come straight back at full health. A panel shows your skulls, what the party has left, and which button to press; it sits at the bottom of the arena and moves to the top if you are lying down there. Spent lives only come back if the run wipes and restarts.

Nobody standing loses the level **once those lives are gone** — while any remain, the storm keeps coming and somebody has to decide to spend one. Anyone still on their feet when the timer runs out wins it.

Two ports **in development**, two jobs. `5173` (Vite) serves the web page — this is the one you open in a browser. `2567` (Colyseus) is the WebSocket game server that page connects to; opening it directly just tells you to go to 5173.

**Deployed, it is one port.** `npm run build` writes the client to `dist/client`, and the server serves it from that same port alongside the WebSocket — so `npm start` is the whole thing running. See "Deploying it" below.

If 5173 does not load, run the two halves in separate terminals so a Vite startup error is not buried in `concurrently`'s interleaved output:

```bash
npm run dev:server
npm run dev:client
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (watch) + client dev server together |
| `npm run bot -- 3` | Spawn 3 headless bots that join and send input |
| `npm run verify` | Determinism check — replays inputs locally and diffs against the server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck, then build the client to `dist/client` |
| `npm start` | Server only, no watcher |

## Deploying it

One process, one port, no reverse proxy and nothing to configure at build time.

```bash
git clone https://github.com/gcastanon/shitstorm.git
cd shitstorm
npm install          # NOT --omit=dev: npm start runs through tsx, a devDependency
npm run build        # typechecks, then writes dist/client
npm start            # serves the game and the WebSocket on 2567
```

Then open `http://your-server:2567/`.

Three things worth knowing:

- **`tuning.json` is read from the working directory**, so run it from the repo root. A service file needs `WorkingDirectory=`.
- **The client finds the server by itself.** The page and the socket share an origin, so `wss:` is used automatically whenever the page came over `https:`. `VITE_SERVER` still overrides it if you want a local client pointed at a remote server.
- **`PORT` is honoured**, and `/health` returns `{"ok":true}` for a load balancer.

For TLS, put any terminating proxy in front and forward everything to 2567 — there is no path splitting to get wrong, because it is all one origin. With Caddy that is two lines:

```
game.example.com {
    reverse_proxy localhost:2567
}
```

Rooms live in memory and fill to 3 players before spilling into a new one *in the same process*. That means one box, no clustering, and a restart drops everyone mid-run.

## Layout

`CLAUDE.md` at the root carries the decision history, gotchas already hit, and open questions. Claude Code loads it automatically; it is worth reading first if you are new to the project.

```
tuning.json          every tunable number, loaded by the server at boot
src/shared/          simulation code both sides run. Never fork this.
  sim.ts             stepPlayer — the one movement function
  structures.ts      town layout, AABB collision, seeded PRNG
  asteroids.ts       tiers, splitting, sewage collision math, bubble reflection
  projectiles.ts     straight-line travellers: arrows and grapple hooks
  perks.ts           the 33 level-up bonuses, and the reducer both sides run
  ultimates.ts       9 ultimates and their 27 upgrades, same id-only pattern
  score.ts           the one scoring formula, run by server and client alike
  types.ts           InputCommand wire format, character ids, button bitmask
  tuning.ts          types for tuning.json
src/server/
  index.ts           http + colyseus bootstrap
  ArenaRoom.ts       fixed-step authoritative loop
  GameState.ts       schema synced to clients
  AsteroidSystem.ts  sewage spawning, movement, and what it hits
  BossSystem.ts      the Clog and the Wellspring
  ProjectileSystem.ts  Ranger arrows
  GrappleSystem.ts   hook flight and anchoring; the pull itself is in sim.ts
  SwallowSystem.ts   Druid swallow, passenger parenting, fractional regen
  ReviveSystem.ts    downing, skulls, death, revive progress
  tuningLoader.ts    reads tuning.json from disk
src/client/
  main.ts            character select, connect, boot Phaser
  net.ts             room connection, snapshot buffer, rtt
  predict.ts         local prediction + server reconciliation
  interp.ts          entity interpolation for remote players
  input.ts           keyboard/mouse sampling, and BINDINGS — the one key map
  ArenaScene.ts      rendering, still drawn on exact hitboxes
  events.ts          one-off effect events, diffed from snapshots
  fx.ts              particles and camera shake
  audio.ts           sound, synthesized — no asset files
  music.ts           chiptune that follows the wave, also synthesized
  pixels.ts          8-bit sprites, generated at boot — no asset files either
  perkScreen.ts      the level-up overlay
  dmPanel.ts         the Dungeon Master's summary and start button
src/bot/             headless soak client
src/tools/           determinism verifier
```

It is deliberately a single package rather than a workspace monorepo. At this size the extra `package.json` files and build wiring cost more than they buy; `src/shared` is imported by relative path and both `tsx` and `vite` handle it directly. Split it later if the server ever needs its own deploy artifact.

## How the netcode works

The server ticks at 30Hz and broadcasts at 20Hz. Both rates live in `tuning.json`.

**Fixed timestep.** `setSimulationInterval` fires on a jittery timer, so `ArenaRoom.onSimulate` converts its delta into a whole number of fixed steps and runs `fixedTick` that many times. Nothing in the game may run outside `fixedTick`. The client accumulates the same way when producing input, so both sides step at exactly `1 / tickHz`.

**Prediction and reconciliation.** The client applies each input immediately and keeps it in a pending list. When the server reports the state it produced for sequence N, the client snaps to that state and replays every command after N through the same `stepPlayer`. Because it is literally the same function, a correct client converges to zero error — `npm run verify` asserts exactly this and currently reports `0.000000px`.

**Starved ticks do nothing.** If no command arrived for a player this tick, the server does not advance them. An earlier version stepped them with an empty input to keep coasting smooth, and that put a permanent ~0.002px/tick wedge between server and client because the extra steps aren't in the command stream the client replays. Jitter means some ticks get zero commands and the next gets two; `maxCommandsPerTick` absorbs the catch-up and the end position is identical. Anything in M2+ that must run every tick regardless of input — knockback, asteroid collision, regen — goes outside that loop.

**Collision.** `stepPlayer` integrates, then resolves against structures, then clamps to the arena boundary. Resolution finds the closest point on each box, ejects the circle along that normal, and kills only the velocity component heading into the surface — the tangential component survives, which is what makes players slide along a wall instead of sticking. It runs two passes because ejecting from one box can push you into its neighbour, which happens constantly in corners.

Boxes resolve in array order, so the server's `ArraySchema` order and the client's mirror of it must match. Never sort or filter that list in place.

**Town layout.** The town is a box in the middle of the arena — `townBox` in `src/shared/structures.ts`, sized by `structures.townWidth` / `townHeight` — with open ground all the way around it. `generateLayout` places huts and walls inside that box by rejection sampling from a seeded PRNG (`level.seed`), under two constraints that exist for playability rather than looks: nothing within `spawnClearRadius` of a spawn point, and `minGap` between any two structures.

There is deliberately no arena-edge constraint. `townBox` guarantees the box is inset from the arena by at least `padding + minGap`, so a structure sitting right on the town's edge still cannot pinch a player against the boundary — the ring is in between. That matters because structures resolve before the boundary clamp.

`AsteroidSystem` aims every chunk at the same box, which is what makes the ring worth walking into: sewage converges on the houses, so the open ground is quiet unless you stand in a lane between an arena edge and the town.

The layout is generated on the server and synced. The client could rebuild it from the seed, but then two code paths would have to agree forever, and one authoritative list is cheaper to trust.

**Sewage is not predicted.** Clients extrapolate chunks forward along their straight line from the newest snapshot, by snapshot age plus one-way latency. Chunks never accelerate or curve, so this is exact until one hits something — the only artifact is a chunk drawn slightly past a wall in the frame it dies. This deliberately differs from remote players, who are interpolated 100ms *behind*: drawing sewage in the past while the local player is predicted in the present would mean dodging things that had already hit you.

**Sewage runs outside the input loop.** `AsteroidSystem.update` is called every fixed tick regardless of whether any player sent input. A starved input queue must never stall the world.

**Interpolation.** Remote players render `interpDelayMs` (100ms) in the past so there are always two snapshots to blend between. No extrapolation: at 20Hz it introduces more artifacts than it hides.

**Version resilience.** The client polls `room.state` inside `onStateChange` using `MapSchema.forEach` rather than binding schema `onAdd`/`onChange` callbacks. `forEach` is stable across Colyseus versions; the callback API is not.

### Dependencies and `npm audit`

`npm audit` reports 3 advisories, all in one place: `@colyseus/core` 0.15 pins `nanoid@2.1.11`. **Do not run `npm audit fix --force`** — it upgrades Colyseus to 0.18, which changes the schema callback API and the transport setup, and it would break this scaffold.

The three nanoid advisories all require an attacker-controlled `size` argument (non-integer, negative, or zero). Colyseus calls `generateId()` with no argument at all — 15 call sites, every one of them zero-arg, defaulting to a hardcoded 9. The advisories are unreachable from this codebase.

Two changes were already made to shrink the surface:

- **`@colyseus/core` instead of the `colyseus` meta-package.** The meta-package pulls in `@colyseus/auth`, which drags in `grant` → `jwk-to-pem` → `elliptic` and `request-oauth` → `uuid`. We use none of it. Importing `Server` and `Room` from `@colyseus/core` directly removed 9 advisories and about 50 packages.
- **Vite pinned to `^6.4.3`**, the first release carrying the esbuild fix for the dev-server request advisory. That one was real but dev-only — it let any site you visited while `vite dev` was running read responses from your local server.

The genuine fix for the last three is upgrading to Colyseus 0.17 or 0.18. That's worth doing, but it belongs in its own pass and not while the game logic is still being built. Revisit around M4.

Colyseus is pinned to 0.15.x. The package is CommonJS and Node's ESM named-export detection can't see through it, which is why the project is not `"type": "module"` — `tsx` compiles the server to CJS and `require` works. Vite handles the client independently, so the client is still ESM.

## Debug controls

Shown in the HUD strip above the canvas: fps, rtt, player count, server tick, pending command count, and prediction error in pixels.

| Key | Toggle |
| --- | --- |
| `P` | Client-side prediction. Off = raw server positions, so you can feel the input lag prediction is hiding. |
| `H` | Hitbox outlines and hp readouts on every structure. |
| `X` | Sewage extrapolation. Off = draw chunks at their last received position, which lags behind the player dodging them. |
| `R` | **Debug:** refill your health. Removed in M4 when downed/revive is real. |
| `I` | Interpolation for remote players. Off = 20Hz stepping. |
| `M` | Mute, music and effects together. Both are synthesized at runtime, so there is nothing to load and nothing to miss. |
| `G` | Server ghost — a white outline at the server's authoritative position for your own player. Gaps mean prediction error. |

## tuning.json

One file, every number. The server reads it from disk at boot and sends it to each client on join, so clients never hold their own copy and rebalancing needs a server restart but no rebuild.

Some values are still not read by any code. They are written down so the numbers we agreed on live in one place from day one, and so each milestone adds behavior rather than constants.

Wired up as of M4: everything except two entries. `friendlyFire.*` is satisfied by construction rather than read — sewage hits whoever it touches, and arrows and melee never test players at all — and melee `windupSec` / `activeSec` are unimplemented, so a swing resolves instantly on the press.

## Design rules this scaffold assumes

Recorded so M1 onward doesn't relitigate them.

- **Asteroids.** Two tiers. An attack splits Large into two Small; an attack destroys Small. Asteroids are consumed when they hit a wall or a player, so attacks are the only source of splitting. Children carry a swing id so one sweep can't chain through its own split.
- **Ranger.** Arrow splits Large, consumed on hit, passes through allies and through the throne bubble. Grapple travels to the first solid thing, full cooldown on a miss, cancels if he takes damage, and detonates asteroid anchors outright.
- **Druid.** Melee. Passive slow regen. Swallows one ally for 5s — no input, invulnerable, regenerating; pops out on release or on the Druid's death. Cooldown starts on release, so a full cycle is 20s. Can swallow a downed ally to block skulls, but that doesn't revive them.
- **Warlock.** Melee. Throne roots him, makes him invulnerable, and raises a bubble of 3 player-widths for 3s. The bubble blocks asteroids and reflects them (including onto teammates), lets players and arrows pass, and shelters downed players inside it. Melee reach is far shorter than the bubble radius, so an enthroned Warlock swinging hits nothing — no special case needed.
- **Downed.** 3 skulls to die, any asteroid size counts as 1. Crawl at 40% speed. Revive by standing within range for 5s using no abilities; progress decays at 2x if the reviver breaks off. Skulls reset on revive; revived at half health with 1s of invulnerability.
- **Levels.** Timed, and they get harder as the run goes on: sewage starts at half speed and half frequency at level 1 and climbs with the level number, speed capped so it stays readable. Any player surviving the timer wins the level; nobody standing at the timer loses it. All three downed loses only once the party's extra lives are gone.
- **Score.** One party total for the run. Clearing a level pays `(10 × sewage destroyed + 150 × huts + 50 × walls left standing)`, multiplied by `1 + 0.25 × (level − 1)` — so level 1 pays 1×, level 3 pays 1.5× and level 10 pays 3.25×. A hut is worth three walls: the huts are the town, the walls are cover. The breakdown is shown on the level-clear screen. A wipe ends the run and takes the score with it.
- **Extra lives.** Three, shared by the whole party, for the whole run. Spent by pressing special while downed or dead. Death persists across levels otherwise — that's what gives reviving a payoff — and a life and the Rebirth ultimate are the only two things that undo it.
- **Friendly fire.** Sewage only, including reflected sewage. Arrows and melee pass through allies.

## Roadmap

- **M0 — done.** Netcode skeleton.
- **M1 — done.** Town layout, AABB collision, structure hit points, hitbox rendering.
- **M2 — done.** Sewage spawner, two tiers, splitting, damage to players and structures. **Playtest here.**
- **M3 — done.** Shared ability system (dash predicted, attack, server-side cooldowns, HUD readouts), then Warlock, Ranger, and Druid. **Playtest here.**
- **M4 — done.** Downed, skulls, death, revive, win and lose conditions, waves, level progression, and a cooldown indicator on the player. Every mechanic in the design rules now exists; the numbers behind them are a deliberate later pass.
- **M5 — done.** 8-bit sprites for everything, a weapon per character that shows facing and swings, splatter particles, camera shake, and synthesized sound. All client-side and all generated at runtime: no asset files, and deleting every line of it would leave the game playing identically.

## Known gaps

- No reconnection handling. A dropped client loses its player immediately.
- No server-side input rate limiting beyond a queue cap; a client can still send faster than 30Hz and simply have inputs dropped.
- No lobby or ready-up; `joinOrCreate` fills rooms to 3 and spills into a new one.
- Arena size is fixed at 1600x1200 and the canvas scales to fit, so on a widescreen monitor the game is letterboxed left and right. There is no follow camera by design — everyone, including the Dungeon Master, sees the whole arena at once.

import { GameState, Player } from "./src/server/GameState";
import { AsteroidSystem } from "./src/server/AsteroidSystem";
import { generateLayout, isStanding } from "./src/shared/structures";
import { spawnPoint } from "./src/shared/sim";
import { TIER_NAMES } from "./src/shared/asteroids";
import * as fs from "node:fs";
const base = JSON.parse(fs.readFileSync("tuning.json", "utf8"));

/**
 * Balance sweep. Three players standing still at spawn for a whole level, eight
 * seeds, reporting the numbers the open questions in CLAUDE.md are about.
 *
 * Idle players are the point, not a shortcut: this measures how much sewage
 * reaches a stationary body, which is the upper bound on pressure. Real players
 * move and can now break chunks, so treat every hit figure here as a ceiling.
 *
 * Downing is deliberately not wired in — health simply goes negative-clamped and
 * the body keeps taking hits, because the question being asked is density, not
 * survival.
 */
function trial(t: any, seed: number, seconds: number, level = 1) {
  const state = new GameState();
  const boxes = generateLayout(t);
  const sys = new AsteroidSystem(t, state, seed);
  const dt = 1 / t.net.tickHz;

  // Which tiers spawn is a function of the level, so the sweep has to say which
  // one it is measuring. Level 1 draws exactly what it always drew.
  state.level = level;

  for (let i = 0; i < 3; i++) {
    const p = new Player();
    const sp = spawnPoint(i, t);
    p.sessionId = `p${i}`; p.x = sp.x; p.y = sp.y;
    p.health = p.maxHealth = t.player.startHealth;
    state.players.set(p.sessionId, p);
  }

  let hits = 0, firstHitSec = -1, peak = 0;
  const hitsByWave: number[] = [];
  const ev = {
    onStructureHit: (id: string, d: number) => { const b = boxes.find(x=>x.id===id)!; b.hp = Math.max(0,b.hp-d); },
    onPlayerHit: (sid: string, d: number) => {
      const p = state.players.get(sid)!;
      if (p.invulnUntilTick > state.tick) return;
      p.health = Math.max(0, p.health - d);
      p.invulnUntilTick = state.tick + Math.round(t.player.hitInvulnSec * t.net.tickHz);
      hits++;
      hitsByWave[sys.waveIndex] = (hitsByWave[sys.waveIndex] ?? 0) + 1;
      if (firstHitSec < 0) firstHitSec = state.tick / t.net.tickHz;
    },
  };

  // The lull is only a revive window for as long as the arena is actually empty:
  // chunks already in the air keep flying for several seconds after spawning
  // stops. This measures that emptiness directly rather than assuming lullSec.
  let clearTicksThisLull = 0;
  const clearPerLull: number[] = [];
  let wasSpawning = true;

  for (let i = 0; i < t.net.tickHz * seconds; i++) {
    state.tick++;
    sys.update(dt, boxes, ev);
    peak = Math.max(peak, sys.count);

    if (!sys.spawning) {
      if (sys.count === 0) clearTicksThisLull++;
    } else if (!wasSpawning) {
      clearPerLull.push(clearTicksThisLull);
      clearTicksThisLull = 0;
    }
    wasSpawning = sys.spawning;
  }
  if (!sys.spawning) clearPerLull.push(clearTicksThisLull);

  const hp = [...state.players.values()].map(p => p.health);
  const byTier = new Map<number, number>();
  for (const a of state.asteroids) byTier.set(a.tier, (byTier.get(a.tier) ?? 0) + 1);
  return {
    hits, firstHitSec, peak, hp, byTier,
    cover: boxes.filter(isStanding).length, total: boxes.length,
    waves: sys.waveIndex + 1,
    hitsByWave,
    clearSecPerLull: clearPerLull.length
      ? clearPerLull.reduce((a, b) => a + b, 0) / clearPerLull.length / t.net.tickHz
      : 0,
  };
}

const SECONDS = base.level.durationSec;
const runs = [1,2,3,4,5,6,7,8].map(s => trial(base, s, SECONDS));
const avg = (f:(r:any)=>number) => (runs.reduce((a,r)=>a+f(r),0)/runs.length).toFixed(1);

const w = base.waves;
console.log(`3 idle players standing at spawn, ${SECONDS}s level, 8 seeds`);
console.log(`waves: ${w.countPerLevel} x (${w.spawnSec}s spawn + ${w.lullSec}s lull), intensity ${w.intensityPerWave}x per wave\n`);
console.log(`  player hits per level:  ${avg(r=>r.hits)}   ${runs.some(r=>r.hits>0) ? "PASS (damage path fires)" : "FAIL"}`);
console.log(`  first hit at:           ${avg(r=>r.firstHitSec<0?SECONDS:r.firstHitSec)}s`);
console.log(`  peak sewage on screen:  ${avg(r=>r.peak)}`);
console.log(`  waves reached:          ${avg(r=>r.waves)}`);
console.log(`  health left (idle):     ${runs.map(r=>r.hp.join("/")).slice(0,4).join("   ")}`);
console.log(`  cover at end:           ${avg(r=>r.cover)}/${runs[0]!.total}`);

const maxWave = Math.max(...runs.map(r => r.hitsByWave.length));
const perWave = Array.from({ length: maxWave }, (_, i) =>
  (runs.reduce((a, r) => a + (r.hitsByWave[i] ?? 0), 0) / runs.length).toFixed(1));
console.log(`  hits by wave:           ${perWave.join("  ")}`);

console.log(`\n  fully-clear time per lull: ${avg(r=>r.clearSecPerLull)}s of the ${w.lullSec}s lull`);
console.log(`  revive needs ${base.downed.reviveSeconds}s uninterrupted -> unaided revive ${
  Number(avg(r=>r.clearSecPerLull)) >= base.downed.reviveSeconds ? "FITS" : "DOES NOT FIT"} in a clear window`);

/**
 * Across the levels where the tier table changes.
 *
 * Level 1 is the recorded baseline and must not move. 5 brings the armoured
 * crust in and 15 the bolus, whose chain — one becomes two Large becomes four
 * Small — is the thing most likely to disturb `maxAlive`, so peak is printed
 * against that cap rather than on its own.
 */
console.log(`\nby level (8 seeds each, ${SECONDS}s, idle players):`);
console.log(`  level   hits   peak/${String(base.asteroids.spawn.maxAlive).padEnd(3)} cover      alive at the end, by tier`);
for (const level of [1, 4, 5, 14, 15, 20]) {
  const rs = [1,2,3,4,5,6,7,8].map(s => trial(base, s, SECONDS, level));
  const a = (f:(r:any)=>number) => (rs.reduce((x,r)=>x+f(r),0)/rs.length);
  const tiers = TIER_NAMES.map((name, i) => {
    const n = rs.reduce((x, r) => x + (r.byTier.get(i) ?? 0), 0) / rs.length;
    return n > 0.05 ? `${name} ${n.toFixed(1)}` : "";
  }).filter(Boolean).join("  ");
  console.log(
    `  ${String(level).padStart(5)}   ${a(r=>r.hits).toFixed(1).padStart(4)}` +
    `   ${a(r=>r.peak).toFixed(1).padStart(5)}   ${a(r=>r.cover).toFixed(1)}/${rs[0]!.total}` +
    `      ${tiers}`,
  );
}

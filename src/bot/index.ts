import { Client } from "colyseus.js";
import type { Tuning } from "../shared/tuning";
import { BTN, CHARACTER_IDS } from "../shared/types";

/**
 * Headless load/soak client. Three browser tabs will never catch the crashes a
 * bot spamming input for ten minutes will, so this exists from M0 onward.
 *
 *   npm run bot -- 3        # spawn 3 bots
 */
const ENDPOINT = process.env.SERVER ?? "ws://localhost:2567";
const COUNT = Number(process.argv[2] ?? 1);

async function spawnBot(i: number) {
  const client = new Client(ENDPOINT);
  const character = CHARACTER_IDS[i % CHARACTER_IDS.length];
  const room = await client.joinOrCreate("arena", { character, name: `bot-${i}` });

  const tuning = await new Promise<Tuning>((resolve) => {
    room.onMessage("tuning", (t: Tuning) => resolve(t));
  });

  console.log(`bot-${i} joined ${room.roomId} as ${character}`);

  // Bots must pick, or every level after the first stalls at the level-up gate
  // until the timeout fires — which would make the soak test a test of the
  // timeout rather than of the game.
  room.onStateChange((state: any) => {
    const me = state.players?.get(room.sessionId);
    if (!me || me.hasPicked || !me.offer || me.offer.length === 0) return;
    const pick = me.offer[Math.floor(Math.random() * me.offer.length)];
    if (pick) room.send("perk:pick", pick);
  });

  let seq = 1;
  let target = randomDir();
  let ticksLeft = 0;
  /** Ticks left in the current held-attack burst. */
  let attackTicks = 0;

  const interval = setInterval(() => {
    if (ticksLeft-- <= 0) {
      target = randomDir();
      ticksLeft = 10 + Math.floor(Math.random() * 40);
    }
    // Mash all three abilities. The server resolves attacks through the same
    // arc sweep a real player uses, so this soaks the split path under load.
    //
    // Attack is held in bursts rather than tapped, because holding is how a real
    // player attacks now and the repeat path is the one worth soaking.
    if (attackTicks > 0) attackTicks--;
    else if (Math.random() < 0.04) attackTicks = 20 + Math.floor(Math.random() * 60);

    let buttons = 0;
    if (Math.random() < 0.02) buttons |= BTN.DASH;
    if (attackTicks > 0) buttons |= BTN.ATTACK;
    if (Math.random() < 0.01) buttons |= BTN.SPECIAL;
    // Rare on purpose: it is once per level, so pressing it often would only
    // soak the rejected path. This is here so a soak past level 5 actually
    // fires the things it just handed out.
    if (Math.random() < 0.004) buttons |= BTN.ULTIMATE;

    room.send("input", {
      seq: seq++,
      move: target,
      aim: Math.random() * Math.PI * 2,
      buttons,
    });
  }, 1000 / tuning.net.tickHz);

  room.onLeave((code) => {
    clearInterval(interval);
    console.log(`bot-${i} left (code ${code})`);
  });

  room.onError((code, message) => console.error(`bot-${i} error ${code}: ${message}`));
}

function randomDir() {
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

(async () => {
  for (let i = 0; i < COUNT; i++) {
    await spawnBot(i).catch((e) => console.error(`bot-${i} failed:`, e.message));
    await new Promise((r) => setTimeout(r, 150));
  }
})();

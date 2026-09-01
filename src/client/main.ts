import Phaser from "phaser";
import { Client } from "colyseus.js";
import { NetClient } from "./net";
import { ArenaScene } from "./ArenaScene";
import { CHARACTER_IDS } from "../shared/types";
import { renderControls } from "./input";

/**
 * Where the game server is.
 *
 * In a build, the server serves this page, so the WebSocket is the same origin:
 * same host, same port, and `wss:` whenever the page came over `https:`. That is
 * what lets a deployment be one process on one port with nothing configured at
 * build time — and it fixes the trap where a page served over HTTPS silently
 * refused a hardcoded `ws://` as mixed content.
 *
 * Under `vite dev` the page is on 5173 and the server is not, so that one case
 * has to be told. VITE_SERVER still overrides both, for pointing a local client
 * at a remote server.
 */
const ENDPOINT = import.meta.env.VITE_SERVER ?? (
  import.meta.env.DEV
    ? `ws://${location.hostname}:2567`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`
);

const menu = document.getElementById("menu")!;
const status = document.getElementById("status")!;
const nameInput = document.getElementById("name") as HTMLInputElement;

// From BINDINGS, not typed out in the HTML: a cabinet that names the wrong
// button is the bug this project already shipped once.
renderControls(document.getElementById("menu-controls")!);

for (const id of CHARACTER_IDS) {
  const btn = document.querySelector<HTMLButtonElement>(`button[data-char="${id}"]`);
  btn?.addEventListener("click", () => start(id));
}

/**
 * Grey out the seats somebody is already sitting in.
 *
 * One of each: three fighters, three seats, and one Dungeon Master. `onJoin`
 * refuses all four cases — this is the part that stops you finding out by being
 * refused.
 *
 * It has to come from **matchmaking metadata**, because the entry screen has not
 * joined anything yet and so has no synced state to read. That makes it a
 * snapshot rather than a live feed, which is why it is polled, and why the
 * server still checks.
 */
const lobby = new Client(ENDPOINT);
let seatTimer: ReturnType<typeof setInterval> | undefined;

interface Seats {
  taken?: Record<string, string>;
  /** The Dungeon Master's name, or "" when that chair is empty. */
  dm?: string;
}

async function refreshSeats() {
  let seats: Seats = {};
  try {
    const rooms = await lobby.getAvailableRooms("arena");
    // The room a join would land in. Colyseus fills an existing room before
    // making a new one, so for the single room this game normally has, this is
    // exactly it — and when there is no room at all, nothing is taken.
    const room = rooms.find((r) => r.clients < r.maxClients);
    seats = (room?.metadata as Seats) ?? {};
  } catch {
    // No server, or matchmaking is unreachable. Leave every card enabled rather
    // than locking the player out of a game they might be able to join; the
    // connect attempt will report the real problem.
    return;
  }

  const taken = seats.taken ?? {};
  for (const id of CHARACTER_IDS) {
    markSeat(document.querySelector(`button[data-char="${id}"]`), taken[id]);
  }
  // The DM chair is one seat like any other, and the room refuses a second one
  // with "this room already has a Dungeon Master" — so it greys out the same way
  // rather than being the one option that lets you click it and find out.
  markSeat(document.querySelector('button[data-role="dm"]'), seats.dm);
}

/** Grey a seat out and name its occupant, or hand it back. */
function markSeat(btn: HTMLButtonElement | null, who: string | undefined) {
  if (!btn) return;
  btn.disabled = !!who;
  btn.classList.toggle("taken", !!who);
  // The name answers "why can't I click this" in one word. Anything longer
  // belongs somewhere that is not a select button.
  let tag = btn.querySelector("small");
  if (who) {
    if (!tag) { tag = document.createElement("small"); btn.appendChild(tag); }
    tag.textContent = who;
  } else if (tag) {
    tag.remove();
  }
}

void refreshSeats();
seatTimer = setInterval(refreshSeats, 2000);

// The Dungeon Master does not pick a character; the character sent alongside is
// ignored by the server for this role.
document
  .querySelector<HTMLButtonElement>('button[data-role="dm"]')
  ?.addEventListener("click", () => start("ranger", "dm"));

async function start(character: string, role?: "dm") {
  // Nothing to poll for once you are in, and a stray refresh would fight the
  // arena for the buttons it no longer owns.
  if (seatTimer) { clearInterval(seatTimer); seatTimer = undefined; }
  menu.classList.add("hidden");
  // The cabinet has the title on it in letters six inches high, so the small
  // page header only earns its place once the cabinet is gone.
  document.querySelector("h1")?.classList.remove("hidden");
  status.textContent = `connecting to ${ENDPOINT}…`;

  const net = new NetClient();
  try {
    await net.connect(ENDPOINT, character, nameInput.value.trim(), role);
  } catch (err) {
    // A refusal the server actually spoke is not "is the server running?" — the
    // commonest one now is somebody taking your character a moment before you.
    const msg = (err as Error).message ?? "";
    status.textContent = /taken|full|Dungeon Master/i.test(msg)
      ? msg
      : `could not connect: ${msg}. Is the server running?`;
    menu.classList.remove("hidden");
    // Whatever just happened, the seats have moved. Show that immediately
    // rather than leaving the card you were refused looking available.
    void refreshSeats();
    seatTimer ??= setInterval(refreshSeats, 2000);
    return;
  }

  status.textContent = "";

  // Arena size comes from the server's tuning, so the canvas is sized after join.
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: net.tuning.arena.width,
    height: net.tuning.arena.height,
    backgroundColor: "#0b1120",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    // pixelArt turns off texture smoothing so a 2x-scaled sprite stays crisp
    // instead of blurring; roundPixels stops entities sitting at fractional
    // world positions from shimmering between pixels as they move.
    render: { pixelArt: true, roundPixels: true },
  });

  // Added after boot so the scene receives the connected client as init data.
  game.scene.add("arena", ArenaScene, true, { net });

  window.addEventListener("beforeunload", () => net.dispose());
}

import Phaser from "phaser";
import { NetClient } from "./net";
import { ArenaScene } from "./ArenaScene";
import { CHARACTER_IDS } from "../shared/types";
import { renderControls } from "./input";

const ENDPOINT = import.meta.env.VITE_SERVER ?? `ws://${location.hostname}:2567`;

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

// The Dungeon Master does not pick a character; the character sent alongside is
// ignored by the server for this role.
document
  .querySelector<HTMLButtonElement>('button[data-role="dm"]')
  ?.addEventListener("click", () => start("ranger", "dm"));

async function start(character: string, role?: "dm") {
  menu.classList.add("hidden");
  // The cabinet has the title on it in letters six inches high, so the small
  // page header only earns its place once the cabinet is gone.
  document.querySelector("h1")?.classList.remove("hidden");
  status.textContent = `connecting to ${ENDPOINT}…`;

  const net = new NetClient();
  try {
    await net.connect(ENDPOINT, character, nameInput.value.trim(), role);
  } catch (err) {
    status.textContent = `could not connect: ${(err as Error).message}. Is the server running?`;
    menu.classList.remove("hidden");
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

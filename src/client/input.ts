import { BTN } from "../shared/types";

/**
 * The one place a key or mouse button is tied to an ability.
 *
 * Declared as data rather than buried in a chain of ifs so it can be asserted:
 * `npm run verify` checks these bindings and fails if a key ends up on two
 * abilities or an ability loses its binding entirely. A control that silently
 * does the wrong thing is close to impossible to spot by reading, and it is not
 * the sort of bug a determinism check would ever catch on its own.
 *
 * Keep the hint text in index.html in step with this.
 */
export interface Binding {
  button: number;
  label: string;
  keys: string[];
  mouse?: "left" | "right";
}

/**
 * Keys that are not abilities, declared here so they are not bare strings
 * scattered through the client.
 *
 * Pause is deliberately not in BINDINGS below. BINDINGS map to the button
 * bitmask, the bitmask travels in the command queue, and pausing is exactly what
 * stops that queue being consumed — an unpause sent that way could never arrive.
 * It goes as a room message instead, which is handled outside the tick loop.
 */
export const KEYS = {
  pause: "Escape",
} as const;

export const BINDINGS: Binding[] = [
  { button: BTN.DASH, label: "dash", keys: ["Space"] },
  { button: BTN.ATTACK, label: "attack", keys: [], mouse: "left" },
  { button: BTN.SPECIAL, label: "special", keys: ["KeyE"], mouse: "right" },
  { button: BTN.ULTIMATE, label: "ultimate", keys: ["ShiftLeft", "ShiftRight"] },
];

/**
 * How to say a binding out loud, for prompts shown to the player.
 *
 * Derived from BINDINGS rather than written out beside it, so a prompt telling
 * somebody which button to press cannot drift away from the button that
 * actually does the thing — the same reason `buttons()` reads the table instead
 * of duplicating it. `npm run verify` asserts the table itself.
 */
export function bindingLabel(button: number): string {
  const b = BINDINGS.find((x) => x.button === button);
  if (!b) return "?";

  const pretty = (code: string) =>
    code.startsWith("Key") ? code.slice(3)
    : code.startsWith("Digit") ? code.slice(5)
    : code === "Space" ? "SPACE"
    : code.replace(/(Left|Right)$/, "").toUpperCase();

  const parts = b.keys.map(pretty);
  // Duplicates are real: Shift binds ShiftLeft and ShiftRight, and "SHIFT or
  // SHIFT" is not a helpful thing to read.
  const seen = [...new Set(parts)];
  if (b.mouse) seen.push(`${b.mouse} mouse`);
  return seen.join(" or ");
}

/**
 * The controls, as pairs of what to press and what it does.
 *
 * Built from BINDINGS rather than written out beside it, for the reason this
 * project learned the hard way: Shift dashed for weeks while the docs said it
 * cast the special, and the only possible detector was somebody playing the
 * game and being surprised. A control's description has to come from the table
 * that decides what the control does. `npm run verify` asserts the table.
 *
 * Movement is not in BINDINGS — it is read straight off WASD in moveVector —
 * so it is stated separately here rather than invented into the table.
 */
export function controlPairs(): Array<[string, string]> {
  // One input per action, not the full list: "E OR RMB" is noise on a strip
  // meant to be read at a glance. The mouse button wins when there is one,
  // because that is the one a player reaches for. `bindingLabel` still gives the
  // complete mapping wherever the whole truth is wanted.
  const primary = (button: number) => {
    const b = BINDINGS.find((x) => x.button === button);
    if (!b) return "?";
    if (b.mouse) return b.mouse === "left" ? "LMB" : "RMB";
    return bindingLabel(button).split(" or ")[0]!.toUpperCase();
  };

  return [
    ["WASD", "move"],
    ["MOUSE", "aim"],
    [primary(BTN.ATTACK), "attack"],
    [primary(BTN.SPECIAL), "special"],
    [primary(BTN.DASH), "dash"],
    [primary(BTN.ULTIMATE), "ultimate"],
    // Not in BINDINGS — see KEYS above for why — so it is stated here by hand.
    ["ESC", "pause (once a level)"],
  ];
}

/** The same pairs as DOM, for the entry screen and the level-up screen. */
export function renderControls(into: HTMLElement) {
  into.replaceChildren(...controlPairs().map(([key, what]) => {
    const el = document.createElement("span");
    el.className = "ctl";

    const k = document.createElement("b");
    k.textContent = key;
    const w = document.createElement("i");
    w.textContent = what;

    el.append(k, w);
    return el;
  }));
}

/** Raw keyboard/mouse state, sampled once per fixed step into an InputCommand. */
export class InputSampler {
  private keys = new Set<string>();
  private mouseDown = false;
  private rightDown = false;
  pointer = { x: 0, y: 0 };

  attach(canvasHost: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    canvasHost.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.rightDown = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightDown = false;
    });
    canvasHost.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  isDown(code: string) {
    return this.keys.has(code);
  }

  wasPressedOnce(code: string) {
    if (!this.keys.has(code)) return false;
    this.keys.delete(code);
    return true;
  }

  moveVector() {
    let x = 0, y = 0;
    if (this.isDown("KeyA") || this.isDown("ArrowLeft")) x -= 1;
    if (this.isDown("KeyD") || this.isDown("ArrowRight")) x += 1;
    if (this.isDown("KeyW") || this.isDown("ArrowUp")) y -= 1;
    if (this.isDown("KeyS") || this.isDown("ArrowDown")) y += 1;
    return { x, y };
  }

  /** Sample the bitmask straight from BINDINGS, so there is one mapping, not two. */
  buttons() {
    let b = 0;
    for (const bind of BINDINGS) {
      if (bind.keys.some((k) => this.isDown(k))) b |= bind.button;
      else if (bind.mouse === "left" && this.mouseDown) b |= bind.button;
      else if (bind.mouse === "right" && this.rightDown) b |= bind.button;
    }
    return b;
  }
}

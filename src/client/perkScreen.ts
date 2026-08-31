import { perkById } from "../shared/perks";
import { isUltimateChoice, ultimateById, upgradeById } from "../shared/ultimates";
import { OUTCOME_WON } from "../shared/types";
import { formatScore } from "../shared/score";
import { renderControls } from "./input";
import type { NetClient } from "./net";

/**
 * Ultimates and upgrades ride the same offer pipeline as perks, so an offered
 * id may come from any of the three pools and the card has to look in all of
 * them rather than assuming which level it is.
 */
const defFor = (id: string) => perkById(id) ?? ultimateById(id) ?? upgradeById(id);

/**
 * The level-up screen.
 *
 * A DOM overlay rather than something drawn in the canvas, matching how
 * character select already works: real buttons, real focus handling, real
 * hover, none of it rebuilt inside Phaser.
 *
 * It renders from synced state and sends one message. The server decides what
 * was offered and validates the pick, so nothing here is trusted — a client
 * asking for a perk it was not shown is simply ignored.
 */
export class PerkScreen {
  private root = document.getElementById("levelup")!;
  private cards = document.getElementById("lu-cards")!;
  private title = document.getElementById("lu-title")!;
  private foot = document.getElementById("lu-foot")!;
  private score = document.getElementById("lu-score")!;
  private build = document.getElementById("lu-build")!;
  private timerFill = document.getElementById("lu-timer-fill")!;
  private timerText = document.getElementById("lu-timer-text")!;
  private controls = document.getElementById("lu-controls")!;
  /** The offer currently rendered, so the DOM is rebuilt only when it changes. */
  private rendered = "";
  /**
   * The build list currently rendered. Same memo as the cards, and for the same
   * reason the DM table needed one: update() runs every frame, and rebuilding a
   * list of DOM nodes sixty times a second made the whole page unresponsive.
   */
  private renderedBuild = "";

  constructor(private net: NetClient) {
    renderControls(this.controls);
  }

  /** Returns whether the screen is up, so the canvas banner can stay out of its way. */
  update(): boolean {
    const me = this.net.snapshots.at(-1)?.players.get(this.net.sessionId) ?? null;
    const showing = this.net.outcome === OUTCOME_WON
      && !!me && !me.hasPicked && me.offer.length > 0;

    if (!showing) {
      if (this.rendered !== "") {
        this.rendered = "";
        this.cards.replaceChildren();
      }
      this.root.classList.remove("show");
      return false;
    }

    this.root.classList.add("show");
    // A milestone level offers an ultimate or an upgrade to one instead of a
    // perk, and it is worth saying so — those choices are permanent and much
    // larger than a bonus.
    const big = me!.offer.some(isUltimateChoice);
    this.title.textContent = big
      ? `Level ${this.net.level} clear — choose an ultimate`
      : `Level ${this.net.level} clear — choose a bonus`;

    const key = me!.offer.join(",");
    if (key !== this.rendered) {
      this.rendered = key;
      this.cards.replaceChildren(...me!.offer.map((id) => this.card(id)));
    }

    this.drawTimer();
    this.drawBuild(me!);

    this.foot.textContent = "picked for you if the timer runs out";
    this.score.textContent = this.scoreLines();
    return true;
  }

  /**
   * The choice clock, as a bar that drains rather than a number in small grey
   * text. Colours on the same 0.5 / 0.25 thresholds drawHealthBar uses, so a bar
   * running out reads the same way everywhere in the game.
   */
  private drawTimer() {
    const t = this.net.tuning;
    const left = Math.max(0, (this.net.intermissionEndTick - this.net.serverTick) / t.net.tickHz);
    const frac = t.level.choiceTimeoutSec > 0
      ? Math.max(0, Math.min(1, left / t.level.choiceTimeoutSec))
      : 0;

    this.timerFill.style.width = `${frac * 100}%`;
    this.timerFill.style.background = frac > 0.5 ? "#4ade80" : frac > 0.25 ? "#fbbf24" : "#ef4444";
    this.timerText.textContent = `${Math.ceil(left)}s`;
    this.timerText.style.color = frac > 0.5 ? "#4ade80" : frac > 0.25 ? "#fbbf24" : "#ef4444";
  }

  /**
   * Everything this player is already carrying, with what it does.
   *
   * `defFor` covers all three pools, so a perk, an ultimate and an upgrade all
   * resolve through one lookup and the list does not have to know which is which
   * — only the ultimate's upgrades are treated specially, indented under it so a
   * build reads as one thing rather than a flat pile of names.
   */
  private drawBuild(me: { perks: string[]; ultimateId: string; ultimateUpgrades: string[] }) {
    const ids = [...me.perks, me.ultimateId, ...me.ultimateUpgrades];
    const key = ids.join(",");
    if (key === this.renderedBuild) return;
    this.renderedBuild = key;

    const rows: HTMLElement[] = [];
    rows.push(heading(me.perks.length > 0 || me.ultimateId !== "" ? "Your build" : "Your build — nothing yet"));

    for (const id of me.perks) rows.push(this.buildRow(id, false));
    if (me.ultimateId !== "") {
      rows.push(heading("Ultimate"));
      rows.push(this.buildRow(me.ultimateId, false));
      for (const id of me.ultimateUpgrades) rows.push(this.buildRow(id, true));
    }

    this.build.replaceChildren(...rows);
  }

  private buildRow(id: string, indented: boolean) {
    const def = defFor(id);
    const row = document.createElement("div");
    row.className = indented ? "lu-have lu-have-sub" : "lu-have";

    const name = document.createElement("b");
    name.textContent = indented ? `+ ${def?.name ?? id}` : (def?.name ?? id);
    const text = document.createElement("i");
    text.textContent = def?.text ?? "";

    row.append(name, text);
    return row;
  }

  /**
   * What the level just scored, and why.
   *
   * Read off the components the server stored rather than recomputed here: the
   * town is about to be rebuilt, so a live house count would explain the score
   * with numbers that no longer apply.
   */
  private scoreLines() {
    const s = this.net.lastScore;
    if (s.level !== this.net.level) return "";

    const t = this.net.tuning.score;
    const mul = 1 + t.levelMulStep * Math.max(0, s.level - 1);
    // Counts recovered from the points, so what is shown is arithmetic on the
    // award itself rather than a second count of a town that has since changed.
    const chunks = s.chunks / t.perChunkDestroyed;
    const huts = s.huts / t.perHutStanding;
    const walls = s.walls / t.perWallStanding;

    return [
      `SCORE  ${formatScore(this.net.score)}`,
      ...(s.boss > 0 ? [`boss destroyed  =  ${formatScore(s.boss)}`] : []),
      `${chunks} sewage destroyed  ×${t.perChunkDestroyed}  =  ${formatScore(s.chunks)}`,
      `${huts} huts standing  ×${t.perHutStanding}  =  ${formatScore(s.huts)}`,
      `${walls} walls standing  ×${t.perWallStanding}  =  ${formatScore(s.walls)}`,
      `level ${s.level} bonus  ×${mul}  =  +${formatScore(s.total)}`,
    ].join("\n");
  }

  private card(id: string) {
    const def = defFor(id);
    const btn = document.createElement("button");
    btn.className = "lu-card";

    const name = document.createElement("div");
    name.className = "lu-name";
    name.textContent = def?.name ?? id;

    const text = document.createElement("div");
    text.className = "lu-text";
    text.textContent = def?.text ?? "";

    btn.append(name, text);
    btn.addEventListener("click", () => {
      // Drop the build memo: the pick changes the list, and without this the new
      // perk would not appear until something else happened to change too.
      this.renderedBuild = "";
      // Hide immediately rather than waiting for the round trip; if the server
      // rejects it, the next snapshot puts the screen straight back.
      this.root.classList.remove("show");
      this.net.room.send("perk:pick", id);
    });
    return btn;
  }
}

function heading(text: string) {
  const el = document.createElement("div");
  el.className = "lu-have-head";
  el.textContent = text;
  return el;
}

import {
  BOSS_CLOG, OUTCOME_COUNTDOWN, OUTCOME_LOST, OUTCOME_PLAYING, OUTCOME_WAITING, OUTCOME_WON,
} from "../shared/types";
import { formatScore } from "../shared/score";
import { nextBossLevel } from "../shared/boss";
import type { NetClient, PlayerStats, RemoteSnapshotPlayer } from "./net";

/**
 * The Dungeon Master's screen: what the level cost, and the button that starts
 * the next one.
 *
 * A DOM overlay for the same reason the perk screen and the character select
 * are — a real table and a real button, rather than layout and click handling
 * rebuilt inside Phaser.
 *
 * Shown to the DM only. It appears the moment a level ends and stays up through
 * the waiting phase, so the summary is still readable while the players are
 * choosing their perks.
 */
export class DmPanel {
  private root = document.getElementById("dmpanel")!;
  private title = document.getElementById("dm-title")!;
  private stats = document.getElementById("dm-stats")!;
  private sub = document.getElementById("dm-sub")!;
  private start = document.getElementById("dm-start") as HTMLButtonElement;
  private passive = document.getElementById("dm-passive") as HTMLInputElement;
  private live = document.getElementById("dm-live")!;
  private difficulty = document.getElementById("dm-difficulty") as HTMLInputElement;
  private difficultyValue = document.getElementById("dm-difficulty-value")!;
  private difficultyWhat = document.getElementById("dm-difficulty-what")!;
  private skip = document.getElementById("dm-skip") as HTMLButtonElement;
  private skipWhat = document.getElementById("dm-skip-what")!;
  /** True while the DM has hold of the slider, so synced state does not fight
   *  their drag. Same idea as not clobbering a text field someone is typing in. */
  private dragging = false;
  /**
   * The numbers the table was last built from.
   *
   * update() runs every frame; rebuilding a table of DOM nodes sixty times a
   * second is enough churn to make the whole page unresponsive, which is exactly
   * what it did the first time. Same memo the perk screen uses.
   */
  private rendered = "";

  constructor(private net: NetClient) {
    this.start.addEventListener("click", () => {
      this.start.disabled = true;
      this.net.room.send("dm:start");
    });
    // The server is the authority on this; the checkbox is corrected from synced
    // state every frame below, so a rejected toggle snaps back on its own.
    this.passive.addEventListener("change", () => {
      this.net.room.send("dm:passive", this.passive.checked);
    });

    // Sent on every input event, not on release: the whole point is that the
    // fight changes under the players' feet while the DM is still dragging.
    this.difficulty.addEventListener("input", () => {
      this.dragging = true;
      const v = Number(this.difficulty.value);
      this.difficultyValue.textContent = `${v.toFixed(2)}x`;
      this.net.room.send("dm:difficulty", v);
    });
    for (const e of ["pointerup", "blur", "change"]) {
      this.difficulty.addEventListener(e, () => { this.dragging = false; });
    }

    this.skip.addEventListener("click", () => this.net.room.send("dm:skipToBoss"));
  }

  update() {
    if (!this.net.isDm || this.net.outcome === undefined) return;

    this.updateLiveControls();

    // Hidden while playing, and hidden through the countdown too: those three
    // seconds are when the arena is worth looking at, and a summary table of the
    // level that just ended would be covering it.
    const showing = this.net.outcome !== OUTCOME_PLAYING
      && this.net.outcome !== OUTCOME_COUNTDOWN;
    if (!showing) {
      this.rendered = "";
      this.root.classList.remove("show");
      return;
    }
    this.root.classList.add("show");
    this.passive.checked = this.net.dmPassive;

    const waiting = this.net.outcome === OUTCOME_WAITING;
    this.title.textContent = this.headline();

    const players = [...(this.net.snapshots.at(-1)?.players.values() ?? [])];

    // Rebuild only when a number actually moved.
    const key = players.map((p) => `${p.id}:${Object.values(p.stats).join(",")}`).join("|");
    if (key !== this.rendered) {
      this.rendered = key;
      this.stats.replaceChildren(this.table(players));
    }
    this.sub.textContent = this.footer(players, waiting);

    // Only actually startable once the level is over and the players are done
    // choosing; before that the button would race the perk picks.
    this.start.textContent = `Start level ${this.net.pendingLevel}`;
    this.start.disabled = !waiting;
  }

  /**
   * The slider, which lives outside the panel so it stays reachable during the
   * fight it controls.
   *
   * Corrected from synced state every frame — except while the DM has hold of
   * it, or a snapshot arriving mid-drag would snap the handle out from under
   * their finger.
   */
  private updateLiveControls() {
    this.live.classList.add("show");

    if (!this.dragging) {
      this.difficulty.value = String(this.net.bossDifficulty);
      this.difficultyValue.textContent = `${this.net.bossDifficulty.toFixed(2)}x`;
    }

    const b = this.net.boss;
    this.difficultyWhat.textContent = b
      ? (b.kind === BOSS_CLOG
        ? `THE CLOG — scaling its speed. ${b.hp}/${b.maxHp}`
        : `THE WELLSPRING — scaling its healing. ${b.hp}/${b.maxHp}`)
      : "no boss this level · the Clog's speed · the Wellspring's healing";

    // The target is worked out from the same shared table the server uses, so
    // the label cannot promise a level the skip would not actually go to.
    const target = nextBossLevel(this.net.tuning, this.net.level);
    const armed = this.net.forcedNextLevel > 0;
    this.skip.textContent = armed
      ? `Skipping to level ${this.net.forcedNextLevel}`
      : `Skip to next boss (level ${target})`;
    this.skip.classList.toggle("armed", armed);
    this.skipWhat.textContent = armed
      ? "armed — takes effect when this level ends"
      : (this.net.outcome === OUTCOME_WAITING
        ? "starts that level instead of the queued one"
        : "arms the jump; the current level still has to finish");
  }

  private headline() {
    if (this.net.outcome === OUTCOME_WON) return `Level ${this.net.level} cleared`;
    if (this.net.outcome === OUTCOME_LOST) return `Level ${this.net.level} lost`;
    return this.net.level === this.net.pendingLevel
      ? `Ready — level ${this.net.pendingLevel}`
      : `Level ${this.net.level} done`;
  }

  private footer(players: RemoteSnapshotPlayer[], waiting: boolean) {
    const t = this.net.team;
    const secs = (this.net.tuning.net.tickHz > 0 ? t.lvlTicks / this.net.tuning.net.tickHz : 0).toFixed(0);
    const pending = players.filter((p) => !p.hasPicked).map((p) => p.name);

    // Lives are the party's, not any one player's, so they belong here rather
    // than in the per-player table — that one only records who spent them.
    const total = this.net.tuning.level.extraLives;
    const world =
      `sewage in ${t.lvlChunksSpawned} / destroyed ${t.lvlChunksKilled}` +
      `   cover lost ${t.lvlStructuresLost}` +
      `   waves ${this.net.waveIndex + 1}` +
      `   lives ${this.net.lives}/${total}` +
      `   ${secs}s` +
      `\nscore ${formatScore(this.net.score)}` +
      (this.net.lastScore.level === this.net.level
        ? `  (+${formatScore(this.net.lastScore.total)} this level)`
        : "");

    if (waiting) return `${world}\n${this.net.dmPassive ? "passive — starting on its own" : "ready when you are"}`;
    if (pending.length > 0) return `${world}\nchoosing perks: ${pending.join(", ")}`;
    return world;
  }

  /** One row per player, each cell showing this level with the run total beside it. */
  private table(players: RemoteSnapshotPlayer[]) {
    const rows: [string, (s: PlayerStats) => [number, number]][] = [
      ["damage taken", (s) => [s.lvlDamageTaken, s.runDamageTaken]],
      ["sewage destroyed", (s) => [s.lvlChunksKilled, s.runChunksKilled]],
      ["times downed", (s) => [s.lvlDowns, s.runDowns]],
      ["skulls taken", (s) => [s.lvlSkulls, s.runSkulls]],
      ["revives", (s) => [s.lvlRevives, s.runRevives]],
      ["ultimates used", (s) => [s.lvlUltimates, s.runUltimates]],
      ["lives spent", (s) => [s.lvlLives, s.runLives]],
      ["seconds downed", (s) => [
        Math.round(s.lvlDownedTicks / this.net.tuning.net.tickHz),
        Math.round(s.runDownedTicks / this.net.tuning.net.tickHz),
      ]],
    ];

    const table = document.createElement("table");
    table.className = "dm-table";

    const head = table.insertRow();
    head.appendChild(th(""));
    for (const p of players) head.appendChild(th(`${p.name} (${p.character})`));

    for (const [label, pick] of rows) {
      const tr = table.insertRow();
      tr.appendChild(td(label, false, true));
      for (const p of players) {
        const [lvl, run] = pick(p.stats);
        // Level figure first, run total dimmed beside it.
        tr.appendChild(td(`${lvl}  (${run})`, true));
      }
    }
    return table;
  }
}

function th(text: string) {
  const el = document.createElement("th");
  el.textContent = text;
  return el;
}

function td(text: string, dimRun = false, label = false) {
  const el = document.createElement("td");
  el.textContent = text;
  if (dimRun && !label) el.classList.add("run");
  return el;
}

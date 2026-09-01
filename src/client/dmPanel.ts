import {
  BOSS_CLOG, LIFE_DEAD, LIFE_DOWNED,
  OUTCOME_COUNTDOWN, OUTCOME_LOST, OUTCOME_PLAYING, OUTCOME_VICTORY,
  OUTCOME_WAITING, OUTCOME_WON,
} from "../shared/types";
import { formatScore } from "../shared/score";
import { bossKindFor, bossName, isBossLevel } from "../shared/boss";
import { TIER_NAMES } from "../shared/asteroids";
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
  private skipLevel = document.getElementById("dm-skip-level") as HTMLInputElement;
  private skipWhat = document.getElementById("dm-skip-what")!;
  private roster = document.getElementById("dm-roster")!;
  private rosterCount = document.getElementById("dm-roster-count")!;
  /** What the roster was last built from; see `rendered` below for why. */
  private rosterKey = "";
  private restart = document.getElementById("dm-restart") as HTMLButtonElement;
  private restartArmed = false;
  private restartTimer = 0;
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

    this.skip.addEventListener("click", () => {
      this.net.room.send("dm:skipToLevel", this.skipTarget());
    });
    // Enter in the box does the same thing, because typing a number and pressing
    // return is what anyone will try first.
    this.skipLevel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.net.room.send("dm:skipToLevel", this.skipTarget());
    });

    // Two clicks. It throws away a run in progress with no undo, and it sits
    // directly under two buttons that do not, so a stray click has to not be
    // enough. The arming lapses on its own rather than staying hot.
    this.restart.addEventListener("click", () => {
      if (this.restartArmed) {
        window.clearTimeout(this.restartTimer);
        this.restartArmed = false;
        this.restart.classList.remove("confirm");
        this.restart.textContent = "Restart game";
        this.net.room.send("dm:restart");
        return;
      }
      this.restartArmed = true;
      this.restart.classList.add("confirm");
      this.restart.textContent = "Click again to throw the run away";
      this.restartTimer = window.setTimeout(() => {
        this.restartArmed = false;
        this.restart.classList.remove("confirm");
        this.restart.textContent = "Restart game";
      }, 4000);
    });
  }

  update() {
    if (!this.net.isDm || this.net.outcome === undefined) return;

    this.updateLiveControls();

    // Hidden while playing, and hidden through the countdown too: those three
    // seconds are when the arena is worth looking at, and a summary table of the
    // level that just ended would be covering it.
    // Also stands down for the victory screen — the DM watched them earn it and
    // should get to see it rather than a summary table over the top of it.
    const showing = this.net.outcome !== OUTCOME_PLAYING
      && this.net.outcome !== OUTCOME_COUNTDOWN
      && this.net.outcome !== OUTCOME_VICTORY;
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
    // choosing; before that the button would race the perk picks. An empty
    // room is the other bar: the server refuses to start a level nobody is in,
    // so the button says so rather than being pressed and doing nothing.
    const empty = players.length === 0;
    this.start.textContent = empty
      ? "Waiting for a player to join"
      : `Start level ${this.net.pendingLevel}`;
    this.start.disabled = !waiting || empty;
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

    this.updateRoster();

    if (!this.dragging) {
      this.difficulty.value = String(this.net.bossDifficulty);
      this.difficultyValue.textContent = `${this.net.bossDifficulty.toFixed(2)}x`;
    }

    const b = this.net.boss;
    this.difficultyWhat.textContent = b
      ? (b.kind === BOSS_CLOG
        ? `${bossName(b.kind)} — scaling its speed. ${b.hp}/${b.maxHp}`
        : `${bossName(b.kind)} — scaling its healing. ${b.hp}/${b.maxHp}`)
      : "no boss this level · the Clog's speed · the Gullet's healing";

    this.updateSkips();
  }

  /**
   * The skip box: any level the DM types, not just a boss one.
   *
   * The caption names what is at the target when there is something worth
   * knowing — a boss, or the level a new kind of sewage starts at — built from
   * the same tables the game spawns from, so it cannot promise the wrong thing.
   *
   * The number box is deliberately never written to from here. It is a field the
   * DM is typing in, and correcting it from synced state every frame would fight
   * their keystrokes — the same reason the difficulty slider is left alone while
   * it is being dragged.
   */
  private updateSkips() {
    const armedAt = this.net.forcedNextLevel;
    const typed = this.skipTarget();

    this.skip.classList.toggle("armed", armedAt > 0);
    this.skip.textContent = armedAt > 0 ? `Armed: ${armedAt}` : "Skip";

    const at = armedAt > 0 ? armedAt : typed;
    this.skipWhat.textContent = armedAt > 0
      ? `armed for level ${armedAt}${this.whatIsAt(at)} — takes effect when this level ends`
      : (this.net.outcome === OUTCOME_WAITING
        ? `starts level ${typed}${this.whatIsAt(at)} instead of the queued one`
        : `arms the jump${this.whatIsAt(at)}; the current level still has to finish`);
  }

  /** The level in the box, clamped to what the server will accept. */
  private skipTarget(): number {
    const n = Math.floor(Number(this.skipLevel.value));
    return Number.isFinite(n) ? Math.max(1, Math.min(999, n)) : 1;
  }

  /** " (THE CLOG)" or " (armoured sewage starts here)", or nothing. */
  private whatIsAt(level: number): string {
    const t = this.net.tuning;
    if (isBossLevel(t, level)) return ` (${bossName(bossKindFor(t, level))})`;
    // A tier's own fromLevel, so this cannot drift from what actually spawns.
    // Skipping level 1, where large and small "start" and saying so is noise.
    const starts = TIER_NAMES.filter((name) => {
      const cfg = t.asteroids[name];
      return cfg && cfg.fromLevel === level && cfg.fromLevel > 1;
    });
    return starts.length ? ` (${starts.join(" and ")} starts here)` : "";
  }

  /**
   * Who is actually in the room, live.
   *
   * The summary table below only exists between levels, so during one the DM had
   * no way to see who was connected, who was on the floor, or whether a seat had
   * quietly emptied — and an empty seat is now the difference between a level
   * that can start and one that cannot.
   *
   * Every field it reads is already synced for other reasons; nothing was added
   * to the wire format for this, and nothing here is authoritative.
   */
  private updateRoster() {
    const players = [...(this.net.snapshots.at(-1)?.players.values() ?? [])];
    const seats = this.net.tuning.player.maxPlayers;
    this.rosterCount.textContent = `${players.length}/${seats}`;

    // Same memo as the table: update() runs every frame, and rebuilding DOM at
    // 60fps is what made this page stop responding the first time.
    const key = players
      .map((p) => [p.id, p.health, p.maxHealth, p.lifeState, p.skulls, p.hasPicked,
        p.carriedBy !== "", p.ultReady, p.pauseUsed].join(","))
      .join("|") + `|${seats}|${this.net.outcome}`;
    if (key === this.rosterKey) return;
    this.rosterKey = key;

    const rows = players.map((p) => this.rosterRow(p));
    // Empty seats are drawn too, so "1/3" reads as a shape rather than only as a
    // number the DM has to notice.
    for (let i = players.length; i < seats; i++) rows.push(emptySeat());
    this.roster.replaceChildren(...rows);
  }

  private rosterRow(p: RemoteSnapshotPlayer) {
    const row = document.createElement("div");
    row.className = "dm-p";

    const dead = p.lifeState === LIFE_DEAD;
    const down = p.lifeState === LIFE_DOWNED;
    const frac = p.maxHealth > 0 ? Math.max(0, Math.min(1, p.health / p.maxHealth)) : 0;
    if (dead) row.classList.add("dead");
    else if (down) row.classList.add("downed");
    else if (frac <= 0.25) row.classList.add("bad");
    else if (frac <= 0.5) row.classList.add("hurt");

    // The character's own colour, from tuning — the same one the cabinet and the
    // sprite use, so a row is identifiable at a glance rather than by reading it.
    const dot = document.createElement("span");
    dot.className = "dot";
    const colour = (this.net.tuning.characters as Record<string, { color?: string }>)[p.character]?.color;
    if (colour && !dead) dot.style.background = colour;
    row.appendChild(dot);

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = p.name;
    const cls = document.createElement("i");
    cls.textContent = `  ${p.character}`;
    who.appendChild(cls);
    row.appendChild(who);

    const cond = document.createElement("span");
    cond.className = "cond";
    if (dead) {
      cond.textContent = "dead";
    } else if (down) {
      // Skulls are what actually kills a downed player, so they are the number
      // that matters here — not the health, which is zero by definition.
      const total = this.net.tuning.downed.skullsToDie;
      cond.textContent = `down ${"☠".repeat(p.skulls)}${"·".repeat(Math.max(0, total - p.skulls))}`;
    } else if (p.carriedBy !== "") {
      cond.textContent = "swallowed";
    } else {
      cond.textContent = `${Math.ceil(p.health)}/${p.maxHealth}`;
    }
    row.appendChild(cond);

    // Between levels the useful thing is not health, it is who the room is
    // still waiting on — the same question the start button is gated behind.
    if (this.net.outcome === OUTCOME_WON && !p.hasPicked && !dead) {
      const pick = document.createElement("span");
      pick.className = "cond pick";
      pick.textContent = "choosing…";
      cond.textContent = "";
      row.appendChild(pick);
    }

    if (!dead && !down) {
      const bar = document.createElement("span");
      bar.className = "hp";
      const fill = document.createElement("span");
      fill.style.width = `${frac * 100}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    return row;
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

    // An empty room outranks both. Passive mode does not start a level nobody
    // is in, so saying "starting on its own" there would be a lie the DM would
    // sit and wait on.
    if (waiting && players.length === 0) return `${world}\nnobody is playing — waiting for a player to join`;
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

/** A seat nobody is sitting in. */
function emptySeat() {
  const row = document.createElement("div");
  row.className = "dm-p empty";
  const dot = document.createElement("span");
  dot.className = "dot";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "—";
  const cond = document.createElement("span");
  cond.className = "cond";
  cond.textContent = "open";
  row.append(dot, who, cond);
  return row;
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

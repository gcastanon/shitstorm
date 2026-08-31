import Phaser from "phaser";
import { InputSampler, KEYS, bindingLabel } from "./input";
import { Predictor } from "./predict";
import { sampleRemote } from "./interp";
import { Sfx } from "./audio";
import { EventDiffer, type FxEvent } from "./events";
import { Fx, FX_BLOOD, FX_HEAL, FX_RUBBLE, FX_SEWAGE, FX_SPARK } from "./fx";
import { bakeAll, PIXEL, TEX, weaponStyle } from "./pixels";
import { PerkScreen } from "./perkScreen";
import { DmPanel } from "./dmPanel";
import { applyPerks, meleeSweep, type PerkMods } from "../shared/perks";
import type { AttackTuning } from "../shared/tuning";
import type { NetClient } from "./net";
import { activeMods, fixedDtSec, secToTicks, specialCooldownSec, throneBubbleRadius } from "../shared/sim";
import { cathedralRadiusMul, ultimateMods } from "../shared/ultimates";
import { isStanding, townBox } from "../shared/structures";
import { formatScore } from "../shared/score";
import { TIER_LARGE, tierRadius, type Tier } from "../shared/asteroids";
import {
  BOSS_CLOG, BTN, LIFE_ALIVE, LIFE_DEAD, LIFE_DOWNED,
  OUTCOME_COUNTDOWN, OUTCOME_PLAYING, OUTCOME_WAITING, OUTCOME_WON,
  type CharacterId, type InputCommand,
} from "../shared/types";

/** How long a bow's draw-and-release animation runs. Melee uses attack.activeSec
 *  from tuning; a bow has no equivalent key, so it gets this. */
const RANGED_RECOIL_SEC = 0.12;

/** Level timer bar, in world pixels. Presentation, like the rest of this file's
 *  render constants. */
const TIMER_BAR_H = 6;
const TIMER_BAR_INSET = 4;

/** A bite runs longer than the Druid's 0.12s activeSec purely so it is legible —
 *  a jaw that opens and shuts inside four frames just flickers. It is a ceiling
 *  rather than a fixed length; swingSeconds below cuts it down when the cooldown
 *  is short enough that bites would otherwise overlap. */
const BITE_SEC = 0.24;

/**
 * Shortest an attack animation may be. Windrunner sets attackCdMul to 0, which
 * without a floor here makes swingSeconds return 0 and the progress calculation
 * divide by zero.
 */
const SWING_MIN_SEC = 0.05;

/**
 * How long to draw one attack for.
 *
 * Clamped to the cooldown rather than run at a fixed length, because the fixed
 * length was an invariant waiting to break: the bite was chosen to sit "well
 * under the 0.6s cooldown", and the cooldown has since been halved twice. An
 * animation longer than the gap between attacks means the jaw never finishes
 * shutting before it opens again.
 *
 * The floor is what makes Windrunner safe: its cooldown is a single tick, so
 * without one the animation length would collapse toward zero and the progress
 * calculation would divide by it.
 */
function swingSeconds(styleSec: number, cooldownSec: number, m: PerkMods): number {
  const gap = m.noAttackCooldown ? 0 : cooldownSec;
  return Math.max(SWING_MIN_SEC, Math.min(styleSec, gap * 0.8));
}

/**
 * How much bigger a weapon is drawn for the reach it has.
 *
 * From `meleeSweep` — the same function the server sweeps with — so a sword that
 * looks longer is a sword that hits further, rather than a picture that happens
 * to have grown. This replaced the wire arc that used to explain reach: the tool
 * itself says it now.
 *
 * A weapon is decoration and collides with nothing, which is the only reason it
 * is allowed to deform at all. Note it does break the game's uniform art-pixel
 * size — Reach at 1.25x puts a sword on a 2.5 scale — and that is accepted for
 * weapons alone.
 */
function reachScale(atk: AttackTuning | undefined, m: PerkMods): number {
  if (!atk || atk.kind !== "melee" || atk.reach <= 0) return 1;
  return meleeSweep(atk, m).reach / atk.reach;
}

/** Stable pseudo-angle from an entity id, so per-chunk decoration does not
 *  crawl between frames. */
function idAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return (h / 0xffff) * Math.PI * 2;
}

/** Draw order. Anything that overlaps has to be deliberate about this. */
const DEPTH = {
  outskirts: -1, floor: 0, structure: 1, entity: 2, prop: 2.5, body: 3, weapon: 4, debug: 6,
};

/** Outcome banner text, and the much larger type the countdown uses. */
const BANNER_SIZE = 44;
const COUNTDOWN_SIZE = 120;

/**
 * Keyed sprite pool.
 *
 * Same shape as the `labels` Map that has been in this scene since M0: make one
 * on first sight of an id, drop it when that id stops appearing. Entity counts
 * here are small and bounded — at most 90 chunks, 16 structures, 3 players — so
 * this needs no cleverness beyond not leaking.
 */
class SpritePool {
  private items = new Map<string, Phaser.GameObjects.Image>();
  private used = new Set<string>();

  constructor(private scene: Phaser.Scene, private depth: number) {}

  get(key: string, texture: string): Phaser.GameObjects.Image {
    let img = this.items.get(key);
    if (!img) {
      img = this.scene.add.image(0, 0, texture).setDepth(this.depth);
      this.items.set(key, img);
    } else if (img.texture.key !== texture) {
      img.setTexture(texture);
    }
    img.setVisible(true);
    this.used.add(key);
    return img;
  }

  begin() {
    this.used.clear();
  }

  /** Destroy anything the frame did not ask for. */
  end() {
    for (const [key, img] of this.items) {
      if (this.used.has(key)) continue;
      img.destroy();
      this.items.delete(key);
    }
  }
}

/**
 * Renders the arena.
 *
 * The art is 8-bit sprites baked at boot by pixels.ts, but every sprite is drawn
 * at exactly the size of the thing it represents — bodies at player.radius,
 * structures at their literal collision boxes, sewage at its true radius. `H`
 * still overlays the real hitboxes, and they land on the sprite edges.
 *
 * Debug and UI stay in immediate-mode Graphics: hitboxes, bars, skull pips, the
 * cooldown ring, the throne bubble, the melee arc, the grapple rope. Keeping
 * those vector is what stops the art and the simulation drifting apart.
 */
export class ArenaScene extends Phaser.Scene {
  private net!: NetClient;
  private input2!: InputSampler;
  private predictor!: Predictor;

  private g!: Phaser.GameObjects.Graphics;
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private hud!: HTMLElement;
  private banner!: Phaser.GameObjects.Text;
  private fx!: Fx;
  private sfx!: Sfx;
  private differ!: EventDiffer;
  private perkScreen!: PerkScreen;
  private dmPanel!: DmPanel;

  private seq = 1;
  private accumulatorMs = 0;
  private interpEnabled = true;
  private showServerGhost = false;
  private showHitboxes = false;
  private extrapolate = true;

  private bodies!: SpritePool;
  private weapons!: SpritePool;
  private chunks!: SpritePool;
  private arrows!: SpritePool;
  private structures!: SpritePool;
  /** Things that appear beneath a player for the duration of an ability. */
  private props!: SpritePool;
  private floor!: Phaser.GameObjects.TileSprite;
  private outskirts!: Phaser.GameObjects.TileSprite;
  /** The prompt line inside the downed panel. Hidden whenever you are upright. */
  private downedText!: Phaser.GameObjects.Text;
  /** The boss's name and health, on its bar. Hidden on ordinary levels. */
  private bossText!: Phaser.GameObjects.Text;

  /**
   * In-flight weapon swings, per player.
   *
   * The aim is frozen at the moment of the swing rather than tracked live,
   * because that is the angle the hit actually resolved at — following the
   * mouse would draw the sweep somewhere the damage never went.
   */
  private swings = new Map<string, { startedMs: number; aim: number; ranged: boolean }>();

  /**
   * Derived perk mods per player, memoised on the list they came from.
   *
   * Remote players' perks are synced too, so their reach, arc, throne radius and
   * skull count can be drawn correctly rather than from raw tuning — but folding
   * them every frame for every player would be waste when the list changes once
   * a level.
   */
  private modsCache = new Map<string, { key: string; mods: PerkMods }>();

  constructor() {
    super("arena");
  }

  init(data: { net: NetClient }) {
    this.net = data.net;
  }

  create() {
    const t = this.net.tuning;

    this.input2 = new InputSampler();
    this.input2.attach(this.game.canvas);

    const me = this.currentServerSelf();
    this.predictor = new Predictor(
      (me?.character as CharacterId) ?? "ranger",
      me?.x ?? t.arena.width / 2,
      me?.y ?? t.arena.height / 2,
      t,
    );

    // Character colours are read from tuning so the art cannot disagree with the
    // simulation about who is who.
    bakeAll(this, t.characters, {
      playerDiameter: t.player.radius * 2,
      hut: { w: t.structures.hut.width, h: t.structures.hut.height },
      wall: { w: t.structures.wall.width, h: t.structures.wall.height },
      sewageLarge: t.asteroids.large.radius * 2,
      sewageSmall: t.asteroids.small.radius * 2,
      bossClog: t.boss.clog.radius * 2,
      bossWellspring: t.boss.wellspring.radius * 2,
    });

    // Two grounds, because the ring has to read as a different place. The
    // outskirts run edge to edge and the town paving sits on top at exactly the
    // box structures are placed inside and sewage aims at — one rectangle, from
    // the same shared function all three read, so the ground can never disagree
    // with where the town actually is.
    const town = townBox(t);
    this.outskirts = this.add
      .tileSprite(0, 0, t.arena.width, t.arena.height, TEX.outskirts)
      .setOrigin(0, 0)
      .setTileScale(PIXEL, PIXEL)
      .setDepth(DEPTH.outskirts);

    this.floor = this.add
      .tileSprite(town.x - town.w / 2, town.y - town.h / 2, town.w, town.h, TEX.floor)
      .setOrigin(0, 0)
      .setTileScale(PIXEL, PIXEL)
      .setDepth(DEPTH.floor);

    this.structures = new SpritePool(this, DEPTH.structure);
    this.chunks = new SpritePool(this, DEPTH.entity);
    this.arrows = new SpritePool(this, DEPTH.entity);
    this.props = new SpritePool(this, DEPTH.prop);
    this.bodies = new SpritePool(this, DEPTH.body);
    this.weapons = new SpritePool(this, DEPTH.weapon);

    this.g = this.add.graphics().setDepth(DEPTH.debug);
    this.hud = document.getElementById("hud")!;

    this.fx = new Fx(this);
    this.sfx = new Sfx();
    this.differ = new EventDiffer();
    this.perkScreen = new PerkScreen(this.net);
    this.dmPanel = new DmPanel(this.net);

    // Browsers will not start audio until the page has been interacted with, so
    // the context is created on the first real key or click and not before.
    this.input.keyboard?.on("keydown", () => this.sfx.unlock());
    this.input.on("pointerdown", () => this.sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => this.sfx.toggleMute());

    // Pause. A room message rather than a button bit: the bitmask travels in the
    // command queue, which is exactly what a pause stops the server consuming,
    // so an unpause sent that way could never arrive. The server decides whether
    // the press does anything — one per player per level, and only the player
    // who called it may lift it.
    // A window listener on the declared KeyboardEvent.code rather than Phaser's
    // own key names, which spell Escape "ESC" and would drift from KEYS.pause.
    window.addEventListener("keydown", (e) => {
      if (e.code !== KEYS.pause || e.repeat) return;
      e.preventDefault();
      this.net.room.send("pause:toggle");
    });

    this.banner = this.add
      .text(t.arena.width / 2, t.arena.height / 2, "", {
        fontFamily: "monospace", fontSize: `${BANNER_SIZE}px`, color: "#e2e8f0",
      })
      .setOrigin(0.5)
      .setDepth(10);

    // The prompt inside the downed panel. Built here rather than per frame for
    // the same reason the banner is: a text object created in render() would
    // leak one every frame.
    this.downedText = this.add
      .text(0, 0, "", { fontFamily: "monospace", fontSize: "22px", color: "#e2e8f0" })
      .setOrigin(0.5)
      .setDepth(10)
      .setVisible(false);

    this.bossText = this.add
      .text(0, 0, "", { fontFamily: "monospace", fontSize: "13px", color: "#0b1120" })
      .setOrigin(0.5)
      .setDepth(10)
      .setVisible(false);

    this.input.keyboard?.on("keydown-P", () => {
      this.predictor.enabled = !this.predictor.enabled;
    });
    this.input.keyboard?.on("keydown-I", () => {
      this.interpEnabled = !this.interpEnabled;
    });
    this.input.keyboard?.on("keydown-G", () => {
      this.showServerGhost = !this.showServerGhost;
    });
    this.input.keyboard?.on("keydown-H", () => {
      this.showHitboxes = !this.showHitboxes;
    });
    this.input.keyboard?.on("keydown-X", () => {
      this.extrapolate = !this.extrapolate;
    });
    this.input.keyboard?.on("keydown-R", () => this.net.room.send("debug:heal"));
  }

  override update(_time: number, deltaMs: number) {
    const t = this.net.tuning;
    const dt = fixedDtSec(t);
    const fixedMs = 1000 / t.net.tickHz;

    // The Dungeon Master has no body: nothing to drive, nothing to predict, and
    // no commands to send. Everything below this point is rendering, which they
    // get in full.
    if (!this.net.isDm) {
      // Stop producing while paused. The server is not consuming — its whole
      // tick loop returns before the clock advances — so anything sent now would
      // be predicted locally and never applied, and the player would visibly
      // slide and snap back. Dropping the accumulator too keeps a long pause from
      // firing a burst of catch-up commands the moment it lifts.
      if (this.net.pausedBy !== "") {
        this.accumulatorMs = 0;
      } else {
        // Fixed-step input production, mirroring the server's tick rate exactly.
        this.accumulatorMs += deltaMs;
        let guard = 0;
        while (this.accumulatorMs >= fixedMs && guard++ < 5) {
          this.accumulatorMs -= fixedMs;
          this.produceCommand(dt);
        }
        if (guard >= 5) this.accumulatorMs = 0;
      }

      // Reconcile against the newest authoritative state.
      const self = this.currentServerSelf();
      if (self) this.predictor.reconcile(self, self.lastSeq, dt, this.net.structures);
    }

    this.playFx(this.differ.diff(this.net));

    // The overlay says everything the banner would, and better, so the banner
    // gets out of its way rather than showing through it.
    const choosing = this.net.isDm ? false : this.perkScreen.update();
    this.dmPanel.update();

    // Layers follow the wave, and the whole thing stops once the level is
    // decided so the outcome stingers have the room to themselves.
    this.sfx.music?.update(
      this.net.outcome === OUTCOME_PLAYING,
      this.net.waveSpawning,
      this.net.waveIndex,
    );

    this.draw();
    this.drawHud();
    this.drawBanner(choosing);
  }

  /**
   * Turn diffed events into noise and mess.
   *
   * Sounds are capped per kind per frame. A Large splitting over a wall can end
   * four chunks in one snapshot, and four identical thuds stacked on the same
   * millisecond is not four times the feedback, it is a click.
   */
  private playFx(events: FxEvent[]) {
    const played = new Map<string, number>();
    const canPlay = (kind: string, max = 2) => {
      const n = played.get(kind) ?? 0;
      played.set(kind, n + 1);
      return n < max;
    };

    for (const e of events) {
      switch (e.kind) {
        case "chunkDied":
          this.fx.burst(e.x, e.y, FX_SEWAGE, 12);
          if (canPlay("chunk")) this.sfx.thud();
          break;

        case "arrowDied":
          this.fx.burst(e.x, e.y, FX_SPARK, 5);
          if (canPlay("arrow")) this.sfx.split();
          break;

        case "structureHit":
          this.fx.burst(e.x, e.y, FX_RUBBLE, 5);
          break;

        case "structureDown":
          this.fx.burst(e.x, e.y, FX_RUBBLE, 40);
          this.fx.shake(260, 0.006);
          if (canPlay("down", 1)) this.sfx.structureDown();
          break;

        case "playerHurt":
          this.fx.burst(e.x, e.y, FX_BLOOD, e.self ? 18 : 10);
          // Only your own pain shakes the camera. Everyone's would make a busy
          // wave unreadable.
          if (e.self) this.fx.shake(160, 0.008);
          if (canPlay("hurt")) e.self ? this.sfx.hurt() : this.sfx.splat();
          break;

        case "playerDowned":
          this.fx.burst(e.x, e.y, FX_BLOOD, 26);
          if (e.self) this.fx.shake(320, 0.012);
          if (canPlay("downed")) this.sfx.down();
          break;

        case "playerDied":
          this.fx.burst(e.x, e.y, FX_BLOOD, 34);
          this.fx.flash(140, 60, 0, 0);
          if (canPlay("died")) this.sfx.down();
          break;

        case "playerRevived":
          this.fx.burst(e.x, e.y, FX_HEAL, 22);
          if (canPlay("revived")) this.sfx.revived();
          break;

        case "attack":
          this.beginSwing(e.id, e.aim, e.ranged);
          if (canPlay("attack")) e.ranged ? this.sfx.shoot() : this.sfx.swing();
          break;

        case "dash":
          this.fx.trail(e.x, e.y, FX_SPARK, 5);
          if (canPlay("dash")) this.sfx.dash();
          break;

        case "special":
          if (canPlay("special")) this.playSpecialSound(e.special);
          break;

        case "waveStart":
          this.sfx.waveStart();
          break;

        case "levelStart":
          this.fx.flash(200, 40, 60, 40);
          break;

        case "outcome":
          if (e.won) { this.sfx.levelClear(); }
          else { this.sfx.wiped(); this.fx.shake(600, 0.014); }
          break;
      }
    }
  }

  private playSpecialSound(kind: string) {
    if (kind === "throne") this.sfx.throne();
    else if (kind === "grapple") this.sfx.grapple();
    else if (kind === "swallow") this.sfx.swallow();
  }

  /**
   * Wave and phase. The lull counts down, because that number is the window a
   * revive has to fit inside and the player needs to be able to judge it.
   */
  private waveLabel() {
    const total = this.net.tuning.waves.countPerLevel;
    const shown = Math.min(this.net.waveIndex + 1, total);
    if (this.net.waveSpawning) return `wave ${shown}/${total}`;

    const left = (this.net.wavePhaseEndTick - this.net.serverTick) / this.net.tuning.net.tickHz;
    return `wave ${shown}/${total} LULL ${Math.max(0, left).toFixed(1)}s`;
  }

  private levelSecondsLeft() {
    const left = (this.net.levelEndTick - this.net.serverTick) / this.net.tuning.net.tickHz;
    return Math.max(0, Math.ceil(left));
  }

  /**
   * This player's effective numbers: perks, with a running ultimate layered on
   * top. Your own come from the predictor, which already holds them and is the
   * copy prediction runs against.
   *
   * `activeMods` is the same function stepPlayer composes with, so what gets
   * drawn is what the simulation is using rather than a second guess at it.
   */
  private modsFor(id: string, view: {
    perks: string[]; ultimateId: string; ultimateUpgrades: string[]; ultTicks: number;
  }): PerkMods {
    if (id === this.net.sessionId) return activeMods(this.predictor.state);

    const key = view.perks.join(",");
    const hit = this.modsCache.get(id);
    const base = hit && hit.key === key ? hit.mods : applyPerks(view.perks);
    if (!hit || hit.key !== key) this.modsCache.set(id, { key, mods: base });

    if (view.ultTicks <= 0 || view.ultimateId === "") return base;
    const m = { ...base };
    ultimateMods(view.ultimateId, view.ultimateUpgrades, m);
    return m;
  }

  /** Who the level-up is still waiting for, from the synced hasPicked flags. */
  private waitingOn() {
    const snap = this.net.snapshots.at(-1);
    if (!snap) return "";

    const names: string[] = [];
    snap.players.forEach((p) => { if (!p.hasPicked) names.push(p.name); });
    if (names.length === 0) return "starting next level";
    return `waiting on ${names.join(", ")}`;
  }

  private drawBanner(choosing = false) {
    // Paused beats everything, including a countdown: it is the one state where
    // nothing at all is happening and the reason needs to be on screen.
    if (this.net.pausedBy !== "") {
      const mine = this.net.pausedBy === this.net.sessionId;
      const t = this.net.tuning;
      this.banner.setFontSize(BANNER_SIZE);
      this.banner.setPosition(t.arena.width / 2, t.arena.height / 2);
      this.banner.setText(
        `PAUSED\nby ${this.net.pausedByName || "someone"}\n`
        + (mine ? "ESC to resume" : "only they can resume"),
      );
      this.banner.setColor("#fbbf24");
      this.banner.setAlign("center");
      return;
    }

    // The countdown is the one thing everybody sees, the DM included: their
    // panel hides for it so they can watch the arena fill up.
    if (this.net.outcome === OUTCOME_COUNTDOWN) {
      const t = this.net.tuning;
      const left = (this.net.intermissionEndTick - this.net.serverTick) / t.net.tickHz;
      // Ceil, so the first frame of a 3s countdown reads "3" rather than a "2"
      // nobody had time to see.
      const n = Math.ceil(left);
      // Big, and lifted into the open ground above the town: everybody spawns in
      // the middle, so a number at the arena's centre lands on top of the very
      // players it is counting in.
      this.banner.setFontSize(COUNTDOWN_SIZE);
      this.banner.setPosition(t.arena.width / 2, (t.arena.height - t.structures.townHeight) / 4);
      this.banner.setText(n > 0 ? String(n) : "GO");
      this.banner.setColor(n > 0 ? "#fbbf24" : "#4ade80");
      this.banner.setAlign("center");
      return;
    }

    // Anything else is the ordinary banner, back where it belongs.
    this.banner.setFontSize(BANNER_SIZE);
    this.banner.setPosition(this.net.tuning.arena.width / 2, this.net.tuning.arena.height / 2);

    // The DM's panel already says all of this, and better; the banner would just
    // show through it.
    if (choosing || this.net.isDm || this.net.outcome === OUTCOME_PLAYING) {
      this.banner.setText("");
      return;
    }
    // Waiting to be started is not a result, so it must not fall through to the
    // won/lost wording — it would otherwise read as WIPED.
    if (this.net.outcome === OUTCOME_WAITING) {
      // A passive DM is not being waited for, so naming them would be a lie.
      const held = this.net.dmPresent && !this.net.dmPassive;
      this.banner.setText(
        `LEVEL ${this.net.pendingLevel}\n` +
        (held ? `waiting for ${this.net.dmName}` : "starting"),
      );
      this.banner.setColor("#fbbf24");
      this.banner.setAlign("center");
      return;
    }

    const won = this.net.outcome === OUTCOME_WON;
    const left = Math.max(0, (this.net.intermissionEndTick - this.net.serverTick) / this.net.tuning.net.tickHz);
    const head = won ? `LEVEL ${this.net.level} CLEAR` : "WIPED";
    // On a win the next level waits for everyone's pick, so a countdown would be
    // a lie; say what it is actually waiting for instead.
    const tail = won ? this.waitingOn() : `restarting in ${Math.ceil(left)}s`;
    // What the level was worth, for anyone not looking at a perk card.
    const s = this.net.lastScore;
    const scored = won && s.level === this.net.level
      ? `\n+${formatScore(s.total)}   score ${formatScore(this.net.score)}`
      : "";
    this.banner.setText(`${head}\n${tail}${scored}`);
    this.banner.setColor(won ? "#4ade80" : "#ef4444");
    this.banner.setAlign("center");
  }

  private produceCommand(dt: number) {
    const pointer = this.input.activePointer;
    const aim = Math.atan2(pointer.worldY - this.predictor.state.y, pointer.worldX - this.predictor.state.x);

    const cmd: InputCommand = {
      seq: this.seq++,
      move: this.input2.moveVector(),
      aim,
      buttons: this.input2.buttons(),
    };

    // The swing flash is driven by the predicted step, not by waiting for the
    // server to confirm it. The cooldown is predicted too, so a swing that the
    // server will reject cannot be drawn in the first place.
    const fired = this.predictor.applyLocal(cmd, dt, this.net.structures);
    const me = this.predictor.state;
    const character = this.net.tuning.characters[me.character];

    if (fired.attackFired) {
      const ranged = character?.attack.kind === "ranged";
      // Driven from the predictor rather than the diffed event, so your own
      // swing starts on the frame the button went down.
      this.beginSwing(this.net.sessionId, cmd.aim, !!ranged);
      if (ranged) this.sfx.shoot();
      else this.sfx.swing();
    }
    if (fired.dashStarted) {
      this.sfx.dash();
      this.fx.trail(me.x, me.y, FX_SPARK, 6);
    }
    if (fired.specialFired) this.playSpecialSound(character?.special.kind ?? "");

    this.net.sendInput(cmd);
  }

  private currentServerSelf() {
    const snap = this.net.snapshots[this.net.snapshots.length - 1];
    return snap?.players.get(this.net.sessionId) ?? null;
  }

  private draw() {
    const t = this.net.tuning;
    const r = t.player.radius;
    const g = this.g;
    g.clear();

    this.structures.begin();
    this.chunks.begin();
    this.arrows.begin();
    this.props.begin();
    this.bodies.begin();
    this.weapons.begin();

    // Arena bounds, which is also the movement clamp.
    g.lineStyle(2, 0x334155, 1);
    g.strokeRect(
      t.arena.padding, t.arena.padding,
      t.arena.width - t.arena.padding * 2,
      t.arena.height - t.arena.padding * 2,
    );

    // The town's edge. Fainter than the arena bounds because it stops nothing —
    // it marks where cover ends and where sewage stops being aimed, which is the
    // line you cross when you go out to meet a chunk.
    const town = townBox(t);
    g.lineStyle(1, 0x2b3a52, 0.9);
    g.strokeRect(town.x - town.w / 2, town.y - town.h / 2, town.w, town.h);

    this.drawLevelTimer();

    this.drawStructures();

    this.drawBoss();

    this.drawAsteroids();

    this.drawProjectiles();

    const renderTime = performance.now() - t.net.interpDelayMs;
    const latest = this.net.snapshots[this.net.snapshots.length - 1];
    const seen = new Set<string>();

    if (latest) {
      latest.players.forEach((raw, id) => {
        seen.add(id);
        const isSelf = id === this.net.sessionId;

        const view = isSelf
          ? { ...raw, x: this.predictor.state.x, y: this.predictor.state.y, aim: raw.aim }
          : (this.interpEnabled ? (sampleRemote(this.net.snapshots, id, renderTime) ?? raw) : raw);

        const color = Phaser.Display.Color.HexStringToColor(
          t.characters[view.character]?.color ?? "#94a3b8",
        ).color;

        // Everything below that a perk can change — reach, arc, throne radius,
        // skull count — is drawn from these rather than from raw tuning.
        const mods = this.modsFor(id, view);

        // Overlays that normally belong to your own player. The DM has no player
        // of their own, so they get them for all three.
        const overlay = isSelf || this.net.isDm;

        // Swallowed players are drawn as a passenger inside the Druid rather
        // than as a body of their own. The server parks them on the Druid every
        // tick, so this position is already the Druid's.
        if (view.carriedBy !== "") {
          g.fillStyle(color, 0.9);
          g.fillCircle(view.x, view.y, r * 0.45);
          this.label(id, view.name, view.x, view.y - r - 16);
          return;
        }

        if (isSelf && this.showServerGhost) {
          g.lineStyle(1, 0xffffff, 0.35);
          g.strokeCircle(raw.x, raw.y, r);
        }

        // Flash during the post-hit mercy window so the player can see why
        // sewage is passing straight through them.
        const invuln = view.invulnUntilTick > this.net.serverTick;
        const alpha = invuln && Math.floor(performance.now() / 90) % 2 === 0 ? 0.35 : 1;

        const dead = view.lifeState === LIFE_DEAD;
        const down = view.lifeState === LIFE_DOWNED;
        // Dead reads as grey and gone; downed keeps the character colour so you
        // can still tell at a glance who is worth crossing the arena for.
        const bodyAlpha = dead ? 0.45 : down ? 0.6 : alpha;

        // The shadow is the only part of a player allowed to deform, because it
        // is the only part that is not a hitbox. Downed and dead read as prone
        // through a wide flat one rather than through a smaller body — drawing
        // the body at anything but player.radius would make sewage look like it
        // connected early, and skulls are exactly the wrong thing to lie about.
        const prone = down || dead;
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(view.x, view.y + r * 0.8, r * (prone ? 2.1 : 1.5), r * (prone ? 0.5 : 0.8));

        // The body sprite is a disc baked at exactly the hitbox diameter, so its
        // edge is the collision edge. Rotating it when prone is safe precisely
        // because it is a disc — a rotated circle is the same circle — so the
        // player visibly lies down without the covered area changing at all.
        const body = this.bodies.get(id, TEX.body(view.character));
        body.setPosition(view.x, view.y);
        body.setScale(PIXEL);
        body.setAlpha(bodyAlpha);
        body.setAngle(prone ? 90 : 0);
        if (dead) body.setTint(0x64748b);
        else body.clearTint();

        if (isSelf) {
          g.lineStyle(2, 0xffffff, bodyAlpha * 0.9);
          g.strokeCircle(view.x, view.y, r);
        }

        // Mid-dash ring. Self reads from the predictor so it appears on the
        // frame you press it; remotes read the synced counter.
        const dashing = isSelf ? this.predictor.state.dashTicks > 0 : view.dashTicks > 0;
        if (dashing) {
          g.lineStyle(2, 0xffffff, 0.75);
          g.strokeCircle(view.x, view.y, r + 5);
        }

        // Verdant heals anyone standing close, so show how close is close enough.
        if (mods.verdant && !dead) {
          g.lineStyle(1, 0x4ade80, 0.22);
          g.strokeCircle(view.x, view.y, t.downed.reviveRadius);
        }

        // A Druid with someone inside reads as visibly fuller.
        if (view.swallowedCount > 0) {
          g.lineStyle(3, color, 0.8);
          g.strokeCircle(view.x, view.y, r + 9);
        }

        if (down) {
          this.drawDownedBar(view.x, view.y + r + 6, view.reviveTicks, view.skulls, mods);
        } else if (!dead) {
          this.drawHealthBar(view.x, view.y + r + 6, view.health, view.maxHealth);
        }

        // The dead have dropped their weapon.
        if (!dead) {
          const aimAngle = isSelf ? this.aimAngle() : view.aim;
          this.placeWeapon(id, view.character, view.x, view.y, aimAngle, down ? 0.5 : bodyAlpha, mods);

          // An aim line, not a reach indicator: the melee arc that used to be
          // drawn here is gone, and the weapon's own size is what shows reach now.
          // The Dungeon Master gets it for everybody, which is what "sees what
          // everyone else sees" means when you are watching all three at once.
          if (overlay) {
            g.lineStyle(1, 0xffffff, 0.25);
            g.lineBetween(
              view.x, view.y,
              view.x + Math.cos(aimAngle) * (r + 26),
              view.y + Math.sin(aimAngle) * (r + 26),
            );
          }
        }

        if (overlay && !dead) {
          this.drawCooldownRing(view.x, view.y, r, view.character, mods,
            isSelf ? this.predictor.state : view);
        }

        // Throne shell. Self reads the predicted counter so it appears on the
        // press; remotes read the synced one.
        const specialTicks = isSelf ? this.predictor.state.specialTicks : view.specialTicks;
        if (specialTicks > 0) this.drawThrone(id, view.x, view.y, view.character, color, mods);

        // The Cathedral is the same shell several times over, and the server
        // reflects off it whether or not the throne itself is up.
        const ultTicks = isSelf ? this.predictor.state.ultTicks : view.ultTicks;
        if (ultTicks > 0 && view.ultimateId === "cathedral") {
          this.drawCathedral(view.x, view.y, view.character, color, mods, view.ultimateUpgrades);
        }

        this.drawGrapple(view, view.x, view.y, color);

        this.label(id, view.name, view.x, view.y - r - 16);
      });
    }

    // What to do about being on the floor. Yours alone — the DM has no body to
    // pick up and no button to press, so they get the lives count in their panel
    // instead.
    const self = latest?.players.get(this.net.sessionId);
    if (self && self.lifeState !== LIFE_ALIVE && this.net.outcome === OUTCOME_PLAYING) {
      this.drawDownedPanel(self, this.modsFor(this.net.sessionId, self));
    } else {
      this.downedText.setVisible(false);
    }

    for (const [id, text] of this.labels) {
      if (id.startsWith("hp-")) continue; // owned by drawStructures
      if (!seen.has(id)) { text.destroy(); this.labels.delete(id); }
    }

    // Anything whose id stopped appearing this frame goes away with it — which
    // is also how the throne disappears when the Warlock stands up.
    this.structures.end();
    this.chunks.end();
    this.arrows.end();
    this.props.end();
    this.bodies.end();
    this.weapons.end();
  }

  /**
   * Put a character's weapon in their hand, and animate a swing if one is in
   * flight.
   *
   * The swing is purely cosmetic: the hit resolved on the server the instant the
   * button went down. The sweep is drawn *across* that moment rather than
   * leading up to it, so it never shows a strike that has not landed yet. That
   * is also why activeSec is used for the animation but windupSec is not — a
   * wind-up would draw a delay the simulation does not have.
   */
  private placeWeapon(
    id: string, character: string,
    x: number, y: number, aim: number, alpha: number, m: PerkMods,
  ) {
    const atk = this.net.tuning.characters[character]?.attack;
    const style = weaponStyle(character, atk?.kind ?? "melee");
    const r = this.net.tuning.player.radius;

    // Progress through the current swing, or -1 when idle.
    const swing = this.swings.get(id);
    let p = -1;
    if (swing && atk) {
      const styleSec = style === "bite" ? BITE_SEC
        : style === "recoil" ? RANGED_RECOIL_SEC
        : (atk.kind === "melee" ? atk.activeSec : RANGED_RECOIL_SEC);
      const sec = swingSeconds(styleSec, atk.cooldownSec, m);
      p = (performance.now() - swing.startedMs) / (sec * 1000);
      if (p >= 1) {
        this.swings.delete(id);
        p = -1;
      }
    }

    if (style === "bite") {
      this.placeMaw(id, character, x, y, aim, alpha, p, m);
      return;
    }

    const img = this.weapons.get(id, TEX.weapon(character));
    let angle = aim;
    let reach = r + 4;

    if (p >= 0 && swing && atk) {
      if (style === "swing") {
        // Sweep the full arc the server swept, around the aim it swept it at —
        // so Cleave visibly carries the sword the whole way round, and Reach
        // carries it further out.
        const sweep = atk.kind === "melee" ? meleeSweep(atk, m) : { reach: 0, arcDegrees: 0 };
        const half = (sweep.arcDegrees * Math.PI) / 180 / 2;
        const eased = 1 - (1 - p) * (1 - p);
        angle = swing.aim - half + half * 2 * eased;
        // Lunge scales with reach, so a longer swing visibly extends further.
        reach += Math.sin(Math.PI * p) * r * 0.6 * m.reachMul;
      } else {
        // A bow does not sweep: it draws back and springs forward.
        angle = swing.aim;
        reach -= Math.sin(Math.PI * p) * r * 0.5;
      }
    }

    img.setPosition(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
    img.setRotation(angle);
    img.setOrigin(0.2, 0.5);
    img.setFlipY(false);
    img.setScale(PIXEL * reachScale(atk, m));
    img.setAlpha(alpha);
  }

  /**
   * The Druid's maw: one jaw sprite drawn twice, the lower one flipped, both
   * hinged on the same point so the teeth meet when it shuts.
   *
   * It gapes open fast and snaps closed slowly-looking-fast, which reads as a
   * bite rather than as a mouth opening. Like every other swing animation this
   * is cosmetic — the hit resolved on the press, and the jaws close over the
   * moment it already landed.
   */
  private placeMaw(
    id: string, character: string,
    x: number, y: number, aim: number, alpha: number, p: number, m: PerkMods,
  ) {
    const r = this.net.tuning.player.radius;
    const atk = this.net.tuning.characters[character]?.attack;
    const REST = 0.20;

    // Gape widens the bite, so the jaws open wider by the same proportion the
    // arc grew. A mouth that hits 40 degrees more should look like it.
    const base = atk?.kind === "melee" ? atk.arcDegrees : 100;
    const grown = atk?.kind === "melee" ? meleeSweep(atk, m).arcDegrees : base;
    const WIDE = 1.05 * (base > 0 ? grown / base : 1);

    let gape = REST;
    if (p >= 0) {
      gape = p < 0.3
        ? REST + (WIDE - REST) * (p / 0.3)
        // Snap: most of the travel happens in the first part of the close.
        : WIDE * (1 - Math.pow((p - 0.3) / 0.7, 0.55));
    }

    const hinge = r + 5;
    const hx = x + Math.cos(aim) * hinge;
    const hy = y + Math.sin(aim) * hinge;
    const tex = TEX.weapon(character);

    for (const [key, flip, dir] of [[id, false, -1], [`${id}-jaw`, true, 1]] as const) {
      const jaw = this.weapons.get(key, tex);
      jaw.setPosition(hx, hy);
      // The pivot is the back corner of the mouth: the tooth line's left end,
      // which flipping moves from the bottom of the sprite to the top.
      jaw.setOrigin(0.05, flip ? 0 : 1);
      jaw.setFlipY(flip);
      jaw.setRotation(aim + dir * gape * 0.5);
      // Gape widens the jaws' angle above; Reach makes the whole maw bigger.
      jaw.setScale(PIXEL * reachScale(atk, m));
      jaw.setAlpha(alpha);
    }
  }

  /** Start a swing animation for a player. */
  private beginSwing(id: string, aim: number, ranged: boolean) {
    this.swings.set(id, { startedMs: performance.now(), aim, ranged });
  }

  /**
   * How much of the level is left, as a bar across the top.
   *
   * The clock has been in the HUD strip as `time 62s` since M4, which is not
   * something you can read while dodging. Colours by remaining fraction on the
   * same thresholds drawHealthBar uses, so the two read as one system.
   */
  private drawLevelTimer() {
    if (this.net.outcome !== OUTCOME_PLAYING) return;

    const t = this.net.tuning;
    const total = secToTicks(t.level.durationSec, t);
    if (total <= 0) return;

    const left = Math.max(0, this.net.levelEndTick - this.net.serverTick);
    const frac = Math.max(0, Math.min(1, left / total));

    const pad = t.arena.padding;
    const w = t.arena.width - pad * 2;
    const y = pad + TIMER_BAR_INSET;
    const g = this.g;

    g.fillStyle(0x0f172a, 0.8);
    g.fillRect(pad, y, w, TIMER_BAR_H);

    const color = frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfbbf24 : 0xef4444;
    g.fillStyle(color, 0.95);
    g.fillRect(pad, y, w * frac, TIMER_BAR_H);

    g.lineStyle(1, 0x334155, 0.9);
    g.strokeRect(pad, y, w, TIMER_BAR_H);
  }

  /**
   * Structures are drawn as their exact collision boxes. Keeping the drawing and
   * the hitbox literally the same rectangle means they can never disagree, which
   * is worth more during M1 than anything prettier would be.
   */
  private drawStructures() {
    const g = this.g;
    for (const b of this.net.structures) {
      const standing = isStanding(b);
      const left = b.x - b.w / 2, top = b.y - b.h / 2;

      if (!standing) {
        // Rubble: still visible so you can read the arena's history, but it no
        // longer collides and sewage flies straight over it. Drawn under
        // everything else, and dimmed, so it never reads as cover.
        const wreck = this.structures.get(b.id, b.kind === "hut" ? TEX.hutRubble : TEX.wallRubble);
        wreck.setPosition(b.x, b.y);
        wreck.setScale(PIXEL);
        wreck.setAngle(b.h > b.w ? 90 : 0);
        wreck.clearTint();
        wreck.setAlpha(0.55);
        continue;
      }

      // Sprites are baked at exactly the collision box, so scaling by PIXEL puts
      // their edges on the hitbox edges. Damage is a tint over the art rather
      // than a separate fill: intact reads normal, nearly-dead reads hot.
      const sprite = this.structures.get(b.id, b.kind === "hut" ? TEX.hut : TEX.wall);
      sprite.setPosition(b.x, b.y);
      sprite.setScale(PIXEL);
      sprite.setAlpha(1);
      // generateLayout stands half the walls on end by swapping w and h, so the
      // sprite has to turn with them. Rotating by exactly 90 keeps pixels square;
      // stretching one axis to fit would not.
      sprite.setAngle(b.h > b.w ? 90 : 0);
      const frac = b.maxHp > 0 ? Math.max(0, Math.min(1, b.hp / b.maxHp)) : 1;
      const g2 = Math.round(0x66 + 0x99 * frac);
      sprite.setTint((0xff << 16) | (g2 << 8) | g2);

      if (this.showHitboxes) {
        g.lineStyle(1, 0x38bdf8, 0.9);
        g.strokeRect(left, top, b.w, b.h);
        this.label(`hp-${b.id}`, `${b.hp}/${b.maxHp}`, b.x, top - 2);
      } else {
        this.dropLabel(`hp-${b.id}`);
      }
    }
  }

  /**
   * Sewage, advanced from the newest server snapshot to roughly present server
   * time: the age of the snapshot plus one-way latency. Straight-line motion
   * makes this exact right up until the chunk hits something, so the only
   * artifact is a chunk drawn slightly past a wall in the frame it dies.
   */
  private asteroidLeadSec() {
    if (!this.extrapolate) return 0;
    // Paused. The server sends no patches while frozen, so snapshotAt stops
    // moving while the wall clock does not, and this lead would grow without
    // bound — chunks sliding across the arena at full speed on a stopped server.
    // That shipped once: the pause probe checked the server's positions, which
    // were correctly still, and never looked at what was drawn.
    if (this.net.pausedBy !== "") return 0;

    const age = (performance.now() - this.net.snapshotAt) / 1000;
    return age + this.net.rttMs / 2000;
  }

  /**
   * The boss, and the bar that says how it is doing.
   *
   * Drawn at exactly the radius the server hits, like every chunk and body — it
   * is the biggest thing in the game and so the one where a sprite that
   * disagreed with its hitbox would be most obvious and most unfair.
   *
   * Not extrapolated. Sewage is led by snapshot age because it moves fast enough
   * for the lag to show; the Clog crawls and the Wellspring does not move at all,
   * so there is nothing to hide and leading it would only add error.
   */
  private drawBoss() {
    const b = this.net.boss;
    if (!b || b.hp <= 0) {
      this.bossText.setVisible(false);
      return;
    }

    const t = this.net.tuning;
    const g = this.g;

    const sprite = this.props.get("boss", TEX.boss(b.kind));
    sprite.setPosition(b.x, b.y);
    sprite.setScale(PIXEL);
    // The Clog turns as it comes; the Wellspring sits still, so a rotation would
    // just make it wobble.
    sprite.setRotation(b.kind === BOSS_CLOG ? idAngle(`${Math.round(b.x / 40)}`) : 0);

    if (this.showHitboxes) {
      g.lineStyle(2, 0xf59e0b, 0.9);
      g.strokeCircle(b.x, b.y, b.radius);
    }

    // Razing reads as an emergency: the Clog is inside the town pulling it down.
    if (b.razing) {
      g.lineStyle(3, 0xef4444, 0.5 + 0.4 * Math.sin(performance.now() / 120));
      g.strokeCircle(b.x, b.y, b.radius + 8);
    }

    // The health bar, across the top of the arena under the level timer, on the
    // same thresholds drawHealthBar uses so it reads like every other bar.
    const frac = b.maxHp > 0 ? Math.max(0, Math.min(1, b.hp / b.maxHp)) : 0;
    const pad = t.arena.padding;
    const w = t.arena.width - pad * 2;
    const y = pad + TIMER_BAR_INSET + TIMER_BAR_H + 6;
    const h = 14;

    g.fillStyle(0x0f172a, 0.85);
    g.fillRect(pad, y, w, h);
    g.fillStyle(frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfbbf24 : 0xef4444, 0.95);
    g.fillRect(pad, y, w * frac, h);
    g.lineStyle(1, 0x334155, 0.9);
    g.strokeRect(pad, y, w, h);

    this.bossText.setPosition(t.arena.width / 2, y + h / 2);
    this.bossText.setText(
      `${b.kind === BOSS_CLOG ? "THE CLOG" : "THE WELLSPRING"}   ${b.hp} / ${b.maxHp}`
      + (b.phase > 0 ? "   ENRAGED" : ""),
    );
    this.bossText.setVisible(true);
  }

  private drawAsteroids() {
    const t = this.net.tuning;
    const g = this.g;
    const lead = this.asteroidLeadSec();

    for (const a of this.net.asteroids) {
      const r = tierRadius(t, a.tier as Tier);
      const x = a.x + a.vx * lead;
      const y = a.y + a.vy * lead;

      // The sprite is a disc baked at the tier's true diameter, so its edge is
      // the collision edge. Rotation is free for the same reason it is on
      // bodies: a rotated disc covers exactly the same pixels, so spinning each
      // chunk by a hash of its id gives them individuality with no cost to
      // honesty.
      const sprite = this.chunks.get(a.id, a.tier === TIER_LARGE ? TEX.sewageLarge : TEX.sewageSmall);
      sprite.setPosition(x, y);
      sprite.setScale(PIXEL);
      sprite.setRotation(idAngle(a.id));

      if (this.showHitboxes) {
        g.lineStyle(1, 0xf59e0b, 0.9);
        g.strokeCircle(x, y, r);
        // Where the server currently believes it is, before extrapolation.
        g.lineStyle(1, 0xffffff, 0.25);
        g.strokeCircle(a.x, a.y, r);
      }
    }
  }

  /**
   * Arrows, extrapolated exactly like sewage and from the same snapshot: they
   * travel in perfectly straight lines, so leading them by snapshot age plus
   * one-way latency is exact right up until one connects.
   */
  private drawProjectiles() {
    if (this.net.projectiles.length === 0) return;

    const atk = this.rangedTuning();
    if (!atk) return;

    const g = this.g;
    const lead = this.asteroidLeadSec();

    for (const p of this.net.projectiles) {
      const x = p.x + p.vx * lead;
      const y = p.y + p.vy * lead;

      const sprite = this.arrows.get(p.id, TEX.arrow);
      sprite.setPosition(x, y);
      sprite.setScale(PIXEL);
      sprite.setRotation(Math.atan2(p.vy, p.vx));
    }
  }

  /** The one bow in the game, found by kind rather than by character id. */
  private rangedTuning() {
    for (const c of Object.values(this.net.tuning.characters)) {
      if (c.attack.kind === "ranged") return c.attack;
    }
    return null;
  }

  /**
   * Hook in flight, then the taut rope while it pulls. Both come straight from
   * server state — neither is predicted, because where a hook lands depends on
   * chunks the client does not simulate.
   */
  private drawGrapple(
    view: { hookActive: boolean; hookX: number; hookY: number; pullTicks: number; pullAnchorX: number; pullAnchorY: number },
    x: number,
    y: number,
    color: number,
  ) {
    const g = this.g;

    if (view.hookActive) {
      g.lineStyle(2, color, 0.7);
      g.lineBetween(x, y, view.hookX, view.hookY);
      g.fillStyle(color, 1);
      g.fillCircle(view.hookX, view.hookY, 4);
      return;
    }

    if (view.pullTicks > 0) {
      g.lineStyle(3, color, 0.9);
      g.lineBetween(x, y, view.pullAnchorX, view.pullAnchorY);
      g.fillStyle(color, 1);
      g.fillCircle(view.pullAnchorX, view.pullAnchorY, 5);
    }
  }

  /**
   * The throne shell, drawn at exactly the radius the server reflects sewage
   * off. Same principle as the structure hitboxes: one number, so what you dodge
   * behind and what actually stops a chunk can never disagree.
   */
  private drawThrone(id: string, x: number, y: number, character: string, color: number, m: PerkMods) {
    const sp = this.net.tuning.characters[character]?.special;
    if (!sp || sp.kind !== "throne") return;

    const r = this.net.tuning.player.radius;

    // The throne itself: a prop, drawn behind the body and lifted so he reads as
    // sitting in it rather than standing on it. Decoration only — it collides
    // with nothing, and the shell below is what actually stops sewage.
    const seat = this.props.get(`throne-${id}`, TEX.throne);
    seat.setPosition(x, y - r * 0.5);
    seat.setScale(PIXEL);

    // The shell, still drawn at exactly the radius the server reflects off —
    // which Wider Throne changes, so the mods have to come with it.
    const radius = throneBubbleRadius(this.net.tuning, sp, m);
    const g = this.g;
    g.fillStyle(color, 0.1);
    g.fillCircle(x, y, radius);
    g.lineStyle(2, color, 0.85);
    g.strokeCircle(x, y, radius);

    // Sanctuary shelters allies as well as the caster, which is a different
    // promise from an ordinary bubble and worth being able to see.
    if (m.sanctuary) {
      g.lineStyle(1, 0xbbf7d0, 0.7);
      g.strokeCircle(x, y, radius - 5);
    }
  }

  /**
   * The Cathedral shell — the throne bubble several times over.
   *
   * Radius is composed exactly as `ArenaRoom.activeBubbles` composes it, from
   * the same two functions, for the same reason the throne is: a shell drawn
   * anywhere but where sewage bounces is worse than no shell at all.
   */
  private drawCathedral(
    x: number, y: number, character: string, color: number,
    m: PerkMods, ups: string[],
  ) {
    const sp = this.net.tuning.characters[character]?.special;
    if (!sp || sp.kind !== "throne") return;

    const radius = throneBubbleRadius(this.net.tuning, sp, m) * cathedralRadiusMul(ups);
    const g = this.g;
    g.fillStyle(color, 0.06);
    g.fillCircle(x, y, radius);
    g.lineStyle(3, 0xfde68a, 0.8);
    g.strokeCircle(x, y, radius);
  }

  /**
   * Dash, attack, and special as arcs around your own player, plus the ultimate
   * once you have one.
   *
   * On the character rather than in the HUD strip because a cooldown is
   * something you check mid-dodge, and looking away from your own body to read
   * a number costs more than the number is worth. Self only — three of these on
   * every player would be noise.
   *
   * Values come from the predictor, so an arc empties on the frame you press the
   * button rather than a round trip later.
   */
  private drawCooldownRing(
    x: number, y: number, r: number,
    character: string, m: PerkMods,
    s: {
      dashCdTicks: number; attackCdTicks: number; specialCdTicks: number;
      dashTicks: number; specialTicks: number;
      ultimateId: string; ultReady: boolean; ultTicks: number;
    },
  ) {
    const t = this.net.tuning;
    const c = t.characters[character];
    if (!c) return;

    // Totals have to be the perk-modified cooldowns, or every arc misreports its
    // own fill: shorten a cooldown without shortening the total it is measured
    // against and the ring never reads as full even when the ability is ready.
    const arcs = [
      {
        left: s.dashCdTicks,
        total: secToTicks(Math.max(0, c.dash.cooldownSec + m.dashCdAdd), t),
        active: s.dashTicks > 0, color: 0x93c5fd,
      },
      {
        left: s.attackCdTicks,
        // Windrunner empties the ring's total too, or the arc would read as
        // permanently unready while the bow is firing every tick.
        total: secToTicks(m.noAttackCooldown ? 0 : c.attack.cooldownSec, t),
        active: false, color: 0xfde68a,
      },
      {
        left: s.specialCdTicks,
        total: secToTicks(specialCooldownSec(c.special.cooldownSec, m), t),
        active: s.specialTicks > 0, color: 0xc4b5fd,
      },
    ];

    // The ultimate is a charge, not a cooldown: it is either there or spent
    // until the next level, so its arc is full or empty with nothing between.
    // Only drawn once you hold one, so the ring stays three arcs until level 5.
    if (s.ultimateId !== "") {
      arcs.push({
        left: s.ultReady ? 0 : 1, total: 1,
        active: s.ultTicks > 0, color: 0xfb923c,
      });
    }

    const g = this.g;
    const radius = r + 7;
    const span = (Math.PI * 2) / arcs.length;
    const gap = span * 0.16;

    arcs.forEach((a, i) => {
      // Start at the top and run clockwise, so the three sit in a fixed place
      // and can be read by position without looking at colour.
      const from = -Math.PI / 2 + i * span + gap / 2;
      const to = from + span - gap;

      g.lineStyle(3, a.color, 0.18);
      g.beginPath();
      g.arc(x, y, radius, from, to, false);
      g.strokePath();

      // Active beats ready: while a dash or a throne is running, its arc is
      // full and bright even though the cooldown underneath is at zero.
      const frac = a.active ? 1 : a.total > 0 ? 1 - Math.min(1, a.left / a.total) : 1;
      if (frac <= 0) return;

      g.lineStyle(3, a.color, a.active || a.left === 0 ? 1 : 0.6);
      g.beginPath();
      g.arc(x, y, radius, from, from + (to - from) * frac, false);
      g.strokePath();
    });
  }

  /**
   * What a downed player shows instead of health: how close somebody is to
   * getting them up, and how many skulls are left before that stops mattering.
   */
  private drawDownedBar(x: number, y: number, reviveTicks: number, skulls: number, m: PerkMods) {
    const d = this.net.tuning.downed;
    const goal = Math.max(1, Math.round(d.reviveSeconds * this.net.tuning.net.tickHz));
    const w = 34, h = 4;
    const g = this.g;

    g.fillStyle(0x0f172a, 0.85);
    g.fillRect(x - w / 2, y, w, h);
    g.fillStyle(0x38bdf8, 1);
    g.fillRect(x - w / 2, y, w * Math.min(1, reviveTicks / goal), h);

    // One pip per skull spent, so the countdown to permanent death is visible
    // from across the arena rather than buried in a number.
    // Iron Will buys extra skulls, so the pip count is per player. Drawing the
    // tuning value would tell someone they were one hit from death when they had
    // two left.
    const pips = d.skullsToDie + m.skullsAdd;
    const pipR = 2.5;
    const spacing = 8;
    for (let i = 0; i < pips; i++) {
      const px = x - ((pips - 1) * spacing) / 2 + i * spacing;
      g.fillStyle(i < skulls ? 0xef4444 : 0x334155, 1);
      g.fillCircle(px, y + h + 5, pipR);
    }
  }

  /**
   * The panel you read while you are on the floor.
   *
   * Three things, big enough to take in without looking away from the sewage:
   * how many skulls you have left, how many lives the party has left, and which
   * button spends one. Yours alone — `drawDownedBar` above the body is what
   * teammates read from across the arena, and this replaces nothing.
   *
   * The key comes from `bindingLabel`, which reads the same BINDINGS table
   * `buttons()` samples, so a prompt can never name a button that does something
   * else. That mistake has already happened once in this project, when Shift
   * dashed for weeks while the docs said otherwise.
   */
  private drawDownedPanel(self: {
    x: number; y: number; lifeState: number; skulls: number; carriedBy: string;
  }, m: PerkMods) {
    const t = this.net.tuning;
    const g = this.g;
    const lives = this.net.lives;
    const dead = self.lifeState === LIFE_DEAD;

    // Wide enough for the longest line it can hold — "PRESS E OR RIGHT MOUSE"
    // spelled out at 22px monospace — because the prompt is the part somebody
    // reading this under pressure actually needs, and text spilling out of the
    // box reads as broken.
    const w = 720, h = 152;
    // Fixed spot, so it is where you expect it under pressure — but flipped to
    // the top when you are lying in the bottom of the arena, which is the whole
    // of "somewhere it will not cover you".
    const low = self.y > t.arena.height - (h + 200);
    const cx = t.arena.width / 2;
    const cy = low ? 150 : t.arena.height - 150;

    g.fillStyle(0x0b1120, 0.92);
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    g.lineStyle(2, dead ? 0x64748b : 0xef4444, 1);
    g.strokeRect(cx - w / 2, cy - h / 2, w, h);

    // Skulls: spent against this player's own limit, because Iron Will buys
    // extra ones. Drawing the tuning number would tell somebody they were one
    // hit from death when they had two left.
    const limit = t.downed.skullsToDie + m.skullsAdd;
    const spacing = 34;
    for (let i = 0; i < limit; i++) {
      const px = cx - ((limit - 1) * spacing) / 2 + i * spacing;
      const spent = i < self.skulls;
      g.fillStyle(spent ? 0xef4444 : 0x1e293b, 1);
      g.fillCircle(px, cy - 38, 12);
      g.lineStyle(2, spent ? 0xef4444 : 0x475569, 1);
      g.strokeCircle(px, cy - 38, 12);
    }

    // Lives, as the party's pips. Drawn against the tuned total so you can see
    // how much of the run's safety net is already gone.
    const total = Math.max(lives, t.level.extraLives);
    const lspacing = 26;
    for (let i = 0; i < total; i++) {
      const px = cx - ((total - 1) * lspacing) / 2 + i * lspacing;
      g.fillStyle(i < lives ? 0x4ade80 : 0x1e293b, 1);
      g.fillCircle(px, cy + 4, 8);
      g.lineStyle(2, i < lives ? 0x4ade80 : 0x475569, 1);
      g.strokeCircle(px, cy + 4, 8);
    }

    this.downedText.setPosition(cx, cy + 46);
    this.downedText.setText(
      self.carriedBy !== ""
        // A passenger has no input at all, so offering a button would be a lie.
        ? "SAFE INSIDE THE DRUID"
        : lives > 0
          ? `${dead ? "DEAD" : "DOWNED"} — PRESS ${bindingLabel(BTN.SPECIAL).toUpperCase()} TO SPEND A LIFE`
          : `${dead ? "DEAD" : "DOWNED"} — NO LIVES LEFT`,
    );
    this.downedText.setColor(lives > 0 ? "#e2e8f0" : "#94a3b8");
    this.downedText.setVisible(true);
  }

  private drawHealthBar(x: number, y: number, health: number, maxHealth: number) {
    if (maxHealth <= 0) return;
    const w = 34, h = 4;
    const frac = Math.max(0, Math.min(1, health / maxHealth));
    const g = this.g;
    g.fillStyle(0x0f172a, 0.85);
    g.fillRect(x - w / 2, y, w, h);
    const color = frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfbbf24 : 0xef4444;
    g.fillStyle(color, 1);
    g.fillRect(x - w / 2, y, w * frac, h);
  }

  private aimAngle() {
    const p = this.input.activePointer;
    return Math.atan2(p.worldY - this.predictor.state.y, p.worldX - this.predictor.state.x);
  }

  private dropLabel(id: string) {
    const t = this.labels.get(id);
    if (t) { t.destroy(); this.labels.delete(id); }
  }

  private label(id: string, name: string, x: number, y: number) {
    let text = this.labels.get(id);
    if (!text) {
      text = this.add.text(0, 0, name, { fontFamily: "monospace", fontSize: "12px", color: "#cbd5e1" })
        .setOrigin(0.5, 1);
      this.labels.set(id, text);
    }
    text.setText(name);
    text.setPosition(x, y);
  }

  private drawHud() {
    const p = this.predictor;
    this.hud.textContent = [
      `fps ${Math.round(this.game.loop.actualFps)}`,
      `rtt ${Math.round(this.net.rttMs)}ms`,
      `players ${this.net.snapshots.at(-1)?.players.size ?? 0}/${this.net.tuning.player.maxPlayers}`,
      `tick ${this.net.snapshots.at(-1)?.tick ?? 0}`,
      `pending ${p.pending.length}`,
      `err ${p.lastError.toFixed(2)}px`,
      `level ${this.net.level}`,
      `score ${formatScore(this.net.score)}`,
      `pause ${this.currentServerSelf()?.pauseUsed ? "spent" : "ready (ESC)"}`,
      // Shared, so this is the party's number and not yours.
      `lives ${"●".repeat(this.net.lives)}${"○".repeat(Math.max(0, this.net.tuning.level.extraLives - this.net.lives))}`,
      `predict ${p.enabled ? "on" : "off"} (P)`,
      `interp ${this.interpEnabled ? "on" : "off"} (I)`,
      `ghost ${this.showServerGhost ? "on" : "off"} (G)`,
      `boxes ${this.showHitboxes ? "on" : "off"} (H)`,
      `lead ${this.extrapolate ? "on" : "off"} (X)`,
      `sound ${this.sfx.muted ? "off" : "on"} (M)`,
      `sewage ${this.net.asteroids.length}`,
      `arrows ${this.net.projectiles.length}`,
      `time ${this.levelSecondsLeft()}s`,
      this.waveLabel(),
      `hp ${this.currentServerSelf()?.health ?? "-"}`,
      `structures ${this.net.structures.filter(isStanding).length}/${this.net.structures.length}`,
    ].join("   ");
  }
}

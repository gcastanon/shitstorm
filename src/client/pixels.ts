import Phaser from "phaser";
import { BOSS_CLOG, BOSS_WELLSPRING } from "../shared/types";

/**
 * The game's art, generated at boot.
 *
 * No asset files, for the same reason the audio is synthesized: this project has
 * no asset pipeline and a handful of small sprites does not justify starting one.
 * Everything here is drawn a pixel at a time into a Graphics and baked with
 * generateTexture, which is the trick fx.ts already uses for its particle dot.
 *
 * ## Why one art pixel is exactly two screen pixels
 *
 * For pixels to read as coherent 8-bit they have to be a *uniform* size across
 * the whole game, which means the art pixel has to divide every hitbox dimension
 * exactly. Those dimensions are 36 (player diameter), 96 (hut), 128x32 (wall),
 * and 68 / 34 (sewage diameters). Their GCD is 2. So PIXEL is 2 — an effective
 * 640x360 — and every sprite lands on an exact boundary. Anything chunkier would
 * mean changing hitbox sizes, and those are balance.
 *
 * ## Which shapes are drawn and which are generated
 *
 * Anything that *is* a hitbox — bodies, sewage — has its shape generated from the
 * hitbox radius, so it cannot drift a pixel away from what collision uses. Only
 * decoration that collides with nothing — weapons, roofs, floor tiles — is
 * hand-authored as string art.
 */

/** One art pixel, in screen pixels. See the note above before changing this. */
export const PIXEL = 2;


export const TEX = {
  floor: "px-floor",
  outskirts: "px-outskirts",
  boss: (kind: string) => `px-boss-${kind}`,
  hut: "px-hut",
  hutRubble: "px-hut-rubble",
  wall: "px-wall",
  wallRubble: "px-wall-rubble",
  sewageLarge: "px-sewage-l",
  sewageSmall: "px-sewage-s",
  arrow: "px-arrow",
  throne: "px-throne",
  body: (c: string) => `px-body-${c}`,
  weapon: (c: string) => `px-weapon-${c}`,
} as const;

const OUTLINE = 0x0b0f18;

/** Multiply a colour's channels. Used for cheap shading off one base colour. */
export function shade(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((color & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

/** A tiny pixel-drawing surface that bakes itself into a texture. */
class Pix {
  private g: Phaser.GameObjects.Graphics;

  constructor(private scene: Phaser.Scene, readonly w: number, readonly h: number) {
    this.g = scene.add.graphics();
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1) {
    this.g.fillStyle(color, alpha);
    this.g.fillRect(x, y, w, h);
  }

  px(x: number, y: number, color: number, alpha = 1) {
    this.rect(x, y, 1, 1, color, alpha);
  }

  /**
   * Filled circle inscribed exactly in a size x size box, so a sprite baked at
   * the hitbox diameter covers precisely the hitbox and not a pixel more.
   */
  disc(cx: number, cy: number, r: number, color: number) {
    for (let y = 0; y < this.h; y++) {
      const dy = y + 0.5 - cy;
      if (Math.abs(dy) > r) continue;
      const half = Math.sqrt(r * r - dy * dy);
      const x0 = Math.round(cx - half);
      const x1 = Math.round(cx + half);
      if (x1 > x0) this.rect(x0, y, x1 - x0, 1, color);
    }
  }

  /**
   * An ellipse, clipped to a circle.
   *
   * The clip is the point: sewage is drawn as coils stacked inside its hitbox
   * disc, and a coil wide enough to read would otherwise bulge past the radius
   * collision actually uses. Clipping keeps the silhouette exactly the hitbox
   * while the detail inside can be any shape it likes.
   */
  ellipseIn(
    cx: number, cy: number, rx: number, ry: number,
    color: number,
    clip: { cx: number; cy: number; r: number },
  ) {
    for (let y = 0; y < this.h; y++) {
      const yc = y + 0.5;

      const ey = (yc - cy) / ry;
      if (Math.abs(ey) > 1) continue;
      const ehw = rx * Math.sqrt(1 - ey * ey);

      const cy2 = yc - clip.cy;
      if (Math.abs(cy2) > clip.r) continue;
      const chw = Math.sqrt(clip.r * clip.r - cy2 * cy2);

      const x0 = Math.round(Math.max(cx - ehw, clip.cx - chw));
      const x1 = Math.round(Math.min(cx + ehw, clip.cx + chw));
      if (x1 > x0) this.rect(x0, y, x1 - x0, 1, color);
    }
  }

  /** Rows of single-char keys; any char missing from the palette is transparent. */
  art(x: number, y: number, rows: string[], palette: Record<string, number>) {
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const color = palette[row[rx]!];
        if (color !== undefined) this.px(x + rx, y + ry, color);
      }
    });
  }

  bake(key: string) {
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.g.generateTexture(key, this.w, this.h);
    this.g.destroy();
  }
}

/**
 * A chunk of sewage: a coiled turd.
 *
 * The silhouette is still the hitbox disc, filled edge to edge, so what you dodge
 * is exactly what collides. Everything on top of it — the stacked coils, the tip,
 * the shine — is clipped to that same disc, so the detail can be as lumpy as it
 * likes without ever claiming a pixel the simulation does not own.
 *
 * `size` is the hitbox diameter in art pixels.
 */
function poopTexture(scene: Phaser.Scene, key: string, size: number) {
  const p = new Pix(scene, size, size);
  const c = size / 2;
  const r = size / 2;
  const clip = { cx: c, cy: c, r: r - 1 };

  const DARK = 0x40280f;
  const MID = 0x684021;
  const LIGHT = 0x8a5a2e;
  const SHINE = 0xa87b45;

  p.disc(c, c, r, OUTLINE);
  p.disc(c, c, r - 1, DARK);

  // Three coils, widest at the bottom, each a little higher and narrower.
  p.ellipseIn(c, c + r * 0.40, r * 0.98, r * 0.44, MID, clip);
  p.ellipseIn(c, c + r * 0.42, r * 0.90, r * 0.34, LIGHT, clip);

  p.ellipseIn(c, c - r * 0.02, r * 0.80, r * 0.38, MID, clip);
  p.ellipseIn(c, c - r * 0.02, r * 0.72, r * 0.28, LIGHT, clip);

  p.ellipseIn(c, c - r * 0.42, r * 0.54, r * 0.32, MID, clip);
  p.ellipseIn(c, c - r * 0.44, r * 0.46, r * 0.22, LIGHT, clip);

  // The little peak on top, and a wet highlight.
  p.ellipseIn(c + r * 0.06, c - r * 0.72, r * 0.20, r * 0.20, LIGHT, clip);
  p.ellipseIn(c - r * 0.30, c - r * 0.18, r * 0.18, r * 0.10, SHINE, clip);
  p.bake(key);
}

/**
 * A boss. The same disc-from-the-hitbox rule every chunk and body follows, so
 * the silhouette cannot drift from what the server hits.
 *
 * The Clog is sewage several times over — the same coils, darker and sicker. The
 * Wellspring is a hole in the ground with something coming out of it, so it gets
 * rings instead of coils and a bright throat that reads at a glance as the thing
 * to point at.
 */
function bossTexture(scene: Phaser.Scene, key: string, size: number, wellspring: boolean) {
  const p = new Pix(scene, size, size);
  const c = size / 2;
  const r = size / 2;
  const clip = { cx: c, cy: c, r: r - 1 };

  if (!wellspring) {
    const DARK = 0x241505;
    const MID = 0x4a2a0e;
    const LIGHT = 0x6b4018;
    const SICK = 0x7d8a2e;

    p.disc(c, c, r, OUTLINE);
    p.disc(c, c, r - 1, DARK);

    // Four coils rather than the chunk's three, so it reads as bigger rather
    // than merely nearer.
    for (const [dy, rx, ry] of [
      [0.52, 0.98, 0.36], [0.18, 0.90, 0.32], [-0.16, 0.76, 0.30], [-0.50, 0.56, 0.26],
    ] as const) {
      p.ellipseIn(c, c + r * dy, r * rx, r * ry, MID, clip);
      p.ellipseIn(c, c + r * dy, r * (rx - 0.1), r * (ry - 0.1), LIGHT, clip);
    }
    // Streaks of something worse.
    p.ellipseIn(c - r * 0.34, c - r * 0.10, r * 0.16, r * 0.09, SICK, clip);
    p.ellipseIn(c + r * 0.30, c + r * 0.34, r * 0.13, r * 0.07, SICK, clip);
    p.bake(key);
    return;
  }

  const RIM = 0x3a2c12;
  const STONE = 0x55503f;
  const BROTH = 0x5c6b1f;
  const HOT = 0x9fbb35;

  p.disc(c, c, r, OUTLINE);
  p.disc(c, c, r - 1, STONE);
  p.disc(c, c, r * 0.82, RIM);
  p.disc(c, c, r * 0.70, BROTH);
  p.disc(c, c, r * 0.40, HOT);
  // Stonework around the mouth, so it reads as built rather than grown.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    p.rect(
      Math.round(c + Math.cos(a) * r * 0.90) - 1,
      Math.round(c + Math.sin(a) * r * 0.90) - 1,
      3, 3, RIM,
    );
  }
  p.bake(key);
}

/** A character. Same disc as the hitbox, plus a face that never rotates. */
function bodyTexture(scene: Phaser.Scene, key: string, size: number, base: number) {
  const p = new Pix(scene, size, size);
  const c = size / 2;

  p.disc(c, c, size / 2, OUTLINE);
  p.disc(c, c, size / 2 - 1, shade(base, 0.7));
  p.disc(c - 1, c - 1, size / 2 - 2, base);

  // Eyes. The body is drawn upright always — the weapon is what shows facing —
  // so these can sit at fixed positions and read as a face from any aim.
  const eyeY = Math.round(size * 0.42);
  for (const ex of [Math.round(size * 0.3), Math.round(size * 0.62)]) {
    p.rect(ex, eyeY, 3, 3, 0xf8fafc);
    p.rect(ex + 1, eyeY + 1, 2, 2, OUTLINE);
  }
  p.bake(key);
}

/** Roofed hut. Decoration only; the collision box is the full square. */
function hutTexture(scene: Phaser.Scene, key: string, size: number, ruined: boolean) {
  const p = new Pix(scene, size, size);
  const roof = ruined ? 0x3f3a34 : 0x8a4b2a;
  const wall = ruined ? 0x2c3340 : 0xa9855b;
  const door = ruined ? 0x151a24 : 0x4a3020;

  p.rect(0, 0, size, size, OUTLINE);
  p.rect(1, 1, size - 2, size - 2, wall);

  // Plank lines across the walls.
  for (let y = Math.round(size * 0.42); y < size - 1; y += 5) {
    p.rect(1, y, size - 2, 1, shade(wall, 0.82));
  }

  // Roof: a slab with a shadowed eave, not a real perspective.
  const roofH = Math.round(size * 0.4);
  p.rect(1, 1, size - 2, roofH, roof);
  p.rect(1, roofH, size - 2, 2, shade(roof, 0.6));
  for (let x = 2; x < size - 2; x += 4) p.rect(x, 2, 2, roofH - 2, shade(roof, 1.12));

  if (!ruined) {
    const dw = Math.round(size * 0.22);
    const dh = Math.round(size * 0.34);
    p.rect(Math.round(size / 2 - dw / 2), size - 1 - dh, dw, dh, door);
    p.rect(Math.round(size * 0.18), Math.round(size * 0.58), 5, 5, 0x1e293b);
    p.rect(Math.round(size * 0.72), Math.round(size * 0.58), 5, 5, 0x1e293b);
  } else {
    // Bites taken out of the silhouette so rubble reads as broken.
    for (let x = 3; x < size - 3; x += 7) p.rect(x, 1, 4, Math.round(size * 0.3), 0x0d1220);
  }
  p.bake(key);
}

/** Stone wall, staggered courses. */
function wallTexture(scene: Phaser.Scene, key: string, w: number, h: number, ruined: boolean) {
  const p = new Pix(scene, w, h);
  const stone = ruined ? 0x2c3340 : 0x6b7280;

  p.rect(0, 0, w, h, OUTLINE);
  p.rect(1, 1, w - 2, h - 2, stone);

  const course = Math.max(3, Math.round(h / 2));
  for (let y = 1; y < h - 1; y += course) {
    p.rect(1, y, w - 2, 1, shade(stone, 0.7));
    const offset = ((y / course) | 0) % 2 ? course : 0;
    for (let x = 1 + offset; x < w - 1; x += course * 2) {
      p.rect(x, y, 1, Math.min(course, h - 1 - y), shade(stone, 0.7));
    }
  }
  if (!ruined) p.rect(1, 1, w - 2, 1, shade(stone, 1.25));
  else for (let x = 2; x < w - 2; x += 9) p.rect(x, 1, 5, h - 2, 0x0d1220);

  p.bake(key);
}

/** Town paving, tiled across the town. Deliberately dim — it must never compete. */
function floorTexture(scene: Phaser.Scene, key: string, size: number) {
  const p = new Pix(scene, size, size);
  p.rect(0, 0, size, size, 0x121a2b);
  // Barely-there grout. The floor is the one thing on screen that must never
  // compete for attention with sewage coming at your head.
  p.rect(0, 0, size, 1, 0x141d2f);
  p.rect(0, 0, 1, size, 0x141d2f);
  // A fixed speckle pattern rather than random, so the tiling does not shimmer.
  const specks = [[3, 5], [11, 2], [6, 12], [13, 9], [9, 7], [2, 13]];
  for (const [x, y] of specks) p.px(x!, y!, 0x0e1522);
  p.bake(key);
}

/**
 * The open ground outside the town.
 *
 * Darker than the paving and with no grout, so the town reads as a place with
 * edges rather than as the middle of an emptier map. It has to be a *quieter*
 * texture than the floor, not a busier one: the ring is where you go to watch
 * sewage cross open ground, and anything patterned out there competes with the
 * thing you went out to see.
 */
function outskirtsTexture(scene: Phaser.Scene, key: string, size: number) {
  const p = new Pix(scene, size, size);
  p.rect(0, 0, size, size, 0x0d1220);
  const specks = [[4, 9], [12, 6], [7, 2], [2, 12]];
  for (const [x, y] of specks) p.px(x!, y!, 0x101728);
  p.bake(key);
}

const ARROW = [
  "..www.",
  "sssssm",
  "..www.",
];

/**
 * Weapons. String art, because this is where each character's character is.
 *
 * All three are authored pointing along +x, which is the aim direction once the
 * sprite is rotated, with the grip near the left edge where the pivot sits. Big
 * enough to read next to an 18px-wide body — a weapon you have to squint at is
 * not doing its job as the facing indicator.
 */
const WEAPONS: Record<string, string[]> = {
  // Bow, seen from above: string nearest the player, limbs bowing forward.
  ranger: [
    "s.........",
    "w.s.......",
    "w...s.....",
    "w.....s...",
    "w......s..",
    "w.......s.",
    "w.......s.",
    "w........s",
    "w........s",
    "w.......s.",
    "w.......s.",
    "w......s..",
    "w.....s...",
    "w...s.....",
    "w.s.......",
    "s.........",
  ],
  // One jaw of the Druid's maw. Drawn teeth-down and hinged at the left; the
  // scene draws it twice, flipping the second, so the two halves bite together.
  druid: [
    "...jjjjjjjjjjjjj",
    ".jjjjjjjjjjjjjjj",
    "jjjjjjjjjjjjjjjj",
    "JJJJJJJJJJJJJJJJ",
    "www.www.www.www.",
    ".w...w...w...w..",
  ],
  // A big sword: pommel, grip, crossguard, then a long blade with a bright
  // fuller down the middle.
  warlock: [
    "....m...................",
    "....m...................",
    "..ggmmmmmmmmmmmmmmmmmmm.",
    "ppggMMMMMMMMMMMMMMMMMMMM",
    "..ggmmmmmmmmmmmmmmmmmmm.",
    "....m...................",
    "....m...................",
  ],
};

const WEAPON_PALETTE: Record<string, number> = {
  h: 0x8a5a2b,  // wood
  H: 0x6b4520,  // wood grain
  s: 0x6b4a24,  // bow limb
  w: 0xe2e8f0,  // bowstring
  m: 0xcbd5e1,  // steel
  M: 0xf1f5f9,  // steel, catching the light
  g: 0x5b3a1a,  // grip
  p: 0xd4a017,  // pommel
  j: 0x9b2c5e,  // gum
  J: 0x6b1d40,  // gum, shadowed
};

/**
 * How each character's weapon animates when it attacks.
 *
 * Kept beside the art rather than derived from `attack.kind`, because it is a
 * property of the thing being drawn: the Druid swings nothing, it bites.
 */
export type WeaponStyle = "swing" | "bite" | "recoil";

export function weaponStyle(character: string, attackKind: string): WeaponStyle {
  if (character === "druid") return "bite";
  return attackKind === "ranged" ? "recoil" : "swing";
}

const ARROW_PALETTE: Record<string, number> = {
  s: 0xb08040,
  m: 0xd6d3d1,
  w: 0xe2e8f0,
};

/**
 * The Warlock's throne. Appears under him for as long as he is enthroned.
 *
 * Drawn behind the body and a little above it so he reads as sitting in it, and
 * it is decoration only — the thing that actually stops sewage is the bubble,
 * which stays a vector circle at the exact radius the server reflects off.
 */
const THRONE = [
  "...g......................g...",
  "...g......................g...",
  "..sSs....................sSs..",
  "..sSssssssssssssssssssssssSs..",
  "..sSSSSSSSSSSSSSSSSSSSSSSSSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSvvvvvvvvvvvvvvvvvvvvvvSs..",
  "..sSSSSSSSSSSSSSSSSSSSSSSSSs..",
  "..ssssssssssssssssssssssssss..",
  "sSs........................sSs",
  "sSs........................sSs",
  "sSs........................sSs",
  "sSs........................sSs",
  "sSs........................sSs",
  "sSs........................sSs",
  "sSs........................sSs",
  "ssssssssssssssssssssssssssssss",
  "sSSSSSSSSSSSSSSSSSSSSSSSSSSSSs",
  "svvvvvvvvvvvvvvvvvvvvvvvvvvvvs",
  "svvvvvvvvvvvvvvvvvvvvvvvvvvvvs",
  "ssssssssssssssssssssssssssssss",
  ".ss........................ss.",
  ".ss........................ss.",
  ".ss........................ss.",
  ".ss........................ss.",
  ".ss........................ss.",
];

const THRONE_PALETTE: Record<string, number> = {
  s: 0x2f3440,  // stone, shadowed
  S: 0x565c6b,  // stone, lit
  // Violet rather than red: the Warlock himself is red, and a red cushion behind
  // a red body makes the throne vanish exactly when it is supposed to appear.
  v: 0x4c1d95,
  g: 0xd4a017,  // finial
};

/**
 * Bake every texture. Character colours come from tuning rather than being
 * hardcoded here, so the art and the tuning can never disagree about who is who.
 */
export function bakeAll(
  scene: Phaser.Scene,
  characters: Record<string, { color: string }>,
  sizes: {
    playerDiameter: number;
    hut: { w: number; h: number };
    wall: { w: number; h: number };
    sewageLarge: number;
    sewageSmall: number;
    bossClog: number;
    bossWellspring: number;
  },
) {
  const art = (world: number) => Math.round(world / PIXEL);

  for (const [id, c] of Object.entries(characters)) {
    const base = Phaser.Display.Color.HexStringToColor(c.color).color;
    bodyTexture(scene, TEX.body(id), art(sizes.playerDiameter), base);

    const rows = WEAPONS[id] ?? WEAPONS.warlock!;
    const p = new Pix(scene, rows[0]!.length, rows.length);
    p.art(0, 0, rows, WEAPON_PALETTE);
    p.bake(TEX.weapon(id));
  }

  poopTexture(scene, TEX.sewageLarge, art(sizes.sewageLarge));
  poopTexture(scene, TEX.sewageSmall, art(sizes.sewageSmall));

  bossTexture(scene, TEX.boss(BOSS_CLOG), art(sizes.bossClog), false);
  bossTexture(scene, TEX.boss(BOSS_WELLSPRING), art(sizes.bossWellspring), true);

  hutTexture(scene, TEX.hut, art(sizes.hut.w), false);
  hutTexture(scene, TEX.hutRubble, art(sizes.hut.w), true);
  wallTexture(scene, TEX.wall, art(sizes.wall.w), art(sizes.wall.h), false);
  wallTexture(scene, TEX.wallRubble, art(sizes.wall.w), art(sizes.wall.h), true);

  floorTexture(scene, TEX.floor, 16);
  outskirtsTexture(scene, TEX.outskirts, 16);

  const ap = new Pix(scene, ARROW[0]!.length, ARROW.length);
  ap.art(0, 0, ARROW, ARROW_PALETTE);
  ap.bake(TEX.arrow);

  const tp = new Pix(scene, THRONE[0]!.length, THRONE.length);
  tp.art(0, 0, THRONE, THRONE_PALETTE);
  tp.bake(TEX.throne);
}

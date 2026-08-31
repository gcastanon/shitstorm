import Phaser from "phaser";

/**
 * Particles and camera feedback.
 *
 * The texture is generated at boot rather than loaded, for the same reason the
 * sound is synthesized: this project has no asset pipeline and a single white
 * dot does not justify starting one. Everything is that dot, tinted.
 *
 * None of this touches simulation state. If every call in here were deleted the
 * game would play identically, which is the property that lets it be as cheesy
 * as it likes.
 */
const DOT = "fx-dot";
const DOT_R = 4;

/** Palette for the things that splatter. Presentation only. */
export const FX_SEWAGE = 0x7a5a20;
export const FX_BLOOD = 0xb91c1c;
export const FX_RUBBLE = 0x64748b;
export const FX_SPARK = 0xfde68a;
export const FX_HEAL = 0x4ade80;

export class Fx {
  private emitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();

  constructor(private scene: Phaser.Scene) {
    if (!scene.textures.exists(DOT)) {
      const g = scene.add.graphics();
      g.fillStyle(0xffffff, 1);
      g.fillCircle(DOT_R, DOT_R, DOT_R);
      g.generateTexture(DOT, DOT_R * 2, DOT_R * 2);
      g.destroy();
    }
  }

  /**
   * One-shot spray. Emitters are cached per colour and reused — creating one per
   * impact would churn objects at exactly the moments the frame is busiest.
   */
  burst(x: number, y: number, color: number, count = 10) {
    this.emitterFor(color).explode(count, x, y);
  }

  /** A short directional streak, for a dash or an arrow leaving a bow. */
  trail(x: number, y: number, color: number, count = 4) {
    this.emitterFor(color).explode(count, x, y);
  }

  shake(durationMs: number, intensity: number) {
    this.scene.cameras.main.shake(durationMs, intensity);
  }

  flash(durationMs: number, r: number, g: number, b: number) {
    this.scene.cameras.main.flash(durationMs, r, g, b);
  }

  private emitterFor(color: number) {
    let e = this.emitters.get(color);
    if (!e) {
      e = this.scene.add.particles(0, 0, DOT, {
        lifespan: { min: 180, max: 480 },
        speed: { min: 40, max: 190 },
        scale: { start: 1, end: 0 },
        alpha: { start: 1, end: 0 },
        gravityY: 120,
        tint: color,
        emitting: false,
      });
      // Above the arena, below the outcome banner.
      e.setDepth(5);
      this.emitters.set(color, e);
    }
    return e;
  }
}

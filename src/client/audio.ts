import { Music } from "./music";

/**
 * Sound, synthesized at runtime.
 *
 * No asset files anywhere in this project, and adding a folder of .wavs for a
 * debug-primitive game would be the wrong trade. Everything here is oscillators
 * and filtered noise, which is cheap, tunable in place, and cannot 404.
 *
 * Browsers refuse to start an AudioContext until the user has interacted with
 * the page, so nothing is created until unlock() is called from a real input
 * event. Every play method no-ops until then rather than throwing.
 */

/** Presentation constants. Deliberately not in tuning.json, which is for game
 *  rules — these change how it sounds, never how it plays. */
const MASTER_GAIN = 0.25;
const NOISE_SECONDS = 1;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  /**
   * The soundtrack, created alongside the context and routed through the same
   * master gain — which is why muting with M silences music and effects together
   * without either needing to know about the other.
   */
  music: Music | null = null;

  /** Call from a genuine user gesture. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      // Not while muted. This is called on every keypress, so without the guard
      // the very next key after pressing M would resume the context that M just
      // suspended — silent, because the gain is zero, but running.
      if (!this.muted && this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(this.ctx.destination);

    // One noise buffer, reused by every percussive sound.
    const len = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.music = new Music(this.ctx, this.master);
  }

  /**
   * Mute stops the sound rather than just turning it down.
   *
   * Zeroing the master gain leaves the music's scheduler running: it keeps
   * building oscillator nodes every 25ms and handing them to an audio graph
   * nobody can hear. Stopping the scheduler and suspending the context means
   * muted really is paused — no work, no scheduled tail carrying on underneath,
   * and unmuting picks the track up rather than dropping into the middle of a
   * bar that played to an empty room.
   */
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_GAIN;

    if (!this.ctx) return this.muted;
    if (this.muted) {
      this.music?.stop();
      void this.ctx.suspend();
    } else {
      void this.ctx.resume();
    }
    return this.muted;
  }

  // --- the sounds -------------------------------------------------------

  /** Sewage meeting a wall. Dull, low, no pitch. */
  thud(strength = 1) {
    this.noise(0.16, 0.5 * strength, "lowpass", 320);
    this.tone("sine", 90, 55, 0.14, 0.35 * strength);
  }

  /** Sewage meeting a person. Wetter and higher than a wall hit. */
  splat() {
    this.noise(0.22, 0.55, "bandpass", 900, 1.2);
    this.tone("sine", 160, 60, 0.18, 0.3);
  }

  /** A chunk coming apart. Short, bright, a bit gritty. */
  split() {
    this.noise(0.1, 0.35, "highpass", 1400);
  }

  /** Melee. A swept whoosh with no tone in it at all. */
  swing() {
    this.noise(0.14, 0.3, "bandpass", 2200, 3);
  }

  /** Bowstring. */
  shoot() {
    this.tone("triangle", 700, 220, 0.09, 0.22);
  }

  dash() {
    this.tone("triangle", 260, 620, 0.12, 0.2);
  }

  /** Taking a hit yourself: lower and longer than hearing someone else take one. */
  hurt() {
    this.tone("square", 200, 70, 0.26, 0.3);
    this.noise(0.18, 0.4, "lowpass", 700);
  }

  down() {
    this.tone("sawtooth", 260, 45, 0.7, 0.28);
  }

  revived() {
    this.arpeggio([330, 440, 660], 0.1, "triangle", 0.22);
  }

  /** The throne coming up, and sewage bouncing off it. */
  throne() {
    this.tone("sine", 120, 420, 0.4, 0.22);
  }

  reflect() {
    this.tone("square", 900, 1500, 0.06, 0.12);
  }

  grapple() {
    this.tone("square", 180, 900, 0.14, 0.16);
  }

  swallow() {
    this.tone("sine", 500, 120, 0.28, 0.24);
  }

  /**
   * An ultimate going off. Deliberately the loudest and longest thing in here —
   * it happens once a level and the whole point of it is that everybody notices.
   *
   * A rising arpeggio over a swell, so it does not get mistaken for the throne
   * (which falls) or a wave starting (two notes, quiet).
   */
  ultimate() {
    this.arpeggio([262, 392, 523, 784], 0.09, "square", 0.3);
    this.tone("sawtooth", 90, 300, 0.55, 0.26);
  }

  structureDown() {
    this.noise(0.5, 0.7, "lowpass", 260);
    this.tone("sine", 70, 40, 0.5, 0.35);
  }

  waveStart() {
    this.arpeggio([180, 240], 0.12, "sawtooth", 0.16);
  }

  levelClear() {
    this.arpeggio([392, 494, 587, 784], 0.13, "triangle", 0.26);
  }

  wiped() {
    this.arpeggio([392, 311, 233, 156], 0.18, "sawtooth", 0.26);
  }

  // --- synthesis --------------------------------------------------------

  private arpeggio(freqs: number[], step: number, type: OscillatorType, gain: number) {
    freqs.forEach((f, i) => this.tone(type, f, f, step * 1.4, gain, i * step));
  }

  private tone(
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    gain: number,
    delay = 0,
  ) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;

    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    // Exponential ramps cannot touch zero, hence the floors here and below.
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur);

    amp.gain.setValueAtTime(gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(amp).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private noise(
    dur: number,
    gain: number,
    filter: BiquadFilterType,
    freq: number,
    q = 0.7,
  ) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf || this.muted) return;

    const at = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // Start somewhere random in the buffer so repeated hits are not identical.
    const offset = Math.random() * (NOISE_SECONDS - dur - 0.01);

    const biq = ctx.createBiquadFilter();
    biq.type = filter;
    biq.frequency.value = freq;
    biq.Q.value = q;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(biq).connect(amp).connect(this.master);
    src.start(at, Math.max(0, offset), dur);
    src.stop(at + dur + 0.02);
  }
}

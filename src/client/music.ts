/**
 * Chiptune, synthesized like everything else here — no asset files.
 *
 * Three layers that come and go with the wave: bass alone through a lull, drums
 * once a spawn window opens, a lead arpeggio from the second wave on. A lull
 * going quiet is the point rather than decoration — it is the window a revive
 * has to fit inside, and hearing it arrive is worth more than reading it.
 *
 * ## Why the scheduling looks like this
 *
 * Notes are queued against absolute `AudioContext.currentTime` by a coarse timer
 * that runs ahead of the music. The obvious alternative — one setTimeout per
 * note — drifts audibly within seconds, because timer callbacks are not accurate
 * to the millisecond and the error accumulates. The timer here only decides
 * *what* to queue; the audio clock decides *when* it sounds.
 */

const BPM = 132;
const STEPS = 16;
const STEP_SEC = 60 / BPM / 4;
/** How often the queueing timer runs, and how far ahead it queues. */
const TICK_MS = 25;
const AHEAD_SEC = 0.12;

const MUSIC_GAIN = 0.65;
const NOISE_SEC = 0.5;

/** Semitones above the root. A minor pentatonic, which is hard to make sound wrong. */
const BASS: (number | null)[] = [0, null, null, 0, null, 7, null, null, 5, null, null, 5, null, 3, null, null];
const LEAD: (number | null)[] = [24, null, 27, null, 29, null, 27, null, 24, null, 31, null, 29, null, 27, null];
const KICK = [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const HAT = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0];

/** MIDI note number of the root. Low A. */
const ROOT = 33;

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export class Music {
  private out: GainNode;
  private noise: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  private playing = false;
  /** 0 = bass only, 1 = add drums, 2 = add lead. */
  private layers = 0;

  constructor(private ctx: AudioContext, destination: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = MUSIC_GAIN;
    this.out.connect(destination);

    const len = Math.floor(ctx.sampleRate * NOISE_SEC);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /**
   * Called every frame with the current game state. Starting and stopping is
   * handled in here so callers never have to track whether it is already going.
   */
  update(shouldPlay: boolean, spawning: boolean, waveIndex: number) {
    this.layers = !spawning ? 0 : waveIndex >= 1 ? 2 : 1;

    if (shouldPlay && !this.playing) this.start();
    else if (!shouldPlay && this.playing) this.stop();
  }

  private start() {
    this.playing = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.queue(), TICK_MS);
  }

  stop() {
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queue every step that falls inside the lookahead window. */
  private queue() {
    if (!this.playing) return;
    while (this.nextTime < this.ctx.currentTime + AHEAD_SEC) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP_SEC;
      this.step = (this.step + 1) % STEPS;
    }
  }

  private playStep(step: number, at: number) {
    const bass = BASS[step];
    if (bass !== null && bass !== undefined) {
      this.tone("triangle", hz(ROOT + bass), 0.34, 0.20, at);
    }

    if (this.layers >= 1) {
      if (KICK[step]) this.kick(at);
      if (HAT[step]) this.hat(at);
    }

    if (this.layers >= 2) {
      const lead = LEAD[step];
      if (lead !== null && lead !== undefined) {
        this.tone("square", hz(ROOT + lead), 0.11, 0.055, at);
      }
    }
  }

  private tone(type: OscillatorType, freq: number, dur: number, gain: number, at: number) {
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    // A quick attack rather than an instant one keeps square waves from clicking.
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(amp).connect(this.out);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private kick(at: number) {
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.11);
    amp.gain.setValueAtTime(0.5, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    osc.connect(amp).connect(this.out);
    osc.start(at);
    osc.stop(at + 0.15);
  }

  private hat(at: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 7000;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.14, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    src.connect(filter).connect(amp).connect(this.out);
    src.start(at, Math.random() * (NOISE_SEC - 0.06), 0.05);
    src.stop(at + 0.06);
  }
}

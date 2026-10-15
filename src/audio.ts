import type { Car } from './car';
import type { SoundEvent } from './weapons';

const REDLINE_RPM = 5600; // what a rev fraction of 1 means in pitch (the dial says 7000; a lower pitch makes it a deeper engine)
const FIRINGS_PER_REV = 2; // four cylinders, four-stroke
/** Overall level of every engine (the player's and the rivals'), relative to the original mix. */
const ENGINE_VOLUME = 0.5;
const SHIFT_CUT = 0.07; // seconds the engine cuts out on a gear change

/** Soft-clipping curve that adds the growl: harmonics build as the signal pushes into it. */
function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 512;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * One engine: a sawtooth at the cylinder firing rate with a square an octave down for weight and a second saw an
 * octave up for bite, pushed through a soft clipper and a low-pass whose cutoff opens with revs and throttle. The full
 * voice (the player's car) adds an exhaust rumble of filtered noise; the lite voice (rivals) is just the tone.
 */
class EngineVoice {
  private readonly saw: OscillatorNode;
  private readonly sub?: OscillatorNode;
  private readonly thump?: OscillatorNode;
  private readonly bite: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly out: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly rumbleGain?: GainNode;
  private lastGear = 0;
  private cutUntil = 0;

  constructor(private readonly ctx: AudioContext, destination: AudioNode, noise: AudioBuffer, full: boolean) {
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.bite = ctx.createOscillator();
    this.bite.type = 'sawtooth';
    this.bite.detune.value = 9;
    const biteGain = ctx.createGain();
    biteGain.gain.value = full ? 0.16 : 0.15;
    this.saw.connect(mix);
    this.bite.connect(biteGain).connect(mix);
    if (full) {
      this.sub = ctx.createOscillator();
      this.sub.type = 'square';
      const subGain = ctx.createGain();
      subGain.gain.value = 0.6;
      this.sub.connect(subGain).connect(mix);
      // A sine two octaves below the firing note: the chest-thump under the engine.
      this.thump = ctx.createOscillator();
      this.thump.type = 'sine';
      const thumpGain = ctx.createGain();
      thumpGain.gain.value = 0.55;
      this.thump.connect(thumpGain).connect(mix);
    }

    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(full ? 2.4 : 1.6);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1.4;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    mix.connect(shaper).connect(this.filter).connect(this.out);

    if (full) {
      const rumble = ctx.createBufferSource();
      rumble.buffer = noise;
      rumble.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 260;
      this.rumbleGain = ctx.createGain();
      this.rumbleGain.gain.value = 0;
      rumble.connect(lp).connect(this.rumbleGain).connect(this.out);
      rumble.start();
    }

    this.out.connect(this.pan).connect(destination);
    this.saw.start();
    this.bite.start();
    this.sub?.start();
    this.thump?.start();
  }

  /** `revs` as a fraction of the redline, `pedal` 0..1, `volume` 0..1 overall, `pan` -1..1. */
  update(revs: number, pedal: number, gear: number, volume: number, pan: number): void {
    const now = this.ctx.currentTime;
    const firing = (Math.max(revs, 0.05) * REDLINE_RPM * FIRINGS_PER_REV) / 60;
    const glide = 0.035;
    this.saw.frequency.setTargetAtTime(firing, now, glide);
    this.bite.frequency.setTargetAtTime(firing * 2, now, glide);
    this.sub?.frequency.setTargetAtTime(firing * 0.5, now, glide);
    this.thump?.frequency.setTargetAtTime(firing * 0.25, now, glide);
    this.filter.frequency.setTargetAtTime(190 + revs * 1400 + pedal * 1000, now, 0.05);

    // Ignition cut on a gear change: a short dip, the thing that makes shifts audible.
    if (gear !== this.lastGear && gear > 0 && this.lastGear > 0) this.cutUntil = now + SHIFT_CUT;
    this.lastGear = gear;
    const cut = now < this.cutUntil ? 0.25 : 1;
    // Louder and rougher under load, quieter and mellow when lifting off.
    const level = (0.16 + 0.2 * revs + 0.36 * pedal) * volume * cut * ENGINE_VOLUME;
    this.out.gain.setTargetAtTime(level, now, 0.02);
    this.rumbleGain?.gain.setTargetAtTime((0.1 + 0.5 * pedal) * revs * 0.9, now, 0.05);
    this.pan.pan.setTargetAtTime(pan, now, 0.05);
  }

  silence(): void {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
  }
}

/**
 * Turbo and nitro sounds for the player's car: a whistle that spools up with throttle and revs (with a lag, like a real
 * turbo), a blow-off valve hiss when the throttle is lifted off boost, and a rushing roar while nitro burns. Only cars
 * with a turbo upgrade whistle; the nitro roar is for everyone.
 */
class TurboVoice {
  private readonly whistle: OscillatorNode;
  private readonly whistleGain: GainNode;
  private readonly hiss: GainNode;
  private readonly roar: GainNode;
  private boost = 0;
  private armed = false;
  private lastTime = 0;

  constructor(private readonly ctx: AudioContext, destination: AudioNode, noise: AudioBuffer) {
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    const vibrato = ctx.createOscillator(); // a little wobble so the whine is not a test tone
    vibrato.frequency.value = 7;
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = 35;
    vibrato.connect(vibratoDepth).connect(this.whistle.frequency);
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(destination);

    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = noise;
    hissSrc.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    this.hiss = ctx.createGain();
    this.hiss.gain.value = 0;
    hissSrc.connect(hp).connect(this.hiss).connect(destination);

    const roarSrc = ctx.createBufferSource();
    roarSrc.buffer = noise;
    roarSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650;
    bp.Q.value = 0.9;
    this.roar = ctx.createGain();
    this.roar.gain.value = 0;
    roarSrc.connect(bp).connect(this.roar).connect(destination);

    this.whistle.start();
    vibrato.start();
    hissSrc.start();
    roarSrc.start();
  }

  update(car: Car): void {
    const now = this.ctx.currentTime;
    const dt = Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    // Only an upgraded turbo whistles (the stock one is a plain engine); nitro spools it on regardless.
    const fitted = Math.min(1, Math.max(0, (car.stats.nitro - 0.75) / 0.55));
    const nitro = car.nitroActive;
    const level = nitro ? Math.max(fitted, 0.7) : fitted;
    const target = car.wrecked ? 0 : nitro ? 1 : level > 0 ? car.pedal * Math.min(1, car.rpm * 1.25) : 0;
    this.boost += (target - this.boost) * Math.min(1, (target > this.boost ? 1.7 : 2.6) * dt);

    this.whistle.frequency.setTargetAtTime(1400 + this.boost * 3900, now, 0.06);
    this.whistleGain.gain.setTargetAtTime(this.boost ** 1.6 * 0.05 * (0.4 + 0.6 * level), now, 0.05);
    this.roar.gain.setTargetAtTime(nitro && !car.wrecked ? 0.16 + 0.08 * car.rpm : 0, now, 0.05);

    // Lift off hard while boosting: the blow-off valve vents with a short hiss.
    if (car.pedal > 0.8 && this.boost > 0.5) this.armed = true;
    if (this.armed && car.pedal < 0.45 && fitted > 0.05) {
      this.armed = false;
      this.hiss.gain.cancelScheduledValues(now);
      this.hiss.gain.setValueAtTime(0.1 + 0.18 * fitted, now);
      this.hiss.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    }
  }

  silence(): void {
    const now = this.ctx.currentTime;
    this.boost = 0;
    this.whistleGain.gain.setTargetAtTime(0, now, 0.04);
    this.roar.gain.setTargetAtTime(0, now, 0.04);
  }
}

/** One car's tyre squeal: band-passed noise that fades in with the slide and gets brighter with speed. */
class SquealVoice {
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode;

  constructor(private readonly ctx: AudioContext, destination: AudioNode, noise: AudioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.loopStart = Math.random() * 1.5; // so the cars do not squeal in unison
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.Q.value = 5;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    src.connect(this.filter).connect(this.gain).connect(this.pan).connect(destination);
    src.start();
  }

  update(intensity: number, speed: number, volume: number, pan: number): void {
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(intensity * 0.2 * volume, now, 0.04);
    this.filter.frequency.setTargetAtTime(1300 + speed * 22 + intensity * 500, now, 0.08);
    this.pan.pan.setTargetAtTime(pan, now, 0.05);
  }

  silence(): void {
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
  }
}

/** How hard a car's tyres are squealing, 0..1: burning rubber, a locked handbrake or a hard slide. */
function squealOf(car: Car): number {
  if (car.wrecked || car.airborne) return 0;
  const slip = Math.abs(Math.atan2(car.vl, Math.max(Math.abs(car.vf), 1)));
  const sliding = car.speed > 5 ? Math.min(1, Math.max(0, (slip - 0.12) / 0.4)) : 0;
  const locked = car.speed > 4 ? car.handbrakePull * 0.8 : 0;
  return Math.max(car.burnout, sliding, locked);
}

/**
 * Procedural engine, tyre and weapon sounds, no sample files. The audio context can only start after the player has
 * pressed a key or clicked, so everything is a no-op until then. M mutes.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private player: EngineVoice | null = null;
  private turbo: TurboVoice | null = null;
  private rivals: EngineVoice[] = [];
  private squeals: SquealVoice[] = [];
  private listenerX = 0;
  private listenerZ = 0;
  muted = false;

  constructor() {
    const start = () => this.start();
    addEventListener('pointerdown', start);
    addEventListener('keydown', (e) => {
      start();
      if (e.code === 'KeyM' && !e.repeat) this.toggleMute();
    });
  }

  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    const limiter = ctx.createDynamicsCompressor(); // stops eight engines and a firefight from clipping
    this.master.connect(limiter).connect(ctx.destination);
    this.noise = noiseBuffer(ctx, 2);
    this.player = new EngineVoice(ctx, this.master, this.noise, true);
    this.turbo = new TurboVoice(ctx, this.master, this.noise);
    this.rivals = Array.from({ length: 7 }, () => new EngineVoice(ctx, this.master!, this.noise!, false));
    this.squeals = Array.from({ length: 8 }, () => new SquealVoice(ctx, this.master!, this.noise!));
    void ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Call every frame. `racing` false (menus) silences everything. */
  update(racing: boolean, player: Car, rivals: Car[]): void {
    if (!this.ctx || !this.player || !this.turbo) return;
    this.listenerX = player.x;
    this.listenerZ = player.z;
    if (!racing) {
      this.player.silence();
      this.turbo.silence();
      this.rivals.forEach((v) => v.silence());
      this.squeals.forEach((v) => v.silence());
      return;
    }

    this.player.update(player.rpm, player.pedal, player.gear, player.wrecked ? 0 : 1, 0);
    this.turbo.update(player);
    this.squeals[0]?.update(squealOf(player), player.speed, 1, 0);
    rivals.forEach((car, i) => {
      const { near, pan } = this.hear(car.x, car.z);
      this.rivals[i]?.update(car.rpm, car.pedal, car.gear, car.wrecked ? 0 : near * near * 0.55, pan);
      this.squeals[i + 1]?.update(squealOf(car), car.speed, near * near * 0.7, pan);
    });
  }

  /** Loudness (0..1, falling off with distance) and stereo position of a sound at (x, z), as heard from the player. */
  private hear(x: number, z: number): { near: number; pan: number } {
    const dx = x - this.listenerX;
    const dz = z - this.listenerZ;
    return { near: Math.max(0, 1 - Math.hypot(dx, dz) / 75), pan: Math.max(-1, Math.min(1, dx / 35)) };
  }

  // --- One-shot effects -----------------------------------------------------------------------------------------

  /** Play the sound for a game event (a shot, an explosion...) at its place in the world. */
  playEvent(e: SoundEvent): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const dx = e.x - this.listenerX;
    const dz = e.z - this.listenerZ;
    const reach = e.type === 'explosion' ? 160 : 110;
    const volume = Math.max(0, 1 - Math.hypot(dx, dz) / reach) ** 1.5;
    if (volume < 0.02) return;

    const out = ctx.createGain();
    out.gain.value = volume;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, dx / 35));
    out.connect(pan).connect(this.master);
    const t = ctx.currentTime;

    switch (e.type) {
      case 'gun':
        this.noiseBurst(out, t, 0.05, 'highpass', 900, 900, 0.32);
        this.tone(out, t, 'sine', 200, 70, 0.07, 0.4);
        break;
      case 'hit':
        if (e.onCar) {
          this.tone(out, t, 'triangle', 1250, 520, 0.1, 0.3); // a metallic ping
          this.noiseBurst(out, t, 0.03, 'bandpass', 3500, 3500, 0.22);
        } else {
          this.noiseBurst(out, t, 0.05, 'bandpass', 2200, 1600, 0.2); // a dull chip off the barrier
        }
        break;
      case 'missile':
        this.noiseBurst(out, t, 0.7, 'bandpass', 350, 3200, 0.5, 0.03); // the whoosh sweeping up
        this.tone(out, t, 'sine', 170, 60, 0.2, 0.55);
        break;
      case 'explosion': {
        const size = Math.max(0.6, Math.min(1.9, (e.size ?? 6.5) / 6.5));
        this.noiseBurst(out, t, 1.1 * size, 'lowpass', 2400, 140, 0.9, 0.006); // the blast, rumbling away
        this.tone(out, t, 'sine', 120, 34, 0.85 * size, 0.85); // the boom
        this.noiseBurst(out, t + 0.04, 0.35, 'highpass', 3000, 3000, 0.22); // debris
        break;
      }
      case 'crash': {
        // Car meets car: a crunch of bodywork, a thud and a clank of loose metal, all bigger for a harder hit.
        const power = Math.max(0.35, Math.min(1.5, (e.size ?? 5) / 9));
        this.noiseBurst(out, t, 0.28, 'bandpass', 1500, 380, 0.7 * power, 0.004);
        this.tone(out, t, 'sine', 150, 52, 0.22, 0.75 * power);
        this.tone(out, t, 'square', 720, 690, 0.12, 0.16 * power);
        this.tone(out, t + 0.015, 'triangle', 1170, 1100, 0.15, 0.2 * power);
        if (power > 0.9) this.noiseBurst(out, t + 0.05, 0.3, 'highpass', 2800, 2800, 0.22); // glass and trim flying
        break;
      }
      case 'wall': {
        // Car meets barrier: a dull concrete-and-sheet-metal thud with a rattle, bigger for a harder hit.
        const power = Math.max(0.35, Math.min(1.5, (e.size ?? 5) / 9));
        this.tone(out, t, 'sine', 120, 42, 0.24, 0.8 * power);
        this.noiseBurst(out, t, 0.24, 'bandpass', 900, 280, 0.6 * power, 0.004);
        this.tone(out, t + 0.01, 'square', 430, 380, 0.1, 0.12 * power);
        if (power > 0.9) this.noiseBurst(out, t + 0.04, 0.22, 'highpass', 2500, 2500, 0.18);
        break;
      }
      case 'scrape': {
        // Bodywork dragging along the barrier: a short grinding rasp, harsher the faster it slides.
        const power = Math.max(0.3, Math.min(1.2, (e.size ?? 8) / 16));
        this.noiseBurst(out, t, 0.16, 'bandpass', 1900, 1300, 0.28 * power, 0.01);
        this.tone(out, t, 'sawtooth', 260 + 120 * power, 230 + 90 * power, 0.14, 0.07 * power);
        break;
      }
      case 'mineDrop':
        this.tone(out, t, 'sine', 320, 110, 0.14, 0.5);
        this.noiseBurst(out, t, 0.04, 'bandpass', 1800, 1800, 0.2);
        this.tone(out, t + 1.0, 'sine', 1500, 1500, 0.08, 0.14); // the beep when it arms
        break;
      case 'oil':
        this.noiseBurst(out, t, 0.3, 'bandpass', 800, 260, 0.4, 0.01); // a wet splat
        this.tone(out, t, 'sine', 140, 70, 0.12, 0.35);
        break;
    }
  }

  /** A burst of filtered noise: the filter sweeps from `from` to `to` Hz over its length. */
  private noiseBurst(out: AudioNode, t: number, length: number, type: BiquadFilterType, from: number, to: number, peak: number, attack = 0.003): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = type === 'bandpass' ? 1.1 : 0.7;
    filter.frequency.setValueAtTime(from, t);
    if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, t + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(gain).connect(out);
    src.start(t, Math.random() * Math.max(0.1, 2 - length), length + 0.02);
  }

  /** A pitched blip gliding from `from` to `to` Hz and fading out. */
  private tone(out: AudioNode, t: number, type: OscillatorType, from: number, to: number, length: number, peak: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }
}

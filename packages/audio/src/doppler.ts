/// <reference lib="esnext.disposable" preserve="true" />
import type { PositionalAudio } from './audio.js';
import { playbackRateModifiers } from './rate-control.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Optional Doppler controller settings. Scene distances are metres, time is seconds. */
export interface AudioDopplerOptions {
  /** Sound speed in the stationary medium. Finite and positive. Default 343 m/s. */
  speedOfSound?: number;
  /** Authored playback rate, before Doppler. Default the sound's current playbackRate. */
  playbackRate?: number;
}

/**
 * Estimates source and listener velocities after their poses update, then shifts buffer playback pitch.
 * Authored sound/pool playbackRate writes compose with Doppler; the sound getter reports the effective rate.
 * Independent of rendering backend. No retarded-time propagation or sonic booms.
 */
export class AudioDoppler {
  readonly sound: PositionalAudio;
  readonly speedOfSound: number;
  private rate: number;
  private amount = 1;
  private time: number | undefined;
  private readonly previousSource = new Float64Array(3);
  private readonly previousListener = new Float64Array(3);
  private disposed = false;
  private writing = false;
  private readonly live: boolean;
  private readonly onStateChange = (): void => { this.reset(); };

  constructor(sound: PositionalAudio, options: AudioDopplerOptions = {}) {
    this.sound = sound;
    this.live = typeof (sound.context as OfflineAudioContext).startRendering !== 'function';
    this.speedOfSound = options.speedOfSound ?? 343;
    if (!Number.isFinite(this.speedOfSound) || this.speedOfSound <= 0)
      throw rangeError('Doppler speedOfSound must be finite and positive; use 343 for air in metres', 'state');
    this.rate = options.playbackRate ?? sound.playbackRate;
    this.validateRate(this.rate);
    this.checkSource();
    if (playbackRateModifiers.has(sound)) throw fault('attached', 'This sound already has Doppler; dispose its controller first', 'state');
    sound.playbackRate = this.rate;
    playbackRateModifiers.set(sound, {validate: this.validateRate, apply: value => {
      if (this.writing) return value;
      this.validateRate(value);
      this.rate = value;
      return value * this.amount;
    }});
    if (this.live) sound.context.addEventListener('statechange', this.onStateChange);
    sound.listener.addSource(this);
  }

  /** Current Doppler multiplier, independent of the authored playback rate. */
  get ratio(): number { return this.amount; }
  /** Authored rate; writes on the sound and pool/event plays also update this value. */
  get playbackRate(): number { return this.rate; }
  set playbackRate(value: number) {
    this.assertLive();
    this.validateRate(value);
    this.sound.playbackRate = value;
  }

  /** Sample current world poses. Live contexts use the monotonic frame clock, offline contexts use audio time. */
  update(): void {
    this.assertLive();
    if (this.sound.isDisposed || this.sound.sourceType !== 'buffer') {
      this.dispose();
      return;
    }
    const context = this.sound.context;
    if (this.live && context.state !== 'running') {
      this.reset();
      return;
    }
    const now = this.live ? performance.now() / 1000 : context.currentTime;
    const source = this.sound.worldPosition, listener = this.sound.listener.position;
    if (this.time !== undefined && now === this.time) return;
    let ratio = 1;
    if (this.time !== undefined && now > this.time) {
      const dt = now - this.time;
      const sourceStep = Math.hypot(source[0]-this.previousSource[0],source[1]-this.previousSource[1],source[2]-this.previousSource[2]);
      const listenerStep = Math.hypot(listener[0]-this.previousListener[0],listener[1]-this.previousListener[1],listener[2]-this.previousListener[2]);
      // A long render gap or motion outside the subsonic model is a cut, not a velocity sample.
      const cut = this.live && (dt > 0.25 || Math.max(sourceStep, listenerStep) / dt > 0.95 * this.speedOfSound);
      const distance = Math.hypot(source[0] - listener[0], source[1] - listener[1], source[2] - listener[2]);
      if (!cut && distance > 0) {
        let vs = 0, vl = 0;
        for (let i = 0; i < 3; i++) {
          const direction = (source[i] - listener[i]) / distance;
          vs += ((source[i] - this.previousSource[i]) / dt) * direction;
          vl += ((listener[i] - this.previousListener[i]) / dt) * direction;
        }
        const mach = (v: number): number => Math.max(-0.95, Math.min(0.95, v / this.speedOfSound));
        ratio = (1 + mach(vl)) / (1 + mach(vs));
      }
    }
    this.previousSource.set(source);
    this.previousListener.set(listener);
    this.time = now;
    this.amount = ratio;
    this.applyRate();
  }

  /** Clear velocity history after a teleport or camera cut; live context state changes reset automatically. */
  reset(): void {
    this.assertLive();
    this.time = undefined;
    this.amount = 1;
    this.applyRate();
  }
  /** Unregister and restore authored playback rate. Idempotent; also called by listener teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.sound.listener.removeSource(this);
    if (this.live) this.sound.context.removeEventListener('statechange', this.onStateChange);
    playbackRateModifiers.delete(this.sound);
    this.sound.playbackRate = this.rate;
    this.disposed = true;
  }
  private applyRate(): void {
    const value = this.rate * this.amount;
    if (this.sound.playbackRate === value) return;
    this.writing = true;
    try { this.sound.playbackRate = value; } finally { this.writing = false; }
  }
  private checkSource(): void {
    if (this.sound.isDisposed || !this.sound.buffer || this.sound.sourceType !== 'buffer')
      throw fault('unsupported', 'Doppler needs an AudioBuffer source; call sound.setBuffer before attaching');
  }
  private validateRate(value: number): void {
    // A buffer's AudioParam is a float32; reserve the largest possible Doppler multiplier (39).
    if (!Number.isFinite(value) || value < 0 || value > 3.4028234663852886e38 / 39)
      throw rangeError('Doppler playbackRate must be finite, nonnegative and fit a float32 after a 39x shift', 'state');
  }
  private assertLive(): void {
    if (this.disposed) throw fault('disposed', 'AudioDoppler is disposed; create a new controller');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}

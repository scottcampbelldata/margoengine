/// <reference lib="esnext.disposable" preserve="true" />
import type { PositionalAudio } from './audio.js';
import { fault, rangeError } from '../../shared/errors.js';

const controlled = new WeakSet<PositionalAudio>();

/** Optional Doppler controller settings. Scene distances are metres, time is audio-clock seconds. */
export interface AudioDopplerOptions {
  /** Sound speed in the stationary medium. Finite and positive. Default 343 m/s. */
  speedOfSound?: number;
  /** Authored playback rate, before Doppler. Default the sound's current playbackRate. */
  playbackRate?: number;
}

/**
 * Estimates source and listener velocities after their poses update, then shifts buffer playback pitch.
 * Owns sound.playbackRate while attached; change this controller's playbackRate for authored pitch.
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

  constructor(sound: PositionalAudio, options: AudioDopplerOptions = {}) {
    this.sound = sound;
    this.speedOfSound = options.speedOfSound ?? 343;
    if (!Number.isFinite(this.speedOfSound) || this.speedOfSound <= 0)
      throw rangeError('Doppler speedOfSound must be finite and positive; use 343 for air in metres', 'state');
    this.rate = options.playbackRate ?? sound.playbackRate;
    this.validateRate(this.rate);
    this.checkSource();
    if (controlled.has(sound)) throw fault('attached', 'This sound already has Doppler; dispose its controller first', 'state');
    sound.playbackRate = this.rate;
    sound.listener.addSource(this);
    controlled.add(sound);
  }

  /** Current Doppler multiplier, independent of the authored playback rate. */
  get ratio(): number {
    return this.amount;
  }
  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    this.assertLive();
    this.validateRate(value);
    this.rate = value;
    this.sound.playbackRate = value * this.amount;
  }

  /** Sample current world poses. Called automatically after the sound by its listener. */
  update(): void {
    this.assertLive();
    if (!this.sound.buffer && !this.sound.source) {
      this.dispose();
      return;
    }
    this.checkSource();
    const now = this.sound.context.currentTime;
    const source = this.sound.worldPosition,
      listener = this.sound.listener.position;
    // Repeated frames during suspension must not consume a displacement or divide by zero.
    if (this.time !== undefined && now === this.time) return;
    let ratio = 1;
    if (this.time !== undefined && now > this.time) {
      const dt = now - this.time;
      const dx = source[0] - listener[0],
        dy = source[1] - listener[1],
        dz = source[2] - listener[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 0) {
        let vs = 0,
          vl = 0;
        for (let i = 0; i < 3; i++) {
          const direction = (source[i] - listener[i]) / distance;
          vs += ((source[i] - this.previousSource[i]) / dt) * direction;
          vl += ((listener[i] - this.previousListener[i]) / dt) * direction;
        }
        // n points listener -> source: positive listener speed approaches, positive source speed recedes.
        // Clamp each radial Mach number to keep the subsonic approximation positive and bounded.
        const mach = (v: number): number => Math.max(-0.95, Math.min(0.95, v / this.speedOfSound));
        ratio = (1 + mach(vl)) / (1 + mach(vs));
      }
    }
    this.previousSource.set(source);
    this.previousListener.set(listener);
    this.time = now;
    this.amount = ratio;
    if (this.sound.playbackRate !== this.rate * ratio) this.sound.playbackRate = this.rate * ratio;
  }

  /** Clear velocity history after a teleport, camera cut or clock discontinuity; restore authored pitch. */
  reset(): void {
    this.assertLive();
    this.time = undefined;
    this.amount = 1;
    this.sound.playbackRate = this.rate;
  }
  /** Unregister and restore authored playback rate. Idempotent; also called by listener teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.sound.listener.removeSource(this);
    controlled.delete(this.sound);
    this.sound.playbackRate = this.rate;
    this.disposed = true;
  }
  private checkSource(): void {
    if (!this.sound.buffer || (this.sound.source && !('playbackRate' in this.sound.source)))
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
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

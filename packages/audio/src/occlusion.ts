/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Raycaster } from '@margoengine/bvh';
import type { PositionalAudio } from './audio.js';
import { smoothParam } from './math.js';
import { fault } from '../../shared/errors.js';

/** Geometry-driven attenuation settings. Distances use scene metres. */
export interface AudioOcclusionOptions {
  /** Radius of the five-ray source cross. Zero traces only the centre. Default 0.25 m. */
  radius?: number;
  /** Linear gain with every ray blocked. Default 0.25, range 0..1. */
  blockedGain?: number;
  /** Low-pass cutoff with every ray blocked. Default 800 Hz, range 10..min(20000, Nyquist). */
  blockedFrequency?: number;
  /** Smoothing time constant in seconds. Default listener.smoothing. */
  smoothing?: number;
  /** Additional blocker predicate. Default all visible meshes except the source and followed listener mesh. */
  filter?: (mesh: Mesh) => boolean;
  /** Cancel creation while the optional BVH module loads. Default none. */
  signal?: AbortSignal;
}

function bounded(value: number, lo: number, hi: number, label: string): number {
  if (!Number.isFinite(value) || value < lo || value > hi)
    throw new RangeError(`${label} needs a finite value in ${lo}..${hi}; choose a value in that range`);
  return value;
}

/**
 * Five CPU geometry rays control a low-pass filter and a separate gain in a positional sound's filter chain.
 * Registered with the sound's listener, after the sound's pose update. Works with WebGPU and WebGL2.
 * This is a tunable obstruction model, not a diffraction or acoustic material simulation.
 */
export class AudioOcclusion {
  /** The controlled sound, whose ordinary volume and filters remain independent. */
  readonly sound: PositionalAudio;
  /** Owned low-pass node. Do not disconnect it or replace the controlled sound's filters while active. */
  readonly lowpass: BiquadFilterNode;
  /** Owned attenuation node. */
  readonly attenuation: GainNode;
  private readonly ray: Raycaster;
  private readonly radius: number;
  private readonly level: number;
  private readonly frequency: number;
  private readonly openFrequency: number;
  private readonly smoothing: number;
  private amount = 0;
  private disposed = false;
  private written = false;

  /** Load the existing BVH implementation lazily, without pulling it into the audio root or import-time graph. */
  static async create(sound: PositionalAudio, options: AudioOcclusionOptions = {}): Promise<AudioOcclusion> {
    const signal = options.signal,
      filter = options.filter;
    signal?.throwIfAborted();
    const radius = bounded(options.radius ?? 0.25, 0, 100, 'Occlusion radius');
    const level = bounded(options.blockedGain ?? 0.25, 0, 1, 'Occlusion blockedGain');
    const frequency = bounded(
      options.blockedFrequency ?? 800,
      10,
      Math.min(20000, sound.context.sampleRate / 2),
      'Occlusion blockedFrequency',
    );
    const smoothing = bounded(options.smoothing ?? sound.listener.smoothing, 0, 60, 'Occlusion smoothing');
    if (filter !== undefined && typeof filter !== 'function')
      throw new TypeError('Occlusion filter needs a predicate; pass a function accepting a mesh');
    const { Raycaster } = await import('@margoengine/bvh');
    signal?.throwIfAborted();
    return new AudioOcclusion(sound, new Raycaster(), {
      filter,
      radius,
      blockedGain: level,
      blockedFrequency: frequency,
      smoothing,
    });
  }

  private constructor(
    sound: PositionalAudio,
    ray: Raycaster,
    options: Required<Pick<AudioOcclusionOptions, 'radius' | 'blockedGain' | 'blockedFrequency' | 'smoothing'>> &
      AudioOcclusionOptions,
  ) {
    this.sound = sound;
    this.ray = ray;
    this.radius = options.radius;
    this.level = options.blockedGain;
    this.frequency = options.blockedFrequency;
    this.smoothing = options.smoothing;
    this.openFrequency = Math.min(20000, sound.context.sampleRate / 2);
    this.lowpass = sound.context.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = -3.01029995664;
    this.lowpass.frequency.value = this.openFrequency;
    this.attenuation = sound.context.createGain();
    ray.firstHitOnly = true;
    ray.side = 'double';
    ray.near = 0.001;
    ray.filter = (mesh) => mesh !== sound.mesh && mesh !== sound.listener.following && (options.filter?.(mesh) ?? true);
    sound.setFilters([...sound.getFilters(), this.lowpass, this.attenuation]);
    sound.listener.addSource(this);
  }

  /** Fraction of blocked rays, 0 clear through 1 fully occluded. Partial coverage models obstruction. */
  get blocked(): number {
    return this.amount;
  }

  /** Recompute after current world matrices and sound/listener poses. Called automatically by listener.update(). */
  update(engine: EngineKernel | null = this.sound.listener.attachedEngine): void {
    if (this.disposed) throw fault('disposed', 'AudioOcclusion is disposed; create a new controller');
    if (!engine || engine.disposed)
      throw fault(
        'state',
        'AudioOcclusion needs a live engine; attach the sound listener to an engine before updating',
      );
    const p = this.sound.worldPosition,
      l = this.sound.listener.position;
    const dx = p[0] - l[0],
      dy = p[1] - l[1],
      dz = p[2] - l[2];
    const distance = Math.hypot(dx, dy, dz);
    let blocked = 0;
    const count = this.radius === 0 ? 1 : 5;
    if (distance > 0.002) {
      const x = dx / distance,
        y = dy / distance,
        z = dz / distance;
      // Orthonormal plane perpendicular to the propagation direction, including vertical rays.
      const horizontal = Math.abs(y) < 0.9;
      const ux = horizontal ? z : 0,
        uy = horizontal ? 0 : -z,
        uz = horizontal ? -x : y;
      const length = Math.hypot(ux, uy, uz);
      const u = [ux / length, uy / length, uz / length];
      const v = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]];
      for (let i = 0; i < count; i++) {
        const axis = i < 3 ? u : v;
        const scale = i === 0 ? 0 : i % 2 === 1 ? this.radius : -this.radius;
        const d = [dx + axis[0] * scale, dy + axis[1] * scale, dz + axis[2] * scale];
        this.ray.set(l, d);
        this.ray.far = Math.hypot(...d) - 0.001;
        if (this.ray.intersectEngine(engine, { refresh: i === 0 }).length) blocked++;
      }
    }
    this.amount = blocked / count;
    const gain = 1 + (this.level - 1) * this.amount;
    const cutoff = this.openFrequency * (this.frequency / this.openFrequency) ** this.amount;
    smoothParam(this.attenuation.gain, gain, this.sound.context, this.smoothing, !this.written);
    smoothParam(this.lowpass.frequency, cutoff, this.sound.context, this.smoothing, !this.written);
    this.written = true;
  }

  /** Remove only the owned nodes, preserving caller filters and restoring the sound's direct path. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    const filters = this.sound.getFilters();
    if (filters.includes(this.lowpass) || filters.includes(this.attenuation))
      this.sound.setFilters(filters.filter((node) => node !== this.lowpass && node !== this.attenuation));
    this.lowpass.disconnect();
    this.attenuation.disconnect();
    this.sound.listener.removeSource(this);
    this.disposed = true;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

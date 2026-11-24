/// <reference lib="esnext.disposable" preserve="true" />
import type { AudioListener } from './listener.js';
import type { PositionalAudio } from './audio.js';
import { AudioVoicePool, type AudioVoicePoolOptions } from './voices.js';
import type { Vec3 } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Random or ordered one-shot sound selection. No loading is performed by a container. */
export interface AudioEventOptions {
  /** Selection order. Random avoids the immediately previous buffer index. Default 'random'. */
  mode?: 'random' | 'sequence';
  /** Independent voices per buffer, stealing that buffer's oldest when full. Default 4. */
  voices?: number;
  /** Uniform linear volume range, each endpoint in 0..1. Default [1, 1]. */
  volume?: readonly [number, number];
  /** Uniform pitch variation in cents, each endpoint in -4800..4800. Default [0, 0]. */
  pitch?: readonly [number, number];
  /** Minimum audio-clock seconds between accepted plays. Default 0. */
  cooldown?: number;
  /** Uniform draw in [0, 1), for reproducible choices. Default Math.random. */
  random?: () => number;
  /** Shared positional/clip options. Default AudioVoicePool defaults, with looping disabled. */
  voiceOptions?: Omit<AudioVoicePoolOptions, 'voices' | 'volume' | 'playbackRate' | 'detune' | 'loop' | 'loopStart' | 'loopEnd'>;
}

function interval(value: readonly [number, number], lo: number, hi: number, name: string): readonly [number, number] {
  if (value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < lo || value[1] > hi || value[0] > value[1])
    throw rangeError(`Audio event ${name} needs an ordered pair in ${lo}..${hi}; pass [minimum, maximum]`, 'state');
  return [value[0], value[1]];
}

/**
 * Random and sequence sound containers with per-play volume/pitch variation and an audio-clock cooldown.
 * Reuses AudioVoicePool for overlapping playback, source ownership and voice stealing on every rendering backend.
 */
export class AudioEventContainer {
  readonly listener: AudioListener;
  private readonly pools: AudioVoicePool[] = [];
  private readonly mode: 'random' | 'sequence';
  private readonly volume: readonly [number, number];
  private readonly pitch: readonly [number, number];
  private readonly cooldown: number;
  private readonly random: () => number;
  private previous = -1;
  private next = 0;
  private lastTime = -Infinity;
  private disposed = false;

  constructor(listener: AudioListener, buffers: readonly AudioBuffer[], options: AudioEventOptions = {}) {
    this.listener = listener;
    if (!buffers.length || buffers.some(buffer => !Number.isFinite(buffer?.duration) || buffer.duration <= 0))
      throw fault('state', 'Audio events need nonempty decoded buffers; use listener.load or context.createBuffer');
    this.mode = options.mode ?? 'random';
    if (this.mode !== 'random' && this.mode !== 'sequence')
      throw fault('state', "Audio event mode must be 'random' or 'sequence'; choose one of those modes");
    this.volume = interval(options.volume ?? [1, 1], 0, 1, 'volume');
    this.pitch = interval(options.pitch ?? [0, 0], -4800, 4800, 'pitch');
    this.cooldown = options.cooldown ?? 0;
    if (!Number.isFinite(this.cooldown) || this.cooldown < 0)
      throw rangeError('Audio event cooldown must be finite and nonnegative; use audio-clock seconds', 'state');
    this.random = options.random ?? Math.random;
    if (typeof this.random !== 'function') throw fault('state', 'Audio event random needs a function returning a value in [0, 1)');
    try {
      for (const buffer of buffers)
        this.pools.push(new AudioVoicePool(listener, buffer, {
          ...options.voiceOptions, voices: options.voices ?? 4, volume: 1, playbackRate: 1, detune: 0, loop: false,
        }));
      listener.addSource(this);
    } catch (error) {
      for (const pool of this.pools) pool.dispose();
      throw error;
    }
  }

  /** Index of the last accepted buffer, or -1 before the first play. Cooldown rejection does not change it. */
  get lastIndex(): number {
    return this.previous;
  }

  /** Play at a world position (default origin). Returns the voice, or null during cooldown. */
  play(position: Vec3 = [0, 0, 0]): PositionalAudio | null {
    this.assertLive();
    if (position.length !== 3 || !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2]))
      throw rangeError('Audio event position needs three finite coordinates; pass [x, y, z] in metres', 'state');
    const now = this.listener.context.currentTime;
    if (now >= this.lastTime && now - this.lastTime < this.cooldown) return null;
    const count = this.pools.length;
    let index = this.next;
    if (this.mode === 'random') {
      const exclude = count > 1 && this.previous >= 0;
      index = count === 1 ? 0 : Math.floor(this.draw() * (count - Number(exclude)));
      if (exclude && index >= this.previous) index++;
    }
    const volume = this.sample(this.volume);
    const playbackRate = 2 ** (this.sample(this.pitch) / 1200);
    const voice = this.pools[index].play(position, { volume, playbackRate });
    this.previous = index;
    this.next = (index + 1) % count;
    this.lastTime = now;
    return voice;
  }

  /** Stop sounding voices, retaining sequence/random history and cooldown. */
  stopAll(): void {
    this.assertLive();
    for (const pool of this.pools) pool.stopAll();
  }
  /** @internal The container has no frame work; registration provides listener-owned teardown. */
  update(): void {}
  /** Release all voices and unregister from the listener. Shared buffers remain usable. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.removeSource(this);
    for (const pool of this.pools) pool.dispose();
  }
  private draw(): number {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw rangeError('Audio event random must return a finite value in [0, 1); use a uniform random generator', 'state');
    return value;
  }
  private sample(range: readonly [number, number]): number {
    return range[0] === range[1] ? range[0] : range[0] + this.draw() * (range[1] - range[0]);
  }
  private assertLive(): void {
    if (this.disposed) throw fault('disposed', 'AudioEventContainer is disposed; create a new container');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

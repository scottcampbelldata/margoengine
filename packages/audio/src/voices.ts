/// <reference lib="esnext.disposable" preserve="true" />
import { margoError } from '../../shared/errors.js';
import { PositionalAudio, type PositionalAudioOptions } from './audio.js';
import type { AudioListener } from './listener.js';
import type { Vec3 } from './math.js';

/**
 * Options of {@link AudioVoicePool}: the {@link PositionalAudioOptions} every voice shares (distance model, cone,
 * volume, playbackRate...), plus how many voices there are. Voices take no mesh, autoplay or filter chain.
 */
export interface AudioVoicePoolOptions extends Omit<PositionalAudioOptions, 'mesh' | 'autoplay' | 'filters'> {
  /** Voices that can sound at once, default 8. A play while every voice sounds steals the oldest. */
  voices?: number;
}

/**
 * Overlapping one-shot sounds from one decoded buffer, such as footsteps, block breaks and hits: `voices`
 * {@link PositionalAudio} voices share the buffer. Each {@link AudioVoicePool.play} takes a voice that is not sounding
 * or, when every voice sounds, steals the one that started longest ago (cut off at once). A voice jumps to its new
 * position and level, never easing from the previous play's.
 */
export class AudioVoicePool {
  /** The voices, in creation order. */
  readonly voices: readonly PositionalAudio[];
  /** Start order of each voice (0 = never played), so the oldest is the lowest. */
  private readonly started: number[];
  private plays = 0;
  private readonly volume: number;
  private readonly playbackRate: number;
  private disposed = false;

  constructor(
    readonly listener: AudioListener,
    readonly buffer: AudioBuffer,
    options: AudioVoicePoolOptions = {},
  ) {
    const { voices = 8, ...shared } = options;
    if (!Number.isSafeInteger(voices) || voices < 1)
      throw new RangeError(`AudioVoicePool voices is ${voices}; pass a whole number of 1 or more`);
    if (typeof buffer?.duration !== 'number')
      throw new TypeError('AudioVoicePool needs a decoded AudioBuffer; pass the result of listener.load(url)');
    this.volume = shared.volume ?? 1;
    this.playbackRate = shared.playbackRate ?? 1;
    const list: PositionalAudio[] = [];
    try {
      for (let i = 0; i < voices; i++) list.push(new PositionalAudio(listener, shared).setBuffer(buffer));
    } catch (error) {
      for (const voice of list) voice.dispose();
      throw error;
    }
    this.voices = list;
    this.started = list.map(() => 0);
  }

  /**
   * Plays the buffer once at world `position` on a free voice, or steals the voice that started longest ago.
   * `volume` and `playbackRate` (pitch: vary it a little per play for footsteps and block sounds) apply to this play
   * only and default to the pool's options. Returns the voice, which can be stopped or moved while it sounds.
   */
  play(position: Vec3, options: { volume?: number; playbackRate?: number } = {}): PositionalAudio {
    if (this.disposed) throw margoError('disposed', 'AudioVoicePool is disposed; create a new AudioVoicePool');
    let index = this.voices.findIndex((voice) => !voice.isPlaying);
    if (index < 0) index = this.started.indexOf(Math.min(...this.started));
    const voice = this.voices[index],
      listener = this.listener,
      smoothing = listener.smoothing;
    voice.stop();
    listener.smoothing = 0;
    try {
      voice.setPosition(position[0], position[1], position[2]);
      voice.volume = options.volume ?? this.volume;
      voice.playbackRate = options.playbackRate ?? this.playbackRate;
    } finally {
      listener.smoothing = smoothing;
    }
    this.started[index] = ++this.plays;
    return voice.play();
  }

  /** Stops every voice. */
  stopAll(): this {
    for (const voice of this.voices) voice.stop();
    return this;
  }

  /** Stops and disposes every voice. The buffer stays usable (the listener's load cache may share it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) voice.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

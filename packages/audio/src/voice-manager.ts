/// <reference lib="esnext.disposable" preserve="true" />
import { Audio, PositionalAudio, distanceGain, coneGain, type AudioListener } from '@margoengine/audio';
import { fault, rangeError } from '../../shared/errors.js';

/** One listener-wide physical voice budget, shared across sounds and pools. */
export interface AudioVoiceManagerOptions {
  /** Maximum simultaneous buffer sources. Default 32; 0 virtualizes every voice. */
  maxVoices?: number;
  /** Estimated linear gain at/below which a voice is virtual. Default 0.0001. */
  threshold?: number;
}
/** Priority and optional app-specific occlusion/bus gain for a managed sound. */
export interface AudioManagedVoiceOptions {
  /** Greater finite priority wins before estimated audibility. Default 0. */
  priority?: number;
  /** Additional nonnegative finite gain estimate. Default returns 1. No graph mutation. */
  gain?: () => number;
}
const owners = new WeakMap<Audio, AudioManagedVoice>();
const nonnegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0)
    throw rangeError(`${name} must be finite and nonnegative; choose a valid value`, 'state');
  return value;
};
const priorityValue = (value: number): number => {
  if (!Number.isFinite(value)) throw rangeError('Voice priority must be finite; choose a numeric priority', 'state');
  return value;
};

/**
 * Shared cap with priority/audibility ranking. Virtual voices have no buffer source,
 * but their audio-clock phase continues. Control transport and pitch through the returned handles.
 */
export class AudioVoiceManager {
  private readonly voices = new Set<AudioManagedVoice>();
  private cap: number;
  private quiet: number;
  private disposed = false;

  constructor(
    readonly listener: AudioListener,
    options: AudioVoiceManagerOptions = {},
  ) {
    this.cap = this.validCap(options.maxVoices ?? 32);
    this.quiet = nonnegative(options.threshold ?? 0.0001, 'Voice threshold');
    listener.addSource(this);
  }
  /** Physical budget; reducing it immediately virtualizes the lowest-ranked voices. */
  get maxVoices(): number {
    return this.cap;
  }
  set maxVoices(value: number) {
    this.assertLive();
    this.cap = this.validCap(value);
    this.update();
  }
  /** Linear quiet threshold; changes apply immediately. */
  get threshold(): number {
    return this.quiet;
  }
  set threshold(value: number) {
    this.assertLive();
    this.quiet = nonnegative(value, 'Voice threshold');
    this.update();
  }
  /** Number of currently allocated playing buffer sources. */
  get activeCount(): number {
    return [...this.voices].filter((v) => v.isPlaying && !v.isVirtual).length;
  }
  /** Playing logical voices without a source node. */
  get virtualCount(): number {
    return [...this.voices].filter((v) => v.isVirtual).length;
  }

  /** Register a decoded-buffer sound, including a positional/pool voice. The caller keeps ownership of the sound. */
  add(sound: Audio, options: AudioManagedVoiceOptions = {}): AudioManagedVoice {
    this.assertLive();
    if (owners.has(sound))
      throw fault(
        'attached',
        'Sound already has a voice manager; dispose its handle before registering again',
        'state',
      );
    if (
      sound.isDisposed ||
      sound.listener !== this.listener ||
      sound.sourceType !== 'buffer' ||
      !sound.buffer ||
      !Number.isFinite(sound.buffer.duration) ||
      sound.buffer.duration <= 0
    )
      throw fault(
        'unsupported',
        'Voice management needs a live decoded-buffer sound on the same listener; set its buffer before registering',
      );
    priorityValue(options.priority ?? 0);
    nonnegative(sound.playbackRate * 2 ** (sound.detune / 1200), 'Effective playback rate');
    if (options.gain !== undefined && typeof options.gain !== 'function')
      throw fault('state', 'Voice gain must be a function; return an additional linear gain');
    const voice = new AudioManagedVoice(this, sound, options);
    owners.set(sound, voice);
    this.voices.add(voice);
    this.update();
    return voice;
  }

  /** Re-rank after listener/sound pose updates. Called automatically by listener updates. */
  update(): void {
    if (this.disposed) return;
    for (const voice of this.voices) {
      if (!voice.sound.isDisposed) voice.sound.update(this.listener.attachedEngine);
      voice.advance();
    }
    const candidates = [...this.voices]
      .filter((v) => v.isPlaying)
      .map((voice) => ({ voice, gain: voice.audibility() }));
    candidates.sort((a, b) => b.voice.priority - a.voice.priority || b.gain - a.gain);
    const selected = new Set(
      candidates
        .filter((c) => c.gain > this.quiet)
        .slice(0, this.cap)
        .map((c) => c.voice),
    );
    // Stop losers first: promotion never temporarily exceeds the physical cap.
    for (const voice of this.voices) if (!selected.has(voice)) voice.physical(false);
    for (const voice of selected) voice.physical(true);
  }
  /** @internal Remove a released registration. */
  remove(voice: AudioManagedVoice): void {
    this.voices.delete(voice);
    owners.delete(voice.sound);
    this.update();
  }
  /** Stop and release registrations, preserving caller-owned sounds/buffers. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.removeSource(this);
    for (const voice of [...this.voices]) voice.dispose();
  }
  private validCap(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0)
      throw rangeError('Voice cap must be a nonnegative safe integer; choose a whole number', 'state');
    return value;
  }
  private assertLive(): void {
    if (this.disposed) throw fault('disposed', 'Voice manager is disposed; create a new manager');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** A transport handle whose phase advances even while its source is virtual. */
export class AudioManagedVoice {
  private status: 'stopped' | 'playing' | 'paused' | 'ended' | 'disposed';
  private phase: number;
  private clock: number;
  private rank: number;
  private allocated = false;
  private rate: number;
  private cents: number;
  private readonly extraGain: () => number;

  constructor(
    private readonly manager: AudioVoiceManager,
    readonly sound: Audio,
    options: AudioManagedVoiceOptions,
  ) {
    this.rank = options.priority ?? 0;
    this.extraGain = options.gain ?? (() => 1);
    this.phase = sound.currentTime;
    this.clock = sound.context.currentTime;
    this.rate = sound.playbackRate;
    this.cents = sound.detune;
    this.status = sound.isPlaying ? 'playing' : 'stopped';
    sound.pause();
  }
  /** Greater priority wins before gain. */
  get priority(): number {
    return this.rank;
  }
  set priority(value: number) {
    this.assertLive();
    this.rank = priorityValue(value);
    this.manager.update();
  }
  /** Logical playback, including virtual voices. */
  get isPlaying(): boolean {
    return this.status === 'playing';
  }
  /** True only when logically playing without an allocated buffer source. */
  get isVirtual(): boolean {
    return this.isPlaying && !this.allocated;
  }
  /** Current logical buffer position, with loop-region wrapping. */
  get currentTime(): number {
    this.advance();
    return this.phase;
  }
  /** Playback multiplier. A pitch change restarts only the physical source at the exact current phase. */
  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    this.pitch(value, this.cents);
  }
  /** Detune in cents; participates in virtual phase. Default is the registered sound's value. */
  get detune(): number {
    return this.cents;
  }
  set detune(value: number) {
    this.pitch(this.rate, value);
  }

  /** Start/resume logical playback, re-evaluating the shared cap immediately. */
  play(): this {
    this.assertLive();
    if (!this.isPlaying) {
      if (this.status === 'ended') this.phase = this.sound.offset;
      this.clock = this.sound.context.currentTime;
      this.status = 'playing';
    }
    this.manager.update();
    return this;
  }
  /** Freeze logical phase and release the physical source. */
  pause(): this {
    this.assertLive();
    this.advance();
    this.status = 'paused';
    this.physical(false);
    this.manager.update();
    return this;
  }
  /** Stop and rewind to the sound's configured offset. */
  stop(): this {
    this.assertLive();
    this.status = 'stopped';
    this.physical(false);
    this.phase = this.sound.offset;
    this.manager.update();
    return this;
  }
  /** Seek in buffer seconds, preserving logical play/pause state. */
  seek(seconds: number): this {
    this.assertLive();
    nonnegative(seconds, 'Voice seek');
    this.advance();
    this.physical(false);
    this.phase = this.wrap(seconds);
    // A seek moves an ended one-shot off its end, so the next play() starts from here instead of rewinding.
    if (this.status === 'ended') this.status = 'stopped';
    this.clock = this.sound.context.currentTime;
    this.manager.update();
    return this;
  }
  /** @internal Advance logical phase and end one-shots even while virtual. */
  advance(): void {
    if (this.sound.isDisposed) {
      this.status = 'disposed';
      this.allocated = false;
      return;
    }
    const now = this.sound.context.currentTime;
    if (this.isPlaying) {
      this.phase = this.wrap(this.phase + Math.max(0, now - this.clock) * this.rate * 2 ** (this.cents / 1200));
      if (!this.sound.loop && this.phase >= this.end) {
        const notify = !this.allocated || this.sound.isPlaying;
        this.status = 'ended';
        this.physical(false);
        if (notify) this.sound.onEnded?.(this.sound);
      }
    }
    this.clock = now;
  }
  /** @internal Estimate volume, distance/cone and caller gain, without changing the graph. */
  audibility(): number {
    const sound = this.sound,
      listener = this.manager.listener;
    let gain =
      sound.gain.gain.value *
      sound.fade.gain.value *
      listener.volume *
      nonnegative(this.extraGain(), 'Additional voice gain');
    if (sound instanceof PositionalAudio) {
      const p = sound.panner,
        position = sound.worldPosition,
        distance = Math.hypot(...listener.position.map((v, i) => v - position[i]));
      gain *= distanceGain(p.distanceModel, distance, p.refDistance, p.maxDistance, p.rolloffFactor);
      gain *= coneGain(
        [position[0], position[1], position[2]],
        [sound.worldDirection[0], sound.worldDirection[1], sound.worldDirection[2]],
        [listener.position[0], listener.position[1], listener.position[2]],
        p.coneInnerAngle,
        p.coneOuterAngle,
        p.coneOuterGain,
      );
    }
    return nonnegative(gain, 'Estimated voice gain');
  }
  /** @internal Allocate/release the source without changing logical playback. */
  physical(active: boolean): void {
    if (this.sound.isDisposed) {
      this.allocated = false;
      return;
    }
    if (active && !this.allocated) {
      this.sound.seek(this.phase).play();
      this.allocated = true;
    } else if (!active && this.allocated) {
      this.sound.pause();
      this.allocated = false;
    }
  }
  /** Stop/release this handle; the underlying sound remains owned by the caller. */
  dispose(): void {
    if (this.status === 'disposed') {
      this.manager.remove(this);
      return;
    }
    this.status = 'disposed';
    this.physical(false);
    this.manager.remove(this);
  }
  private get end(): number {
    return Math.min(this.sound.buffer!.duration, this.sound.offset + (this.sound.duration ?? Infinity));
  }
  private wrap(value: number): number {
    const sound = this.sound,
      duration = sound.buffer!.duration;
    if (!sound.loop) return Math.min(value, this.end);
    const start = sound.loopStart,
      end = sound.loopEnd > 0 ? Math.min(sound.loopEnd, duration) : duration;
    return end > start ? (value < end ? value : start + ((value - start) % (end - start))) : value % duration;
  }
  private pitch(rate: number, cents: number): void {
    this.assertLive();
    nonnegative(rate, 'Voice playback rate');
    nonnegative(rate * 2 ** (cents / 1200), 'Effective voice playback rate');
    if (!Number.isFinite(cents)) throw rangeError('Voice detune must be finite; use cents', 'state');
    this.advance();
    this.physical(false);
    this.rate = rate;
    this.cents = cents;
    this.sound.playbackRate = rate;
    this.sound.detune = cents;
    this.manager.update();
  }
  private assertLive(): void {
    if (this.status === 'disposed' || this.sound.isDisposed)
      throw fault('disposed', 'Managed voice is disposed; register a live sound');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/// <reference lib="esnext.disposable" preserve="true" />
import { Animation as BaseAnimation, type AnimationOptions } from '@margoengine/animation';
import type { PBRModel } from '@margoengine/gltf-pro';
import { rangeError } from '../../shared/errors.js';
import { LoopOnce, LoopRepeat, LoopPingPong, type ActionLoop } from './mixer.js';
export { LoopOnce, LoopRepeat, LoopPingPong } from './mixer.js';
/** Optional plain-player event and iteration controls. */
export interface PlaybackOptions extends AnimationOptions {
  /** Default LoopRepeat, or LoopOnce when loop=false. */
  loopMode?: ActionLoop;
  /** Total traversals, positive integer or Infinity. Default Infinity; LoopOnce always uses one. */
  repetitions?: number;
  /** Signed multiplier on speed. Default 1. */
  timeScale?: number;
  /** Abort disposes this player and rejects its pending finished promise. */
  signal?: AbortSignal;
}
/** Loop or completion notification, delivered after the sampled pose is applied. */
export class PlaybackEvent extends Event {
  /** @internal Constructed by PlaybackAnimation. */
  constructor(
    type: 'loop' | 'finished',
    readonly animation: PlaybackAnimation,
    readonly loopDelta: number,
    readonly direction: 1 | -1,
  ) {
    super(type);
  }
}
/** Event payloads for on/addEventListener. */
export interface PlaybackEventMap {
  loop: PlaybackEvent;
  finished: PlaybackEvent;
}
const invalid = (message: string) => Object.assign(rangeError(message, 'arguments'), { code: 'arguments' });
const number = (value: number, label: string) => {
  if (!Number.isFinite(value)) throw invalid(`Invalid playback ${label}; pass finite seconds or a rate`);
  return value;
};
const cancelled = () =>
  new DOMException('Animation playback cancelled; start another play or wait on a live player', 'AbortError');

/** Plain Animation playback with repeat counts, ping-pong, events and an abortable completion promise. */
export class PlaybackAnimation extends BaseAnimation {
  /** Directed looping. Default LoopRepeat (LoopOnce when constructed with loop=false). */
  loopMode: ActionLoop;
  /** Total traversals. Default Infinity. */
  repetitions: number;
  /** Signed multiplier on Animation.options.speed. Default 1. */
  timeScale: number;
  private cursor = 0;
  private completed = 0;
  private settled = false;
  private started = false;
  private terminal = false;
  private released = false;
  private readonly events = new EventTarget();
  private promise!: Promise<PlaybackEvent>;
  private resolve!: (event: PlaybackEvent) => void;
  private reject!: (reason: unknown) => void;
  private signal?: AbortSignal;
  private readonly abort = () => this.dispose();
  /** Construct like Animation, adding loopMode, repetitions, timeScale and signal. */
  constructor(model: PBRModel, options: PlaybackOptions = {}) {
    super(model, options);
    this.loopMode = options.loopMode ?? (options.loop === false ? LoopOnce : LoopRepeat);
    this.repetitions = options.repetitions ?? Infinity;
    this.timeScale = options.timeScale ?? 1;
    this.validatePlayback();
    this.newPromise();
    this.signal = options.signal;
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.dispose();
  }
  /** Create and register in the model's scene; an already-aborted signal never registers. */
  static override attach(model: PBRModel, options: PlaybackOptions = {}): PlaybackAnimation {
    const animation = new PlaybackAnimation(model, options);
    if (!options.signal?.aborted) {
      try {
        model.root.scene.use(animation);
      } catch (error) {
        animation.dispose();
        throw error;
      }
    }
    return animation;
  }
  /** Current run's completion, renewed by play; rejects with AbortError on replacement/disposal. */
  get finished(): Promise<PlaybackEvent> {
    return this.promise;
  }
  private newPromise(): void {
    this.settled = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Consumers still observe rejection; an unobserved optional promise must not crash disposal.
    void this.promise.catch(() => {});
  }
  private validatePlayback(): void {
    if (
      ![LoopOnce, LoopRepeat, LoopPingPong].includes(this.loopMode) ||
      (this.repetitions !== Infinity && (!Number.isSafeInteger(this.repetitions) || this.repetitions < 1))
    )
      throw invalid('Invalid playback loop; choose a loop mode and a positive integer traversal count or Infinity');
    number(this.timeScale, 'timeScale');
  }
  /** Start a clip from its beginning (negative rates start at its end); renew completion on a replacement run. */
  override play(clip: string | number = 0): this {
    super.play(clip);
    if (this.started) {
      if (!this.settled) this.reject(cancelled());
      this.newPromise();
    }
    this.started = true;
    this.completed = 0;
    this.terminal = false;
    this.cursor = this.timeScale < 0 ? this.clips[this.clip].duration : 0;
    this.pose(this.cursor, 1, this.timeScale < 0);
    return this;
  }
  /** Choose a loop mode and total traversal count, without restarting the run. */
  setLoop(mode: ActionLoop, repetitions = Infinity): this {
    const oldMode = this.loopMode,
      oldCount = this.repetitions;
    this.loopMode = mode;
    this.repetitions = repetitions;
    try {
      this.validatePlayback();
    } catch (error) {
      this.loopMode = oldMode;
      this.repetitions = oldCount;
      throw error;
    }
    this.options.loop = mode !== LoopOnce;
    return this;
  }
  /** Seek total clip seconds without emitting playback events; restarts traversal counting. */
  override seek(time: number): this {
    if (number(time, 'seek') < 0) throw invalid('Playback seek must be nonnegative; pass total clip seconds >= 0');
    this.cursor = time;
    this.completed = 0;
    this.terminal = false;
    this.pose(time, this.timeScale < 0 ? -1 : 1, false);
    return this;
  }
  private mode(): ActionLoop {
    return this.loopMode === LoopRepeat && this.options.loop === false ? LoopOnce : this.loopMode;
  }
  private pose(cursor: number, direction: 1 | -1, endpoint: boolean): void {
    const duration = this.clips[this.clip]?.duration ?? 0,
      mode = this.mode();
    let time = 0;
    if (duration > 0) {
      if (mode === LoopOnce) time = Math.max(0, Math.min(duration, cursor));
      else if (mode === LoopPingPong) {
        const period = 2 * duration,
          t = ((cursor % period) + period) % period;
        time = t <= duration ? t : period - t;
      } else time = endpoint ? (direction > 0 ? duration : 0) : ((cursor % duration) + duration) % duration;
    }
    const loop = this.options.loop;
    this.options.loop = false;
    try {
      super.seek(time);
    } finally {
      this.options.loop = loop;
    }
  }
  /** Advance plain playback before world-matrix/deformation updates. */
  override onPreUpdate(delta: number): void {
    if (this.model.disposed) {
      this.dispose();
      return;
    }
    this.validatePlayback();
    const playing = this.playing;
    this.playing = false;
    try {
      super.onPreUpdate(0);
    } finally {
      this.playing = playing;
    }
    if (!playing || this.terminal) return;
    number(delta, 'delta');
    if (delta < 0) throw invalid('Playback delta must be nonnegative; reverse with timeScale');
    const step = number(delta * (this.options.speed ?? 1) * this.timeScale, 'advance');
    if (step === 0 && (this.clips[this.clip]?.duration ?? 0) > 0) return;
    const duration = this.clips[this.clip]?.duration ?? 0,
      direction: 1 | -1 = step < 0 ? -1 : 1,
      mode = this.mode();
    let next = number(this.cursor + step, 'clock'),
      crossed = 0,
      done = false;
    if (duration === 0) {
      next = 0;
      done = true;
    } else if (mode === LoopOnce) {
      done = direction > 0 ? next >= duration : next <= 0;
      next = Math.max(0, Math.min(duration, next));
    } else {
      crossed =
        direction > 0
          ? Math.floor(next / duration) - Math.floor(this.cursor / duration)
          : Math.ceil(this.cursor / duration) - Math.ceil(next / duration);
      if (!Number.isSafeInteger(crossed))
        throw invalid('Playback crossed too many loops to count exactly; use a smaller delta or rate');
      const remaining = this.repetitions - this.completed;
      if (crossed >= remaining) {
        next =
          (direction > 0
            ? Math.floor(this.cursor / duration) + remaining
            : Math.ceil(this.cursor / duration) - remaining) * duration;
        crossed = remaining;
        done = true;
      }
    }
    this.started = true;
    this.cursor = next;
    this.completed += crossed;
    this.pose(next, direction, done);
    if (done) {
      this.terminal = true;
      this.playing = false;
      this.settled = true;
      const event = new PlaybackEvent('finished', this, 0, direction);
      this.resolve(event);
      this.events.dispatchEvent(event);
    } else if (crossed) this.events.dispatchEvent(new PlaybackEvent('loop', this, crossed * direction, direction));
  }
  /** Subscribe with optional AbortSignal; returns an unsubscribe function. */
  on<K extends keyof PlaybackEventMap>(
    type: K,
    listener: (event: PlaybackEventMap[K]) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    this.events.addEventListener(type, listener as EventListener, options);
    return () => this.events.removeEventListener(type, listener as EventListener);
  }
  /** Familiar EventTarget listener API. */
  addEventListener(
    type: 'loop' | 'finished',
    listener: (event: PlaybackEvent) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.events.addEventListener(type, listener as EventListener, options);
  }
  /** Remove a previously added listener. */
  removeEventListener(
    type: 'loop' | 'finished',
    listener: (event: PlaybackEvent) => void,
    options?: EventListenerOptions | boolean,
  ): void {
    this.events.removeEventListener(type, listener as EventListener, options);
  }
  /** Await this run with independent cancellation, without stopping playback. */
  waitForFinished({ signal }: { signal?: AbortSignal } = {}): Promise<PlaybackEvent> {
    if (!signal) return this.finished;
    if (signal.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason ?? cancelled());
      };
      signal.addEventListener('abort', abort, { once: true });
      this.finished.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  /** Reject pending completion, remove abort subscription and release Animation resources. Idempotent. */
  override dispose(): void {
    if (this.released) return;
    this.released = true;
    this.playing = false;
    this.signal?.removeEventListener('abort', this.abort);
    this.signal = undefined;
    if (!this.settled) {
      this.settled = true;
      this.reject(cancelled());
    }
    super.dispose();
  }
}
export { PlaybackAnimation as Animation };

// Time series playback: a figure's frames at given times, an HTML slider (with a play button and the current time)
// over the canvas's bottom edge, and play() that steps through the frames at a frame rate, waiting for each frame's
// update before moving on, so slow updates never overlap.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Theme } from './axes.js';
import { formatValue } from './ticks.js';

/** Shows one frame: update your layers for frame `index` at `time`. May return a promise; playback waits for it. */
export type TimelineFrame = (index: number, time: number) => void | Promise<void>;

/** Options for `figure.timeline()`. */
export interface TimelineOptions {
  /** Show the slider, play button and time over the canvas. Default true. */
  readonly controls?: boolean;
  /** Text for a time in the controls. Default four significant digits. */
  readonly format?: (time: number) => string;
}

/** Options for `play()`. */
export interface PlayOptions {
  /** Frames per second. Default 10. */
  readonly fps?: number;
  /** Start again from the first frame after the last. Default false. */
  readonly loop?: boolean;
  /** Stops playback; play() then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** A figure's time series: frames, the current one, playback and the slider. Create it with `figure.timeline()`. */
export class Timeline extends EventTarget {
  /** The frame times. */
  readonly times: Float64Array;
  /** The controls' root element, or undefined with `controls: false`. */
  readonly element: HTMLDivElement | undefined;
  readonly #onFrame: TimelineFrame;
  readonly #format: (time: number) => string;
  #index = -1;
  #slider: HTMLInputElement | undefined;
  #button: HTMLButtonElement | undefined;
  #label: HTMLSpanElement | undefined;
  #playing: { stop: () => void } | undefined;
  // Frames are shown one after another: a seek waits for the frame before it.
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  /** @internal Use `figure.timeline()`. */
  constructor(
    canvas: HTMLCanvasElement | undefined,
    theme: Theme,
    times: ArrayLike<number>,
    onFrame: TimelineFrame,
    options: TimelineOptions = {},
  ) {
    super();
    if (!times || typeof times.length !== 'number' || times.length < 1)
      throw rangeError('timeline needs at least one time', 'sciviz');
    if (typeof onFrame !== 'function')
      throw typeError('timeline needs a frame callback (index, time) => void', 'sciviz');
    this.times = Float64Array.from(times);
    if (!this.times.every(Number.isFinite)) throw rangeError('timeline times must be finite numbers', 'sciviz');
    this.#onFrame = onFrame;
    this.#format = options.format ?? ((t) => formatValue(t));
    if ((options.controls ?? true) && canvas && typeof document !== 'undefined')
      this.element = this.#controls(canvas, theme);
  }

  #controls(canvas: HTMLCanvasElement, theme: Theme): HTMLDivElement {
    const host = canvas.parentElement ?? document.body;
    if (host !== document.body && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const root = document.createElement('div');
    root.dataset.scivizTimeline = '';
    root.style.cssText = `position: absolute; z-index: 1; left: ${canvas.offsetLeft + 12}px; width: ${Math.max(120, canvas.clientWidth - 24)}px; top: ${canvas.offsetTop + canvas.clientHeight - 40}px; display: flex; align-items: center; gap: 10px; padding: 4px 10px; box-sizing: border-box; border-radius: 6px; font: 12px system-ui, sans-serif; color: ${theme.text}; background: ${theme.background}cc; font-variant-numeric: tabular-nums`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '▶';
    button.setAttribute('aria-label', 'Play');
    button.style.cssText = `width: 28px; height: 24px; border: 1px solid ${theme.grid}; border-radius: 4px; background: transparent; color: ${theme.text}; cursor: pointer`;
    button.addEventListener('click', () => {
      if (this.#playing) this.pause();
      // A frame error during button playback goes to the page's error reporting (window error event, console).
      else this.play({ loop: true }).catch(reportError);
    });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(this.times.length - 1);
    slider.step = '1';
    slider.value = '0';
    slider.setAttribute('aria-label', 'Time');
    slider.style.cssText = `flex: 1; accent-color: ${theme.axis}`;
    slider.addEventListener('input', () => {
      this.pause();
      void this.seek(Number(slider.value));
    });
    const label = document.createElement('span');
    label.style.cssText = 'min-width: 6ch; text-align: right; white-space: nowrap';
    label.textContent = this.#format(this.times[0]);
    root.append(button, slider, label);
    host.append(root);
    this.#slider = slider;
    this.#button = button;
    this.#label = label;
    return root;
  }

  /** The current frame's index (-1 before the first is shown). */
  get index(): number {
    return this.#index;
  }

  /** The current frame's time (NaN before the first is shown). */
  get time(): number {
    return this.#index < 0 ? Number.NaN : this.times[this.#index];
  }

  /** True while playing. */
  get playing(): boolean {
    return this.#playing !== undefined;
  }

  /**
   * Shows frame `index` (clamped to the frames): calls the frame callback, moves the slider and sends a `time` event.
   * Resolves once the frame callback has finished.
   */
  seek(index: number): Promise<void> {
    if (this.#disposed) return Promise.reject(fault('disposed', 'Timeline disposed; create a new one', 'sciviz'));
    if (!Number.isFinite(index))
      return Promise.reject(rangeError(`seek index must be a number, got ${index}`, 'sciviz'));
    const k = Math.min(this.times.length - 1, Math.max(0, Math.round(index)));
    const run = this.#queue.then(async () => {
      if (this.#disposed) return;
      await this.#onFrame(k, this.times[k]);
      if (this.#disposed) return;
      this.#index = k;
      if (this.#slider) this.#slider.value = String(k);
      if (this.#label) this.#label.textContent = this.#format(this.times[k]);
      this.dispatchEvent(new CustomEvent('time', { detail: { index: k, time: this.times[k] } }));
    });
    // A failed frame does not block the ones after it; the caller of this seek still gets the error.
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Plays from the current frame (from the first after the last) at `fps`, waiting for each frame's callback. Resolves
   * at the last frame or on pause(); rejects with the signal's reason when `signal` aborts, or with a frame's error.
   */
  play(options: PlayOptions = {}): Promise<void> {
    if (this.#disposed) return Promise.reject(fault('disposed', 'Timeline disposed; create a new one', 'sciviz'));
    const fps = options.fps ?? 10;
    if (!(fps > 0) || !Number.isFinite(fps))
      return Promise.reject(rangeError(`play fps must be a positive number, got ${fps}`, 'sciviz'));
    options.signal?.throwIfAborted();
    this.pause();
    return new Promise<void>((resolve, reject) => {
      let stopped = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (this.#playing === handle) this.#playing = undefined;
        if (this.#button) {
          this.#button.textContent = '▶';
          this.#button.setAttribute('aria-label', 'Play');
        }
        if (error === undefined) resolve();
        else reject(error);
      };
      const handle = { stop: () => finish() },
        abort = () => finish(options.signal!.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.#playing = handle;
      if (this.#button) {
        this.#button.textContent = '❚❚';
        this.#button.setAttribute('aria-label', 'Pause');
      }
      const last = this.times.length - 1;
      let next = -1;
      const step = async () => {
        if (stopped) return;
        // The first step starts after any frame still being shown, from the frame after it.
        if (next < 0) {
          await this.#queue;
          if (stopped) return;
          next = this.#index < 0 || this.#index >= last ? 0 : this.#index + 1;
        }
        const started = performance.now();
        try {
          await this.seek(next);
        } catch (error) {
          finish(error);
          return;
        }
        if (stopped) return;
        if (next >= last && !options.loop) {
          finish();
          return;
        }
        next = next >= last ? 0 : next + 1;
        // The frame interval counts from the frame's start, so slow callbacks do not slow playback further.
        timer = setTimeout(step, Math.max(0, 1000 / fps - (performance.now() - started)));
      };
      void step();
    });
  }

  /** Stops playback (play() resolves). */
  pause(): void {
    this.#playing?.stop();
  }

  /** Stops playback and removes the controls. */
  dispose(): void {
    if (this.#disposed) return;
    this.pause();
    this.#disposed = true;
    this.element?.remove();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

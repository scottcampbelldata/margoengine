/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/** The JSON body of one beacon. It holds these numbers and the app's `context`, nothing else. */
export interface FrameBeaconReport {
  /** Frames in this report. */
  frames: number;
  /** Their total time. */
  seconds: number;
  /** Frame time percentiles in milliseconds; each is at most 4.6% above the true value. */
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  /** The longest frame, exact. */
  max: number;
  context: Record<string, string | number | boolean>;
}
/** Options for {@link FrameBeacon}. */
export interface FrameBeaconOptions {
  /** Where reports are POSTed: an http or https URL, relative to the page if relative. Required. */
  endpoint: string | URL;
  /** Time between reports, or 0 to send only when the page hides and on `flush()`. Default 30000. */
  intervalMilliseconds?: number;
  /** A report with fewer frames waits for more. Default 60. */
  minFrames?: number;
  /** Share of sessions that report, 0..1, decided once at construction. Default 1. */
  sampleRate?: number;
  /** Sent with every report: a build number, a scene name, a quality tier. Read at each send. Default `{}`. */
  context?: Record<string, string | number | boolean>;
  /** Stops reporting when aborted, as `dispose()` does. */
  signal?: AbortSignal;
}

// 256 logarithmic bins from 0.1 ms to 10 s: each is 4.6% wider than the last, so memory is fixed for any session.
const BINS = 256,
  LOWEST = 0.1,
  STEP = Math.log(1e5) / BINS;
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Reports frame time percentiles from real sessions to an endpoint the app chooses. The app decides whether to create
 * it; it sends only frame numbers and `context`, with no identifier. It reports on an interval, when the page hides and
 * on `dispose()`, through `navigator.sendBeacon`, or `fetch` with `keepalive` where that is missing or refuses. The body
 * is a JSON string sent as `text/plain`, so a cross-origin endpoint needs no preflight.
 */
export class FrameBeacon implements EnginePlugin {
  readonly name = 'frame-beacon';
  /** False when `sampleRate` left this session out: it then does nothing at all. */
  readonly active: boolean;
  /** Reports handed to the browser. */
  sent = 0;
  /** Reports the browser could not send; `lastError` holds why. Nothing is retried. */
  failed = 0;
  lastError: unknown = null;
  private readonly url: string;
  private readonly bins = new Float64Array(BINS);
  private readonly minFrames: number;
  private readonly context: Record<string, string | number | boolean>;
  private frames = 0;
  private total = 0;
  private longest = 0;
  private timer?: ReturnType<typeof setInterval>;
  private engine?: Engine;
  private removeFrameListener?: () => void;
  private last = 0;
  private disposed = false;
  private readonly signal?: AbortSignal;
  private readonly hidden = (): void => {
    if (globalThis.document?.visibilityState === 'hidden') this.flush();
  };
  private readonly leave = (): void => {
    this.flush();
  };
  private readonly abort = (): void => {
    this.dispose();
  };

  /** Adds it to an engine and samples the engine's frames. */
  static attach(engine: EngineKernel, options: FrameBeaconOptions): FrameBeacon {
    const beacon = new FrameBeacon(options);
    try {
      engine.use(beacon);
      return beacon;
    } catch (error) {
      beacon.dispose();
      throw error;
    }
  }
  constructor({
    endpoint,
    intervalMilliseconds = 30000,
    minFrames = 60,
    sampleRate = 1,
    context = {},
    signal,
  }: FrameBeaconOptions) {
    if (endpoint === undefined) throw new TypeError('FrameBeacon needs an endpoint; pass its URL.');
    const url = new URL(endpoint, globalThis.location?.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('endpoint must be http or https');
    if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds < 0)
      throw new RangeError('intervalMilliseconds must be 0 or above');
    if (!Number.isInteger(minFrames) || minFrames < 1) throw new RangeError('minFrames must be 1 or above');
    if (!(sampleRate >= 0 && sampleRate <= 1)) throw new RangeError('sampleRate must be 0..1');
    this.url = url.href;
    this.minFrames = minFrames;
    this.context = context;
    this.signal = signal;
    this.active = !signal?.aborted && Math.random() < sampleRate;
    if (!this.active) return;
    signal?.addEventListener('abort', this.abort);
    if (intervalMilliseconds) this.timer = setInterval(this.leave, intervalMilliseconds);
    globalThis.document?.addEventListener('visibilitychange', this.hidden);
    globalThis.addEventListener?.('pagehide', this.leave);
  }

  /** Adds one frame. Numbers only: nothing is allocated. */
  frame(milliseconds: number): void {
    if (this.disposed) throw new MargoError('disposed', 'FrameBeacon is disposed; create a new one to sample frames.');
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new RangeError('Frame time must be above 0');
    if (!this.active) return;
    const bin = Math.floor(Math.log(milliseconds / LOWEST) / STEP);
    this.bins[bin < 0 ? 0 : bin >= BINS ? BINS - 1 : bin]++;
    this.frames++;
    this.total += milliseconds;
    if (milliseconds > this.longest) this.longest = milliseconds;
  }
  /** The frame time at or under which share `p` (0..1) of the frames lie, by the upper edge of its bin. */
  private percentile(p: number): number {
    const rank = Math.ceil(p * this.frames);
    let seen = 0;
    for (let i = 0; i < BINS; i++) {
      seen += this.bins[i];
      if (seen >= rank) return Math.min(LOWEST * Math.exp((i + 1) * STEP), this.longest);
    }
    return this.longest;
  }
  /** What the next report would hold. */
  toJSON(): FrameBeaconReport {
    return {
      frames: this.frames,
      seconds: round(this.total / 1000),
      p50: round(this.percentile(0.5)),
      p90: round(this.percentile(0.9)),
      p95: round(this.percentile(0.95)),
      p99: round(this.percentile(0.99)),
      max: round(this.longest),
      context: { ...this.context },
    };
  }
  /** Sends the frames so far and starts counting again. Returns false, keeping them, under `minFrames`. */
  flush(): boolean {
    if (!this.active || this.disposed || this.frames < this.minFrames) return false;
    const body = JSON.stringify(this);
    this.bins.fill(0);
    this.frames = this.total = this.longest = 0;
    if (globalThis.navigator?.sendBeacon?.(this.url, body)) {
      this.sent++;
      return true;
    }
    // no-cors: the request goes out with no preflight, and an endpoint without CORS headers is no failure here.
    fetch(this.url, { method: 'POST', body, keepalive: true, mode: 'no-cors', credentials: 'omit' }).then(
      () => {
        this.sent++;
      },
      (error) => {
        this.failed++;
        this.lastError = error;
      },
    );
    return true;
  }

  setup(engine: Engine): void {
    if (this.disposed)
      throw new MargoError('disposed', 'FrameBeacon is disposed; create a new one and add it to the engine.');
    if (this.engine)
      throw new MargoError('attached', 'FrameBeacon is already attached to an engine; create one per engine.');
    this.engine = engine;
    this.removeFrameListener = engine.onFrame((_engine, delta) => {
      const now = performance.now();
      // Delta 0 is a restart: the time since the last frame was a pause, not a slow frame.
      if (delta !== 0 && this.last) this.frame(now - this.last);
      this.last = now;
    });
  }
  /** Sends what it has, if that is enough, and stops. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    this.removeFrameListener?.();
    this.removeFrameListener = undefined;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    clearInterval(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    globalThis.document?.removeEventListener('visibilitychange', this.hidden);
    globalThis.removeEventListener?.('pagehide', this.leave);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

declare const GPUQueue: { prototype: unknown } | undefined;
/** Options for {@link ResolutionScaler}. */
export interface ResolutionOptions {
  /** Frame cost in milliseconds above which the resolution drops; below 70% of it the resolution creeps back up. Default 12 (leaves room in a 16.7 ms frame). */
  budget?: number;
  /** Lowest render scale (fraction of the full pixel ratio), in (0, 1]. Default 0.5. */
  min?: number;
  /** Highest render scale, in [min, 1]. Default 1. */
  max?: number;
  /** Samples averaged before each decision. Default 30. */
  window?: number;
  /** Scale changes are rounded to a multiple of this, so the canvas is not reallocated for tiny moves. Default 0.05. */
  granularity?: number;
}

/**
 * The decision logic of dynamic resolution, free of timers and the DOM so it is easy to test and to reuse in your own
 * loop. Feed it one frame cost per frame with {@link ResolutionScaler.push}; it returns the new render scale when it
 * changes. Cost grows with pixel count (scale squared), so a drop is sized to land just under the budget. It rises
 * slowly (5% per decision) and backs off after a rise that had to be undone, so it settles instead of oscillating.
 */
export class ResolutionScaler {
  /** Current render scale, between `min` and `max`. Starts at `max`. */
  scale: number;
  private readonly budget: number;
  private readonly min: number;
  private readonly max: number;
  private readonly window: number;
  private readonly granularity: number;
  private sum = 0;
  private count = 0;
  private skip = 0;
  private calm = 0;
  private holdOff = 2;
  private sinceRise = Infinity;
  /**
   * @throws RangeError when `budget` is not above 0, `min` and `max` are not 0 < min <= max <= 1, or `window` is below 1.
   */
  constructor({ budget = 12, min = 0.5, max = 1, window = 30, granularity = 0.05 }: ResolutionOptions = {}) {
    if (
      !(Number.isFinite(budget) && budget > 0) ||
      !(min > 0 && min <= max && max <= 1) ||
      !Number.isInteger(window) ||
      window < 1 ||
      !(granularity > 0 && granularity <= 0.5)
    )
      throw new RangeError(
        'Invalid resolution options; use budget > 0, 0 < min <= max <= 1, an integer window >= 1 and granularity in (0, 0.5]',
      );
    this.budget = budget;
    this.min = min;
    this.max = max;
    this.window = window;
    this.granularity = granularity;
    this.scale = max;
  }
  /**
   * Record one frame's cost in milliseconds (GPU time or frame interval). Returns the new scale when this sample made
   * the scaler change it, otherwise `undefined`. Non-finite or negative samples are ignored.
   */
  push(ms: number): number | undefined {
    if (!Number.isFinite(ms) || ms < 0) return undefined;
    if (this.skip > 0) {
      this.skip--;
      return undefined;
    }
    this.sum += ms;
    if (++this.count < this.window) return undefined;
    const average = this.sum / this.count;
    this.sum = this.count = 0;
    const round = (v: number) =>
      Math.min(this.max, Math.max(this.min, Math.round(v / this.granularity) * this.granularity));
    this.sinceRise++;
    if (average > this.budget) {
      this.calm = 0;
      let next = round(this.scale * Math.max(0.7, Math.sqrt((this.budget * 0.95) / average)));
      if (next >= this.scale) next = Math.max(this.min, this.scale - this.granularity);
      // A drop soon after a rise means the rise was too eager: wait longer before trying again.
      if (this.sinceRise <= 3) this.holdOff = Math.min(32, this.holdOff * 2);
      return this.change(next);
    }
    if (average < this.budget * 0.7 && this.scale < this.max) {
      if (++this.calm >= this.holdOff) {
        this.calm = 0;
        this.sinceRise = 0;
        return this.change(round(this.scale * 1.05 + this.granularity / 2));
      }
    } else if (average < this.budget) {
      this.calm = Math.max(0, this.calm - 1);
    }
    return undefined;
  }
  private change(next: number): number | undefined {
    if (Math.abs(next - this.scale) < 1e-9) return undefined;
    this.scale = next;
    // The new size takes a few frames to reach the GPU; ignore them so they do not count against the new scale.
    this.skip = 8;
    return next;
  }
}

/** Hooks of {@link watchResolution}; each defaults to the browser's own, so tests can inject them. */
export interface WatchResolutionOptions extends ResolutionOptions {
  /** Frame scheduler, used only when no queue is available. Default `requestAnimationFrame`. */
  request?: (callback: (time: number) => void) => unknown;
  /** Queue whose `submit` is wrapped to time GPU work (submit to finished). Default `GPUQueue.prototype` when WebGPU exists. */
  queue?: { submit(buffers: unknown): unknown; onSubmittedWorkDone(): Promise<unknown> };
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
  /** Receives each new scale. Default sets `globalThis.margoLow` (core's pixel-ratio cap) so the next frame resizes the canvas. */
  apply?: (scale: number) => void;
}

/** Stops {@link watchResolution} and restores the starting pixel ratio. */
export interface ResolutionWatch {
  /** Current render scale. */
  readonly scale: number;
  /** Stop measuring and restore full resolution. Also runs on `using` disposal. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const inactive: ResolutionWatch = {
  scale: 1,
  dispose() {},
  [Symbol.dispose]() {},
};

/**
 * Dynamic resolution: while the scene runs, time each frame's GPU work and lower the canvas pixel ratio when it goes
 * over `budget`, raise it again when there is room. It works by moving `globalThis.margoLow`, core's pixel-ratio cap,
 * which core reads every frame, so it needs the light or phone tier (`applyQualityTier()` first). On the full 4x MSAA
 * tier it does nothing and returns a handle with `scale` 1, because changing the cap there would also switch off
 * multisampling; pass your own `apply` to scale some other way.
 *
 * ```ts
 * applyQualityTier();
 * const engine = await Engine.create(canvas, {backend: 'webgpu'});
 * using resolution = watchResolution({budget: 12, min: 0.6});
 * ```
 * @throws RangeError for invalid options (see {@link ResolutionOptions}).
 */
export function watchResolution({
  request = globalThis.requestAnimationFrame?.bind(globalThis),
  queue = typeof GPUQueue === 'undefined'
    ? undefined
    : (GPUQueue.prototype as unknown as WatchResolutionOptions['queue']),
  now = () => performance.now(),
  apply,
  ...options
}: WatchResolutionOptions = {}): ResolutionWatch {
  const scaler = new ResolutionScaler(options),
    base = globalThis.margoLow;
  if (!apply && !base) return inactive;
  const setScale =
    apply ??
    ((scale: number) => {
      globalThis.margoLow = Math.max(0.25, Math.min(globalThis.devicePixelRatio ?? 1, base!) * scale);
    });
  let stopped = false,
    cleanup = () => {};
  const record = (ms: number) => {
    if (stopped) return;
    const next = scaler.push(ms);
    if (next !== undefined) setScale(next);
  };
  if (queue?.submit) {
    const submit = queue.submit;
    const measured = function (this: NonNullable<WatchResolutionOptions['queue']>, buffers: unknown): unknown {
      const start = now(),
        result = submit.call(this, buffers);
      void this.onSubmittedWorkDone().then(() => record(now() - start));
      return result;
    };
    queue.submit = measured;
    cleanup = () => {
      if (queue.submit === measured) queue.submit = submit;
    };
  } else if (request) {
    let last: number | undefined;
    const tick = (time: number) => {
      if (stopped) return;
      // A long gap is a hidden tab or a startup compile, not steady load.
      if (last !== undefined && time - last < 250) record(time - last);
      last = time;
      request(tick);
    };
    request(tick);
  }
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    setScale(1);
  };
  return {
    get scale() {
      return scaler.scale;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

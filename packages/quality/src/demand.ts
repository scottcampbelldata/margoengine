import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';

/** A change source, including controls and DOM EventTargets. */
export interface DemandSource {
  /** Subscribe to a change, start, end or load event. */
  addEventListener(type: string, listener: () => void): void;
  /** Remove the subscription. */
  removeEventListener(type: string, listener: () => void): void;
}

/** Options for the demand frame loop. */
export interface DemandOptions {
  /** Controls or loaders emitting change/start/end/load. Default none. */
  sources?: readonly DemandSource[];
  /** Update before rendering; return true while an animation needs another frame. Default none. */
  update?: (delta: number, time: number) => boolean | void;
  /** Request an initial frame. Default true. */
  initial?: boolean;
  /** Maximum animation step in seconds after a delayed frame. Default 0.1. */
  maxDelta?: number;
  /** Abort cancels queued work and subscriptions. Default none. */
  signal?: AbortSignal;
  /** Frame scheduler. Default requestAnimationFrame. */
  request?: (callback: (time: number) => void) => number;
  /** Cancels a scheduled frame. Default cancelAnimationFrame. */
  cancel?: (id: number) => void;
}

/** An idle loop has no scheduled frame or polling timer. */
export interface DemandLoop {
  /** Request at least this many frames, coalescing requests. Default 1. */
  invalidate(frames?: number): void;
  /** Keep drawing until the returned release function runs; independent callers nest. */
  animate(): () => void;
  /** Invalidate when a successful load finishes, preserving its result or rejection. */
  loaded<T>(promise: PromiseLike<T>): Promise<T>;
  /** Whether a frame is queued. */
  readonly pending: boolean;
  /** Stop and unsubscribe; the engine remains stopped. */
  dispose(): void;
  [Symbol.dispose](): void;
}

let serial = 0;
/**
 * Stop the engine's continuous loop and render only dirty frames. Attached controls and plugins update during
 * engine.render; app engine.onFrame callbacks belong in options.update instead. No import-time side effects.
 * @throws RangeError for an invalid frame count; use a positive integer.
 */
export function renderOnDemand(engine: EngineKernel, options: DemandOptions = {}): DemandLoop {
  const {
    sources = [],
    update,
    initial = true,
    signal,
    maxDelta = 0.1,
    request = globalThis.requestAnimationFrame.bind(globalThis),
    cancel = globalThis.cancelAnimationFrame.bind(globalThis),
  } = options;
  if (!Number.isFinite(maxDelta) || maxDelta <= 0)
    throw rangeError('Invalid demand delta; use a finite value above zero', 'arguments');
  let stopped = false,
    queued: number | undefined,
    dirty = 0,
    active = 0,
    last: number | undefined;
  const schedule = () => {
    if (!stopped && queued === undefined && (dirty || active)) queued = request(frame);
  };
  const invalidate = (frames = 1) => {
    if (!Number.isSafeInteger(frames) || frames < 1)
      throw rangeError('Invalid demand count; use a positive safe integer', 'arguments');
    if (stopped) return;
    dirty = Math.max(dirty, frames);
    schedule();
  };
  const frame = (time: number) => {
    queued = undefined;
    if (stopped) return;
    dirty = Math.max(0, dirty - 1);
    const idle = last === undefined;
    const delta = idle ? 0 : Math.min(maxDelta, Math.max(0, (time - last!) / 1000));
    last = time;
    try {
      if (update?.(delta, time)) dirty = Math.max(dirty, 1);
      // Damped controls need a nonzero step to consume the motion that woke an idle loop.
      if (!stopped) engine.render({ delta: idle ? Math.min(maxDelta, 1 / 60) : delta, views: engine.views });
    } catch (error) {
      dispose();
      throw error;
    }
    schedule();
    if (queued === undefined) last = undefined;
  };
  const changed = () => invalidate();
  const events = ['start', 'change', 'end', 'load'];
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (queued !== undefined) cancel(queued);
    queued = undefined;
    for (const source of sources) for (const event of events) source.removeEventListener(event, changed);
    signal?.removeEventListener('abort', dispose);
    engine.sceneOf(plugin)?.removePlugin(plugin.name);
  };
  const plugin: EnginePlugin = {
    name: `quality-demand-${++serial}`,
    setup() {},
    onDeviceRestored: () => invalidate(2),
    dispose,
  };
  engine.stop();
  if (!signal?.aborted) {
    engine.use(plugin);
    for (const source of sources) for (const event of events) source.addEventListener(event, changed);
    signal?.addEventListener('abort', dispose, { once: true });
    if (initial) invalidate();
  } else stopped = true;
  return {
    invalidate,
    animate() {
      if (stopped) return () => {};
      active++;
      invalidate();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        invalidate();
      };
    },
    async loaded<T>(promise: PromiseLike<T>): Promise<T> {
      const value = await promise;
      invalidate();
      return value;
    },
    get pending() {
      return queued !== undefined;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

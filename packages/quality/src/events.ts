import type { DemandSource } from './demand.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Motion-dependent picking policy and optional clock for deterministic tests. */
export interface AdaptiveEventOptions {
  /** Minimum milliseconds between calls during motion. Infinity suppresses them until rest. Default 100. */
  interval?: number;
  /** Milliseconds without a control event before rest. Default 120. */
  debounce?: number;
  /** Control start/change/end sources. Default none; call regress or setMoving manually. */
  sources?: readonly DemandSource[];
  /** Cancels all returned promises and removes listeners. Default none. */
  signal?: AbortSignal;
  /** Monotonic milliseconds. Default performance.now. */
  now?: () => number;
  /** Schedule a timeout. Default global setTimeout. */
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  /** Cancel a timeout. Default global clearTimeout. */
  clearTimer?: (timer: unknown) => void;
}

/** Serialized, latest-input picking; each run's promise receives the result of its coalesced call. */
export interface AdaptiveEventTask<A extends unknown[], R> {
  /** Schedule picking with the latest arguments; queued calls coalesce. Errors reject every corresponding promise. */
  run(...args: A): Promise<R>;
  /** Mark movement and restart the inactivity window, including programmatic camera changes. */
  regress(): void;
  /** Set motion explicitly; false immediately flushes the latest queued input. */
  setMoving(moving: boolean): void;
  /** Force the latest input through, regardless of motion; an in-flight call still finishes first. */
  flush(): void;
  /** Whether motion is currently reducing event frequency. */
  readonly moving: boolean;
  /** Whether input is queued or a handler is in flight. */
  readonly pending: boolean;
  /** Cancel queued/in-flight results, unsubscribe and cancel timers. The underlying caller-owned task may finish. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Throttle hover picks or raycasts during camera movement, restoring the final pointer at rest. Independent calls
 * never overlap, including asynchronous GPU picks. Click/drag actions should call their handler directly.
 * @throws RangeError for invalid interval or debounce; use nonnegative milliseconds (interval also accepts Infinity).
 */
export function adaptiveEvents<A extends unknown[], R>(
  handler: (...args: A) => R | PromiseLike<R>,
  {
    interval = 100,
    debounce = 120,
    sources = [],
    signal,
    now = () => performance.now(),
    setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }: AdaptiveEventOptions = {},
): AdaptiveEventTask<A, R> {
  if (
    !(interval >= 0) ||
    (interval !== Infinity && interval > 2147483647) ||
    !(debounce >= 0) ||
    debounce > 2147483647 ||
    !Number.isFinite(debounce)
  )
    throw rangeError('Invalid adaptive event timing; use nonnegative milliseconds', 'arguments');
  type Work = { args: A; waiters: { resolve: (result: R) => void; reject: (error: unknown) => void }[] };
  let stopped = false,
    moving = false,
    last = -Infinity,
    queued: Work | undefined,
    current: Work | undefined;
  let timer: unknown,
    quiet: unknown,
    forced = false;
  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const pump = () => {
    cancelTimer();
    if (stopped || current || !queued) return;
    const wait = moving && !forced ? interval - (now() - last) : 0;
    if (moving && !forced && interval === Infinity) return;
    if (wait > 0) {
      timer = setTimer(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const work = (current = queued);
    queued = undefined;
    forced = false;
    last = now();
    const finish = (ok: boolean, value: unknown) => {
      if (current !== work) return;
      current = undefined;
      for (const waiter of work.waiters) ok ? waiter.resolve(value as R) : waiter.reject(value);
      pump();
    };
    try {
      Promise.resolve(handler(...work.args)).then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
  };
  const setMoving = (value: boolean) => {
    if (stopped) return;
    if (quiet !== undefined) clearTimer(quiet);
    quiet = undefined;
    moving = value;
    pump();
  };
  const regress = () => {
    setMoving(true);
    if (!stopped)
      quiet = setTimer(() => {
        quiet = undefined;
        setMoving(false);
      }, debounce);
  };
  const events = ['start', 'change', 'end'];
  const disposed = () =>
    signal?.aborted ? signal.reason : fault('disposed', 'Adaptive events disposed; create a new task', 'disposed');
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    cancelTimer();
    if (quiet !== undefined) clearTimer(quiet);
    quiet = undefined;
    const error = disposed();
    for (const work of [current, queued]) for (const waiter of work?.waiters ?? []) waiter.reject(error);
    current = queued = undefined;
    for (const source of sources) for (const event of events) source.removeEventListener(event, regress);
    signal?.removeEventListener('abort', dispose);
  };
  if (signal?.aborted) stopped = true;
  else {
    for (const source of sources) for (const event of events) source.addEventListener(event, regress);
    signal?.addEventListener('abort', dispose, { once: true });
  }
  return {
    run(...args: A): Promise<R> {
      if (stopped) return Promise.reject(disposed());
      const result = new Promise<R>((resolve, reject) => {
        if (queued) {
          queued.args = args;
          queued.waiters.push({ resolve, reject });
        } else queued = { args, waiters: [{ resolve, reject }] };
      });
      pump();
      return result;
    },
    regress,
    setMoving,
    flush() {
      if (queued) {
        forced = true;
        pump();
      }
    },
    get moving() {
      return moving;
    },
    get pending() {
      return !!(queued || current);
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

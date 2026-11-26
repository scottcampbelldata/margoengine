/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { Schedule } from './schedule.js';

/**
 * What a coroutine yields to wait: nothing (the next update), a number of seconds, a promise (its rejection is thrown
 * into the generator at the `yield`), or another {@link Coroutine} (until it ends).
 */
export type CoroutineWait = undefined | number | PromiseLike<unknown> | Coroutine;
/** A generator that spans frames: `function* () { yield; yield 0.5; yield somePromise; }`. */
export type CoroutineGenerator = Generator<CoroutineWait, void, unknown>;
/** Options of {@link Coroutines.start}. */
export interface CoroutineOptions {
  /** Cancels the coroutine when it aborts; an already aborted signal cancels it before it starts. */
  signal?: AbortSignal;
}
/** Settings of {@link Coroutines}. */
export interface CoroutinesOptions {
  /**
   * Called for an error a coroutine throws, so one failing coroutine never stops the others. Default: errors are
   * collected and rethrown after the update as one MargoError `'failed'` whose `cause` is the first.
   */
  onError?: (error: unknown, coroutine: Coroutine) => void;
}

/** A running coroutine: `done` settles when it ends, `cancel()` stops it. */
export class Coroutine {
  /** Resolves when the generator returns; rejects with an AbortError on cancel, or with the error it threw. */
  readonly done: Promise<void>;
  /** @internal */ resolve!: () => void;
  /** @internal */ reject!: (error: unknown) => void;
  /** @internal */ waitSeconds = 0;
  /** @internal */ waitFor: Coroutine | null = null;
  /** @internal */ thrown: { error: unknown } | null = null;
  /** @internal */ finished = false;
  /** @internal */
  constructor(
    readonly generator: CoroutineGenerator,
    private readonly owner: Coroutines,
  ) {
    this.done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // A cancelled or failed fire-and-forget coroutine is reported through onError or update, never as an unhandled rejection.
    this.done.catch(() => {});
  }
  /** True until it returns, throws or is cancelled. */
  get active(): boolean {
    return !this.finished;
  }
  /** Stops it at the current `yield` (its `finally` blocks run) and rejects `done` with an AbortError. Does nothing once ended. */
  cancel(): void {
    this.owner.stop(this, new DOMException('Coroutine cancelled; catch the AbortError from done to handle it', 'AbortError'));
  }
}

/**
 * Runs multi-frame logic written as generators, stepped once per `update(dt)` (or by a {@link Schedule} after
 * `install`). A bare `yield` waits one update, `yield seconds` waits that long, `yield promise` waits for a promise and
 * `yield coroutine` waits for another coroutine, so a sequence reads top to bottom instead of as a state machine.
 */
export class Coroutines {
  private readonly running = new Set<Coroutine>();
  private disposed = false;
  constructor(private readonly options: CoroutinesOptions = {}) {}
  /** Number of coroutines still running. */
  get size(): number {
    return this.running.size;
  }
  /**
   * Starts a coroutine; its first step runs on the next `update`.
   * @throws MargoError `'disposed'` after `dispose`.
   */
  start(generator: CoroutineGenerator, options: CoroutineOptions = {}): Coroutine {
    if (this.disposed) throw new MargoError('disposed', 'Coroutines is disposed; create a new Coroutines');
    const co = new Coroutine(generator, this);
    this.running.add(co);
    const { signal } = options;
    if (signal) {
      const stop = (): void => co.cancel();
      if (signal.aborted) stop();
      else {
        signal.addEventListener('abort', stop, { once: true });
        const release = (): void => signal.removeEventListener('abort', stop);
        co.done.then(release, release);
      }
    }
    return co;
  }
  /** Starts a coroutine and returns its `done` promise: the async form, `await coroutines.run(gen)`. */
  run(generator: CoroutineGenerator, options: CoroutineOptions = {}): Promise<void> {
    return this.start(generator, options).done;
  }
  /** @internal Ends `co`: no `error` resolves it, anything else rejects it. */
  stop(co: Coroutine, error?: unknown): void {
    if (co.finished) return;
    co.finished = true;
    this.running.delete(co);
    if (error === undefined) return co.resolve();
    try {
      co.generator.return();
    } catch (thrown) {
      error = thrown;
    }
    co.reject(error);
  }
  /**
   * Steps every running coroutine by `dt` seconds. Returns how many are still running.
   * @throws RangeError when `dt` is negative or not finite.
   * @throws MargoError `'failed'` when a coroutine threw and no `onError` was given.
   */
  update(dt: number): number {
    if (!(dt >= 0) || !Number.isFinite(dt))
      throw new RangeError('Coroutines.update needs a finite dt of 0 or more; pass seconds');
    const errors: unknown[] = [];
    for (const co of [...this.running]) {
      if (co.finished) continue;
      if (co.waitFor) {
        if (co.waitFor.active) continue;
        co.waitFor = null;
      }
      if (co.waitSeconds > 0) {
        co.waitSeconds -= dt;
        if (co.waitSeconds > 0) continue;
        co.waitSeconds = 0;
      }
      this.step(co, errors);
    }
    if (errors.length) {
      const error = new MargoError(
        'failed',
        `${errors.length} coroutine${errors.length > 1 ? 's' : ''} threw; the first error is in cause, or pass onError to handle each`,
      );
      Object.defineProperty(error, 'cause', { value: errors[0] });
      throw error;
    }
    return this.running.size;
  }
  private step(co: Coroutine, errors: unknown[]): void {
    let result: IteratorResult<CoroutineWait, void>;
    try {
      const pending = co.thrown;
      co.thrown = null;
      result = pending ? co.generator.throw(pending.error) : co.generator.next();
    } catch (error) {
      co.finished = true;
      this.running.delete(co);
      co.reject(error);
      if (this.options.onError) this.options.onError(error, co);
      else errors.push(error);
      return;
    }
    if (result.done) return this.stop(co);
    const wait = result.value;
    if (typeof wait === 'number') {
      if (wait >= 0 && Number.isFinite(wait)) co.waitSeconds = wait;
      else co.thrown = { error: new RangeError('A coroutine can yield seconds of 0 or more; yield a finite number') };
    } else if (wait instanceof Coroutine) co.waitFor = wait;
    else if (wait && typeof wait.then === 'function') {
      co.waitSeconds = Infinity;
      wait.then(
        () => (co.waitSeconds = 0),
        (error) => ((co.thrown = { error }), (co.waitSeconds = 0)),
      );
    }
  }
  /** Adds a frame system `coroutines` that calls `update(delta)` to a {@link Schedule}. */
  install(schedule: Schedule, options: { before?: readonly string[]; after?: readonly string[] } = {}): this {
    schedule.add('coroutines', (t) => void this.update(t.delta), options);
    return this;
  }
  /** Cancels every running coroutine; each `done` rejects with an AbortError. */
  cancelAll(): void {
    for (const co of [...this.running]) co.cancel();
  }
  /** Cancels everything and refuses new coroutines. */
  dispose(): void {
    if (this.disposed) return;
    this.cancelAll();
    this.disposed = true;
  }
  declare [Symbol.dispose]: () => void;
}
Coroutines.prototype[Symbol.dispose] = Coroutines.prototype.dispose;

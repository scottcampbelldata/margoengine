import { rangeError, typeError } from '../../shared/errors.js';

/** Options for `on` and `once`. */
export interface EmitterListenerOptions {
  /** Removes the listener when aborted; an already-aborted signal subscribes nothing. */
  signal?: AbortSignal;
  /** Remove the listener before its first call (default false). */
  once?: boolean;
}
/** Options for `events`. */
export interface EmitterEventsOptions {
  /** Ends the iterator when aborted; an already-aborted signal returns an iterator that is already closed. */
  signal?: AbortSignal;
  /** Most unread events kept (default 64, an integer of 1 or more). On overflow the oldest unread event is dropped and counted in `dropped`. */
  capacity?: number;
}
/** Constructor options. */
export interface EmitterOptions {
  /** Receives an error a listener threw, with the event type. Default: rethrown in a microtask, so it surfaces as an uncaught error and never stops other listeners. */
  onError?: (error: unknown, type: string) => void;
}
/** The async iterator `events` returns. */
export interface EventIterator<T> extends AsyncIterableIterator<T> {
  /** Events dropped so far because the buffer was full before they were read. */
  readonly dropped: number;
  /** True once `return()`, the signal or the emitter's dispose ended it. Unread events are discarded on ending. */
  readonly closed: boolean;
}
type Entry = { fn: (event: never) => void; once: boolean; live: boolean; end?: () => void; off: () => void };

/**
 * A small typed event emitter (the observer pattern) with the web conventions: `AbortSignal` and `once` on subscription,
 * an unsubscribe function from `on`, async iteration of events (`for await`) with a bounded buffer, and `Symbol.dispose`.
 * Listeners run synchronously in subscription order. A listener added during an emit first sees the next event; one removed
 * during an emit is not called. A throwing listener goes to `onError` and the others still run.
 */
export class Emitter<Events extends Record<string, unknown>> implements Disposable {
  private readonly map = new Map<keyof Events, Set<Entry>>();
  private readonly onError: (error: unknown, type: string) => void;
  constructor(options: EmitterOptions = {}) {
    this.onError =
      options.onError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }
  /** Subscribe; returns an idempotent unsubscribe function. */
  on<K extends keyof Events>(type: K, fn: (event: Events[K]) => void, options: EmitterListenerOptions = {}): () => void {
    if (typeof fn !== 'function') throw typeError('Emitter.on needs a listener function', 'scene-emitter');
    return this.add(type, fn as (event: never) => void, !!options.once, options.signal).off;
  }
  /** Same as `on(type, fn, { ...options, once: true })`. */
  once<K extends keyof Events>(
    type: K,
    fn: (event: Events[K]) => void,
    options: Omit<EmitterListenerOptions, 'once'> = {},
  ): () => void {
    return this.on(type, fn, { ...options, once: true });
  }
  /** Remove the first subscription of `fn` for `type`; returns whether one was removed. */
  off<K extends keyof Events>(type: K, fn: (event: Events[K]) => void): boolean {
    for (const entry of this.map.get(type) ?? []) if (entry.fn === fn) return (entry.off(), true);
    return false;
  }
  /** Number of listeners and open iterators for `type`, or for every type when omitted. */
  listenerCount(type?: keyof Events): number {
    if (type !== undefined) return this.map.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.map.values()) total += set.size;
    return total;
  }
  /** Call every listener of `type` with `event`, in subscription order. Returns how many were called. */
  emit<K extends keyof Events>(type: K, event: Events[K]): number {
    const set = this.map.get(type);
    if (!set) return 0;
    let called = 0;
    for (const entry of [...set]) {
      if (!entry.live) continue;
      if (entry.once) entry.off();
      called++;
      try {
        (entry.fn as (event: Events[K]) => void)(event);
      } catch (error) {
        try {
          this.onError(error, String(type));
        } catch (hookError) {
          queueMicrotask(() => {
            throw hookError;
          });
        }
      }
    }
    return called;
  }
  /**
   * Async iterator over the events of `type` from now on. Unread events wait in a buffer of `capacity` (default 64);
   * when it is full the oldest unread event is dropped and counted in `dropped`. `return()`, the signal and `dispose`
   * end it: a pending `next()` resolves done and unread events are discarded.
   */
  events<K extends keyof Events>(type: K, options: EmitterEventsOptions = {}): EventIterator<Events[K]> {
    const capacity = options.capacity ?? 64;
    if (!Number.isInteger(capacity) || capacity < 1)
      throw rangeError('Emitter.events: capacity must be an integer of 1 or more', 'scene-emitter');
    type T = Events[K];
    const buffer: T[] = [],
      waiting: ((result: IteratorResult<T>) => void)[] = [];
    let dropped = 0,
      closed = false,
      entry: Entry | undefined;
    const end = () => {
      if (closed) return;
      closed = true;
      buffer.length = 0;
      entry?.off();
      for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
    };
    const iterator: EventIterator<T> = {
      get dropped() {
        return dropped;
      },
      get closed() {
        return closed;
      },
      next: () =>
        buffer.length
          ? Promise.resolve({ value: buffer.shift() as T, done: false })
          : closed
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => waiting.push(resolve)),
      return: () => (end(), Promise.resolve({ value: undefined, done: true })),
      [Symbol.asyncIterator]: () => iterator,
    };
    entry = this.add(
      type,
      ((event: T) => {
        const resolve = waiting.shift();
        if (resolve) return resolve({ value: event, done: false });
        if (buffer.length >= capacity) (buffer.shift(), dropped++);
        buffer.push(event);
      }) as (event: never) => void,
      false,
      options.signal,
      end,
    );
    return iterator;
  }
  /** Remove every listener and end every iterator. The emitter stays usable. */
  dispose(): void {
    for (const entry of [...this.map.values()].flatMap((set) => [...set])) entry.off();
    this.map.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  private add(type: keyof Events, fn: (event: never) => void, once: boolean, signal?: AbortSignal, end?: () => void): Entry {
    const entry: Entry = { fn, once, live: !signal?.aborted, end, off: () => {} };
    if (!entry.live) {
      end?.();
      return entry;
    }
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    const own = set;
    own.add(entry);
    const abort = () => entry.off();
    entry.off = () => {
      if (!entry.live) return;
      entry.live = false;
      signal?.removeEventListener('abort', abort);
      own.delete(entry);
      if (!own.size && this.map.get(type) === own) this.map.delete(type);
      end?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    return entry;
  }
}

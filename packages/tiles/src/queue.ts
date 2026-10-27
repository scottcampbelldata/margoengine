// A priority-ordered request queue with a concurrency limit. Each update re-states which requests are still wanted
// and at what priority; requests nobody wants any more are dropped (queued) or aborted (in flight).

/** Lower sorts first: a group (0 = needed to avoid holes, 1 = refinement), then a distance-like key. */
export type Priority = readonly [group: number, key: number];

interface Entry {
  readonly key: string;
  priority: Priority;
  frame: number;
  run: (signal: AbortSignal) => Promise<void>;
  controller?: AbortController;
}

/** Options of `FetchQueue`. */
export interface FetchQueueOptions {
  /** Most requests in flight at once. Default 6. */
  maxConcurrent?: number;
  /** Aborts everything when it aborts. */
  signal?: AbortSignal;
}

/**
 * Priority fetch queue. `want(key, priority, run)` each frame for every request still needed, then `flush()`: queued
 * requests not wanted this frame are dropped, in-flight ones are aborted, and the best-priority queued ones start up
 * to `maxConcurrent`. `run` receives an AbortSignal and must settle when it aborts.
 */
export class FetchQueue {
  readonly maxConcurrent: number;
  private readonly entries = new Map<string, Entry>();
  private frame = 0;
  private active = 0;
  private readonly signal?: AbortSignal;
  constructor({ maxConcurrent = 6, signal }: FetchQueueOptions = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
      throw new RangeError('Invalid maxConcurrent; pass a whole number of 1 or more');
    this.maxConcurrent = maxConcurrent;
    this.signal = signal;
  }
  /** Requests queued and not started. */
  get queued(): number {
    return this.entries.size - this.active;
  }
  /** Requests in flight. */
  get inFlight(): number {
    return this.active;
  }
  /** Starts a new frame of wants. */
  begin(): void {
    this.frame++;
  }
  /** Marks a request wanted this frame (queues it the first time). */
  want(key: string, priority: Priority, run: (signal: AbortSignal) => Promise<void>): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.priority = priority;
      entry.frame = this.frame;
      return;
    }
    this.entries.set(key, { key, priority, frame: this.frame, run });
  }
  /** True while a request is queued or in flight. */
  has(key: string): boolean {
    return this.entries.has(key);
  }
  /** Drops or aborts requests not wanted this frame and starts the best queued ones. */
  flush(): void {
    const waiting: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.frame !== this.frame) {
        this.entries.delete(entry.key);
        if (entry.controller) entry.controller.abort(new DOMException('Tile no longer needed', 'AbortError'));
        continue;
      }
      if (!entry.controller) waiting.push(entry);
    }
    if (this.signal?.aborted) return;
    waiting.sort((a, b) => a.priority[0] - b.priority[0] || a.priority[1] - b.priority[1]);
    for (const entry of waiting) {
      if (this.active >= this.maxConcurrent) break;
      this.start(entry);
    }
  }
  /** Aborts and forgets everything. */
  clear(): void {
    for (const entry of this.entries.values()) entry.controller?.abort(new DOMException('Queue cleared', 'AbortError'));
    this.entries.clear();
  }
  private start(entry: Entry): void {
    const controller = new AbortController();
    entry.controller = controller;
    this.active++;
    const outer = this.signal,
      forward = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', forward, { once: true });
    let settled: Promise<void>;
    try {
      settled = entry.run(controller.signal);
    } catch (error) {
      settled = Promise.reject(error);
    }
    // run() reports its own errors; the queue only needs to know it finished.
    settled
      .catch(() => undefined)
      .finally(() => {
        outer?.removeEventListener('abort', forward);
        this.active--;
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      });
  }
}

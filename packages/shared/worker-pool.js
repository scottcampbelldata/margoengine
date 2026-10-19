// A long-lived worker pool with one central priority queue (voxel meshing; packages/voxel/DESIGN.md decision 11). Each
// worker runs one job at a time, so the worker side is serve() from worker.js; ArrayBuffers and ImageBitmaps move both
// ways without copies.
import { margoError } from './errors.js';
import { reviveError, transferables } from './worker.js';

export class JobPool {
  #create;
  #size;
  #slots = new Set();
  #idle = [];
  // Sorted so the next job is last: priority descending, then newest first (FIFO among equal priorities).
  // ponytail: O(n) insert and cancel; a heap if queues reach tens of thousands.
  #queue = [];
  #disposed = false;

  constructor(create, size) {
    if (!Number.isInteger(size) || size < 1)
      throw new RangeError(`Worker pool size is ${size}; pass a whole number of 1 or more`);
    this.#create = create;
    this.#size = size;
  }

  run(message, { priority = 0, timeout = Number.POSITIVE_INFINITY, signal } = {}) {
    if (this.#disposed) return Promise.reject(margoError('disposed', 'Worker pool is disposed; create a new pool'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const job = { message, priority, timeout, signal, resolve, reject, done: false };
      job.abort = () => {
        const i = this.#queue.indexOf(job);
        if (i >= 0) this.#queue.splice(i, 1);
        this.#settle(job, reject, signal.reason); // a running job keeps its worker until the reply, which is dropped
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      let lo = 0,
        hi = this.#queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.#queue[mid].priority > priority) lo = mid + 1;
        else hi = mid;
      }
      this.#queue.splice(lo, 0, job);
      this.#pump();
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const reason = margoError('disposed', 'Worker pool is disposed; create a new pool');
    for (const slot of this.#slots) this.#retire(slot, reason);
    for (const job of this.#queue.splice(0)) this.#settle(job, job.reject, reason);
  }

  #settle(job, settle, value) {
    if (job.done) return;
    job.done = true;
    job.signal?.removeEventListener('abort', job.abort);
    settle(value);
  }

  // Hands queued jobs to idle workers, starting workers up to the pool size. A message function runs here, when a
  // worker is free, so queued jobs hold no buffers and see the latest state; undefined from it resolves the job.
  #pump() {
    while (this.#queue.length && (this.#idle.length || this.#slots.size < this.#size)) {
      const job = this.#queue.pop();
      let message;
      try {
        message = typeof job.message === 'function' ? job.message() : job.message;
      } catch (error) {
        this.#settle(job, job.reject, error);
        continue;
      }
      if (message === undefined) {
        this.#settle(job, job.resolve, undefined);
        continue;
      }
      const slot = this.#idle.pop() ?? this.#spawn();
      try {
        slot.worker.postMessage(message, [...transferables(message)]);
      } catch (error) {
        this.#idle.push(slot);
        this.#settle(job, job.reject, error);
        continue;
      }
      slot.job = job;
      if (Number.isFinite(job.timeout))
        slot.timer = setTimeout(
          () =>
            this.#retire(
              slot,
              margoError('failed', `Worker job timed out after ${job.timeout} ms; the worker was restarted`),
            ),
          job.timeout,
        );
    }
  }

  #spawn() {
    const slot = { worker: this.#create(), job: undefined, timer: undefined };
    this.#slots.add(slot);
    slot.worker.onmessage = ({ data }) => {
      const job = slot.job;
      if (!job) return;
      clearTimeout(slot.timer);
      slot.job = undefined;
      this.#idle.push(slot);
      if (!data || typeof data !== 'object')
        this.#settle(job, job.reject, new TypeError('Worker sent an invalid reply'));
      else if (data.error) this.#settle(job, job.reject, reviveError(data.error));
      else this.#settle(job, job.resolve, data.result);
      this.#pump();
    };
    slot.worker.onerror = (event) => {
      event.preventDefault?.();
      this.#retire(slot, margoError('failed', `Worker failed: ${event.message || 'unknown error'}; it was restarted`));
    };
    slot.worker.onmessageerror = () =>
      this.#retire(slot, margoError('failed', 'Worker reply could not be deserialized; the worker was restarted'));
    return slot;
  }

  // Terminates the slot's worker, rejects its job with `reason` and lets a fresh worker take the queue.
  #retire(slot, reason) {
    clearTimeout(slot.timer);
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    slot.worker.terminate();
    this.#slots.delete(slot);
    const idle = this.#idle.indexOf(slot);
    if (idle >= 0) this.#idle.splice(idle, 1);
    if (slot.job) this.#settle(slot.job, slot.job.reject, reason);
    slot.job = undefined;
    if (!this.#disposed) this.#pump();
  }
}

import { decodeFailed } from './errors.js';
import type { WorkerResponse } from './protocol.js';

interface Job {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  /** Most milliseconds the worker may spend on this job once it reaches the front of the worker's queue. */
  timeout: number;
  /** What timed out, for the error ('Draco decode', 'KTX2 transcode'). */
  label: string;
}
interface Slot {
  worker: Worker;
  /** In posting order: a worker runs its jobs one after another, so the first is the one running. */
  jobs: Map<number, Job>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Default time limit for one decode: 10 s plus 4 s per MiB of input. Corrupt Draco data can keep the decoder busy for
 * many seconds on a few kilobytes; past the limit the worker is restarted and the decode rejects.
 */
export const jobTimeout = (bytes: number): number => 10_000 + Math.ceil(bytes / 256);

/** Validates a `timeout` option: undefined (the default limit), a positive number of milliseconds or Infinity. */
export function timeLimit(value: number | undefined): number | undefined {
  if (value !== undefined && !(typeof value === 'number' && value > 0))
    throw new RangeError('timeout must be a positive number of milliseconds or Infinity');
  return value;
}

/** Default worker count: hardware threads capped at 4. Read lazily so SSR never touches navigator. */
export const defaultWorkerLimit = (): number =>
  Math.max(1, Math.min(globalThis.navigator?.hardwareConcurrency || 4, 4));

export function workerLimit(value: number | undefined): number {
  const limit = value ?? defaultWorkerLimit();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
    throw new RangeError('workerLimit must be an integer from 1 to 16');
  return limit;
}

// The worker is a prebuilt classic script (importScripts needs one). Its URL stays out of `new Worker(...)` so bundlers
// (Vite, webpack 5, Next.js) copy it as an asset instead of rebuilding it; `?no-inline` keeps it a file, never a data: URL.
const workerURL = (): URL => new URL('./decoder.worker.js?no-inline', import.meta.url);

/** Start one decoder worker. */
export const spawnDecoderWorker = (): Worker => new Worker(workerURL(), { name: 'margoengine-decoder' });

export function requireWorkers(owner: string): void {
  if (typeof Worker === 'undefined')
    throw new Error(`${owner} needs a browser with Web Workers; it cannot decode during SSR`);
}

/** Copy view data out of a larger buffer; whole ArrayBuffers are transferred only when the caller opts in. */
export function payload(data: ArrayBuffer | ArrayBufferView, transfer: boolean): ArrayBuffer {
  if (data instanceof ArrayBuffer) return transfer ? data : data.slice(0);
  if (!ArrayBuffer.isView(data)) throw new TypeError('Expected an ArrayBuffer or typed array');
  const whole =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer;
  return transfer && whole
    ? (data.buffer as ArrayBuffer)
    : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Lazily grown worker pool. Jobs go to an idle worker, a new worker while under the limit, or the least loaded worker.
 * A crashed worker rejects only its own jobs and is replaced on demand; so is a worker whose running job exceeds its time
 * limit (the jobs queued behind it on that worker reject too).
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private next = 1;
  private disposed = false;

  constructor(
    readonly limit: number,
    private readonly create: () => Worker = spawnDecoderWorker,
  ) {}

  get size(): number {
    return this.slots.length;
  }
  get pending(): number {
    return this.slots.reduce((total, slot) => total + slot.jobs.size, 0);
  }

  /**
   * Post one job. `timeout`: most milliseconds the worker may spend on it (default: no limit); past it the worker is
   * terminated and replaced, and its jobs reject with `<label> timed out ...`.
   */
  run<T>(
    message: Record<string, unknown>,
    transfer: Transferable[],
    signal?: AbortSignal,
    timeout = Number.POSITIVE_INFINITY,
    label = 'Decode',
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Decoder has been disposed'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    let slot: Slot;
    try {
      slot = this.pick();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const job: Job = { resolve: () => {}, reject: () => {}, timeout, label };
      const abort = () => {
        // Synchronous Wasm keeps running after cancellation: the entry stays until the reply (or the time limit), so the
        // worker is not handed new jobs as if idle and the watchdog still covers it.
        job.resolve = job.reject = () => {};
        reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const settle = (fn: (value: unknown) => void) => (value: unknown) => {
        signal?.removeEventListener('abort', abort);
        fn(value);
      };
      job.resolve = settle((value) => resolve(value as T));
      job.reject = settle(reject);
      slot.jobs.set(id, job);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        slot.worker.postMessage({ ...message, id }, transfer);
      } catch (error) {
        slot.jobs.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(error);
        return;
      }
      if (slot.jobs.size === 1) this.watch(slot);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots.splice(0)) this.retire(slot, new Error('Decoder has been disposed'));
  }

  // Arms the time limit of the job the worker is running now (the oldest).
  private watch(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.timer = undefined;
    const running: Job | undefined = slot.jobs.values().next().value;
    if (running && Number.isFinite(running.timeout))
      slot.timer = setTimeout(
        () =>
          this.retire(
            slot,
            decodeFailed(
              `${running.label} timed out after ${running.timeout} ms (corrupt data?); the decoder worker was restarted`,
            ),
          ),
        running.timeout,
      );
  }

  private crash(slot: Slot, message: string): void {
    this.retire(slot, new Error(message));
  }

  private pick(): Slot {
    const idle = this.slots.find((slot) => !slot.jobs.size);
    if (idle) return idle;
    if (this.slots.length < this.limit) {
      const worker = this.create(),
        slot: Slot = { worker, jobs: new Map() };
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        const job = slot.jobs.get(data?.id);
        if (!job) return;
        slot.jobs.delete(data.id);
        this.watch(slot);
        if (typeof data.error === 'string') job.reject(new Error(data.error));
        else job.resolve(data.result);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.crash(slot, `Decoder worker failed: ${event.message || 'unknown error'}`);
      };
      worker.onmessageerror = () => this.crash(slot, 'Decoder worker message could not be deserialized');
      this.slots.push(slot);
      return slot;
    }
    return this.slots.reduce((best, slot) => (slot.jobs.size < best.jobs.size ? slot : best));
  }

  // Terminates the slot's worker (a later job starts a fresh one) and rejects its jobs with `reason`.
  private retire(slot: Slot, reason: Error): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    clearTimeout(slot.timer);
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    slot.worker.terminate();
    for (const job of slot.jobs.values()) job.reject(reason);
    slot.jobs.clear();
  }
}

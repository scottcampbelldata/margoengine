import type {WorkerResponse} from './protocol.js';

interface Job {resolve(value: unknown): void; reject(reason: unknown): void}
interface Slot {worker: Worker; jobs: Map<number, Job>}

/** Default worker count: hardware threads capped at 4. Read lazily so SSR never touches navigator. */
export const defaultWorkerLimit = (): number => Math.max(1, Math.min(globalThis.navigator?.hardwareConcurrency || 4, 4));

export function workerLimit(value: number | undefined): number {
  const limit = value ?? defaultWorkerLimit();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new RangeError('workerLimit must be an integer from 1 to 16');
  return limit;
}

/** Standard URL pattern so Vite, webpack 5 and Next.js emit the worker as its own chunk. */
export const spawnDecoderWorker = (): Worker => new Worker(new URL('./decoder.worker.js', import.meta.url), {type: 'module', name: 'margoengine-decoder'});

export function requireWorkers(owner: string): void {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') throw new Error(`${owner} needs a browser with Web Workers; it cannot decode during SSR`);
}

/** Copy view data out of a larger buffer; whole ArrayBuffers are transferred only when the caller opts in. */
export function payload(data: ArrayBuffer | ArrayBufferView, transfer: boolean): ArrayBuffer {
  if (data instanceof ArrayBuffer) return transfer ? data : data.slice(0);
  if (!ArrayBuffer.isView(data)) throw new TypeError('Expected an ArrayBuffer or typed array');
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer;
  return transfer && whole ? data.buffer as ArrayBuffer : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Lazily grown worker pool. Jobs go to an idle worker, a new worker while under the limit, or the least loaded worker.
 * A crashed worker rejects only its own jobs and is replaced on demand.
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private next = 1;
  private disposed = false;

  constructor(readonly limit: number, private readonly create: () => Worker = spawnDecoderWorker) {}

  get size(): number {return this.slots.length;}
  get pending(): number {return this.slots.reduce((total, slot) => total + slot.jobs.size, 0);}

  run<T>(message: Record<string, unknown>, transfer: Transferable[], signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Decoder has been disposed'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    let slot: Slot;
    try {slot = this.pick();} catch (error) {return Promise.reject(error);}
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {slot.jobs.delete(id); reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));};
      const settle = (fn: (value: any) => void) => (value: unknown) => {signal?.removeEventListener('abort', abort); fn(value);};
      slot.jobs.set(id, {resolve: settle(resolve), reject: settle(reject)});
      signal?.addEventListener('abort', abort, {once: true});
      try {slot.worker.postMessage({...message, id}, transfer);}
      catch (error) {slot.jobs.delete(id); signal?.removeEventListener('abort', abort); reject(error);}
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots.splice(0)) this.retire(slot, new Error('Decoder has been disposed'));
  }

  private pick(): Slot {
    const idle = this.slots.find(slot => !slot.jobs.size);
    if (idle) return idle;
    if (this.slots.length < this.limit) {
      const worker = this.create(), slot: Slot = {worker, jobs: new Map()};
      worker.onmessage = ({data}: MessageEvent<WorkerResponse>) => {
        const job = slot.jobs.get(data?.id);
        if (!job) return;
        slot.jobs.delete(data.id);
        if (typeof data.error === 'string') job.reject(new Error(data.error));
        else job.resolve(data.result);
      };
      const crash = (message: string) => {
        const index = this.slots.indexOf(slot);
        if (index >= 0) this.slots.splice(index, 1);
        this.retire(slot, new Error(message));
      };
      worker.onerror = event => {event.preventDefault?.(); crash(`Decoder worker failed: ${event.message || 'unknown error'}`);};
      worker.onmessageerror = () => crash('Decoder worker message could not be deserialized');
      this.slots.push(slot);
      return slot;
    }
    return this.slots.reduce((best, slot) => slot.jobs.size < best.jobs.size ? slot : best);
  }

  private retire(slot: Slot, reason: Error): void {
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    slot.worker.terminate();
    for (const job of slot.jobs.values()) job.reject(reason);
    slot.jobs.clear();
  }
}

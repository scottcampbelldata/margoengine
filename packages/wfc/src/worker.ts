import { MargoError } from '@margoengine/math/errors';
import { canUseWorker, reviveError } from '../../shared/worker.js';
import type { Tile } from './index.js';
import type { CellPosition } from './constraints.js';
import type { HeapBackendOptions, HeapSolveOptions } from './heap.js';

/** Real work counters, cumulative across restarts. They are not a completion percentage. */
export interface WFCProgress {
  /** Selected solver implementation. */ backend: 'typescript' | 'wasm';
  /** Local entropy choices made so far. */ decisions: number;
  /** Heap updates so far. */ updates: number;
  /** Domain intersections so far. */ intersections: number;
  /** Current restart, starting at 1. */ attempts: number;
}
/** One worker solve. */
export interface WorkerSolveOptions extends HeapSolveOptions, HeapBackendOptions {
  /** Wall-clock limit including startup and loading, 1..2147483647 ms. Default 60000. */ timeout?: number;
}
const fault = (code: 'failed' | 'disposed' | 'unsupported' | 'timeout' | 'state', text: string) =>
  new MargoError(code, `${text}. Help: https://margoengine.com/docs/wfc`);

/** One dedicated worker per solve, with a promise result and a bounded, single-consumer progress stream. */
export class WFCWorkerSolve implements Disposable, AsyncIterable<WFCProgress> {
  /** Transferred X-fastest Uint16 tile IDs; rejects on abort, disposal, timeout or worker failure. */
  readonly result: Promise<Uint16Array>;
  private readonly worker: Worker;
  private latest?: WFCProgress;
  private wake?: () => void;
  private finished = false;
  private consumed = false;
  private cancel!: (reason: unknown) => void;

  /** Start immediately. Rules and pins are copied by structured clone; no solver runs on the calling thread. */
  constructor(dimensions: CellPosition, tiles: readonly Tile[], options: WorkerSolveOptions = {}) {
    const { signal, timeout = 60_000, ...solve } = options;
    signal?.throwIfAborted();
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)
      throw new RangeError('WFC worker timeout must be an integer from 1 to 2147483647 milliseconds');
    if (!canUseWorker())
      throw fault('unsupported', 'WFC worker solving needs browser Web Workers; use HeapWFC in Node');
    const url = new URL(/* @vite-ignore */ './workers/wfc.js?no-inline', import.meta.url);
    try {
      this.worker = new Worker(url, { name: 'margoengine-wfc' });
    } catch (cause) {
      throw Object.assign(fault('failed', 'WFC worker could not start; check worker-src and asset hosting'), { cause });
    }
    this.result = new Promise((resolve, reject) => {
      const finish = (error?: unknown, cells?: Uint16Array) => {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
        this.worker.terminate();
        this.wake?.();
        if (cells) resolve(cells);
        else reject(error);
      };
      const abort = () => finish(signal!.reason),
        timer = setTimeout(
          () => finish(fault('timeout', 'WFC worker exceeded its time limit; reduce the grid or raise timeout')),
          timeout,
        );
      this.cancel = (reason) => finish(reason);
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.onerror = (event) => {
        event.preventDefault?.();
        finish(fault('failed', `WFC worker crashed: ${event.message || 'unknown error'}`));
      };
      this.worker.onmessageerror = () => finish(fault('failed', 'WFC worker reply could not be deserialized'));
      this.worker.onmessage = ({ data }) => {
        if (this.finished) return;
        if (data?.progress) {
          const p = data.progress;
          if (
            !['typescript', 'wasm'].includes(p.backend) ||
            !['decisions', 'updates', 'intersections', 'attempts'].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0)
          ) {
            finish(fault('failed', 'WFC worker sent invalid progress'));
            return;
          }
          this.latest = { ...p };
          this.wake?.();
        } else if (data?.error) {
          const error = reviveError(data.error);
          finish(
            data.error.name === 'MargoError'
              ? Object.assign(error, { name: 'MargoError', code: data.error.code })
              : error,
          );
        } else if (data?.result instanceof Uint16Array) finish(undefined, data.result);
        else finish(fault('failed', 'WFC worker sent an invalid result'));
      };
      try {
        this.worker.postMessage({
          dimensions,
          tiles,
          options: solve,
          wasmURL: new URL(/* @vite-ignore */ './wfc.wasm?no-inline', import.meta.url).href,
        });
      } catch (cause) {
        finish(Object.assign(fault('failed', 'WFC worker inputs could not be cloned'), { cause }));
      }
    });
  }
  /** Single consumer. Slow readers keep only the latest snapshot; completion closes the stream. Await result for errors. */
  async *[Symbol.asyncIterator](): AsyncGenerator<WFCProgress> {
    if (this.consumed) throw fault('state', 'WFC progress already has a consumer');
    this.consumed = true;
    while (!this.finished || this.latest) {
      if (this.latest) {
        const value = this.latest;
        this.latest = undefined;
        yield value;
      } else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
    this.wake = undefined;
  }
  /** Terminate immediately and reject an unfinished result with coded disposed. Idempotent. */
  dispose(): void {
    this.cancel(fault('disposed', 'WFC worker solve disposed; create another solve'));
  }
  /** Explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

import type { NumericArray } from './index.js';
/** Stable packed shared component view for one system execution. */
export interface SharedComponentView {
  /** Read the first count ids. Structural edits are confined to the calling thread between updates. */
  readonly entities: Uint32Array;
  /** Shared sparse row lookup by entity slot. Use sharedIndex to check the generation. */
  readonly rows: Int32Array;
  /** Slot spacing in entity ids. */
  readonly stride: number;
  /** Occupied packed rows. */
  readonly count: number;
  /** Shared numeric field arrays. Only declared writes may be mutated. */
  readonly fields: Readonly<Record<string, NumericArray>>;
}
/** Resolve a live packed row from a worker view, rejecting stale generations. */
export function sharedIndex(view: SharedComponentView, entity: number): number {
  if (!Number.isInteger(entity) || entity < 0 || entity > 0xffffffff) return -1;
  const row = view.rows[entity % view.stride];
  return row >= 0 && row < view.count && view.entities[row] === entity ? row : -1;
}
/** Worker system invocation; retain neither views nor asynchronous work after the function settles. */
export interface ParallelContext {
  /** Seconds in this update. */
  readonly delta: number;
  /** Accumulated successful update time, including this update. */
  readonly elapsed: number;
  /** Zero-based successful update index. */
  readonly tick: number;
  /** Only the named components declared in reads or writes. */
  readonly components: Readonly<Record<string, SharedComponentView>>;
}
/** Browser Worker or an equivalent app-provided worker endpoint. */
export interface ParallelEndpoint {
  /** Send a structured-clone message. Shared buffers are shared, never transferred. */
  postMessage(message: unknown): void;
  /** Receive messages or endpoint failures. */
  addEventListener(type: string, listener: EventListener): void;
  /** Detach a listener. */
  removeEventListener(type: string, listener: EventListener): void;
}
/** Owned worker endpoint. Termination must stop all shared-memory writes before resolving. */
export interface ParallelWorker extends ParallelEndpoint {
  /** Stop immediately. Promise-returning hosts are awaited before releasing the world lock. */
  terminate(): void | Promise<unknown>;
}
/** Install the worker-side module dispatcher on a dedicated worker endpoint; returns its cleanup function. */
export function serveParallelSystems(endpoint: ParallelEndpoint): () => void {
  let busy = false,
    stopped = false;
  const listener: EventListener = (event) => {
    const data = (event as MessageEvent).data as {
      tag?: string;
      id?: number;
      module?: string;
      exportName?: string;
      context?: ParallelContext;
    };
    if (!data || data.tag !== 'margo-ecs-parallel' || !Number.isSafeInteger(data.id)) return;
    const reply = (ok: boolean, error?: string) => {
      if (!stopped) endpoint.postMessage({ tag: data.tag, id: data.id, ok, error });
    };
    if (busy) {
      reply(false, 'Worker already running; dispatch one system at a time');
      return;
    }
    busy = true;
    void (async () => {
      try {
        if (typeof data.module !== 'string' || typeof data.exportName !== 'string' || !data.context)
          throw new TypeError('Invalid parallel message; dispatch a named module with a context');
        const module = await import(/* @vite-ignore */ data.module);
        if (!Object.hasOwn(module, data.exportName) || typeof module[data.exportName] !== 'function')
          throw new TypeError('Parallel system export is missing; export a system function from the module');
        await module[data.exportName](data.context);
        reply(true);
      } catch (error) {
        reply(false, error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
      }
    })();
  };
  endpoint.addEventListener('message', listener);
  return () => {
    stopped = true;
    endpoint.removeEventListener('message', listener);
  };
}

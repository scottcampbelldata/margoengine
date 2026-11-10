// Clean room: HTML canvas transfer and workers, DOM cancellation, capability-first execution (Dryad, 2007).
import type { EngineKernel } from '@margoengine/core';
import { transferCanvas, workerCanvasSupported, type WorkerCanvas } from './index.js';
import { RpcClient } from './rpc.js';
import { loadScene, type SceneInstance, type SceneTasks } from './scene-runtime.js';
import { fault, rangeError } from '../../shared/errors.js';
export type { SceneContext, SceneInstance, SceneModule } from './scene-runtime.js';

/** Options for automatic worker/page scene selection. */
export interface AutoSceneOptions {
  /** auto chooses a supported worker, then page fallback. page forces page; worker disables fallback. Default auto. */
  mode?: 'auto' | 'worker' | 'page';
  /** Required renderer capability in the worker probe. auto accepts WebGPU or WebGL2. Default auto. */
  backend?: 'auto' | 'webgpu' | 'webgl2';
  /** Passed to createScene on either thread. Default undefined. */
  data?: unknown;
  /** User data to move rather than copy on the worker path. Ignored on the page path. Default none. */
  transfer?: Transferable[];
  /** Startup/lifetime cancellation. Default none. */
  signal?: AbortSignal;
  /** Startup and worker cleanup deadline in milliseconds, above zero. Default 30000. */
  timeout?: number;
  /** Optional factory for a CSP-hosted copy of the bundled generic scene worker. Its worker is owned by this scene. */
  worker?: () => Worker;
}

/** Running shared scene with its selected execution mode and lifetime owner. Use await using for cleanup. */
export class AutoScene {
  declare [Symbol.dispose]: () => Promise<void>;
  declare [Symbol.asyncDispose]: () => Promise<void>;
  private closing?: Promise<void>;
  /** @internal Created by runScene. */
  constructor(
    /** The original canvas, retained on fallback because the worker is probed before transfer. */
    readonly canvas: HTMLCanvasElement,
    /** Selected thread. */
    readonly mode: 'page' | 'worker',
    /** Why auto selected the page, if a worker was attempted but unavailable. */
    readonly fallbackReason: unknown,
    private readonly cleanup: () => Promise<void>,
  ) {}
  /** True once disposal starts. */
  get disposed(): boolean {
    return Boolean(this.closing);
  }
  /** Aborts scene lifetime, runs cleanup once, and terminates an owned worker even if cleanup fails. */
  dispose(): Promise<void> {
    return (this.closing ??= this.cleanup());
  }
  /** Starts cleanup and returns its completion. Use await using to await asynchronous cleanup at scope exit. */
  [(Symbol.dispose ?? Symbol()) as symbol](): Promise<void> {
    return this.dispose();
  }
  [(Symbol.asyncDispose ?? Symbol()) as symbol](): Promise<void> {
    return this.dispose();
  }
}

/** Runs one scene module in a capable worker, otherwise on the page. Runtime scene failures are reported, never replayed. */
export async function runScene(
  canvas: HTMLCanvasElement,
  moduleURL: URL,
  options: AutoSceneOptions = {},
): Promise<AutoScene> {
  const { mode = 'auto', backend = 'auto', timeout = 30_000, signal, data, transfer = [] } = options;
  if (!(timeout > 0 && Number.isFinite(timeout)))
    throw rangeError('Scene timeout must be finite and above zero', 'worker');
  if (!['auto', 'page', 'worker'].includes(mode) || !['auto', 'webgpu', 'webgl2'].includes(backend))
    throw fault('state', 'Choose auto, page or worker mode and a supported backend', 'worker');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const limit = new AbortController();
  const startupSignal = AbortSignal.any([lifetime.signal, limit.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(
    () => limit.abort(fault('timeout', 'Scene startup deadline exceeded; check the scene module', 'worker')),
    timeout,
  );
  let worker: Worker | undefined, client: RpcClient<SceneTasks> | undefined, view: WorkerCanvas | undefined;
  let instance: SceneInstance | undefined, fallbackReason: unknown;
  const attached = new Set<EngineKernel>();
  const cleanPage = async () => {
    try {
      await instance?.dispose();
    } finally {
      for (const engine of attached) engine.dispose();
      attached.clear();
    }
  };
  const abortable = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(startupSignal.reason);
      startupSignal.addEventListener('abort', abort, { once: true });
      if (startupSignal.aborted) abort();
      void operation.then(resolve, reject).finally(() => startupSignal.removeEventListener('abort', abort));
    });
  try {
    if (mode !== 'page') {
      try {
        if (!workerCanvasSupported()) throw fault('unsupported', 'Worker canvas unavailable; use page mode', 'worker');
        worker =
          options.worker?.() ??
          new Worker(new URL(/* @vite-ignore */ './workers/scene.js?no-inline', import.meta.url), { type: 'module' });
        client = new RpcClient<SceneTasks>(worker);
        if (!(await client.call('prepare', [moduleURL.href, backend], { signal: startupSignal, timeout })))
          throw fault('unsupported', 'Worker renderer or animation frames unavailable; use page mode', 'worker');
      } catch (error) {
        client?.dispose();
        worker?.terminate();
        client = undefined;
        worker = undefined;
        startupSignal.throwIfAborted();
        if (mode === 'worker') throw error;
        fallbackReason = error;
      }
    }
    if (worker && client) {
      view = await transferCanvas(canvas, worker, { data, transfer, signal: startupSignal, timeout });
      await client.call('start', [], { signal: startupSignal, timeout });
    } else {
      const module = await abortable(loadScene(moduleURL.href));
      if (typeof module.createScene !== 'function')
        throw fault('state', 'Scene module must export createScene', 'worker');
      const start = Promise.resolve(
        module.createScene({
          canvas,
          data,
          signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
          mode: 'page',
          attach: (engine) => {
            attached.add(engine);
          },
        }),
      );
      // If import/start cannot be interrupted, still dispose anything created after the caller has left.
      void start.then(
        async (late) => {
          if (startupSignal.aborted) await late.dispose();
        },
        () => {},
      );
      instance = await abortable(start);
    }
    startupSignal.throwIfAborted();
    clearTimeout(timer);
    const running = new AutoScene(canvas, worker ? 'worker' : 'page', fallbackReason, async () => {
      signal?.removeEventListener('abort', abort);
      lifetime.abort();
      try {
        if (client) await client.call('dispose', [], { timeout });
        else await cleanPage();
      } finally {
        view?.dispose();
        client?.dispose();
        worker?.terminate();
      }
    });
    const abort = () => {
      void running.dispose().catch((error) => canvas.dispatchEvent(new ErrorEvent('error', { error })));
    };
    signal?.addEventListener('abort', abort, { once: true });
    return running;
  } catch (error) {
    lifetime.abort();
    view?.dispose();
    client?.dispose();
    worker?.terminate();
    await cleanPage();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

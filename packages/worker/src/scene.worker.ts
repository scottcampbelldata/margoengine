// Lazy generic bootstrap: imports the application scene only after the page supplies its absolute module URL.
import { receiveCanvas, type ReceivedCanvas } from './canvas.js';
import { exposeRpc } from './rpc.js';
import { loadScene, workerContext, type SceneInstance, type SceneModule, type SceneTasks } from './scene-runtime.js';
import { fault } from '../../shared/errors.js';

let module: SceneModule | undefined;
let view: Promise<ReceivedCanvas> | undefined;
let instance: SceneInstance | undefined;
let preparing = false;
let started = false;
const lifetime = new AbortController();
const supported = async (backend: 'auto' | 'webgpu' | 'webgl2'): Promise<boolean> => {
  if (typeof OffscreenCanvas !== 'function' || typeof requestAnimationFrame !== 'function') return false;
  if (backend !== 'webgl2' && typeof navigator.gpu?.requestAdapter === 'function') {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) return true;
  }
  if (backend === 'webgpu') return false;
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return Boolean(gl);
};

exposeRpc<SceneTasks>({
  async prepare(url, backend) {
    if (preparing) throw fault('state', 'Scene worker already prepared; create a new scene', 'worker');
    preparing = true;
    if (!(await supported(backend))) return false;
    module = await loadScene(url);
    if (typeof module.createScene !== 'function')
      throw fault('state', 'Scene module must export createScene', 'worker');
    view = receiveCanvas({ signal: lifetime.signal });
    // The RPC caller receives a receiveCanvas timeout through start(), without an unhandled rejection if it leaves.
    void view.catch(() => {});
    return true;
  },
  async start({ signal }) {
    if (!module || !view || started) throw fault('state', 'Prepare a new worker scene before starting', 'worker');
    started = true;
    const received = await view;
    const sceneSignal = AbortSignal.any([signal, lifetime.signal, received.signal]);
    instance = await module.createScene(workerContext(received, sceneSignal));
    if (sceneSignal.aborted) {
      await instance.dispose();
      instance = undefined;
      sceneSignal.throwIfAborted();
    }
  },
  async dispose() {
    lifetime.abort();
    const current = instance;
    instance = undefined;
    try {
      await current?.dispose();
    } finally {
      if (view) (await view).dispose();
    }
  },
});

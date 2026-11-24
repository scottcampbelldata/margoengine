// A small fake WebGPU binding on the CPU for core's device-loss tests: every call the renderer makes returns a stub
// whose methods return more stubs, so the real Engine and GPURenderer run on it. `install()` puts it on globalThis and
// returns the record: `devices` (each with `lose()`, `submits` and `lost`), `adapters` (requestAdapter calls),
// `pipelines` (createRenderPipelineAsync calls) and `uninstall()`. `loseAtStart(n)` makes the n-th device (0 first)
// come back from requestDevice already lost.
const GLOBALS = ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode'];
const KEEP = new Set(['destroy', 'unmap', 'unconfigure']);

function stub(extra = {}) {
  return new Proxy(extra, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      if (KEEP.has(key)) return () => {};
      return () => stub();
    },
  });
}

export function install() {
  const saved = Object.fromEntries(GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])),
    gpu = { devices: [], adapters: 0, pipelines: 0, lostAtStart: new Set() };
  gpu.loseAtStart = (n) => gpu.lostAtStart.add(n);
  function device() {
    let resolve;
    const lost = new Promise((r) => (resolve = r)),
      record = { id: gpu.devices.length, lost: false, destroyed: false, submits: 0 };
    record.lose = (message = 'lost') => {
      if (record.lost) return;
      record.lost = true;
      resolve({ reason: 'unknown', message });
    };
    record.device = stub({
      features: new Set(),
      limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27, maxTextureDimension2D: 8192 },
      lost,
      addEventListener() {},
      removeEventListener() {},
      destroy() {
        record.destroyed = true;
        record.lose('destroyed');
      },
      queue: stub({
        submit() {
          if (!record.lost) record.submits++;
        },
        onSubmittedWorkDone: async () => {},
      }),
      createRenderPipelineAsync: async () => (gpu.pipelines++, stub()),
    });
    gpu.devices.push(record);
    if (gpu.lostAtStart.has(record.id)) record.lose('lost during startup');
    return record.device;
  }
  const adapter = { features: new Set(), limits: {}, requestDevice: async () => device() },
    define = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define('navigator', {
    userAgent: 'fake',
    gpu: {
      requestAdapter: async () => (gpu.adapters++, adapter),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  define('GPUBufferUsage', {});
  define('GPUTextureUsage', {});
  define('GPUMapMode', { READ: 1, WRITE: 2 });
  gpu.canvas = {
    width: 32,
    height: 32,
    clientWidth: 32,
    clientHeight: 32,
    getContext: (type) =>
      type === 'webgpu' ? stub({ configure() {}, getCurrentTexture: () => stub({ width: 32, height: 32, format: 'bgra8unorm', sampleCount: 1 }) }) : null,
  };
  gpu.uninstall = () => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  };
  return gpu;
}

/** Lets queued promise jobs and immediates run (device-lost handlers, restores). */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A display refresh queue on globalThis: frames wait in `queue` until `refresh(time)` runs the ones scheduled before
 * it. `uninstall()` puts the old requestAnimationFrame and cancelAnimationFrame back.
 */
export function frames() {
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame],
    queue = new Map();
  let next = 1;
  globalThis.requestAnimationFrame = (callback) => (queue.set(next, callback), next++);
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  return {
    queue,
    refresh(time = 16) {
      const due = [...queue];
      queue.clear();
      for (const [, callback] of due) callback(time);
    },
    uninstall() {
      [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
    },
  };
}

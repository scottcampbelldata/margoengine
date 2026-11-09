// Engine stand-in for post's node tests: a real frame graph and plugin map over the recording mock GPU
// (examples/package-benchmarks/proofs/gpu-recorder.js), every GPU resource an effect creates kept for leak checks.
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';

export function harness({ samples = 4, shader = wgsl, format = 'bgra8unorm', lighting } = {}) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map(),
    resources = [];
  let host = false;
  for (const kind of ['createTexture', 'createBuffer']) {
    const create = gpu.device[kind];
    gpu.device[kind] = (descriptor) => {
      const r = create(descriptor);
      if (!host) resources.push(r);
      return r;
    };
  }
  const engine = {
    gpu: gpu.device,
    frameGraph: graph,
    lighting: lighting ?? {
      direction: new Float32Array([3, 5, 4, 3]),
      radiance: new Float32Array([1, 1, 1, 0.15]),
      ambient: new Float32Array([1, 1, 1]),
    },
    hasPlugin: (name) => plugins.has(name),
    sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
    use(plugin) {
      if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
      plugins.set(plugin.name, plugin);
      try {
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        plugins.set(plugin.name, plugin);
      } catch (error) {
        graph.removeOwner(plugin.name);
        plugins.delete(plugin.name);
        plugin.dispose?.();
        throw error;
      }
      return engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
    restore() {
      for (const plugin of [...plugins.values()]) plugin.onDeviceRestored?.(engine);
    },
  };
  const view = context(gpu, { samples, shader, format }),
    draws = [];
  let index = 0;
  const frame = (bindings = []) => {
    host = true;
    view.begin(index++);
    host = false;
    view.c.bindings.push(...bindings);
    view.c.draw = (o) => draws.push({ ...o, color: view.c.color, descriptor: view.c.descriptor });
    graph.execute(view.c);
  };
  return { gpu, engine, view, plugins, draws, frame, live: () => resources.filter((r) => !r.destroyed) };
}
/** WGSL of every shader module created in `log`. */
export const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
/** The float32 values of the first buffer write of `bytes` bytes in `log`. */
export function written(log, bytes, nth = 0) {
  const e = log.filter((entry) => entry[0] === 'writeBuffer' && entry[3].length === bytes * 2)[nth],
    b = Buffer.from(e[3], 'hex');
  return new Float32Array(b.buffer, b.byteOffset, bytes / 4);
}

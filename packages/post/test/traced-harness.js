import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack } from '../dist/index.js';
// Shared by the traced effects' tests (rt-reflections, rt-gi), after the SSR tests' harness: a recorded device, a frame graph and a 1x pass context, with core's default lighting.
export function tracedHarness() {
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
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    hasPlugin: (name) => plugins.has(name),
    sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
    use(plugin) {
      plugins.set(plugin.name, plugin);
      graph.withOwner(plugin.name, () => {
        plugin.setup(engine);
        plugin.registerPasses?.(graph);
      });
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
  };
  const view = context(gpu, { samples: 1, shader: wgsl, format: 'bgra8unorm' });
  let index = 0;
  const frame = () => {
    host = true;
    view.begin(index++);
    host = false;
    view.c.draw = () => {};
    graph.execute(view.c);
  };
  // A stand-in GPUSceneBVH: the five buffers its WGSL binds.
  const buffer = (size) => gpu.device.createBuffer({ size, usage: 0x80 });
  const buffers = [buffer(32), buffer(16), buffer(16), buffer(112), buffer(16)];
  const scene = {
    device: gpu.device,
    disposed: false,
    bindings: (first = 0) => buffers.map((b, i) => ({ binding: first + i, resource: { buffer: b } })),
  };
  return {
    gpu,
    engine,
    frame,
    scene,
    stack: (effects) => new PostStack(effects),
    live: () => resources.filter((r) => !r.destroyed && !buffers.includes(r)),
  };
}
export const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
export const floats = (hex) => new Float32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer);

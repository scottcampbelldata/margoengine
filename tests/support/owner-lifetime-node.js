import { Engine, TransformStore } from '@margoengine/core/extension';
import { Camera } from '@margoengine/core';
import { optionalGPU } from './optional-gpu.js';

class Canvas extends EventTarget {
  width = 64;
  height = 32;
  clientWidth = 64;
  clientHeight = 32;
  style = { touchAction: 'auto' };
  captures = new Set();
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 64, height: 32 }; }
  attributes = new Map();
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getContext() {
    const canvas = this;
    return { configure() {}, getConfiguration: () => ({ device: canvas.device, format: 'bgra8unorm' }),
      getCurrentTexture: () => ({ width: 8, height: 8, format: 'bgra8unorm' }) };
  }
}
class Frame {
  displayWidth = 8;
  closed = false;
  close() { this.closed = true; this.displayWidth = 0; }
}

// The browser members the inert device lacks, filled in here and only here: fixtures never shim a device, so on a real
// device they build real resources. Every device the adapter makes (first and after each loss) gets them.
const enums = {
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
};
function completeDevice(device) {
  device.createPipelineLayout ??= (descriptor) => descriptor;
  device.pushErrorScope ??= () => {};
  device.popErrorScope ??= async () => null;
  device.queue.writeTexture ??= () => {};
  device.limits.maxTextureArrayLayers ??= 256;
  device.limits.maxTextureDimension2D ??= 8192;
}
// Core's standard lit shader lines that plugins rewrite (lighting, tone mapping, ambient), and its vertex layout, as a
// real frame hands them over.
const standardShader = [
  '@group(0) @binding(0) var<uniform> frame:Frame;', '@vertex fn vertex(i:Input)->Output {',
  '@fragment fn fragment(i:In)->@location(0) vec4f {', 'let direct=vec3f(1);',
  'let ambient=i.color*frame.radiance.w*frame.ambient.rgb;', 'let linear=direct*vec3f(1);',
  'let mapped=pbrNeutral(max(linear,vec3f(0))); return vec4f(mapped,1);}',
].join('\n');

// Executes real engine scene routing, updates and frame graphs, but issues no GPU work.
export async function nodeLifetimeAdapter() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.VideoFrame = Frame;
  const added = Object.keys(enums).filter((name) => !(name in globalThis));
  for (const name of added) globalThis[name] = enums[name];
  return {
    close() {
      if (previous) Object.defineProperty(globalThis, 'VideoFrame', previous);
      else delete globalThis.VideoFrame;
      for (const name of added) delete globalThis[name];
    },
    async create() {
      const makeGPU = () => {
        const h = optionalGPU();
        completeDevice(h.engine.gpu);
        const begin = h.context.encoder.beginRenderPass;
        h.engine.gpu.createCommandEncoder = () => ({
          ...h.context.encoder,
          beginRenderPass(descriptor) {
            return { ...begin(descriptor), setViewport() {}, setScissorRect() {} };
          },
          finish() { return {}; },
        });
        return h;
      };
      let gpu = makeGPU();
      const renderer = {
        backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, dispose() {},
        render(camera, _lighting, _batches, graph, delta, view) {
          const context = { ...gpu.context, camera, delta, width: 64, height: 32, shader: standardShader,
            descriptor: { multisample: { count: 1 }, vertex: { buffers: [] },
              depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } },
            device: renderer.gpu, encoder: renderer.gpu.createCommandEncoder(),
            view: view && { ...view, viewport: view.rect } };
          graph.execute(context);
        },
      };
      const canvas = new Canvas();
      Object.defineProperty(canvas, 'device', { get: () => renderer.gpu });
      const engine = new Engine(canvas, await TransformStore.create(32), renderer, undefined, null);
      const scenes = new Set([engine.scene]);
      const create = engine.createScene.bind(engine);
      engine.createScene = (...args) => { const scene = create(...args); scenes.add(scene); return scene; };
      return {
        engine,
        camera: () => new Camera(),
        frame: () => new Frame(),
        async render(views) { engine.render({ views, delta: 0.125 }); },
        async lose(observer) {
          // Deterministic notification simulation; browser adapter separately proves real device destruction/recovery.
          observer.lost(renderer.gpu);
          gpu = makeGPU();
          renderer.gpu = gpu.engine.gpu;
          observer.watchDevice(renderer.gpu);
          for (const scene of scenes) {
            const plugins = [...scene.plugins.values()];
            if (!plugins.length) continue;
            const scope = { name: 'owner-lifetime:restore', setup() {
              for (const plugin of plugins) plugin.onDeviceRestored?.(engine);
            } };
            scene.use(scope);
            scene.removePlugin(scope.name);
          }
        },
      };
    },
  };
}

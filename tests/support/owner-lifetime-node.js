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
}
class Frame {
  displayWidth = 8;
  closed = false;
  close() { this.closed = true; this.displayWidth = 0; }
}

// Executes real engine scene routing, updates and frame graphs, but issues no GPU work.
export async function nodeLifetimeAdapter() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  globalThis.VideoFrame = Frame;
  return {
    close() {
      if (previous) Object.defineProperty(globalThis, 'VideoFrame', previous);
      else delete globalThis.VideoFrame;
    },
    async create() {
      const makeGPU = () => {
        const h = optionalGPU();
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
          const context = { ...gpu.context, camera, delta, width: 64, height: 32,
            descriptor: { multisample: { count: 1 },
              depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } },
            device: renderer.gpu, encoder: renderer.gpu.createCommandEncoder(),
            view: view && { ...view, viewport: view.rect } };
          graph.execute(context);
        },
      };
      const engine = new Engine(new Canvas(), await TransformStore.create(32), renderer, undefined, null);
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

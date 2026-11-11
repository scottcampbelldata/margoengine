import { EngineKernel, Camera } from '../../packages/core/dist/index.js';
import { engineRuntime } from '../../packages/core/dist/extension.js';
import { waitForPipelines } from '../../scripts/support/gpu-ready.js';
import { invariant } from './owner-lifetime.js';

export const browserLifetimeAdapter = {
  async create() {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
    instance.stop();
    const engine = engineRuntime(instance);
    const background = engine.createScene('lifetime-background');
    const makeTarget = () => engine.gpu.createTexture({ size: [64, 32], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    let target = makeTarget();
    return {
      engine,
      camera: () => new Camera(),
      frame() {
        const pixels = new OffscreenCanvas(8, 8), context = pixels.getContext('2d');
        context.fillStyle = '#ff0000';
        context.fillRect(0, 0, 8, 8);
        return new VideoFrame(pixels, { timestamp: 0 });
      },
      async pixels() {
        // A caller-owned target survives task boundaries; swapchain textures do not.
        const buffer = engine.gpu.createBuffer({ size: 64 * 32 * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const encoder = engine.gpu.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [64, 32]);
          engine.gpu.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          return new Uint8Array(buffer.getMappedRange()).slice();
        } finally { buffer.destroy(); }
      },
      async render(views) {
        engine.gpu.pushErrorScope('validation');
        await waitForPipelines(async () => {
          // Swapchain contents outside partial views are not retained across tasks.
          // Establish the same full-canvas background in this submission before every measured pair.
          engine.render({ views: [
            { scene: background, camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }, ...views,
          ].map((view) => ({ ...view, target: { color: target } })), delta: 0.125 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        const error = await engine.gpu.popErrorScope();
        invariant(!error, `WebGPU validation: ${error?.message}`);
      },
      async lose(observer) {
        const previous = engine.gpu;
        previous.destroy();
        const loss = await previous.lost;
        invariant(loss.reason === 'destroyed', 'test observes real GPU device destruction');
        observer.lost(previous);
        await engine.rebootDevice();
        invariant(engine.gpu !== previous, 'recovery supplies a new GPU device');
        observer.watchDevice(engine.gpu);
        target = makeTarget();
      },
      close() { target.destroy(); canvas.remove(); },
    };
  },
};

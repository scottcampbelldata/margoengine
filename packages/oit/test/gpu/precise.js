import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { PostStack, Bloom } from '../../../post/dist/index.js';
import { OIT } from '../../dist/index.js';
import { PreciseOIT } from '../../dist/precise.js';

let engine, canvas, pass, stack;
const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const draw = async () => {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  async build({
    samples = 1,
    layers = 8,
    brightness = 1000,
    mode = 'precise',
    reverse = false,
    blocker = false,
    edge = false,
  } = {}) {
    pass?.dispose();
    engine?.dispose();
    canvas?.remove();
    globalThis.margoLow = samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:64px;height:64px;display:block';
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      features: ['float32-blendable'],
      preserveDrawingBuffer: true,
      camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
    });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    stack = PostStack.attach(engine, [new Bloom({ strength: 0 })]);
    const mesh = (rgb, opacity, z, emission = 0) => {
      const m = createMesh(
        engine,
        planeGeometry(edge && opacity < 1 ? 1.6 : 4, edge && opacity < 1 ? 1.6 : 4),
        new Material({
          shading: 'basic',
          color: emission ? [0, 0, 0] : rgb,
          emissive: emission ? rgb : [0, 0, 0],
          emissiveIntensity: emission,
          opacity,
          transparent: opacity < 1,
        }),
      );
      m.root.setPosition([0, 0, z]);
      if (edge && opacity < 1) m.root.setRotation([0, 0, 0.2]);
      return m;
    };
    mesh([0, 0, 0], 1, -2);
    if (blocker) mesh([0.25, 0.5, 0.75], 1, 1);
    pass = mode === 'half' ? OIT.attach(engine, { depthScale: 10 }) : PreciseOIT.attach(engine, { depthScale: 10 });
    const models = Array.from({ length: layers }, (_, i) => mesh([1, 0.5, 0.25], 0.5, 0.9 - i * 0.01, brightness));
    for (const m of reverse ? models.reverse() : models) pass.add(m);
    await waitForPipelines(draw);
    const device = engine.gpu,
      texture = stack.sceneTexture;
    const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, origin: [32, 32] }, { buffer: read, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = [...new Float16Array(read.getMappedRange().slice(0, 8))];
    read.destroy();
    return result;
  },
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;

import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { Camera } = await import('/packages/core/dist/extension.js');
    const { OrbitAtmosphere } = await import('/packages/creative/dist/planet-atmosphere.js');
    let device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const errors = [];
    const watch = () => device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    watch();
    const effect = new OrbitAtmosphere();
    let execute;
    effect.setup({ gpu: device, sceneOf: () => undefined });
    effect.registerPasses({ add: (p) => (execute = p.execute) });
    const camera = new Camera({ position: [0, 0, 3], target: [0, 0, 0], near: 0.01, far: 100 });
    camera.update(1, true);
    const image = async () => {
      const texture = device.createTexture({
        size: [96, 96],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const depth = device.createTexture({
        size: [96, 96],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const buffer = device.createBuffer({ size: 512 * 96, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder(),
        color = texture.createView(),
        z = depth.createView();
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: color, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: z, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
        })
        .end();
      execute({
        backend: 'webgpu',
        device,
        encoder,
        color,
        depth: z,
        format: 'rgba8unorm',
        width: 96,
        height: 96,
        camera,
        descriptor: { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
      });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512 }, [96, 96]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      let lit = 0,
        sum = 0,
        hash = 0;
      for (let y = 0; y < 96; y++)
        for (let x = 0; x < 96; x++) {
          const i = y * 512 + x * 4;
          sum += data[i] + data[i + 1] + data[i + 2];
          if (data[i] + data[i + 1] + data[i + 2] > 12) lit++;
          hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 256 + data[i + 2] * 65536) | 0;
        }
      buffer.unmap();
      buffer.destroy();
      texture.destroy();
      depth.destroy();
      return { lit, sum, hash };
    };
    try {
      const initial = await image();
      effect.options.sun = [-1, 0, 0];
      const opposite = await image();
      effect.options.atmosphere = {
        mie: 0,
        mieAbsorption: 0,
        rayleigh: [0, 0, 0],
        ozone: [0, 0, 0],
        groundAlbedo: [0, 0, 0],
      };
      const vacuum = await image();
      effect.options.atmosphere = undefined;
      const before = await image();
      const old = device;
      device = await (await navigator.gpu.requestAdapter()).requestDevice();
      watch();
      effect.onDeviceRestored({ gpu: device, sceneOf: () => undefined });
      old.destroy();
      const after = await image();
      effect.enabled = false;
      const hidden = await image();
      effect.dispose();
      effect.dispose();
      return { initial, opposite, vacuum, before, after, hidden, errors };
    } finally {
      device.destroy();
    }
  });
  console.log(JSON.stringify(result));
  assert.ok(result.initial.lit > 100);
  assert.notEqual(result.initial.hash, result.opposite.hash);
  assert.ok(result.vacuum.sum < result.initial.sum / 10);
  assert.deepEqual(result.before, result.after);
  assert.ok(result.hidden.sum < result.before.sum / 10);
  assert.deepEqual(result.errors, []);
} finally {
  await browser.close();
}

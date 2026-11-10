import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/cameras/test/browser-check.html', port: 5208 });
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const result = await browser.page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
    const { capturePanorama, panoramaPNG } = await import('/packages/cameras/dist/panorama.js');
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    canvas.style.width = '160px';
    canvas.style.height = '90px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 0], target: [0, 0, -1] },
    });
    const device = engine.gpu,
      errors = [];
    // Ambient-only primaries isolate cube orientation from white specular highlights.
    engine.lighting.direction[3] = 0;
    engine.lighting.radiance[3] = 1;
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    device.pushErrorScope('validation');
    try {
      const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
      const directions = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      for (let i = 0; i < 6; i++)
        engine
          .createMesh()
          .setGeometry(box(2, 2, 2))
          .setMaterial(new PbrMaterial({ color: colors[i] }))
          .setPosition(directions[i].map((v) => v * 4));
      const saved = {
        position: [...engine.camera.position],
        target: [...engine.camera.target],
        plugins: engine.hasPlugin('cube-camera-1'),
      };
      const image = await capturePanorama(engine, { size: 64, width: 260 }); // unaligned rows exercise readback padding
      const at = (u, v) => [
        ...image.data.slice(
          (Math.floor(v * image.height) * image.width + Math.floor(u * image.width)) * 4,
          (Math.floor(v * image.height) * image.width + Math.floor(u * image.width)) * 4 + 4,
        ),
      ];
      const samples = [
        [0.75, 0.5],
        [0.25, 0.5],
        [0.5, 0],
        [0.5, 0.999],
        [0.001, 0.5],
        [0.5, 0.5],
      ].map(([u, v]) => at(u, v));
      const png = await panoramaPNG(image);
      // A pre-baked cube tests HDR preservation, exact sRGB conversion, yaw and caller ownership.
      const texture = device.createTexture({
        size: [8, 8, 6],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      for (let face = 0; face < 6; face++) {
        const half = new Uint16Array(8 * 8 * 4);
        for (let p = 0; p < 64; p++) half.set([0x4000, 0x3400, 0, 0x3c00], p * 4); // 2, 0.25, 0, 1
        device.queue.writeTexture({ texture, origin: [0, 0, face] }, half, { bytesPerRow: 64 }, [8, 8]);
      }
      const cube = { view: texture.createView({ dimension: 'cube' }) };
      const hdr = await capturePanorama(engine, { cube, width: 18, format: 'linear', yaw: 0.8 });
      const ldr = await capturePanorama(engine, { cube, width: 18 });
      const controller = new AbortController();
      const cancelled = capturePanorama(engine, {
        cube: {
          view: cube.view,
          update() {
            queueMicrotask(() => controller.abort(new Error('cancelled readback')));
            return 6;
          },
        },
        width: 18,
        signal: controller.signal,
      });
      let abort = '';
      try {
        await cancelled;
      } catch (e) {
        abort = e.message;
      }
      texture.destroy();
      return {
        samples,
        width: image.width,
        height: image.height,
        png: [...new Uint8Array(await png.arrayBuffer())],
        hdr: [...hdr.data.slice(0, 4)],
        ldr: [...ldr.data.slice(0, 4)],
        abort,
        saved,
        after: {
          position: [...engine.camera.position],
          target: [...engine.camera.target],
          width: canvas.width,
          height: canvas.height,
        },
        validation: (await device.popErrorScope())?.message ?? null,
        errors,
      };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  assert.equal(result.validation, null);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.width, result.height], [260, 130]);
  for (const [i, channels] of [
    [0, [0]],
    [1, [1]],
    [2, [2]],
    [3, [0, 1]],
    [4, [0, 2]],
    [5, [1, 2]],
  ]) {
    for (let c = 0; c < 3; c++)
      assert.ok(
        channels.includes(c) ? result.samples[i][c] > 80 : result.samples[i][c] < 30,
        `face ${i}: ${result.samples[i]}`,
      );
  }
  assert.deepEqual(result.hdr, [2, 0.25, 0, 1]);
  assert.deepEqual(result.ldr, [255, 137, 0, 255]);
  assert.match(result.abort, /cancelled readback/);
  assert.deepEqual(result.after, {
    position: result.saved.position,
    target: result.saved.target,
    width: 160,
    height: 90,
  });
  const png = await decodePNG(Uint8Array.from(result.png));
  assert.deepEqual([png.width, png.height], [260, 130]);
  console.log(
    'panorama: six rendered axes, padded rows, PNG, HDR, sRGB, cancellation and state passed',
    JSON.stringify(browser.hardware),
  );
} finally {
  await browser.close();
}

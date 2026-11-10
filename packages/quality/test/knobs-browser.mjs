import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
setTimeout(() => {
  console.error('quality knobs hard timeout');
  process.exit(124);
}, 180000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 'free' });
const problems = [];
context.page.on('pageerror', (error) => problems.push(error.message));
context.page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') console.log(message.text());
});
try {
  for (const backend of ['webgpu', 'webgl2']) {
    await context.page.reload();
    const result = await context.page.evaluate(async (backend) => {
      if (backend === 'webgl2') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { VFX } = await import('/packages/vfx/dist/base.js');
      const { textureResolutionKnob, particleKnob, renderTargetKnob, msaaKnob } = await import(
        '/packages/quality/dist/knobs.js'
      );
      const msaa = msaaKnob(),
        samples = [],
        errors = [],
        resources = [];
      const canvas = document.querySelector('canvas');
      const create = async () => {
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 4], target: [0, 0, 0] },
        });
        engine.stop();
        engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        engine.use({
          name: 'sample probe',
          setup() {},
          registerPasses(graph) {
            graph.add({
              name: 'sample probe',
              order: 1,
              execute(c) {
                samples.push(c.descriptor.multisample.count);
              },
            });
          },
        });
        return engine;
      };
      let frame = 0;
      const render = async (engine, options) => {
        engine.gpu.pushErrorScope('validation');
        engine.render(options);
        const error = await engine.gpu.popErrorScope();
        if (error) throw new Error('Frame ' + frame + ': ' + error.message);
        frame++;
      };
      msaa.prepare();
      let engine = await create();
      await render(engine);
      msaa.apply(1);
      await render(engine);
      await engine.gpu.queue.onSubmittedWorkDone();
      engine.dispose();
      msaa.prepare();
      engine = await create();
      await render(engine);
      const device = engine.gpu;
      const readBuffer = async (source, bytes) => {
        const buffer = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, 0, buffer, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Uint32Array(buffer.getMappedRange()));
        buffer.unmap();
        buffer.destroy();
        return values;
      };
      const pixel = async (texture) => {
        const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Uint8Array(buffer.getMappedRange()).slice(0, 4));
        buffer.unmap();
        buffer.destroy();
        return values;
      };
      const raster = new OffscreenCanvas(8, 8),
        draw = raster.getContext('2d');
      for (let x = 0; x < 8; x++) {
        draw.fillStyle = x % 2 ? '#ffffff' : '#000000';
        draw.fillRect(x, 0, 1, 8);
      }
      const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 23 });
      resources.push(texture);
      device.queue.copyExternalImageToTexture({ source: raster }, { texture }, [8, 8]);
      let bound = texture;
      const textures = textureResolutionKnob({
        device,
        texture,
        source: raster,
        bind(value) {
          bound = value;
        },
      });
      const textureRows = [];
      for (const level of [1, 2, 0]) {
        textures.apply(level);
        textureRows.push({ width: bound.width, height: bound.height, pixel: await pixel(bound) });
      }
      textures.dispose();
      engine.scene.background = '#ff0000';
      const color = device.createTexture({ size: [64, 32], format: 'rgba8unorm', usage: 17 });
      resources.push(color);
      const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color } };
      const targets = renderTargetKnob({
        device,
        texture: color,
        bind(value) {
          view.target = { color: value };
        },
      });
      const targetRows = [];
      for (const level of [1, 2, 0]) {
        targets.apply(level);
        await render(engine, { views: [view] });
        targetRows.push({
          width: view.target.color.width,
          height: view.target.color.height,
          pixel: await pixel(view.target.color),
        });
      }
      targets.dispose();
      engine.createMesh().setGeometry(box());
      const vfx = VFX.attach(engine, { capacity: 128, rate: 100, life: [10, 10], gravity: [0, 0, 0] });
      const particles = particleKnob(vfx),
        counts = [];
      for (const level of [0, 1, 3, 0]) {
        particles.apply(level);
        await render(engine, { delta: 0.1 });
        counts.push((await readBuffer(vfx.gpuState.indirect, 16))[1]);
      }
      particles.apply(0);
      await device.queue.onSubmittedWorkDone();
      for (const resource of resources) resource.destroy();
      engine.dispose();
      return { samples: samples.slice(0, 3), textureRows, targetRows, counts, errors };
    }, backend);
    console.log(backend, JSON.stringify(result));
    assert.deepEqual(result.samples, [4, 4, 1], 'live selection changes no hardware; recreation applies it');
    assert.deepEqual(
      result.textureRows.map(({ width, height }) => [width, height]),
      [
        [4, 4],
        [2, 2],
        [8, 8],
      ],
    );
    for (const row of result.textureRows.slice(0, 2)) {
      assert.ok(row.pixel[0] > 80 && row.pixel[0] < 180, 'stripes are prefiltered');
      assert.equal(row.pixel[3], 255);
    }
    assert.deepEqual(result.textureRows[2].pixel, [0, 0, 0, 255]);
    assert.deepEqual(
      result.targetRows.map(({ width, height }) => [width, height]),
      [
        [32, 16],
        [16, 8],
        [64, 32],
      ],
    );
    for (const row of result.targetRows) assert.deepEqual(row.pixel, [255, 0, 0, 255]);
    assert.deepEqual(result.counts, [10, 15, 15, 25]);
    assert.deepEqual(result.errors, []);
  }
  assert.deepEqual(problems, []);
} finally {
  await context.close();
}

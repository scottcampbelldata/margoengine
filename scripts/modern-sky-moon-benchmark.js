import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

const browser = await openBrowser(),
  errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
try {
  const measurements = await browser.page.evaluate(async () => {
    const { SkyMoonPass } = await import('/packages/scenery/dist/index.js');
    const { Camera } = await import('/packages/core/dist/index.js');
    const { invert } = await import('/packages/shared/math.js');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has('timestamp-query'))
      throw new Error('GPU timestamp queries are needed for this benchmark');
    const device = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query'],
    });
    device.pushErrorScope('validation');
    const sky = new SkyMoonPass(device, 'rgba16float'),
      camera = new Camera({
        position: [0, 0, 0],
        target: [0, 0.5, -1],
        fov: 58,
      });
    const inverse = new Float32Array(16),
      workspace = new Float64Array(52),
      commands = [];
    sky.setConfig({
      moonDirection: [0, 0.4, -0.9],
      moonSize: 0.035,
      moonPhase: 0.85,
      hazeDensity: 1,
      starIntensity: 1,
      starTwinkleIntensity: 0.8,
    });
    const query = device.createQuerySet({ type: 'timestamp', count: 2 }),
      resolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      }),
      read = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    const rows = [];
    for (const [width, height] of [
      [1280, 900],
      [1920, 1080],
    ]) {
      camera.update(width / height, true);
      if (!invert(inverse, camera.matrix, 0, workspace))
        throw new Error('Camera inversion failed');
      const texture = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const descriptor = {
        colorAttachments: [
          {
            view: texture.createView(),
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        timestampWrites: {
          querySet: query,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      };
      const gpu = [],
        cpu = [],
        drawsPerSample = 64;
      for (let i = 0; i < 150; i++) {
        const start = performance.now();
        sky.updateFrame(inverse, camera.position, i / 60);
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginRenderPass(descriptor);
        for (let draw = 0; draw < drawsPerSample; draw++) sky.record(pass);
        pass.end();
        encoder.resolveQuerySet(query, 0, 2, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
        commands[0] = encoder.finish();
        device.queue.submit(commands);
        const elapsed = performance.now() - start;
        await read.mapAsync(GPUMapMode.READ);
        const stamps = new BigUint64Array(read.getMappedRange());
        if (i >= 50) {
          gpu.push(Number(stamps[1] - stamps[0]) / 1e6 / drawsPerSample);
          cpu.push(elapsed);
        }
        read.unmap();
      }
      gpu.sort((a, b) => a - b);
      cpu.sort((a, b) => a - b);
      rows.push({
        width,
        height,
        samples: gpu.length,
        drawsPerSample,
        gpuMedianMs: gpu[49],
        gpuP95Ms: gpu[94],
        cpuBatchMedianMs: cpu[49],
        cpuBatchP95Ms: cpu[94],
      });
      texture.destroy();
    }
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    sky.dispose();
    query.destroy();
    resolve.destroy();
    read.destroy();
    device.destroy();
    return rows;
  });
  assert.deepEqual(errors, []);
  const report = {
    hardware: browser.hardware,
    measurements,
    note: 'GPU timestamp-query measures SkyMoonPass per draw, batching 64 draws to exceed timestamp quantization. CPU times include one upload and a 64-draw command batch. Does not measure presentation refresh.',
  };
  const suffix = process.argv.includes('--before') ? '-before' : '';
  await writeFile(
    `test-results/sky-moon-benchmark${suffix}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

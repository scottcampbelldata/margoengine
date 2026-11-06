// Real-GPU check of supersample, built packages. Takes the GPU lock itself around the browser.
// node packages/quality/test/ssaa-browser.mjs
// The reference is the same scene drawn 8 times wider and taller and box-filtered in linear light: what supersampling
// should reach. A plain frame and a 64-sample still are each compared with it by PSNR.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'quality-ssaa' });
setTimeout(() => {
  console.error('ssaa-browser: stopped at its time limit');
  process.exit(124);
}, 180_000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 5212 }),
  { page } = context,
  problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});

const setup = async (low) => {
  await page.reload();
  await page.evaluate(async (low) => {
    if (low) globalThis.margoLow = 1;
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      ssaa = await import('/packages/quality/dist/ssaa.js'),
      canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 3, 9], target: [0, 0, 0] } });
    engine.stop();
    const light = new PbrMaterial({ color: '#f0f0e8' }),
      dark = new PbrMaterial({ color: '#203040' }),
      meshes = [];
    for (let x = -6; x <= 6; x++)
      for (let z = -3; z <= 3; z++)
        meshes.push(
          engine
            .createMesh()
            .setGeometry(box(0.4, 0.4, 0.4))
            .setPosition([x * 0.8, 0, z * 0.8])
            .setRotation([0, 0.4 * x, 0])
            .setMaterial((x + z) & 1 ? light : dark),
        );
    const errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const display = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    window.t = {
      engine,
      ssaa,
      meshes,
      errors,
      /** The image box-filtered down by `factor` in linear light, as display bytes. */
      shrink({ width, height, data }, factor) {
        const w = width / factor,
          h = height / factor,
          out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            for (let k = 0; k < 3; k++) {
              let sum = 0;
              for (let j = 0; j < factor; j++)
                for (let i = 0; i < factor; i++)
                  sum += linear(data[((y * factor + j) * width + x * factor + i) * 4 + k] / 255);
              out[(y * w + x) * 4 + k] = Math.round(display(sum / (factor * factor)) * 255);
            }
        return out;
      },
      psnr(a, b) {
        let sum = 0,
          count = 0;
        for (let i = 0; i < a.length; i += 4)
          for (let k = 0; k < 3; k++) {
            sum += (a[i + k] - b[i + k]) ** 2;
            count++;
          }
        return 10 * Math.log10((255 * 255) / (sum / count));
      },
      /** How many different red codes the picture holds; edges between sampled pixels add in-between ones. */
      levels(data) {
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4) seen.add(data[i]);
        return seen.size;
      },
    };
  }, low);
};

try {
  await setup(true);
  const low = await page.evaluate(async () => {
    const { engine, ssaa, psnr, shrink, levels } = window.t;
    engine.render();
    const before = engine.camera.matrix.slice(),
      plain = await ssaa.supersample(engine, { samples: 1 }),
      still = await ssaa.supersample(engine, { samples: 64 }),
      again = await ssaa.supersample(engine, { samples: 64 }),
      big = await ssaa.supersample(engine, { samples: 1, width: 1280, height: 960 }),
      reference = shrink(big, 8);
    return {
      size: [plain.width, plain.height],
      plain: psnr(plain.data, reference),
      still: psnr(still.data, reference),
      same: still.data.every((value, i) => value === again.data[i]),
      opaque: still.data.every((value, i) => i % 4 !== 3 || value === 255),
      levels: [levels(plain.data), levels(still.data)],
      camera: engine.camera.matrix.every((value, i) => value === before[i]),
      big: [big.width, big.height],
    };
  });
  console.log('single-sampled', JSON.stringify(low));
  assert.deepEqual(low.size, [160, 120]);
  assert.deepEqual(low.big, [1280, 960]);
  assert.equal(low.same, true, 'the same call gives the same picture');
  assert.equal(low.opaque, true);
  assert.equal(low.camera, true, 'the camera matrix is the plain one afterwards');
  assert.ok(low.levels[1] > low.levels[0] * 2, `edges gain in-between values: ${low.levels}`);
  assert.ok(low.still > low.plain + 6, `64 samples read ${low.still} dB, a plain frame ${low.plain} dB`);
  assert.ok(low.still > 34, `64 samples read ${low.still} dB against the 8x reference`);

  const after = await page.evaluate(async () => {
    const { engine, meshes, ssaa, errors } = window.t,
      hit = await engine.pick(80, 60),
      controller = new AbortController();
    const aborted = ssaa.supersample(engine, { samples: 256, signal: controller.signal }).then(
      () => 'finished',
      (error) => error.message,
    );
    controller.abort(new Error('stopped'));
    const blob = await ssaa.supersampleBlob(engine, { samples: 4 });
    return {
      picked: meshes.includes(hit),
      aborted: await aborted,
      blob: [blob.type, blob.size > 100],
      errors,
    };
  });
  assert.equal(after.picked, true, 'picking works on the frame left behind');
  assert.equal(after.aborted, 'stopped');
  assert.deepEqual(after.blob, ['image/png', true]);
  assert.deepEqual(after.errors, []);
  console.log('ok picking, abort and blob');

  // The full tier: core's 4x MSAA target, and effects that size themselves to what they draw into.
  await setup(false);
  const full = await page.evaluate(async () => {
    const { engine, ssaa, psnr, errors } = window.t,
      { PostStack } = await import('/packages/post/dist/index.js'),
      { Bloom } = await import('/packages/post/dist/bloom.js'),
      { TAA } = await import('/packages/taa/dist/index.js'),
      still = await ssaa.supersample(engine, { samples: 16 }),
      stack = PostStack.attach(engine, [new Bloom()]),
      bloom = await ssaa.supersample(engine, { samples: 16 }),
      wide = await ssaa.supersample(engine, { samples: 4, width: 320, height: 240 });
    stack.dispose();
    const taa = TAA.attach(engine),
      temporal = await ssaa.supersample(engine, { samples: 16 });
    taa.dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    return {
      lit: still.data.some((value) => value > 100),
      bloom: psnr(still.data, bloom.data),
      wide: wide.data.some((value, i) => i % 4 !== 3 && value > 100),
      temporal: psnr(still.data, temporal.data),
      errors,
    };
  });
  console.log('full tier', JSON.stringify(full));
  assert.equal(full.lit, true);
  assert.equal(full.wide, true);
  assert.ok(full.bloom < 60, 'a post effect shows in the still');
  assert.ok(full.temporal > 25, `TAA attached reads ${full.temporal} dB against the plain still`);
  assert.deepEqual(full.errors, []);
  assert.deepEqual(problems, []);
  console.log('ssaa browser check passed');
} finally {
  await context.close();
  await release();
}

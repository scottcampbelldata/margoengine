// A still sea drawn again and again over 10 s of wall time is the same frame (KB-WATER-SETTINGS-COMPAT1). Nothing in
// Water or the WebGL2 layer may depend on the wall clock: with delta 0 and no value changed, every frame 300 ms apart
// draws the same pixels (WebGPU, and the layer on ANGLE Vulkan) and, on the layer, hands the driver the same WebGL2
// calls with the same data. On the layer over ANGLE Direct3D 11 an RTX A6000 draws 3 pixels one code apart about 4 s
// in although the calls are the same (docs/known-bugs.md), so there the pixels are reported and the calls compared.
// Run on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer; BROWSER_ARGS='["--use-angle=vulkan"]' for ANGLE Vulkan.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { firstDifference } from '../../../tests/support/gl-stream.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const WIDTH = 640,
  HEIGHT = 360,
  FRAMES = 34,
  GAP_MS = 300;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const device = legDevice(false, hardware),
  layer = device !== 'webgpu',
  // The one device whose pixels are known to move under the same calls (docs/known-bugs.md, KB-WATER-SETTINGS-COMPAT1).
  driverMoves = device === 'webgl2-layer on ANGLE D3D11';
const differs = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
};
try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT, layer }) => {
      if (layer) (await import('/tests/support/gl-stream.js')).recordGL();
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { applyWaterSettings } = await import('/packages/water/dist/settings.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 4, 0], target: [0, 1.5, -40], near: 0.3, far: 20000 },
      });
      engine.gpu.pushErrorScope('validation');
      const water = Water.attach(engine, { size: [200, 200], segments: 128 });
      window.repeatTest = {
        engine,
        async frame() {
          const stream = globalThis.__margoGLStream;
          stream?.start();
          applyWaterSettings(water, {});
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
          return stream?.stop() ?? null;
        },
      };
    },
    { WIDTH, HEIGHT, layer },
  );
  const frames = [];
  const started = Date.now();
  for (let k = 0; k < FRAMES; k++) {
    if (k) await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    const calls = await page.evaluate(() => window.repeatTest.frame());
    const pixels = (await decodePNG(await page.locator('canvas').screenshot())).data;
    frames.push({ at: Date.now() - started, calls, pixels });
  }
  const span = frames.at(-1).at - frames[0].at;
  assert.ok(span >= 9000, `the frames span ${span} ms of wall time, not 10 s`);
  // The first two frames make the resources (the layer double-buffers uniforms); every later one makes the same calls
  // with the same data.
  if (layer)
    for (let k = 3; k < FRAMES; k++) {
      const difference = firstDifference(frames[2].calls, frames[k].calls);
      if (difference) {
        await mkdir('test-results', { recursive: true });
        await writeFile('test-results/water-frame-repeat-calls-2.txt', frames[2].calls.join('\n'));
        await writeFile(`test-results/water-frame-repeat-calls-${k}.txt`, frames[k].calls.join('\n'));
      }
      assert.equal(
        difference,
        null,
        `frame ${k} (${frames[k].at} ms) hands WebGL2 other calls than frame 2: ${JSON.stringify(difference)}`,
      );
    }
  const moved = frames.map((f, k) => [k, f.at, differs(f.pixels, frames[0].pixels)]).filter(([, , n]) => n > 0);
  if (driverMoves) {
    if (moved.length)
      console.log(
        `${device}: the same calls, yet ${moved.length} of ${FRAMES} frames differ from the first, by up to ` +
          `${Math.max(...moved.map(([, , n]) => n))} pixels, the first at ${moved[0][1]} ms ` +
          '(docs/known-bugs.md, KB-WATER-SETTINGS-COMPAT1)',
      );
  } else assert.deepEqual(moved, [], `${device}: frames [index, ms, pixels] differ from the first`);
  const error = await page.evaluate(() => window.repeatTest.engine.gpu.popErrorScope().then((e) => e?.message ?? null));
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(
    `water frame repeat check passed: ${FRAMES} frames over ${span} ms on ${device}${layer ? ', the same WebGL2 calls each frame' : ''}`,
  );
} finally {
  await page.evaluate(() => window.repeatTest?.engine.dispose());
  await closeAll({ browser });
}

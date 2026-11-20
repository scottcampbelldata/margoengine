// @margoengine/water/settings on a real GPU: the defaults draw the frame a Water draws without them, every row moves the
// picture it should, and a named look draws a different sea. Run on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { firstDifference } from '../../../tests/support/gl-stream.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 640,
  HEIGHT = 360;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const device = legDevice(false, hardware),
  layer = device !== 'webgpu',
  // On the layer over ANGLE Direct3D 11 an RTX A6000 draws a few pixels one code apart a few seconds into the page under
  // the same WebGL2 calls (docs/known-bugs.md, KB-WATER-SETTINGS-COMPAT1): there a frame that must come back is held to
  // the calls of the plain frame, and its pixels are reported.
  driverMoves = device === 'webgl2-layer on ANGLE D3D11';
// What the page can do: apply values, draw a frame, and give back the picture and, on the WebGL2 layer, the WebGL2
// calls the frame made (tests/support/gl-stream.js).
const draw = async (values) => {
  const calls = await page.evaluate(
    async ({ values }) => {
      const { engine, water, apply } = window.settingsTest,
        stream = globalThis.__margoGLStream;
      stream?.start();
      apply(water, values);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      return stream?.stop() ?? null;
    },
    { values },
  );
  return { calls, pixels: (await decodePNG(await page.locator('canvas').screenshot())).data };
};
const differs = ({ pixels: a }, { pixels: b }) => {
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
      window.settingsTest = { engine, water, apply: applyWaterSettings };
    },
    { WIDTH, HEIGHT, layer },
  );
  const plain = await draw({});
  // The first two frames make the layer's resources (it double-buffers uniforms); the third is the plain frame's calls.
  await draw({});
  const plainCalls = (await draw({})).calls;
  // A frame that must equal the plain one: the same pixels and, on the layer, the same WebGL2 calls with the same data.
  const same = (frame, what) => {
    if (layer) assert.equal(firstDifference(plainCalls, frame.calls), null, `${what} (WebGL2 calls)`);
    const moved = differs(frame, plain);
    if (driverMoves && moved)
      console.log(`${what}: ${moved} pixels differ on ${device} under the same calls (KB-WATER-SETTINGS-COMPAT1)`);
    else assert.equal(moved, 0, what);
  };
  // 1. Every default written draws the same frame.
  same(await draw({}), 'the defaults changed the frame');
  // 2. Every row that has a look moves the picture. foamDistance only widens shore foam, so an open sea does not change.
  const rows = {
    whitecaps: 1,
    chop: 1,
    waveHeight: 0.05,
    color: [0.3, 0.1, 0.02],
    glitterRoughness: 0.55,
    shallowDepth: 60,
    // Before the wind rows: a null wind row leaves the wind it set, so after them the frame cannot come back.
    seaLevel: 0.5,
    windSpeed: 22,
    windDirection: 90,
    fetch: 3000,
  };
  for (const [name, value] of Object.entries(rows)) {
    const moved = differs(await draw({ [name]: value }), plain);
    console.log(`${name}: ${moved} pixels differ`);
    assert.ok(moved > 200, `${name} did not move the picture (${moved})`);
    // A null chop, windSpeed or windDirection leaves the value the weather or the options gave, so only these bring the
    // frame back: the other rows back at their defaults, the chop at its own 0, and the wind where it was.
    if (!['windSpeed', 'windDirection', 'fetch', 'seaLevel'].includes(name))
      same(await draw({ chop: 0 }), `${name} at its default does not bring the frame back`);
    // A null seaLevel keeps the level it was given, so only the level the Water was made with brings the frame back.
    if (name === 'seaLevel') same(await draw({ chop: 0, seaLevel: 0 }), 'seaLevel 0 does not bring the frame back');
  }
  // The foam's softness only shows where there is foam: a sea of whitecaps drawn soft and hard differs.
  const hard = await draw({ whitecaps: 1, foamSoftness: 0 }),
    soft = await draw({ whitecaps: 1, foamSoftness: 1 });
  assert.ok(differs(hard, soft) > 200, 'foamSoftness did not move the picture');
  await draw({ whitecaps: 0, chop: 0 });
  // 3. Named looks draw seas unlike each other.
  const looks = await page.evaluate(async () =>
    Object.keys((await import('/packages/water/dist/settings.js')).WATER_LOOKS),
  );
  const seen = [];
  for (const name of looks) {
    const picture = await draw(
      await page.evaluate(async (n) => (await import('/packages/water/dist/settings.js')).WATER_LOOKS[n], name),
    );
    for (const [other, prior] of seen) assert.ok(differs(picture, prior) > 100, `${name} draws like ${other}`);
    seen.push([name, picture]);
  }
  // 4. Sixty frames of every live row, with no validation error.
  await page.evaluate(async () => {
    const { engine, water, apply } = window.settingsTest;
    for (let i = 0; i < 60; i++) {
      const t = i / 59;
      apply(water, {
        windSpeed: 2 + 20 * t,
        windDirection: 360 * t,
        fetch: 1000 + 1e6 * t,
        whitecaps: t,
        chop: t,
        waveHeight: null,
        color: [t, 1 - t, 0.5],
        foamDistance: 0.5 + 5 * t,
        seaLevel: -1 + 2 * t,
        glitterRoughness: 0.02 + 0.5 * t,
        foamSoftness: t,
        shallowColor: [t, 1 - t, 0.5],
        shallowDepth: 80 * t,
      });
      engine.render({ delta: 1 / 60 });
    }
    await engine.gpu.queue.onSubmittedWorkDone();
  });
  const error = await page.evaluate(() =>
    window.settingsTest.engine.gpu.popErrorScope().then((e) => e?.message ?? null),
  );
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(`water settings browser check passed (${hardware.webgpu.vendor})`);
} finally {
  await page.evaluate(() => window.settingsTest?.engine.dispose());
  await closeAll({ browser });
}

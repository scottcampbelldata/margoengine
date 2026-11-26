// Runs every side-by-side example of examples/from-threejs in a real browser and checks what each one claims: the
// frame is drawn, the motion moves, picking answers with the right object, an effect changes the picture, and nothing
// errors (WGSL diagnostics included, through scripts/browser.js).
// `npm run test:from-threejs` (WebGPU); `npm run test:from-threejs -- --compat` runs it on the WebGL2 compatibility
// layer. Frames are saved in test-results/from-threejs/ (`-compat` for the layer). Needs `npm run build:packages`.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

const compat = process.argv.includes('--compat');
const out = 'test-results/from-threejs';
await mkdir(out, { recursive: true });
const path = '/examples/from-threejs/index.html';
const { page, close, hardware } = await openBrowser({ startPath: path, port: 'free' });
const origin = new URL(page.url()).origin;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

/** Draws frames until every pipeline the scene asks for is in place. */
const settle = () =>
  page.evaluate(async () => {
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const { engine } = window.example;
    await waitForPipelines(
      async () => {
        await new Promise((done) => requestAnimationFrame(done));
        await engine.gpu.queue.onSubmittedWorkDone();
      },
      { timeoutMs: 120000 },
    );
  });

const open = async (name) => {
  await page.goto(`${origin}${path}?name=${name}`);
  await page.waitForSelector('#viewport[data-ready], #viewport[data-error]', { timeout: 180000 });
  const failure = await page.getAttribute('#viewport', 'data-error');
  assert.equal(failure, null, `${name}: ${failure}`);
  await settle();
};

/** The canvas as pixels; `file` also saves it. */
const frame = async (file) => {
  const png = await page.locator('canvas').screenshot();
  if (file) await writeFile(`${out}/${file}${compat ? '-compat' : ''}.png`, png);
  return decodePNG(png);
};

/** Mean and standard deviation of the frame's luma. */
const luma = ({ data, width, height }) => {
  let sum = 0,
    squares = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += y;
    squares += y * y;
  }
  const mean = sum / (width * height);
  return { mean, spread: Math.sqrt(squares / (width * height) - mean * mean) };
};

/** How many pixels differ by more than 12 levels in some channel. */
const changed = (a, b) => {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) > 12 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 12 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 12
    )
      count++;
  return count;
};

/** Draws the scene as it stands, `seconds` of engine time later, with the frame loop stopped. */
const step = (seconds) =>
  page.evaluate(async (seconds) => {
    const { engine } = window.example;
    engine.stop();
    engine.render({ delta: seconds });
    await engine.gpu.queue.onSubmittedWorkDone();
  }, seconds);

const centre = async () => {
  const box = await page.locator('canvas').boundingBox();
  return [Math.round(box.width / 2), Math.round(box.height / 2)];
};

const checks = {
  async basics() {
    await step(0);
    const first = await frame('basics');
    const [x, y] = await centre();
    const at = (y * first.width + x) * 4;
    assert.ok(first.data[at] > first.data[at + 2] + 40, 'the orange box is not in the middle of the frame');
    // The spin is an onFrame callback, which the engine's own loop calls.
    await page.evaluate(() => window.example.engine.start());
    await page.waitForFunction(() => window.example.crate.rotation.y > 0.3, null, { timeout: 30000 });
    await step(0);
    assert.ok(changed(first, await frame()) > 200, 'the box did not turn');
  },
  async 'model-animation'() {
    await step(0);
    const first = await frame('model-animation');
    for (let i = 0; i < 3; i++) await step(0.1);
    assert.ok(changed(first, await frame()) > 500, 'the walk did not move the model');
    const weights = await page.evaluate(() => {
      const { toggle, engine, walk, run } = window.example;
      toggle();
      for (let i = 0; i < 6; i++) engine.render({ delta: 0.1 });
      return { walk: walk.getEffectiveWeight(), run: run.getEffectiveWeight() };
    });
    assert.deepEqual(weights, { walk: 0, run: 1 }, 'the cross-fade did not end on the run clip');
  },
  async 'instancing-picking'() {
    const [x, y] = await centre();
    // The camera looks at box 40, the middle of the 9 by 9 grid; the corner is background.
    const picked = await page.evaluate(
      async ([x, y]) => {
        const { rayAt, gpuAt } = window.example;
        return {
          ray: rayAt(x, y),
          gpu: await gpuAt(x, y),
          rayMiss: rayAt(2, 2) ?? null,
          gpuMiss: (await gpuAt(2, 2)) ?? null,
        };
      },
      [x, y],
    );
    assert.deepEqual(picked, { ray: 40, gpu: 40, rayMiss: null, gpuMiss: null });
    await page.locator('canvas').click({ position: { x, y } });
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Picked box 40.', null, {
      timeout: 30000,
    });
    await settle();
    await frame('instancing-picking');
  },
  async 'post-processing'() {
    await step(0);
    const withBloom = await frame('post-processing');
    await page.evaluate(() => window.example.removeBloom());
    await settle();
    await step(0);
    const without = await frame();
    assert.ok(
      luma(withBloom).mean > luma(without).mean + 1,
      `bloom adds no light: ${luma(withBloom).mean.toFixed(2)} with, ${luma(without).mean.toFixed(2)} without`,
    );
  },
  async 'typical-scene'() {
    const [x, y] = await centre();
    const box = await page.locator('canvas').boundingBox();
    await step(0);
    await frame('typical-scene');
    const picks = await page.evaluate(
      async ([x, y, bottom]) => {
        const { select } = window.example;
        return {
          fox: (await select(x, y)) ?? null,
          ground: (await select(x, bottom)) ?? null,
          sky: (await select(4, 4)) ?? null,
        };
      },
      [x, y, Math.round(box.height - 8)],
    );
    assert.deepEqual(picks, { fox: 'fox', ground: 'ground', sky: null });
    // A real click selects the fox and draws its outline.
    await page.evaluate(() => window.example.engine.start());
    await page.locator('canvas').click({ position: { x, y } });
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Picked the fox.', null, {
      timeout: 30000,
    });
    await settle();
    await frame('typical-scene-picked');
    // Clear the outline, then compare like with like.
    await page.evaluate(() => window.example.select(4, 4));
    await step(0);
    const still = await frame();
    for (let i = 0; i < 3; i++) await step(0.1);
    assert.ok(changed(still, await frame()) > 500, 'the walk clip did not move the fox');
    // The sun's shadow: without it the ground gets brighter.
    await step(0);
    const shadowed = await frame();
    await page.evaluate(() => window.example.shadows.dispose());
    await settle();
    await step(0);
    const unshadowed = await frame();
    let lifted = 0;
    for (let i = 0; i < shadowed.data.length; i += 4) if (unshadowed.data[i] - shadowed.data[i] > 20) lifted++;
    assert.ok(lifted > shadowed.width * shadowed.height * 0.002, `the sun casts no visible shadow (${lifted} pixels)`);
    // Orbit: a drag moves the camera around the target.
    await page.evaluate(() => window.example.engine.start());
    const before = await page.evaluate(() => [...window.example.engine.camera.position]);
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      (before) => Math.hypot(...window.example.engine.camera.position.map((v, i) => v - before[i])) > 0.1,
      before,
      { timeout: 30000 },
    );
  },
};

try {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [name, check] of Object.entries(checks)) {
    await open(name);
    await step(0);
    const { mean, spread } = luma(await frame());
    assert.ok(
      mean > 8 && spread > 8,
      `${name}: the frame looks blank (mean ${mean.toFixed(1)}, spread ${spread.toFixed(1)})`,
    );
    await page.evaluate(() => window.example.engine.start());
    await check();
    assert.deepEqual(errors, [], `${name} console errors:\n${errors.join('\n')}`);
    console.log(`ok ${name}`);
  }
} finally {
  await close();
}
console.log(
  `Migration examples passed on ${compat ? 'the WebGL2 compatibility layer' : 'WebGPU'} (${
    compat ? hardware.webglRenderer : `${hardware.webgpu?.vendor} ${hardware.webgpu?.architecture}`
  })`,
);

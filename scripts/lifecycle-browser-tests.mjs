// What a visitor's browser does to a running scene, in a real browser (tests/lifecycle-browser.html):
//   D. the tab goes to the background for 30 s and comes back (the page's clock jumps, nothing waits): the stage's,
//      React's and the physics step's first frame back steps 0, engine.maxDelta clamps a long frame, nothing throws;
//   A. no navigator.gpu, and a requestAdapter() that answers null: createStage rejects with the coded 'unsupported'
//      error, React's Canvas shows its plain message, and no rejection goes unhandled;
//   B. at 125, 150 and 175 % zoom the canvas is whole device pixels at the engine's size, and React's Canvas on demand
//      redraws at that size after its box changes;
//   C. the GPU device is lost (device.destroy(), and a GPU process crash): the engine replaces the device and keeps
//      drawing, with no uncaught error.
// Every scenario runs even when an earlier one fails, so one run names every failure.
// Browser: MARGO_BROWSER (scripts/lib/browser.mjs); Firefox has no WebGPU, so the suite prints that it is skipped.
// Run by check:gpu-packages (ROOT 'test:lifecycle:browser'): npm run test:lifecycle:browser
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

const opened = await openBrowser({ startPath: '/tests/lifecycle-browser.html', port: 5236 }),
  base = opened.page.url(),
  browser = opened.page.context().browser(),
  results = { hardware: opened.hardware, checks: [], failures: [] };

/** A fresh page on its own context (pixel ratio, init script), with every uncaught error collected. */
async function open({ deviceScaleFactor = 1, init } = {}) {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor });
  if (init) await context.addInitScript(init);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(base);
  await page.waitForFunction(() => window.lifecycle);
  return {
    page,
    run: (name, ...args) => page.evaluate(([name, args]) => window.lifecycle[name](...args), [name, args]),
    async done(label) {
      const reported = await page.evaluate(() => window.lifecycle.errors);
      await context.close();
      assert.deepEqual([...errors, ...reported], [], `${label}: no uncaught error, rejection or engine error`);
    },
  };
}

/** Runs one scenario and records its result; a failure does not stop the scenarios after it. */
async function scenario(name, run) {
  try {
    results.checks.push({ name, ...(await run()) });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.failures.push({ name, error: String(error) });
    console.log(`FAIL ${name}: ${String(error).split('\n')[0]}`);
  }
}

try {
  await scenario('D: stage loop and physics after a 30 s background tab', async () => {
    const t = await open();
    assert.deepEqual(await t.run('stage', { physics: true }), { rejected: null });
    await t.run('drain');
    await t.run('frames', 5);
    const before = await t.run('drain');
    assert.ok(before.length >= 4 && before.every((f) => f.delta > 0 && f.delta <= 0.1), 'steady frames');
    const hidden = await t.run('background', 30_000);
    await t.run('frames', 3);
    const [back, ...after] = await t.run('drain');
    assert.equal(back.delta, 0, 'the first frame back from a 30 s background steps 0, not the clamped 0.1');
    assert.equal(back.steps, 0, 'and runs no physics step');
    assert.equal(back.y, hidden.y, 'so the body does not jump');
    assert.ok(
      after.every((f) => f.delta > 0 && f.delta <= 0.1 && f.steps <= 4 && Number.isFinite(f.y)),
      'resumes',
    );
    await t.run('setMaxDelta', 0.05);
    await t.run('jump', 1000);
    await t.run('frames', 2);
    const [slow] = await t.run('drain');
    assert.equal(slow.delta, 0.05, 'engine.maxDelta clamps a 1 s frame');
    await t.done('D stage');
    return { back, slow: slow.delta };
  });
  for (const mode of ['always', 'demand'])
    await scenario(`D: React frameloop="${mode}" after a 30 s background tab`, async () => {
      const t = await open();
      assert.deepEqual(await t.run('react', mode), { alert: null, ready: true });
      if (mode === 'demand') {
        await t.run('invalidate');
        await t.run('jump', 16);
        await t.run('invalidate');
      } else await t.run('frames', 3);
      await t.run('drain');
      await t.run('background', 30_000);
      if (mode === 'demand') await t.run('invalidate');
      else await t.run('frames', 2);
      const [back] = await t.run('drain');
      assert.equal(back.delta, 0, `React ${mode}: the first frame back from a 30 s background steps 0`);
      await t.done(`D react ${mode}`);
      return { delta: back.delta };
    });

  // The two ways a browser lacks WebGPU.
  const strip = {
    'no navigator.gpu': () => {
      delete Navigator.prototype.gpu;
    },
    'no adapter': () => {
      if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
    },
  };
  for (const [mode, init] of Object.entries(strip)) {
    await scenario(`A: ${mode}: createStage rejects with 'unsupported'`, async () => {
      const t = await open({ init });
      const { rejected } = await t.run('stage');
      assert.equal(rejected?.code, 'unsupported', 'createStage rejects with the coded error');
      assert.match(rejected.message, /WebGPU unavailable; see https:\/\/margoengine\.com\/errors#webgpu/);
      await t.run('frames', 2); // an unhandled rejection is reported by the end of the task that left it
      await t.done(`A stage ${mode}`);
      return { rejected };
    });
    await scenario(`A: ${mode}: React shows the needs-WebGPU message`, async () => {
      const t = await open({ init });
      const { alert, ready } = await t.run('react', 'always');
      assert.equal(ready, false);
      assert.equal(alert, 'This 3D scene needs a browser with WebGPU, such as a current Chrome, Edge or Safari.');
      await t.run('frames', 2);
      // onError is the app's own report of the coded error; anything else is a failure.
      const reported = await t.page.evaluate(() => window.lifecycle.errors.splice(0));
      assert.equal(reported.length, 1);
      assert.match(reported[0], /^onError: MargoError: WebGPU unavailable/);
      await t.done(`A react ${mode}`);
      return { alert };
    });
  }

  // Fractional zoom. The engine's size is whole pixels, round(css * ratio), with the ratio capped where MSAA would
  // multiply it (4x MSAA on desktop: 1).
  for (const deviceScaleFactor of [1.25, 1.5, 1.75]) {
    await scenario(`B: stage at ${deviceScaleFactor * 100} % zoom`, async () => {
      const t = await open({ deviceScaleFactor });
      await t.run('stage');
      await t.run('resize', '417.7px', '233.1px');
      await t.run('frames', 3);
      const size = await t.run('size');
      assert.equal(size.dpr, deviceScaleFactor);
      assert.ok(size.pixels.every(Number.isInteger));
      assert.deepEqual(
        size.pixels,
        size.client.map((v) => Math.round(v * Math.min(size.dpr, 1))),
      );
      await t.done(`B stage ${deviceScaleFactor}`);
      return size;
    });
    await scenario(`B: React on demand at ${deviceScaleFactor * 100} % zoom`, async () => {
      const t = await open({ deviceScaleFactor });
      await t.run('react', 'demand');
      await t.run('drain');
      await t.run('resize', '417.7px', '233.1px');
      await t.run('frames', 3);
      const drawn = (await t.run('drain')).length,
        size = await t.run('size');
      assert.ok(drawn >= 1, 'React on demand redraws after its box changes');
      assert.deepEqual(
        size.pixels,
        size.client.map((v) => Math.round(v * Math.min(size.dpr, 1))),
        "React's canvas keeps the engine's size",
      );
      await t.done(`B react ${deviceScaleFactor}`);
      return { drawn, ...size };
    });
  }

  for (const kind of ['stage', 'react'])
    await scenario(`C: ${kind} recovers from device.destroy()`, async () => {
      const t = await open();
      if (kind === 'stage') await t.run('stage');
      else await t.run('react', 'always');
      const lost = await t.run('loseDevice');
      assert.equal(lost.lost?.reason, 'destroyed', 'the device reports it was destroyed');
      assert.equal(lost.replaced, true, 'a new device replaces the destroyed one');
      assert.ok(lost.frames >= 4, 'frames keep coming after the device is back');
      await t.done(`C ${kind} destroy`);
      return lost;
    });
  await scenario('C: geometry set during a restore draws on the new device', async () => {
    const t = await open();
    await t.run('stage');
    const lost = await t.run('loseDeviceSettingGeometry');
    assert.equal(lost.lost?.reason, 'destroyed', 'the device reports it was destroyed');
    assert.equal(lost.replaced, true, 'a new device replaces the destroyed one');
    assert.ok(lost.frames >= 4, 'frames keep coming after the device is back');
    assert.equal(lost.added, 4, 'the four meshes given geometry during the restore are drawn');
    await t.done('C geometry during restore');
    return lost;
  });
  // Every browser that gets this far is Chromium-based (the only family with WebGPU here), so it has a GPU process.
  await scenario('C: stage recovers from a GPU process crash', async () => {
    const t = await open();
    await t.run('stage');
    await t.run('markDevice');
    // What chrome://gpucrash (Edge: edge://gpucrash) does, through the DevTools protocol: pages cannot open those URLs.
    const devtools = await browser.newBrowserCDPSession();
    await devtools.send('Browser.crashGpuProcess');
    await devtools.detach();
    const lost = await t.run('replacedSinceMark');
    assert.equal(lost.lost?.reason, 'unknown', 'the device reports an unknown loss');
    assert.equal(lost.replaced, true, 'a new device replaces the lost one');
    assert.ok(lost.frames >= 4, 'frames keep coming');
    await t.done('C GPU process crash');
    return lost;
  });
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/lifecycle-browser.json', JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(results.failures, [], `${results.failures.length} lifecycle scenario(s) failed`);
} finally {
  await opened.close();
}

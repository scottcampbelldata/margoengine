// Same film frames on every run, on a real GPU (run from the repository root after building packages; MARGO_COMPAT=1
// runs every leg on the WebGL2 compatibility layer):
//   node scripts/run-with-timeout.mjs --timeout=600000 -- node packages/sky/test/rain-frames-check.mjs
// A film's rain shot (rain-frames-check.html) is drawn for FRAMES film frames (default 90) in fresh browsers: two alone,
// one beside a second browser that keeps the GPU busy with a plain compute load (gpu-load.html), and one that reads
// the page canvas in the same task as the render instead of drawing on createHeadlessCanvas. Every frame of every run
// must be byte for byte the first run's, from frame 0 on (GAP-FILM-READY, KB-FILM-GPUSHARE1). Reading the page canvas
// after an await instead gave whole frames from earlier draws and failed this check in 65 of 90 frames (2026-11-17).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const FRAMES = Number(process.env.FRAMES ?? 90);
async function draw(name, { load = false, read = 'headless' } = {}) {
  const context = await openBrowser({ startPath: `/packages/sky/test/rain-frames-check.html?read=${read}`, port: 'free' }),
    errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  let busy;
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    if (load) {
      busy = await openBrowser({ startPath: '/packages/sky/test/gpu-load.html', port: 'free' });
      await busy.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
      // The load is running: its first dispatches are done before the shot's first frame.
      await busy.page.waitForFunction(() => window.dispatched >= 4, null, { timeout: 120000 });
    }
    const r = await context.page.evaluate((n) => window.check.run(n), FRAMES);
    assert.deepEqual(r.errors, [], `${name}: GPU errors`);
    assert.deepEqual(errors, [], `${name}: page errors`);
    if (load) assert.ok(await busy.page.evaluate(() => window.dispatched) > 4, `${name}: the load ran during the shot`);
    console.log(`${name}: ${r.frames.length} frames on ${context.hardware?.compat ? 'the WebGL2 layer' : 'WebGPU'}`);
    return { name, frames: r.frames, compat: !!context.hardware?.compat };
  } finally {
    if (busy) await busy.close();
    await context.close();
  }
}
const runs = [
  await draw('alone 1'),
  await draw('alone 2'),
  await draw('beside a GPU load', { load: true }),
  await draw('page canvas read in the render task', { read: 'canvas' }),
];
const [first] = runs;
assert.equal(first.frames.length, FRAMES);
assert.equal(new Set(first.frames).size > FRAMES / 2, true, 'the shot moves: most frames differ from each other');
assert.ok(runs.every((r) => r.compat === first.compat), 'every run drew on the same device kind');
// An all-zero frame (transparent black, nothing shown) as rain-frames-check.html digests it.
let blank = 2166136261;
for (let i = 0; i < 1280 * 720 * 4; i++) blank = Math.imul(blank, 16777619) >>> 0;
const blankDigest = blank.toString(16).padStart(8, '0');
assert.ok(!first.frames.includes(blankDigest), 'every headless frame shows the shot');
for (const run of runs.slice(1)) {
  const differing = run.frames.flatMap((d, f) => (d === first.frames[f] ? [] : [f]));
  assert.deepEqual(differing, [], `${run.name}: frames that differ from the first run`);
}
console.log(`rain frames check passed: ${runs.length} fresh runs drew the same ${FRAMES} frames`);

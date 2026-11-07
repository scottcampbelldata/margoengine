// Real-GPU proof of the cinematic entries: a brain writes the engine's camera in the frame loop, and what the stages say
// is on screen is where the engine picks the mesh. From the repository root, after building the packages:
// node packages/cinematic/test/browser-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/cinematic/test/browser-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (a, b, limit, what) => assert.ok(Math.abs(a - b) <= limit, `${what}: ${a} is not ${b} within ${limit}`);
const run = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });

  // The box is about 20 pixels across at this distance, so a pick 40 pixels off its reported place misses on all sides.
  const framed = await run('framed');
  near(framed.x, 0.25, 1e-9, 'x on the screen point');
  near(framed.y, 0.75, 1e-9, 'y on the screen point');
  assert.deepEqual(
    [framed.center, framed.left, framed.right, framed.above, framed.below],
    [true, false, false, false, false],
    'the engine finds the mesh where the composer says it is, and only there',
  );

  // A jump past the soft zone: the mesh is at once on the soft edge, which is 0.25 from the point, and still picked.
  const jumped = await run('move', [9, 1, 0], 1);
  near(jumped.x, 0.5, 1e-9, 'held on the soft edge');
  assert.equal(jumped.hit, true, 'the mesh is on the soft edge');
  const settled = await run('move', [9, 1, 0], 120);
  near(settled.x, 0.3, 1e-3, 'settled on the dead edge');
  assert.equal(settled.hit, true, 'the mesh is on the dead edge');

  const swap = await run('swap');
  assert.equal(swap.live, 'wide');
  near(swap.position[0], 20, 1e-9, 'the brain ended on the wide camera');
  for (let i = 1; i < swap.during.length; i++) {
    const step = Math.hypot(...swap.during[i].map((v, k) => v - swap.during[i - 1][k]));
    assert.ok(step < 4, `no jump in the blend: ${step} at frame ${i}`);
  }
  assert.deepEqual(swap.errors, [], 'no GPU error');
  assert.deepEqual(pageErrors, [], 'no page error');
  console.log('cinematic browser check passed');
} catch (error) {
  console.error(pageErrors);
  throw error;
} finally {
  await context.close();
}

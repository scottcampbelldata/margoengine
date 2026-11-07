// Real-GPU proof of the cinematic entries: a brain writes the engine's camera in the frame loop, and what the stages say
// is on screen is where the engine picks the mesh. From the repository root, after building the packages:
// node packages/cinematic/test/browser-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/cinematic/test/browser-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (a, b, limit, what) => assert.ok(Math.abs(a - b) <= limit, `${what}: ${a} is not ${b} within ${limit}`);
// Blur along the middle row in a span of columns: how many pixels lie part way between the darkest and the brightest.
// A sharp edge has one or two, a blurred one as many as its disk is wide.
const edge = async (from, to) => {
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    row = Math.floor(image.height / 2) * image.width,
    scale = image.width / 800,
    values = [];
  for (let x = Math.round(from * scale); x < to * scale; x++) values.push(image.data[(row + x) * 4 + 1]);
  const low = Math.min(...values),
    high = Math.max(...values),
    middle = values.filter((v) => v > low + (high - low) * 0.1 && v < high - (high - low) * 0.1);
  return middle.length;
};
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
  const group = await run('group');
  assert.deepEqual(group.ends, ['left', 'right'], 'the far ends of the group sit on the padded edge');
  assert.deepEqual(group.outside, [null, null], 'and nothing lies beyond it');
  assert.deepEqual(group.errors, [], 'no GPU error');
  // A real DOF on the GPU. The near card sits left of the middle, the far card right of it.
  const sharp = await run('lens', 'near', 120);
  near(sharp.focus, 6, 1e-3, 'focus on the near card');
  const nearEdge = await edge(0, 400),
    farEdge = await edge(400, 800);
  console.log('focus near: near edge', nearEdge, 'far edge', farEdge);
  assert.ok(farEdge > 2 * nearEdge, `the card in focus is the sharp one: ${nearEdge} against ${farEdge}`);
  const rack = await run('lens', 'far', 1, 0.5);
  near(rack.focus, 30 + (6 - 30) * Math.exp(-3), 1e-3, 'the rack reaches the DOF at its rate');
  const other = await run('lens', 'far', 120);
  near(other.focus, 30, 1e-3, 'focus on the far card');
  const nearAfter = await edge(0, 400),
    farAfter = await edge(400, 800);
  console.log('focus far: near edge', nearAfter, 'far edge', farAfter);
  assert.ok(nearAfter > 2 * farAfter, `focus moved to the far card: ${farAfter} against ${nearAfter}`);
  assert.deepEqual(other.errors, [], 'no GPU error');

  const zoom = await run('zoom');
  console.log('zoom fov', zoom.fov);
  assert.deepEqual(zoom.inside, [true, true], 'the subject reaches to 4 pixels of its share');
  assert.deepEqual(zoom.outside, [false, false], 'and stops within 4 pixels of it');
  assert.deepEqual(swap.errors, [], 'no GPU error');
  assert.deepEqual(pageErrors, [], 'no page error');
  console.log('cinematic browser check passed');
} catch (error) {
  console.error(pageErrors);
  throw error;
} finally {
  await context.close();
}

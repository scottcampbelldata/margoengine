// Real-adapter check (run from the repository root after building packages): node packages/shader/test/compute-model-check.mjs
// A prefix scan in workgroup memory, 2D and 3D dispatch with their bounds, a dispatch sized by an earlier pass, every
// atomic, a compare-and-swap loop, a workgroup histogram, and two buffers trading values.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/shader/test/compute-model-check.html', port: 5221 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const call = async (name) => {
  const result = await page.evaluate((n) => window.check[n](), name);
  assert.deepEqual(await page.evaluate(() => window.check.takeErrors()), [], name);
  return result;
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  const { data, out } = await call('scan');
  let sum = 0;
  assert.deepEqual(
    out,
    data.map((v, i) => (sum = (i % 256 ? sum : 0) + v)),
    'scan',
  );
  console.log('ok scan');

  const g2 = await call('grid2');
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++)
      assert.equal(g2.out[y * 16 + x], x < g2.w && y < g2.h ? x * 100 + y + 1 : 0, `2D cell ${x},${y}`);
  g2.linear.forEach((v, i) => assert.equal(v, (i % g2.w) + Math.floor(i / g2.w) * 1000, `linear ${i}`));
  console.log('ok 2D');

  const g3 = await call('grid3'),
    [dx, dy] = g3.d;
  g3.out.forEach((v, i) => {
    const x = i % dx,
      y = Math.floor(i / dx) % dy,
      z = Math.floor(i / (dx * dy));
    assert.equal(v, x + y * 10 + z * 100, `3D ${i}`);
  });
  console.log('ok 3D');

  const { out: indirect } = await call('indirect');
  indirect.forEach((v, i) => assert.equal(v, i < 192 ? 4 : 0, `indirect ${i}`));
  console.log('ok indirect');

  const { values, seen } = await call('atomics');
  assert.equal(values[0], 1000 - 256, 'sub');
  assert.equal(values[1], 0xfffffffc, 'and');
  assert.equal(values[2], 7, 'or');
  assert.equal(values[3], 0, 'xor of an even count');
  assert.ok(values[4] >= 1000 && values[4] < 1256, 'exchange leaves one of the values');
  assert.equal(values[5], 255, 'compare-and-swap maximum');
  assert.equal(values[6], 256, 'every invocation finished its loop');
  const chain = new Set(seen);
  assert.equal(chain.size, 256, 'each exchange saw a different previous value');
  assert.ok(chain.has(7));
  console.log('ok atomics');

  const h = await call('histogram'),
    bins = Array(16).fill(0);
  for (const v of h.data) bins[v]++;
  assert.deepEqual(h.out, bins, 'histogram');
  console.log('ok histogram');

  const swap = await call('swap');
  assert.deepEqual(swap.a, [5, 6, 7, 8]);
  assert.deepEqual(swap.b, [1, 2, 3, 4]);
  assert.deepEqual(pageErrors, []);
  console.log('compute model check passed');
} finally {
  await context.close();
}

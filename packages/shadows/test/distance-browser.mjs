// Real-GPU check of `@margoengine/shadows/distance`: a wall in a height field shades the ground past the cascades only, follows
// the sun, forgets an edited field only when told, gives the share of the sun's disc above the horizon, and reaches across long
// cells. Rainier against Cycles is in outside/check.mjs.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/distance-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// Light from a pixel: as check.mjs in outside/, through Khronos PBR Neutral's toe.
const light = (v) => {
  const y = linear(v);
  return y >= 0.04 ? y + 0.04 : 0.4 * Math.sqrt(y);
};
// The wall runs along z at x = 8, 6 high, one cell thick, in a field of unit cells. The sun at 45 degrees from +x ends its
// shadow 6 units behind it, at x = 2.
const wall = [];
for (let row = 0; row < 65; row++) wall.push([40, row, 6]);
const field = { columns: 65, rows: 65, size: [64, 64], origin: [-32, -32], walls: wall };
const release = await acquire({ owner: 'shadows-distance' });
const context = await openBrowser({ startPath: '/packages/shadows/test/distance.html', port: 5277 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const start = async (settings) => assert.deepEqual(await page.evaluate((s) => window.check.start(s), settings), []);
const read = async (x, z, height) => {
  const r = await page.evaluate(([a, b, c]) => window.check.read(a, b, c), [x, z, height]);
  assert.deepEqual(r.errors, []);
  return r;
};
const ratio = (r) => light(r.shaded) / light(r.open);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await start({ field, toLight: [1, 1, 0], options: { sunSize: 0 } });
  const shaded = ratio(await read(5, 0)),
    open = ratio(await read(12, 0)),
    near = ratio(await read(5, 0, 5));
  console.log(JSON.stringify({ shaded, open, near }));
  assert.ok(shaded < 0.5, `the ground behind the wall keeps ${shaded} of its light`);
  assert.ok(open > 0.98, `the ground before the wall keeps ${open}`);
  // 5 units up is inside the cascades' 30, where the cascades own the shadow and a height field adds none.
  assert.ok(near > 0.98, `the far shadow reaches into the cascades: ${near}`);

  // The sun crosses over: the field is marched again, so the shadow changes sides.
  await page.evaluate(() => window.check.sun([-1, 1, 0]));
  const behind = ratio(await read(11, 0)),
    before = ratio(await read(5, 0));
  console.log(JSON.stringify({ behind, before }));
  assert.ok(behind < 0.5, `the far shadow did not follow the sun: ${behind}`);
  assert.ok(before > 0.98, `the old shadow stayed: ${before}`);

  // A sun of 0.4 radians, wide next to a pixel of 0.03 units. A horizon at t of the disc's radius off its centre leaves the segment 0.5 + (t sqrt(1 - t^2) + asin t) / pi,
  // and a straight ramp would give 0.5 + t / 2, 0.05 away at t = 0.5, so the bound of 0.03 tells them apart. 0.03 is
  // three 8-bit steps of the light at these levels. The core mesh's output curve is not PBR Neutral's, so pixels are turned into
  // light by a table read here: deep in the shadow `strength` s leaves exactly 1 - s of the sun.
  await start({ field, toLight: [1, 1, 0], options: { sunSize: 0.4 } });
  await read(5, 0);
  const table = [];
  for (let i = 0; i <= 16; i++) table.push([await page.evaluate((s) => window.check.level(s), i / 16), 1 - i / 16]);
  const share = (pixel) => {
    const i = table.findIndex(([v]) => v <= pixel);
    if (i <= 0) return 1;
    const [a, x] = table[i - 1],
      [b, y] = table[i];
    return a === b ? y : y + ((x - y) * (pixel - b)) / (a - b);
  };
  const disc = (t) => 0.5 + (t * Math.sqrt(1 - t * t) + Math.asin(t)) / Math.PI;
  for (const d of [5.4, 6, 6.6]) {
    const r = await read(8 - d, 0),
      got = share(r.shaded),
      want = disc((2 * (d - 6)) / (d * 0.4));
    console.log(JSON.stringify({ d, got, want }));
    assert.ok(Math.abs(got - want) < 0.03, `${d} from the wall the sun shows ${got} of its disc, not ${want}`);
  }

  // An edited field holds until invalidate(): the shadow stands for the heights last marched.
  await start({ field, toLight: [1, 1, 0], options: { sunSize: 0 } });
  await page.evaluate(() => window.check.flatten(false));
  const stale = ratio(await read(5, 0));
  await page.evaluate(() => window.check.flatten(true));
  const fresh = ratio(await read(5, 0));
  console.log(JSON.stringify({ stale, fresh }));
  assert.ok(stale < 0.5, `the field was marched without invalidate: ${stale}`);
  assert.ok(fresh > 0.98, `invalidate left the old shadow: ${fresh}`);

  // Cells 1 by 16: a march steps by the short side, so crossing 512 units takes 512 steps, not columns + rows. The wall stands
  // 100 units from the ground read, past those 38.
  const long = [];
  for (let column = 0; column < 5; column++) long.push([column, 20, 200]);
  await start({ field: { columns: 5, rows: 33, size: [4, 512], origin: [-2, -256], walls: long }, toLight: [0, 1, 2], options: { sunSize: 0 } });
  const across = ratio(await read(0, -36));
  console.log(JSON.stringify({ across }));
  assert.ok(across < 0.5, `a march over long cells stopped short: ${across}`);

  assert.deepEqual(pageErrors, []);
  console.log('far shadows: ok');
} finally {
  await context.close?.();
  await release();
}

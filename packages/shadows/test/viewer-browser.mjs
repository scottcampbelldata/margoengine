// Real-GPU check of `@margoengine/shadows/viewer`: the grey at the centre of a spot light's map and of a point light's -y
// cube face is the floor's linear distance from the light (reversed perspective depth mirrored, then linearised), an
// empty cube face shows the far plane, and a Shadows cascade shows the floor inside its box. Run from the repository root
// after `npm run build:packages`:
// node scripts/run-with-timeout.mjs --max=5 -- node packages/shadows/test/viewer-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/shadows/test/viewer.html', port: 5279 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const read = async (which) => {
  const r = await page.evaluate((w) => window.check.read(w), which);
  assert.deepEqual(r.errors, []);
  return r;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  // The floor is 4 from both local lights along the map's axis; near is the range / 1000 and far the range, 8. Read
  // as plain depth the reversed value there is about 0.001 (black); mirrored but not linearised about 0.999 (white).
  const near = 8e-3,
    want = Math.round(((4 - near) / (8 - near)) * 255);
  const spot = await read(['spot', 0, 0]),
    down = await read(['point', 1, 3]),
    up = await read(['point', 1, 2]);
  console.log(JSON.stringify({ want, spot, down, up }));
  assert.equal(spot.info.projection, 'perspective');
  assert.ok(spot.info.reversed, 'LocalShadows stores reversed depth');
  assert.ok(Math.abs(spot.grey - want) <= 2, `spot map centre ${spot.grey}, want ${want}`);
  assert.ok(Math.abs(down.grey - want) <= 2, `point -y face centre ${down.grey}, want ${want}`);
  assert.equal(up.grey, 255, 'nothing above the point light: the far plane');
  // The cascade box spans y -1..1 and the floor lies at y 0, half way between its near and far planes.
  const cascade = await read(['cascade', 0]);
  console.log(JSON.stringify({ cascade }));
  assert.equal(cascade.info.projection, 'orthographic');
  assert.ok(Math.abs(cascade.grey - 127) <= 3, `cascade centre ${cascade.grey}, want the middle of the box, 127`);
  assert.equal((await read(['spot', 5, 0])).info, null, 'no such light: no map');
  assert.deepEqual(await page.evaluate(() => window.check.dispose()), []);
  assert.deepEqual(pageErrors, []);
  console.log('shadow map viewer: ok');
} finally {
  await context.close?.();
}

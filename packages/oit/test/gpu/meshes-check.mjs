// Real-GPU check for addMesh: core meshes turn see-through through OIT, the result does not depend on the order they
// were added, they follow their core mesh, and removing restores the opaque frame exactly. Takes a GPU slot itself. From
// the repository root, after building packages: node packages/oit/test/gpu/meshes-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-meshes' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/meshes.html', port: 5284 }),
  { page } = context;
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  const at = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  const opaque = await shot(),
    solid = at(opaque, 128, 128);
  await page.evaluate(() => window.check.see('red'));
  const one = await shot(),
    glass = at(one, 128, 128);
  await page.evaluate(() => window.check.remove());
  const back = await shot();
  let changed = 0;
  for (let k = 0; k < back.data.length; k++) if (back.data[k] !== opaque.data[k]) changed++;
  await page.evaluate(() => window.check.see('blue'));
  const other = await shot();
  let reorder = 0;
  for (let k = 0; k < other.data.length; k++) reorder = Math.max(reorder, Math.abs(other.data[k] - one.data[k]));
  await page.evaluate(() => window.check.move(1.5));
  const moved = await shot();
  console.log(JSON.stringify({ solid, glass, changed, reorder, left: at(moved, 60, 128), right: at(moved, 170, 128) }));
  assert.ok(solid[2] > solid[0] * 3, `the front blue box hides the red one when opaque, got ${solid}`);
  const wall = at(one, 60, 128);
  assert.ok(glass[0] > wall[0] + 3 || glass[2] > wall[2] + 3, `the see-through boxes draw, got ${glass} over ${wall}`);
  assert.ok(glass[0] > solid[0] + 20, `the red box and wall show through the blue one, got ${glass}`);
  assert.equal(changed, 0, 'removing restores the opaque frame');
  assert.ok(reorder <= 1, `the order of adding does not matter, got ${reorder}`);
  const [left, right] = [at(moved, 60, 128), at(moved, 170, 128)];
  assert.ok(
    left.every((v, i) => Math.abs(v - wall[i]) < 6),
    `the old place shows the wall, got ${left}`,
  );
  assert.ok(
    right.some((v, i) => Math.abs(v - wall[i]) > 5),
    `the copies followed, got ${right}`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log('oit meshes check passed');
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  await release();
}

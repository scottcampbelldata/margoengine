// Real-GPU proof of @margoengine/sprites/billboard (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sprites/tests/billboard-check.mjs
// A 64 x 64 exactSize frame with a 90 degree camera, read back and measured: billboards face the camera from three
// sides, world sizes halve at twice the distance, pixel sizes do not, pivot and turn, cut-out depth writes and alpha
// test, back-to-front blending, lockY, and the depth test against a core mesh. Results: test-results/billboards-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/sprites/tests/billboard-check.html', port: 5272 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const box = (b) => [b.minX, b.minY, b.width, b.height];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/billboards-browser.json', JSON.stringify({ hardware, result: r }, null, 1));
  // 2 units at 6.4 px per unit cover 25.6 to 38.4 about the centre (32): pixel centres 26.5 to 37.5, 12 px.
  for (const side of ['front', 'side', 'above'])
    assert.deepEqual(box(r.facing[side]), [26, 26, 12, 12], `faces the camera from ${side}`);
  // At distance 10, 3.2 px per unit: 28.8 to 35.2, pixels 29 to 34.
  assert.deepEqual(box(r.facing.far), [29, 29, 6, 6], 'world size halves at twice the distance');
  // 8 px about 32: pixels 28 to 35 at any distance.
  for (const at of ['near', 'far']) assert.deepEqual(box(r.pixels[at]), [28, 28, 8, 8], `pixel size holds ${at}`);
  // pivotY 1: the image stands on the centre, rows 19.2 to 32, so 19 to 31, 12 px wide.
  assert.deepEqual(box(r.pivot), [26, 19, 12, 13], 'a bottom pivot stands the image on its point');
  // 4 x 2 turned a quarter: 2 units wide (12 px) and 4 tall (19.2 to 44.8: rows 19 to 44, 26 px).
  assert.deepEqual(box(r.turn), [26, 19, 12, 26], 'a quarter turn swaps width and height');
  // The near red at z = 1 is 4 units from the eye, where the view is 8 units tall: 8 px per unit, 24 to 40, 16 px.
  assert.deepEqual(box(r.cutout.red), [24, 24, 16, 16], 'the near cut-out stays whole over the far one drawn after it');
  assert.ok(r.cutout.green.count > 0, 'the far one shows around it');
  assert.equal(r.cutout.clearDrew, 0, 'alpha test drops a transparent rectangle');
  // Red at alpha 0.5 over green on an 8-bit target with straight alpha: 127.5 each, rounded either way.
  assert.ok(
    Math.abs(r.blend[0] - 127.5) <= 1 && Math.abs(r.blend[1] - 127.5) <= 1 && r.blend[2] === 0,
    `back to front blend: ${r.blend}`,
  );
  assert.ok(Math.abs(r.lockY.false.width - r.lockY.false.height) <= 1, 'unlocked: square on screen from above');
  assert.ok(
    r.lockY.true.height < r.lockY.true.width - 2,
    `lockY stands upright and looks shorter from above: ${JSON.stringify(r.lockY.true)}`,
  );
  for (const mode of ['false', 'true']) {
    assert.equal(r.scene[mode].behind, 0, `transparent ${mode}: hidden behind a core mesh`);
    assert.ok(r.scene[mode].inFront > 100, `transparent ${mode}: drawn in front of it`);
  }
  assert.equal(r.validation, null, 'no validation errors');
  assert.equal(r.msaa.validation, null, 'MSAA engine: no validation error');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'ok billboards: facing, size attenuation, pixel size, pivot, turn, cut-out, blending, lockY, scene depth; 0 validation errors',
  );
} finally {
  await context.close();
}

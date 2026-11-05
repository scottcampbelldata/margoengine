// Real-GPU check of @margoengine/geometry/gpu (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/geometry/tests/gpu-check.mjs
// Generated vertices are read back and compared with what the shaders promise: closed forms, control points, frames.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/geometry/tests/gpu-check.html', port: 5263 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.setDefaultTimeout(60_000);
const run = (name) => page.evaluate((n) => window.check[n](), name);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  const sphere = await run('sphere');
  assert.ok(sphere.worstRadius < 1e-5, `sphere radius off by ${sphere.worstRadius}`);
  assert.ok(sphere.worstNormal < 2e-3, `sphere normals off by ${sphere.worstNormal}`);
  assert.ok(sphere.worstUnit < 1e-5, `sphere normals not unit by ${sphere.worstUnit}`);
  assert.equal(sphere.wrong, 0, 'sphere triangles face out');
  const ball = (4 / 3) * Math.PI * 1.5 ** 3;
  assert.ok(Math.abs(sphere.volume / ball - 1) < 0.01, `sphere volume ${sphere.volume}, outward, near ${ball}`);
  await run('clear');
  console.log('ok sphere');

  const torus = await run('params');
  const expected = (r) => 2 * Math.PI ** 2 * 2 * r * r;
  assert.ok(Math.abs(torus.first / expected(0.5) - 1) < 0.01, `torus ${torus.first}`);
  assert.ok(Math.abs(torus.second / expected(0.25) - 1) < 0.01, `torus after params ${torus.second}`);
  assert.equal(torus.wrong, 0, 'torus triangles face out');
  console.log('ok torus and params');

  const cone = await run('cylinder');
  assert.ok(cone.worstSlope < 1e-5, `cone radius follows height and faces out, ${cone.worstSlope}`);
  assert.equal(cone.wrong, 0, 'cone triangles face out');
  console.log('ok cone');

  const grid = await run('grid');
  assert.ok(grid.worst < 1e-4, `grid off the formula by ${grid.worst}`);
  assert.ok(grid.up > 0, `grid faces up, lowest ${grid.up}`);
  assert.equal(grid.wrong, 0, 'grid triangles face up');
  assert.equal(grid.time, 1.5, 'time advances with the engine');
  console.log('ok grid');

  const surface = await run('surface');
  surface.last.forEach((x, k) => assert.ok(Math.abs(x - [3, 3, 2][k]) < 1e-5, `corner ${surface.last}`));
  surface.normal.forEach((x, k) => assert.ok(Math.abs(x - surface.expected[k]) < 1e-4, `normal ${surface.normal}`));
  console.log('ok surface');

  const tube = await run('tube');
  assert.ok(tube.worstCentre < 1e-4, `rings centred on the curve, off by ${tube.worstCentre}`);
  assert.ok(tube.worstRadius < 1e-4, `radius off by ${tube.worstRadius}`);
  assert.ok(tube.worstCross < 1e-3, `normals radial, off by ${tube.worstCross}`);
  assert.ok(tube.worstTwist < 0.3, `no jump between rings, largest ${tube.worstTwist}`);
  assert.equal(tube.wrong, 0, 'tube triangles face out');
  console.log('ok tube');

  assert.ok((await run('simulated')) < 1e-4, 'points written on the GPU drive the tube');
  console.log('ok points from a compute pass');

  assert.ok((await run('grow')) > 1, 'generation follows a replaced vertex buffer');
  console.log('ok replaced vertex buffer');

  assert.ok((await run('closed')) < 1e-4, 'a closed tube meets itself');
  console.log('ok closed tube');

  const ribbon = await run('ribbon');
  ribbon.first.forEach((x, k) => assert.ok(Math.abs(x - [0, -0.5, 0, 0, 0.5, 0][k]) < 1e-5, `ribbon ${ribbon.first}`));
  assert.ok(Math.abs(Math.abs(ribbon.normal[2]) - 1) < 1e-5, `ribbon normal ${ribbon.normal}`);
  assert.equal(ribbon.wrong, 0, 'ribbon triangles face their normal');
  console.log('ok ribbon');

  await run('picture');
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    pixel = (x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)],
    middle = pixel(image.width >> 1, image.height >> 1),
    corner = pixel(4, 4);
  assert.ok(middle[0] > 60 && middle[0] > middle[2] * 2, `generated sphere drawn, middle ${middle}`);
  assert.notDeepEqual(middle, corner, 'the corner is background');
  await run('clear');
  console.log('ok drawn', middle);

  const restored = await run('restore');
  assert.equal(restored.same, false, 'a new device');
  assert.ok(Math.abs(restored.y - 7) < 1, `control points survive a lost device, y ${restored.y}`);
  console.log('ok device restored');

  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  console.log('geometry GPU check passed');
} finally {
  await context.close();
}

// Real-adapter check (run from the repository root after building packages): node packages/shader/test/inputs-check.mjs
// Each input node drawn as a colour on a wall the camera faces, and read back: view space, depth, camera planes, matrices,
// tangents, vertex index, cube and 3D textures, and the instance inputs compiled in every instanced variant.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/inputs-check.html', port: 5227 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const pixel = async (name, y = 0.5, x = 0.5) => {
  const { errors } = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(errors, [], name);
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4,
    value = [...image.data.slice(o, o + 3)];
  await page.evaluate(() => window.check.clear());
  return value;
};
const encode = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
const shows = async (name, linear, tolerance = 2) => {
  const actual = await pixel(name),
    expected = linear.map(encode);
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${name}: ${actual} != ${expected}`,
  );
  console.log('ok', name);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  await shows('positionView', [0.5, 0.5, 0.5]);
  await shows('normalView', [0.5, 0.5, 1]);
  await shows('linearDepth', [0.5, 0.5, 0.5]);
  await shows('linearDepthVertex', [0.5, 0.5, 0.5]);
  await shows('planes', [0.5, 0.5, 0]);
  await shows('matrices', [0.5, 0.5, 0.5]);
  await shows('model', [0.25, 0.5, 0]);
  await shows('tangent', [0.5, 1, 0.5]);
  await shows('tangentVertex', [0.5, 1, 0.5]);
  await shows('bitangent', [0, 0.5, 0.5]);
  await shows('bitangentMirrored', [1, 0.5, 0.5]);
  await shows('bitangentMirroredVertex', [1, 0.5, 0.5]);
  await shows('frame', [1, 1, 1]);
  await shows('noTangent', [1, 0.5, 0.5]);
  await shows('noTangentVertex', [1, 0.5, 0.5]);
  await shows('noBitangent', [0.5, 1, 0.5]);

  const corners = new Set();
  for (const [y, x] of [
    [0.4, 0.4],
    [0.4, 0.6],
    [0.6, 0.4],
    [0.6, 0.6],
  ])
    corners.add((await pixel('vertexIndex', y, x))[0]);
  assert.ok(corners.size >= 3, `the quad's vertices hold different indices: ${[...corners]}`);
  const flat = (await pixel('vertexIndexFlat'))[0];
  assert.ok([0, 1, 2, 3].map((i) => encode(i / 3)).includes(flat), `a fragment reads one vertex's index: ${flat}`);
  console.log('ok vertexIndex');

  await shows('cubeRight', [1, 0, 0]);
  await shows('cubeUp', [0, 0, 1]);
  await shows('volumeNear', [0, 0, 0]);
  await shows('volumeFar', [1, 0, 0]);

  for (const [i, errors] of (await page.evaluate(() => window.check.instanced())).entries())
    assert.deepEqual(errors, [], `instanced variant ${i}`);
  console.log('ok instance inputs compile plain, instanced and in uniform rows');
  assert.deepEqual(pageErrors, []);
  console.log('inputs check passed');
} finally {
  await context.close();
}

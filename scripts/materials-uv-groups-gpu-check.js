import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const release = await acquire({ owner: 'materials-uv-groups-gpu-check' });
let browser;
try {
  await mkdir('test-results/materials-uv-groups', { recursive: true });
  browser = await openBrowser({ startPath: '/tests/materials-uv-groups.html', port: 5211 });
  const page = browser.page,
    errors = [],
    captures = [],
    pixel = (image, x, y = 120) =>
      Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.uvGroups);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  async function capture(label) {
    const image = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/materials-uv-groups/${label}.png` }),
    );
    captures.push({ label, left: pixel(image, 80), center: pixel(image, 160), right: pixel(image, 240) });
    return image;
  }
  async function uv(mode) {
    await page.evaluate((mode) => uvGroups.uv(mode), mode);
    return capture(mode);
  }
  const uv0 = await uv('uv0'),
    uv1 = await uv('uv1'),
    fallback = await uv('fallback');
  assert.deepEqual(pixel(uv0, 160), [255, 0, 0], 'UV0 did not sample the red texel');
  assert.deepEqual(pixel(uv1, 160), [0, 0, 255], 'UV1 did not sample its distinct blue texel');
  assert.equal(Buffer.compare(uv0.data, fallback.data), 0, 'Missing UV1 did not fall back to UV0');
  const ao0 = await uv('ao0'),
    ao1 = await uv('ao1');
  assert.ok(
    pixel(ao1, 160).every((value, i) => value > pixel(ao0, 160)[i] + 40),
    'AO map did not use the selected UV set',
  );
  assert.deepEqual(await page.evaluate(() => uvGroups.grouped()), { primitives: 2, materials: 2 });
  const grouped = await capture('grouped-mixed-shaders');
  assert.deepEqual(pixel(grouped, 80), [0, 255, 0], 'First range did not use materialIndex 1 and its texture');
  assert.ok(
    pixel(grouped, 240)[2] > 250 && pixel(grouped, 240)[0] > 120 && pixel(grouped, 240)[0] < 136,
    'Second range did not use normal shading',
  );
  const picks = await page.evaluate(() => uvGroups.picks());
  assert.deepEqual(
    picks,
    { hits: [true, true], sharedNode: true },
    'Picking did not identify the grouped model in both ranges',
  );
  await page.evaluate(() => uvGroups.move());
  const moved = await capture('grouped-root-transform');
  assert.notDeepEqual(pixel(grouped, 60), pixel(moved, 60), 'Root transform did not move the first group');
  assert.deepEqual(pixel(moved, 110), [0, 255, 0]);
  const restoredState = await page.evaluate(() => uvGroups.restore()),
    restored = await capture('grouped-device-restored');
  assert.equal(restoredState.changedDevice, true, 'Device restoration reused the old device');
  assert.equal(restoredState.primitives, 2);
  assert.equal(
    Buffer.compare(moved.data, restored.data),
    0,
    'Device restoration changed grouped texture/shader pixels',
  );
  await page.evaluate(() => uvGroups.blending());
  const blended = await capture('grouped-blend-order'),
    composed = pixel(blended, 240);
  assert.ok(
    composed[0] >= 120 &&
      composed[0] <= 136 &&
      composed[1] >= 55 &&
      composed[1] <= 72 &&
      composed[2] >= 55 &&
      composed[2] <= 72,
    `Incorrect grouped blend ordering: ${composed}`,
  );
  assert.deepEqual(pixel(blended, 80), [255, 255, 255], 'Opaque sibling was incorrectly blended');
  assert.deepEqual(await page.evaluate(() => uvGroups.instances()), { sharedInstances: true, primitives: 2 });
  const instanced = await capture('grouped-instances');
  for (const x of [60, 220]) assert.deepEqual(pixel(instanced, x), [0, 255, 0], 'An instance lost its first group');
  for (const x of [100, 260])
    assert.deepEqual(pixel(instanced, x), [0, 0, 255], 'An instance lost its UV1 mapped second group');
  await page.evaluate(() => uvGroups.instances(1));
  const reduced = await capture('grouped-instance-count');
  assert.deepEqual(pixel(reduced, 60), [0, 255, 0]);
  assert.deepEqual(pixel(reduced, 100), [0, 0, 255]);
  for (const x of [220, 260])
    assert.notDeepEqual(pixel(reduced, x), pixel(instanced, x), 'Instance count failed to update every group');
  for (const withSSAO of [false, true]) {
    await page.evaluate((withSSAO) => uvGroups.matcap(withSSAO), withSSAO);
    const matcap = await capture(withSSAO ? 'grouped-matcap-ssao' : 'grouped-matcap'),
      left = pixel(matcap, 80),
      right = pixel(matcap, 240);
    assert.ok(left[0] > 150 && left[1] > 70 && left[0] > left[1] && left[2] < 20, `Matcap texture lost: ${left}`);
    assert.ok(right[1] > 150 && right[0] < 20 && right[2] < 20, `Grouped basic texture lost: ${right}`);
  }
  const normals = {};
  for (const mode of ['zero', 'uv0', 'uv1']) {
    await page.evaluate((mode) => uvGroups.normal(mode), mode);
    normals[mode] = pixel(await capture('normal-' + mode), 160);
  }
  assert.ok(
    normals.zero[0] >= 125 &&
      normals.zero[0] <= 130 &&
      normals.zero[1] >= 125 &&
      normals.zero[1] <= 130 &&
      normals.zero[2] > 250,
    `Normal scale zero did not retain geometric normal: ${normals.zero}`,
  );
  assert.ok(
    normals.uv0[1] > 190 && normals.uv0[2] > 190 && normals.uv0[2] < 235,
    `Normal map or normal scale was ignored: ${normals.uv0}`,
  );
  assert.ok(
    normals.uv1[1] < 60 && normals.uv1[2] > 190 && normals.uv1[2] < 235,
    `Mirrored UV1 reused UV0 tangent space: ${normals.uv1}`,
  );
  assert.deepEqual(await page.evaluate(() => uvGroups.disposal()), { pickedAfterDispose: true });
  const disposed = await capture('caller-texture-after-disposal');
  assert.deepEqual(pixel(disposed, 160), [0, 255, 0]);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => uvGroups.errors), []);
  const report = {
    hardware: browser.hardware,
    checks: [
      'distinct UV1',
      'UV0 fallback',
      'AO UV selection',
      'mixed grouped shaders and textures',
      'both group picks',
      'root transform',
      'device restoration',
      'opaque and blended ordering',
      'shared grouped instances',
      'instance count',
      'matcap and SSAO auxiliary bindings',
      'normal scale',
      'UV1 normal tangent orientation',
      'disposal and caller-owned texture',
    ],
    picks,
    normals,
    changedRestoredChannels: 0,
    captures,
  };
  await writeFile('test-results/materials-uv-groups/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.page.evaluate(() => window.uvGroups?.dispose()).catch(() => {});
  await browser?.close();
  release();
}

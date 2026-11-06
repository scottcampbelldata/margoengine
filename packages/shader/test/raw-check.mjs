// Real-adapter check (run from the repository root after building packages): node packages/shader/test/raw-check.mjs
// Raw meshes as full citizens: each scene draws through a real adapter and is read back as pixels, buffers, picks and counters.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/raw-check.html', port: 5233 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const encode = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
const image = async () => decodePNG(await page.locator('canvas').screenshot());
const at = (png, x, y) => {
  const o = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [...png.data.slice(o, o + 3)];
};
const scene = async (name) => {
  const result = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(result.errors, [], name);
  return result;
};
const clear = () => page.evaluate(() => window.check.clear());
const shows = async (name, linear) => {
  await scene(name);
  const png = await image(),
    actual = at(png, png.width / 2, png.height / 2),
    expected = linear.map(encode);
  await clear();
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
    `${name}: ${actual} != ${expected}`,
  );
  console.log('ok', name);
};
const counted = async (name, stats) => {
  const result = await scene(name);
  await clear();
  assert.deepEqual({ culled: result.stats.culled, meshes: result.stats.meshes }, stats, name);
  console.log('ok', name);
};
// The wall's brightness in the middle, where a caster's shadow falls, over its brightness well to the left of it.
const shadowRatio = async (name) => {
  await scene(name);
  const png = await image(),
    middle = at(png, png.width / 2, png.height / 2)[0],
    open = at(png, png.width * 0.3, png.height / 2)[0];
  await clear();
  assert.ok(open > 60, `${name}: the wall is lit (${open})`);
  return middle / open;
};
const shadowed = async (name) => {
  const ratio = await shadowRatio(name);
  assert.ok(ratio < 0.5, `${name}: the shadow reaches the wall (${ratio})`);
  console.log('ok', name, ratio.toFixed(2));
};
const lit = async (name) => {
  const ratio = await shadowRatio(name);
  assert.ok(ratio > 0.9, `${name}: the middle stays lit (${ratio})`);
  console.log('ok', name, ratio.toFixed(2));
};
const picks = async (name, expected) => {
  const result = await scene(name);
  await clear();
  const { errors, ...values } = result;
  assert.deepEqual(values, expected, name);
  assert.deepEqual(errors, []);
  console.log('ok', name);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  await shows('uniformList', [0, 1, 0]);
  await shows('uniformFlat', [0, 0.5, 0.25]);
  await shows('uniformColours', [1, 0, 0]);
  await shows('uniformStruct', [0.5, 0.25, 0]);
  await shows('uniformStructList', [0.5, 0, 0.25]);
  await shows('uniformLive', [0, 0, 1]);
  await shows('storageRead', [0, 1, 0]);
  await shows('storageVertex', [0, 1, 0]);
  await shows('storageStruct', [0, 0, 0.5]);
  await shows('storageCompute', [0, 1, 0]);
  const written = await scene('storageWrite'),
    png = await image(),
    red = at(png, png.width / 2, png.height / 2);
  await clear();
  assert.deepEqual(written.written, [0, 7, 0, 0]);
  assert.ok(red[0] > 250, `storageWrite drew ${red}`);
  console.log('ok storageWrite');
  await shows('extraGroups', [0.5, 0.25, 0]);
  await shows('extraGroupWithUniforms', [0.5, 0, 0.5]);

  await counted('culledOut', { culled: 1, meshes: 0 });
  await counted('culledIn', { culled: 0, meshes: 1 });
  await counted('culledScale', { culled: 0, meshes: 1 });
  await counted('culledBehind', { culled: 1, meshes: 0 });
  await counted('culledBounds', { culled: 1, meshes: 0 });
  await counted('culledNever', { culled: 0, meshes: 1 });

  await shadowed('shadow');
  await shadowed('shadowProjection');
  await shadowed('shadowMoved');
  await shadowed('shadowStatic');
  await lit('shadowCut');
  await lit('shadowTransparent');
  await lit('shadowOut');

  // SSAO darkens the ambient light the mesh gave it near the crease; with depth alone it has no light to take away.
  const own = await scene('ssaoOwn'),
    ownImage = await image();
  await clear();
  const depth = await scene('ssaoDepth'),
    depthImage = await image();
  await clear();
  const near = at(ownImage, ...own.crease)[0],
    plain = at(depthImage, ...depth.crease)[0],
    far = at(ownImage, ...own.open)[0],
    farPlain = at(depthImage, ...depth.open)[0];
  console.log('ssao crease', near, 'against', plain, 'open wall', far, 'against', farPlain);
  assert.ok(near <= plain - 6, `the G-buffer's ambient is darkened at the crease: ${near} against ${plain}`);
  assert.ok(Math.abs(far - farPlain) <= 2, `the open wall is left alone: ${far} against ${farPlain}`);
  // A normal into the wall sends SSAO's samples behind it, so the open wall darkens too: the shader's normals are what it reads.
  const flipped = await scene('ssaoFlipped'),
    flippedImage = await image();
  await clear();
  const inside = at(flippedImage, ...flipped.open)[0];
  console.log('ssao open wall with its normals turned inward', inside);
  assert.ok(inside <= far - 6, `the shader's normal reaches SSAO: ${inside} against ${far}`);
  console.log('ok ssao');

  await picks('pick', { left: true, right: true, miss: null });
  await picks('pickBlocked', { core: true });
  await picks('pickInFront', { raw: true });
  await picks('pickHidden', { miss: null });
  await picks('pickMoved', { shown: true, source: null });
  await picks('pickFollowed', { core: true, raw: true });
  await picks('pickRemoved', { miss: null, gone: null });
  assert.deepEqual(pageErrors, []);
  console.log('raw check passed');
} finally {
  await context.close();
}

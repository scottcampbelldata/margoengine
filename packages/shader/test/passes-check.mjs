// Real-adapter check (run from the repository root after building packages): node packages/shader/test/passes-check.mjs
// Node output in the passes that are not the colour pass: a caster moved by positionNode throws the shadow of a plain
// mesh placed there (Shadows, virtual shadows, LocalShadows, integrated clustered shadows), a caster cut by discard() the shadow of a half caster, normals
// follow the moved surface in both modes, and SSAO's G-buffer pass draws such a surface.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/passes-check.html', port: 5225 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const grab = async (name) => {
  const { errors } = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(errors, [], name);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(() => window.check.clear());
  return {
    width: image.width,
    at(y, x) {
      const o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
      return [...image.data.slice(o, o + 3)];
    },
    row(y) {
      return Array.from({ length: image.width }, (_, x) => this.at(y, (x + 0.5) / image.width));
    },
  };
};
// Fraction of the picture that differs between two renders.
const difference = (a, b) => {
  let different = 0,
    total = 0;
  for (let y = 0.1; y < 0.9; y += 0.01)
    for (let x = 0.1; x < 0.9; x += 0.01) {
      total++;
      if (a.at(y, x).some((v, k) => Math.abs(v - b.at(y, x)[k]) > 8)) different++;
    }
  return different / total;
};
const dark = (image, y) => image.row(y).filter((c) => c[0] < 40).length;
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  for (const [plain, moved] of [
    ['plainShadow', 'movedShadow'],
    ['virtualPlain', 'virtualMoved'],
    ['localPlain', 'localMoved'],
    ['integratedPlain', 'integratedMoved'],
  ]) {
    const a = await grab(plain),
      b = await grab(moved);
    assert.ok(dark(a, 0.36) > 10, `${plain} throws a shadow`);
    const share = difference(a, b);
    assert.ok(share < 0.01, `${moved} differs from ${plain} on ${(share * 100).toFixed(2)}% of the picture`);
    console.log('ok', moved);
  }

  const share = difference(await grab('halfShadow'), await grab('cutShadow'));
  assert.ok(share < 0.01, `a cut caster differs from a half caster on ${(share * 100).toFixed(2)}% of the picture`);
  console.log('ok discard in a shadow');

  const row = (image) => image.row(0.5).map((c) => c[0]),
    smooth = await grab('neighbours'),
    faces = await grab('faces'),
    kept = await grab('kept');
  // sin(4x) slopes hardest at x = 0, the middle of the plane: n.x = -0.8 / sqrt(1 + 0.64) = -0.625, so red 0.1875 linear.
  const expected = encode(0.5 - 0.625 / 2);
  for (const [name, image] of [
    ['neighbours', smooth],
    ['faces', faces],
  ]) {
    const reds = row(image),
      middle = reds[Math.floor(reds.length / 2)];
    assert.ok(Math.abs(middle - expected) < 8, `${name}: red ${middle} at the steepest point, expected ${expected}`);
    assert.ok(Math.max(...reds) - Math.min(...reds) > 60, `${name}: the normal changes across the wave`);
  }
  const keptReds = row(kept);
  assert.ok(Math.max(...keptReds.slice(100, 300)) - Math.min(...keptReds.slice(100, 300)) < 4, 'keep: the flat normal');
  console.log('ok normals follow the surface');

  await grab('gbuffer');
  console.log('ok G-buffer pass');
  assert.deepEqual(pageErrors, []);
  console.log('passes check passed');
} finally {
  await context.close();
}

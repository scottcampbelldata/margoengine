// Real-GPU check that create3MFMesh draws 3MF metallic display properties: a metallic-roughness map and factors written
// by export3MF, read back by parse3MFMaterials, on a plain texture group and on a tinted multiproperties stack. Each
// quadrant of the lit quad must match, within 2 of 255, a quad drawn with that quadrant's roughness and metalness as
// plain material numbers: roughness from the map's red and metalness from its green (3MF Materials and Properties
// Extension 1.2.1, section 7.4), rows the right way up, times the factors. Options must replace the file's values, on
// every layer of a stack. WebGPU must report no validation error. Run from the repository root after building packages,
// natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/threemf-finish-gpu-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const compat = compatRun(),
  size = 128;
const context = await openBrowser({ startPath: '/packages/loaders/tests/threemf-finish-gpu.html', port: 5361 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
/** Three pixels in each quadrant, in the order top left, top right, bottom left, bottom right. */
const pixels = async () => {
  const shot = await decodePNG(await page.locator('#a').screenshot());
  assert.equal(shot.width, size);
  return [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([column, row]) =>
    [
      [20, 20],
      [32, 40],
      [44, 28],
    ].flatMap(([x, y]) => {
      const at = ((row * 64 + y) * size + column * 64 + x) * 4;
      return [...shot.data.slice(at, at + 3)];
    }),
  );
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const texels = await page.evaluate(() => window.check.texels),
    map = (roughness, metalness) => texels.map(([r, m]) => [(r / 255) * roughness, (m / 255) * metalness]),
    same = (value) => [value, value, value, value];
  const cases = [
    {
      name: 'map on a texture group',
      source: { map: true, metalness: 1, roughness: 1 },
      layered: false,
      want: map(1, 1),
    },
    {
      name: 'map and factors on a tinted stack',
      source: { tint: true, map: true, metalness: 0.5, roughness: 0.8 },
      layered: true,
      want: map(0.8, 0.5),
    },
    {
      name: 'factors alone on a textured material',
      source: { tint: true, metalness: 0.7, roughness: 0.3 },
      layered: true,
      want: same([0.3, 0.7]),
    },
    {
      name: 'a value on an untextured material',
      source: { tint: true, textured: false, metalness: 0.9, roughness: 0.4 },
      layered: false,
      want: same([0.4, 0.9]),
    },
    {
      name: 'both options replace the map on a stack',
      source: { tint: true, map: true, metalness: 0.5, roughness: 0.8 },
      options: { roughness: 0.25, metalness: 1 },
      layered: true,
      want: same([0.25, 1]),
    },
    {
      name: 'a roughness option keeps the metalness map',
      source: { tint: true, map: true, metalness: 0.5, roughness: 0.8 },
      options: { roughness: 0.4 },
      layered: true,
      want: map(1, 0.5).map(([, m]) => [0.4, m]),
    },
  ];
  const seen = [];
  for (const { name, source, options = {}, layered, want } of cases) {
    const made = await page.evaluate(([s, o]) => window.check.drawn(s, o), [source, options]);
    assert.equal(made.layered, layered, `${name}: stack`);
    assert.ok(made.metallic, `${name}: the group has metallic properties`);
    const got = await pixels();
    await page.evaluate(([tint, values]) => window.check.reference(tint, values), [!!source.tint, want]);
    const expected = await pixels();
    expected.forEach((quadrant, q) =>
      assert.ok(
        quadrant.every((value, i) => Math.abs(value - got[q][i]) <= 2),
        `${name}${compat ? ' (compat)' : ''}, quadrant ${q}: ${got[q]} should be ${quadrant} for ${want[q]}`,
      ),
    );
    seen.push(expected);
  }
  // The oracle can tell the values apart: the map's four quadrants differ, and so do two uniform cases.
  const apart = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
  for (let a = 0; a < 4; a++)
    for (let b = a + 1; b < 4; b++)
      assert.ok(apart(seen[0][a], seen[0][b]) > 6, `quadrants ${a} and ${b} look alike: ${seen[0][a]}`);
  assert.ok(apart(seen[2][0], seen[3][0]) > 6, 'two finishes look alike');
  console.log(`3MF metallic display properties${compat ? ' (compat)' : ''}: ${cases.length} cases match`);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log('3MF metallic display properties draw check passed');

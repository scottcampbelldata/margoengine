// Real-GPU check that create3MFMesh draws 3MF display properties: a metallic-roughness map and factors written
// by export3MF, read back by parse3MFMaterials, on a plain texture group and on a tinted multiproperties stack. Each
// quadrant of the lit quad must match, within 2 of 255, a quad drawn with that quadrant's roughness and metalness as
// plain material numbers: roughness from the map's red and metalness from its green (3MF Materials and Properties
// Extension 1.2.1, section 7.4), rows the right way up, times the factors. Options must replace the file's values, on
// every layer of a stack. Specular colour and glossiness (section 7.3), as numbers and maps, must match a material that
// states the same reflectance as a specular colour over the index 1.5. A translucent box must match a material given the
// transmission and volume it was written from, with the box's mean chord as thickness (section 7.5). WebGPU must report
// no validation error. Run from the repository root after building packages,
// natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/threemf-finish-gpu-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const compat = compatRun();
const context = await openBrowser({ startPath: '/packages/loaders/tests/threemf-finish-gpu.html', port: 5361 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
/** Three pixels in each quadrant, in the order top left, top right, bottom left, bottom right. */
const pixels = async () => {
  const points = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].flatMap(([column, row]) =>
    [
      [20, 20],
      [32, 40],
      [44, 28],
    ].map(([x, y]) => [column * 64 + x, row * 64 + y]),
  );
  const read = await page.evaluate((at) => window.check.pixels(at), points);
  return [0, 3, 6, 9].map((first) => read.slice(first, first + 3).flat());
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
  const seen = [],
    apart = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
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
  for (let a = 0; a < 4; a++)
    for (let b = a + 1; b < 4; b++)
      assert.ok(apart(seen[0][a], seen[0][b]) > 6, `quadrants ${a} and ${b} look alike: ${seen[0][a]}`);
  assert.ok(apart(seen[2][0], seen[3][0]) > 6, 'two finishes look alike');
  console.log(`3MF metallic display properties${compat ? ' (compat)' : ''}: ${cases.length} cases match`);

  // Specular: the reflectance is 0.04 x the factor, times the map's linear colour where there is one.
  const colors = await page.evaluate(() => window.check.colors),
    linear = (byte) => (byte <= 10 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4),
    FACTOR = [20, 15, 10],
    plain = FACTOR.map((value) => value * 0.04),
    sampled = colors.map((texel) => texel.map((byte, i) => linear(byte) * plain[i]));
  const specular = [
    {
      name: 'a specular value on an untextured material',
      source: { tint: true, textured: false, roughness: 0.3, specular: { factor: FACTOR } },
      layered: false,
      want: same([0.3, 0, plain]),
    },
    {
      name: 'specular and glossiness maps on a texture group',
      source: { map: true, roughness: 1, metalness: 0, specular: { factor: FACTOR, map: true } },
      layered: false,
      want: texels.map(([r], q) => [r / 255, 0, sampled[q]]),
    },
    {
      name: 'specular maps on a tinted stack',
      source: { tint: true, map: true, roughness: 0.8, metalness: 0, specular: { factor: FACTOR, map: true } },
      layered: true,
      want: texels.map(([r], q) => [(r / 255) * 0.8, 0, sampled[q]]),
    },
    {
      name: 'a roughness option replaces the glossiness map',
      source: { tint: true, map: true, roughness: 0.8, metalness: 0, specular: { factor: FACTOR, map: true } },
      options: { roughness: 0.35 },
      layered: true,
      want: sampled.map((f0) => [0.35, 0, f0]),
    },
  ];
  const shades = [];
  for (const { name, source, options = {}, layered, want } of specular) {
    const made = await page.evaluate(([s, o]) => window.check.drawn(s, o), [source, options]);
    assert.equal(made.layered, layered, `${name}: stack`);
    assert.ok(made.specular && !made.metallic, `${name}: the group has specular properties`);
    const got = await pixels();
    await page.evaluate(([tint, values]) => window.check.reference(tint, values), [!!source.tint, want]);
    const expected = await pixels();
    // 8-bit sRGB holds the reflectance colour, and 8-bit maps the glossiness.
    expected.forEach((quadrant, q) =>
      assert.ok(
        quadrant.every((value, i) => Math.abs(value - got[q][i]) <= 2),
        `${name}${compat ? ' (compat)' : ''}, quadrant ${q}: ${got[q]} should be ${quadrant}`,
      ),
    );
    shades.push(expected);
  }
  // The oracle sees the reflectance: the same roughness without the specular colour looks different.
  await page.evaluate((values) => window.check.reference(true, values), same([0.3, 0]));
  assert.ok(apart((await pixels())[0], shades[0][0]) > 6, 'the specular colour changes nothing');
  console.log(`3MF specular display properties${compat ? ' (compat)' : ''}: ${specular.length} cases match`);

  for (const textured of [false, true]) {
    const name = `a translucent box${textured ? ' on a textured stack' : ''}${compat ? ' (compat)' : ''}`,
      made = await page.evaluate((t) => window.check.glass(t), textured);
    assert.equal(made.layered, textured, `${name}: stack`);
    assert.equal(made.translucent.roughness, 0.2, name);
    const [thickness, ior] = made.values;
    assert.ok(Math.abs(thickness - 4 / 3) < 1e-6 && Math.abs(ior - 1.4) < 1e-6, `${name}: ${made.values}`);
    const got = await pixels();
    await page.evaluate(() => window.check.glassReference(4 / 3));
    const expected = await pixels();
    expected.forEach((quadrant, q) =>
      assert.ok(
        quadrant.every((value, i) => Math.abs(value - got[q][i]) <= 2),
        `${name}, quadrant ${q}: ${got[q]} should be ${quadrant}`,
      ),
    );
    // The oracle sees the volume: a thinner box, or a clear one, looks different.
    for (const other of [[0.1], [4 / 3, [1, 1, 1]]]) {
      await page.evaluate(([t, c]) => window.check.glassReference(t, c), other);
      assert.ok(apart((await pixels())[0], expected[0]) > 6, `${name}: ${other} looks the same`);
    }
  }
  console.log(`3MF translucent display properties${compat ? ' (compat)' : ''}: 2 cases match`);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log('3MF display properties draw check passed');

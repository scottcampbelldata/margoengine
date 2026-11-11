import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { cornellPicture, cornellDecomposition } from '../scripts/reference-rendering/cornell-scene.mjs';
import { cornellScene, positionsOf } from '../packages/lightmap/scripts/cornell-box.mjs';

test('the pictured Cornell scene is exactly the existing batch 168 geometry and reflectance', () => {
  const source = cornellScene(),
    positions = Array.from(positionsOf(source.quads));
  for (const point of [false, true]) {
    const picture = cornellPicture(point);
    assert.equal(picture.quads.length, 15);
    assert.deepEqual(
      picture.quads.flatMap((q) => q.positions),
      positions,
    );
    picture.quads.forEach((q, i) => {
      assert.equal(q.name, source.quads[i].name);
      assert.deepEqual(q.albedo, source.quads[i].albedo);
    });
    for (const q of picture.quads)
      for (let p = 0; p < 4; p++)
        for (let c = 0; c < 3; c++)
          assert.ok(
            q.positions[p * 3 + c] >= picture.settings.bounds.min[c] &&
              q.positions[p * 3 + c] <= picture.settings.bounds.max[c],
          );
  }
  assert.deepEqual(cornellPicture().settings.light, { direction: [0.2, -0.6, 1], intensity: 3, color: [1, 1, 1] });
  assert.deepEqual(cornellPicture(true).settings.light, {
    position: [2.78, 4.8, 1],
    intensity: 70,
    color: [1, 1, 1],
    range: 20,
  });
});

for (const [family, absolute, compatAbsolute, square, compatSquare, max] of [
  ['clustered', [38244516, 567377], [38244516, 567377], [7256041740, 44838153], [7256041740, 44838153], [198, 165]],
  ['clustered-point', [6010641, 730273], [6010645, 730276], [842857153, 19557045], [842857493, 19557048], [214, 156]],
])
  test(`${family} has first-measured all-pixel budgets for unshadowed and default-shadowed cases`, () => {
    const b = JSON.parse(readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}.json`, import.meta.url)));
    for (const [row, ab, sq] of [
      [b, absolute, square],
      [b.compat, compatAbsolute, compatSquare],
    ]) {
      assert.equal(row.nativeWebGL2.code, 'unsupported');
      assert.equal(row.reference.meta.quads, 15);
      assert.equal(row.reference.meta.triangles, 30);
      assert.equal(row.reference.meta.samples, 128);
      assert.equal(row.reference.meta.seed, 160);
      assert.equal(row.reference.meta.maxDepth, 2);
      for (const [i, mode] of ['unshadowed', 'shadowed'].entries()) {
        const r = row.rows[mode];
        assert.equal(r.margo.quads, 15);
        assert.equal(r.margo.draws, 15);
        assert.equal(r.metrics.absolute, ab[i]);
        assert.equal(r.metrics.square, sq[i]);
        assert.equal(r.metrics.max, max[i]);
        assert.equal(r.metrics.mae, ab[i] / (512 * 512 * 3));
      }
    }
    assert.equal(b.compat.hardware.webgpu.vendor, 'margo-webgl2');
    assert.equal(b.reference.linearSha256, b.compat.reference.linearSha256);
    assert.equal(b.reference.referenceSha256, b.compat.reference.referenceSha256);
    assert.equal(b.sceneSha256, b.compat.sceneSha256);
  });

// KB3573 accepted difference: the shadowed residual splits into the point light's authored range window, the default
// 512 map with 3x3 PCF, and what stays at 4096 (silhouette antialiasing and contact lines). Exact first measurements
// on the RTX A6000, native and WebGL2 compatibility (docs/limits.md, "Batch 160 job 8 decomposition").
for (const [family, rows, compatRows] of [
  [
    'clustered',
    { 'map-1024': 356406, 'map-2048': 212780, 'map-4096': 213642 },
    { 'map-1024': 356406, 'map-2048': 212777, 'map-4096': 213643 },
  ],
  [
    'clustered-point',
    { 'no-range-window': 469266, 'map-2048': 595330, 'map-4096': 605700, 'no-range-window-map-4096': 346680 },
    { 'no-range-window': 469265, 'map-2048': 595333, 'map-4096': 605703, 'no-range-window-map-4096': 346677 },
  ],
])
  test(`${family} shadowed residual decomposes into range window and shadow-map resolution (KB3573)`, () => {
    const point = family === 'clustered-point',
      b = JSON.parse(readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}.json`, import.meta.url))),
      d = JSON.parse(
        readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}-decomposition.json`, import.meta.url)),
      );
    assert.equal(d.sceneSha256, b.sceneSha256);
    assert.equal(d.reference.linearSha256, b.reference.linearSha256);
    assert.deepEqual(d.frozenShadowed, {
      native: b.rows.shadowed.metrics.absolute,
      compat: b.compat.rows.shadowed.metrics.absolute,
    });
    assert.equal(d.compat.hardware.webgpu.vendor, 'margo-webgl2');
    const variants = cornellDecomposition(point);
    assert.deepEqual(variants.map((v) => v.name), Object.keys(rows));
    for (const [side, expected] of [
      ['native', rows],
      ['compat', compatRows],
    ])
      for (const { name, ...options } of variants) {
        assert.deepEqual(d[side][name].options, options);
        assert.equal(d[side][name].metrics.absolute, expected[name]);
        assert.ok(expected[name] < d.frozenShadowed[side]);
      }
    const base = d.frozenShadowed.native,
      share = (name) => Math.round((1000 * (base - rows[name])) / base) / 10;
    if (point) {
      // Removing only the window (range 0, same shadow far 20) explains 35.7 %; it darkens nearly every lit pixel.
      assert.deepEqual(variants[0].light, { range: 0, shadow: { far: 20 } });
      assert.equal(share('no-range-window'), 35.7);
      assert.equal(share('map-2048'), 18.5);
      assert.equal(share('no-range-window-map-4096'), 52.5);
    } else {
      // Map resolution explains 62.5 % and converges by 2048: 4096 is no better.
      assert.equal(share('map-2048'), 62.5);
      assert.ok(rows['map-4096'] >= rows['map-2048']);
    }
  });

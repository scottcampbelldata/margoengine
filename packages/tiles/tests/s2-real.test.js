// Outside standard data only. The oracle below is written from the S2 quadratic projection and WGS84 equations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
import { Tileset } from '../dist/index.js';
import { s2 } from '../dist/s2.js';
import { memoryFetch, settle } from './generator.js';

// Face 0 has direction (1, u, v). Neither the engine's S2 nor its WGS84 routines produce these expected points.
function point(level, x, y, s, t, height) {
  const quadratic = (q) => q >= 0.5 ? (4 * q * q - 1) / 3 : (1 - 4 * (1 - q) ** 2) / 3;
  const n = 2 ** level, u = quadratic((x + s) / n), v = quadratic((y + t) / n);
  const lon = Math.atan2(u, 1), lat = Math.atan2(v, Math.hypot(1, u));
  const a = 6378137, flattening = 1 / 298.257223563, e2 = flattening * (2 - flattening);
  const sin = Math.sin(lat), cos = Math.cos(lat), radius = a / Math.sqrt(1 - e2 * sin * sin);
  return [(radius + height) * cos * Math.cos(lon), (radius + height) * cos * Math.sin(lon), (radius * (1 - e2) + height) * sin];
}

const morton = (x, y) => (x & 1) + 2 * (y & 1) + 4 * (x >> 1) + 8 * (y >> 1);

test('published Cesium S2 data: all 21 implicit cells contain independently sampled published height extents', {
  timeout: 20_000,
}, async (t) => {
  const root = requireExternalAssets('tiles/s2/');
  const files = new Map(['s2-tileset_1.1.json', 'subtrees/1.1/0.0.0.json', 'subtrees/metadata.bin']
    .map((name) => [name, readFileSync(join(root, name))]));
  const source = JSON.parse(files.get('s2-tileset_1.1.json'));
  const subtree = JSON.parse(files.get('subtrees/1.1/0.0.0.json'));
  const heights = files.get('subtrees/metadata.bin');
  assert.equal(source.root.boundingVolume.extensions['3DTILES_bounding_volume_S2'].token, '1');
  assert.equal(subtree.propertyTables[0].count, 21);
  const memory = memoryFetch(files);
  const loaded = await Tileset.load('https://tiles.test/s2-tileset_1.1.json', { fetch: memory.fetch, boundingVolumes: [s2] });
  t.after(() => loaded.dispose());
  const errors = [];
  loaded.on('error', (event) => errors.push(event.error));
  // Pump the normal update/fetch lifecycle; the in-memory source has no network timing dependency.
  for (let frame = 0; frame < 20; frame++) {
    loaded.update({ position: [6478137, 0, 0], screenHeight: 1080, fov: 60 });
    await settle(4);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual([...memory.requests].sort(), [...files.keys()].sort());
  const tiles = [];
  function visit(tile) {
    tiles.push(tile);
    for (const child of tile.children) visit(child);
  }
  visit(loaded.root);
  assert.equal(tiles.length, 21);
  let samples = 0;
  for (const tile of tiles) {
    const { level, x, y } = tile.implicit;
    const index = (4 ** level - 1) / 3 + morton(x, y);
    const minimumHeight = heights.readDoubleLE(8 * index);
    const maximumHeight = heights.readDoubleLE(168 + 8 * index);
    assert.ok(minimumHeight >= 1000 && maximumHeight <= 5000 && minimumHeight < maximumHeight);
    assert.equal(tile.children.length, level < 2 ? 4 : 0);
    assert.equal(tile.contentUrls.length, 0, 'this published sample has no content meshes');
    if (level > 0) {
      assert.ok(tile.bounds.radius < tile.parent.bounds.radius, 'a child bounds a smaller cell');
      assert.equal(Math.sign(tile.bounds.center[1]), x < 2 ** (level - 1) ? -1 : 1);
      assert.equal(Math.sign(tile.bounds.center[2]), y < 2 ** (level - 1) ? -1 : 1);
    }
    for (let sy = 0; sy <= 32; sy++) for (let sx = 0; sx <= 32; sx++) {
      for (const height of [minimumHeight, maximumHeight]) {
        const p = point(level, x, y, sx / 32, sy / 32, height);
        for (let axis = 0; axis < 3; axis++) {
          const h = tile.bounds.halfAxes.subarray(3 * axis, 3 * axis + 3);
          const length = Math.hypot(...h);
          const distance = p.reduce((sum, value, k) => sum + (value - tile.bounds.center[k]) * h[k], 0) / length;
          // Float64 arithmetic on Earth-scale coordinates: one micrometre, the existing S2 containment bar.
          assert.ok(Math.abs(distance) <= length + 1e-6, `cell ${level}/${x}/${y}, axis ${axis}`);
        }
        samples++;
      }
    }
  }
  assert.equal(samples, 45738);
  t.diagnostic('21 published cells, 45738 independent WGS84 points, 3 exact source files; no rendered content or height-tightening claim');
});

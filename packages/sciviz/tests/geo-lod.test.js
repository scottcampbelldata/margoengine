import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GeoTileCache,
  decodeTerrarium,
  geoTerrainStreamSource,
  geoTileMesh,
  selectGeoTiles,
  geoTileKey,
  geoTileHeight,
  quantizedGeoElevation,
} from '@margoengine/sciviz/geo-lod';
const root = { z: 0, x: 0, y: 0 };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
const view = (width = 512, matrix = identity) => ({ matrix, width, height: width });

test('view quadtree coarsens, refines, culls, bounds budget, and follows a pan', () => {
  assert.equal(selectGeoTiles(view(128)).length, 1);
  const full = selectGeoTiles(view(1024), { tileBudget: 64 });
  assert.ok(full.length >= 16);
  assert.ok(full.every((t) => t.z >= 2));
  assert.ok(selectGeoTiles(view(10000), { tileBudget: 7 }).length <= 7);
  const west = identity.slice();
  west[0] = west[5] = 8;
  west[12] = 5;
  const east = west.slice();
  east[12] = -5;
  const a = selectGeoTiles(view(512, west)),
    b = selectGeoTiles(view(512, east));
  assert.ok(a.every((t) => t.x < 2 ** t.z / 2));
  assert.ok(b.every((t) => t.x >= 2 ** t.z / 2));
  const away = identity.slice();
  away[12] = 10;
  assert.deepEqual(selectGeoTiles(view(512, away)), []);
  assert.throws(() => selectGeoTiles(view(512), { maxZoom: 25 }), RangeError);
  assert.throws(() => selectGeoTiles(view(512), { tileBudget: 0 }));
});

test('globe root curvature is visible even when dateline corners coincide', () => {
  const tiles = selectGeoTiles(view(1024), { projection: 'globe', tileBudget: 40, maxZoom: 5 });
  assert.ok(tiles.length > 4 && tiles.length <= 40);
  assert.ok(tiles.some((t) => t.z > 1));
});

test('elevation bytes, bilinear samples, stream mapping and row orientation', async () => {
  const e = decodeTerrarium({
    width: 2,
    height: 2,
    data: [128, 1, 128, 255, 128, 3, 128, 255, 128, 5, 128, 255, 128, 7, 128, 255],
  });
  assert.deepEqual([...e.heights], [1.5, 3.5, 5.5, 7.5]);
  assert.equal(geoTileHeight(e, 0.5, 0.5), 4.5);
  const requests = [],
    source = geoTerrainStreamSource(
      async (tile) => {
        requests.push(tile);
        return e;
      },
      { zoom: 2, tileTexels: 2, origin: [3, 1] },
    );
  const sample = await source(1, 1, new AbortController().signal);
  assert.deepEqual(requests, [{ z: 2, x: 0, y: 2 }]);
  assert.deepEqual([...sample.heights], [...e.heights]);
  sample.heights.fill(0);
  assert.equal(e.heights[0], 1.5);
  assert.equal(await source(0, -2, new AbortController().signal), undefined);
});

test('tile mesh has downward skirts, finite globe vertices and exact adjacent edges', () => {
  const segments = 4,
    n = segments + 1,
    a = geoTileMesh({ z: 2, x: 1, y: 1 }, 'globe', undefined, segments, 1000),
    b = geoTileMesh({ z: 2, x: 2, y: 1 }, 'globe', undefined, segments, 1000);
  assert.equal(a.vertices.length / 5, n * n + 4 * n);
  assert.equal(a.indices.length, segments * segments * 6 + 4 * segments * 6);
  assert.ok(a.vertices.every(Number.isFinite));
  for (let row = 0; row < n; row++)
    assert.deepEqual(
      a.vertices.slice((row * n + segments) * 5, (row * n + segments) * 5 + 3),
      b.vertices.slice(row * n * 5, row * n * 5 + 3),
    );
  for (let i = n * n; i < a.vertices.length / 5; i++) assert.ok(Math.hypot(...a.vertices.slice(i * 5, i * 5 + 3)) < 1);
});

test('quantized heights use the existing tiles/terrain decoder on the real Everest sample', async () => {
  const bytes = new Uint8Array(
    readFileSync(
      new URL('../../../examples/assets/terrain/CesiumWorldTerrainSample/9/759/335.terrain', import.meta.url),
    ),
  );
  const grid = await quantizedGeoElevation(bytes, 33);
  assert.equal(grid.heights.length, 1089);
  assert.ok(grid.heights.every(Number.isFinite));
  const { parseQuantizedMesh } = await import('@margoengine/tiles/terrain');
  const mesh = parseQuantizedMesh(bytes);
  // Independent signed-area barycentric oracle at the raster's centre. A coarse pixel grid does not sample
  // the summit vertex exactly, so its maximum must not be tested as though it were the source maximum.
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let expected;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [...mesh.indices.slice(i, i + 3)],
      p = ids.map((id) => [mesh.u[id] / 32767, mesh.v[id] / 32767]),
      denom = area(...p);
    if (!denom) continue;
    const w = [
      area([0.5, 0.5], p[1], p[2]) / denom,
      area(p[0], [0.5, 0.5], p[2]) / denom,
      area(p[0], p[1], [0.5, 0.5]) / denom,
    ];
    if (w.every((v) => v >= 0)) {
      expected =
        mesh.minimumHeight +
        (w.reduce((sum, v, j) => sum + v * mesh.height[ids[j]], 0) / 32767) * (mesh.maximumHeight - mesh.minimumHeight);
      break;
    }
  }
  assert.equal(grid.heights[544], Math.fround(expected));
  assert.ok(grid.heights.every((h) => h >= mesh.minimumHeight && h <= mesh.maximumHeight));
  await assert.rejects(quantizedGeoElevation(bytes.subarray(0, 88)), RangeError);
});

test('cache limits concurrent requests, preserves fallback, fades and evicts LRU', async () => {
  let active = 0,
    peak = 0;
  const dropped = [],
    calls = [];
  const cache = new GeoTileCache(
    async (tile) => {
      calls.push(geoTileKey(tile));
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return geoTileKey(tile);
    },
    { concurrency: 2, capacity: 4, drop: (v) => dropped.push(v) },
  );
  const selected = [
    { z: 1, x: 0, y: 0 },
    { z: 1, x: 1, y: 0 },
  ];
  cache.update(selected, 5);
  await cache.ready({ signal: AbortSignal.timeout(1000) });
  assert.equal(peak, 2);
  assert.equal(calls[0], '0/0/0');
  assert.deepEqual(
    cache.drawTiles(5, 1).map((d) => [geoTileKey(d.resident.tile), d.opacity]),
    [
      ['0/0/0', 1],
      ['1/0/0', 0],
      ['1/1/0', 0],
    ],
  );
  assert.equal(cache.drawTiles(5.5, 1).find((d) => d.resident.tile.z === 1).opacity, 0.5);
  assert.equal(cache.drawTiles(6, 1).length, 2);
  cache.update(
    [
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ],
    6,
  );
  await cache.ready();
  assert.equal(cache.residents.length, 4);
  assert.equal(dropped.length, 1);
  cache.dispose();
  assert.equal(dropped.length, 5);
});

test('stale tile results are aborted and dropped, errors surface without retry', async () => {
  const waits = new Map(),
    dropped = [];
  const cache = new GeoTileCache(
    (tile, signal) => new Promise((resolve) => waits.set(geoTileKey(tile), { resolve, signal })),
    { capacity: 4, concurrency: 2, drop: (value) => dropped.push(value) },
  );
  cache.update([{ z: 1, x: 0, y: 0 }]);
  await Promise.resolve();
  waits.get('0/0/0').resolve('root');
  cache.update([{ z: 1, x: 1, y: 1 }]);
  assert.ok(waits.get('1/0/0').signal.aborted);
  waits.get('1/0/0').resolve('stale');
  await new Promise((resolve) => setImmediate(resolve));
  waits.get('1/1/1').resolve('fresh');
  await cache.ready();
  assert.deepEqual(dropped, ['stale']);
  assert.ok(!cache.residents.some((r) => r.value === 'stale'));
  cache.dispose();
  let calls = 0;
  const error = new Error('provider failure');
  const failed = new GeoTileCache(async () => {
    calls++;
    throw error;
  });
  failed.update([root]);
  await assert.rejects(failed.ready(), (e) => e === error);
  failed.update([root]);
  await assert.rejects(failed.ready(), (e) => e === error);
  assert.equal(calls, 1);
  failed.dispose();
});

test('missing tiles retain loaded ancestors, aborted wait leaves ongoing work owned by cache', async () => {
  const cache = new GeoTileCache(async (t) => (t.z ? undefined : 'base'));
  cache.update([{ z: 3, x: 4, y: 3 }]);
  await cache.ready();
  assert.equal(cache.missing, 1);
  assert.deepEqual(
    cache.drawTiles(1).map((d) => d.resident.value),
    ['base'],
  );
  cache.dispose();
  const pending = new GeoTileCache(
    async (_t, signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve('late'), { once: true })),
  );
  pending.update([root]);
  await assert.rejects(pending.ready({ signal: AbortSignal.timeout(10) }), { name: 'TimeoutError' });
  pending.dispose();
});

test('cache disposal and source abort reject ready even when a provider ignores its signal', async () => {
  const c = new GeoTileCache(() => new Promise(() => {}));
  c.update([root]);
  const ready = c.ready();
  c.dispose();
  await assert.rejects(ready, { name: 'AbortError' });
  await assert.rejects(c.ready(), { name: 'AbortError' });
  const external = new AbortController(),
    reason = new Error('source stopped');
  const d = new GeoTileCache(() => new Promise(() => {}), { signal: external.signal });
  d.update([root]);
  const waiting = d.ready();
  external.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
});

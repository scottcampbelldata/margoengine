// SmoothTerrain and meshSmoothChunk: a ball meshes into a closed surface near its true radius, split over chunks it
// stays closed with shared border points, sculpting marks the right chunks, materials split the parts, errors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshSmoothChunk, SmoothTerrain, SmoothTerrainView } from '../dist/smooth.js';

const ball = (cx, cy, cz, r) => (x, y, z) => r - Math.hypot(x - cx, y - cy, z - cz);

// World-space triangles of every chunk, positions rounded to 1e-4 so shared points compare equal.
function surface(terrain) {
  const triangles = [];
  for (const key of terrain.keys()) {
    const [cx, cy, cz] = key.split(',').map(Number),
      mesh = meshSmoothChunk(terrain, key);
    for (const { positions, normals, indices } of mesh.parts.values())
      for (let t = 0; t < indices.length; t += 3)
        triangles.push(
          [0, 1, 2].map((c) => {
            const i = indices[t + c] * 3;
            return {
              p: [positions[i] + cx * 32, positions[i + 1] + cy * 32, positions[i + 2] + cz * 32].map(
                (v) => Math.round(v * 1e4) / 1e4,
              ),
              n: [normals[i], normals[i + 1], normals[i + 2]],
            };
          }),
        );
  }
  return triangles;
}

// Every edge used once in each direction: a closed, consistently wound surface.
function closed(triangles) {
  const edges = new Map();
  for (const t of triangles)
    for (let c = 0; c < 3; c++) {
      const k = `${t[c].p}|${t[(c + 1) % 3].p}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  for (const [k, n] of edges) {
    const [a, b] = k.split('|');
    if (n !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

test('a ball in one chunk: closed, wound outward, points within half a cell of the sphere', () => {
  const terrain = new SmoothTerrain();
  terrain.addChunk(0, 0, 0, ball(16, 16, 16, 9.3));
  const triangles = surface(terrain);
  assert.ok(triangles.length > 500, `${triangles.length} triangles`);
  assert.ok(closed(triangles));
  for (const t of triangles) {
    for (const { p, n } of t) {
      const d = Math.hypot(p[0] - 16, p[1] - 16, p[2] - 16);
      assert.ok(Math.abs(d - 9.3) < 0.5, `point ${p} at ${d}`);
      assert.ok((n[0] * (p[0] - 16) + n[1] * (p[1] - 16) + n[2] * (p[2] - 16)) / d > 0.8, 'normal points out');
    }
    const [a, b, c] = t.map((v) => v.p),
      u = b.map((v, i) => v - a[i]),
      w = c.map((v, i) => v - a[i]),
      face = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(
      face[0] * (a[0] - 16) + face[1] * (a[1] - 16) + face[2] * (a[2] - 16) > 0,
      'counterclockwise from outside',
    );
  }
});

test('a ball across eight chunks is closed with no seam, and matches the one-chunk ball moved', () => {
  const split = new SmoothTerrain(),
    whole = new SmoothTerrain();
  for (let cy = -1; cy <= 0; cy++)
    for (let cz = -1; cz <= 0; cz++) for (let cx = -1; cx <= 0; cx++) split.addChunk(cx, cy, cz, ball(0, 0, 0, 9.3));
  whole.addChunk(0, 0, 0, ball(16, 16, 16, 9.3));
  const a = surface(split),
    b = surface(whole);
  assert.ok(closed(a));
  assert.equal(a.length, b.length);
  const key = (t) =>
    t
      .map((v) => v.p.join())
      .sort()
      .join(';');
  const moved = new Set(b.map((t) => key(t.map((v) => ({ p: v.p.map((x) => Math.round((x - 16) * 1e4) / 1e4) })))));
  assert.ok(
    a.every((t) => moved.has(key(t))),
    'same triangles as one chunk',
  );
  // An unloaded neighbour leaves no wall: half a ball against nothing is open there, not capped.
  const half = new SmoothTerrain();
  half.addChunk(0, 0, 0, ball(0, 16, 16, 9.3));
  assert.ok(!closed(surface(half)));
});

test('sculpting and loading mark the chunks that read the changed cells; materials split the parts', () => {
  const terrain = new SmoothTerrain();
  terrain.addChunk(0, 0, 0, (x, y) => 10.5 - y);
  terrain.addChunk(
    1,
    0,
    0,
    (x, y) => 10.5 - y,
    () => 2,
  );
  assert.deepEqual([...terrain.dirty].sort(), ['0,0,0', '1,0,0']);
  terrain.dirty.clear();
  assert.ok(terrain.sculpt([10, 10, 10], 3, 1, 1) > 0);
  assert.deepEqual([...terrain.dirty], ['0,0,0']);
  terrain.dirty.clear();
  terrain.sculpt([32, 10, 10], 2, -1);
  assert.deepEqual([...terrain.dirty].sort(), ['0,0,0', '1,0,0']);
  assert.ok(terrain.getDensity(32, 10, 10) < 0);
  assert.equal(terrain.getMaterial(10, 11, 10), 1);
  assert.equal(terrain.getDensity(0, 0, 99), undefined);
  assert.deepEqual([...meshSmoothChunk(terrain, '0,0,0').parts.keys()], [0, 1]);
  assert.deepEqual([...meshSmoothChunk(terrain, '1,0,0').parts.keys()], [2]);
  assert.equal(meshSmoothChunk(terrain, '5,0,0'), undefined);
  terrain.dirty.clear();
  assert.ok(terrain.removeChunk(1, 0, 0));
  assert.deepEqual([...terrain.dirty].sort(), ['0,0,0', '1,0,0']);
});

test('options and arguments are checked', () => {
  assert.throws(() => new SmoothTerrain({ minChunkY: 2, maxChunkY: 1 }), RangeError);
  const terrain = new SmoothTerrain();
  assert.throws(() => terrain.addChunk(0, 9, 0), RangeError);
  assert.throws(() => terrain.addChunk(0.5, 0, 0), RangeError);
  assert.throws(() => terrain.addChunk(0, 0, 0, 5), TypeError);
  assert.throws(() => terrain.addChunk(0, 0, 0, () => Number.NaN), RangeError);
  assert.throws(() => terrain.addChunk(0, 0, 0, undefined, () => 300), RangeError);
  assert.throws(() => terrain.sculpt([0, 0], 2, 1), RangeError);
  assert.throws(() => terrain.sculpt([0, 0, 0], 0, 1), RangeError);
  assert.throws(() => terrain.sculpt([0, 0, 0], 2, 3), RangeError);
  assert.throws(() => meshSmoothChunk({}, '0,0,0'), TypeError);
  assert.throws(() => meshSmoothChunk(terrain, 'a'), RangeError);
  assert.throws(() => SmoothTerrainView.attach({}, { terrain, materials: [{}] }), TypeError);
  const engine = { createMesh() {}, remove() {}, camera: { position: [0, 0, 0] } };
  assert.throws(() => SmoothTerrainView.attach(engine, { terrain: {}, materials: [{}] }), TypeError);
  assert.throws(() => SmoothTerrainView.attach(engine, { terrain, materials: [] }), TypeError);
  assert.throws(() => SmoothTerrainView.attach(engine, { terrain, materials: [{}], budget: 0 }), RangeError);
  const view = SmoothTerrainView.attach(engine, { terrain, materials: [{}] });
  view.dispose();
  assert.throws(() => view.update(), { code: 'disposed' });
});

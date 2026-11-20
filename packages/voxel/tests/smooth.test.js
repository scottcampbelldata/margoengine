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

test('createMesh: each chunk part goes to the app with its material and corner, and is disposed with the chunk', () => {
  const terrain = new SmoothTerrain(),
    height = (x, z) => 12 + 3 * Math.sin(x / 7) + 2 * Math.cos(z / 5);
  terrain.addChunk(
    0,
    0,
    0,
    (x, y, z) => height(x, z) - y,
    (x, y, z) => (y > height(x, z) - 2 ? 0 : 1),
  );
  terrain.addChunk(
    1,
    0,
    0,
    (x, y, z) => height(x + 32, z) - y,
    () => 0,
  );
  const made = [],
    engine = {
      createMesh: () => assert.fail('no core mesh when createMesh is given'),
      camera: { position: [0, 0, 0] },
    },
    view = SmoothTerrainView.attach(engine, {
      terrain,
      createMesh(part, material, origin) {
        const mesh = { part, material, origin: [...origin], disposed: false, dispose: () => (mesh.disposed = true) };
        made.push(mesh);
        return mesh;
      },
    });
  view.update();
  const direct = new Map([...meshSmoothChunk(terrain, '0,0,0').parts].filter(([, p]) => p.positions.length >= 9));
  const first = made.filter((m) => m.origin[0] === 0);
  assert.deepEqual(
    first.map((m) => m.material),
    [...direct.keys()],
    'one call per material part, in part order',
  );
  for (const m of first) assert.deepEqual([...m.part.indices], [...direct.get(m.material).indices]);
  assert.ok(
    made.some((m) => m.origin[0] === 32 && m.origin[1] === 0 && m.origin[2] === 0),
    "the chunk's corner",
  );
  assert.ok(made.every((m) => !m.disposed));
  terrain.sculpt([8, 12, 8], 4, -1);
  view.update();
  assert.ok(
    first.every((m) => m.disposed),
    'meshed again: the old parts are disposed',
  );
  view.dispose();
  assert.ok(
    made.every((m) => m.disposed),
    'the view disposes every part',
  );
  // Neither materials nor createMesh, or a createMesh that is not a function or returns no dispose(): TypeError.
  assert.throws(() => SmoothTerrainView.attach(engine, { terrain }), TypeError);
  assert.throws(() => SmoothTerrainView.attach(engine, { terrain, createMesh: 1 }), TypeError);
  const bad = SmoothTerrainView.attach(engine, { terrain, createMesh: () => ({}) });
  terrain.sculpt([8, 12, 8], 4, 1);
  assert.throws(() => bad.update(), TypeError);
  bad.dispose();
});

test('createMesh that throws leaves the chunk pending and its previous meshes drawn', () => {
  const terrain = new SmoothTerrain(),
    height = (x, z) => 12 + 3 * Math.sin(x / 7) + 2 * Math.cos(z / 5);
  terrain.addChunk(
    0,
    0,
    0,
    (x, y, z) => height(x, z) - y,
    (x) => (x < 16 ? 0 : 1),
  );
  const made = [];
  let fail = false;
  const view = SmoothTerrainView.attach(
    { createMesh: () => assert.fail('no core mesh'), camera: { position: [0, 0, 0] } },
    {
      terrain,
      createMesh(part, material) {
        // The second part of a remesh fails, after the first was made.
        if (fail && made.some((m) => m.round === 2)) throw new Error('GPU out of memory');
        const mesh = { material, round: fail ? 2 : 1, disposed: false, dispose: () => (mesh.disposed = true) };
        made.push(mesh);
        return mesh;
      },
    },
  );
  view.update();
  const first = made.filter((m) => m.round === 1);
  assert.ok(first.length >= 2, 'the chunk has two material parts');
  fail = true;
  terrain.sculpt([8, 12, 8], 4, -1);
  assert.throws(() => view.update(), /GPU out of memory/);
  assert.ok(first.every((m) => !m.disposed), 'the previous meshes stay drawn');
  assert.ok(made.filter((m) => m.round === 2).every((m) => m.disposed), 'the partial new meshes are freed');
  assert.ok(terrain.dirty.has('0,0,0'), 'the chunk is still pending');
  assert.equal(view.stats.chunks, 1);
  fail = false;
  assert.equal(view.update(), 1, 'meshed on the next update');
  assert.ok(first.every((m) => m.disposed) && !terrain.dirty.size);
  view.dispose();
  assert.ok(made.every((m) => m.disposed));
});

// An engine whose meshes record their geometry and position.
const recordingEngine = (position) => {
  const meshes = [];
  return {
    meshes,
    camera: { position },
    createMesh() {
      const mesh = {
        position: { value: [0, 0, 0], set: (x, y, z) => (mesh.position.value = [x, y, z]) },
        setGeometry: (g) => ((mesh.geometry = g), mesh),
        setMaterial: (m) => ((mesh.material = m), mesh),
        disposed: false,
        dispose: () => (mesh.disposed = true),
      };
      meshes.push(mesh);
      return mesh;
    },
  };
};
// Rolling ground over a line of four chunks from chunk (cx, 0, cz), the same shape wherever it starts.
const ground = (cx, cz) => {
  const terrain = new SmoothTerrain(),
    field = (x, y, z) => 12 + 3 * Math.sin((x - cx * 32) / 7) + 2 * Math.cos((z - cz * 32) / 5) - y;
  for (let i = 0; i < 4; i++) terrain.addChunk(cx + i, 0, cz, field);
  return terrain;
};
const placed = (engine) =>
  engine.meshes.filter((m) => !m.disposed).map((m) => `${m.position.value}:${m.geometry.vertices.length}`);

test('origin: terrain 2^24 blocks out, under its origin, meshes nearest first and places the same meshes as near zero', () => {
  const S = 2 ** 24,
    near = recordingEngine([100, 20, 16]),
    far = recordingEngine([100, 20, 16]),
    a = SmoothTerrainView.attach(near, { terrain: ground(0, 0), materials: [{}], budget: 1 }),
    b = SmoothTerrainView.attach(far, {
      terrain: ground(S / 32, -S / 32),
      materials: [{}],
      budget: 1,
      origin: { origin: [S, 0, -S] },
    });
  a.update();
  b.update();
  // Budget 1: the chunk nearest the world eye (chunk 3, x 96..128) comes first in both.
  assert.deepEqual(placed(far), placed(near));
  assert.equal(near.meshes[0].position.value[0], 96);
  while (a.update());
  while (b.update());
  assert.deepEqual(placed(far), placed(near));
  for (let i = 0; i < far.meshes.length; i++)
    assert.deepEqual([...far.meshes[i].geometry.vertices], [...near.meshes[i].geometry.vertices]);
  // A moved origin (live field and in place) moves every mesh to its corner minus the new origin, in float64.
  b.origin.origin[0] = S + 64.5;
  b.update();
  assert.deepEqual(
    far.meshes.map((m) => m.position.value[0]).sort((x, y) => x - y),
    near.meshes.map((m) => m.position.value[0] - 64.5).sort((x, y) => x - y),
  );
  b.origin = null;
  b.update();
  assert.ok(far.meshes.every((m) => m.position.value[0] >= S && m.position.value[2] === -S));
  assert.throws(() => SmoothTerrainView.attach(far, { terrain: ground(0, 0), materials: [{}], origin: 3 }), TypeError);
  const nan = SmoothTerrainView.attach(far, {
    terrain: ground(0, 0),
    materials: [{}],
    origin: { origin: [0, Number.NaN, 0] },
  });
  assert.throws(() => nan.update(), RangeError);
});

test('origin: createMesh gets the corner in engine space; a moved origin makes meshes without a position again', () => {
  const S = 2 ** 24,
    made = [],
    origin = { origin: [S, 0, 0] },
    view = SmoothTerrainView.attach(
      { createMesh: () => assert.fail('no core mesh'), camera: { position: [0, 0, 0] } },
      {
        terrain: ground(S / 32, 0),
        origin,
        createMesh(part, material, corner) {
          const mesh = { corner: [...corner], disposed: false, dispose: () => (mesh.disposed = true) };
          made.push(mesh);
          return mesh;
        },
      },
    );
  view.update();
  assert.deepEqual(
    made.map((m) => m.corner[0]).sort((x, y) => x - y),
    [0, 32, 64, 96],
  );
  origin.origin[0] = S + 32;
  const before = made.length;
  view.update();
  assert.ok(made.slice(0, before).every((m) => m.disposed));
  assert.deepEqual(
    made
      .slice(before)
      .map((m) => m.corner[0])
      .sort((x, y) => x - y),
    [-32, 0, 32, 64],
  );
});

test('a chunk missing beside two loaded neighbours: both neighbours compute their shared border points alike', () => {
  // Chunks (0,0,0) and (1,0,0) loaded, (0,0,1) and (1,0,1) not: the samples past z = 32 repeat along z only, so the
  // net cells at x 31, z 31 that both chunks mesh get the same points (they once clamped every axis and differed).
  const terrain = new SmoothTerrain(),
    low = (x, y, z) => 12 + 3 * Math.sin(z / 5) + 2 * Math.cos(x / 3) + 0.3 * z - y;
  terrain.addChunk(0, 0, 0, low);
  terrain.addChunk(1, 0, 0, low);
  const near = (key, shift) => {
    const set = new Set();
    for (const part of meshSmoothChunk(terrain, key).parts.values())
      for (let i = 0; i < part.positions.length; i += 3) {
        const x = part.positions[i] + shift,
          z = part.positions[i + 2];
        if (x > 31 && x < 32 && z > 31 && z < 32)
          set.add([x, part.positions[i + 1], z].map((v) => v.toFixed(4)).join());
      }
    return set;
  };
  const left = near('0,0,0', 0),
    right = near('1,0,0', 32);
  assert.ok(right.size > 0, 'the surface crosses the corner cell');
  // Every corner point the right chunk draws is one the left chunk draws.
  for (const point of right) assert.ok(left.has(point), `${point} only in the right chunk: ${[...left]}`);
});

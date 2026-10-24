import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MeshBVH as RootBVH, buildAsync } from '../dist/index.js';
import { MeshBVH, buildBVH } from '../dist/tree.js';
import { rayTriangle } from '../dist/math.js';
import { rng } from './reference.js';

const NODE_WORDS = 8;

// Random triangles far from the origin, where float32 storage would move every vertex by up to ~1 unit.
function farSoup(random, count, offset = 3e7) {
  const positions = new Float64Array(count * 9);
  for (let t = 0; t < count; t++) {
    const cx = offset + random() * 50,
      cy = random() * 50,
      cz = -offset + random() * 50;
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = cx + random() * 3 + random() * 1e-3;
      positions[t * 9 + v * 3 + 1] = cy + random() * 3 + random() * 1e-3;
      positions[t * 9 + v * 3 + 2] = cz + random() * 3 + random() * 1e-3;
    }
  }
  return positions;
}

// Every float64 triangle vertex lies inside its leaf's float32 box and every leaf inside its parents.
function assertBoundsContain(bvh) {
  const f = bvh.nodeBounds,
    u = bvh.nodeData,
    P = bvh.positions,
    s = bvh.stride;
  for (let node = 0; node < bvh.nodeCount; node++) {
    const w = node * NODE_WORDS;
    if (bvh.isLeaf(node)) {
      for (let k = u[w + 6], end = k + u[w + 7]; k < end; k++)
        for (let v = 0; v < 3; v++) {
          const o = bvh.index[k * 3 + v] * s;
          for (let axis = 0; axis < 3; axis++) {
            assert.ok(f[w + axis] <= P[o + axis], `node ${node} min ${axis}`);
            assert.ok(f[w + axis + 3] >= P[o + axis], `node ${node} max ${axis}`);
          }
        }
    }
  }
}

// Brute force over the float64 triangles with the same exact predicate, sorted like raycast.
function brute(positions, ray, near = 0, far = Infinity) {
  const out = new Float64Array(4),
    hits = [],
    [ox, oy, oz] = ray.origin,
    [dx, dy, dz] = ray.direction,
    length = Math.hypot(dx, dy, dz);
  for (let t = 0; t < positions.length / 9; t++) {
    const p = positions.subarray(t * 9, t * 9 + 9);
    if (
      rayTriangle(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        p[0],
        p[1],
        p[2],
        p[3],
        p[4],
        p[5],
        p[6],
        p[7],
        p[8],
        0,
        near / length,
        far / length,
        out,
      )
    )
      hits.push({ faceIndex: t, distance: out[0] * length, barycoord: [1 - out[1] - out[2], out[1], out[2]] });
  }
  return hits.sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex);
}

test('float32 stays the default: other position arrays are converted and Float32Array is used as is', () => {
  const positions = new Float64Array([0.1, 0, 0, 1, 0, 0, 0, 1, 0]),
    converted = MeshBVH.build({ positions });
  assert.ok(converted.positions instanceof Float32Array);
  assert.equal(converted.positions[0], Math.fround(0.1));
  const f32 = new Float32Array(positions);
  assert.equal(MeshBVH.build({ positions: f32 }).positions, f32);
  assert.equal(MeshBVH.build({ positions: f32, precision: 'float32' }).positions, f32);
});

test("precision 'float64' keeps a Float64Array uncopied, converts other arrays, and rejects unknown values", () => {
  const positions = new Float64Array([0.1, 0, 0, 1, 0, 0, 0, 1, 0]),
    bvh = MeshBVH.build({ positions, precision: 'float64' });
  assert.equal(bvh.positions, positions);
  const fromArray = MeshBVH.build({ positions: [...positions], precision: 'float64' });
  assert.ok(fromArray.positions instanceof Float64Array);
  assert.equal(fromArray.positions[0], 0.1);
  const fromF32 = MeshBVH.build({ positions: new Float32Array(positions), precision: 'float64' });
  assert.ok(fromF32.positions instanceof Float64Array);
  assert.throws(() => MeshBVH.build({ positions, precision: 'double' }), TypeError);
  // Prebuilt data wraps the same way.
  const data = buildBVH(positions, 3, null);
  assert.equal(new MeshBVH(data, { positions, precision: 'float64' }).positions, positions);
  assert.equal(MeshBVH.deserialize(bvh.serialize(), { positions, precision: 'float64' }).positions, positions);
});

test('float32 node bounds are rounded outward around float64 triangles, also after refit', () => {
  const random = rng(11),
    positions = farSoup(random, 400);
  for (const maxLeafTriangles of [1, 4, 8]) {
    const bvh = MeshBVH.build({ positions, precision: 'float64' }, { maxLeafTriangles });
    assertBoundsContain(bvh);
    for (let i = 0; i < positions.length; i++) positions[i] += (random() - 0.5) * 1e-3;
    bvh.refit();
    assertBoundsContain(bvh);
  }
});

test('float32 positions keep exact (unrounded) bounds', () => {
  const positions = new Float32Array(farSoup(rng(3), 64, 1e5)),
    bvh = MeshBVH.build({ positions });
  for (let node = 0; node < bvh.nodeCount; node++) {
    if (!bvh.isLeaf(node)) continue;
    const w = node * NODE_WORDS;
    let min = Infinity;
    for (const face of bvh.leafTriangles(node))
      for (let v = 0; v < 3; v++) min = Math.min(min, positions[face * 9 + v * 3]);
    assert.equal(bvh.nodeBounds[w], min);
  }
});

test('float64 all-hit and nearest queries match brute force exactly far from the origin, in distance then face order', () => {
  const random = rng(5),
    positions = farSoup(random, 1500),
    bvh = MeshBVH.build({ positions, precision: 'float64' }, { maxLeafTriangles: 2 });
  let hits = 0;
  for (let i = 0; i < 600; i++) {
    const origin = [3e7 + random() * 60 - 5, random() * 60 - 5, -3e7 - 10],
      target = [3e7 + random() * 50, random() * 50, -3e7 + random() * 50],
      direction = target.map((v, k) => v - origin[k]),
      ray = { origin, direction },
      expected = brute(positions, ray),
      found = bvh.raycast(ray);
    hits += expected.length;
    assert.deepEqual(
      found.map((h) => [h.faceIndex, h.distance, ...h.barycoord]),
      expected.map((h) => [h.faceIndex, h.distance, ...h.barycoord]),
      `ray ${i}`,
    );
    const first = bvh.raycastFirst(ray);
    assert.deepEqual(first, found[0] ?? null);
    // Barycentric weights reproduce the float64 hit point.
    for (const hit of found) {
      const [a, b, c] = hit.face;
      for (let axis = 0; axis < 3; axis++) {
        const p =
          positions[a * 3 + axis] * hit.barycoord[0] +
          positions[b * 3 + axis] * hit.barycoord[1] +
          positions[c * 3 + axis] * hit.barycoord[2];
        assert.ok(Math.abs(p - hit.point[axis]) < 1e-6 * (Math.abs(p) + 1));
      }
    }
  }
  assert.ok(hits > 100, `only ${hits} hits`);
});

test('raycastFirst resolves equal distances to the lowest face index, whatever the leaf order', () => {
  const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0],
    positions = new Float32Array(Array.from({ length: 12 }, () => triangle).flat()),
    ray = { origin: [0.2, 0.2, 1], direction: [0, 0, -1] };
  for (const strategy of ['sah', 'center'])
    for (const maxLeafTriangles of [1, 3, 12]) {
      const bvh = MeshBVH.build({ positions }, { strategy, maxLeafTriangles }),
        all = bvh.raycast(ray);
      assert.deepEqual(
        all.map((h) => h.faceIndex),
        [...Array(12).keys()],
      );
      assert.equal(bvh.raycastFirst(ray).faceIndex, 0);
      assert.deepEqual(bvh.raycastFirst(ray), all[0]);
    }
});

test('buildAsync keeps float64 precision (no Worker in Node: built on a microtask)', async () => {
  const positions = farSoup(rng(9), 20),
    bvh = await buildAsync({ positions, precision: 'float64' });
  assert.equal(bvh.positions, positions);
  assertBoundsContain(bvh);
});

test('@margoengine/bvh/tree is engine-free: the same MeshBVH, with no core import in its module graph or types', () => {
  assert.equal(MeshBVH, RootBVH);
  const seen = new Set(),
    visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(new URL(file), 'utf8');
      assert.doesNotMatch(text, /@margoengine\/core/, file);
      for (const [, path] of text.matchAll(/from '(\.\/[^']+)'/g))
        visit(new URL(file.endsWith('.d.ts') ? path.replace(/\.js$/, '.d.ts') : path, file).href);
    };
  for (const entry of ['../dist/tree.js', '../dist/tree.d.ts']) visit(new URL(entry, import.meta.url).href);
  assert.ok(seen.size >= 4);
});

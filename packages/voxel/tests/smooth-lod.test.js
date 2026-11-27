// SmoothLod and meshSmoothLodNode: far levels of a smooth terrain chosen like VoxelLod, each node clipped to its box
// with capped faces, so rays from the air never pass between the real terrain and the levels or between two levels; far
// geometry within a cell of the true surface; level 1 leaves the real chunks' boxes empty; handover with no hole;
// origin; errors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshSmoothChunk, SmoothTerrain } from '../dist/smooth.js';
import { meshSmoothLodNode, SmoothLod } from '../dist/smooth-lod.js';

const height = (x, z) =>
  24 + 14 * Math.sin(x / 53) * Math.cos(z / 41) + 6 * Math.sin((x + z) / 23) + 3 * Math.sin(x / 7) * Math.cos(z / 9);
const density = (x, y, z) => height(x, z) - y;
const engine = { createMesh: () => assert.fail('createMesh is given'), camera: { position: [0, 0, 0] } };

// World triangles [ax, ay, az, bx, ..., cz] of a mesh part placed at `origin`.
function place(part, origin, out) {
  const { positions: p, indices } = part;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    out.push(p[v] + origin[0], p[v + 1] + origin[1], p[v + 2] + origin[2]);
  }
}

// The real terrain (2 x 2 chunk columns around zero) drawn with caps, and a SmoothLod around eye (0, 30, 0).
function scene(skirt, options = {}) {
  const terrain = new SmoothTerrain(),
    tris = [];
  for (let cx = -1; cx <= 0; cx++)
    for (let cz = -1; cz <= 0; cz++) for (let cy = -1; cy <= 1; cy++) terrain.addChunk(cx, cy, cz, density);
  for (const key of terrain.keys()) {
    const [cx, cy, cz] = key.split(',').map(Number),
      mesh = meshSmoothChunk(terrain, key, { skirt });
    for (const part of mesh.parts.values()) place(part, [cx * 32, cy * 32, cz * 32], tris);
  }
  const levels = [],
    lod = SmoothLod.attach(engine, {
      terrain,
      density,
      levels: 3,
      radius: 2,
      budget: Infinity,
      skirt,
      createMesh(part, material, origin, level) {
        const at = tris.length;
        place(part, origin, tris);
        levels.push([level, at, tris.length]);
        return { dispose() {} };
      },
      ...options,
    });
  lod.update([0, 30, 0]);
  return { terrain, lod, tris, levels };
}

// Segment-triangle hits, with the triangles bucketed by 16-block xz squares.
function caster(tris) {
  const buckets = new Map(),
    B = 16;
  for (let t = 0; t < tris.length; t += 9) {
    const xs = [tris[t], tris[t + 3], tris[t + 6]],
      zs = [tris[t + 2], tris[t + 5], tris[t + 8]];
    for (let i = Math.floor(Math.min(...xs) / B); i <= Math.floor(Math.max(...xs) / B); i++)
      for (let k = Math.floor(Math.min(...zs) / B); k <= Math.floor(Math.max(...zs) / B); k++) {
        const key = `${i},${k}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(t);
      }
  }
  return (o, d, len) => {
    const seen = new Set(),
      e = [o[0] + d[0] * len, o[2] + d[2] * len];
    for (let i = Math.floor(Math.min(o[0], e[0]) / B); i <= Math.floor(Math.max(o[0], e[0]) / B); i++)
      for (let k = Math.floor(Math.min(o[2], e[1]) / B); k <= Math.floor(Math.max(o[2], e[1]) / B); k++)
        for (const t of buckets.get(`${i},${k}`) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          // Moller and Trumbore 1997, two-sided.
          const a = [tris[t], tris[t + 1], tris[t + 2]],
            e1 = [tris[t + 3] - a[0], tris[t + 4] - a[1], tris[t + 5] - a[2]],
            e2 = [tris[t + 6] - a[0], tris[t + 7] - a[1], tris[t + 8] - a[2]],
            p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
            det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
          if (Math.abs(det) < 1e-12) continue;
          const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]],
            u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
            v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
          if (v < -1e-9 || u + v > 1 + 1e-9) continue;
          const h = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
          if (h >= 0 && h <= len) return true;
        }
    return false;
  };
}

// Rays from the air into the ground, tilted up to 60 degrees: a third aimed anywhere, two thirds aimed at the ground
// where it crosses a node border plane (x or z a multiple of 32), within 0.3 blocks above or below it and crossing the
// plane there. Returns those that reach 40 blocks past the aim without meeting a triangle.
function misses(tris, count = 6000) {
  const hit = caster(tris);
  let seed = 7,
    missed = 0,
    cast = 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let n = 0; n < count; n++) {
    let x = -400 + 800 * rnd(),
      z = -400 + 800 * rnd(),
      y;
    const tilt = (Math.PI / 3) * rnd(),
      turn = 2 * Math.PI * rnd(),
      d = [Math.sin(tilt) * Math.cos(turn), -Math.cos(tilt), Math.sin(tilt) * Math.sin(turn)];
    if (n % 3) {
      if (n % 3 === 1) x = Math.round(x / 32) * 32;
      else z = Math.round(z / 32) * 32;
      y = height(x, z) + 0.6 * rnd() - 0.3;
    } else y = height(x, z);
    const o = [x - 14 * d[0], y - 14 * d[1], z - 14 * d[2]];
    if (o[1] < height(o[0], o[2]) + 1) continue; // the start must be in the air
    cast++;
    if (!hit(o, d, 54)) missed++;
  }
  return { missed, cast };
}

test('no cracks: rays from the air into the ground meet the real terrain or a far level everywhere', () => {
  const { tris, lod } = scene(32);
  assert.deepEqual(
    lod.stats.nodes.map((n) => n > 0),
    [true, true, true],
  );
  const { missed, cast } = misses(tris);
  assert.ok(cast > 4000, `cast ${cast}`);
  assert.equal(missed, 0, `${missed} of ${cast} rays passed through the ground`);
});

// Lengyel 2010, Figure 4.5: ground running nearly parallel to the face y = 128 that level-1 node (0, 1, 0) shares with
// level-2 node (0, 1, 0), within half a block of it, so the two levels' borders on the face wander far apart. Waves
// found by a seeded search over such grounds; 4-cell skirts left sky through at about x 35.6, z 53.3.
const flat = [
  [0.12421930208802223, -0.7617025375366211, 1.6731653213500977, 2.378814058303833],
  [0.025422632694244385, 1.9381571412086487, 0.5293731689453125, 0.35344524383544923],
  [0.1451106108725071, -1.0547990798950195, -1.076115608215332, 4.634554128646851],
  [0.14568108320236206, 1.5507307052612305, -1.854619026184082, 1.4739518052339555],
];
const flatHeight = (x, z) =>
  128.16098064184188843 +
  0.016896467208862304 * (x - 32) +
  flat.reduce((h, [a, kx, kz, ph]) => h + a * Math.sin(kx * x + kz * z + ph), 0);

test('near-parallel seam: a level-1 node and the level-2 node above it let no ray from the air through', () => {
  const field = (x, y, z) => flatHeight(x, z) - y,
    tris = [];
  for (const [level, node] of [
    [1, [0, 1, 0]],
    [2, [0, 1, 0]],
  ]) {
    const size = 32 * 2 ** level;
    for (const part of meshSmoothLodNode(field, level, ...node, {}).parts.values())
      place(part, [node[0] * size, node[1] * size, node[2] * size], tris);
  }
  const hit = caster(tris);
  let cast = 0,
    missed = 0;
  // Straight down over the whole shared face, then finely around the crack the skirts left; the rays start at y 140
  // (air in both levels) and end at y 112 (solid in both).
  const ray = (x, z) => {
    cast++;
    if (!hit([x, 140, z], [0, -1, 0], 28)) missed++;
  };
  for (let x = 0.13; x < 64; x += 0.5) for (let z = 0.29; z < 64; z += 0.5) ray(x, z);
  for (let x = 33.01; x < 38; x += 0.04) for (let z = 51.03; z < 56; z += 0.04) ray(x, z);
  assert.ok(cast > 30000, `cast ${cast}`);
  assert.equal(missed, 0, `${missed} of ${cast} rays passed through the seam`);
});

// Every edge of a closed surface is used by two triangles in opposite directions (by float32 position; triangles that
// round to a line or a point are skipped).
function openEdges(mesh) {
  const edges = new Map();
  for (const part of mesh.parts.values()) {
    const { positions: p, indices } = part,
      key = (v) => `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`;
    for (let t = 0; t < indices.length; t += 3) {
      const k = [key(indices[t]), key(indices[t + 1]), key(indices[t + 2])];
      if (k[0] === k[1] || k[1] === k[2] || k[2] === k[0]) continue;
      for (let e = 0; e < 3; e++) {
        const a = k[e],
          b = k[(e + 1) % 3],
          id = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(id, (edges.get(id) ?? 0) + (a < b ? 1 : -1));
      }
    }
  }
  return [...edges.values()].filter((n) => n !== 0).length;
}

test('closed: every node mesh (whole or with octants left out) and a lone skirted chunk bound a closed solid', () => {
  const near = (x, y, z) => flatHeight(x, z) - y;
  let meshes = 0;
  for (const [field, level, node, mask] of [
    [density, 1, [0, 0, 0], 0],
    [density, 1, [-1, 0, 2], 0],
    [density, 2, [0, 0, 0], 0],
    [density, 3, [-1, 0, 0], 0],
    [density, 1, [0, 0, 0], 19],
    [density, 1, [0, 0, -1], 0b10100101],
    [density, 1, [-1, 0, -1], 0b01011010],
    [near, 1, [0, 1, 0], 0],
    [near, 2, [0, 1, 0], 0],
    [near, 1, [0, 1, 0], 0b00110011],
  ]) {
    const mesh = meshSmoothLodNode(field, level, ...node, { mask });
    assert.ok(mesh.triangles > 100, `level ${level} node ${node}: ${mesh.triangles} triangles`);
    assert.equal(openEdges(mesh), 0, `level ${level} node ${node} mask ${mask}`);
    meshes++;
  }
  const terrain = new SmoothTerrain();
  terrain.addChunk(0, 0, 0, density);
  assert.equal(openEdges(meshSmoothChunk(terrain, '0,0,0', { skirt: 32 })), 0, 'lone chunk');
  // Without caps the same node is open.
  assert.ok(openEdges(meshSmoothLodNode(density, 1, 0, 0, 0, { skirt: 0 })) > 50);
  assert.equal(meshes, 10);
});

// Seeded caves (`3 + noise`) and overhanging ground (`20 + noise - y`), noise a sum of five plane waves with
// wavenumbers up to 0.3 per block on each axis and amplitudes 2 to 12: at levels 1 and 2 the surface folds inside one
// cell, also at box edges and corners, where the two faces meeting there must agree on what is solid. Every fourth
// node leaves some octants out.
function noiseNodes() {
  let seed = 99;
  const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    },
    nodes = [];
  for (let n = 0; n < 60; n++) {
    const waves = Array.from({ length: 5 }, () => [
        (rnd() * 2 - 1) * 0.3,
        (rnd() * 2 - 1) * 0.3,
        (rnd() * 2 - 1) * 0.3,
        6.28 * rnd(),
        2 + 10 * rnd(),
      ]),
      kind = n % 3;
    rnd();
    rnd();
    const level = 1 + (n % 3),
      mask = n % 4 === 0 ? Math.floor(rnd() * 255) : 0,
      node = [Math.floor(rnd() * 3) - 1, 0, Math.floor(rnd() * 3) - 1];
    if (kind === 2) continue;
    const noise = (x, y, z) =>
        waves.reduce((s, [a, b, c, ph, amp]) => s + amp * Math.sin(a * x + b * y + c * z + ph), 0),
      field = kind === 0 ? (x, y, z) => 20 + noise(x, y, z) - y : (x, y, z) => noise(x, y, z) + 3;
    nodes.push({ field, level, node, mask, mesh: meshSmoothLodNode(field, level, ...node, { mask }) });
  }
  return nodes;
}
let noisy;
const noiseMeshes = () => {
  noisy ??= noiseNodes();
  return noisy;
};

test('closed for any field: seeded cave and overhang nodes, whole or part-masked, have every edge used twice', () => {
  const nodes = noiseMeshes(),
    open = nodes.map(({ mesh }) => openEdges(mesh));
  assert.equal(nodes.length, 40);
  assert.ok(
    nodes.every(({ mesh }) => mesh.triangles > 1000),
    'every node has ground in it',
  );
  assert.deepEqual(
    open.flatMap((n, k) => (n ? [`node ${k} level ${nodes[k].level} mask ${nodes[k].mask}: ${n} open edges`] : [])),
    [],
  );
});

// +1 when segment o + h d (h in [0, 1]) enters the solid through triangle t (against its normal, which faces the air),
// -1 when it leaves, 0 when it misses (Moller and Trumbore 1997).
function crossing(tris, t, o, d) {
  const a = [tris[t], tris[t + 1], tris[t + 2]],
    e1 = [tris[t + 3] - a[0], tris[t + 4] - a[1], tris[t + 5] - a[2]],
    e2 = [tris[t + 6] - a[0], tris[t + 7] - a[1], tris[t + 8] - a[2]],
    p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
    det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (det === 0) return 0;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]],
    u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  if (u < 0 || u > 1) return 0;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
    v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  if (v < 0 || u + v > 1) return 0;
  const h = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
  if (h < 0 || h > 1) return 0;
  // det = e1 . (d x e2) = -d . (e1 x e2): positive when d runs against the normal.
  return det > 0 ? 1 : -1;
}

// Segments between neighbouring samples along each box edge of the whole cave and overhang nodes, moved about 0.001
// cells into the box, so they run through the seam where two faces' caps meet: a sample's winding number about a closed
// surface is its solid flag, so each segment crosses the mesh (+1 into the solid, -1 out of it) by the end's flag minus
// the start's.
test('rays along box edges cross the surface as often as the samples at their ends say', () => {
  let segments = 0,
    changes = 0;
  const wrong = [];
  for (const { field, level, node, mask, mesh } of noiseMeshes()) {
    if (mask) continue;
    const s = 2 ** level,
      corner = node.map((c) => c * 32 * s),
      solid = (p) => (Math.max(-1, Math.min(1, field(...p.map((c, k) => corner[k] + c * s)) / s)) > 0 ? 1 : 0),
      tris = [];
    for (const part of mesh.parts.values()) place(part, [0, 0, 0], tris);
    for (let a = 0; a < 3; a++)
      for (const w1 of [0, 32])
        for (const w2 of [0, 32]) {
          const b = (a + 1) % 3,
            c = (a + 2) % 3,
            inward = [0, 0, 0];
          inward[b] = w1 ? -0.001 : 0.001;
          // Unequal, so a segment does not run in the diagonal plane of a box edge, where the mesh has edges.
          inward[c] = w2 ? -0.0013 : 0.0013;
          // Triangles within 0.01 cells of this box edge.
          const near = [];
          for (let t = 0; t < tris.length; t += 9) {
            let close = true;
            for (const [k, w] of [
              [b, w1],
              [c, w2],
            ]) {
              const lo = Math.min(tris[t + k], tris[t + 3 + k], tris[t + 6 + k]),
                hi = Math.max(tris[t + k], tris[t + 3 + k], tris[t + 6 + k]);
              if (lo > (w + 0.01) * s || hi < (w - 0.01) * s) close = false;
            }
            if (close) near.push(t);
          }
          for (let i = 0; i < 32; i++) {
            const p = [0, 0, 0],
              q = [0, 0, 0];
            p[a] = i;
            q[a] = i + 1;
            p[b] = q[b] = w1;
            p[c] = q[c] = w2;
            // The ends on box faces move 0.001 cells in too, off the caps there.
            const want = solid(q) - solid(p),
              o = p.map((x, k) => (x + inward[k]) * s),
              d = [0, 0, 0];
            if (i === 0) o[a] += 0.001 * s;
            d[a] = (i === 0 || i === 31 ? 0.999 : 1) * s;
            let got = 0;
            for (const t of near) got += crossing(tris, t, o, d);
            segments++;
            if (want) changes++;
            if (got !== want)
              wrong.push(`level ${level} node ${node} axis ${a} at ${p}: crossed ${got}, samples ${want}`);
          }
        }
  }
  console.log(`${segments} segments, ${changes} with a change`);
  assert.ok(segments > 7000 && changes > 300, `${segments} segments, ${changes} with a change`);
  assert.deepEqual(wrong, []);
});

test('the crack test sees cracks: without skirts rays pass through the seams', () => {
  const { tris } = scene(0),
    { missed } = misses(tris);
  assert.ok(missed > 10, `only ${missed} rays missed without skirts`);
  console.log(`without skirts ${missed} rays passed through`);
});

test('far geometry: every surface point of level L is within one 2^L cell of the true ground', () => {
  for (const level of [1, 2, 3]) {
    const s = 2 ** level;
    let points = 0;
    for (const [x, y, z] of [
      [0, 0, 0],
      [-1, 0, 2],
      [3, 0, -1],
    ]) {
      const mesh = meshSmoothLodNode(density, level, x, y, z, { skirt: 0 }),
        size = 32 * s;
      for (const part of mesh.parts.values())
        for (let i = 0; i < part.positions.length; i += 3) {
          const wx = x * size + part.positions[i],
            wy = y * size + part.positions[i + 1],
            wz = z * size + part.positions[i + 2];
          assert.ok(Math.abs(wy - height(wx, wz)) <= s, `level ${level} point ${wx},${wy},${wz}`);
          // Clipped to the node's box.
          for (const v of [part.positions[i], part.positions[i + 1], part.positions[i + 2]])
            assert.ok(v >= 0 && v <= size, `level ${level} position ${v} outside 0..${size}`);
          points++;
        }
    }
    assert.ok(points > 100, `level ${level}: ${points} points`);
  }
});

test('nodes chosen like VoxelLod: rings per level, nothing past maxY, level 1 empty over loaded real chunks', () => {
  const { lod, tris, levels } = scene(4);
  // Level 1 nodes are 64 blocks; the real chunks fill x, z -32..32, y -32..96: no level-1 surface inside it.
  for (const [level, from, to] of levels) {
    if (level !== 1) continue;
    for (let t = from; t < to; t += 9) {
      const cx = (tris[t] + tris[t + 3] + tris[t + 6]) / 3,
        cy = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3,
        cz = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
      const plane = [0, 1, 2].some(
        (a) => tris[t + a] === tris[t + 3 + a] && tris[t + a] === tris[t + 6 + a] && tris[t + a] % 32 === 0,
      );
      if (plane) continue; // a cap, in a node face plane
      const inside = cx > -32 + 1e-3 && cx < 32 - 1e-3 && cz > -32 + 1e-3 && cz < 32 - 1e-3 && cy > -32 && cy < 96;
      assert.ok(!inside, `level-1 triangle at ${cx},${cy},${cz} over the real terrain`);
    }
  }
  assert.equal(lod.stats.pending, 0);
  assert.equal(lod.update([0, 30, 0]), 0, 'nothing to do once current');
});

test('a real chunk loading or unloading meshes its level-1 node again', () => {
  const { terrain, lod } = scene(4);
  terrain.removeChunk(0, 0, 0);
  assert.equal(lod.update([0, 30, 0]), 1);
  terrain.addChunk(0, 0, 0, density);
  assert.equal(lod.update([0, 30, 0]), 1);
  assert.equal(lod.update([0, 30, 0]), 0);
});

test('handover: moving the eye keeps every column covered while the budget is small', () => {
  const terrain = new SmoothTerrain(),
    shown = new Map();
  const lod = SmoothLod.attach(engine, {
    terrain,
    density,
    levels: 2,
    radius: 2,
    budget: 3,
    createMesh(part, material, origin, level) {
      const key = `${level}:${origin}`,
        mesh = {
          dispose: () => {
            shown.delete(key);
          },
        };
      shown.set(key, [level, origin]);
      return mesh;
    },
  });
  // Until current; then after each move of the eye, every ground column that was covered stays covered through every
  // update until current again.
  const covered = (x, z) =>
    [...shown.values()].some(([level, o]) => {
      const size = 32 << level,
        h = height(x, z);
      return x >= o[0] && x < o[0] + size && z >= o[2] && z < o[2] + size && h >= o[1] && h < o[1] + size;
    });
  while (lod.update([0, 30, 0]));
  let updates = 0;
  for (let step = 1; step <= 12; step++) {
    const columns = [];
    // Columns within 200 blocks of the eye before and after the move (the view reaches 256 past the top nodes).
    for (let x = step * 40 - 200; x <= (step - 1) * 40 + 200; x += 20)
      for (let z = -200; z <= 200; z += 20) if (covered(x, z)) columns.push([x, z]);
    assert.ok(columns.length > 300, `${columns.length} columns`);
    do {
      for (const [x, z] of columns) assert.ok(covered(x, z), `hole at ${x},${z} on step ${step}`);
      updates++;
    } while (lod.update([step * 40, 30, 0]));
  }
  assert.ok(updates > 24, `${updates} updates`);
});

test('origin: node meshes sit at their corner minus the origin and move with it', () => {
  const terrain = new SmoothTerrain(),
    placed = [],
    origin = { origin: [1e7, 0, 0] };
  const lod = SmoothLod.attach(engine, {
    terrain,
    density,
    levels: 1,
    radius: 2,
    budget: Infinity,
    origin,
    createMesh(part, material, at) {
      const mesh = {
        position: {
          set(x, y, z) {
            mesh.at = [x, y, z];
          },
        },
        at: [...at],
        dispose() {},
      };
      placed.push(mesh);
      return mesh;
    },
  });
  engine.camera.position = [0, 30, 0];
  lod.update();
  assert.ok(placed.length > 0);
  for (const mesh of placed) assert.ok(Math.abs(mesh.at[0]) < 400, `mesh at ${mesh.at}`);
  const before = placed.map((m) => m.at[0]);
  origin.origin = [1e7 + 64, 0, 0];
  engine.camera.position = [-64, 30, 0]; // the same world eye
  assert.equal(lod.update(), 0);
  placed.forEach((m, i) => assert.equal(m.at[0], before[i] - 64));
  assert.equal(placed.length, before.length);
  engine.camera.position = [0, 0, 0];
});

test('meshSmoothChunk skirt: chunks join exactly; a face with no neighbour hangs a skirt; the default is unchanged', () => {
  const terrain = new SmoothTerrain(),
    low = (x, y, z) => 12 + 3 * Math.sin(z / 5) + 2 * Math.cos(x / 6) - y;
  terrain.addChunk(0, 0, 0, low);
  terrain.addChunk(1, 0, 0, low);
  const plain = meshSmoothChunk(terrain, '0,0,0'),
    open = meshSmoothChunk(terrain, '0,0,0', { skirt: 0 }),
    hung = meshSmoothChunk(terrain, '0,0,0', { skirt: 4 });
  assert.ok(open.triangles > 0 && hung.triangles > open.triangles);
  // Clipped: every point inside the box. Skirt points lie on a face with no neighbour (not x = 32).
  for (const part of hung.parts.values())
    for (let i = 0; i < part.positions.length; i += 3) {
      const [x, y, z] = [part.positions[i], part.positions[i + 1], part.positions[i + 2]];
      assert.ok(x >= 0 && x <= 32 && z >= 0 && z <= 32, `${x},${y},${z}`);
    }
  // The two chunks' clipped meshes share their cut points on x = 32.
  const right = meshSmoothChunk(terrain, '1,0,0', { skirt: 0 }),
    cut = (mesh, plane, shift) => {
      const set = new Set();
      for (const part of mesh.parts.values())
        for (let i = 0; i < part.positions.length; i += 3)
          if (part.positions[i] + shift === plane)
            set.add(`${part.positions[i + 1].toFixed(4)},${part.positions[i + 2].toFixed(4)}`);
      return set;
    };
  const a = cut(open, 32, 0),
    b = cut(right, 32, 32);
  assert.ok(a.size > 10);
  assert.deepEqual([...a].sort(), [...b].sort());
  // Without the option the mesh is the unclipped one.
  assert.equal(plain.triangles, meshSmoothChunk(terrain, '0,0,0', undefined).triangles);
  assert.throws(() => meshSmoothChunk(terrain, '0,0,0', { skirt: 40 }), RangeError);
  assert.throws(() => meshSmoothChunk(terrain, '0,0,0', 5), TypeError);
});

test('errors', () => {
  const terrain = new SmoothTerrain(),
    ok = { terrain, density, createMesh: () => ({ dispose() {} }) };
  assert.throws(() => SmoothLod.attach({}, ok), TypeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, terrain: {} }), TypeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, density: 1 }), TypeError);
  assert.throws(() => SmoothLod.attach(engine, { terrain, density }), TypeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, levels: 13 }), RangeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, radius: 1 }), RangeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, minY: 10, maxY: 0 }), RangeError);
  assert.throws(() => SmoothLod.attach(engine, { ...ok, skirt: -1 }), RangeError);
  assert.throws(() => meshSmoothLodNode(density, 0, 0, 0, 0), RangeError);
  assert.throws(() => meshSmoothLodNode(() => Number.NaN, 1, 0, 0, 0), RangeError);
  assert.throws(() => meshSmoothLodNode(density, 1, 0, 0, 0, { mask: 256 }), RangeError);
  const lod = SmoothLod.attach(engine, ok);
  assert.throws(() => lod.update([0, Number.NaN, 0]), TypeError);
  lod.dispose();
  assert.throws(() => lod.update([0, 0, 0]), { code: 'disposed' });
});

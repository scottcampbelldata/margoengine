import assert from 'node:assert/strict';
import test from 'node:test';
import { bevelQuads } from '../dist/bevel.js';

// The chamfer follows the cells' silhouette, so it must not depend on how the mesher merged or split the faces, and
// the result must be a closed surface: every edge used once in each direction once corners are welded.

const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
// The face's u and v axes, as the chunk mesher lays them out.
const AXES = [
  [2, 1],
  [0, 2],
  [0, 1],
];

// Every exposed face of a cell set as one quad per cell face.
const exposed = (cells) => {
  const set = new Set(cells.map((c) => c.join()));
  const out = [];
  for (const c of cells)
    for (let face = 0; face < 6; face++) {
      const n = NORMALS[face];
      if (!set.has([c[0] + n[0], c[1] + n[1], c[2] + n[2]].join()))
        out.push({ x: c[0], y: c[1], z: c[2], face, w: 1, h: 1, material: face + 1 });
    }
  return out;
};

// Merges unit faces into runs along u, broken wherever `split` says (as AO or light changes split the mesher's runs).
const merge = (faces, split) => {
  const key = (f, i) => {
    const c = [f.x, f.y, f.z];
    c[AXES[f.face >> 1][0]] += i;
    return `${f.face}|${c.join()}`;
  };
  const left = new Map(faces.map((f) => [key(f, 0), f]));
  const out = [];
  for (const f of faces) {
    if (!left.has(key(f, 0)) || left.has(key(f, -1))) continue;
    const quad = { ...f };
    left.delete(key(f, 0));
    while (left.has(key(quad, quad.w)) && !split(quad)) {
      left.delete(key(quad, quad.w));
      quad.w++;
    }
    out.push(quad);
    // Faces still left after a split start their own runs on a later pass.
  }
  for (const f of left.values()) out.push(f);
  return out;
};

const measure = (mesh) => {
  const p = mesh.positions,
    weld = (i) => [0, 1, 2].map((a) => Math.round(p[i * 3 + a] * 4096)).join(),
    edges = new Map();
  let area = 0,
    volume = 0,
    inward = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => mesh.indices[t + k]),
      [a, b, c] = v.map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]),
      u = [0, 1, 2].map((k) => b[k] - a[k]),
      w = [0, 1, 2].map((k) => c[k] - a[k]),
      n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      stored = [0, 1, 2].map((k) => mesh.normals[v[0] * 3 + k]);
    area += Math.hypot(...n) / 2;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    if (Math.hypot(...n) > 1e-9 && n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] <= 0) inward++;
    for (let k = 0; k < 3; k++) {
      const from = weld(v[k]),
        to = weld(v[(k + 1) % 3]);
      if (from !== to) edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [edge, count] of edges) {
    const [from, to] = edge.split('>');
    open += Math.abs(count - (edges.get(`${to}>${from}`) ?? 0));
  }
  return { area, volume, open, inward };
};

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const blob = (size, fill) => {
  const cells = [];
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) if (random() < fill) cells.push([x, y, z]);
  return cells;
};

test('bevel: a merged top over a side the mesher split stays closed (no crack at the split)', () => {
  // The known-bug repro, closed into a 3 x 1 x 1 bar: the top is one quad, the -z side two (split at x = 1).
  const bar = [
    { x: 0, y: 0, z: 0, face: 2, w: 3, h: 1 },
    { x: 0, y: 0, z: 0, face: 5, w: 1, h: 1 },
    { x: 1, y: 0, z: 0, face: 5, w: 2, h: 1 },
    { x: 0, y: 0, z: 0, face: 3, w: 3, h: 1 },
    { x: 0, y: 0, z: 0, face: 4, w: 3, h: 1 },
    { x: 0, y: 0, z: 0, face: 1, w: 1, h: 1 },
    { x: 2, y: 0, z: 0, face: 0, w: 1, h: 1 },
  ];
  const split = measure(bevelQuads(bar, 0.15)),
    unit = measure(bevelQuads(exposed([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), 0.15));
  assert.equal(split.open, 0, 'open edges: the chamfer cracks where the side was split');
  assert.equal(split.inward, 0);
  assert.ok(Math.abs(split.area - unit.area) < 1e-6, `area ${split.area} != ${unit.area}`);
  assert.ok(Math.abs(split.volume - unit.volume) < 1e-6, `volume ${split.volume} != ${unit.volume}`);
  // A chamfered unit cube: 12 edge prisms of b^2/2 x (1 - 2b) and 8 corners of 5b^3/6 are cut away.
  const b = 0.15,
    cube = measure(bevelQuads(exposed([[0, 0, 0]]), b));
  assert.equal(cube.open, 0);
  assert.ok(Math.abs(cube.volume - (1 - 6 * b * b * (1 - 2 * b) - (20 / 3) * b ** 3)) < 1e-5, `cube volume ${cube.volume}`);
});

test('bevel: coplanar quads meet flat, with no groove between them', () => {
  // A 2 x 1 x 1 slab whose top is one quad, or two of different materials (a chunk seam or a material change).
  const slab = exposed([[0, 0, 0], [1, 0, 0]]),
    merged = [...slab.filter((f) => f.face !== 2), { x: 0, y: 0, z: 0, face: 2, w: 2, h: 1, material: 3 }],
    one = bevelQuads(merged, 0.2),
    two = bevelQuads(slab, 0.2);
  assert.ok(Math.abs(measure(one).area - measure(two).area) < 1e-6, 'a groove adds area');
  assert.equal(measure(two).open, 0);
  // Nothing of the split top dips below the top plane away from the outline.
  for (let i = 0; i < two.positions.length; i += 3) {
    const [x, y, z] = two.positions.subarray(i, i + 3);
    if (x > 0.25 && x < 1.75 && z > 0.25 && z < 0.75) assert.equal(y, 1, `vertex (${x}, ${y}, ${z}) is in a groove`);
  }
  // A flat floor of 4 x 4 single faces is just its panels: nothing chamfers inside it.
  const floor = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) floor.push({ x, y: 0, z, face: 2, w: 1, h: 1 });
  const flat = bevelQuads(floor, 0.2);
  assert.ok(flat.positions.every((v, i) => i % 3 !== 1 || v === 1), 'a coplanar floor stays at y = 1');
});

test('bevel: any merge of the same cells gives the same closed surface', () => {
  for (let round = 0; round < 6; round++) {
    const cells = blob(5, 0.55),
      unit = exposed(cells),
      reference = measure(bevelQuads(unit, 0.15));
    assert.equal(reference.open, 0, `round ${round}: unit faces leave open edges`);
    assert.equal(reference.inward, 0, `round ${round}: a triangle winds against its normal`);
    for (const split of [() => false, () => random() < 0.4]) {
      const result = measure(bevelQuads(merge(unit, split), 0.15));
      assert.equal(result.open, 0, `round ${round}: merged faces leave open edges`);
      assert.equal(result.inward, 0);
      assert.ok(Math.abs(result.area - reference.area) < 1e-5, `round ${round}: area ${result.area} != ${reference.area}`);
      assert.ok(Math.abs(result.volume - reference.volume) < 1e-5, `round ${round}: volume differs`);
    }
  }
});

test('bevel: two chunks meshed with each other as context meet exactly at the seam', () => {
  for (let round = 0; round < 4; round++) {
    const cells = blob(4, 0.6),
      faces = exposed(cells),
      // The seam is the plane x = 2: a face belongs to its cell's chunk.
      a = faces.filter((f) => f.x < 2),
      b = faces.filter((f) => f.x >= 2),
      whole = bevelQuads(faces, 0.15),
      left = bevelQuads(a, 0.15, b),
      right = bevelQuads(b, 0.15, a),
      offset = left.positions.length / 3,
      joined = {
        positions: Float32Array.from([...left.positions, ...right.positions]),
        normals: Float32Array.from([...left.normals, ...right.normals]),
        indices: Uint32Array.from([...left.indices, ...[...right.indices].map((i) => i + offset)]),
      },
      seam = measure(joined),
      reference = measure(whole);
    assert.equal(seam.open, 0, `round ${round}: the seam cracks`);
    assert.ok(Math.abs(seam.area - reference.area) < 1e-5);
    assert.ok(Math.abs(seam.volume - reference.volume) < 1e-5);
  }
});

// The unit faces of `faces` that touch the closed box [lo, hi] (cells), as a chunk mesher's one-cell border sees them.
const touching = (faces, lo, hi) =>
  faces.filter((f) => {
    const c = [f.x, f.y, f.z],
      a = f.face >> 1,
      plane = c[a] + (f.face & 1 ? 0 : 1);
    return plane >= lo[a] && plane <= hi[a] && [0, 1, 2].every((b) => b === a || (c[b] + 1 >= lo[b] && c[b] <= hi[b]));
  });

test('bevel: chunks that merge their own faces their own way meet exactly at seams and seam corners', () => {
  for (let round = 0; round < 6; round++) {
    const cells = blob(6, 0.6),
      faces = exposed(cells),
      reference = measure(bevelQuads(faces, 0.15)),
      // Eight chunks of 3 cells meeting at (3, 3, 3); each merges its faces with its own splits, as AO and light
      // split a mesher's runs differently on either side of a seam.
      parts = [];
    for (let k = 0; k < 8; k++) {
      const lo = [k & 1, (k >> 1) & 1, (k >> 2) & 1].map((b) => b * 3),
        hi = lo.map((v) => v + 3),
        inside = (f) => [f.x, f.y, f.z].every((v, a) => v >= lo[a] && v < hi[a]),
        own = faces.filter(inside),
        context = touching(faces.filter((f) => !inside(f)), lo, hi);
      parts.push(bevelQuads(merge(own, () => random() < 0.35), 0.15, context));
    }
    let offset = 0;
    const joined = { positions: [], normals: [], indices: [] };
    for (const part of parts) {
      joined.positions.push(...part.positions);
      joined.normals.push(...part.normals);
      joined.indices.push(...[...part.indices].map((i) => i + offset));
      offset += part.positions.length / 3;
    }
    const seam = measure({
      positions: Float32Array.from(joined.positions),
      normals: Float32Array.from(joined.normals),
      indices: Uint32Array.from(joined.indices),
    });
    assert.equal(seam.open, 0, `round ${round}: a seam or seam corner cracks`);
    assert.equal(seam.inward, 0, `round ${round}: a triangle winds against its normal`);
    assert.ok(Math.abs(seam.area - reference.area) < 1e-5, `round ${round}: area ${seam.area} != ${reference.area}`);
    assert.ok(Math.abs(seam.volume - reference.volume) < 1e-5, `round ${round}: volume differs`);
  }
});

test('bevel: each triangle takes its own face material, texture and light', () => {
  const ao = [0, 1, 2, 3],
    faces = exposed([[0, 0, 0]]).map((f) => ({ ...f, ao, sky: [15, 15, 15, 15] })),
    mesh = bevelQuads(faces, 0.2);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t + k]);
    assert.equal(mesh.materials[a], mesh.materials[b]);
    assert.equal(mesh.materials[a], mesh.materials[c]);
  }
  for (let v = 0; v < mesh.materials.length; v++) {
    const ambient = mesh.lighting[v * 3];
    assert.ok(ambient >= 0 && ambient <= 3, `AO ${ambient} leaves the corner range`);
    assert.equal(mesh.lighting[v * 3 + 1], 15);
  }
  // The +y panel's corner nearest (0, 1, 0) reads the face's (0, 0) corner AO bilinearly, inset by the bevel.
  const top = [...Array(mesh.materials.length).keys()].find(
    (v) => mesh.materials[v] === 3 && Math.abs(mesh.positions[v * 3] - 0.2) < 1e-6 && Math.abs(mesh.positions[v * 3 + 2] - 0.2) < 1e-6 && mesh.normals[v * 3 + 1] === 1,
  );
  assert.ok(top !== undefined);
  assert.ok(Math.abs(mesh.lighting[top * 3] - (0 * 0.64 + 1 * 0.16 + 3 * 0.16 + 2 * 0.04)) < 1e-5);
});

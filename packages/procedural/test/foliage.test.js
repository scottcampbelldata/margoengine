import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTreeMesh, generateShrubMesh, generateGrassMesh } from '../dist/index.js';
import { coneGeometry, cylinderGeometry, icosahedronGeometry } from '@margoengine/geometry';

test('grass LODs remove blades while preserving surviving positions, normals and UVs', () => {
  const near = generateGrassMesh(3);
  for (const blades of [1, 2]) {
    const lod = generateGrassMesh(blades);
    for (const [field, stride] of [
      ['positions', 3],
      ['normals', 3],
      ['uvs', 2],
      ['tangents', 4],
    ])
      assert.deepEqual(lod[field], near[field].slice(0, blades * 4 * stride));
    assert.deepEqual(lod.indices, near.indices.slice(0, blades * 6));
  }
});

function inside(data, indices, x, y, z) {
  const leaf = data.positions,
    hits = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const bx = leaf[b] - leaf[a],
      bz = leaf[b + 2] - leaf[a + 2],
      cx = leaf[c] - leaf[a],
      cz = leaf[c + 2] - leaf[a + 2],
      det = bx * cz - bz * cx;
    if (Math.abs(det) < 1e-9) continue;
    const u = ((x - leaf[a]) * cz - (z - leaf[a + 2]) * cx) / det,
      w = (bx * (z - leaf[a + 2]) - bz * (x - leaf[a])) / det;
    if (u < -1e-6 || w < -1e-6 || u + w > 1 + 1e-6) continue;
    const t = leaf[a + 1] + u * (leaf[b + 1] - leaf[a + 1]) + w * (leaf[c + 1] - leaf[a + 1]) - y;
    if (t > 1e-6 && !hits.some((hit) => Math.abs(hit - t) < 1e-5)) hits.push(t);
  }
  return hits.length % 2 === 1;
}

function check(data) {
  assert.ok(data.positions instanceof Float32Array);
  assert.ok(data.indices instanceof Uint32Array);
  const count = data.positions.length / 3;
  for (const values of [data.positions, data.normals, data.uvs, data.tangents])
    assert.ok(values instanceof Float32Array && values.every(Number.isFinite));
  assert.equal(data.normals.length, count * 3);
  assert.equal(data.uvs.length, count * 2);
  assert.equal(data.tangents.length, count * 4);
  for (let v = 0; v < count; v++) {
    const n = data.normals.subarray(v * 3, v * 3 + 3),
      t = data.tangents.subarray(v * 4, v * 4 + 4);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5);
    assert.ok(Math.abs(Math.hypot(...t.subarray(0, 3)) - 1) < 1e-5);
    assert.ok(Math.abs(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) < 1e-5);
    assert.ok(Math.abs(t[3]) === 1);
  }
  for (let i = 0; i < data.indices.length; i += 3) {
    const [a, b, c] = data.indices.subarray(i, i + 3);
    assert.ok(Math.max(a, b, c) < count);
    const p = data.positions,
      u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]),
      v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
    assert.ok(
      Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 1e-9,
      'Nondegenerate triangle',
    );
  }
}

test('broadleaf lobes share one canopy normal volume and trunks flare at the ground', () => {
  const tree = generateTreeMesh('broadleaf'),
    p = tree.canopy.positions,
    n = tree.canopy.normals;
  for (let i = 0; i < p.length; i += 3) {
    const v = [p[i] - tree.center[0], p[i + 1] - tree.center[1], p[i + 2] - tree.center[2]],
      length = Math.hypot(...v);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(n[i + k] - v[k] / length) < 1e-6);
  }
  const trunk = tree.trunk.positions;
  let base = 0;
  for (let i = 0; i < trunk.length; i += 3)
    if (Math.abs(trunk[i + 1]) < 1e-5) base = Math.max(base, Math.hypot(trunk[i], trunk[i + 2]));
  assert.ok(Math.abs(base - 0.32 * 1.8) < 1e-5);
});

test('pine support branches stay enclosed by their foliage instead of protruding from the silhouette', () => {
  const tree = generateTreeMesh('conifer'),
    p = tree.trunk.positions,
    canopy = tree.canopy;
  const trunkVertices = cylinderGeometry(0.11, 0.32, 6.2, 8, 6).indices.length;
  const branchVertices = cylinderGeometry(0.015, 0.065, 1, 8).positions.length / 3;
  const tierIndices = coneGeometry(1, 2, 12, 2).indices.length;
  const branches = (p.length / 3 - trunkVertices) / branchVertices;
  assert.ok(branches > 0, 'Pines retain supporting timber branches');
  for (let branch = 0; branch < branches; branch++) {
    const indices = canopy.indices.subarray(branch * tierIndices, (branch + 1) * tierIndices);
    for (let v = trunkVertices + branch * branchVertices; v < trunkVertices + (branch + 1) * branchVertices; v++) {
      assert.ok(
        inside(canopy, indices, p[v * 3], p[v * 3 + 1], p[v * 3 + 2]),
        'Every branch vertex lies inside its closed foliage tier',
      );
    }
  }
});

test('canopies and hemispherical shrubs have continuous outward normals across split seams', () => {
  for (const data of [generateTreeMesh('conifer').canopy, generateTreeMesh('broadleaf').canopy, generateShrubMesh()]) {
    check(data);
    const seams = new Map();
    let smoothFaces = 0;
    for (let v = 0; v < data.positions.length / 3; v++) {
      const key = Array.from(data.positions.subarray(v * 3, v * 3 + 3))
          .map((x) => x.toFixed(5))
          .join(','),
        n = Array.from(data.normals.subarray(v * 3, v * 3 + 3));
      if (seams.has(key))
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(seams.get(key)[k] - n[k]) < 1e-4, 'Continuous seam');
      else seams.set(key, n);
    }
    for (let i = 0; i < data.indices.length; i += 3) {
      const a = data.indices[i] * 3,
        b = data.indices[i + 1] * 3;
      if (Math.hypot(...[0, 1, 2].map((k) => data.normals[a + k] - data.normals[b + k])) > 0.01) smoothFaces++;
    }
    assert.ok(smoothFaces > data.indices.length / 6, 'Foliage uses smooth normals, not face normals');
  }
  for (const kind of ['conifer', 'broadleaf']) check(generateTreeMesh(kind).trunk);
});

test('foliage generators are deterministic, compact and reject unknown tree kinds', () => {
  for (const kind of ['conifer', 'broadleaf']) assert.deepEqual(generateTreeMesh(kind), generateTreeMesh(kind));
  const shrub = generateShrubMesh();
  assert.deepEqual(shrub, generateShrubMesh());
  let radius = 0;
  for (let i = 0; i < shrub.positions.length; i += 3)
    radius = Math.max(radius, Math.hypot(shrub.positions[i], shrub.positions[i + 2]));
  assert.ok(radius < 0.9);
  assert.throws(() => generateTreeMesh('palm'), /tree kind/);
});

test('broadleaf trunk top is enclosed by at least one foliage lobe', () => {
  const tree = generateTreeMesh('broadleaf'),
    p = tree.trunk.positions;
  const vertices = cylinderGeometry(0.11, 0.32, 1, 8, 6).indices.length;
  const lobeIndices = icosahedronGeometry(1, 3).indices.length,
    lobes = [];
  for (let i = 0; i < tree.canopy.indices.length; i += lobeIndices)
    lobes.push(tree.canopy.indices.subarray(i, i + lobeIndices));
  let top = -Infinity,
    checked = 0;
  for (let v = 0; v < vertices; v++) top = Math.max(top, p[v * 3 + 1]);
  for (let v = 0; v < vertices; v++)
    if (Math.abs(p[v * 3 + 1] - top) < 1e-5) {
      assert.ok(
        lobes.some((indices) => inside(tree.canopy, indices, p[v * 3], p[v * 3 + 1], p[v * 3 + 2])),
        'Every trunk cap vertex must end inside foliage',
      );
      checked++;
    }
  assert.ok(checked >= 8, 'Checks the full cap perimeter and its center');
});

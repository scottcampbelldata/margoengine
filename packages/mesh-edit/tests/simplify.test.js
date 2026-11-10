import assert from 'node:assert/strict';
import test from 'node:test';
import { area, assertClosed, assertNoDegenerate, euler, grid, ids, volume } from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };
const cube = () => K.createPrimitiveMesh('cube', 'box');

test('locked vertices keep cluster boundaries intact and displacement bounds accumulated collapses', () => {
  const mesh = grid(8),
    lockedVertices = mesh.vertices.flatMap(([x, , z], i) => (x === 0 || x === 8 || z === 0 || z === 8 ? [i] : []));
  const result = K.simplifyMesh(mesh, { ratio: 0.1, lockedVertices, mergeCoplanar: false });
  for (const v of lockedVertices) assert.ok(result.sourceVertices.includes(v), `boundary vertex ${v} must survive`);
  const originalEdges = new Set();
  for (const face of mesh.faces)
    for (let corner = 1; corner + 1 < face.vertices.length; corner++) {
      const triangle = [face.vertices[0], face.vertices[corner], face.vertices[corner + 1]];
      for (let k = 0; k < 3; k++)
        originalEdges.add([triangle[k], triangle[(k + 1) % 3]].sort((a, b) => a - b).join(':'));
    }
  for (const face of result.mesh.faces)
    for (let k = 0; k < face.vertices.length; k++) {
      const a = result.sourceVertices[face.vertices[k]],
        b = result.sourceVertices[face.vertices[(k + 1) % face.vertices.length]];
      if (lockedVertices.includes(a) && lockedVertices.includes(b))
        assert.ok(
          originalEdges.has([a, b].sort((a, b) => a - b).join(':')),
          'no new edge can collide with an adjacent cluster',
        );
    }
  assert.ok(result.triangles.after < result.triangles.before);
  assert.ok(result.maxDeviation > 0);
  for (const p of mesh.vertices) {
    const nearest = Math.min(...result.mesh.vertices.map((q) => Math.hypot(...p.map((x, k) => x - q[k]))));
    assert.ok(nearest <= result.maxDeviation, `${nearest} <= ${result.maxDeviation}`);
  }
  assert.equal(K.simplifyMesh(mesh, { ratio: 0, lockedVertices: mesh.vertices.map((_, i) => i) }).triangles.after, 128);
  assert.throws(() => K.simplifyMesh(mesh, { lockedVertices: [-1] }), RangeError);
  assert.throws(() => K.simplifyMesh(mesh, { lockedVertices: [mesh.vertices.length] }), RangeError);
});

test('simplify a flat grid: borders stay, area and UVs stay exact, interior collapses', () => {
  const mesh = grid(8),
    result = K.simplifyMesh(mesh, { ratio: 0.05 });
  assert.equal(result.triangles.before, 128);
  assert.ok(result.triangles.after <= 7, `${result.triangles.after} triangles left`);
  assert.ok(Math.abs(area(result.mesh) - 64) < 1e-9);
  assert.equal(result.error, 0);
  for (const face of result.mesh.faces)
    face.vertices.forEach((v, i) => {
      const [x, , z] = result.mesh.vertices[v];
      assert.deepEqual(face.uv[i], [x / 8, z / 8]);
    });
  // The four grid corners survive (border corners never move).
  for (const corner of [
    [0, 0, 0],
    [8, 0, 0],
    [0, 0, 8],
    [8, 0, 8],
  ])
    assert.ok(result.mesh.vertices.some((p) => p.every((x, k) => x === corner[k])));
  K.compilePolygonMesh(result.mesh);
});

test('simplify keeps a cube whose every edge is a UV seam unchanged', () => {
  const result = K.simplifyMesh(cube(), { ratio: 0 });
  assert.equal(result.mesh.faces.length, 6);
  assert.equal(result.triangles.after, 12);
});

test('simplify a smooth solid: closed, genus 0, volume close, UVs stay in their islands', () => {
  const subdivided = K.subdivideMesh(cube(), { levels: 3, ...ids('s') }),
    smooth = subdivided.mesh,
    v0 = volume(smooth),
    result = K.simplifyMesh(smooth, { ratio: 0.5, ...ids('q') });
  // 768 triangles to 384: an inscribed polyhedron loses about 3% of the volume here.
  assert.ok(result.triangles.after <= Math.round(result.triangles.before * 0.5) + 2);
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assertNoDegenerate(result.mesh);
  assert.ok(Math.abs(volume(result.mesh) - v0) / v0 < 0.05, `${volume(result.mesh)} vs ${v0}`);
  // Every output position is an input position.
  result.sourceVertices.forEach((source, i) => assert.deepEqual(result.mesh.vertices[i], smooth.vertices[source]));
  // Each output face's UVs stay within the tile of the cube face it descends from.
  const byId = new Map(result.mesh.faces.map((face) => [face.id, face]));
  let checked = 0;
  for (const tileFace of cube().faces) {
    const [lo, hi] = [Math.min, Math.max].map((pick) => [0, 1].map((k) => pick(...tileFace.uv.map((uv) => uv[k]))));
    for (const mid of subdivided.faceMap[tileFace.id])
      for (const id of result.faceMap[mid] ?? [])
        for (const uv of byId.get(id).uv) {
          checked++;
          for (const k of [0, 1]) assert.ok(uv[k] >= lo[k] && uv[k] <= hi[k], `${tileFace.id}: ${uv}`);
        }
  }
  assert.ok(checked > 0);
});

test('LOD chain: nested levels shrink and stay closed', () => {
  const smooth = K.subdivideMesh(cube(), { levels: 3, ...ids('s') }).mesh,
    chain = K.meshLODChain(smooth, { ratios: [0.5, 0.25, 0.1], ...ids('l') });
  assert.equal(chain.length, 3);
  let previous = Infinity;
  for (const level of chain) {
    assert.ok(level.triangles.after < previous);
    previous = level.triangles.after;
    assertClosed(level.mesh);
    assert.equal(euler(level.mesh), 2);
  }
  assert.throws(() => K.meshLODChain(smooth, { ratios: [0.25, 0.5] }), RangeError);
});

test('simplify options: maxError stops early; AbortSignal and bad ratios throw', () => {
  const smooth = K.subdivideMesh(cube(), { levels: 2, ...ids('s') }).mesh,
    none = K.simplifyMesh(smooth, { ratio: 0, maxError: 0 });
  assert.ok(none.error === 0);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  assert.throws(() => K.simplifyMesh(smooth, { signal: controller.signal }), /stop/);
  assert.throws(() => K.simplifyMesh(smooth, { ratio: 2 }), RangeError);
  assert.throws(() => K.simplifyMesh(smooth, { targetTriangles: -1 }), RangeError);
});

test('README simplification example runs as written', () => {
  const smooth = K.subdivideMesh(K.createPrimitiveMesh('cube', 'box'), { levels: 3 }).mesh;
  const half = K.simplifyMesh(smooth, { ratio: 0.5 });
  const lods = K.meshLODChain(smooth, { ratios: [0.5, 0.25, 0.125] });
  assert.equal(half.triangles.before, 768);
  assert.ok(half.triangles.after <= 386);
  assert.deepEqual(
    lods.map((level) => level.triangles.after <= Math.round(768 * [0.5, 0.25, 0.125][lods.indexOf(level)]) + 2),
    [true, true, true],
  );
});

test('a collapse never makes a face of corners a hair apart: a sphere whose pole float noise left unwelded', () => {
  const segments = 16,
    positions = [],
    indices = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = (y / segments) * Math.PI;
      positions.push(Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b));
    }
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const i = y * (segments + 1) + x,
        j = i + segments + 1;
      indices.push(i, i + 1, j, i + 1, j + 1, j);
    }
  const chain = K.meshLODChain(K.polygonMeshFromTriangles({ positions, indices }).mesh, { ratios: [0.5, 0.25] });
  assert.ok(chain[1].triangles.after < chain[0].triangles.after);
  assert.ok(chain[0].triangles.after < indices.length / 3);
});

test('simplify error and maxError are squared distances: scaling the model by 4 scales them by 16', () => {
  const base = grid(8),
    faces = base.faces.flatMap((f) =>
      [1, 2].map((c) => ({
        id: `${f.id}:${c}`,
        vertices: [f.vertices[0], f.vertices[c], f.vertices[c + 1]],
        uv: [f.uv[0], f.uv[c], f.uv[c + 1]],
      })),
    ),
    bumpy = (s) => ({
      vertices: base.vertices.map(([x, , z]) => [x * s, Math.sin(x) * Math.cos(z) * 0.3 * s, z * s]),
      faces,
    });
  const one = K.simplifyMesh(bumpy(1), { ratio: 0.3, mergeCoplanar: false }),
    four = K.simplifyMesh(bumpy(4), { ratio: 0.3, mergeCoplanar: false });
  assert.equal(four.triangles.after, one.triangles.after);
  assert.ok(one.error > 0);
  assert.equal(four.error, 16 * one.error, 'the error is a squared distance, not area times squared distance');
  // A maxError picked as a squared distance means the same at both scales.
  const limit = one.error / 2,
    small = K.simplifyMesh(bumpy(1), { ratio: 0, maxError: limit, mergeCoplanar: false }),
    large = K.simplifyMesh(bumpy(4), { ratio: 0, maxError: 16 * limit, mergeCoplanar: false });
  assert.equal(large.triangles.after, small.triangles.after);
});

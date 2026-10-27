import assert from 'node:assert/strict';
import test from 'node:test';
import { joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { area, assertClosed, euler, grid, halfEdges, ids, random, volume } from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };

/** Surface of a set of unit voxels as shared-vertex unit quads, outward, UVs projected per axis (continuous). */
function voxels(cells, size = 4) {
  const filled = new Set(cells.map((c) => c.join(','))),
    vertices = [],
    index = new Map(),
    faces = [];
  const vertex = (p) => {
    const key = p.join(',');
    if (!index.has(key)) {
      index.set(key, vertices.length);
      vertices.push(p);
    }
    return index.get(key);
  };
  // For each axis and sign: the four corners of the face, counterclockwise seen from outside.
  const sides = [
    [
      0,
      1,
      [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    ],
    [
      0,
      -1,
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
      ],
    ],
    [
      1,
      1,
      [
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
      ],
    ],
    [
      1,
      -1,
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    ],
    [
      2,
      1,
      [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
    ],
    [
      2,
      -1,
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
    ],
  ];
  for (const cell of cells)
    for (const [axis, sign, corners] of sides) {
      const n = [...cell];
      n[axis] += sign;
      if (filled.has(n.join(','))) continue;
      const points = corners.map((c) => c.map((x, k) => x + cell[k])),
        [a, b] = [0, 1, 2].filter((k) => k !== axis);
      faces.push({
        id: `v${faces.length}`,
        vertices: points.map(vertex),
        uv: points.map((p) => [p[a] / size, p[b] / size]),
      });
    }
  return { vertices, faces };
}

/** Every directed half-edge is matched by its reverse as often (closed, even with nonmanifold edges). */
function assertBalanced(mesh) {
  const { half } = halfEdges(mesh);
  for (const [key, count] of half) {
    const [a, b] = key.split('>');
    assert.equal(half.get(`${b}>${a}`), count, `half-edge ${key} unmatched`);
  }
}

/** No used vertex lies inside another face's edge (no T-junctions). */
function assertNoTJunctions(mesh) {
  const used = [...new Set(mesh.faces.flatMap((face) => face.vertices))];
  for (const face of mesh.faces)
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        p = mesh.vertices[a],
        q = mesh.vertices[b],
        d = q.map((x, k) => x - p[k]),
        length = Math.hypot(...d);
      for (const v of used) {
        if (v === a || v === b) continue;
        const e = mesh.vertices[v].map((x, k) => x - p[k]),
          t = (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) / length,
          off = Math.hypot(e[1] * d[2] - e[2] * d[1], e[2] * d[0] - e[0] * d[2], e[0] * d[1] - e[1] * d[0]) / length;
        assert.ok(!(t > 1e-9 && t < length - 1e-9 && off < 1e-9), `vertex ${v} inside edge ${a}-${b} of ${face.id}`);
      }
    });
}

test('flat-tile merge: a grid with one UV map becomes one quad, UVs exact', () => {
  const mesh = grid(8),
    result = K.mergeFlatFaces(mesh);
  assert.equal(result.mesh.faces.length, 1);
  assert.equal(result.mesh.faces[0].vertices.length, 4);
  assert.equal(result.mesh.faces[0].id, 'g0-0');
  assert.equal(result.merged, 63);
  assert.equal(result.mesh.vertices.length, 4);
  assert.ok(Math.abs(area(result.mesh) - 64) < 1e-9);
  result.mesh.faces[0].vertices.forEach((v, c) => {
    const [x, , z] = result.mesh.vertices[v];
    assert.deepEqual(result.mesh.faces[0].uv[c], [x / 8, z / 8]);
  });
  for (const face of mesh.faces) assert.deepEqual(result.faceMap[face.id], ['g0-0']);
});

test('flat-tile merge: atlas tiles do not merge unless uv is ignored; L shapes stay convex', () => {
  const tiles = grid(3);
  tiles.faces = tiles.faces.map((face, i) => ({
    ...face,
    uv: [
      [0, 0.1],
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ].map(([u, v]) => [u + (i % 5) * 0.12, v]),
  }));
  assert.equal(K.mergeFlatFaces(tiles).mesh.faces.length, 9);
  assert.equal(K.mergeFlatFaces(tiles, { uv: 'ignore' }).mesh.faces.length, 1);
  // An L of three tiles: one rectangle and one square, the shared corner kept (no T-junction).
  const l = grid(2);
  l.faces = l.faces.filter((face) => face.id !== 'g1-1');
  const merged = K.mergeFlatFaces(l).mesh;
  assert.equal(merged.faces.length, 2);
  assert.ok(Math.abs(area(merged) - 3) < 1e-9);
  assertNoTJunctions(merged);
  // Only listed faces merge.
  assert.equal(K.mergeFlatFaces(grid(2), { faces: ['g0-0', 'g1-0'] }).mesh.faces.length, 3);
  assert.throws(() => K.mergeFlatFaces(grid(2), { faces: ['nope'] }), TypeError);
  assert.throws(() => K.mergeFlatFaces(grid(2), { tolerance: -1 }), RangeError);
});

test('flat-tile merge of a voxel box: six faces, closed, genus 0, same volume', () => {
  const cells = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 4; z++) cells.push([x, y, z]);
  const box = voxels(cells),
    result = K.mergeFlatFaces(box);
  assert.equal(result.mesh.faces.length, 6);
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.ok(Math.abs(volume(result.mesh) - 24) < 1e-9);
  assert.equal(result.mesh.vertices.length, 8);
});

test('flat-tile merge fuzz: random voxel shapes keep closure, Euler, volume, area and have no T-junctions', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = random(seed),
      cells = [];
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) if (rand() < 0.55) cells.push([x, y, z]);
    if (!cells.length) continue;
    const mesh = voxels(cells),
      result = K.mergeFlatFaces(mesh, { uv: seed % 2 ? 'match' : 'ignore' });
    assert.ok(result.mesh.faces.length <= mesh.faces.length);
    assertBalanced(result.mesh);
    assert.equal(euler(result.mesh), euler(mesh), `seed ${seed}`);
    assert.ok(Math.abs(volume(result.mesh) - cells.length) < 1e-9);
    assert.ok(Math.abs(area(result.mesh) - area(mesh)) < 1e-9);
    assertNoTJunctions(result.mesh);
    // UVs still follow the per-axis projection.
    if (seed % 2)
      for (const face of result.mesh.faces) {
        const normal = K.compilePolygonMesh({ vertices: result.mesh.vertices, faces: [face] }).normals.slice(0, 3),
          axis = normal.findIndex((x) => Math.abs(x) > 0.5),
          [a, b] = [0, 1, 2].filter((k) => k !== axis);
        face.vertices.forEach((v, c) =>
          assert.deepEqual(face.uv[c], [result.mesh.vertices[v][a] / 4, result.mesh.vertices[v][b] / 4]),
        );
      }
  }
});

/** A glTF-style box: 24 vertices (split per side), 12 triangles, a full UV square per side. */
function gltfBox() {
  const positions = [],
    uvs = [],
    indices = [];
  const sides = [
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  ];
  sides.forEach((corners, s) => {
    const base = positions.length / 3;
    corners.forEach((p, i) => {
      positions.push(...p);
      uvs.push(
        ...[
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ][i],
      );
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    void s;
  });
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

test('import glTF triangles: seams rejoin, triangles merge back into six quads with their UVs', () => {
  const result = K.polygonMeshFromTriangles(gltfBox());
  assert.equal(result.unwrapped, false);
  assert.equal(result.mesh.vertices.length, 8);
  assert.equal(result.mesh.faces.length, 6);
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-9);
  for (const face of result.mesh.faces) {
    assert.equal(face.vertices.length, 4);
    assert.equal(result.sourceFaces[face.id].length, 2);
    assert.deepEqual([...face.uv].map(String).sort(), ['0,0', '0,1', '1,0', '1,1']);
  }
  // Without merging: twelve triangles, still closed.
  const triangles = K.polygonMeshFromTriangles(gltfBox(), { mergeFlat: false });
  assert.equal(triangles.mesh.faces.length, 12);
  assertClosed(triangles.mesh);
  assert.deepEqual(triangles.mesh.faces.map((face) => face.id).slice(0, 3), ['f0', 'f1', 'f2']);
});

test('import OBJ polygons: fans rebuild n-gons, concave ones split, degenerate ones drop', () => {
  // A unit quad and an L hexagon side by side (OBJ order: corners fanned from c0), plus a degenerate triangle.
  const points = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [3, 0, 0],
      [3, 1, 0],
      [2, 1, 0],
      [2, 2, 0],
      [1, 2, 0],
    ],
    polygons = [
      [0, 1, 2, 3],
      [1, 4, 5, 6, 7, 8, 2],
      [0, 0, 1],
    ],
    positions = [],
    uvs = [],
    positionIndices = [],
    indices = [],
    faceSizes = [];
  for (const polygon of polygons) {
    const base = positionIndices.length;
    for (const p of polygon) {
      positions.push(...points[p]);
      uvs.push(points[p][0] / 3, points[p][1] / 2);
      positionIndices.push(p);
    }
    for (let k = 1; k < polygon.length - 1; k++) indices.push(base, base + k, base + k + 1);
    faceSizes.push(polygon.length);
  }
  const result = K.polygonMeshFromTriangles(
    { positions, uvs, indices, faceSizes, positionIndices },
    { mergeFlat: false },
  );
  assert.equal(result.mesh.vertices.length, 9);
  assert.equal(result.mesh.faces[0].id, 'f0');
  assert.deepEqual(result.mesh.faces[0].vertices.length, 4);
  assert.ok(result.mesh.faces.filter((face) => result.sourceFaces[face.id][0] === 1).length >= 2);
  assert.ok(Math.abs(area(result.mesh) - 4) < 1e-9);
  assert.ok(result.diagnostics.some((line) => /1 degenerate/.test(line)));
  assert.ok(result.diagnostics.some((line) => /1 concave/.test(line)));
  assert.ok(!Object.values(result.sourceFaces).some((list) => list.includes(2)));
});

test('import UVs: missing or out-of-range UVs unwrap; keep rejects them; abort and bad arrays throw', () => {
  const box = gltfBox(),
    bare = K.polygonMeshFromTriangles({ positions: box.positions, indices: box.indices });
  assert.equal(bare.unwrapped, true);
  assert.equal(bare.mesh.faces.length, 6);
  assertClosed(bare.mesh);
  const tiled = { ...box, uvs: box.uvs.map((x) => x * 4) };
  assert.equal(K.polygonMeshFromTriangles(tiled).unwrapped, true);
  assert.throws(() => K.polygonMeshFromTriangles(tiled, { uv: 'keep' }), RangeError);
  assert.equal(K.polygonMeshFromTriangles(box, { uv: 'unwrap' }).unwrapped, true);
  assert.throws(() => K.polygonMeshFromTriangles({ positions: [0, 0] }), TypeError);
  assert.throws(() => K.polygonMeshFromTriangles({ positions: box.positions, indices: [0, 1, 99] }), TypeError);
  assert.throws(() => K.polygonMeshFromTriangles({ ...box, faceSizes: [4] }), TypeError);
  assert.throws(() => K.polygonMeshFromTriangles(box, { weld: -1 }), RangeError);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  assert.throws(() => K.polygonMeshFromTriangles(box, { signal: controller.signal }), /stop/);
  // A tolerance weld joins nearly equal positions.
  const shaken = { ...box, positions: box.positions.map((x, i) => x + (i % 7 === 0 ? 1e-6 : 0)) };
  assert.equal(K.polygonMeshFromTriangles(shaken, { weld: 1e-4 }).mesh.vertices.length, 8);
  void ids;
});

test('README import example runs as written (GLB through exporters)', () => {
  // Build the GLB the example reads.
  const box = gltfBox(),
    bin = new Uint8Array(box.positions.byteLength + box.uvs.byteLength + box.indices.byteLength);
  bin.set(new Uint8Array(box.positions.buffer), 0);
  bin.set(new Uint8Array(box.uvs.buffer), box.positions.byteLength);
  bin.set(new Uint8Array(box.indices.buffer), box.positions.byteLength + box.uvs.byteLength);
  const bytes = joinGLB({
    json: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: box.positions.byteLength },
        { buffer: 0, byteOffset: box.positions.byteLength, byteLength: box.uvs.byteLength },
        { buffer: 0, byteOffset: box.positions.byteLength + box.uvs.byteLength, byteLength: box.indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 24, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
    },
    bin,
  });
  const parts = splitGLB(bytes);
  const gltf = parts.json;
  const primitive = gltf.meshes[0].primitives[0];
  const { mesh } = K.polygonMeshFromTriangles({
    positions: readAccessor(parts, primitive.attributes.POSITION).values,
    uvs: readAccessor(parts, primitive.attributes.TEXCOORD_0).values,
    indices: readAccessor(parts, primitive.indices).values,
  });
  const tiles = K.mergeFlatFaces(mesh);
  assert.equal(mesh.faces.length, 6);
  assert.equal(tiles.merged, 0);
});

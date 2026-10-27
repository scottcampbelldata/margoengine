import assert from 'node:assert/strict';
import test from 'node:test';
import {
  area,
  assertClosed,
  assertNoDegenerate,
  edgeId,
  euler,
  grid,
  ids,
  random,
  volume,
} from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };
const cube = () => K.createPrimitiveMesh('cube', 'box');
const close = (a, b, eps = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${a} != ${b}`));
const cubeEdges = () => K.polygonMeshEdges(cube()).map((edge) => edge.id);

/** A cube whose six faces each own four vertices (24 vertices, positions duplicated). */
function splitCube() {
  const base = cube(),
    vertices = [],
    faces = base.faces.map((face) => ({
      id: face.id,
      uv: face.uv.map((uv) => [...uv]),
      vertices: face.vertices.map((v) => vertices.push([...base.vertices[v]]) - 1),
    }));
  return { vertices, faces };
}

test('weld merges duplicated cube vertices into a closed cube and keeps every corner UV', () => {
  const split = splitCube(),
    result = K.weldMeshVertices(split);
  assert.equal(result.welded, 16);
  assert.equal(result.mesh.vertices.length, 8);
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
  result.mesh.faces.forEach((face, i) => assert.deepEqual(face.uv, split.faces[i].uv));
  assert.equal(result.removedVertices.length, 16);
  for (const [old, [now]] of result.vertexMap.entries()) close(result.mesh.vertices[now], split.vertices[old], 0);
});

test('weld does not chain: points closer than the distance to a neighbor but not to the first stay apart', () => {
  const mesh = {
      vertices: [
        [0, 0, 0],
        [0.6, 0, 0],
        [1.2, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        {
          id: 'f',
          vertices: [0, 1, 2, 3],
          uv: [
            [0, 0],
            [0.5, 0],
            [1, 0],
            [0, 1],
          ],
        },
      ],
    },
    result = K.weldMeshVertices(mesh, { distance: 1 });
  // 1 merges into 0 (0.6 away); 2 is 1.2 from 0, so it stays, although it is 0.6 from 1.
  assert.equal(result.welded, 2); // 3 is exactly 1 from 0: inclusive
  assert.equal(result.mesh.faces.length, 0);
  assert.match(result.diagnostics[0], /collapsed/);
});

test('weld collapses a short edge: the quad becomes a triangle, and an exact weld leaves distinct points alone', () => {
  const mesh = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0.00005, 1],
        [0, 0, 1],
        [1, 0, 1],
      ],
      faces: [
        {
          id: 'q',
          vertices: [0, 3, 4, 1],
          uv: [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
          ],
        },
      ],
    },
    // Vertex 2 is unused, so it is not a default candidate; select it explicitly.
    result = K.weldMeshVertices(mesh, { vertices: [2, 4] });
  assert.equal(result.welded, 1);
  // The kept vertex sits 0.00005 off the face's plane, so the quad is split into two planar triangles.
  assert.deepEqual(
    result.mesh.faces.map((face) => face.vertices.length),
    [3, 3],
  );
  assert.equal(result.mesh.faces[0].id, 'q');
  const short = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1.00001, 0, 0],
        [0, 0, 1],
      ],
      faces: [
        {
          id: 'q',
          vertices: [0, 3, 2, 1],
          uv: [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
          ],
        },
      ],
    },
    welded = K.weldMeshVertices(short);
  assert.equal(welded.mesh.faces.length, 1);
  assert.equal(welded.mesh.faces[0].vertices.length, 3);
  assert.deepEqual(welded.mesh.faces[0].uv, [
    [0, 0],
    [0, 1],
    [1, 1],
  ]);
  assert.equal(K.weldMeshVertices(short, { distance: 0 }).welded, 0);
  assert.throws(() => K.weldMeshVertices(short, { distance: -1 }), RangeError);
  assert.throws(() => K.weldMeshVertices(short, { vertices: [9] }), RangeError);
});

test('weld fuzz: jittered split cubes always weld back to a closed genus-0 cube', () => {
  const rand = random(7);
  for (let trial = 0; trial < 40; trial++) {
    const split = splitCube();
    // Jitter within each face's plane (the face's constant axis stays put), so the input faces stay planar.
    for (const face of split.faces) {
      const points = face.vertices.map((v) => split.vertices[v]),
        flat = [0, 1, 2].find((axis) => points.every((p) => p[axis] === points[0][axis]));
      for (const p of points) for (let a = 0; a < 3; a++) if (a !== flat) p[a] += (rand() - 0.5) * 1e-6;
    }
    const result = K.weldMeshVertices(split, { distance: 1e-4 });
    assert.equal(result.mesh.vertices.length, 8);
    assertClosed(result.mesh, `trial ${trial}`);
    assert.equal(euler(result.mesh), 2);
    assertNoDegenerate(result.mesh);
  }
});

test('dissolve vertex: the centre of a 2x2 grid merges four quads into one face', () => {
  const mesh = grid(2),
    result = K.dissolveMeshComponents(mesh, { mode: 'vertex', vertices: [4] });
  assert.equal(result.mesh.faces.length, 1);
  assert.equal(result.mesh.faces[0].id, 'g0-0');
  assert.equal(result.mesh.vertices.length, 8);
  assert.deepEqual(result.removedVertices, [4]);
  assert.deepEqual(result.faceMap['g1-1'], ['g0-0']);
  assert.ok(Math.abs(area(result.mesh) - 4) < 1e-12);
  // Each corner keeps the UV it had in its source face.
  const face = result.mesh.faces[0];
  face.vertices.forEach((v, i) => close(face.uv[i], [result.mesh.vertices[v][0] / 2, result.mesh.vertices[v][2] / 2]));
});

test('dissolve faces: an L of three quads becomes convex pieces covering the same area', () => {
  const mesh = grid(2),
    result = K.dissolveMeshComponents(mesh, { mode: 'face', faces: ['g0-0', 'g1-0', 'g0-1'] }, ids());
  assert.ok(Math.abs(area(result.mesh) - 4) < 1e-12);
  assert.ok(result.mesh.faces.length >= 3);
  assertNoDegenerate(result.mesh);
  assert.deepEqual(result.faceMap['g1-0'], result.faceMap['g0-0']);
});

test('dissolve edges on a closed mesh keeps it closed with the same Euler characteristic', () => {
  const edges = cubeEdges();
  for (const edge of edges) {
    // Cube faces meet at folds, so nothing merges: the shape is kept and the fold is reported.
    const result = K.dissolveMeshComponents(cube(), { mode: 'edge', edges: [edge] }, ids());
    assert.equal(result.mesh.faces.length, 6);
    assert.match(result.diagnostics.join(' '), /not coplanar/);
    assertClosed(result.mesh, edge);
    assert.equal(euler(result.mesh), 2);
    assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
  }
  // A coplanar split face dissolves back into one quad.
  const cut = K.cutMeshFace(cube(), 'box-face-1', ids('c'));
  const shared = K.polygonMeshEdges(cut.mesh).find(
    (edge) =>
      edge.incidences.length === 2 &&
      edge.incidences.every((i) => i.faceId === 'box-face-1' || i.faceId.startsWith('c-')),
  );
  const merged = K.dissolveMeshComponents(cut.mesh, { mode: 'edge', edges: [shared.id] });
  assert.equal(merged.mesh.faces.length, 6);
  assertClosed(merged.mesh);
});

test('dissolve rejects holes, boundary edges and unknown IDs', () => {
  const mesh = grid(3),
    ring = mesh.faces.map((face) => face.id).filter((id) => id !== 'g1-1');
  assert.throws(
    () => K.dissolveMeshComponents(mesh, { mode: 'face', faces: ring }),
    (error) => error.name === 'MargoError' && error.code === 'unsupported',
  );
  assert.throws(() => K.dissolveMeshComponents(mesh, { mode: 'edge', edges: ['0:1'] }), TypeError);
  assert.throws(() => K.dissolveMeshComponents(mesh, { mode: 'edge', edges: ['nope'] }), TypeError);
  assert.throws(() => K.dissolveMeshComponents(mesh, { mode: 'vertex', vertices: [1] }), TypeError);
});

test('dissolve a two-edge vertex removes it from its face', () => {
  const mesh = {
      vertices: [
        [0, 0, 0],
        [0.5, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
      faces: [
        {
          id: 'p',
          vertices: [0, 4, 3, 2, 1],
          uv: [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0.5, 0],
          ],
        },
      ],
    },
    result = K.dissolveMeshComponents(mesh, { mode: 'vertex', vertices: [1] });
  assert.deepEqual(result.mesh.faces[0].vertices, [0, 3, 2, 1]);
  assert.deepEqual(result.removedVertices, [1]);
  assert.deepEqual(result.edgeMap['0:1'], ['0:1']);
});

test('dissolve fuzz: random edge sets on a subdivided closed box stay closed, genus 0 and volume-exact', () => {
  const rand = random(11);
  let box = cube();
  for (const [face, corner] of [
    ['box-face-0', 0],
    ['box-face-0', 1],
    ['box-face-2', 1],
  ])
    box = K.cutMeshQuadRing(
      box,
      { faceId: box.faces.find((f) => f.id.startsWith(face)).id, corner },
      0.5,
      ids(`r${face}${corner}`),
    ).mesh;
  const edges = K.polygonMeshEdges(box).map((edge) => edge.id);
  let accepted = 0;
  for (let trial = 0; trial < 60; trial++) {
    const pick = edges.filter(() => rand() < 0.15);
    if (!pick.length) continue;
    let result;
    try {
      result = K.dissolveMeshComponents(box, { mode: 'edge', edges: pick }, ids(`t${trial}`));
    } catch (error) {
      assert.ok(error.name === 'MargoError' && error.code === 'unsupported', String(error));
      continue;
    }
    accepted++;
    assertClosed(result.mesh, `trial ${trial}`);
    assert.equal(euler(result.mesh), 2);
    assertNoDegenerate(result.mesh);
    assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-9);
  }
  assert.ok(accepted > 20, `only ${accepted} trials were accepted`);
});

test('edge slide moves a loop along its rails and carries UVs with it', () => {
  const strip = grid(3, 1),
    // The edge between g0-0 and g1-0 runs from (1,0,0) to (1,0,1): vertices 1 and 5.
    edge = edgeId(1, 5),
    right = K.slideMeshEdges(strip, [edge], 0.5),
    left = K.slideMeshEdges(strip, [edge], -0.5);
  const xs = (result) => [result.mesh.vertices[1][0], result.mesh.vertices[5][0]];
  const moved = [xs(right), xs(left)].map(([a, b]) => (assert.equal(a, b), a)).sort();
  assert.deepEqual(moved, [0.5, 1.5]);
  for (const result of [right, left]) {
    assertNoDegenerate(result.mesh);
    for (const face of result.mesh.faces)
      face.vertices.forEach((v, i) =>
        close(face.uv[i], [result.mesh.vertices[v][0] / 3, result.mesh.vertices[v][2]], 1e-12),
      );
  }
  assert.throws(() => K.slideMeshEdges(strip, [edge], 1), RangeError);
  assert.throws(() => K.slideMeshEdges(strip, [edgeId(0, 1)], 0.5), TypeError);
});

test('loop cut and slide: a cut cube ring slides both ways and stays a closed unit cube', () => {
  const cut = K.cutMeshQuadRing(cube(), { faceId: 'box-face-0', corner: 0 }, 0.5, ids()),
    ring = cut.ring.edges;
  for (const factor of [-0.75, -0.3, 0.3, 0.75]) {
    const result = K.slideMeshEdges(cut.mesh, ring, factor);
    assertClosed(result.mesh, `factor ${factor}`);
    assert.equal(euler(result.mesh), 2);
    assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
    const moved = cut.ring.vertices.map((v) => result.mesh.vertices[v]),
      before = cut.ring.vertices.map((v) => cut.mesh.vertices[v]);
    const shift = moved.map((p, i) => Math.hypot(...p.map((value, axis) => value - before[i][axis])));
    for (const value of shift) assert.ok(Math.abs(value - Math.abs(factor) * 0.5) < 1e-12);
  }
});

test('bridge joins two open cylinders, rotated against each other, into one closed solid', () => {
  const base = K.createPrimitiveMesh('cylinder', 'a'),
    lower = K.deleteMeshComponents(base, { mode: 'face', faces: ['a-face-1'] }).mesh,
    upper = K.deleteMeshComponents(base, { mode: 'face', faces: ['a-face-0'] }).mesh,
    offset = lower.vertices.length,
    turn = 0.3,
    combined = {
      vertices: [
        ...lower.vertices,
        ...upper.vertices.map(([x, y, z]) => [
          x * Math.cos(turn) - z * Math.sin(turn),
          y + 2,
          x * Math.sin(turn) + z * Math.cos(turn),
        ]),
      ],
      faces: [
        ...lower.faces,
        ...upper.faces.map((face) => ({ ...face, id: `u${face.id}`, vertices: face.vertices.map((v) => v + offset) })),
      ],
    },
    boundary = K.polygonMeshEdges(combined).filter((edge) => edge.incidences.length === 1),
    loopAt = (y) =>
      boundary
        .filter((edge) => edge.vertices.every((v) => Math.abs(combined.vertices[v][1] - y) < 1e-12))
        .map((e) => e.id),
    result = K.bridgeMeshEdgeLoops(combined, loopAt(0.5), loopAt(1.5), ids());
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.ok(volume(result.mesh) > 0);
  // Rotation pairing: the eight paired band edges join nearest vertices (0.15 apart after the 0.3 radian twist);
  // the twisted quads are nonplanar, so each also gets a diagonal (0.24).
  const band = K.polygonMeshEdges(result.mesh)
    .map((edge) => edge.vertices.map((v) => result.mesh.vertices[v]))
    .filter(([a, b]) => Math.abs(a[1] - 0.5) < 1e-12 && Math.abs(b[1] - 1.5) < 1e-12)
    .map(([a, b]) => Math.hypot(a[0] - b[0], a[2] - b[2]));
  assert.equal(band.filter((d) => d < 0.2).length, 8);
  assert.equal(band.length, 16);
});

test('bridge closes two facing sheets into a box, with and without extra segments', () => {
  const top = grid(1),
    bottom = grid(1),
    sheets = {
      vertices: [...bottom.vertices, ...top.vertices.map(([x, , z]) => [x, 1, z])],
      faces: [
        ...bottom.faces.map((face) => ({
          ...face,
          id: 'b',
          vertices: [...face.vertices].reverse(),
          uv: [...face.uv].reverse(),
        })),
        ...top.faces.map((face) => ({ ...face, id: 't', vertices: face.vertices.map((v) => v + 4) })),
      ],
    },
    loop = (offset) => [
      edgeId(offset, offset + 1),
      edgeId(offset + 1, offset + 3),
      edgeId(offset + 3, offset + 2),
      edgeId(offset + 2, offset),
    ];
  for (const segments of [1, 3]) {
    const box = K.bridgeMeshEdgeLoops(sheets, loop(0), loop(4), { ...ids(), segments });
    assertClosed(box.mesh, `segments ${segments}`);
    assert.equal(euler(box.mesh), 2);
    assert.ok(Math.abs(Math.abs(volume(box.mesh)) - 1) < 1e-12);
    assert.equal(box.mesh.faces.length, 2 + 4 * segments);
    assert.equal(box.createdVertices.length, 4 * (segments - 1));
  }
  assert.throws(() => K.bridgeMeshEdgeLoops(sheets, loop(0), loop(0).slice(0, 3)), TypeError);
  assert.throws(() => K.bridgeMeshEdgeLoops(sheets, loop(0), loop(4), { segments: 0 }), RangeError);
});

test('edge bevel: one cube edge gives a strip and two pentagons', () => {
  const result = K.bevelMeshEdges(cube(), [edgeId(0, 1)], 0.1, ids());
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.equal(result.mesh.faces.length, 7);
  assert.equal(result.mesh.vertices.length, 10);
  const sizes = result.mesh.faces.map((face) => face.vertices.length).sort();
  assert.deepEqual(sizes, [4, 4, 4, 4, 4, 5, 5]);
  // A 45-degree chamfer of legs 0.1 removes a prism of 0.1 * 0.1 / 2 * 1.
  assert.ok(Math.abs(volume(result.mesh) - (1 - 0.005)) < 1e-12);
  assert.equal(result.edgeMap[edgeId(0, 1)].length, 2);
});

test('edge bevel: every cube edge gives 26 faces and 24 vertices', () => {
  const result = K.bevelMeshEdges(cube(), cubeEdges(), 0.1, ids());
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.equal(result.mesh.faces.length, 26);
  assert.equal(result.mesh.vertices.length, 24);
  // Convex result, so volume = sum of face area * plane distance / 3 (w = 0.1, half size h = 0.5):
  // squares 6 (1-2w)^2 h / 3, strips 12 (1-2w) w (1-w) / 3, corner triangles 8 w^2 (3h - 2w) / 6.
  const w = 0.1,
    expected = 2 * (1 - 2 * w) ** 2 * 0.5 + 4 * (1 - 2 * w) * w * (1 - w) + (8 / 6) * w * w * (1.5 - 2 * w);
  assert.ok(Math.abs(volume(result.mesh) - expected) < 1e-12, `${volume(result.mesh)} vs ${expected}`);
});

test('edge bevel fuzz: random edge subsets and widths on a cube and a cut cube stay closed and shrink', () => {
  const rand = random(3),
    cut = K.cutMeshQuadRing(cube(), { faceId: 'box-face-0', corner: 0 }, 0.5, ids('c')).mesh;
  for (const [name, source] of [
    ['cube', cube()],
    ['cut', cut],
  ]) {
    const edges = K.polygonMeshEdges(source).map((edge) => edge.id);
    for (let trial = 0; trial < 60; trial++) {
      const pick = edges.filter(() => rand() < 0.35);
      if (!pick.length) continue;
      const width = 0.02 + rand() * 0.15,
        result = K.bevelMeshEdges(source, pick, width, ids(`t${trial}`));
      assertClosed(result.mesh, `${name} ${trial}`);
      assert.equal(euler(result.mesh), 2);
      assertNoDegenerate(result.mesh);
      const v = volume(result.mesh);
      assert.ok(v < 1 && v > 0.8, `${name} ${trial}: volume ${v}`);
    }
  }
});

test('edge bevel rejects widths past an edge, boundary edges and bad widths', () => {
  assert.throws(() => K.bevelMeshEdges(cube(), [edgeId(0, 1)], 2), RangeError);
  assert.throws(() => K.bevelMeshEdges(cube(), [edgeId(0, 1)], 0), RangeError);
  assert.throws(() => K.bevelMeshEdges(grid(2), [edgeId(1, 4)], 0.1), TypeError);
  assert.throws(() => K.bevelMeshEdges(cube(), ['0:6'], 0.1), TypeError);
});

test('edge bevel of a chain ending where its side faces are coplanar runs the strip end through the vertex', () => {
  // Ring edge on the cut cube's flat top face: each end vertex joins four faces, two of them coplanar.
  const cut = K.cutMeshQuadRing(cube(), { faceId: 'box-face-0', corner: 0 }, 0.5, ids('c')).mesh,
    ring = K.polygonMeshEdges(cut).find((edge) =>
      edge.vertices.every((v) => cut.vertices[v][0] === 0 && cut.vertices[v][1] === 0.5),
    ),
    result = K.bevelMeshEdges(cut, [ring.id], 0.1, ids());
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assertNoDegenerate(result.mesh);
  // The bevel only cuts the flat face, so no volume is lost; the strip is a hexagon through both end vertices.
  assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
  assert.ok(result.mesh.faces.some((face) => face.vertices.length === 6));
});

test('README modeling example runs as written', () => {
  const cube = K.createPrimitiveMesh('cube', 'box');
  const beveled = K.bevelMeshEdges(cube, ['0:1'], 0.1);
  const cut = K.cutMeshQuadRing(cube, { faceId: 'box-face-0', corner: 0 }, 0.5);
  const slid = K.slideMeshEdges(cut.mesh, cut.ring.edges, 0.25);
  const dissolved = K.dissolveMeshComponents(cut.mesh, { mode: 'edge', edges: cut.ring.edges });
  const welded = K.weldMeshVertices(dissolved.mesh, { distance: 0.0001 });
  const sheet = K.createPrimitiveMesh('plane', 'sheet');
  const sheets = {
    vertices: [...sheet.vertices, ...sheet.vertices.map(([x, y, z]) => [x, y + 1, z])],
    faces: [
      { id: 'bottom', vertices: [3, 2, 1, 0], uv: [...sheet.faces[0].uv].reverse() },
      { id: 'top', vertices: [4, 5, 6, 7], uv: sheet.faces[0].uv },
    ],
  };
  const bridged = K.bridgeMeshEdgeLoops(sheets, ['0:1', '1:2', '2:3', '0:3'], ['4:5', '5:6', '6:7', '4:7'], {
    segments: 2,
  });
  assert.deepEqual([beveled.mesh.faces.length, slid.mesh.faces.length, dissolved.mesh.faces.length], [7, 10, 6]);
  assert.equal(welded.welded, 0);
  assert.equal(bridged.mesh.faces.length, 10);
  assertClosed(bridged.mesh);
  assert.equal(euler(bridged.mesh), 2);
});

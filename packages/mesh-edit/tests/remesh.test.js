import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';
import { remeshMesh, remeshMeshVoxels } from '@margoengine/mesh-edit/remesh';

let next = 0;
const createId = () => `r${next++}`;

const volume = (mesh) => {
  let sum = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const b = mesh.vertices[face.vertices[i]],
        c = mesh.vertices[face.vertices[i + 1]];
      sum +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return sum / 6;
};

function assertClosed(mesh) {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh)) {
    assert.equal(edge.incidences.length, 2, `edge ${edge.id}`);
    assert.notEqual(edge.incidences[0].from, edge.incidences[1].from, 'winding');
  }
}

const edgeLengths = (mesh) =>
  polygonMeshEdges(mesh).map((edge) => {
    const [a, b] = edge.vertices.map((v) => mesh.vertices[v]);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  });

/** Sphere of radius 1 as triangles of very mixed sizes: dense at +x, sparse elsewhere. */
function unevenSphere() {
  let mesh = createPrimitiveMesh('cube', 'box');
  for (let i = 0; i < 3; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  const vertices = mesh.vertices.map((p) => {
    const length = Math.hypot(...p),
      unit = p.map((x) => x / length),
      squeeze = (unit[0] + 1) / 2;
    // Pull points toward +x along the sphere, so one side gets tiny triangles.
    const x = unit[0] + (1 - unit[0]) * squeeze * 0.7,
      side = Math.hypot(unit[1], unit[2]) || 1,
      scale = Math.sqrt(Math.max(0, 1 - x * x)) / side;
    return [x, unit[1] * scale, unit[2] * scale];
  });
  return {
    vertices,
    faces: mesh.faces.flatMap((face) =>
      face.vertices.slice(1, -1).map((_, i) => ({
        id: `${face.id}.${i}`,
        vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
        uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
      })),
    ),
  };
}

test('isotropic remesh evens out edges and stays on the surface', () => {
  const input = unevenSphere(),
    lengths = edgeLengths(input),
    { mesh, sources } = remeshMesh(input, { targetLength: 0.2, createId }),
    after = edgeLengths(mesh),
    spread = (list) => {
      const mean = list.reduce((a, b) => a + b) / list.length;
      return Math.sqrt(list.reduce((sum, x) => sum + (x - mean) ** 2, 0) / list.length) / mean;
    };
  assertClosed(mesh);
  assert.ok(spread(after) < spread(lengths) / 2, `spread ${spread(lengths)} to ${spread(after)}`);
  const mean = after.reduce((a, b) => a + b) / after.length;
  assert.ok(mean > 0.15 && mean < 0.26, `mean edge ${mean}`);
  for (const p of mesh.vertices) assert.ok(Math.abs(Math.hypot(...p) - 1) < 0.02, 'vertex left the surface');
  assert.ok(Math.abs(volume(mesh) / volume(input) - 1) < 0.03);
  for (const face of mesh.faces) assert.ok(input.faces.some((source) => source.id === sources[face.id]));
});

test('creases and corners survive: a remeshed cube is still a cube', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    { mesh } = remeshMesh(cube, { targetLength: 0.2, createId, iterations: 4 });
  assertClosed(mesh);
  assert.ok(Math.abs(volume(mesh) - 1) < 1e-9, `volume ${volume(mesh)}`);
  assert.ok(mesh.faces.length > 100);
  for (const corner of cube.vertices)
    assert.ok(mesh.vertices.some((p) => p.every((x, k) => Math.abs(x - corner[k]) < 1e-12)));
  // No face crosses a crease: every triangle stays on one cube side.
  for (const face of mesh.faces)
    assert.ok([0, 1, 2].some((k) => face.vertices.every((v) => Math.abs(Math.abs(mesh.vertices[v][k]) - 0.5) < 1e-12)));
});

test('coarsening: a target above the mesh edges reduces faces', () => {
  const input = unevenSphere(),
    { mesh } = remeshMesh(input, { targetLength: 0.6, createId });
  assertClosed(mesh);
  assert.ok(mesh.faces.length < input.faces.length / 2);
});

test('an open surface keeps its outline and UVs carry over', () => {
  const plane = createPrimitiveMesh('plane', 'tile'),
    { mesh } = remeshMesh(plane, { targetLength: 0.15, createId }),
    size = (m) => Math.max(...m.vertices.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2]))));
  compilePolygonMesh(mesh);
  assert.equal(size(mesh), size(plane));
  // The plane's UVs are an affine map of x and z, so every corner must follow the same map.
  const source = plane.faces[0],
    [a, b, c] = source.vertices.map((v) => plane.vertices[v]),
    [ua, ub, uc] = source.uv,
    det = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
  for (const face of mesh.faces)
    face.vertices.forEach((v, i) => {
      const p = mesh.vertices[v],
        s = ((p[0] - a[0]) * (c[2] - a[2]) - (p[2] - a[2]) * (c[0] - a[0])) / det,
        t = ((b[0] - a[0]) * (p[2] - a[2]) - (b[2] - a[2]) * (p[0] - a[0])) / det;
      for (const k of [0, 1])
        assert.ok(Math.abs(face.uv[i][k] - (ua[k] + (ub[k] - ua[k]) * s + (uc[k] - ua[k]) * t)) < 0.03, 'uv drifted');
    });
});

test('voxel remesh rebuilds a closed even surface close to the volume', () => {
  const input = unevenSphere(),
    { mesh, quads, nonManifoldEdges } = remeshMeshVoxels(input, { voxelSize: 0.1, createId });
  assert.equal(nonManifoldEdges, 0);
  assertClosed(mesh);
  assert.ok(Math.abs(volume(mesh) / volume(input) - 1) < 0.03, `volume ${volume(mesh)} of ${volume(input)}`);
  assert.ok(quads.length > 500);
  for (const quad of quads) assert.equal(new Set(quad).size, 4);
  for (const p of mesh.vertices) assert.ok(Math.abs(Math.hypot(...p) - 1) < 0.08);
  const lengths = edgeLengths(mesh).filter((x) => x > 0);
  assert.ok(Math.max(...lengths) < 0.3);
});

test('voxel remesh merges overlapping parts into one surface', () => {
  const box = createPrimitiveMesh('cube', 'box'),
    both = {
      vertices: [...box.vertices, ...box.vertices.map(([x, y, z]) => [x + 0.5, y, z])],
      faces: [
        ...box.faces,
        ...box.faces.map((face) => ({
          ...face,
          id: `${face.id}b`,
          vertices: face.vertices.map((v) => v + box.vertices.length),
        })),
      ],
    },
    { mesh } = remeshMeshVoxels(both, { voxelSize: 0.1, createId });
  assertClosed(mesh);
  // Parity reads the overlap as outside, so two walls bound the shared middle.
  assert.ok(volume(mesh) > 0.8);
});

test('bad options reject and abort stops the work', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    plane = createPrimitiveMesh('plane', 'tile');
  assert.throws(() => remeshMesh(cube, { iterations: 0 }), RangeError);
  assert.throws(() => remeshMesh(cube, { targetLength: 0 }), RangeError);
  assert.throws(() => remeshMesh(cube, { sharpAngle: 4 }), RangeError);
  assert.throws(() => remeshMesh(cube, { createId: 1 }), TypeError);
  assert.throws(() => remeshMesh(cube, { signal: {} }), TypeError);
  assert.throws(() => remeshMesh(cube, { signal: AbortSignal.abort(new RangeError('stop')) }), { message: 'stop' });
  assert.throws(() => remeshMeshVoxels(cube, { voxelSize: 0 }), RangeError);
  assert.throws(() => remeshMeshVoxels(cube, { voxelSize: 0.001, maxCells: 1000 }), RangeError);
  assert.throws(() => remeshMeshVoxels(plane, { voxelSize: 0.1 }), TypeError);
  assert.throws(() => remeshMeshVoxels(cube, { voxelSize: 0.05, signal: AbortSignal.abort(new RangeError('stop')) }), {
    message: 'stop',
  });
});

const roundBall = () => {
  let high = createPrimitiveMesh('cube', 'hi');
  for (let i = 0; i < 3; i++) high = subdivideMesh(high, { createId }).mesh;
  return { ...high, vertices: high.vertices.map((p) => p.map((x) => x / Math.hypot(...p))) };
};
const skew = (mesh, [a, b, c, d]) =>
  Math.max(
    ...[a, b, c, d].map((v, i, all) => {
      const p = mesh.vertices[v],
        u = mesh.vertices[all[(i + 1) % 4]].map((x, k) => x - p[k]),
        w = mesh.vertices[all[(i + 3) % 4]].map((x, k) => x - p[k]),
        cosine = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
      return Math.abs(Math.acos(cosine) - Math.PI / 2);
    }),
  );

test('quads pairs a curved surface into mostly quads, each triangle in at most one, none a sliver', () => {
  const made = remeshMesh(roundBall(), { targetLength: 0.15, quads: true, preserveSeams: false, createId }),
    { mesh, quads, unpaired } = made,
    triangles = quads.length * 2 + unpaired,
    corners = new Set();
  assert.equal(unpaired, 0, `${quads.length} quads of ${triangles} triangles`);
  for (const quad of quads) {
    assert.ok(skew(mesh, quad) <= (65 * Math.PI) / 180 + 1e-9);
    const key = [...quad].sort((a, b) => a - b).join();
    assert.equal(corners.has(key), false, 'each quad once');
    corners.add(key);
  }
  assert.ok(quads.every((q) => new Set(q).size === 4));
  assertClosed(mesh);
});

test('quads with seams kept still pair most of a curved surface', () => {
  const { quads, unpaired } = remeshMesh(roundBall(), { targetLength: 0.15, quads: true, createId }),
    triangles = quads.length * 2 + unpaired;
  assert.ok(quads.length * 2 >= triangles * 0.8, `${quads.length} quads of ${triangles} triangles`);
});

test('quads on a cube: flat pairs become single faces, the corners and volume hold, and sources follow', () => {
  const { mesh, quads, sources } = remeshMesh(createPrimitiveMesh('cube', 'q'), { targetLength: 0.25, quads: true, createId }),
    four = mesh.faces.filter((face) => face.vertices.length === 4);
  assert.ok(four.length * 1.2 >= quads.length && four.length > 0, `${four.length} faces of ${quads.length} quads`);
  assert.ok(Math.abs(Math.abs(volume(mesh)) - 1) < 1e-9);
  assert.deepEqual(Object.keys(sources).sort(), mesh.faces.map((face) => face.id).sort());
  assertClosed(mesh);
});

test('a UV seam stays an edge of the quads, unless told otherwise', () => {
  const vertices = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    split = {
      vertices,
      faces: [
        { id: 'a', vertices: [0, 1, 2], uv: [[0, 0], [0.4, 0], [0.4, 0.4]] },
        { id: 'b', vertices: [0, 2, 3], uv: [[0.6, 0.6], [1, 1], [0.6, 1]] },
      ],
    },
    options = { targetLength: 2, iterations: 1, quads: true, createId };
  const kept = remeshMesh(split, options);
  assert.equal(kept.quads.length, 0);
  assert.equal(kept.unpaired, 2);
  assert.equal(remeshMesh(split, { ...options, preserveSeams: false }).quads.length, 1);
});

test('quads never pair across a crease', () => {
  const cube = createPrimitiveMesh('cube', 'c'),
    { mesh, quads } = remeshMesh(cube, { targetLength: 0.25, quads: true, createId });
  // On a cube every quad lies on one side: its corners share an axis value.
  for (const quad of quads) {
    const points = quad.map((v) => mesh.vertices[v]);
    assert.ok([0, 1, 2].some((axis) => points.every((p) => Math.abs(p[axis] - points[0][axis]) < 1e-9)));
  }
});

test('without quads the result has no quad fields and stays all triangles', () => {
  const made = remeshMesh(createPrimitiveMesh('cube', 'n'), { targetLength: 0.25, createId });
  assert.equal(made.quads, undefined);
  assert.ok(made.mesh.faces.every((face) => face.vertices.length === 3));
});

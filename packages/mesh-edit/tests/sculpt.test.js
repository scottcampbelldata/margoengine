import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';
import { MeshSculptSession } from '@margoengine/mesh-edit/sculpt';

let next = 0;
const createId = () => `c${next++}`;

/** A flat grid in the XZ plane, facing +Y, 1 by 1, as triangles. */
function sheet(levels = 4) {
  let mesh = createPrimitiveMesh('plane', 'tile');
  for (let i = 0; i < levels; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  return mesh;
}

/** A unit sphere as triangles. */
function sphere(levels = 3) {
  let mesh = createPrimitiveMesh('cube', 'box');
  for (let i = 0; i < levels; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  return {
    vertices: mesh.vertices.map((p) => p.map((x) => x / Math.hypot(...p))),
    faces: mesh.faces.flatMap((face) =>
      face.vertices.slice(1, -1).map((_, i) => ({
        id: `${face.id}.${i}`,
        vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
        uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
      })),
    ),
  };
}

function stroke(session, options, ...points) {
  session.beginStroke(options);
  for (const point of points) session.dab(point);
  session.endStroke();
}

const up = (mesh) => {
  const normal = compilePolygonMesh(mesh).normals[1];
  return normal >= 0 ? 1 : -1;
};
const peak = (mesh) => Math.max(...mesh.vertices.map((p) => p[1] * up(mesh)));

function assertClosed(mesh) {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh)) assert.equal(edge.incidences.length, 2, `edge ${edge.id}`);
}

test('pick finds the nearest surface point and its normal', () => {
  const session = new MeshSculptSession(sphere(), { createId }),
    hit = session.pick([0, 0, 5], [0, 0, -2]);
  assert.ok(Math.abs(hit.distance - 4) < 0.05);
  assert.ok(hit.normal[2] > 0.9);
  assert.equal(session.pick([0, 5, 5], [0, 0, -1]), null);
  assert.throws(() => session.pick([0, 0, 0], [0, 0, 0]), TypeError);
});

test('draw raises the surface under the brush and leaves the rest', () => {
  const mesh = sheet(),
    session = new MeshSculptSession(mesh, { createId, radius: 0.3, strength: 1 });
  stroke(session, { brush: 'draw' }, [0, 0, 0]);
  const out = session.mesh();
  assert.ok(peak(out) > 0.05, `peak ${peak(out)}`);
  for (const p of out.vertices) if (Math.hypot(p[0], p[2]) > 0.31) assert.equal(p[1], 0);
  stroke(session, { brush: 'draw', invert: true }, [0, 0, 0]);
  assert.ok(peak(session.mesh()) < peak(out) / 2);
});

test('inflate grows a sphere along its normals; invert shrinks it', () => {
  const session = new MeshSculptSession(sphere(), { createId, radius: 3, falloff: 'constant', strength: 0.2 });
  stroke(session, { brush: 'inflate' }, [0, 0, 0]);
  const radii = session.mesh().vertices.map((p) => Math.hypot(...p));
  assert.ok(Math.min(...radii) > 1.1, 'every vertex moved out');
  stroke(session, { brush: 'inflate', invert: true }, [0, 0, 0]);
  const back = session.mesh().vertices.map((p) => Math.hypot(...p));
  assert.ok(Math.max(...back) < 1.06);
});

test('smooth flattens a spike', () => {
  const mesh = sheet(),
    session = new MeshSculptSession(mesh, { createId, radius: 0.15, strength: 1 });
  stroke(session, { brush: 'draw' }, [0, 0, 0]);
  const spike = peak(session.mesh());
  stroke(session, { brush: 'smooth', radius: 0.4 }, [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
  assert.ok(peak(session.mesh()) < spike * 0.8);
});

test('grab drags held vertices with the pointer, off the surface too', () => {
  const mesh = sheet(),
    session = new MeshSculptSession(mesh, { createId, radius: 0.2, falloff: 'constant' });
  session.beginStroke({ brush: 'grab' });
  session.dab([0, 0, 0]);
  session.dab([0, 0.5, 0]);
  session.dab([0, 1, 0]);
  session.endStroke();
  const out = session.mesh(),
    raised = out.vertices.filter((p) => p[1] === 1);
  assert.ok(raised.length > 3);
  for (const p of raised) assert.ok(Math.hypot(p[0], p[2]) < 0.2);
});

test('crease cuts a valley and pinches toward the center', () => {
  const mesh = sheet(5),
    session = new MeshSculptSession(mesh, { createId, radius: 0.3, strength: 1 });
  stroke(session, { brush: 'crease' }, [0, 0, 0]);
  const out = session.mesh(),
    lowest = out.vertices.reduce((best, p) => (p[1] * up(mesh) < best[1] * up(mesh) ? p : best));
  assert.ok(lowest[1] * up(mesh) < -0.03);
  assert.ok(Math.hypot(lowest[0], lowest[2]) < 0.1);
  const nearCenter = (m) => m.vertices.filter((p) => Math.hypot(p[0], p[2]) < 0.1).length;
  assert.ok(nearCenter(out) > nearCenter(mesh));
});

test('symmetry repeats a dab across the plane', () => {
  const mesh = sheet(),
    session = new MeshSculptSession(mesh, { createId, radius: 0.15, strength: 1, symmetry: 'x' });
  stroke(session, { brush: 'draw' }, [0.25, 0, 0]);
  const out = session.mesh(),
    tall = (sign) => Math.max(...out.vertices.filter((p) => p[0] * sign > 0).map((p) => p[1] * up(mesh)));
  assert.ok(tall(1) > 0.01);
  assert.ok(Math.abs(tall(1) - tall(-1)) < 1e-12);
});

test('dynamic topology adds triangles under a long pull and keeps edges at the detail size', () => {
  const ball = sphere(),
    fixed = new MeshSculptSession(ball, { createId, radius: 0.5, strength: 1 }),
    dynamic = new MeshSculptSession(ball, {
      createId,
      radius: 0.5,
      strength: 1,
      dynamicTopology: true,
      detailSize: 0.15,
    }),
    start = dynamic.triangleCount;
  const pull = (session) => {
    for (let i = 0; i < 8; i++) {
      const hit = session.pick([0, 0, 9], [0, 0, -1]);
      stroke(session, { brush: 'draw' }, hit.point);
    }
  };
  pull(fixed);
  pull(dynamic);
  assert.equal(fixed.triangleCount, ball.faces.length);
  assert.ok(dynamic.triangleCount > start, `${start} to ${dynamic.triangleCount}`);
  const out = dynamic.mesh();
  assertClosed(out);
  const longest = (mesh) =>
    Math.max(
      ...polygonMeshEdges(mesh)
        .filter((edge) => edge.vertices.some((v) => mesh.vertices[v][2] > 1.1))
        .map((edge) => {
          const [a, b] = edge.vertices.map((v) => mesh.vertices[v]);
          return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        }),
    );
  assert.ok(longest(out) < longest(fixed.mesh()), 'stretched edges were split');
});

test('dynamic topology collapses edges where detail is coarser, and open edges stay', () => {
  const mesh = sheet(5),
    session = new MeshSculptSession(mesh, {
      createId,
      radius: 0.2,
      strength: 0.1,
      dynamicTopology: true,
      detailSize: 0.2,
    }),
    start = session.triangleCount;
  stroke(session, { brush: 'smooth' }, [0, 0, 0]);
  assert.ok(session.triangleCount < start);
  compilePolygonMesh(session.mesh());
  const edgeOf = (m) => Math.max(...m.vertices.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2]))));
  assert.equal(edgeOf(session.mesh()), edgeOf(mesh));
});

test('undo and redo cover strokes, with topology, and honor the limit', () => {
  const ball = sphere(),
    session = new MeshSculptSession(ball, {
      createId: () => 'x',
      radius: 0.5,
      dynamicTopology: true,
      detailSize: 0.1,
      undoLimit: 2,
    }),
    shape = () =>
      session
        .mesh()
        .vertices.map((p) => p.join(','))
        .sort()
        .join(';'),
    before = shape(),
    count = session.triangleCount;
  session.beginStroke({ brush: 'draw' });
  assert.throws(() => session.undo(), RangeError);
  session.dab([0, 0, 1]);
  session.endStroke();
  const after = shape(),
    afterCount = session.triangleCount;
  assert.notEqual(after, before);
  assert.equal(session.undo(), true);
  assert.equal(session.triangleCount, count);
  assert.equal(shape(), before);
  assert.equal(session.redo(), true);
  assert.equal(session.triangleCount, afterCount);
  assert.equal(shape(), after);
  stroke(session, {}, [0, 0, 1]);
  stroke(session, {}, [0, 0, 1]);
  stroke(session, {}, [0, 0, 1]);
  assert.equal(session.undoSteps, 2);
  assert.equal(session.redoSteps, 0);
  assert.equal(session.undo(), true);
  assert.equal(session.undo(), true);
  assert.equal(session.undo(), false);
});

test('the input is untouched and UVs carry through', () => {
  const mesh = sheet(2),
    copy = JSON.stringify(mesh),
    session = new MeshSculptSession(mesh, {
      createId,
      radius: 0.5,
      strength: 1,
      dynamicTopology: true,
      detailSize: 0.05,
    });
  stroke(session, { brush: 'draw' }, [0, 0, 0]);
  assert.equal(JSON.stringify(mesh), copy);
  const out = session.mesh();
  compilePolygonMesh(out);
  for (const face of out.faces)
    for (const uv of face.uv) assert.ok(uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1);
  assert.ok(new Set(out.faces.flatMap((face) => face.uv.map((uv) => uv.join(',')))).size > 8);
});

test('bad input rejects with the fix in the message', () => {
  const mesh = sheet(1);
  assert.throws(() => new MeshSculptSession(mesh, { brush: 'pinch' }), TypeError);
  assert.throws(() => new MeshSculptSession(mesh, { radius: 0 }), RangeError);
  assert.throws(() => new MeshSculptSession(mesh, { strength: 2 }), RangeError);
  assert.throws(() => new MeshSculptSession(mesh, { falloff: 'hard' }), TypeError);
  assert.throws(() => new MeshSculptSession(mesh, { symmetry: 'w' }), TypeError);
  assert.throws(() => new MeshSculptSession(mesh, { undoLimit: -1 }), RangeError);
  assert.throws(() => new MeshSculptSession(mesh, { detailSize: 0 }), RangeError);
  assert.throws(() => new MeshSculptSession(mesh, { createId: 2 }), TypeError);
  const session = new MeshSculptSession(mesh);
  assert.throws(() => session.dab([0, 0, 0]), RangeError);
  assert.throws(() => session.endStroke(), RangeError);
  session.beginStroke();
  assert.throws(() => session.beginStroke(), RangeError);
  assert.throws(() => session.dab([0, 0]), TypeError);
});

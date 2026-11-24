import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh } from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';
import { MeshSculptSession } from '@margoengine/mesh-edit/sculpt';

let next = 0;
const createId = () => `s${next++}`;

function grid(kind, levels) {
  let mesh = createPrimitiveMesh(kind, 'box');
  for (let i = 0; i < levels; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  return mesh;
}

/** Nearest hit distance over every triangle of a mesh, the plain way. */
function nearest(mesh, origin, direction) {
  const size = Math.hypot(...direction),
    d = direction.map((x) => x / size),
    cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2],
    sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  let best = null;
  for (const face of mesh.faces) {
    const [a, b, c] = face.vertices.map((v) => mesh.vertices[v]),
      e = sub(b, a),
      f = sub(c, a),
      p = cross(d, f),
      det = dot(e, p);
    if (!det) continue;
    const s = sub(origin, a),
      u = dot(s, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e),
      v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    const t = dot(f, q) / det;
    if (t >= 0 && (best === null || t < best)) best = t;
  }
  return best;
}

function assertSamePicks(session, rays) {
  const mesh = session.mesh();
  for (const [origin, direction] of rays) {
    const hit = session.pick(origin, direction),
      want = nearest(mesh, origin, direction);
    if (want === null) assert.equal(hit, null, `ray ${origin} ${direction}`);
    else assert.ok(hit && Math.abs(hit.distance - want) < 1e-9 * (1 + want), `ray ${origin}: ${hit?.distance}, ${want}`);
  }
}

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const rays = (count, at = [0, 0, 0]) =>
  Array.from({ length: count }, () => {
    const origin = [at[0] + rnd() * 6 - 3, at[1] + rnd() * 6 - 3, at[2] + rnd() * 6 - 3],
      goal = [at[0] + rnd() - 0.5, at[1] + rnd() - 0.5, at[2] + rnd() - 0.5];
    return [origin, goal.map((x, k) => x - origin[k])];
  });

test('pick agrees with testing every triangle, before and after strokes', () => {
  const session = new MeshSculptSession(grid('cube', 3), { createId, radius: 0.4, strength: 1 });
  assertSamePicks(session, rays(150));
  session.beginStroke({ brush: 'draw' });
  session.dab([0, 0, 0.5]);
  session.dab([0.5, 0, 0]);
  session.endStroke();
  session.beginStroke({ brush: 'grab' });
  session.dab([0, 0.5, 0]);
  session.dab([0, 2, 0]);
  session.endStroke();
  assertSamePicks(session, rays(150));
  session.undo();
  assertSamePicks(session, rays(100));
  session.undo();
  assertSamePicks(session, rays(100));
});

test('pick agrees after dynamic topology splits and collapses, and after undoing them', () => {
  const session = new MeshSculptSession(grid('cube', 3), {
    createId,
    radius: 0.5,
    strength: 1,
    dynamicTopology: true,
    detailSize: 0.08,
  });
  session.beginStroke({ brush: 'draw' });
  for (let i = 0; i < 4; i++) session.dab([0, 0, 0.5]);
  session.endStroke();
  assertSamePicks(session, rays(120));
  session.undo();
  assertSamePicks(session, rays(120));
  session.redo();
  assertSamePicks(session, rays(120));
});

test('a mesh far from the origin, a huge triangle and a vertex dragged far away still pick right', () => {
  const far = grid('cube', 2);
  far.vertices = far.vertices.map((p) => [p[0] + 1e7, p[1] - 1e7, p[2]]);
  const session = new MeshSculptSession(far, { createId });
  assertSamePicks(session, rays(60, [1e7, -1e7, 0]));

  const big = grid('plane', 4);
  big.vertices.push([-500, 3, -500], [500, 3, -500], [0, 3, 500]);
  const n = big.vertices.length;
  big.faces.push({
    id: 'huge',
    vertices: [n - 3, n - 1, n - 2],
    uv: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  });
  const huge = new MeshSculptSession(big, { createId });
  assert.ok(Math.abs(huge.pick([0.1, 9, 0.1], [0, -1, 0]).distance - 6) < 1e-9);
  assertSamePicks(huge, rays(60));

  const dragged = new MeshSculptSession(grid('cube', 3), { createId, radius: 0.2, falloff: 'constant' });
  dragged.beginStroke({ brush: 'grab' });
  dragged.dab([0, 0, 0.5]);
  dragged.dab([0, 0, 5e6]);
  dragged.endStroke();
  assertSamePicks(dragged, rays(60));
  assertSamePicks(dragged, [[[0, 0, 6e6], [0, 0, -1]]]);
});

test('work follows the brush and the ray, not the size of the mesh', () => {
  const mesh = grid('cube', 5),
    session = new MeshSculptSession(mesh, { createId, radius: 0.1, strength: 1 }),
    triangles = session.triangleCount,
    hit = session.pick([0.1, 0.1, 5], [0, 0, -1]);
  assert.ok(triangles > 50_000, `${triangles} triangles`);
  assert.ok(session.stats.pickTriangles < triangles / 50, `${session.stats.pickTriangles} of ${triangles} tested`);
  session.beginStroke({ brush: 'draw' });
  session.dab(hit.point);
  session.endStroke();
  const { dabVertices, undoEntries } = session.stats;
  assert.ok(dabVertices > 0 && dabVertices < mesh.vertices.length / 20, `${dabVertices} of ${mesh.vertices.length}`);
  assert.ok(undoEntries > 0 && undoEntries <= dabVertices, `undo holds ${undoEntries} entries`);
});

test('undo holds what strokes changed, however many there are', () => {
  const mesh = grid('cube', 4),
    session = new MeshSculptSession(mesh, {
      createId,
      radius: 0.1,
      dynamicTopology: true,
      detailSize: 0.03,
      undoLimit: 100,
    });
  for (let i = 0; i < 30; i++) {
    session.beginStroke({ brush: 'draw' });
    session.dab([0, 0, 0.5]);
    session.endStroke();
  }
  assert.equal(session.undoSteps, 30);
  assert.ok(session.stats.undoEntries < mesh.vertices.length * 5, `${session.stats.undoEntries} entries`);
  const after = session.triangleCount;
  while (session.undo());
  assert.equal(session.triangleCount, new MeshSculptSession(mesh, { createId }).triangleCount);
  while (session.redo());
  assert.equal(session.triangleCount, after);
});

test('a drawing follows the surface: ranges carry every changed float, new triangles say all', () => {
  const session = new MeshSculptSession(grid('cube', 3), { createId, radius: 0.3, strength: 1 }),
    drawing = session.drawing();
  assert.equal(drawing.update(), 'all');
  assert.deepEqual(drawing.update(), []);
  const count = drawing.vertices.length / 20,
    mirror = drawing.vertices.slice();
  assert.equal(drawing.indices.length, session.triangleCount * 3);
  session.beginStroke({ brush: 'draw' });
  session.dab([0, 0, 0.5]);
  session.endStroke();
  const ranges = drawing.update();
  assert.ok(Array.isArray(ranges) && ranges.length > 0);
  const sent = ranges.reduce((sum, { count }) => sum + count, 0);
  assert.ok(sent < count, `${sent} of ${count} vertices`);
  for (const { start, count } of ranges)
    mirror.set(drawing.vertices.subarray(start * 20, (start + count) * 20), start * 20);
  assert.deepEqual(mirror, drawing.vertices, 'nothing changed outside the ranges');
  for (let v = 0; v < count; v++) {
    const o = v * 20;
    assert.ok(Math.abs(Math.hypot(drawing.vertices[o + 4], drawing.vertices[o + 5], drawing.vertices[o + 6]) - 1) < 1e-3);
  }
  const fresh = new MeshSculptSession(session.mesh(), { createId }).drawing();
  fresh.update();
  assert.equal(fresh.indices.length, drawing.indices.length);
  session.undo();
  assert.ok(Array.isArray(drawing.update()), 'undoing a stroke that kept its triangles uploads ranges');

  const growing = new MeshSculptSession(grid('cube', 2), {
      createId,
      radius: 0.6,
      strength: 1,
      dynamicTopology: true,
      detailSize: 0.1,
    }),
    view = growing.drawing();
  view.update();
  growing.beginStroke({ brush: 'draw' });
  growing.dab([0, 0, 0.5]);
  growing.endStroke();
  assert.equal(view.update(), 'all');
  assert.equal(view.indices.length, growing.triangleCount * 3);
  growing.undo();
  assert.equal(view.update(), 'all');
  assert.equal(view.indices.length, growing.triangleCount * 3);
});

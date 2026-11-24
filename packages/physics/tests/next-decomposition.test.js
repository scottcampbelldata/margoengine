// Convex decomposition (`@margoengine/physics/decomposition`, Wei, Liu, Ling and Su 2022): the paper's own cases (a
// tube in four parts, Fig. 9), its concavity measure (Eq. 10) on every result, results that repeat bit for bit, the
// limits on parts and time, and the proof the batch asks for: a marble inside a decomposed cup on the own solver.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MargoError } from '@margoengine/math/errors';
import { Physics as RapierPhysics } from '../dist/index.js';
import { convexDecomposition, decompositionConcavity } from '../dist/decomposition.js';
import { Physics } from '../dist/next.js';

await Promise.all([Physics.load(), RapierPhysics.load()]);

/** Closed boxes as one triangle soup, each box with its own corners, triangles facing in as in depth.test.js. */
function boxes(list) {
  const faces = [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ],
    vertices = [],
    indices = [];
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const base = vertices.length / 3;
    for (let i = 0; i < 8; i++) vertices.push(i & 4 ? x1 : x0, i & 2 ? y1 : y0, i & 1 ? z1 : z0);
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  return { vertices, indices };
}

/** The cup of depth.test.js: an open-top box with 0.1 m walls, 2 m wide, 1 m tall, from five overlapping slabs. */
const cup = () =>
  boxes([
    [-1, 0, -1, 1, 0.1, 1],
    [-1, 0, -1, -0.9, 1, 1],
    [0.9, 0, -1, 1, 1, 1],
    [-1, 0, -1, 1, 1, -0.9],
    [-1, 0, 0.9, 1, 1, 1],
  ]);

/** One closed, shared-vertex surface around filled unit cells. */
function cells(filled) {
  const key = (c) => c.join(','),
    set = new Set(filled.map(key)),
    ids = new Map(),
    vertices = [],
    indices = [];
  const vertex = (p) => {
    if (!ids.has(key(p))) {
      ids.set(key(p), vertices.length / 3);
      vertices.push(...p);
    }
    return ids.get(key(p));
  };
  for (const cell of filled)
    for (let a = 0; a < 3; a++)
      for (const s of [1, -1]) {
        const n = [...cell];
        n[a] += s;
        if (set.has(key(n))) continue;
        const u = (a + 1) % 3,
          w = (a + 2) % 3,
          base = [...cell];
        if (s > 0) base[a] += 1;
        const corner = (du, dw) => {
          const p = [...base];
          p[u] += du;
          p[w] += dw;
          return vertex(p);
        };
        const q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
        if (s > 0) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
        else indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
      }
  return { vertices, indices };
}

/** The paper's Fig. 9: a square tube open at both ends, 4 by 4 by 4 with walls 1 thick. Four boxes are its best answer. */
function tube() {
  const filled = [];
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 4; k++) if (i === 0 || i === 3 || k === 0 || k === 3) for (let j = 0; j < 4; j++) filled.push([i, j, k]);
  return cells(filled);
}

/** libigl's decimated knight (packages/loaders/tests/fixtures, in THIRD-PARTY-NOTICES.md): 502 vertices, 1,000 triangles, closed. */
function knight() {
  const words = readFileSync(new URL('../../loaders/tests/fixtures/decimated-knight.off', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
  const [vertexCount, faceCount] = [+words[1], +words[2]],
    vertices = words.slice(4, 4 + vertexCount * 3).map(Number),
    indices = [];
  for (let f = 0, i = 4 + vertexCount * 3; f < faceCount; f++, i += 4) indices.push(+words[i + 1], +words[i + 2], +words[i + 3]);
  return { vertices, indices };
}

test('a square tube splits into its four walls, as the paper shows a tree search does where a greedy cut cannot', () => {
  const mesh = tube(),
    result = convexDecomposition(mesh);
  assert.equal(result.shape, 'convexDecomposition');
  assert.equal(result.parts.length, 4, 'four parts (Rapier 0.21 makes 7 of the same tube)');
  for (const value of result.concavity) assert.ok(value < 0.05, `each part under the threshold (${value})`);
  // Eq. 10 clips the tube to each part's hull: every part needs whole caps after three cuts, or a hull face is open.
  const score = decompositionConcavity(mesh, result.parts);
  assert.ok(score < 0.05, `the paper's score is under the threshold (${score})`);
  const filled = decompositionConcavity(mesh, [{ points: mesh.vertices }]);
  assert.ok(Math.abs(filled - 0.25) < 0.01, `one hull fills the tube: its score is the hollow's half width, a quarter of the side (${filled})`);
});

test('the same mesh, options and seed give the same parts bit for bit, and an inside-out mesh the same as an outward one', () => {
  const mesh = cup(),
    options = { iterations: 60 },
    first = convexDecomposition(mesh, options),
    again = convexDecomposition(mesh, options);
  assert.deepEqual(again, first);
  const outward = { vertices: mesh.vertices, indices: [] };
  for (let i = 0; i < mesh.indices.length; i += 3) outward.indices.push(mesh.indices[i], mesh.indices[i + 2], mesh.indices[i + 1]);
  assert.deepEqual(convexDecomposition(outward, options), first);
});

test('a knight decomposes under the threshold by the paper measure, with every hull holding its part', () => {
  const mesh = knight(),
    result = convexDecomposition(mesh, { iterations: 100 });
  assert.ok(result.parts.length > 2 && result.parts.length <= 64, `${result.parts.length} parts`);
  for (const value of result.concavity) assert.ok(value < 0.05, `each part under the threshold (${value})`);
  const score = decompositionConcavity(mesh, result.parts);
  assert.ok(score < 0.06, `the mesh clipped to each hull stays near the threshold (${score})`);
});

test('maxConvexHulls caps the parts, timeLimit stops with a timeout, and open or bad meshes are refused', () => {
  assert.ok(convexDecomposition(tube(), { maxConvexHulls: 2 }).parts.length <= 2);
  assert.equal(convexDecomposition(tube(), { maxConvexHulls: 1 }).parts.length, 1);
  assert.throws(
    () => convexDecomposition(knight(), { timeLimit: 1 }),
    (error) => error instanceof MargoError && error.code === 'timeout' && /timeLimit/.test(error.message),
  );
  const open = tube();
  open.indices.length -= 3;
  assert.throws(() => convexDecomposition(open), /closed mesh/);
  assert.throws(() => convexDecomposition({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] }), /indices/);
  assert.throws(() => convexDecomposition({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] }), /outside/);
  assert.throws(() => convexDecomposition(tube(), { concavity: 0 }), RangeError);
  assert.throws(() => convexDecomposition(tube(), { iterations: 0.5 }), RangeError);
});

test('a marble falls inside a decomposed cup on the own solver, and rests on the lid of its hull', () => {
  const parts = convexDecomposition(cup());
  const drop = (colliders) => {
    const physics = new Physics(null);
    physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
    const body = physics.addBody(null, { position: [0, 0, 0], colliders }),
      marble = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.2 } });
    for (let i = 0; i < 300; i++) physics.step();
    return { marble: marble.position[1], cup: body.position[1], mass: body.mass };
  };
  const hollow = drop(parts),
    filled = drop({ shape: 'convexHull', points: cup().vertices });
  assert.ok(hollow.marble < 0.6, `the marble falls inside the decomposed cup (${hollow.marble})`);
  assert.ok(filled.marble > 1.1, `and rests on the lid of the hull (${filled.marble})`);
  assert.ok(hollow.mass < filled.mass * 0.6, 'the hollow cup weighs less than the filled hull');
  assert.ok(Math.abs(hollow.cup) < 0.05, `the cup rests on the floor (${hollow.cup})`);
});

test('the decomposition is a collider on the root entry too, and /next asks for it by name', () => {
  const parts = convexDecomposition(tube()),
    rapier = new RapierPhysics(null),
    body = rapier.addBody(null, { type: 'fixed', colliders: parts });
  assert.equal(body.colliders.length, 1);
  rapier.dispose();
  const own = new Physics(null),
    mesh = tube();
  assert.throws(
    () => own.addBody(null, { colliders: { shape: 'convexDecomposition', ...mesh } }),
    (error) => error instanceof MargoError && error.code === 'unsupported' && /@margoengine\/physics\/decomposition/.test(error.message),
  );
});

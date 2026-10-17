// STL/OBJ shading normals keep CAD edges hard: corners at a point share a smooth normal only with triangles that meet
// their own within the crease angle (default 40 degrees). Averaging every triangle at a point used to round off every
// edge of a dropped-in OBJ (the CAD scale ladder's brackets looked soft) and smear lighting across flat STL plates.
// Runs machinery's built CAD worker in-process, as tests/cad-occt-normals.test.js does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseCADAsync } from '../packages/machinery/dist/index.js';

const root = join(import.meta.dirname, '..');

/** The worker's parts for an OBJ text; `creaseAngle` undefined = the worker's default. */
function cadWorker(obj, creaseAngle) {
  const code = readFileSync(join(root, 'packages/machinery/dist/workers/cad-runtime.js'), 'utf8');
  return new Promise((done) => {
    const parts = [],
      self = {
        location: { href: 'file:///cad-runtime.js' },
        postMessage: (m) => {
          if (m.part) parts.push(m.part);
          if (m.error !== undefined || m.done) done({ ...m, parts });
        },
      };
    new Function('self', code)(self);
    const buffer = new TextEncoder().encode(obj).slice().buffer;
    self.onmessage({ data: { buffer, format: 'obj', smoothing: true, creaseAngle } });
  });
}
/** Every output vertex as { p: position, n: normal }. */
const verticesOf = (part) =>
  Array.from({ length: part.vertices.length / 6 }, (_, k) => ({
    p: [...part.vertices.subarray(k * 6, k * 6 + 3)],
    n: [...part.vertices.subarray(k * 6 + 3, k * 6 + 6)],
  }));
const close = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) < tolerance),
    `${label}: ${actual.map((v) => v.toFixed(5))} != ${expected.map((v) => v.toFixed(5))}`,
  );

// Unit cube, every face wound counter-clockwise seen from outside.
const cube = `o cube
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 4 8 7 3
f 1 5 8 4
f 2 3 7 6
`;

// A 24-sided prism of radius 1 and height 1 (sides 15 degrees apart) with fan caps, wound outward.
function prism(sides = 24) {
  const lines = ['o prism'];
  for (const y of [0, 1])
    for (let i = 0; i < sides; i++) {
      const a = (2 * Math.PI * i) / sides;
      lines.push(`v ${Math.cos(a)} ${y} ${Math.sin(a)}`);
    }
  lines.push('v 0 0 0', 'v 0 1 0');
  const bottom = (i) => 1 + (i % sides),
    top = (i) => 1 + sides + (i % sides),
    [low, high] = [2 * sides + 1, 2 * sides + 2];
  for (let i = 0; i < sides; i++)
    lines.push(
      `f ${bottom(i)} ${top(i)} ${top(i + 1)} ${bottom(i + 1)}`,
      `f ${high} ${top(i + 1)} ${top(i)}`,
      `f ${low} ${bottom(i)} ${bottom(i + 1)}`,
    );
  return `${lines.join('\n')}\n`;
}

test('default crease angle: a cube keeps its 90 degree edges (three flat normals at every corner)', async () => {
  const result = await cadWorker(cube);
  assert.equal(result.error, undefined, result.error);
  const vertices = verticesOf(result.parts[0]);
  assert.equal(vertices.length, 24, '8 corners x 3 faces');
  for (const { p, n } of vertices) {
    // Each normal is one face's outward axis: the coordinate it points along is 0 or 1 at that corner.
    const axis = n.findIndex((v) => Math.abs(v) > 0.5);
    close(
      n,
      [0, 1, 2].map((a) => (a === axis ? Math.sign(n[a]) : 0)),
      `corner ${p}`,
    );
    assert.equal(p[axis], n[axis] > 0 ? 1 : 0, `normal ${n} points out of the cube at ${p}`);
  }
});

test('creaseAngle 180 averages every triangle at a point, as before: a cube has 8 diagonal normals', async () => {
  const vertices = verticesOf((await cadWorker(cube, 180)).parts[0]);
  assert.equal(vertices.length, 8);
  for (const { p, n } of vertices)
    close(
      n,
      p.map((v) => (v ? 1 : -1) / Math.sqrt(3)),
      `corner ${p}`,
    );
});

test('a 24-sided cylinder shades round across its sides and stays hard at its rims', async () => {
  const vertices = verticesOf((await cadWorker(prism())).parts[0]);
  assert.equal(vertices.length, 98, '48 rim points x (side + cap) + 2 cap centres');
  let side = 0,
    cap = 0;
  for (const { p, n } of vertices) {
    if (Math.abs(n[1]) > 0.5) {
      cap++;
      close(n, [0, p[1] ? 1 : -1, 0], `cap at ${p}`);
    } else {
      side++;
      // The smooth side normal is the radial direction at that point.
      close(n, [p[0], 0, p[2]], `side at ${p}`, 1e-5);
    }
  }
  assert.deepEqual([side, cap], [48, 50]);
  assert.equal(verticesOf((await cadWorker(prism(), 0)).parts[0]).length, 146, 'creaseAngle 0: every face flat');
  assert.equal(verticesOf((await cadWorker(prism(), 180)).parts[0]).length, 50, 'creaseAngle 180: one per point');
});

test('creaseAngle outside 0..180 degrees is refused with the fix', async () => {
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(8),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  for (const creaseAngle of [-1, 181, Number.NaN, '40'])
    assert.throws(
      () => parseCADAsync(engine, new TextEncoder().encode(cube).slice().buffer, 'obj', { creaseAngle }),
      /^RangeError: creaseAngle must be a number of degrees from 0 to 180$/,
    );
});

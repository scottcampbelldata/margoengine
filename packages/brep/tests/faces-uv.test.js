// Faces whose loops the (u, v) view of a face once refused, found in public CAD files: an edge over a sphere's pole
// between its vertices (a ball end cut through its pole), and a ruled band closed in v only (a tube as a B-spline).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { Body, Edge, Face, Vertex, checkBody, frameOf, massProperties, sphere, validateBody } = model;
const mm = 0.001,
  close = (a, b, rel, what) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${what}: ${a} against ${b}`);

/** Half a ball, x >= 0: a hemisphere bounded by a great circle through both poles and the disc in that circle. */
function halfBall(r, start) {
  const s = sphere('s', r).faces[0].surface,
    body = new Body('half ball', 'solid'),
    shell = body.shell(),
    // The circle's one vertex at an angle that puts no sample on either pole.
    v = new Vertex('v', [0, r * Math.cos(start), r * Math.sin(start)]),
    rim = new Edge(
      'rim',
      { kind: 'circle', frame: frameOf([0, 0, 0], [1, 0, 0], [0, Math.cos(start), Math.sin(start)]), radius: r },
      v,
      v,
    );
  assert.deepEqual(s.frame.z, [0, 0, 1], 'the sphere poles lie on z');
  shell
    .add(new Face('dome', s, true))
    .loop()
    .use(rim, true);
  shell
    .add(new Face('disc', { kind: 'plane', frame: frameOf([0, 0, 0], [-1, 0, 0], [0, 1, 0]) }, true))
    .loop()
    .use(rim, false);
  return body;
}

test('faces: an edge over a sphere pole between its vertices is followed along the pole line', () => {
  const r = 5 * mm;
  for (const start of [0.3, 1.234, -2.5]) {
    const body = halfBall(r, start);
    assert.deepEqual(validateBody(body), []);
    assert.deepEqual(checkBody(body), []);
    const m = massProperties(body);
    close(m.volume, (2 / 3) * Math.PI * r ** 3, 1e-9, `half ball volume at ${start}`);
    close(m.area, 3 * Math.PI * r * r, 1e-9, `half ball area at ${start}`);
    close(m.centroid[0], (3 / 8) * r, 1e-9, `half ball centroid at ${start}`);
  }
});

/** A circle of radius r at height z as a rational quadratic B-spline's control points and weights. */
function ring(r, z) {
  const w = Math.SQRT1_2,
    xy = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
    ];
  return { points: xy.map(([x, y]) => [r * x, r * y, z]), weights: xy.map((_, k) => (k % 2 ? w : 1)) };
}

/** A round bar: its side a ruled B-spline closed in v only, bounded by two closed circles with no seam between. */
function splineBar(r, h) {
  const lo = ring(r, 0),
    hi = ring(r, h),
    side = {
      kind: 'spline',
      vClosed: true,
      degrees: [1, 2],
      counts: [2, 9],
      knots: [
        [0, 1],
        [0, 0.25, 0.5, 0.75, 1],
      ],
      multiplicities: [
        [2, 2],
        [3, 2, 2, 2, 3],
      ],
      points: lo.points.flatMap((p, j) => [p, hi.points[j]]),
      weights: lo.weights.flatMap((w) => [w, w]),
    },
    body = new Body('bar', 'solid'),
    shell = body.shell(),
    vb = new Vertex('vb', [r, 0, 0]),
    vt = new Vertex('vt', [r, 0, h]),
    bottom = new Edge('bottom', { kind: 'circle', frame: frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]), radius: r }, vb, vb),
    top = new Edge('top', { kind: 'circle', frame: frameOf([0, 0, h], [0, 0, 1], [1, 0, 0]), radius: r }, vt, vt);
  // The spline's own normal (along u x v: up crossed with round) points in, so the side face runs against it.
  const f = shell.add(new Face('side', side, false));
  f.loop().use(bottom, true);
  f.loop().use(top, false);
  shell
    .add(new Face('base', { kind: 'plane', frame: frameOf([0, 0, 0], [0, 0, -1], [1, 0, 0]) }, true))
    .loop()
    .use(bottom, false);
  shell
    .add(new Face('lid', { kind: 'plane', frame: frameOf([0, 0, h], [0, 0, 1], [1, 0, 0]) }, true))
    .loop()
    .use(top, true);
  return body;
}

test('faces: a face on a surface closed in v only, its loops round in v, is read like a cylinder', () => {
  const r = 4 * mm,
    h = 10 * mm,
    body = splineBar(r, h);
  assert.deepEqual(validateBody(body), []);
  assert.deepEqual(checkBody(body), []);
  const m = massProperties(body);
  close(m.volume, Math.PI * r * r * h, 1e-9, 'bar volume');
  close(m.area, 2 * Math.PI * r * (r + h), 1e-9, 'bar area');
  close(m.centroid[2], h / 2, 1e-9, 'bar centroid');
});

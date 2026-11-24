// The body check against tolerant vertices: a vertex's tolerance is a ball round its point (the curves of its edges end
// somewhere in it), so it widens the test of whether an edge touches a face only near that vertex, never along the
// whole edge; and a face no wider than the gap between its curves' ends at such a vertex keeps its own sense. The
// shape is the one round a vertex of abc 00000044 step_007 body 91, built here from its numbers: two parallel
// cylinders of radius 7.5 and 6 mm touching along a line, a plane tangent to the larger, and between the three a thin
// fin (at most 7.4 um across) whose foot is a sliver face along the tangent plane and an edge across the cusp.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { Body, Edge, Face, Vertex, checkBody, frameOf, validateBody } = model;
const mm = 0.001;

/**
 * The fin between cylinder 1 (radius r1 about the z axis), cylinder 2 (radius r2, touching it at the angle asin(sinPhi)
 * from -x towards +y, or `overlap` mm into it) and the plane x = -r1, from z = 0 to 7 mm. At its foot (z = 0) the
 * sliver between the plane and cylinder 1 is a face, closed at its top by the vertex V halfway between them (w / 2 off
 * both curves, its tolerance 1.5 times that, as an import measures it); from V to the line where the cylinders touch,
 * the edge 'cusp' on cylinder 1 closes the fin, off cylinder 2 by up to w (its tolerance 1.5 times that).
 */
function fin({ r1 = 7.5, r2 = 6, sinPhi = 1 / 13.5, overlap = 0 } = {}) {
  const h = 7,
    cosPhi = Math.sqrt(1 - sinPhi * sinPhi),
    d = r1 + r2 - overlap,
    o2 = [-d * cosPhi, d * sinPhi],
    t = [-r1 * cosPhi, r1 * sinPhi],
    yB = o2[1] - Math.sqrt(r2 * r2 - (r1 + o2[0]) ** 2),
    w = r1 - Math.sqrt(r1 * r1 - yB * yB),
    cuspGap = Math.hypot(w - r1 - o2[0], yB - o2[1]) - r2,
    P = (x, y, z) => [x * mm, y * mm, z * mm],
    circle = (c, r, z) => ({ kind: 'circle', frame: frameOf(P(c[0], c[1], z), [0, 0, 1], [1, 0, 0]), radius: r * mm }),
    up = (x, y) => ({ kind: 'line', origin: P(x, y, 0), direction: [0, 0, 1] }),
    along = (z) => ({ kind: 'line', origin: P(-r1, 0, z), direction: [0, 1, 0] }),
    A1 = new Vertex('A1', P(-r1, 0, 0)),
    A2 = new Vertex('A2', P(-r1, 0, h)),
    V = new Vertex('V', P(-r1 + w / 2, yB, 0), 0.75 * w * mm),
    B2 = new Vertex('B2', P(-r1, yB, h)),
    T1 = new Vertex('T1', P(t[0], t[1], 0)),
    T2 = new Vertex('T2', P(t[0], t[1], h)),
    line = new Edge('line', along(0), A1, V),
    arc = new Edge('arc', circle([0, 0], r1, 0), V, A1),
    cusp = new Edge('cusp', circle([0, 0], r1, 0), T1, V, true, 1.5 * Math.abs(cuspGap) * mm),
    a = new Edge('a', up(-r1, 0), A1, A2),
    b = new Edge('b', up(-r1, yB), V, B2),
    c = new Edge('t', up(t[0], t[1]), T1, T2),
    topLine = new Edge('top-line', along(h), A2, B2),
    top1 = new Edge('top-arc1', circle([0, 0], r1, h), T2, A2),
    top2 = new Edge('top-arc2', circle(o2, r2, h), B2, T2),
    body = new Body('fin', 'solid'),
    shell = body.shell(),
    face = (name, surface, sense, uses) => {
      const l = shell.add(new Face(name, surface, sense)).loop();
      for (const [e, forward] of uses) l.use(e, forward);
    },
    plane = (o, z, x) => ({ kind: 'plane', frame: frameOf(o, z, x) }),
    cylinder = (o, r) => ({ kind: 'cylinder', frame: frameOf(P(o[0], o[1], 0), [0, 0, 1], [1, 0, 0]), radius: r * mm });
  face('sliver', plane(P(0, 0, 0), [0, 0, -1], [1, 0, 0]), true, [
    [line, true],
    [arc, true],
  ]);
  face('top', plane(P(0, 0, h), [0, 0, 1], [1, 0, 0]), true, [
    [top1, false],
    [top2, false],
    [topLine, false],
  ]);
  face('plane', plane(P(-r1, 0, 0), [-1, 0, 0], [0, 1, 0]), true, [
    [a, true],
    [topLine, true],
    [b, false],
    [line, false],
  ]);
  face('cylinder1', cylinder([0, 0], r1), false, [
    [arc, false],
    [cusp, false],
    [c, true],
    [top1, true],
    [a, false],
  ]);
  face('cylinder2', cylinder(o2, r2), false, [
    [b, true],
    [top2, true],
    [c, false],
    [cusp, true],
  ]);
  return { body, w, b };
}

test('body check: a vertex tolerance widens the touch test only near the vertex, and a sliver face keeps its sense', () => {
  // Body 91's numbers: the fin is 7.44 um across at V, whose tolerance is then 5.6 um. The edge b (the plane on
  // cylinder 2, up from V) runs 7.43 um off cylinder 1 all its 7 mm, ten times its own tolerance being 1 um: before,
  // ten times V's (56 um) was taken along the whole of it, and it lay inside cylinder 1. The cusp edge lies in the
  // sliver's plane outside the sliver, but the sliver's samples, each edge's from its start, cut across V's gap and
  // wound the other way, so the sliver held everything but itself and the cusp lay inside it.
  const tangent = fin();
  assert.ok(Math.abs(tangent.w - 7.437e-3) < 1e-6, String(tangent.w));
  assert.deepEqual(validateBody(tangent.body), []);
  assert.deepEqual(checkBody(tangent.body), []);
  // Here the cusp edge's middle is 10.04 times its tolerance from the sliver, just past the margin of 10; with larger
  // cylinders it is 27 times.
  const wide = fin({ r1: 30, r2: 30, sinPhi: 0.03 });
  assert.deepEqual(validateBody(wide.body), []);
  assert.deepEqual(checkBody(wide.body), []);
});

test('body check: an edge whose own tolerance takes in a face along its whole length lies inside it', () => {
  // The same fin with b's own tolerance raised to 10 um: then it is within its own reach of cylinder 1 all along, and
  // lies inside that face, which it does not bound.
  const { body, b } = fin();
  b.tolerance = 1e-5;
  assert.deepEqual(validateBody(body), []);
  assert.deepEqual(checkBody(body), [{ name: 'b', problem: 'lies inside cylinder1, which it does not bound' }]);
});

test('body check: cylinders overlapping past the tolerances are reported', () => {
  // Cylinder 2 moved 50 um into cylinder 1: the edges where they were to touch are 50 um off it.
  const { body } = fin({ overlap: 0.05 });
  assert.deepEqual(
    checkBody(body).map((p) => `${p.name}: ${p.problem}`),
    ['T2: 5.00e-5 m off the curve of top-arc2', 'cusp: 5.00e-5 m off the surface of cylinder2', 't: 5.00e-5 m off the surface of cylinder2'],
  );
});

// The body check passes over the faces an edge does not come near (its pieces' boxes against the face's box and, on a
// spline face, against the boxes of its knot spans' control points), samples only the pieces that do, and finds two
// crossing edges of a face through a grid. These tests hold its verdicts to those it gave before (recorded from the
// check that sampled every piece against every face whose box met the edge's), and bound its work on a body of many
// faces by counting spline projections: before, a long edge was sampled against every face along it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { Body, Face, box, checkBody, frameOf, loft, surfaceEvaluator } = model;
const mm = 0.001;

/** A square of half side s (mm) across axis z (or x) at `at` along it, centred on `centre` in the other two, turned. */
function square(name, s, at, turn = 0, alongX = false, centre = [0, 0]) {
  const c = Math.cos(turn),
    si = Math.sin(turn),
    p = (x, y) => {
      const a = x * c - y * si + centre[0],
        b = x * si + y * c + centre[1];
      return alongX ? [at * mm, a * mm, b * mm] : [a * mm, b * mm, at * mm];
    };
  return {
    name,
    start: p(-s, -s),
    normal: alongX ? [1, 0, 0] : [0, 0, 1],
    segments: [p(s, -s), p(s, s), p(-s, s), p(-s, -s)].map((to) => ({ kind: 'line', to })),
  };
}
/** A circle of radius r at height z as four quarter arcs. */
function quarters(r, z) {
  const p = (t) => [r * Math.cos(t) * mm, r * Math.sin(t) * mm, z * mm],
    t0 = (-3 * Math.PI) / 4;
  return {
    name: `q${z}`,
    start: p(t0),
    normal: [0, 0, 1],
    segments: [0, 1, 2, 3].map((j) => ({ kind: 'arc', to: p(t0 + ((j + 1) * Math.PI) / 2), center: [0, 0, z * mm] })),
  };
}
/** One body holding the faces of several, a shell each. */
function together(name, bodies) {
  const out = new Body(name, 'solid');
  for (const b of bodies) {
    const shell = out.shell();
    for (const f of b.faces) shell.add(f);
  }
  return out;
}
/** The body with every face turned over. */
function insideOut(body) {
  const out = new Body(`${body.name}-out`, 'solid'),
    shell = out.shell();
  for (const f of body.faces) {
    const g = shell.add(new Face(f.name, f.surface, !f.sense));
    for (const l of f.loops) {
      const loop = g.loop();
      for (const c of [...l.coedges].reverse()) loop.use(c.edge, !c.forward);
    }
  }
  return out;
}
/** A square loft 8 mm tall at x (mm), its top turned an eighth of a turn: four twisted spline sides. */
const twisted = (name, x, y = 0) =>
  loft(name, [square(`${name}a`, 3, 0, 0, false, [x, y]), square(`${name}b`, 3, 8, Math.PI / 4, false, [x, y])]);
const coneish = () => loft('cs', [quarters(5, 0), square('cs1', 4, 10)]);
/** n twisted lofts 12 mm apart along x, and a twisted beam along them all, 1.7 mm off them (`hit`: one moved into it). */
function row(n, hit) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(twisted(`r${i}`, 12 * i, i === hit ? 5 : 0));
  parts.push(loft('beam', [square('ba', 3, -6, 0, true, [9, 4]), square('bb', 3, 12 * n, Math.PI / 2, true, [9, 4])]));
  return together(`row${n}`, parts);
}

/** checkBody's problems, and how many spline projections it made. */
function counted(body) {
  const spline = body.faces.find((f) => f.surface.kind === 'spline'),
    proto = Object.getPrototypeOf(surfaceEvaluator(spline.surface)),
    parameters = proto.parameters;
  let calls = 0;
  proto.parameters = function (...args) {
    calls++;
    return parameters.apply(this, args);
  };
  try {
    return { problems: checkBody(body), calls };
  } finally {
    proto.parameters = parameters;
  }
}

const passes = (bar, face, at) => ({ name: `bar/edge:${bar}`, problem: `passes through cs/face:${face} at (${at}) m` }),
  lies = (edge, face) => ({ name: edge, problem: `lies inside ${face}, which it does not bound` });

test('body check culling: the same verdicts as sampling every piece, on valid and defective bodies with spline faces', () => {
  const cases = [
    [twisted('tw', 0), []],
    [coneish(), []],
    [
      together('lumps', [twisted('a', 0), twisted('b', 2)]),
      [
        lies('a/edge:section:1:e0', 'b/face:end'),
        lies('a/edge:section:0:e1', 'b/face:start'),
        lies('a/edge:section:1:e1', 'b/face:end'),
        lies('b/edge:section:1:e2', 'a/face:end'),
        lies('b/edge:section:0:e3', 'a/face:start'),
        lies('b/edge:section:1:e3', 'a/face:end'),
      ],
    ],
    [
      insideOut(coneish()),
      [
        {
          name: 'cs/face:s0/e0',
          problem: 'its shell faces into its material (it encloses -7.141e-7 m^3, not more than 0)',
        },
      ],
    ],
    [
      together('pierced', [
        coneish(),
        box('bar', [20 * mm, 2 * mm, 2 * mm], frameOf([-10 * mm, -1 * mm, 4 * mm], [0, 0, 1], [1, 0, 0])),
      ]),
      [
        passes('-z:+y', 's0/e1', '0.00453818, 0.00100000, 0.00400000'),
        passes('-z:+y', 's0/e3', '-0.00453818, 0.00100000, 0.00400000'),
        passes('-z:-y', 's0/e1', '0.00453818, -0.00100000, 0.00400000'),
        passes('-z:-y', 's0/e3', '-0.00453818, -0.00100000, 0.00400000'),
        passes('+z:-y', 's0/e1', '0.00435838, -0.00100000, 0.00600000'),
        passes('+z:-y', 's0/e3', '-0.00435838, -0.00100000, 0.00600000'),
        passes('+z:+y', 's0/e1', '0.00435838, 0.00100000, 0.00600000'),
        passes('+z:+y', 's0/e3', '-0.00435838, 0.00100000, 0.00600000'),
      ],
    ],
    [row(16), []],
  ];
  for (const [body, expected] of cases) assert.deepEqual(checkBody(body), expected, body.name);
  // A loft of the row moved into the beam: its edges and the beam's pass through each other's spline sides.
  const hit = checkBody(row(16, 7));
  assert.ok(hit.length > 0);
  assert.ok(
    hit.every((p) => /^(r7|beam)\/edge:.* passes through (r7|beam)\/face:/.test(`${p.name} ${p.problem}`)),
    JSON.stringify(hit),
  );
  assert.ok(hit.some((p) => p.name.startsWith('r7/')) && hit.some((p) => p.name.startsWith('beam/')));
});

test('body check culling: work on a row of many spline faces grows with the faces, not with faces times edges', () => {
  // One loft alone, then 16 in a row beside a beam as long as the row: each edge is sampled only against the faces it
  // comes near. Sampling every piece against every face whose box met the edge's took 92522 projections for the row
  // (6.7 times as many as for 4 lofts); the culled check, 27521.
  const one = counted(twisted('tw', 0)).calls,
    four = counted(row(4)),
    sixteen = counted(row(16));
  assert.deepEqual(four.problems, []);
  assert.deepEqual(sixteen.problems, []);
  assert.ok(sixteen.calls <= 1.5 * 17 * one, `${sixteen.calls} projections for 17 lofts, one alone ${one}`);
  assert.ok(sixteen.calls <= 3.5 * four.calls, `${sixteen.calls} projections for 16 lofts, ${four.calls} for 4`);
});

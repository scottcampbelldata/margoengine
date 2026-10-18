import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const {
  Body,
  Edge,
  Face,
  Vertex,
  bodiesFromSTEP,
  bodiesToSTEP,
  boolean,
  box,
  checkBody,
  cylinder,
  extrude,
  fillet,
  frameOf,
  revolve,
  sphere,
  torus,
  validateBody,
} = model;
const mm = 0.001,
  at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]),
  line = (x, y) => ({ kind: 'line', to: [x * mm, y * mm, 0] }),
  profile = (points) => ({
    name: 'p',
    start: [points[0][0] * mm, points[0][1] * mm, 0],
    normal: [0, 0, 1],
    segments: [...points.slice(1), points[0]].map(([x, y]) => line(x, y)),
  });

/** The body with every face turned over: each face's sense flipped and its loops run backwards. */
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

/** One body holding the faces of several, in one shell or a shell each. */
function together(name, bodies, oneShell) {
  const out = new Body(name, 'solid');
  let shell = out.shell();
  bodies.forEach((b, i) => {
    if (i && !oneShell) shell = out.shell();
    for (const f of b.faces) shell.add(f);
  });
  return out;
}

test('body check: what the modeler makes passes every check', () => {
  const cube = () => box('a', [10 * mm, 10 * mm, 10 * mm]),
    bodies = [
      cube(),
      cylinder('c', 5 * mm, 10 * mm),
      sphere('s', 5 * mm),
      torus('t', 10 * mm, 3 * mm),
      boolean('p', 'subtract', box('b', [20 * mm, 20 * mm, 10 * mm]), cylinder('h', 3 * mm, 20 * mm, at(10, 10, -5))),
      boolean(
        'hollow',
        'subtract',
        box('b', [10 * mm, 10 * mm, 10 * mm]),
        box('v', [4 * mm, 4 * mm, 4 * mm], at(3, 3, 3)),
      ),
      boolean('h', 'intersect', sphere('s', 5 * mm), box('b', [20 * mm, 20 * mm, 10 * mm], at(-10, -10, 0))),
      fillet(
        'rb',
        cube(),
        cube().edges.map((e) => e.name),
        2 * mm,
      ),
      extrude(
        'l',
        profile([
          [0, 0],
          [20, 0],
          [20, 5],
          [5, 5],
          [5, 20],
          [0, 20],
        ]),
        [0, 0, 5 * mm],
      ),
      revolve(
        'k',
        {
          name: 'r',
          start: [2 * mm, 0, 0],
          normal: [0, -1, 0],
          segments: [
            { kind: 'line', to: [6 * mm, 0, 0] },
            { kind: 'line', to: [4 * mm, 0, 8 * mm] },
            { kind: 'line', to: [2 * mm, 0, 8 * mm] },
            { kind: 'line', to: [2 * mm, 0, 0] },
          ],
        },
        { origin: [0, 0, 0], direction: [0, 0, 1] },
      ),
    ];
  for (const b of bodies) assert.deepEqual(checkBody(b), [], b.name);
  // Imported back from STEP, the cavity comes back as its own shell inside the outer one.
  const [hollow] = bodiesFromSTEP(parseSTEP(bodiesToSTEP([bodies[5]]))).bodies;
  assert.equal(hollow.shells.length, 2);
  assert.equal(hollow.shells.filter((s) => s.outer === hollow.shells[0]).length, 1);
  assert.deepEqual(checkBody(hollow), []);
});

test('body check: a solid turned inside out, a shell in two pieces, an odd Euler count, overlapping lumps', () => {
  // Every edge still used once each way, but the shell faces into the material.
  const out = checkBody(insideOut(box('a', [10 * mm, 10 * mm, 10 * mm])));
  assert.equal(out.length, 1);
  assert.match(out[0].problem, /faces into its material/);

  // Two boxes apart, listed as one shell.
  const apart = validateBody(together('two', [box('a', [mm, mm, mm]), box('b', [mm, mm, mm], at(5, 0, 0))], true));
  assert.equal(apart.length, 1);
  assert.match(apart[0].problem, /2 pieces that share no edge/);

  // A torus face bounded only by one meridian run both ways: every edge used twice, but no closed surface counts so.
  const t = torus('t', 10 * mm, 3 * mm).faces[0].surface,
    v = new Vertex('v', [13 * mm, 0, 0]),
    meridian = new Edge(
      'm',
      { kind: 'circle', frame: frameOf([10 * mm, 0, 0], [0, 1, 0], [1, 0, 0]), radius: 3 * mm },
      v,
      v,
    ),
    odd = new Body('odd', 'solid'),
    face = odd.shell().add(new Face('f', t, true)),
    loop = face.loop();
  loop.use(meridian, true);
  loop.use(meridian, false);
  const euler = validateBody(odd);
  assert.equal(euler.length, 1);
  assert.match(euler[0].problem, /V - E \+ 2F - L = 1/);

  // Two overlapping boxes as two shells of one solid: the edges of each pass through the faces of the other.
  const lumps = checkBody(
    together('lumps', [box('a', [10 * mm, 10 * mm, 10 * mm]), box('b', [10 * mm, 4 * mm, 4 * mm], at(5, 3, 3))], false),
  );
  assert.ok(lumps.length > 0);
  assert.ok(
    lumps.every((p) => /passes through/.test(p.problem)),
    JSON.stringify(lumps),
  );
});

test('body check: a profile crossing itself is refused, and a face whose edges cross is found', () => {
  // A bow tie: (10, 0) to (0, 10) crosses (4, 10) to (0, 0).
  assert.throws(
    () =>
      extrude(
        'x',
        profile([
          [0, 0],
          [10, 0],
          [0, 10],
          [4, 10],
        ]),
        [0, 0, 5 * mm],
      ),
    /profile p crosses or touches itself/,
  );
  // A profile touching itself at a point that is not a corner, and one running back along itself.
  assert.throws(
    () =>
      extrude(
        'x',
        profile([
          [0, 0],
          [10, 0],
          [10, 10],
          [5, 0.000_000_1],
          [0, 10],
        ]),
        [0, 0, 5 * mm],
      ),
    /crosses or touches itself/,
  );
  assert.throws(
    () =>
      extrude(
        'x',
        profile([
          [0, 0],
          [10, 0],
          [10, 10],
          [10, 5],
          [0, 10],
        ]),
        [0, 0, 5 * mm],
      ),
    /turns straight back on itself|crosses or touches itself/,
  );
  // The same bow tie built face by face: its top and bottom loops cross themselves.
  const p = [
      [0, 0],
      [10, 0],
      [0, 10],
      [4, 10],
    ].map(([x, y]) => [x * mm, y * mm, 0]),
    h = 5 * mm,
    body = new Body('bow', 'solid'),
    shell = body.shell(),
    lo = p.map((q, k) => new Vertex(`lo${k}`, q)),
    hi = p.map((q, k) => new Vertex(`hi${k}`, [q[0], q[1], h])),
    seg = (a, b, n) => new Edge(n, { kind: 'line', origin: a.point, direction: unitOf(a.point, b.point) }, a, b),
    bottom = p.map((_, k) => seg(lo[k], lo[(k + 1) % 4], `b${k}`)),
    top = p.map((_, k) => seg(hi[k], hi[(k + 1) % 4], `t${k}`)),
    side = p.map((_, k) => seg(lo[k], hi[k], `s${k}`)),
    plane = (o, z, x) => ({ kind: 'plane', frame: frameOf(o, z, x) });
  const b = shell.add(new Face('bottom', plane(p[0], [0, 0, -1], [1, 0, 0]), true)).loop();
  for (let k = 3; k >= 0; k--) b.use(bottom[k], false);
  const tl = shell.add(new Face('top', plane([0, 0, h], [0, 0, 1], [1, 0, 0]), true)).loop();
  for (let k = 0; k < 4; k++) tl.use(top[k], true);
  for (let k = 0; k < 4; k++) {
    const d = unitOf(p[k], p[(k + 1) % 4]),
      l = shell.add(new Face(`side${k}`, plane(p[k], [d[1], -d[0], 0], d), true)).loop();
    l.use(bottom[k], true);
    l.use(side[(k + 1) % 4], true);
    l.use(top[k], false);
    l.use(side[k], false);
  }
  assert.deepEqual(validateBody(body), []);
  const problems = checkBody(body).filter((x) => /cross at/.test(x.problem));
  assert.deepEqual(problems.map((x) => x.name).sort(), ['bottom', 'top']);
});

function unitOf(a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    l = Math.hypot(...d);
  return d.map((x) => x / l);
}

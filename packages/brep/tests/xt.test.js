import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXT, readXT, tessellateSTEP, xtToSTEP } from '../dist/index.js';

/**
 * A sheet body: one planar disc of radius 10 mm bounded by a ring edge on a circle, coloured orange, as a Parasolid
 * text transmit file. With `embedded`, every node type's first node says its layout is the base schema's (255), as
 * files from Parasolid V14 on do.
 */
function disc(embedded) {
  return transmit(
    [
      [12, '1 10 0 0 0 0 0 0 1e3 1e-8 0 0 0 1 0 3 1 2 3 4 0 5 6 0 '],
      [13, '2 1 0 1 0 9 0 0 5 9 '],
      [50, '3 2 0 9 0 0 0 +0 0 0 0 0 1 1 0 0 '],
      [31, '4 3 0 6 0 0 0 +0 0 0 0 0 1 1 0 0 .01 '],
      [19, '5 4 0 1 0 0 2 V'],
      [16, '6 5 0 ?7 0 0 4 0 0 1 '],
      [17, '7 0 8 7 7 0 10 6 0 0 +'],
      [15, '8 6 0 7 9 0 '],
      [14, '9 7 11 ?0 0 8 2 3 +0 0 0 0 2 '],
      [17, '10 0 0 0 0 0 7 6 0 0 -'],
      [81, '1 11 8 12 9 0 0 0 0 14 '],
      [80, '1 12 0 13 8001 0 0 0 0 3 5 0 0 0 FFFFTFTFFFFFFF2 '],
      [79, '15 13 SDL/TYSA_COLOUR'],
      [83, '3 14 1 .5 0 '],
    ],
    embedded,
  );
}

/**
 * A sheet body: one rolling-ball blend face of radius 2 mm and length 10 mm in the corner between the planes z = 0
 * and x = 0, its spine the line x = z = 2 mm, bounded by two lines where the ball touches the planes and two
 * quarter circles at its ends.
 */
const fillet = () =>
  transmit(
    [
      [12, '1 40 0 0 0 0 0 0 1e3 1e-8 0 0 0 1 0 3 1 2 3 14 0 4 10 18 '],
      [13, '2 1 0 1 0 5 0 0 4 5 '],
      [56, '3 2 0 5 0 0 0 +R7 8 9 .002 .002 1 1 0 0 0 0 '],
      [19, '4 3 0 1 0 0 2 V'],
      [14, '5 4 0 ?0 0 6 2 3 +0 0 0 0 2 '],
      [15, '6 5 0 26 5 0 '],
      [50, '7 6 0 1 0 0 0 +0 0 0 0 0 1 1 0 0 '],
      [50, '8 7 0 1 0 0 0 +0 0 0 1 0 0 0 1 0 '],
      [30, '9 8 0 1 0 0 0 +.002 0 .002 0 1 0 '],
      [16, '10 9 0 ?26 0 11 14 0 0 1 '],
      [16, '11 10 0 ?27 10 12 15 0 0 1 '],
      [16, '12 11 0 ?32 11 13 16 0 0 1 '],
      [16, '13 12 0 ?33 12 0 17 0 0 1 '],
      [30, '14 13 0 10 0 0 0 +.002 0 0 0 1 0 '],
      [31, '15 14 0 11 0 0 0 +.002 .01 .002 0 1 0 0 0 -1 .002 '],
      [30, '16 15 0 12 0 0 0 +0 0 .002 0 1 0 '],
      [31, '17 16 0 13 0 0 0 +.002 0 .002 0 1 0 0 0 -1 .002 '],
      [18, '18 17 0 26 0 19 22 ?1 '],
      [18, '19 18 0 27 18 20 23 ?1 '],
      [18, '20 19 0 28 19 21 24 ?1 '],
      [18, '21 20 0 29 20 0 25 ?1 '],
      [29, '22 21 0 18 23 0 .002 0 0 '],
      [29, '23 22 0 19 24 22 .002 .01 0 '],
      [29, '24 23 0 20 25 23 0 .01 .002 '],
      [29, '25 24 0 21 0 24 0 0 .002 '],
      [17, '26 0 6 27 29 19 30 10 0 0 +'],
      [17, '27 0 6 28 26 20 31 11 0 0 +'],
      [17, '28 0 6 29 27 21 32 12 0 0 -'],
      [17, '29 0 6 26 28 18 33 13 0 0 -'],
      [17, '30 0 0 0 0 18 26 10 0 0 -'],
      [17, '31 0 0 0 0 19 27 11 0 0 -'],
      [17, '32 0 0 0 0 20 28 12 0 0 +'],
      [17, '33 0 0 0 0 21 29 13 0 0 +'],
    ],
    false,
  );

/**
 * A sheet body: a quarter of the concave fillet of radius 2 mm round a cylindrical boss of radius 10 mm standing on the
 * plane z = 0 (x and y from 0 up), its spine the circle of radius 12 mm at z = 2 mm, running counter-clockwise as
 * Parasolid runs it (the plane's normal crossed with the cylinder's). The spine is an intersection curve whose chart
 * has only five points, so its chords stray up to 0.23 mm from the ball centres. As a rolling-ball blend its supports
 * are the plane and the cylinder; with `cliff`, it is a cliff-edge blend: the plane and a blend of range [0,0] whose
 * spine is the boss's top edge (the circle of radius 10 mm at z = 2 mm), which the ball touches.
 */
const bossFillet = (cliff) =>
  transmit(
    [
      [12, '1 40 0 0 0 0 0 0 1e3 1e-8 0 0 0 1 0 3 1 2 3 14 0 4 10 18 '],
      [13, '2 1 0 1 0 5 0 0 4 5 '],
      [56, `3 2 0 5 0 0 0 +${cliff ? 'E7 35' : 'R7 8'} 9 .002 .002 1 1 0 0 0 0 `],
      [19, '4 3 0 1 0 0 2 V'],
      [14, '5 4 0 ?0 0 6 2 3 +0 0 0 0 2 '],
      [15, '6 5 0 26 5 0 '],
      [50, '7 6 0 1 0 0 0 +0 0 0 0 0 1 1 0 0 '],
      [51, '8 7 0 1 0 0 0 +0 0 0 0 0 1 .01 1 0 0 '],
      [38, '9 8 0 1 0 0 0 +7 8 34 0 0 '],
      [16, '10 9 0 ?26 0 11 14 0 0 1 '],
      [16, '11 10 0 ?27 10 12 15 0 0 1 '],
      [16, '12 11 0 ?32 11 13 16 0 0 1 '],
      [16, '13 12 0 ?33 12 0 17 0 0 1 '],
      [31, '14 13 0 10 0 0 0 +0 0 0 0 0 1 1 0 0 .012 '],
      [31, '15 14 0 11 0 0 0 +0 .012 .002 -1 0 0 0 0 -1 .002 '],
      [31, '16 15 0 12 0 0 0 +0 0 .002 0 0 1 1 0 0 .01 '],
      [31, '17 16 0 13 0 0 0 +.012 0 .002 0 1 0 0 0 -1 .002 '],
      [18, '18 17 0 26 0 19 22 ?1 '],
      [18, '19 18 0 27 18 20 23 ?1 '],
      [18, '20 19 0 28 19 21 24 ?1 '],
      [18, '21 20 0 29 20 0 25 ?1 '],
      [29, '22 21 0 18 23 0 .012 0 0 '],
      [29, '23 22 0 19 24 22 0 .012 0 '],
      [29, '24 23 0 20 25 23 0 .01 .002 '],
      [29, '25 24 0 21 0 24 .01 0 .002 '],
      [17, '26 0 6 27 29 19 30 10 0 0 +'],
      [17, '27 0 6 28 26 20 31 11 0 0 +'],
      [17, '28 0 6 29 27 21 32 12 0 0 -'],
      [17, '29 0 6 26 28 18 33 13 0 0 -'],
      [17, '30 0 0 0 0 18 26 10 0 0 -'],
      [17, '31 0 0 0 0 19 27 11 0 0 -'],
      [17, '32 0 0 0 0 20 28 12 0 0 +'],
      [17, '33 0 0 0 0 21 29 13 0 0 +'],
      [
        40,
        '5 34 0 1 5 1e-6 .01 0 0 .012 0 .002 .0110865543901 .00459220118838 .002 .00848528137424 .00848528137424 .002 .00459220118838 .0110865543901 .002 0 .012 .002 ',
      ],
      ...(cliff
        ? [
            [56, '35 36 0 0 0 0 0 +R7 8 36 0 0 1 1 0 0 0 0 '],
            [31, '36 37 0 35 0 0 0 +0 0 .002 0 0 1 1 0 0 .01 '],
          ]
        : []),
    ],
    false,
  );

/**
 * Checks a blend face's mesh: every vertex on the ball's sweep (`off` gives a vertex's distance from the spine), the
 * area, and every triangle facing away from the spine (Parasolid's natural normal for a blend, the face being
 * positive; `centre` gives the spine point nearest a point).
 */
function checkBlend(mesh, off, centre, exact) {
  assert.deepEqual(mesh.failures, []);
  const p = mesh.positions,
    t = mesh.indices;
  let area = 0,
    worst = 0,
    inward = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      m = [0, 1, 2].map((i) => (a[i] + b[i] + c[i]) / 3),
      s = centre(m);
    area += Math.hypot(...n) / 2;
    if (n[0] * (m[0] - s[0]) + n[1] * (m[1] - s[1]) + n[2] * (m[2] - s[2]) <= 0) inward++;
  }
  for (let i = 0; i < p.length; i += 3) worst = Math.max(worst, Math.abs(off(p[i], p[i + 1], p[i + 2]) - 0.002));
  assert.ok(worst < 2e-6, `off the round by ${worst}`);
  assert.equal(inward, 0, `${inward} triangles face the spine`);
  assert.ok(Math.abs(area - exact) < 2e-3 * exact, `area ${area} vs ${exact}`);
}

/** A text transmit file of the given nodes ([type, data after the type]). */
function transmit(nodes, embedded) {
  const seen = new Set(),
    body = nodes
      .map(([type, rest]) => {
        const first = embedded && !seen.has(type);
        seen.add(type);
        return `${type} ${first ? '255 ' : ''}${rest}`;
      })
      .join('');
  const schema = embedded ? 'SCH_1400000_14000_13006' : 'SCH_1300000_13006';
  // Records of about 80 characters; a break may fall anywhere, a separating space starting the next line.
  const data = `T51 : TRANSMIT FILE created by modeller version 1300000${schema.length} ${schema}${embedded ? '185 ' : ''}0 ${body}1 0 `;
  // A record never ends in a separating space (trailing spaces are dropped on reading): it starts the next one.
  const records = [];
  for (let rest = data; rest.length; ) {
    let n = Math.min(80, rest.length);
    while (n > 1 && n < rest.length && rest[n - 1] === ' ') n--;
    records.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return `**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************
**PARASOLID !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~0123456789**************************
**PART1;MC=test;FORMAT=text;GUISE=transmit;
**PART2;SCH=${schema};USFLD_SIZE=0;
**PART3;
**END_OF_HEADER*****************************************************************
${records.join('\n')}
`;
}

test('Parasolid XT: a text transmit file reads into nodes, with or without embedded schema flags', () => {
  for (const embedded of [false, true]) {
    const xt = readXT(disc(embedded));
    assert.equal(xt.schema, embedded ? 'SCH_1400000_14000_13006' : 'SCH_1300000_13006');
    assert.equal(xt.nodes.size, 14);
    assert.equal(xt.root.name, 'BODY');
    assert.deepEqual(xt.nodes.get(4).fields.centre, [0, 0, 0]);
    assert.equal(xt.nodes.get(4).fields.radius, 0.01);
    assert.equal(xt.nodes.get(6).fields.tolerance, null);
    assert.equal(xt.nodes.get(13).fields.string, 'SDL/TYSA_COLOUR');
  }
});

test('Parasolid XT: the disc converts to a coloured sheet in metres and meshes to its area', () => {
  const conversion = xtToSTEP(disc(true));
  assert.deepEqual(conversion.warnings, []);
  const model = parseXT(disc(true));
  assert.deepEqual(
    model.bodies.map((b) => [b.kind, b.faces.length, b.unit]),
    [['shell', 1, 1]],
  );
  assert.deepEqual([...model.faceColors.values()], [[1, 0.5, 0, 1]]);
  const [mesh] = tessellateSTEP(model, { deflection: 1e-7 });
  assert.deepEqual(mesh.failures, []);
  let area = 0;
  const p = mesh.positions,
    t = mesh.indices;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  assert.ok(Math.abs(area - Math.PI * 1e-4) < 1e-3 * Math.PI * 1e-4, `area ${area}`);
});

test('Parasolid XT: malformed input throws a TypeError that says where', () => {
  assert.throws(() => readXT('**END_OF_HEADER***\nX'), { name: 'TypeError', message: /no T flag/ });
  assert.throws(() => readXT(disc(false).replaceAll('SCH_1300000_13006', 'SCH_1300000_1300X')), {
    name: 'TypeError',
    message: /schema name/,
  });
});

test('Parasolid XT: a rolling-ball blend is built from its spine and supports as an exact quarter-round', () => {
  const conversion = xtToSTEP(fillet());
  assert.deepEqual(conversion.warnings, []);
  const [mesh] = tessellateSTEP(parseXT(fillet()), { deflection: 1e-7 });
  // Every vertex lies on the cylinder of radius 2 mm about the spine.
  checkBlend(
    mesh,
    (x, _y, z) => Math.hypot(x - 0.002, z - 0.002),
    ([, y]) => [0.002, y, 0.002],
    (Math.PI / 2) * 0.002 * 0.01,
  );
});

test('Parasolid XT: blends on a coarsely charted spine, rolling-ball and cliff-edge, sweep the exact round', () => {
  const exact = (6 * Math.PI ** 2 - 2 * Math.PI) * 1e-6;
  for (const cliff of [false, true]) {
    assert.deepEqual(xtToSTEP(bossFillet(cliff)).warnings, []);
    const [mesh] = tessellateSTEP(parseXT(bossFillet(cliff)), { deflection: 1e-7 });
    // Every vertex lies on the torus swept by the ball round the boss.
    checkBlend(
      mesh,
      (x, y, z) => Math.hypot(Math.hypot(x, y) - 0.012, z - 0.002),
      ([x, y]) => {
        const r = Math.hypot(x, y);
        return [(0.012 * x) / r, (0.012 * y) / r, 0.002];
      },
      exact,
    );
  }
});

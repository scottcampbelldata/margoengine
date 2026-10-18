import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXT, readXT, tessellateSTEP, xtToSTEP } from '../dist/index.js';

/**
 * A sheet body: one planar disc of radius 10 mm bounded by a ring edge on a circle, coloured orange, as a Parasolid
 * text transmit file. With `embedded`, every node type's first node says its layout is the base schema's (255), as
 * files from Parasolid V14 on do.
 */
function disc(embedded) {
  const nodes = [
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
  ];
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSAT, satToSTEP, tessellateSTEP } from '../dist/index.js';

/** A closed cylinder, radius 5 and height 8 units, in the ACIS 7.0 layout; its side face is red. */
const cylinder = (mmPerUnit) => `700 0 1 0
16 Margo test suite 12 ACIS 7.0 NT 24 Sat Oct 17 12:00:00 2026
${mmPerUnit} 9.9999999999999995e-07 1e-10
body $-1 -1 $-1 $1 $-1 $-1 #
lump $-1 -1 $-1 $-1 $2 $0 #
shell $-1 -1 $-1 $-1 $-1 $3 $-1 $1 #
face $4 -1 $-1 $5 $6 $2 $-1 $7 forward single #
rgb_color-st-attrib $-1 -1 $-1 $-1 $3 1 0 0 #
face $-1 -1 $-1 $8 $9 $2 $-1 $10 reversed single #
loop $-1 -1 $-1 $11 $12 $3 #
cone-surface $-1 -1 $-1 0 0 0 0 0 1 5 0 0 1 I I 0 1 5 forward I I I I #
face $-1 -1 $-1 $-1 $13 $2 $-1 $14 forward single #
loop $-1 -1 $-1 $-1 $15 $5 #
plane-surface $-1 -1 $-1 0 0 0 0 0 1 1 0 0 forward_v I I I I #
loop $-1 -1 $-1 $-1 $16 $3 #
coedge $-1 -1 $-1 $12 $12 $15 $17 forward $6 $-1 #
loop $-1 -1 $-1 $-1 $18 $8 #
plane-surface $-1 -1 $-1 0 0 8 0 0 1 1 0 0 forward_v I I I I #
coedge $-1 -1 $-1 $15 $15 $12 $17 reversed $9 $-1 #
coedge $-1 -1 $-1 $16 $16 $18 $19 reversed $11 $-1 #
edge $-1 -1 $-1 $20 0 $20 6.2831853071795862 $12 $21 forward @7 unknown #
coedge $-1 -1 $-1 $18 $18 $16 $19 forward $13 $-1 #
edge $-1 -1 $-1 $22 0 $22 6.2831853071795862 $16 $23 forward @7 unknown #
vertex $-1 -1 $-1 $17 $24 #
ellipse-curve $-1 -1 $-1 0 0 0 0 0 1 5 0 0 1 I I #
vertex $-1 -1 $-1 $19 $25 #
ellipse-curve $-1 -1 $-1 0 0 8 0 0 1 5 0 0 1 I I #
point $-1 -1 $-1 5 0 0 #
point $-1 -1 $-1 5 0 8 #
End-of-ACIS-data
`;

/** Volume, area and open edges of a mesh in its own units, vertices joined where positions are equal. */
function measure(m) {
  const p = m.positions,
    t = m.indices,
    ids = new Map(),
    weld = (i) => {
      const key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    },
    directed = new Map();
  let volume = 0,
    area = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    const w = [t[k], t[k + 1], t[k + 2]].map(weld);
    for (const [x, y] of [
      [w[0], w[1]],
      [w[1], w[2]],
      [w[2], w[0]],
    ])
      directed.set(`${x},${y}`, (directed.get(`${x},${y}`) ?? 0) + 1);
  }
  let open = 0;
  for (const [key, count] of directed) {
    const [x, y] = key.split(',');
    if (count !== 1 || directed.get(`${y},${x}`) !== 1) open++;
  }
  return { volume, area, open };
}

test('SAT: a closed cylinder from ACIS 7.0 records meshes as a closed solid with its colour, in millimetres', () => {
  const conversion = satToSTEP(cylinder(1));
  assert.equal(conversion.version, 700);
  assert.deepEqual(conversion.warnings, []);
  const model = parseSAT(cylinder(1));
  assert.deepEqual(
    model.bodies.map((b) => [b.kind, b.faces.length, b.unit]),
    [['solid', 3, 0.001]],
  );
  assert.deepEqual(model.census.surfaces, { CYLINDRICAL_SURFACE: 1, PLANE: 2 });
  assert.deepEqual([...model.faceColors.values()], [[1, 0, 0, 1]]);
  const [mesh] = tessellateSTEP(model, { deflection: 1e-6 }),
    r = measure(mesh);
  assert.deepEqual(mesh.failures, []);
  assert.equal(r.open, 0);
  assert.ok(Math.abs(r.volume - Math.PI * 25 * 8) < 0.01 * Math.PI * 25 * 8, `volume ${r.volume}`);
  assert.ok(Math.abs(r.area - (Math.PI * 80 + Math.PI * 50)) < 0.01 * Math.PI * 130, `area ${r.area}`);
});

test("SAT: the header's millimetres per unit scale the model", () => {
  const [mesh] = tessellateSTEP(parseSAT(cylinder(2)), { deflection: 2e-6 });
  assert.ok(Math.abs(measure(mesh).volume - 8 * Math.PI * 25 * 8) < 0.01 * 8 * Math.PI * 25 * 8);
});

test('SAT: malformed input throws a TypeError that says what is wrong', () => {
  assert.throws(() => satToSTEP('not a sat file'), { name: 'TypeError', message: /SAT header/ });
  assert.throws(() => satToSTEP(cylinder(1).replace('lump $-1 -1 $-1 $-1 $2 $0 #', 'lump $-1 -1 $-1 $-1 $99 $0 #')), {
    name: 'TypeError',
    message: /\$99/,
  });
});

// parse3MFBoolean's surfaces against the 3MF Boolean Operations Extension specification
// (https://github.com/3MFConsortium/spec_booleans, chapter 2): operations in order on the base, transforms first, and
// each face keeping the property of the surface it came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MFBoolean } from '../dist/threemf-boolean.js';
import { box, closed, meshXML, volume, zip } from './threemf-surface.js';

const NS = 'xmlns:bo="http://schemas.3mf.io/3dmanufacturing/booleanoperations/2023/07"';
const file = { units: 'file' };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} is not ${expected}`);
const move = (x, y, z) => `transform="1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}"`;
const mesh = (id, low, high, attributes = '') =>
  `<object id="${id}" type="model" ${attributes}>${meshXML(box(low, high))}</object>`;
const shape = (id, base, operation, operands, attributes = '') =>
  `<object id="${id}" type="model"><bo:booleanshape objectid="${base}" operation="${operation}" ${attributes}>${operands
    .map(([object, transform = '']) => `<bo:boolean objectid="${object}" ${transform}/>`)
    .join('')}</bo:booleanshape></object>`;
const pack = (resources, item) =>
  zip({
    '3D/3dmodel.model': `<model unit="millimeter" ${NS} requiredextensions="bo"><resources>${resources}</resources><build><item objectid="${item}"/></build></model>`,
  });
const materials =
  '<basematerials id="1"><base name="r" displaycolor="#FF0000"/><base name="g" displaycolor="#00FF00"/></basematerials>';
// A red cube of side 10 and a green cube of side 4, moved to overlap one corner by 2 or the middle of a face.
const solids =
  materials +
  mesh(2, [0, 0, 0], [10, 10, 10], 'pid="1" pindex="0"') +
  mesh(3, [0, 0, 0], [4, 4, 4], 'pid="1" pindex="1"') +
  mesh(4, [0, 0, 0], [4, 4, 4]);

test('union, difference and intersection apply the operands in order, transforms first', async () => {
  const corner = [[3, move(8, 8, 8)]];
  for (const [operation, expected] of [
    ['union', 1000 + 64 - 8],
    ['difference', 1000 - 8],
    ['intersection', 8],
  ]) {
    const read = await parse3MFBoolean(pack(solids + shape(9, 2, operation, corner), 9), file);
    near(volume(read), expected);
    closed(read);
    assert.equal(read.shapes[0].operation, operation);
  }
  // Two holes, one of them reaching the other: base - (a U b). The base is moved by its own transform first.
  const two = await parse3MFBoolean(
    pack(
      solids +
        shape(
          9,
          2,
          'difference',
          [
            [3, move(8, 8, 8)],
            [3, move(10, 10, 8)],
          ],
          move(2, 2, 0),
        ),
      9,
    ),
    file,
  );
  near(volume(two), 1000 - 4 * 4 * 2);
  closed(two);
  // A shape may be the base of another.
  const nested = await parse3MFBoolean(
    pack(solids + shape(8, 2, 'difference', corner) + shape(9, 8, 'union', [[3, move(8, 8, 8)]]), 9),
    file,
  );
  near(volume(nested), 1000 + 64 - 8);
  closed(nested);
});

test('a cut face takes the property of the subtracting object, or none', async () => {
  const hole = [[3, move(3, 3, 8)]],
    painted = await parse3MFBoolean(pack(solids + shape(9, 2, 'difference', hole), 9), file),
    colours = painted.groups.map((g) => String(g.color)).sort();
  assert.deepEqual(colours, ['0,1,0,1', '1,0,0,1']);
  // The pocket's floor and walls are green: 16 + 4 * 4 * 2 square millimetres.
  let area = 0;
  for (const g of painted.groups.filter((x) => x.color[1] === 1))
    for (let t = g.start; t < g.start + g.count; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => {
          const v = painted.indices[t + k];
          return painted.positions.subarray(v * 3, v * 3 + 3);
        }),
        u = [0, 1, 2].map((i) => b[i] - a[i]),
        w = [0, 1, 2].map((i) => c[i] - a[i]);
      area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
  near(area, 16 + 32);
  const bare = await parse3MFBoolean(pack(solids + shape(9, 2, 'difference', [[4, move(3, 3, 8)]]), 9), file);
  assert.ok(bare.groups.some((g) => g.color === undefined));
  assert.ok(bare.groups.some((g) => String(g.color) === '1,0,0,1'));
});

test('a mirrored operand, evaluate: false and refused inputs', async () => {
  const mirrored = [[3, 'transform="-1 0 0 0 1 0 0 0 1 12 8 8"']],
    read = await parse3MFBoolean(pack(solids + shape(9, 2, 'union', mirrored), 9), file);
  near(volume(read), 1000 + 64 - 8);
  closed(read);
  const input = pack(solids + shape(9, 2, 'union', mirrored), 9),
    unevaluated = await parse3MFBoolean(input, { evaluate: false });
  assert.equal(unevaluated.indices.length, 0);
  await assert.rejects(parse3MFBoolean(input, { maxTriangles: 10 }), { code: 'limit' });
  await assert.rejects(
    parse3MFBoolean(pack(solids + shape(8, 2, 'union', mirrored) + shape(9, 2, 'union', [[8]]), 9)),
    /plain triangle mesh/,
  );
  const open = `<object id="5" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
  await assert.rejects(parse3MFBoolean(pack(solids + open + shape(9, 2, 'union', [[5]]), 9)), { code: 'syntax' });
});

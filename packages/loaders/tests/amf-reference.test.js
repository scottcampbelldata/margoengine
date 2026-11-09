import assert from 'node:assert/strict';
import test from 'node:test';
import { referenceAMF } from '../scripts/amf-reference.mjs';
import { parseAMF } from '../dist/amf.js';

const object =
  '<object id="0"><mesh><vertices>' +
  [
    [0, 0, 0],
    [20, 0, 0],
    [0, 20, 0],
  ]
    .map(([x, y, z]) => `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates></vertex>`)
    .join('') +
  '</vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object>';

test('AMF proof compares placed coordinates, including the published Slic3r translation', async () => {
  const source = `<amf unit="millimeter">${object}<constellation id="1"><instance objectid="0"><deltax>67.5</deltax><deltay>35</deltay></instance></constellation></amf>`;
  const reference = referenceAMF(source),
    parsed = await parseAMF(new TextEncoder().encode(source));
  assert.deepEqual(reference.positions, [0.0675, 0.035, 0, 0.08750000000000001, 0.035, 0, 0.0675, 0.055, 0]);
  assert.deepEqual(Array.from(parsed.positions), reference.positions.map(Math.fround));
  assert.deepEqual(Array.from(parsed.indices), reference.indices);
});

test('the AMF oracle follows nested rotation/translation and emits only root constellations', () => {
  const source = `<amf unit="meter">${object}<constellation id="1"><instance objectid="0"><rz>90</rz><deltax>3</deltax></instance></constellation><constellation id="2"><instance objectid="1"><deltay>5</deltay></instance></constellation></amf>`;
  const reference = referenceAMF(source);
  const expected = [3, 5, 0, 3, 25, 0, -17, 5, 0];
  reference.positions.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
  assert.deepEqual(reference.indices, [0, 1, 2]);
});

// parseGCode: layers by Z, extrusion against travel, absolute and relative modes, units, comments, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGCode } from '../dist/gcode.js';
import { LoaderError } from '../dist/common.js';

const near = (actual, expected, label = 'value') => {
  assert.equal(actual.length, expected.length, label);
  [...actual].forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-4, `${label}: ${[...actual]} against ${expected}`),
  );
};

test('extruding moves form layers by rising Z; travel leads into the next layer', () => {
  const { layers, filament, min, max } = parseGCode(`
G21 ; millimetres
G90
M82
G92 E0
G0 Z0.2 F3000
G1 X10 Y0 E1 F1200 ; first line
G1 X10 Y10 E2
G0 X0 Y0
G0 Z0.4
G1 X5 E3
`);
  assert.deepEqual(
    layers.map((l) => Math.round(l.z * 10) / 10),
    [0.2, 0.4],
  );
  near(layers[0].extrusion, [0, 0, 0.2, 10, 0, 0.2, 10, 0, 0.2, 10, 10, 0.2], 'layer 0 extrusion');
  near(layers[0].travel, [0, 0, 0, 0, 0, 0.2], 'the Z move leads in');
  near(layers[1].extrusion, [0, 0, 0.4, 5, 0, 0.4], 'layer 1 extrusion');
  near(layers[1].travel, [10, 10, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.4], 'layer 1 travel');
  assert.equal(filament, 3);
  near(min, [0, 0, 0]);
  near(max, [10, 10, 0.4]);
});

test('layers come back sorted though the file printed them out of order', () => {
  const { layers } = parseGCode('G1 Z2\nG1 X1 E1\nG1 Z1\nG1 X2 E2\nG1 Z2\nG1 X3 E3\n');
  assert.deepEqual(
    layers.map((l) => l.z),
    [1, 2],
  );
  assert.equal(layers[1].extrusion.length, 12, 'a return to a Z joins its layer');
});

test('retraction and pure E moves draw nothing and only positive E counts as filament', () => {
  const { layers, filament } = parseGCode('G1 Z1\nG1 X5 E5\nG1 E3\nG1 E5\nG1 X9 E4\nG1 X12 E6\n');
  assert.equal(filament, 5 + 2 + 2);
  assert.equal(layers.length, 1);
  near(layers[0].extrusion, [0, 0, 1, 5, 0, 1, 9, 0, 1, 12, 0, 1]);
  near(layers[0].travel.subarray(6), [5, 0, 1, 9, 0, 1], 'an E that falls is travel');
});

test('relative modes: G91 moves all axes, M83 only E, G90 and M82 restore them', () => {
  const all = parseGCode('G1 Z1\nG91\nG1 X1 E1\nG1 X1 E1\nG90\nG1 X5 E3\n');
  near(all.layers[0].extrusion, [0, 0, 1, 1, 0, 1, 1, 0, 1, 2, 0, 1, 2, 0, 1, 5, 0, 1]);
  assert.equal(all.filament, 3);
  const onlyE = parseGCode('M83\nG1 Z1\nG1 X1 E1\nG1 X2 E1\nM82\nG92 E0\nG1 X3 E5\n');
  near(onlyE.layers[0].extrusion, [0, 0, 1, 1, 0, 1, 1, 0, 1, 2, 0, 1, 2, 0, 1, 3, 0, 1]);
  assert.equal(onlyE.filament, 7);
});

test('G92 sets positions without moving, G28 homes, G20 reads inches', () => {
  const set = parseGCode('G1 Z1\nG1 X10 E1\nG92 X0\nG1 X5 E2\n');
  near(set.layers[0].extrusion.subarray(6), [0, 0, 1, 5, 0, 1]);
  const home = parseGCode('G1 X5 Y5 Z5\nG28 X\nG1 Y6 E1\nG28\nG1 X1 E2\n');
  near(home.layers[1].extrusion, [0, 5, 5, 0, 6, 5]);
  near(home.layers[0].extrusion, [0, 0, 0, 1, 0, 0]);
  const inches = parseGCode('G20\nG1 Z1\nG1 X1 E1\nG21\nG1 X100 E100\n');
  near(inches.layers[0].extrusion, [0, 0, 25.4, 25.4, 0, 25.4, 25.4, 0, 25.4, 100, 0, 25.4]);
});

test('spelling: no spaces, lower case, line numbers, checksums, comments of both kinds, CRLF', () => {
  const { layers } = parseGCode(
    'N1 g1z1*12\r\ng1x1e1 (a comment G1 X99)\r\nN3 G1 X2 ; G1 X99\r\n;G1 X99\r\n(G1 X99)\r\nM104 S200\r\nG1 X-1.5 Y+.5 E2\r\n',
  );
  near(layers[0].extrusion, [0, 0, 1, 1, 0, 1, 2, 0, 1, -1.5, 0.5, 1]);
});

test('arcs move the position, are not drawn and warn once; an empty file is empty', () => {
  const { layers, warnings, filament } = parseGCode('G1 Z1\nG2 X5 Y5 I1 J1 E1\nG3 X6 Y6 I1 J1 E2\nG1 X7 E3\n');
  assert.deepEqual(warnings, ['G2 and G3 arcs move the position but are not drawn']);
  near(layers[0].extrusion, [6, 6, 1, 7, 6, 1]);
  assert.equal(filament, 1, 'only the drawn move counts');
  const empty = parseGCode('; nothing\nM84\n');
  assert.deepEqual(empty.layers, []);
  assert.deepEqual(empty.min, [0, 0, 0]);
  assert.deepEqual(empty.max, [0, 0, 0]);
});

test('a file that only travels still shows its moves', () => {
  const { layers } = parseGCode('G0 X1\nG0 X2\n');
  assert.equal(layers.length, 1);
  near(layers[0].travel, [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
});

test('bad input and limits throw coded errors', () => {
  const coded = (fn, code, pattern) =>
    assert.throws(
      fn,
      (e) => e instanceof LoaderError && e.code === code && e.format === 'G-code' && pattern.test(e.message),
    );
  coded(() => parseGCode('G1 X'), 'syntax', /X has no number on line 1/);
  coded(() => parseGCode('G1 X1\nG\n'), 'syntax', /without a number on line 2/);
  coded(() => parseGCode('G1 X1\nG1 X2\n', { maxVertices: 3 }), 'limit', /vertex count/);
  coded(() => parseGCode('G1 X1', { maxVertices: -1 }), 'range', /maxVertices/);
  assert.equal(parseGCode(new TextEncoder().encode('G1 X1 E1')).layers.length, 1);
});

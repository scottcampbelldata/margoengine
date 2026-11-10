// Batch 132 audit: the documented sign conventions match the geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';
import { lanes } from '../dist/lanes.js';
import { markings } from '../dist/markings.js';

test("positive crossSection offsets and the first lane lie on the driver's left (+X when driving along +Z)", () => {
  const curve = new Spline([
    [0, 0, 0],
    [0, 0, 20],
  ]);
  const v = road(curve, {
    segments: 2,
    crossSection: [
      [1, 0],
      [2, 0],
    ],
  }).geometry.vertices;
  for (let i = 0; i < v.length; i += 6) assert.ok(v[i] >= 1 - 1e-9, `x ${v[i]}`);
  const [left] = lanes(curve, { widths: [3, 3] });
  assert.equal(left.index, 0);
  for (let i = 0; i < left.geometry.vertices.length; i += 6) assert.ok(left.geometry.vertices[i] > 2.9);
});

test('marking angle turns +Z toward +X (counterclockwise seen from above)', () => {
  const [line] = markings([{ kind: 'line', position: [0, 0, 0], angle: Math.PI / 4 }]);
  assert.ok(Math.abs(line.up[0] - Math.SQRT1_2) < 1e-15 && Math.abs(line.up[2] - Math.SQRT1_2) < 1e-15);
});

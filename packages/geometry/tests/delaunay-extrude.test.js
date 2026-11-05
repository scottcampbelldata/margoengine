// Extruded caps through the constrained triangulator: every outline point stays, so caps meet walls with no T-junctions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extrudeGeometry, Path, Shape } from '../dist/index.js';
import { triangulateConstrained } from '../dist/delaunay.js';
import { signedVolume, watertight } from './support/mesh-checks.js';

// A square with extra points along its sides, the case the default triangulator cleans away.
const outline = () =>
  new Shape([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [3, 1.5],
    [3, 3],
    [1.5, 3],
    [0, 3],
    [0, 1],
  ]);

test('an outline with collinear points extrudes watertight, with the right volume', () => {
  const solid = extrudeGeometry(outline(), { depth: 2, bevelEnabled: false, triangulate: triangulateConstrained });
  watertight(solid, 'collinear outline');
  assert.ok(Math.abs(signedVolume(solid) - 18) < 1e-4, `volume ${signedVolume(solid)}`);
});

test('holes and bevels stay watertight', () => {
  const shape = outline(),
    hole = new Path([
      [1, 1],
      [1.5, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ]);
  shape.holes.push(hole);
  const solid = extrudeGeometry(shape, { depth: 1, bevelSegments: 2, triangulate: triangulateConstrained });
  watertight(solid, 'bevelled with a hole');
  assert.ok(signedVolume(solid) > 0);
});

test('the option is used for every shape, and the default stays without it', () => {
  let calls = 0;
  const counted = (contour, holes) => {
      calls++;
      return triangulateConstrained(contour, holes);
    },
    solid = extrudeGeometry([outline(), outline()], { bevelEnabled: false, triangulate: counted });
  assert.equal(calls, 2);
  assert.equal(solid.groups.length, 4);
  const plain = extrudeGeometry(outline(), { bevelEnabled: false }),
    same = extrudeGeometry(outline(), { bevelEnabled: false, triangulate: undefined });
  assert.deepEqual(same.positions, plain.positions);
});

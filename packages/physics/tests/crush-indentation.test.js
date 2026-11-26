import assert from 'node:assert/strict';
import test from 'node:test';
import { CircularPlateIndentation } from '../dist/crush.js';

// Simonsen and Lauridsen (2000), Table 1. The specimen dimensions and Table 2's
// separate tensile coupon parameters never use the measured fracture/stroke results.
const steel = { radius: 0.1114, thickness: 0.001, strength: 497e6, hardening: 0.19 };
const observed = [
  [0.01, 0.02684, 159.17],
  [0.013, 0.0312, 254.24],
  [0.025, 0.04184, 575.2],
  [0.05, 0.06, 1687.3],
];
const near = (got, expected, tolerance) =>
  assert.ok(Math.abs(got - expected) <= tolerance, `${got} differs from ${expected} by more than ${tolerance}`);

test('a circular marine plate predicts the four independent measured rupture strokes and work values', (t) => {
  for (const [indenterRadius, stroke, work] of observed) {
    const plate = new CircularPlateIndentation({ ...steel, indenterRadius });
    // Section 5.1 reports a 7% approximation for the sharpest tip. All four
    // depths use that comparison envelope. Work accumulates load and stroke
    // model errors, so its acceptance band is broader.
    near(plate.fractureStroke, stroke, 0.07 * stroke);
    near(plate.fractureWork, work, 0.13 * work);
    t.diagnostic(
      `${1000 * indenterRadius} mm nose: ${(1000 * plate.fractureStroke).toFixed(2)} mm and ${plate.fractureWork.toFixed(1)} J; measured ${1000 * stroke} mm and ${work} J`,
    );
  }
});

test('loading accumulates irreversible work and stops reporting intact force at localization', () => {
  const plate = new CircularPlateIndentation({ ...steel, indenterRadius: 0.025 });
  const initial = plate.read(0);
  assert.equal(initial.force, 0);
  assert.equal(initial.work, 0);
  let previous = initial;
  for (let j = 1; j < 24; j++) {
    const next = plate.read((j * plate.fractureStroke) / 24);
    assert.ok(next.force > previous.force && next.work > previous.work);
    assert.ok(next.contactRadius > previous.contactRadius);
    assert.equal(next.fractured, false);
    near(plate.strokeForWork(next.work), next.stroke, 1e-14);
    previous = next;
  }
  const fractured = plate.read(2 * plate.fractureStroke);
  assert.equal(fractured.fractured, true);
  assert.equal(fractured.force, undefined);
  assert.equal(fractured.stroke, plate.fractureStroke);
  assert.equal(fractured.work, plate.fractureWork);
  assert.equal(plate.strokeForWork(2 * plate.fractureWork), plate.fractureStroke);
});

test('radial sampling keeps the held edge fixed and supplies unit normals at its deformed positions', () => {
  const plate = new CircularPlateIndentation({ ...steel, indenterRadius: 0.025 });
  const stroke = 0.02;
  const rest = [0, 0, 0.005, 0, 0, -0.005, 0.03, 0, steel.radius, 0];
  const { positions, normals } = plate.read(stroke, rest).surface;
  assert.equal(positions[2], stroke);
  assert.equal(positions[14], 0);
  near(positions[5], positions[8], 1e-15);
  assert.ok(positions[5] > positions[11] && positions[11] > positions[14]);
  assert.ok(normals[3] > 0 && normals[7] < 0);
  for (let i = 0; i < normals.length; i += 3) near(Math.hypot(...normals.subarray(i, i + 3)), 1, 1e-12);
  assert.deepEqual(plate.read(stroke, rest).surface, { positions, normals });
  assert.deepEqual(Array.from(plate.read(0, [0, 0]).surface.normals), [0, 0, 1]);
});

test('geometrically similar plates scale stroke, force and work with length, area and volume', () => {
  const reference = new CircularPlateIndentation({ ...steel, indenterRadius: 0.025 });
  const scale = 20;
  const large = new CircularPlateIndentation({
    ...steel,
    radius: scale * steel.radius,
    thickness: scale * steel.thickness,
    indenterRadius: scale * 0.025,
  });
  near(large.fractureStroke / scale, reference.fractureStroke, 1e-12);
  near(large.fractureForce / scale ** 2, reference.fractureForce, 1e-8);
  near(large.fractureWork / scale ** 3, reference.fractureWork, 1e-8);
  assert.throws(() => large.read(-0.01), { code: 'state', message: /indentation stroke/ });
  assert.throws(() => large.read(0.01, [large.fractureStroke, Infinity]), {
    code: 'state',
    message: /finite rest-plane sample/,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { wheelSoil } from '@margoengine/physics/terramechanics';

test('two footprint widths separate the width-dependent and independent pressure coefficients', () => {
  const material = { cohesiveModulus: 1000, frictionalModulus: 400000, exponent: 1.2 };
  const narrow = wheelSoil(0.1, 0.3, material, false);
  const wide = wheelSoil(0.2, 0.3, material, true);
  assert.equal(narrow.stiffness, 410000);
  assert.equal(wide.stiffness, 405000);
  assert.equal(narrow.exponent, 1.2);
  assert.equal(wide.exponent, 1.2);
  assert.equal(narrow.area, 0.03);
  assert.equal(wide.area, 0.015 * Math.PI);
});

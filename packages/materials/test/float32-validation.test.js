// Material scalars upload as float32: values that overflow it are refused instead of uploading Infinity, and white
// volume attenuation stays white for any accepted distance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PbrMaterial, PhongMaterial } from '../dist/index.js';

const largest = (2 - 2 ** -23) * 2 ** 127,
  rounds = largest + 2 ** 102, // rounds to the largest float32
  overflows = largest + 2 ** 103; // rounds to Infinity
for (const [field, Ctor, base] of [
  ['clearcoatNormalScale', PbrMaterial, {}],
  ['iridescenceIOR', PbrMaterial, {}],
  ['ior', PbrMaterial, {}],
  ['thickness', PbrMaterial, { transmission: 1 }],
  ['normalScale', PbrMaterial, {}],
  ['shininess', PhongMaterial, {}],
])
  test(`${field} accepts the largest float32 and refuses an overflow without changing the material`, () => {
    const m = new Ctor({ ...base, [field]: rounds });
    try {
      assert.equal(m[field], rounds);
      assert.throws(() => (m[field] = overflows), { name: 'RangeError', message: new RegExp(field) });
      assert.equal(m[field], rounds);
    } finally {
      m.dispose();
    }
  });

test('iridescenceThicknessRange refuses overflowing, negative or reversed ranges', () => {
  const m = new PbrMaterial();
  for (const range of [[0, overflows], [-1, 10], [20, 10], [1], 'thin'])
    assert.throws(() => (m.iridescenceThicknessRange = range), RangeError);
  m.iridescenceThicknessRange = [0, rounds];
  assert.deepEqual(m.iridescenceThicknessRange, [0, rounds]);
  m.dispose();
});

test('white attenuation channels stay at one for a subnormal distance', () => {
  const m = new PbrMaterial({ transmission: 1, thickness: 1 });
  m.attenuationColor = [1, 0.5, 1];
  m.attenuationDistance = Number.MIN_VALUE;
  assert.deepEqual(m.volume, [1, 1, 0, 1]);
  m.dispose();
});

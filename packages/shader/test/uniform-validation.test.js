import assert from 'node:assert/strict';
import test from 'node:test';
// Float uniforms upload as float32, so values that overflow it are refused; integer uniforms keep their ranges.
import { uniform } from '@margoengine/shader';
const threshold = (2 - 2 ** -24) * 2 ** 127;
for (const value of [1e100, -1e100, threshold, -threshold]) {
  test('float uniform refuses unrepresentable constructor value ' + value, () =>
    assert.throws(() => uniform(value), TypeError),
  );
  test('float uniform refuses invalid live value atomically ' + value, () => {
    const u = uniform(0.25, { name: 'amount' });
    assert.throws(() => {
      u.value = value;
    }, TypeError);
    assert.equal(u.value, 0.25);
  });
}
for (const [type, size] of [
  ['vec2f', 2],
  ['vec3f', 3],
  ['vec4f', 4],
  ['mat2x2f', 4],
  ['mat3x3f', 9],
  ['mat4x4f', 16],
]) {
  test(type + ' refuses one overflowing lane without changing the prior value', () => {
    const initial = Array(size).fill(0.25),
      bad = [...initial];
    bad[size - 1] = 1e100;
    assert.throws(() => uniform(bad, { type }), TypeError);
    const u = uniform(initial, { type });
    assert.throws(() => {
      u.value = bad;
    }, TypeError);
    assert.deepEqual(u.value, initial);
  });
}
test('ordinary integer uniform boundaries remain available without a new coercion policy', () => {
  for (const [type, value] of [
    ['u32', 4294967295],
    ['i32', -2147483648],
    ['i32', 2147483647],
  ])
    assert.equal(uniform(value, { type }).value, value);
});

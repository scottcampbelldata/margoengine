// One gravity for the engine: the default every solver and shader takes, checked, its strength, its direction and its uniform.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GRAVITY,
  STANDARD_GRAVITY,
  checkGravity,
  gravityDown,
  gravityMagnitude,
  gravityUniform,
} from '../dist/gravity.js';

test('the default is 9.81 m/s^2 down y, frozen, and standard gravity is the CGPM value', () => {
  assert.deepEqual([...DEFAULT_GRAVITY], [0, -9.81, 0]);
  assert.ok(Object.isFrozen(DEFAULT_GRAVITY));
  assert.equal(STANDARD_GRAVITY, 9.80665);
  assert.equal(gravityMagnitude(), 9.81);
  assert.deepEqual(gravityDown(), [0, -1, 0]);
});

test('a gravity is checked, its strength and direction read, and no gravity has no direction', () => {
  const moon = checkGravity([0, 0, -1.62]);
  assert.ok(Object.isFrozen(moon));
  assert.equal(gravityMagnitude(moon), 1.62);
  assert.deepEqual(gravityDown(moon), [0, 0, -1]);
  assert.deepEqual(gravityDown(checkGravity([0, 0, 0])), [0, 0, 0]);
  assert.throws(() => checkGravity([0, -9.81]), TypeError);
  assert.throws(() => checkGravity(null), TypeError);
  assert.throws(() => checkGravity([0, '1', 0]), TypeError);
  assert.throws(() => checkGravity([0, Number.NaN, 0], 'World gravity'), /World gravity must be finite/);
});

test('the uniform is x, y, z and the strength as f32, written where asked', () => {
  assert.deepEqual([...gravityUniform()], [0, Math.fround(-9.81), 0, Math.fround(9.81)]);
  const buffer = new Float32Array(8).fill(7);
  gravityUniform(checkGravity([3, -4, 0]), buffer, 4);
  assert.deepEqual([...buffer], [7, 7, 7, 7, 3, -4, 0, 5]);
});

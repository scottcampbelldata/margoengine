import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_BINDING, shadowSampling } from '../src/shader.ts';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { shadowStyle } from '../dist/style.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
const other = { wgsl: () => '', call: 'vec3f(0.5)' };
// What the frame sends: the shadow's floor, for a given style.
const floor = (options) => {
  const style = shadowStyle(options);
  let sent;
  const device = { createBuffer: () => ({ destroy() {} }), queue: { writeBuffer: (_, __, values) => (sent = [...values]) } };
  style.setup(device);
  style.update({ context: { device } });
  return sent.slice(0, 3);
};

test('a style takes the whole shadow of the light in both shadow classes', () => {
  const name = `shadowFxStyle${EFFECT_BINDING}`;
  const plain = shadowSampling(1, 'hard', false, true, false, [shadowStyle(), other]);
  assert.ok(plain.includes(`return direct*${name}(vec3f(1)*shadowVisibility(position,normal)*shadowTint(position,normal)*vec3f(0.5));}`));
  const virtual = new VirtualShadows({ filter: 'hard', effects: [shadowStyle()] }).pbr(1).declarations;
  assert.ok(virtual.includes(`return direct*${name}(vec3f(1)*shadowVisibility(position,normal));}`));
});
test('the floor is what a full shadow leaves: 1 - intensity, plus intensity of the colour', () => {
  assert.deepEqual(floor({}), [0, 0, 0]);
  assert.deepEqual(floor({ intensity: 0, color: [1, 0, 0] }), [1, 1, 1]);
  assert.deepEqual(floor({ intensity: 0.5 }), [0.5, 0.5, 0.5]);
  assert.deepEqual(floor({ intensity: 0.5, color: [1, 0.5, 0] }), [1, 0.75, 0.5]);
});
test('a style out of range throws at the frame that reads it', () => {
  for (const bad of [{ intensity: -0.1 }, { intensity: 1.1 }, { color: [0, 0] }, { color: [0, 0, 2] }])
    assert.throws(() => floor(bad), RangeError, JSON.stringify(bad));
});
test('one style per shadows', () => {
  assert.throws(() => new Shadows({ effects: [shadowStyle(), shadowStyle()] }), TypeError);
});

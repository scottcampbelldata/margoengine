import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_BINDING, shadowSampling } from '../src/shader.ts';
import { VirtualShadows } from '../dist/virtual.js';
import { distanceShadows } from '../dist/distance.js';

const field = () => ({ heights: new Float32Array(4), columns: 2, rows: 2, size: [1, 1] });

test('far shadows refuse a field that does not add up', () => {
  assert.throws(() => distanceShadows({ ...field(), heights: [0, 0, 0, 0] }), RangeError);
  assert.throws(() => distanceShadows({ ...field(), columns: 1 }), RangeError);
  assert.throws(() => distanceShadows({ ...field(), rows: 3 }), RangeError);
  assert.throws(() => distanceShadows({ ...field(), size: [0, 1] }), RangeError);
});
test('far shadows multiply the sun in both shadow classes, past shadowReach', () => {
  for (const code of [shadowSampling(1, 'hard', false, false, false, [distanceShadows(field())]), new VirtualShadows({ filter: 'hard', effects: [distanceShadows(field())] }).pbr(1).declarations]) {
    assert.ok(code.includes(`@group(1) @binding(${EFFECT_BINDING}) var<uniform> shadowFxFarData${EFFECT_BINDING}`));
    assert.ok(code.includes(`@group(1) @binding(${EFFECT_BINDING + 1}) var<storage,read> shadowFxFarCells${EFFECT_BINDING}`));
    assert.ok(code.includes(`*vec3f(shadowFxFar${EFFECT_BINDING}(position));}`));
    assert.ok(code.includes('let reach=shadowReach();'));
  }
});
test('far shadow settings out of range throw at the frame that reads them', () => {
  const buffer = { destroy() {} },
    device = { createBuffer: () => buffer, queue: { writeBuffer() {} } };
  globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 };
  for (const bad of [{ fade: 0 }, { fade: 2 }, { strength: 2 }, { sunSize: -1 }, { bias: -1 }, { sunStep: -1 }]) {
    const far = distanceShadows({ ...field(), ...bad });
    far.setup(device, { size: 1024, layers: 4 });
    assert.throws(() => far.update({ light: [0, 1, 0], context: {} }), RangeError, JSON.stringify(bad));
    far.dispose();
  }
});

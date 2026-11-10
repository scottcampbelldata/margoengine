import assert from 'node:assert/strict';
import test from 'node:test';
import { Splats } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const data = {
  positions: new Float32Array([0, 0, -2, 1, 0, -3]),
  covariances: new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]),
  colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
};
test('per-content splat masks retain original IDs through sorting and device restoration', () => {
  const s = new Splats(data);
  assert.equal(s.ditherFadeBytes, 0);
  s.setDitherFade(0, 1, 0.5, 1);
  assert.deepEqual([...s.fadeData], [4104, 4096]);
  s.setDitherFade(1, 1, 0, 0.5);
  assert.deepEqual([...s.fadeData], [4104, 2048]);
  assert.equal(s.ditherFadeBytes, 8);
  const h = optionalGPU();
  h.engine.gpu.limits = {
    ...h.engine.gpu.limits,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxStorageBuffersPerShaderStage: 8,
  };
  h.engine.use(s);
  const old = s.fadeBuffer;
  assert.ok(old);
  s.onDeviceRestored(h.engine);
  assert.notEqual(s.fadeBuffer, old);
  assert.deepEqual([...s.fadeData], [4104, 2048]);
  for (const args of [
    [0, 1, -0.1, 1],
    [0, 1, 1, 0.5],
    [0, 1, NaN, 1],
    [2, 1, 0, 1],
  ])
    assert.throws(() => s.setDitherFade(...args));
  s.dispose();
});
test('splat interval quantization follows shader f32 rounding at half-rank boundaries', () => {
  const s = new Splats(data);
  s.setDitherFade(0, 1, 0.0312500001, 0.5);
  assert.equal(s.fadeData[0] & 255, 0);
  s.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuHarness } from './support/postfx-gpu.js';

test('postfx recorder uses the allocated uniform size rather than a fixed 256-float scratch', () => {
  const h = gpuHarness(),
    device = h.engine.gpu;
  const buffer = device.createBuffer({ size: 2048, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new Float32Array(400).fill(0.5);
  device.queue.writeBuffer(buffer, 16, data);
  assert.equal(h.writes.length, 512);
  assert.equal(h.writes[3], 0);
  assert.equal(h.writes[4], 0.5);
  assert.equal(h.writes[403], 0.5);
  assert.equal(h.writes[404], 0);
  assert.throws(() => device.queue.writeBuffer(buffer, 2000, data), RangeError);
  device.queue.writeBuffer(buffer, 0, new Float32Array([1, 2, 3, 4]), 1, 2);
  assert.deepEqual([...h.writes.slice(0, 4)], [2, 3, 0, 0]);
});

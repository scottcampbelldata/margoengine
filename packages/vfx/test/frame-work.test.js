// Batch 170: per-frame CPU to GPU work of 100,000 live particles. The simulation lives on the GPU, so a steady frame
// uploads one 224-byte uniform block whatever the count. three.quarks 0.17.1, a CPU simulation run as a black box in
// engine-bench (batch-170/quarks-rival.mjs), marks 4,800,000 bytes of instance attributes for upload per frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';
import { configs } from './traces.js';
import { VFX } from '../dist/index.js';

test('work count: a steady frame of 100,000 particles uploads 224 bytes in one write', () => {
  const h = tracedGPU();
  h.engine.stats = { drawCalls: 0 };
  const queue = h.engine.gpu.queue,
    write = queue.writeBuffer;
  let bytes = 0,
    writes = 0;
  queue.writeBuffer = function (buffer, offset, data, dataOffset = 0, size) {
    const unit = data.BYTES_PER_ELEMENT ?? 1;
    writes++;
    bytes += size === undefined ? data.byteLength - dataOffset * unit : size * unit;
    return write.apply(this, arguments);
  };
  const options = configs.afterlight.options();
  assert.equal(options.capacity, 100_000);
  assert.equal(options.initialCount, 100_000);
  const effect = new VFX(options);
  h.engine.use(effect);
  h.frame();
  h.frame();
  bytes = writes = 0;
  for (let i = 0; i < 60; i++) h.frame();
  assert.equal(writes, 60);
  assert.equal(bytes, 60 * 224);
  effect.dispose();
});

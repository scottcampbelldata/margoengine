import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { concatenate, stack, pad, tile, flip, repeat } from '@margoengine/compute/shape';
import { shapeCases } from './shape-cases.js';

test('shape entry implements standard joining, padding, tiling and repetition on CPU', { timeout: 30000 }, async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  assert.equal(await shapeCases(gpu), 30);
});

test('shape validation rejects mismatches, invalid axes/counts, context mixing and disposed inputs', {
  timeout: 30000,
}, async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  using other = await createCompute({ backend: 'cpu' });
  const x = gpu.ones([2, 3]);
  assert.throws(() => concatenate([]), TypeError);
  assert.throws(() => concatenate([x, gpu.ones([3, 3])], 1), RangeError);
  assert.throws(() => stack([x, gpu.ones([1, 3])]), RangeError);
  assert.throws(() => stack([x], 4), RangeError);
  assert.throws(() => concatenate([x, other.ones([2, 3])]), TypeError);
  assert.throws(() => flip(x, [0, -2]), RangeError);
  assert.throws(() => tile(x, [1, -1]), RangeError);
  assert.throws(() => repeat(x, [1, 2], 1), RangeError);
  assert.throws(() => repeat(x, 0.5), RangeError);
  assert.throws(() => pad(x, [[1, 2]]), RangeError);
  assert.throws(() => pad(x, -1), RangeError);
  assert.throws(() => pad(x, 1, { mode: 'unknown' }), TypeError);
  assert.throws(() => pad(gpu.zeros([0]), 1, { mode: 'edge' }), RangeError);
  const gone = gpu.ones([0]);
  gone.dispose();
  assert.throws(
    () => flip(gone),
    (e) => e.code === 'disposed',
  );
  // Output owns its buffer, so using/dispose releases it without disposing inputs.
  for (const result of [stack([x]), concatenate([x]), flip(x), tile(x, 1), repeat(x, 1), pad(x, 0)]) {
    assert.equal(result.owner, true);
    result.dispose();
    assert.equal(result.storage.disposed, true);
    assert.equal(x.disposed, false);
  }
});

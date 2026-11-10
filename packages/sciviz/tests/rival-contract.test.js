import assert from 'node:assert/strict';
import test from 'node:test';
import { rivalOptions, samePixels, countDelta, installWorkCounters, sampleFrame } from '../scripts/rival-contract.js';
import { fillVolume } from '../scripts/rival-data.js';

test('smoke is exactly one run; invalid and unknown options reject before GPU work', () => {
  assert.equal(rivalOptions(['--runs=1']).smoke, true);
  assert.equal(rivalOptions([]).smoke, false);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5', '101', '1junk'])
    assert.throws(() => rivalOptions([`--runs=${value}`]), RangeError);
  assert.throws(() => rivalOptions(['--scene=missing']), RangeError);
  assert.throws(() => rivalOptions(['--typo']), TypeError);
  assert.throws(() => rivalOptions(['--output=']), TypeError);
});

test('image repeat oracle rejects one changed byte and truncation', () => {
  assert.equal(samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.throws(() => samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 3])), /byte 1/);
  assert.throws(() => samePixels(new Uint8Array([1]), new Uint8Array()), /size/);
});

test('public boundary counters retain receiver, return value, arguments and errors', () => {
  const previous = globalThis.GPUQueue;
  class Queue {
    writeBuffer(...args) {
      assert.equal(this, queue);
      assert.deepEqual(args, [4, 8]);
      return 12;
    }
    submit() {
      throw new Error('device lost');
    }
  }
  const queue = new Queue();
  try {
    globalThis.GPUQueue = Queue;
    installWorkCounters();
    assert.equal(queue.writeBuffer(4, 8), 12);
    assert.throws(() => queue.submit(), /device lost/);
    assert.equal(globalThis.__rivalCounts['webgpu.writeBuffer'], 1);
    assert.equal(globalThis.__rivalCounts['webgpu.submit'], 1);
    assert.deepEqual(countDelta({ a: 3 }, { a: 5, b: 1 }), { a: 2, b: 1 });
    globalThis.__stopRivalCounters();
    queue.writeBuffer(4, 8);
    assert.equal(globalThis.__rivalCounts['webgpu.writeBuffer'], 1);
  } finally {
    if (previous === undefined) delete globalThis.GPUQueue;
    else globalThis.GPUQueue = previous;
    delete globalThis.__rivalCounts;
    delete globalThis.__stopRivalCounters;
  }
});

test('128 cube is a full workload, not a resized copy of the 64 cube', () => {
  const { data } = fillVolume(128);
  assert.equal(data.length, 128 ** 3);
  assert.equal(data[0], 0);
  assert.ok(data[63 + 128 * (63 + 128 * 63)] > 0.98);
});

test('smoke never reads a benchmark clock; timed path uses the completed read boundary', async () => {
  const counts = { draw: 0 };
  const pixels = new Uint8Array([1, 2, 3, 255]);
  const frame = async () => {
    counts.draw++;
    return pixels;
  };
  const smoke = await sampleFrame(true, frame, counts, () => {
    throw new Error('smoke clock');
  });
  assert.deepEqual(smoke, { pixels, work: { draw: 1 } });
  let clock = 0;
  const timed = await sampleFrame(false, frame, counts, () => {
    clock += 7;
    return clock;
  });
  assert.equal(timed.ms, 7);
  assert.deepEqual(timed.work, { draw: 1 });
  await assert.rejects(
    sampleFrame(
      true,
      async () => {
        throw new Error('GPU error');
      },
      counts,
    ),
    /GPU error/,
  );
});

test('WebGL1 and inherited WebGL2 methods count one call and restore their prototype shape', () => {
  const old1 = globalThis.WebGLRenderingContext,
    old2 = globalThis.WebGL2RenderingContext;
  class GL1 {
    drawArrays() {
      return 7;
    }
  }
  class GL2 extends GL1 {}
  try {
    globalThis.WebGLRenderingContext = GL1;
    globalThis.WebGL2RenderingContext = GL2;
    installWorkCounters();
    assert.equal(new GL1().drawArrays(), 7);
    assert.equal(new GL2().drawArrays(), 7);
    assert.equal(globalThis.__rivalCounts['webgl1.drawArrays'], 1);
    assert.equal(globalThis.__rivalCounts['webgl2.drawArrays'], 1);
    globalThis.__stopRivalCounters();
    assert.equal(Object.hasOwn(GL2.prototype, 'drawArrays'), false);
  } finally {
    if (old1 === undefined) delete globalThis.WebGLRenderingContext;
    else globalThis.WebGLRenderingContext = old1;
    if (old2 === undefined) delete globalThis.WebGL2RenderingContext;
    else globalThis.WebGL2RenderingContext = old2;
    delete globalThis.__rivalCounts;
    delete globalThis.__stopRivalCounters;
  }
});

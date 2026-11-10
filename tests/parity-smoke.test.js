import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { workCounter } from '../bench/lib/work-count.js';

test('work counter preserves native calls and counts exact typed-array upload ranges', () => {
  const received = [];
  class Queue {
    writeBuffer(...args) {
      received.push([this, ...args]);
      return 'unchanged';
    }
  }
  const original = Queue.prototype.writeBuffer;
  const counter = workCounter({ GPUQueue: Queue });
  const queue = new Queue();
  const buffer = {};
  const values = new Float32Array([1, -0, 3, 4]);
  assert.equal(queue.writeBuffer(buffer, 0, values), 'unchanged');
  queue.writeBuffer(buffer, 4, values, 1, 2);
  queue.writeBuffer(buffer, 0, new DataView(values.buffer), 4);
  queue.writeBuffer(buffer, 0, values.buffer, 4, 8);
  assert.deepEqual(counter.snapshot(), { 'GPUQueue.writeBuffer': 4, writeBufferBytes: 44 });
  assert.equal(received[0][0], queue);
  assert.equal(received[0][3], values);
  assert.deepEqual([...new Uint8Array(values.buffer)], [...new Uint8Array(new Float32Array([1, -0, 3, 4]).buffer)]);
  counter.reset();
  assert.deepEqual(counter.snapshot(), {});
  counter.restore();
  assert.equal(Queue.prototype.writeBuffer, original);
});

test('parity smoke rejects repeated runs before creating a browser', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/parity-smoke-browser.mjs', '--runs=2'], { timeout: 30_000 }),
    /requires --runs=1/,
  );
});

for (const [scene, kind] of [
  ['p-orbit-controls', 'task'],
  ['p-background', 'frame'],
]) {
  test(`parity smoke executes one complete ${kind} and never enters timing phases`, async () => {
    const saved = new Map(
      ['location', 'document', 'window', 'addEventListener'].map((k) => [
        k,
        Object.getOwnPropertyDescriptor(globalThis, k),
      ]),
    );
    const resultWindow = {};
    try {
      Object.assign(globalThis, {
        location: new URL(`http://localhost/?scene=${scene}&smoke=1`),
        document: { querySelector: () => ({ width: 1280, height: 720 }) },
        window: resultWindow,
        addEventListener: () => {},
      });
      const { run } = await import(`../bench/scenes/harness.js?smoke-test=${kind}`);
      let calls = 0,
        idles = 0;
      await run(async () => ({
        task(i) {
          assert.equal(i, 0);
          calls++;
        },
        render(t) {
          assert.equal(t, 0);
          calls++;
        },
        async idle() {
          idles++;
        },
        gpuTimes() {
          assert.fail('smoke requested timing work');
        },
        output: () => ({ vertices: 42 }),
      }));
      assert.deepEqual(resultWindow.result, {
        engine: 'margo',
        scene,
        params: {},
        smoke: true,
        calls: 1,
        work: { setup: {}, call: {} },
        output: { vertices: 42 },
        info: {},
        errors: [],
      });
      assert.equal(calls, 1);
      assert.equal(idles, kind === 'frame' ? 1 : 0);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}

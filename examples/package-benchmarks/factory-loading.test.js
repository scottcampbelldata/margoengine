import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkloadForPage } from './factory-loading.js';

test('sync and async factories receive the selected count and publish only a live result', async () => {
  for (const asynchronous of [false, true]) {
    const controller = new AbortController(),
      value = { points: new Float32Array(16) };
    const result = await createWorkloadForPage(
      {
        createWorkload(count, options) {
          assert.equal(count, 4);
          assert.equal(options.signal, controller.signal);
          return asynchronous ? Promise.resolve(value) : value;
        },
      },
      4,
      controller.signal,
    );
    assert.equal(result, value);
  }
});

test('closing the page during dependency initialization disposes the late resource once', async () => {
  const controller = new AbortController();
  let complete,
    disposed = 0;
  const pending = createWorkloadForPage(
    {
      createWorkload() {
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
    64,
    controller.signal,
  );
  controller.abort(new Error('Page closed'));
  complete({
    dispose() {
      disposed++;
    },
  });
  await assert.rejects(pending, /Page closed/);
  assert.equal(disposed, 1);
  await assert.rejects(
    createWorkloadForPage(
      {
        createWorkload() {
          assert.fail('Closed page invoked factory');
        },
      },
      64,
      controller.signal,
    ),
    /Page closed/,
  );
});

test('dependency rejection is preserved rather than publishing an empty workload', async () => {
  await assert.rejects(
    createWorkloadForPage(
      {
        async createWorkload() {
          throw new Error('Wasm failed');
        },
      },
      64,
      new AbortController().signal,
    ),
    /Wasm failed/,
  );
});

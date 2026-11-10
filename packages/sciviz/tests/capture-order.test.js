import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureGPU } from '../src/export.ts';

test('PNG usage reconfiguration drains previously submitted work before expiring its canvas target', async (t) => {
  for (const key of ['OffscreenCanvas', 'ImageData', 'createImageBitmap'])
    if (!(key in globalThis)) {
      Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
      t.after(() => {
        delete globalThis[key];
      });
    }
  const gate = Promise.withResolvers(),
    events = [];
  let drained = false;
  const context = {
    getConfiguration: () => ({ format: 'rgba8unorm', usage: 0x10 }),
    configure() {
      assert(drained, 'pending replay still references the old canvas texture');
      events.push('configure');
    },
    getCurrentTexture: () => ({}),
  };
  const buffer = {
    mapAsync: async () => {
      events.push('map');
    },
    getMappedRange: () => new ArrayBuffer(256),
    unmap() {},
    destroy() {
      events.push('destroy');
    },
  };
  const engine = {
    gpu: {
      queue: {
        onSubmittedWorkDone() {
          events.push('drain');
          return gate.promise;
        },
        submit() {
          events.push('submit');
        },
      },
      createBuffer: () => buffer,
      createCommandEncoder: () => ({
        copyTextureToBuffer() {
          events.push('copy');
        },
        finish: () => ({}),
      }),
    },
  };
  t.mock.property(
    globalThis,
    'OffscreenCanvas',
    class {
      getContext() {
        return { putImageData() {} };
      }
    },
  );
  t.mock.property(globalThis, 'ImageData', class {});
  t.mock.property(globalThis, 'createImageBitmap', async () => ({ bitmap: true }));
  const promise = captureGPU(engine, { width: 1, height: 1, getContext: () => context }, () => events.push('render'));
  assert.deepEqual(events, ['drain']);
  drained = true;
  gate.resolve();
  assert.deepEqual(await promise, { bitmap: true });
  assert.deepEqual(events, ['drain', 'configure', 'render', 'copy', 'submit', 'map', 'destroy']);
});

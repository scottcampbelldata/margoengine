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
    getCurrentTexture: () => ({ width: 1, height: 1 }),
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

test('PNG capture copies the size of the texture the frame drew into when that frame resized the canvas', async (t) => {
  // WebKit sweep: a figure whose CSS box changed was 1392 px wide before render() and 690 px after it; the copy used
  // the old width and failed validation (endX 1392 > width 690).
  for (const key of ['OffscreenCanvas', 'ImageData', 'createImageBitmap'])
    if (!(key in globalThis)) {
      Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
      t.after(() => {
        delete globalThis[key];
      });
    }
  const canvas = { width: 1392, height: 720 },
    copies = [],
    sizes = [];
  let texture = null;
  const context = {
    getConfiguration: () => ({ format: 'bgra8unorm', usage: 0x11 }),
    configure() {},
    getCurrentTexture: () => (texture ??= { width: canvas.width, height: canvas.height }),
  };
  canvas.getContext = () => context;
  const engine = {
    gpu: {
      queue: { onSubmittedWorkDone: async () => {}, submit() {} },
      createBuffer: ({ size }) => {
        sizes.push(size);
        return {
          mapAsync: async () => {},
          getMappedRange: () => new ArrayBuffer(size),
          unmap() {},
          destroy() {},
        };
      },
      createCommandEncoder: () => ({
        copyTextureToBuffer(source, destination, size) {
          assert.ok(size[0] <= source.texture.width && size[1] <= source.texture.height, 'copy fits the texture');
          copies.push({ size, bytesPerRow: destination.bytesPerRow, rowsPerImage: destination.rowsPerImage });
        },
        finish: () => ({}),
      }),
    },
  };
  let image = null;
  t.mock.property(
    globalThis,
    'OffscreenCanvas',
    class {
      constructor(width, height) {
        this.size = [width, height];
      }
      getContext() {
        return { putImageData: (data) => (image = data) };
      }
    },
  );
  t.mock.property(
    globalThis,
    'ImageData',
    class {
      constructor(data, width, height) {
        Object.assign(this, { data, width, height });
      }
    },
  );
  t.mock.property(globalThis, 'createImageBitmap', async (c) => ({ width: c.size[0], height: c.size[1] }));
  const bitmap = await captureGPU(engine, canvas, () => {
    // The engine sizes the drawing buffer from the CSS box inside render(); the resize replaces the canvas texture.
    canvas.width = 690;
    canvas.height = 360;
    texture = null;
  });
  assert.deepEqual(copies, [{ size: [690, 360], bytesPerRow: 2816, rowsPerImage: 360 }]);
  assert.deepEqual(sizes, [2816 * 360]);
  assert.deepEqual([image.width, image.height, image.data.length], [690, 360, 690 * 360 * 4]);
  assert.deepEqual(bitmap, { width: 690, height: 360 });
});

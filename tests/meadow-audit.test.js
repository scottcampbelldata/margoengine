import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentMeadow } from '../scripts/support/meadow-audit.mjs';

for (const replacement of [false, true])
  test(`meadow counters follow ${replacement ? 'replacement compatibility' : 'native'} device classes`, async () => {
    const names = ['window', 'navigator', 'GPUDevice', 'GPUQueue', 'GPURenderPassEncoder'];
    const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const install = (name, value) =>
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const classes = () => ({
      GPUDevice: class {
        createBuffer(descriptor) {
          return { ...descriptor, destroy() {} };
        }
        createTexture(descriptor) {
          return { ...descriptor, destroy() {} };
        }
        createRenderPipeline() {
          return {};
        }
        createBindGroup() {
          return {};
        }
      },
      GPUQueue: class {
        writeBuffer() {}
      },
      GPURenderPassEncoder: class {
        setPipeline() {}
      },
    });
    try {
      install('window', {});
      const before = classes(),
        actual = replacement ? classes() : before;
      for (const [name, value] of Object.entries(before)) install(name, value);
      let requests = 0;
      const adapter = {};
      install('navigator', {
        gpu: {
          async requestAdapter() {
            requests++;
            for (const [name, value] of Object.entries(actual)) install(name, value);
            return adapter;
          },
        },
      });
      instrumentMeadow();
      assert.equal(await navigator.gpu.requestAdapter(), adapter);
      assert.equal(await navigator.gpu.requestAdapter(), adapter);
      assert.equal(requests, 2);
      const device = new actual.GPUDevice(),
        queue = new actual.GPUQueue();
      const buffer = device.createBuffer({ label: 'grass:frame' });
      const texture = device.createTexture({ sampleCount: 4 });
      const pipeline = device.createRenderPipeline({ multisample: { count: 4 } });
      new actual.GPURenderPassEncoder().setPipeline(pipeline);
      queue.writeBuffer(buffer, 0, new Float32Array([1, 2, 3]));
      assert.equal(window.meadowAudit.frames, 1, 'the active queue increments exactly once');
      assert.deepEqual(window.meadowAudit.grass, [1, 2, 3]);
      assert.equal(window.meadowAudit.created, 3, 'repeat adapter requests do not double-patch');
      assert.deepEqual(window.meadowAudit.textures, [4]);
      assert.ok(window.meadowAudit.boundSamples.has(4));
      assert.equal(window.meadowAudit.live.size, 2);
      texture.destroy();
      buffer.destroy();
      assert.equal(window.meadowAudit.live.size, 0);
    } finally {
      names.forEach((name, index) =>
        saved[index] ? Object.defineProperty(globalThis, name, saved[index]) : Reflect.deleteProperty(globalThis, name),
      );
    }
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';

// Chromium reports completion (onSubmittedWorkDone, mapAsync) about 3 ms late when it is asked for before the error
// scopes have come back, and about 0.3 ms late when asked for after an error-scope round trip (measured on Edge with an
// RTX A6000; docs/benchmarking.md "compute"). These checks pin the order on a recording device.

globalThis.GPUBufferUsage ??= {
  STORAGE: 0x80,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  MAP_READ: 0x1,
  UNIFORM: 0x40,
  INDIRECT: 0x100,
  VERTEX: 0x20,
  QUERY_RESOLVE: 0x200,
};
globalThis.GPUMapMode ??= { READ: 1 };

/** A fake device that logs scope pops, their resolution and completion requests. */
function recordingDevice() {
  const log = [];
  let scopes = 0;
  const later = (what) =>
    new Promise((resolve) =>
      setTimeout(() => {
        log.push(what);
        resolve(null);
      }, 2),
    );
  const device = {
    log,
    features: new Set(),
    limits: {
      maxStorageBufferBindingSize: 1 << 30,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
      minStorageBufferOffsetAlignment: 256,
    },
    lost: new Promise(() => {}),
    pushErrorScope() {},
    popErrorScope() {
      log.push('pop');
      return later(`scope ${++scopes} back`);
    },
    createBuffer: ({ size }) => ({
      size,
      destroy() {},
      mapAsync() {
        log.push('map');
        return Promise.resolve();
      },
      getMappedRange: () => new ArrayBuffer(size),
    }),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone() {
        log.push('done');
        return Promise.resolve();
      },
    },
  };
  return device;
}

test('done() asks for completion only after an error-scope round trip', async () => {
  const device = recordingDevice(),
    gpu = await createCompute({ device });
  await gpu.done();
  assert.deepEqual(device.log, ['pop', 'scope 1 back', 'done']);
});

test('read() maps its staging buffer only after an error-scope round trip', async () => {
  const device = recordingDevice(),
    gpu = await createCompute({ device });
  const x = gpu.zeros(4);
  device.log.length = 0;
  await x.read();
  assert.deepEqual(device.log, ['pop', 'scope 1 back', 'map']);
});

// A device lost while an environment rebuilds on it (restore-fault sweep, scripts/restore-fault-sweep.mjs): its SH
// readback rejects. Core restores onto the next device and the environment rebuilds there, so that rejection is not a
// failure to report; a readback that fails on a device that is still alive is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Environment, EnvironmentLighting } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUMapMode: { READ: 1 },
});

/** A device whose readbacks wait until `finish()`; `lose()` rejects them as a browser does and settles `lost`. */
function device() {
  let lose, failMaps;
  const waiting = [],
    gpu = {
      lost: new Promise((resolve) => (lose = resolve)),
      limits: { maxTextureDimension2D: 8192 },
      features: new Set(),
      createBuffer: (d) => ({
        size: d.size,
        destroy() {},
        mapAsync: () =>
          new Promise((resolve, reject) => {
            if (failMaps) reject(new DOMException('Mapping failed', 'OperationError'));
            else waiting.push({ resolve, reject });
          }),
        getMappedRange: () => new ArrayBuffer(d.size),
        unmap() {},
      }),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createBindGroup: () => ({}),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      pushErrorScope() {},
      popErrorScope: async () => null,
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
        copyBufferToBuffer() {},
        copyTextureToTexture() {},
        finish: () => ({}),
      }),
      queue: { writeBuffer() {}, writeTexture() {}, submit() {}, onSubmittedWorkDone: async () => {} },
      finish: () => waiting.splice(0).forEach((map) => map.resolve()),
      lose() {
        lose({ reason: 'destroyed', message: 'destroyed' });
        for (const map of waiting.splice(0))
          map.reject(new DOMException('The Device was lost before mapping was resolved', 'AbortError'));
      },
      failMaps: () => (failMaps = true),
    };
  return gpu;
}
const image = { width: 8, height: 4, data: new Float32Array(8 * 4 * 4).fill(1) };
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(check(), 'an error was reported');
};

test('a device lost during an environment rebuild is not reported; the next restore rebuilds', async () => {
  const first = device(),
    renderer = { backend: 'webgpu', gpu: first, dispose() {} },
    engine = new Engine({ width: 16, height: 16 }, await TransformStore.create(4), renderer, {}, null),
    errors = [];
  engine.onError = (error) => errors.push(error);
  try {
    const attaching = Environment.attach(engine, image, { size: 16 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.finish();
    const environment = await attaching;
    const second = device();
    renderer.gpu = second;
    environment.onDeviceRestored(engine);
    const rebuilding = environment.restore(second);
    let pending = true;
    rebuilding.catch(() => {}).finally(() => (pending = false));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(pending, true);
    second.lose();
    await assert.rejects(rebuilding, { name: 'MargoError', code: 'failed', message: /device was lost.*errors#gpu-lost/ });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(errors, [], 'the lost rebuild reached engine.onError');
    assert.equal(environment.device, null, 'nothing of the lost device is kept');
    const third = device();
    renderer.gpu = third;
    environment.onDeviceRestored(engine);
    const restoring = environment.restore(third);
    await new Promise((resolve) => setTimeout(resolve, 5));
    third.finish();
    await restoring;
    assert.equal(environment.device, third);
    assert.deepEqual(errors, []);
  } finally {
    engine.dispose();
  }
});

test('a readback that fails on a live device is still reported', async () => {
  const first = device(),
    renderer = { backend: 'webgpu', gpu: first, dispose() {} },
    engine = new Engine({ width: 16, height: 16 }, await TransformStore.create(4), renderer, {}, null),
    errors = [];
  engine.onError = (error) => errors.push(error);
  try {
    const attaching = Environment.attach(engine, image, { size: 16 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.finish();
    const environment = await attaching;
    const second = device();
    second.failMaps();
    renderer.gpu = second;
    environment.onDeviceRestored(engine);
    // EnvironmentLighting restores the same environment; the one failure is reported once.
    EnvironmentLighting.attach(engine, environment).onDeviceRestored(engine);
    await until(() => errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'OperationError');
  } finally {
    engine.dispose();
  }
});

test('an environment disposed while it rebuilds releases the rebuild at dispose and reports nothing', async () => {
  const first = device(),
    renderer = { backend: 'webgpu', gpu: first, dispose() {} },
    engine = new Engine({ width: 16, height: 16 }, await TransformStore.create(4), renderer, {}, null),
    errors = [];
  engine.onError = (error) => errors.push(error);
  try {
    const attaching = Environment.attach(engine, image, { size: 16 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.finish();
    const environment = await attaching;
    // Every buffer and texture the rebuild makes on the next device, and whether it is destroyed yet.
    const second = device(),
      live = new Set();
    for (const name of ['createBuffer', 'createTexture']) {
      const create = second[name];
      second[name] = (descriptor) => {
        const resource = create(descriptor),
          destroy = resource.destroy;
        live.add(resource);
        resource.destroy = () => {
          live.delete(resource);
          destroy.call(resource);
        };
        return resource;
      };
    }
    renderer.gpu = second;
    environment.onDeviceRestored(engine);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(live.size > 0, 'the rebuild holds GPU resources while its readback waits');
    environment.dispose();
    assert.equal(live.size, 0, 'dispose released every resource of the running rebuild');
    second.finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(live.size, 0);
    assert.deepEqual(errors, [], 'the abandoned rebuild reached engine.onError');
  } finally {
    engine.dispose();
  }
});

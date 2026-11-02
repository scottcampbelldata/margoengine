import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BiomeWorld } from '../dist/index.js';

const options = { size: [256, 256], tileSize: 128, resolution: 4, height: { field: () => 20 } };
const failed = (error) => error.name === 'MargoError' && error.code === 'failed';

// Error transport only: this fake never computes fields or claims WGSL parity.
function fakeDevice(mode = 'pipeline') {
  const buffers = [], events = new EventTarget();
  let lose, rejectMap, mapped;
  const mappingStarted = new Promise((resolve) => { mapped = resolve; });
  const device = Object.assign(events, {
    lost: new Promise((resolve) => { lose = resolve; }),
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer() {}, submit() {} },
    pushErrorScope() {},
    popErrorScope: async () => mode === 'validation' ? { message: 'validation failure' } : null,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: mode === 'compile' ? [{ message: 'bad shader' }] : [] }) }),
    createComputePipelineAsync: async () => {
      if (mode === 'pipeline') throw Error('pipeline failure');
      return { getBindGroupLayout: () => ({}) };
    },
    createBuffer: () => {
      if (mode === 'allocation' && buffers.length === 1) throw RangeError('allocation failure');
      const buffer = {
        destroyed: false,
        destroy() { this.destroyed = true; },
        mapAsync() {
          mapped();
          if (mode === 'uncaptured') {
            device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'GPU failure' } }));
            return new Promise(() => {});
          }
          if (mode !== 'wait') return Promise.reject(Error('mapping failure'));
          return new Promise((_, reject) => { rejectMap = reject; });
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      copyBufferToBuffer() {}, finish: () => ({}),
    }),
    destroy() { assert.fail('The world must never destroy its caller-owned device'); },
  });
  return { device, buffers, mappingStarted, lose: () => { lose({ message: 'destroyed' }); rejectMap?.(Error('device lost')); },
    rejectMap: () => rejectMap?.(Error('mapping stopped')) };
}

function constants(t) {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, MAP_READ: 1 }, GPUMapMode: { READ: 1 },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
}

test('GPU option validation names the missing device and disallows workers', async () => {
  for (const device of [undefined, {}, null, { createBuffer() {}, queue: {} }])
    await assert.rejects(BiomeWorld.create({ ...options, backend: 'gpu', device }),
      (e) => e instanceof TypeError && /device/.test(e.message));
  const { device } = fakeDevice();
  await assert.rejects(BiomeWorld.create({ ...options, backend: 'gpu', device, workers: 2 }),
    (e) => e instanceof RangeError && /workers: 0/.test(e.message));
  for (const backend of ['cpu', 'auto', 'gpu'])
    await assert.rejects(BiomeWorld.create({ ...options, backend, device, workers: -1 }),
      (e) => e instanceof RangeError && /0\.\.16/.test(e.message));
});

test('a GPU world with omitted workers starts none, including in a browser environment', async (t) => {
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class { constructor() { assert.fail('worker started'); } } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.invalid/' } });
  t.after(() => {
    if (oldWorker) Object.defineProperty(globalThis, 'Worker', oldWorker); else delete globalThis.Worker;
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
  });
  const world = await BiomeWorld.create({ ...options, height: undefined, backend: 'gpu', device: fakeDevice().device });
  assert.equal(world.workers, undefined);
  world.dispose();
});

test('GPU errors and lost devices reject tiles and parts with failed; allocated buffers are destroyed', { timeout: 10000 }, async (t) => {
  constants(t);
  for (const mode of ['pipeline', 'compile', 'validation', 'allocation', 'map', 'uncaptured', 'lost']) {
    const fake = fakeDevice(mode);
    if (mode === 'lost') fake.lose();
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    try {
      await assert.rejects(world.tile(0, 0), failed);
      await assert.rejects(world.tile(0, 0, { layers: ['rainfall'] }), failed);
      await assert.rejects(world.tilePart(0, 0, [0, 0, 4, 3]), failed);
      assert.ok(fake.buffers.every((b) => b.destroyed), mode);
      if (mode === 'map' || mode === 'allocation') assert.ok(fake.buffers.length > 0);
    } finally { world.dispose(); }
    assert.ok(fake.buffers.every((b) => b.destroyed), mode);
  }
});

test('signals preserve their exact reason before and during GPU requests', { timeout: 10000 }, async (t) => {
  constants(t);
  for (const part of [false, true]) {
    const fake = fakeDevice('wait'), reason = { cancelled: true }, controller = new AbortController();
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    const request = (signal) => part
      ? world.tilePart(0, 0, [0, 0, 4, 3], { signal }) : world.tile(0, 0, { signal });
    await assert.rejects(request(AbortSignal.abort(reason)), (e) => e === reason);
    const pending = request(controller.signal);
    const rejected = assert.rejects(pending, (e) => e === reason);
    await fake.mappingStarted;
    controller.abort(reason);
    await rejected;
    // A tile's shared cached work outlives one caller's abort and still cleans up on failure.
    if (!part) {
      const shared = world.tile(0, 0);
      const sharedRejected = assert.rejects(shared, failed);
      fake.rejectMap();
      await sharedRejected;
    }
    world.dispose();
    assert.ok(fake.buffers.every((b) => b.destroyed));
  }
});

test('loss and disposal during readback reject and release all buffers', { timeout: 10000 }, async (t) => {
  constants(t);
  for (const dispose of [false, true]) {
    const fake = fakeDevice('wait');
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    const pending = world.tilePart(0, 0, [0, 0, 4, 3]);
    const rejected = assert.rejects(pending,
      (e) => e.name === 'MargoError' && e.code === (dispose ? 'disposed' : 'failed'));
    await fake.mappingStarted;
    if (dispose) world.dispose(); else fake.lose();
    await rejected;
    world.dispose();
    assert.ok(fake.buffers.length > 0 && fake.buffers.every((b) => b.destroyed));
  }
});

test('auto and cpu ignore device and retain existing default world digests', async () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
  for (const backend of ['auto', 'cpu']) {
    const world = await BiomeWorld.create({ backend, device: {}, workers: 0 });
    try {
      assert.equal(await world.digest(8, 8), golden.default88);
      assert.equal(await world.digest(0, 15), golden.default015);
    } finally { world.dispose(); }
  }
});

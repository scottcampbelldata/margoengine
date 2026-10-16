import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumLimits, scenarios, stressProfile, stressOptions, installStressGPU } from './support/stress-profiles.js';
import { aggregateStress } from '../scripts/aggregate-stress.js';

test('10,000 seeded profiles are reproducible, legal and partition without omissions', () => {
  const profiles = Array.from({ length: 10000 }, (_, index) => stressProfile(20261011, index));
  assert.deepEqual(
    profiles,
    Array.from({ length: 10000 }, (_, index) => stressProfile(20261011, index)),
  );
  assert.equal(new Set(profiles.map((profile) => JSON.stringify(profile.limits))).size > 9000, true);
  for (const profile of profiles) {
    for (const [key, minimum] of Object.entries(minimumLimits)) assert(profile.limits[key] >= minimum);
    assert(profile.limits.maxStorageBufferBindingSize <= profile.limits.maxBufferSize);
  }
  const shards = Array.from({ length: 7 }, (_, shard) => profiles.filter((profile) => profile.index % 7 === shard));
  assert.equal(new Set(shards.flat().map((profile) => profile.index)).size, 10000);
  assert.equal(new Set(profiles.map((profile) => profile.scenario)).size, scenarios.length);
});

test('stress arguments reject invalid, misspelled or unbounded workloads', () => {
  assert.equal(stressOptions(['--sessions=10000', '--shards=10', '--shard=9']).shard, 9);
  for (const arg of [
    '--frames=0',
    '--frames=11',
    '--seed=-1',
    '--sessions=NaN',
    '--sessions=1000001',
    '--splats=3000001',
    '--typo=1',
    '--constructor=1',
    '--shard=1',
  ])
    assert.throws(() => stressOptions([arg]));
});

test('GPU interception binds native accessors, forwards device limits and rejects excess before native calls', async () => {
  const originals = Object.fromEntries(
    ['window', 'navigator', 'GPUDevice', 'GPUBuffer', 'GPUTexture'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  class Resource {
    destroy() {
      this.destroyed = true;
    }
  }
  class Device {
    createBuffer() {
      return new Resource();
    }
    createTexture() {
      return new Resource();
    }
    addEventListener() {}
    destroy() {}
  }
  const profile = { ...stressProfile(1, 0), adapterDelay: 0, features: 'none' };
  let requested;
  const adapter = {
    limits: { ...minimumLimits },
    features: new Set(['depth32float-stencil8']),
    identity() {
      assert.equal(this, adapter);
      return true;
    },
    async requestDevice(descriptor) {
      assert.equal(this, adapter);
      requested = descriptor;
      return Object.assign(new Device(), {
        limits: descriptor.requiredLimits,
        features: new Set(descriptor.requiredFeatures),
      });
    },
  };
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter: async () => adapter } },
    });
    globalThis.window = { addEventListener() {}, GPUBuffer: Resource, GPUTexture: Resource };
    globalThis.GPUDevice = Device;
    installStressGPU(profile);
    const proxy = await navigator.gpu.requestAdapter();
    assert(proxy.identity());
    assert.equal(proxy.features.size, 0);
    const device = await proxy.requestDevice();
    assert.deepEqual(requested.requiredLimits, minimumLimits);
    await assert.rejects(
      proxy.requestDevice({ requiredLimits: { maxBufferSize: minimumLimits.maxBufferSize + 1 } }),
      /limit exceeded/,
    );
    await assert.rejects(proxy.requestDevice({ requiredFeatures: ['depth32float-stencil8'] }), /unavailable/);
    const buffer = device.createBuffer({ size: 4 });
    buffer.destroy();
    buffer.destroy();
    assert.equal(window.stressGPU.alive, 0);
    device.destroy();
    device.destroy();
    assert.equal(window.stressGPU.aliveDevices, 0);
  } finally {
    for (const [key, descriptor] of Object.entries(originals))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});

test('aggregation blocks incomplete, duplicated, mixed and failed evidence', () => {
  const options = stressOptions(['--sessions=20', '--shards=2']);
  const reports = [0, 1].map((shard) => ({
    version: 1,
    revision: 'abc',
    dirty: false,
    finished: 'now',
    options: { ...options, shard },
    hardware: {},
    sessions: Array.from({ length: 10 }, (_, i) => ({
      index: i * 2 + shard,
      profile: stressProfile(options.seed, i * 2 + shard),
      status: 'passed',
    })),
  }));
  assert.equal(aggregateStress(reports).passed, 20);
  assert.throws(() => aggregateStress(reports.slice(0, 1)), /Missing shards/);
  assert.throws(() => aggregateStress([reports[0], reports[0]]), /Duplicate/);
  const dirty = structuredClone(reports);
  dirty[0].dirty = true;
  assert.throws(() => aggregateStress(dirty), /clean checkout/);
  const partial = structuredClone(reports);
  partial[1].sessions.pop();
  assert.throws(() => aggregateStress(partial), /Missing sessions/);
  const mixed = structuredClone(reports);
  mixed[1].options.frames++;
  assert.throws(() => aggregateStress(mixed), /Mixed frames/);
  const failed = structuredClone(reports);
  failed[1].sessions[0].status = 'failed';
  assert.equal(aggregateStress(failed).failed, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { BiomeWorld, defineBiome } from '../dist/index.js';

const options = { size: [256, 256], tileSize: 128, resolution: 4, height: { field: () => 20 } };
const failed = (error) => error.name === 'MargoError' && error.code === 'failed';

// Error transport only: this fake never computes fields or claims WGSL parity.
function fakeDevice(mode = 'pipeline', onMap) {
  const buffers = [],
    events = new EventTarget();
  let lose, rejectMap, mapped;
  const mappingStarted = new Promise((resolve) => {
    mapped = resolve;
  });
  const device = Object.assign(events, {
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    queue: {
      writeBuffer(buffer, _offset, data) {
        buffer.values = new Uint32Array(data);
      },
      submit() {},
    },
    pushErrorScope() {},
    popErrorScope: async () => (mode === 'validation' ? { message: 'validation failure' } : null),
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: mode === 'compile' ? [{ message: 'bad shader' }] : [] }),
    }),
    createComputePipelineAsync: async () => {
      if (mode === 'pipeline') throw Error('pipeline failure');
      return { getBindGroupLayout: () => ({}) };
    },
    createBuffer: ({ size }) => {
      if (mode === 'allocation' && buffers.length === 1) throw RangeError('allocation failure');
      const buffer = {
        size,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        getMappedRange() {
          return this.values.buffer;
        },
        unmap() {},
        mapAsync() {
          mapped();
          if (mode === 'tail') return onMap?.() ?? Promise.resolve();
          if (mode === 'uncaptured') {
            device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'GPU failure' } }));
            return new Promise(() => {});
          }
          if (mode !== 'wait') return Promise.reject(Error('mapping failure'));
          return new Promise((_, reject) => {
            rejectMap = reject;
          });
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: (group) => group,
    createCommandEncoder: () => {
      let shape;
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup(_index, group) {
            shape = group.entries.find(
              ({ resource }) => resource.buffer.values?.length === 4 || resource.buffer.size === 32,
            )?.resource.buffer.values;
          },
          dispatchWorkgroups() {},
          end() {},
        }),
        copyBufferToBuffer(_src, _srcOffset, dst) {
          if (mode !== 'tail') return;
          // Transport stubs only: zero payload with execution markers reaches the CPU callback error paths.
          dst.values = new Int32Array(dst.size / 4);
          const count = shape[0] * shape[1],
            total = shape.length === 4 ? 5 * count : shape[7] ? shape[3] : 3 * count;
          for (let k = 0; k < dst.values.length - total; k++) dst.values[total + k] = k + 1;
        },
        finish: () => ({}),
      };
    },
    destroy() {
      assert.fail('The world must never destroy its caller-owned device');
    },
  });
  return {
    device,
    buffers,
    mappingStarted,
    lose: () => {
      lose({ message: 'destroyed' });
      rejectMap?.(Error('device lost'));
    },
    rejectMap: () => rejectMap?.(Error('mapping stopped')),
  };
}

function constants(t) {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, MAP_READ: 1 },
    GPUMapMode: { READ: 1 },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]));
  }
}

test('GPU option validation names the missing device and disallows workers', async () => {
  for (const device of [undefined, {}, null, { createBuffer() {}, queue: {} }])
    await assert.rejects(
      BiomeWorld.create({ ...options, backend: 'gpu', device }),
      (e) => e instanceof TypeError && /device/.test(e.message),
    );
  const { device } = fakeDevice();
  await assert.rejects(
    BiomeWorld.create({ ...options, backend: 'gpu', device, workers: 2 }),
    (e) => e instanceof RangeError && /workers: 0/.test(e.message),
  );
  for (const backend of ['cpu', 'auto', 'gpu'])
    await assert.rejects(
      BiomeWorld.create({ ...options, backend, device, workers: -1 }),
      (e) => e instanceof RangeError && /0\.\.16/.test(e.message),
    );
});

test('GPU region axes reject oversized grids before sampling; CPU keeps its domain', { timeout: 120000 }, async () => {
  const large = { ...options, size: [65536, 256], resolution: 0.5, regionResolution: 2 };
  const fake = fakeDevice();
  let sampled = false;
  for (const size of [large.size, [256, 65536]])
    await assert.rejects(
      BiomeWorld.create({
        ...large,
        size,
        height: {
          field() {
            sampled = true;
            return 20;
          },
        },
        backend: 'gpu',
        device: fake.device,
      }),
      (e) =>
        e instanceof RangeError &&
        /32768/.test(e.message) &&
        /regionResolution/.test(e.message) &&
        /size/.test(e.message),
    );
  assert.equal(sampled, false);
  assert.equal(fake.buffers.length, 0);
  const cpu = await BiomeWorld.create({ ...large, backend: 'cpu', workers: 0 });
  try {
    assert.equal(cpu.region.nx, 32769);
  } finally {
    cpu.dispose();
  }
});

test('GPU height domain errors name the bound and fix; CPU still makes the tile', async () => {
  const high = {
    ...options,
    height: { field: () => 1_500_000 },
    biomes: [defineBiome({ id: 'high', climate: { height: [1_400_000, 1_600_000] }, ground: [{ material: 'rock' }] })],
  };
  const fake = fakeDevice();
  await assert.rejects(
    BiomeWorld.create({ ...high, backend: 'gpu', device: fake.device }),
    (e) =>
      e instanceof RangeError && e.code !== 'failed' && /1073741824/.test(e.message) && /rescale|cpu/.test(e.message),
  );
  assert.equal(fake.buffers.length, 0);
  const cpu = await BiomeWorld.create({ ...high, backend: 'cpu', workers: 0 });
  try {
    const tile = await cpu.tile(0, 0);
    assert.equal(tile.layer('height').data[0], 1_500_000_000);
    assert.equal(tile.layer('biome').data[0], 0);
  } finally {
    cpu.dispose();
  }
});

test('GPU region upload limits reject at create before sampling', async () => {
  const fake = fakeDevice();
  fake.device.limits.maxStorageBufferBindingSize = 1;
  let sampled = false;
  await assert.rejects(
    BiomeWorld.create({
      ...options,
      backend: 'gpu',
      device: fake.device,
      height: {
        field() {
          sampled = true;
          return 20;
        },
      },
    }),
    (e) => e instanceof RangeError && /size/.test(e.message) && /regionResolution/.test(e.message),
  );
  assert.equal(sampled, false);
  assert.equal(fake.buffers.length, 0);
});

test('failed GPU updates keep heights, climate, options, region and cached tiles', async (t) => {
  constants(t);
  const fake = fakeDevice('tail');
  const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
  try {
    const region = world.region,
      climate = world.climate,
      height = world.heightAt(0, 0),
      tile = await world.tile(0, 0, { layers: ['height'] });
    const unchanged = () => {
      assert.equal(world.region, region);
      assert.equal(world.climate, climate);
      assert.equal(world.heightAt(0, 0), height);
      assert.ok(world.region.height.every((v) => v === 20000));
    };
    assert.throws(() => world.update({ height: { field: () => 1_500_000 }, climate: { latitude: 20 } }), RangeError);
    unchanged();
    assert.equal(await world.tile(0, 0, { layers: ['height'] }), tile);
    // An unrelated valid update must keep using the state from before the rejection.
    world.update({ paint: [] });
    unchanged();
    fake.device.limits.maxBufferSize = 1;
    assert.throws(
      () => world.update({ height: { field: () => 30 }, climate: { latitude: 20 } }),
      (e) => e instanceof RangeError && /size/.test(e.message) && /regionResolution/.test(e.message),
    );
    unchanged();
  } finally {
    world.dispose();
  }
});

test('GPU minimum classification bands reject at create and update atomically', async () => {
  const fake = fakeDevice(),
    biomes = Array.from({ length: 254 }, (_, i) =>
      defineBiome({ id: `b${i}`, climate: {}, ground: [{ material: 'rock' }] }),
    );
  // Fits the region and default classifier, but not a single wide row of 254 envelope biomes.
  fake.device.limits.maxStorageBufferBindingSize = 20000;
  await assert.rejects(
    BiomeWorld.create({ ...options, biomes, backend: 'gpu', device: fake.device }),
    (e) => e instanceof RangeError && /resolution/.test(e.message) && /biomes/.test(e.message),
  );
  const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
  try {
    const before = world.biomes;
    assert.throws(() => world.update({ biomes }), RangeError);
    assert.equal(world.biomes, before);
  } finally {
    world.dispose();
  }
});

test('GPU tile and part dispatch row bands within device limits', async (t) => {
  constants(t);
  for (const part of [false, true]) {
    const fake = fakeDevice('tail'),
      regionShapes = [],
      biomes = Array.from({ length: 80 }, (_, i) =>
        defineBiome({ id: `b${i}`, climate: {}, ground: [{ material: 'rock' }] }),
      ),
      reason = new TypeError('stop after first band');
    fake.device.limits.maxStorageBufferBindingSize = 134217728;
    fake.device.limits.maxBufferSize = 268435456;
    const write = fake.device.queue.writeBuffer;
    fake.device.queue.writeBuffer = (buffer, offset, data) => {
      if (buffer.size === 16 && data.length === 4) regionShapes.push([...data]);
      write(buffer, offset, data);
    };
    let reads = 0;
    const world = await BiomeWorld.create({
      ...options,
      tileSize: 256,
      resolution: 0.5,
      biomes,
      height: {
        field() {
          if (reads > 0) throw reason;
          return 20;
        },
      },
      backend: 'gpu',
      device: fake.device,
    });
    // Fail in the shared CPU tail after the first band upload; no fake output is used as byte-parity proof.
    reads++;
    try {
      await assert.rejects(part ? world.tilePart(0, 0, [0, 0, 512, 512]) : world.tile(0, 0), (e) => e === reason);
      assert.equal(regionShapes.length, 1);
      assert.equal(regionShapes[0][0], 514);
      assert.ok(regionShapes[0][1] >= 3 && regionShapes[0][1] < 514, 'full tile was split before dispatch');
      assert.ok(8 * (9 + 80) * regionShapes[0][0] * regionShapes[0][1] <= 134217728);
      assert.ok(fake.buffers.every((b) => b.destroyed));
    } finally {
      world.dispose();
    }
  }
});

test('GPU bands keep the request state across updates and raster writes', { timeout: 20000 }, async (t) => {
  constants(t);
  for (const part of [false, true]) {
    let resume,
      maps = 0,
      paintReads = 0,
      maskReads = 0;
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const fake = fakeDevice('tail', () => (++maps === 1 ? gate : Promise.resolve()));
    fake.device.limits.maxStorageBufferBindingSize = 20000;
    const regionPayloads = [],
      tables = [],
      shapes = [];
    const bind = fake.device.createBindGroup;
    fake.device.createBindGroup = (group) => {
      const buffers = group.entries.map(({ resource }) => resource.buffer);
      if (buffers.length === 4 && buffers[2].size === 16) {
        regionPayloads.push(buffers[0].values.slice());
        shapes.push([...buffers[2].values]);
      }
      if (buffers.length === 5 && buffers[3].size === 32) tables.push(buffers[2].values.slice());
      return bind(group);
    };
    const biomes = [0, 1].map((i) =>
      defineBiome({
        id: `snapshot-${i}`,
        climate: { height: [i * 10, 100], custom: { 'mask/custom': [0, 1] } },
        ground: [{ material: 'rock' }],
      }),
    );
    const world = await BiomeWorld.create({ ...options, biomes, backend: 'gpu', device: fake.device });
    const paint = new Uint8Array(32 * 32).fill(127),
      mask = new Uint8Array(32 * 32).fill(63);
    // Observe the CPU tail's raster inputs, not fake shader output or parity.
    for (const [data, read] of [
      [paint, () => paintReads++],
      [mask, () => maskReads++],
    ]) {
      data.slice = () => data;
      data.subarray = (...args) => {
        read();
        return Uint8Array.prototype.subarray.apply(data, args);
      };
    }
    world.writeLayer('paint/snapshot-1', 0, 0, paint);
    world.writeLayer('mask/custom', 0, 0, mask);
    try {
      const pending = part ? world.tilePart(0, 0, [1, 0, 31, 32]) : world.tile(0, 0);
      await fake.mappingStarted;
      world.update({
        climate: { latitude: 20, rainfall: 2000 },
        height: { field: () => 30 },
        biomes: biomes.map((b) => defineBiome({ ...b, climate: { height: [200, 300] } })),
      });
      for (const name of ['paint/snapshot-1', 'mask/custom']) {
        const replacement = new Uint8Array(32 * 32).fill(255);
        replacement.slice = () => replacement;
        replacement.subarray = () => {
          throw Error('in-flight request read a replacement raster');
        };
        world.writeLayer(name, 0, 0, replacement);
      }
      resume();
      const tile = await pending;
      assert.ok(regionPayloads.length > 1 && tables.length > 1, 'request completed multiple bands');
      assert.ok(
        shapes.every((shape) => shape[1] < 34),
        'request used row bands',
      );
      for (const payload of regionPayloads) assert.deepEqual(payload, regionPayloads[0]);
      for (const table of tables) assert.deepEqual(table, tables[0]);
      assert.ok(
        tile.layer('height').data.every((v) => v === 20000),
        'height source stays at request revision',
      );
      assert.ok(paintReads > 32 && maskReads > 32, 'every band reads the original paint and mask');
      assert.ok(fake.buffers.every((buffer) => buffer.destroyed));
    } finally {
      resume();
      world.dispose();
    }
  }
});

test('CPU callback failures preserve identity on GPU tiles and parts', async (t) => {
  constants(t);
  // Backend 'auto' with a device runs the same GPU path: a CPU callback error is not a device failure to fall back on.
  for (const backend of ['cpu', 'gpu', 'auto'])
    for (const kind of ['height', 'score', 'user']) {
      const reason = kind === 'height' ? new TypeError('height callback failed') : Error(`${kind} callback failed`);
      let throwing = false;
      const extra =
        kind === 'height'
          ? {
              height: {
                field() {
                  if (throwing) throw reason;
                  return 20;
                },
              },
            }
          : kind === 'score'
            ? {
                classifier: {
                  kind: 'whittaker',
                  perCell: true,
                  scorer: () => () => {
                    throw reason;
                  },
                },
              }
            : {
                biomes: [
                  defineBiome({
                    id: 'mask',
                    climate: { custom: { 'mask/custom': [0, 1] } },
                    ground: [{ material: 'rock' }],
                  }),
                ],
              };
      const fake = fakeDevice('tail');
      const world = await BiomeWorld.create({ ...options, ...extra, backend, device: fake.device, workers: 0 });
      try {
        throwing = true;
        if (kind === 'user') {
          const data = new Uint8Array(32 * 32);
          data.slice = () => data;
          world.writeLayer('mask/custom', 0, 0, data);
          // Inject a read failure in the stored raster without relying on private world state.
          data.subarray = () => {
            throw reason;
          };
        }
        await assert.rejects(world.tile(0, 0), (e) => e === reason);
        await assert.rejects(world.tilePart(0, 0, [0, 0, 4, 3]), (e) => e === reason);
      } finally {
        world.dispose();
      }
    }
});

test('a stale GPU rejection preserves the replacement tile cache entry', { timeout: 10000 }, async (t) => {
  constants(t);
  const gates = [];
  let secondMapped;
  const replacementMapping = new Promise((resolve) => {
    secondMapped = resolve;
  });
  const fake = fakeDevice('tail', () => {
    if (gates.length >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      gates.push({ resolve, reject });
      if (gates.length === 2) secondMapped();
    });
  });
  const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
  try {
    const first = world.tile(0, 0);
    const rejected = assert.rejects(first, failed);
    await fake.mappingStarted;
    world.update({ climate: { latitude: 20 } });
    const replacement = world.tile(0, 0);
    // A rejects after B reaches readback and occupies the cache key.
    await replacementMapping;
    gates[0].reject(Error('stale readback failed'));
    await rejected;
    gates[1].resolve();
    const tile = await replacement;
    const allocations = fake.buffers.length;
    assert.equal(await world.tile(0, 0), tile);
    assert.equal(fake.buffers.length, allocations, 'cache hit starts no new GPU work');
    assert.ok(fake.buffers.every((buffer) => buffer.destroyed));
  } finally {
    for (const gate of gates) gate.resolve();
    world.dispose();
  }
});

test('GPU worlds share one device loss reaction and unregister on disposal', async (t) => {
  const fake = fakeDevice();
  const then = t.mock.method(fake.device.lost, 'then');
  const abort = t.mock.method(AbortController.prototype, 'abort');
  for (let i = 0; i < 32; i++) {
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    world.dispose();
  }
  const disposedAborts = abort.mock.callCount();
  fake.lose();
  await setImmediate();
  assert.equal(abort.mock.callCount(), disposedAborts, 'no disposed controller remains registered');
  assert.equal(then.mock.callCount(), 1, 'one reaction for the caller-owned device');
  const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
  try {
    await assert.rejects(world.tile(0, 0), failed);
    assert.equal(then.mock.callCount(), 1, 'new worlds observe prior loss without another reaction');
  } finally {
    world.dispose();
  }
});

test('a live caller-owned device does not retain disposed GPU worlds', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const fake = fakeDevice();
  const reference = await (async () => {
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    world.dispose();
    return new WeakRef(world);
  })();
  try {
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      gc();
    }
    assert.equal(reference.deref(), undefined);
    assert.ok(fake.device.lost instanceof Promise);
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
});

test('a GPU world with omitted workers starts none, including in a browser environment', async (t) => {
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      constructor() {
        assert.fail('worker started');
      }
    },
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.invalid/' } });
  t.after(() => {
    if (oldWorker) Object.defineProperty(globalThis, 'Worker', oldWorker);
    else delete globalThis.Worker;
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation);
    else delete globalThis.location;
  });
  const world = await BiomeWorld.create({ ...options, height: undefined, backend: 'gpu', device: fakeDevice().device });
  assert.equal(world.workers, undefined);
  world.dispose();
});

test('GPU errors and lost devices reject tiles and parts with failed; allocated buffers are destroyed', {
  timeout: 10000,
}, async (t) => {
  constants(t);
  for (const mode of ['pipeline', 'compile', 'validation', 'allocation', 'map', 'uncaptured', 'lost']) {
    const fake = fakeDevice(mode);
    if (mode === 'lost') fake.lose();
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    try {
      await assert.rejects(world.tile(0, 0), failed);
      await assert.rejects(world.tile(0, 0, { layers: ['rainfall'] }), failed);
      await assert.rejects(world.tilePart(0, 0, [0, 0, 4, 3]), failed);
      assert.ok(
        fake.buffers.every((b) => b.destroyed),
        mode,
      );
      if (mode === 'map' || mode === 'allocation') assert.ok(fake.buffers.length > 0);
    } finally {
      world.dispose();
    }
    assert.ok(
      fake.buffers.every((b) => b.destroyed),
      mode,
    );
  }
});

test('signals preserve their exact reason before and during GPU requests', { timeout: 10000 }, async (t) => {
  constants(t);
  for (const part of [false, true]) {
    const fake = fakeDevice('wait'),
      reason = { cancelled: true },
      controller = new AbortController();
    const world = await BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device });
    const request = (signal) => (part ? world.tilePart(0, 0, [0, 0, 4, 3], { signal }) : world.tile(0, 0, { signal }));
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
    const rejected = assert.rejects(
      pending,
      (e) => e.name === 'MargoError' && e.code === (dispose ? 'disposed' : 'failed'),
    );
    await fake.mappingStarted;
    if (dispose) world.dispose();
    else fake.lose();
    await rejected;
    world.dispose();
    assert.ok(fake.buffers.length > 0 && fake.buffers.every((b) => b.destroyed));
  }
});

/** Asserts two tiles (or tile parts) hold the same layers with the same bytes. */
function sameTile(actual, expected, message) {
  assert.deepEqual(actual.layers, expected.layers, message);
  for (const name of expected.layers) assert.deepEqual(actual.layer(name).data, expected.layer(name).data, message);
}

test('auto uses a given device and makes a tile on the CPU, with the CPU bytes, when the device fails on it', {
  timeout: 20000,
}, async (t) => {
  constants(t);
  const cpu = await BiomeWorld.create({ ...options, backend: 'cpu' });
  const expected = [await cpu.tile(0, 0), await cpu.tile(0, 0, { layers: ['rainfall'] })];
  const part = await cpu.tilePart(0, 0, [0, 0, 4, 3]);
  cpu.dispose();
  for (const mode of ['pipeline', 'compile', 'validation', 'allocation', 'map', 'uncaptured', 'lost']) {
    const fake = fakeDevice(mode);
    if (mode === 'lost') fake.lose();
    const world = await BiomeWorld.create({ ...options, device: fake.device });
    try {
      sameTile(await world.tile(0, 0), expected[0], mode);
      sameTile(await world.tile(0, 0, { layers: ['rainfall'] }), expected[1], mode);
      sameTile(await world.tilePart(0, 0, [0, 0, 4, 3]), part, mode);
      // The device was tried first: backend 'auto' (the default) no longer ignores a given device.
      if (mode === 'map' || mode === 'allocation') assert.ok(fake.buffers.length > 0, mode);
      assert.ok(
        fake.buffers.every((b) => b.destroyed),
        mode,
      );
      const reason = { cancelled: true };
      await assert.rejects(
        world.tilePart(0, 1, [0, 0, 4, 3], { signal: AbortSignal.abort(reason) }),
        (e) => e === reason,
      );
    } finally {
      world.dispose();
    }
  }
});

test('auto: a device lost during readback finishes the tile on the CPU; disposal still rejects', {
  timeout: 10000,
}, async (t) => {
  constants(t);
  const cpu = await BiomeWorld.create({ ...options, backend: 'cpu' });
  const expected = await cpu.tilePart(0, 0, [0, 0, 4, 3]);
  cpu.dispose();
  for (const dispose of [false, true]) {
    const fake = fakeDevice('wait');
    const world = await BiomeWorld.create({ ...options, backend: 'auto', device: fake.device });
    const pending = world.tilePart(0, 0, [0, 0, 4, 3]);
    await fake.mappingStarted;
    if (dispose) {
      world.dispose();
      await assert.rejects(pending, (e) => e.name === 'MargoError' && e.code === 'disposed');
    } else {
      fake.lose();
      sameTile(await pending, expected);
      const made = fake.buffers.length;
      sameTile(await world.tilePart(0, 0, [0, 0, 4, 3]), expected);
      assert.equal(fake.buffers.length, made, 'after the loss, tiles go straight to the CPU');
    }
    world.dispose();
    assert.ok(fake.buffers.length > 0 && fake.buffers.every((b) => b.destroyed));
  }
});

test('auto makes a world its device cannot hold on the CPU instead of rejecting', async (t) => {
  constants(t);
  const high = {
    ...options,
    height: { field: () => 1_500_000 },
    biomes: [defineBiome({ id: 'high', climate: { height: [1_400_000, 1_600_000] }, ground: [{ material: 'rock' }] })],
  };
  const small = fakeDevice();
  small.device.limits.maxStorageBufferBindingSize = 1;
  for (const [world, fake] of [
    [high, fakeDevice()],
    [options, small],
  ]) {
    const cpu = await BiomeWorld.create({ ...world, backend: 'cpu' }),
      auto = await BiomeWorld.create({ ...world, backend: 'auto', device: fake.device });
    try {
      sameTile(await auto.tile(0, 0), await cpu.tile(0, 0));
      assert.equal(fake.buffers.length, 0);
    } finally {
      cpu.dispose();
      auto.dispose();
    }
  }
});

test('cpu ignores a device, auto ignores what is not a GPUDevice; both keep the default world digests', async () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
  for (const backend of ['auto', 'cpu']) {
    const world = await BiomeWorld.create({ backend, device: {}, workers: 0 });
    try {
      assert.equal(await world.digest(8, 8), golden.default88);
      assert.equal(await world.digest(0, 15), golden.default015);
    } finally {
      world.dispose();
    }
  }
});

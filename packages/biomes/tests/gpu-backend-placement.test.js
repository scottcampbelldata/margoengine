// Transport and public routing checks only. Real WGSL parity belongs to the hardware runner.
import './gpu-placement-flow-resolve.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
const m = await import('./gpu-placement-flow-source.mjs');
const { hydrologyOf, hydrologyOfAsync } = await import('../src/hydrology.ts');
const { fakeDevice, installGPUConstants } = await import('./gpu-placement-flow-fake.mjs');
const { placementBridges } = await import('../src/gpu-placement-flow-internal.ts');

const failed = (e) => e.name === 'MargoError' && e.code === 'failed';
const bytesHash = (tile) => {
  const hash = createHash('sha256');
  for (const part of m.tileBytes(tile)) hash.update(part);
  return hash.digest('hex');
};

// Use a real GPU-world registration and CPU field sampling so this oracle only executes the landed
// placement/flow transport. The fake does not implement world field or classification shaders.
async function fixture(t, fakeOptions = {}, gpu = true) {
  const spec = m.placementCases(m)[0];
  const options = { ...spec.options, size: [384, 384], workers: 0 };
  const cpu = await m.BiomeWorld.create({ ...options, backend: 'cpu' });
  const fake = fakeDevice(fakeOptions);
  const world = gpu ? await m.BiomeWorld.create({ ...options, backend: 'gpu', device: fake.device }) : cpu;
  const loads = [];
  if (gpu) {
    t.mock.method(world, 'tile', (x, z, options) => {
      loads.push([x, z, 'whole']);
      return cpu.tile(x, z, options);
    });
    t.mock.method(world, 'tilePart', (x, z, window, options) => {
      loads.push([x, z, [...window]]);
      return cpu.tilePart(x, z, window, options);
    });
  }
  const placement = m.BiomePlacement.attach(world, spec.placement);
  t.after(() => {
    placement.dispose();
    world.dispose();
    if (gpu) cpu.dispose();
  });
  return { world, cpu, fake, placement, loads, spec };
}

test('CPU public entries retain the pre-J6 bytes and async hydrology matches every field', async (t) => {
  const spec = m.placementCases(m)[0];
  const world = await m.BiomeWorld.create({ ...spec.options, workers: 0 });
  const p = m.BiomePlacement.attach(world, spec.placement);
  t.after(() => {
    p.dispose();
    world.dispose();
  });
  assert.equal(bytesHash(await p.tile(0, 0)), '80cf90dab6d8ec822e7f66fa72a2972010924e710731b12880233a0ccc440e99');
  const expectedDigest = createHash('sha256')
    .update(new TextEncoder().encode((await p.tile(0, 0)).species.join(',') + ';' + (await p.tile(0, 0)).count + ';'))
    .update((await p.tile(0, 0)).instances)
    .digest('hex');
  assert.equal(await p.digest(0, 0), expectedDigest);
  for (const options of [{}, { multiple: true, sea: -123, channelCells: 3, lakeDepth: 500 }])
    assert.deepEqual(await hydrologyOfAsync(world, options), hydrologyOf(world, options));
});

test('GPU public tile routes through kernels, keeps bands/ahead, digest and the shared cache', {
  timeout: 30000,
}, async (t) => {
  installGPUConstants(t);
  const { cpu, fake, placement: p, loads, spec } = await fixture(t);
  const reference = m.BiomePlacement.attach(cpu, spec.placement);
  t.after(() => reference.dispose());
  const actual = await p.tile(1, 1, { ahead: [[2, 1]] });
  assert.deepEqual(m.tileBytes(actual), m.tileBytes(await reference.tile(1, 1)));
  assert.equal(await p.digest(1, 1), await reference.digest(1, 1));
  const own = loads.find(([x, z]) => x === 1 && z === 1);
  const ahead = loads.find(([x, z]) => x === 2 && z === 1);
  assert.equal(own[2], 'whole');
  assert.equal(ahead[2], 'whole');
  assert.ok(
    loads.some(([, , window]) => Array.isArray(window)),
    'cold neighbours start as bands',
  );
  assert.ok(fake.dispatch.some(([name]) => name === 'counts'));
  assert.ok(fake.dispatch.some(([name]) => name === 'emit'));
  const dispatches = fake.dispatch.length;
  assert.equal(await p.tile(1, 1), actual);
  assert.equal(fake.dispatch.length, dispatches);
  // Eager GPU dependency reads cross the bands and must retry with whole fields.
  assert.ok(
    loads.some(
      ([x, z, kind], i) =>
        kind === 'whole' && loads.slice(0, i).some(([bx, bz, window]) => bx === x && bz === z && Array.isArray(window)),
    ),
    'a missing band is reloaded whole',
  );
  assert.ok(fake.dispatch.filter(([name]) => name === 'counts').length > 1, 'missing reads repeat the GPU run');
  fake.assertFreed();
});

test('direct bridge calls keep whole dependency windows without a public call context', async (t) => {
  installGPUConstants(t);
  const { placement: p, fake, loads } = await fixture(t);
  await m.placeTileGPU(fake.device, p, 0, 0);
  assert.ok(loads.length > 0);
  assert.ok(loads.every(([, , kind]) => kind === 'whole'));
  fake.assertFreed();
});

test('CPU and GPU validate tile options and pre-aborted requests in the same order', async (t) => {
  for (const gpu of [false, true]) {
    const { world, placement: p, fake } = await fixture(t, {}, gpu);
    const reason = { cancelled: true };
    const signal = AbortSignal.abort(reason);
    await assert.rejects(p.tile(-1, 0, { signal }), RangeError);
    await assert.rejects(p.tile(0, 0, { ahead: 1 }), TypeError);
    await assert.rejects(p.tile(0, 0, { ahead: [null] }), TypeError);
    await assert.rejects(p.tile(0, 0, { signal }), (e) => e === reason);
    await assert.rejects(p.digest(0, 0, { signal }), (e) => e === reason);
    await assert.rejects(hydrologyOfAsync(world, {}, { signal }), (e) => e === reason);
    assert.equal(fake.dispatch.length, 0);
    for (const options of [{ channelCells: 0 }, { lakeDepth: 0 }]) {
      let expected;
      try {
        hydrologyOf(world, options);
      } catch (e) {
        expected = e;
      }
      await assert.rejects(
        hydrologyOfAsync(world, options),
        (e) => e.constructor === expected.constructor && e.message === expected.message && e.code === expected.code,
      );
    }
  }
});

test('GPU async hydrology routes options and the sync entry stays CPU-only', async (t) => {
  installGPUConstants(t);
  const { world, fake } = await fixture(t);
  const options = { sea: -1, multiple: true, channelCells: 3, lakeDepth: 20 };
  const expected = hydrologyOf(world, options);
  assert.equal(fake.dispatch.length, 0);
  assert.deepEqual(await hydrologyOfAsync(world, options), expected);
  assert.ok(fake.dispatch.some(([name]) => name === 'd8'));
  assert.ok(fake.dispatch.some(([name]) => name === 'accumulate'));
  fake.assertFreed();
});

test('public GPU entries reject storage limits before device work and placement retries after recovery', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  for (const limit of ['maxBufferSize', 'maxStorageBufferBindingSize']) {
    const { world, cpu, fake, placement: p, spec, loads } = await fixture(t);
    const reference = m.BiomePlacement.attach(cpu, spec.placement);
    t.after(() => reference.dispose());
    let pipelines = 0;
    const createPipeline = fake.device.createComputePipelineAsync;
    t.mock.method(fake.device, 'createComputePipelineAsync', (descriptor) => {
      pipelines++;
      return createPipeline(descriptor);
    });
    const original = fake.device.limits[limit];
    fake.device.limits[limit] = 4;
    const storageError = (error) =>
      error instanceof RangeError && /GPU storage exceeds device limits/.test(error.message);
    await assert.rejects(p.tile(0, 0), storageError, limit);
    await assert.rejects(p.digest(0, 0), storageError, limit);
    await assert.rejects(hydrologyOfAsync(world), storageError, limit);
    assert.equal(pipelines, 0, 'storage preflight precedes pipeline creation');
    assert.equal(fake.buffers.length, 0, 'storage preflight precedes buffer allocation');
    assert.equal(fake.dispatch.length, 0, 'storage preflight precedes dispatch');
    assert.deepEqual(loads, [], 'placement preflight precedes field loading');
    fake.assertFreed();

    fake.device.limits[limit] = original;
    assert.deepEqual(m.tileBytes(await p.tile(0, 0)), m.tileBytes(await reference.tile(0, 0)));
    assert.equal(await p.digest(0, 0), await reference.digest(0, 0));
    assert.deepEqual(await hydrologyOfAsync(world), hydrologyOf(cpu));
    assert.ok(pipelines > 0, 'recovered requests execute on the GPU backend');
    fake.assertFreed();
  }
});

test('abort during CPU/GPU work preserves reason and rejected placement cache entries retry', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  for (const gpu of [false, true]) {
    const controller = new AbortController(),
      reason = { midRun: true };
    let aborted = false;
    const {
      world,
      placement: p,
      fake,
    } = await fixture(
      t,
      {
        onMap() {
          if (!aborted) {
            aborted = true;
            controller.abort(reason);
          }
        },
      },
      gpu,
    );
    const pending = p.tile(0, 0, { signal: controller.signal });
    if (!gpu) controller.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
    assert.ok((await p.tile(0, 0)).count > 0);
    const flowAbort = new AbortController();
    const flow = hydrologyOfAsync(world, {}, { signal: flowAbort.signal });
    flowAbort.abort(reason);
    await assert.rejects(flow, (e) => e === reason);
    fake.assertFreed();
  }
});

test('GPU loss during work and pipeline creation failures reject with failed', { timeout: 15000 }, async (t) => {
  installGPUConstants(t);
  for (const fail of ['lost', 'sync-pipeline']) {
    for (const entry of ['tile', 'hydrology']) {
      const { world, placement: p, fake } = await fixture(t, { fail });
      await assert.rejects(entry === 'tile' ? p.tile(0, 0) : hydrologyOfAsync(world), failed);
      fake.assertFreed();
    }
  }
  const { world, placement: p, fake } = await fixture(t);
  fake.lose({ message: 'lost before dispatch' });
  await setImmediate();
  await assert.rejects(p.tile(0, 0), failed);
  await assert.rejects(hydrologyOfAsync(world), failed);
});

test('updates invalidate GPU placement and an in-flight plan change fails without poisoning its replacement', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  let update;
  const {
    world,
    placement: p,
    fake,
  } = await fixture(t, {
    onMap() {
      update?.();
      update = undefined;
    },
  });
  let notifications = 0;
  const off = p.onChange(() => notifications++);
  const first = await p.tile(0, 0);
  p.update({ exclusions: [] });
  assert.equal(notifications, 1);
  assert.notEqual(await p.tile(0, 0), first);
  world.update({ climate: { latitude: 20 } });
  assert.equal(notifications, 2);
  update = () => p.update({ conflicts: {} });
  await assert.rejects(p.tile(0, 0), failed);
  assert.ok((await p.tile(0, 0)).count > 0);
  assert.ok((await p.inspect(world.bounds)).length > 0);
  off();
  assert.ok(placementBridges.has(p));
  fake.assertFreed();
});

test('CPU sampling failures on public GPU placement keep their original identity', async (t) => {
  installGPUConstants(t);
  const { world, placement: p, fake } = await fixture(t);
  const reason = new TypeError('height callback failed');
  const sample = world.tile;
  t.mock.method(world, 'tile', () => {
    throw reason;
  });
  await assert.rejects(p.tile(0, 0), (e) => e === reason);
  t.mock.method(world, 'tile', sample);
  assert.ok((await p.tile(0, 0)).count > 0);
  fake.assertFreed();
});

test('abort during GPU hydrology readback retains the reason and frees buffers', async (t) => {
  installGPUConstants(t);
  const controller = new AbortController(),
    reason = { hydrologyReadback: true };
  const { world, fake } = await fixture(t, {
    onMap() {
      controller.abort(reason);
      return new Promise(() => {});
    },
  });
  await assert.rejects(hydrologyOfAsync(world, {}, { signal: controller.signal }), (e) => e === reason);
  fake.assertFreed();
});

test('concurrent GPU placements capture independent loading contexts and cached adjacency promotes neighbours', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  const { cpu, placement: p, loads, spec, fake } = await fixture(t);
  const reference = m.BiomePlacement.attach(cpu, spec.placement);
  t.after(() => reference.dispose());
  const actual = await Promise.all([p.tile(0, 0, { ahead: [[1, 0]] }), p.tile(2, 2, { ahead: [] })]);
  for (const [i, [x, z]] of [
    [0, 0],
    [2, 2],
  ].entries())
    assert.deepEqual(m.tileBytes(actual[i]), m.tileBytes(await reference.tile(x, z)));
  loads.length = 0;
  const next = await p.tile(1, 1);
  assert.deepEqual(m.tileBytes(next), m.tileBytes(await reference.tile(1, 1)));
  assert.ok(
    loads.every(([, , kind]) => kind === 'whole'),
    'cached neighbours keep the existing whole-tile heuristic',
  );
  fake.assertFreed();
});

test('the hardware runner bundles the full public placement/hydrology matrix', async () => {
  const { backendPlacementModuleCode } = await import('./gpu-backend-placement-entry.mjs');
  const code = await backendPlacementModuleCode();
  for (const name of [
    'runBackendPlacementCases',
    'R16-mountain',
    'island-clearing-exclusions',
    'coast-south',
    'samples-flats',
  ])
    assert.ok(code.includes(name), name);
});

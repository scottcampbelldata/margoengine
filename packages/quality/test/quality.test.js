import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyQualityTier,
  watchQuality,
  FAST_GPU_MS,
  capFrameRate,
  paceEngine,
  qualityPreset,
  QUALITY_PRESETS,
} from '../dist/index.js';
import { Engine } from '../../core/dist/engine.js';
import { TransformStore } from '../../core/dist/kernel.js';
import { sceneSamples } from '../../core/dist/quality.js';
import { SSAO } from '../../post/dist/index.js';
import { VolumetricFog } from '../../environment/dist/volumetric.js';

const memory = (values = {}) => ({
  values,
  getItem: (key) => values[key] ?? null,
  setItem(key, value) {
    values[key] = value;
  },
});
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155',
  phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) Mobile',
  android = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/155 Mobile Safari/537.36';

test('desktops start light unless a measured or forced tier says otherwise', () => {
  try {
    assert.equal(applyQualityTier({ search: '', storage: memory(), userAgent: desktop }), 'light');
    assert.equal(globalThis.margoLow, 1);
    assert.equal(applyQualityTier({ search: '?scale=1.5', storage: memory(), userAgent: desktop }), 'light');
    assert.equal(globalThis.margoLow, 1.5);
    assert.equal(
      applyQualityTier({ search: '', storage: memory({ margoQuality: 'high' }), userAgent: desktop }),
      'high',
    );
    assert.equal(globalThis.margoLow, undefined);
    assert.equal(
      applyQualityTier({ search: '?quality=low', storage: memory({ margoQuality: 'high' }), userAgent: desktop }),
      'light',
    );
    assert.equal(
      applyQualityTier({ search: '', storage: memory({ margoLow: '1' }), userAgent: desktop }),
      'light',
      'older key still means low',
    );
  } finally {
    delete globalThis.margoLow;
  }
});

for (const [device, userAgent] of [
  ['Android', android],
  ['iPhone', phone],
  ['iPhone without Mobile', 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X)'],
]) {
  test(`${device} user agents select 1x pixels with SSAO and volumetric fog disabled`, () => {
    try {
      for (const search of ['', '?quality=high&scale=2']) {
        globalThis.margoLow = 1.5;
        assert.equal(applyQualityTier({ search, storage: memory({ margoQuality: 'high' }), userAgent }), 'phone');
        assert.equal(globalThis.margoLow, 1);
        assert.equal(globalThis.margoPreset, QUALITY_PRESETS.phone);
        assert.equal(qualityPreset(), QUALITY_PRESETS.phone);
        assert.equal(qualityPreset().ssao.enabled, false);
        assert.equal(qualityPreset().volumetric.enabled, false);
        assert.equal(new SSAO().enabled, false);
        const passes = [];
        new VolumetricFog().registerPasses({ add: (pass) => passes.push(pass) });
        assert.doesNotThrow(() => passes[0].execute({ backend: 'webgpu' }), 'an unattached fog draws nothing here');
      }
    } finally {
      delete globalThis.margoLow;
      delete globalThis.margoPreset;
    }
  });
}

test('desktop user agents keep light scaling and high defaults after a phone tier', () => {
  try {
    for (const userAgent of [desktop, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) Safari/605.1.15']) {
      applyQualityTier({ search: '', storage: memory(), userAgent: phone });
      assert.equal(applyQualityTier({ search: '?scale=1.5', storage: memory(), userAgent }), 'light');
      assert.equal(globalThis.margoLow, 1.5);
      assert.equal(globalThis.margoPreset, QUALITY_PRESETS.light);
      assert.equal(globalThis.margoPreset.ssao.enabled, undefined);
      assert.equal(globalThis.margoPreset.volumetric.enabled, undefined);
      assert.equal(applyQualityTier({ search: '?quality=high', storage: memory(), userAgent }), 'high');
      assert.equal(Object.hasOwn(globalThis, 'margoLow'), false);
      assert.deepEqual(globalThis.margoPreset, {});
    }
  } finally {
    delete globalThis.margoLow;
    delete globalThis.margoPreset;
  }
});

test('VolumetricFog with enabled false keeps a pass that draws nothing, so enabled stays live', () => {
  const passes = [];
  new VolumetricFog({ enabled: false }).registerPasses({ add: (pass) => passes.push(pass) });
  assert.doesNotThrow(() => passes[0].execute({ backend: 'webgpu' }), 'an unattached fog draws nothing here');
});

test('VolumetricFog without enabled still registers its pass', () => {
  const passes = [];
  new VolumetricFog().registerPasses({ add: (pass) => passes.push(pass) });
  assert.equal(passes.length, 1);
  assert.equal(passes[0].name, 'volumetric-fog');
  assert.equal(typeof passes[0].execute, 'function');
});

// Contract with the feature packages (readers: packages/shared/preset.js, tests/quality-presets.test.js): the tier's preset
// is published as globalThis.margoPreset, keyed by feature, with values named like that feature's options.
test('applyQualityTier publishes the tier preset as globalThis.margoPreset; the full tier keeps package defaults', () => {
  try {
    assert.equal(applyQualityTier({ search: '', storage: memory(), userAgent: desktop }), 'light');
    assert.equal(globalThis.margoPreset, QUALITY_PRESETS.light);
    assert.equal(qualityPreset(), QUALITY_PRESETS.light);
    assert.deepEqual(QUALITY_PRESETS.light, {
      shadows: { resolution: 1024, filter: 'pcf' },
      ssao: { samples: 16 },
      ssr: { enabled: false, steps: 32 },
      volumetric: { grid: [80, 45, 32] },
      localShadows: { resolution: 256 },
      vfx: { capacity: 100_000 },
    });
    applyQualityTier({ search: '', storage: memory(), userAgent: phone });
    assert.equal(globalThis.margoPreset, QUALITY_PRESETS.phone);
    assert.notEqual(QUALITY_PRESETS.phone, QUALITY_PRESETS.light);
    // Phones: PCF shadows on two cascades, and no scatter LOD fade (its discard defeats early depth rejection).
    assert.deepEqual(QUALITY_PRESETS.phone, {
      shadows: { resolution: 1024, filter: 'pcf', cascades: 2 },
      ssao: { enabled: false },
      ssr: { enabled: false, steps: 32 },
      volumetric: { enabled: false },
      localShadows: { resolution: 256 },
      vfx: { capacity: 100_000 },
      scatter: { lodFade: 0 },
    });
    assert.deepEqual(QUALITY_PRESETS.light.shadows, { resolution: 1024, filter: 'pcf' }, 'light keeps four cascades');
    applyQualityTier({ search: '', storage: memory({ margoQuality: 'high' }), userAgent: desktop });
    assert.deepEqual(globalThis.margoPreset, {});
    assert.deepEqual(qualityPreset(), {});
  } finally {
    delete globalThis.margoLow;
    delete globalThis.margoPreset;
  }
});

// Drive the full-tier watcher with synthetic frame timestamps; `gaps` lists [interval ms, frame count] runs.
function fullTier(gaps) {
  const frames = [],
    calls = { store: [], reload: 0 };
  applyQualityTier({ search: '', storage: memory({ margoQuality: 'high' }), userAgent: desktop });
  watchQuality({
    request: (callback) => frames.push(callback),
    store: (value) => calls.store.push(value),
    reload: () => calls.reload++,
  });
  let now = 1000;
  for (const [interval, count] of gaps)
    for (let i = 0; i < count && frames.length; i++) frames.shift()((now += interval));
  return { ...calls, watching: frames.length > 0 };
}
test('on the full tier, sustained slow frames store low and reload once; fast or interrupted frames do not', () => {
  assert.deepEqual(fullTier([[25, 400]]), { store: ['low'], reload: 1, watching: false }, '40 FPS for ten seconds');
  assert.deepEqual(
    fullTier([[1000 / 60, 3000]]),
    { store: [], reload: 0, watching: false },
    '60 FPS stops watching after 30 s',
  );
  assert.deepEqual(
    fullTier([
      [25, 150],
      [5000, 1],
      [1000 / 60, 300],
    ]),
    { store: [], reload: 0, watching: true },
    'a hidden-tab gap resets the count',
  );
});

// A fake WebGPU for the light-tier reading. `passMs`: each frame's passes by timestamps. `doneMs`: what submit to done would
// read (the old rule's number): the presenting floor and other work on the machine, which the reading must ignore.
function fakeGpu({ passMs = 2, doneMs = passMs, passes = 3, encoders = 1, feature = true, zero = false, overlap = false } = {}) {
  const live = new Set(),
    make = (object) => (live.add(object), object);
  let clock = 0;
  const gpu = {
    live,
    wrote: 0,
    stamp: 1000n,
    pending: [],
    clock: () => clock,
    queue: {
      submit(buffers) {
        for (const buffer of buffers) buffer.run?.();
      },
      onSubmittedWorkDone() {
        const start = clock;
        return new Promise((resolve) =>
          gpu.pending.push(() => {
            clock = Math.max(clock, start + doneMs);
            resolve();
          }),
        );
      },
    },
    device: {
      features: new Set(feature ? ['timestamp-query'] : []),
      createQuerySet: () =>
        make({
          stamps: [],
          destroy() {
            live.delete(this);
          },
        }),
      createBuffer: () =>
        make({
          destroy() {
            live.delete(this);
            this.dead = true;
          },
          mapAsync() {
            return this.dead ? Promise.reject(new Error('destroyed')) : Promise.resolve();
          },
          getMappedRange() {
            return this.data;
          },
          unmap() {},
        }),
      createCommandEncoder() {
        const steps = [],
          begin = (pass) => {
            const writes = pass?.timestampWrites;
            if (writes?.querySet) {
              gpu.wrote++;
              const each = BigInt(Math.round((passMs * 1e6) / (passes * encoders)));
              // Passes run one after another unless `overlap`: then every pass of a frame runs at once, as on a tiled GPU.
              const start = overlap ? 1000n : gpu.stamp;
              writes.querySet.stamps[writes.beginningOfPassWriteIndex] = start;
              writes.querySet.stamps[writes.endOfPassWriteIndex] = start + each;
              gpu.stamp = start + each;
            }
            return { end() {} };
          };
        return {
          beginRenderPass: begin,
          beginComputePass: begin,
          resolveQuerySet: (set, _first, count, resolve) => steps.push(() => (resolve.from = { set, count })),
          copyBufferToBuffer: (resolve, _a, read, _b, size) =>
            steps.push(() => {
              const stamps = new BigInt64Array(size / 8);
              for (let i = 0; i < stamps.length; i++) stamps[i] = zero ? 0n : (resolve.from.set.stamps[i] ?? 0n);
              read.data = stamps.buffer;
            }),
          finish: () => ({ run: () => steps.forEach((step) => step()) }),
        };
      },
    },
    frame(pageTimed = false) {
      for (let e = 0; e < encoders; e++) {
        const encoder = gpu.device.createCommandEncoder();
        for (let p = 0; p < passes; p++)
          encoder[p % 2 ? 'beginComputePass' : 'beginRenderPass'](pageTimed ? { timestampWrites: {} } : {}).end();
        gpu.queue.submit([encoder.finish()]);
      }
    },
  };
  return gpu;
}
// The reading is its own chunk: wait for its first frame request.
async function started(frames) {
  for (let i = 0; i < 2000 && !frames.length; i++) await new Promise(setImmediate);
}
// Frames at `hz` until the watcher stops asking for them. Maps resolve between frames, as they do on a real queue.
async function drive(gpu, frames, hz = 60) {
  await started(frames);
  for (let i = 0; i < 1500 && frames.length; i++) {
    frames.shift()((i * 1000) / hz);
    gpu.frame();
    while (gpu.pending.length) gpu.pending.shift()();
    await new Promise(setImmediate);
  }
}
// One visit on the light tier until the reading ends: what was stored and reported. Checks everything was put back.
async function visit(options, saved, { pageTimed = false } = {}) {
  const gpu = fakeGpu(options),
    frames = [],
    storage = memory(saved),
    readings = [],
    submit = gpu.queue.submit,
    create = gpu.device.createCommandEncoder,
    plain = gpu.frame;
  if (pageTimed) gpu.frame = () => plain(true);
  let reloads = 0;
  try {
    assert.equal(applyQualityTier({ search: '', storage, userAgent: desktop }), 'light');
    watchQuality({
      request: (callback) => frames.push(callback),
      queue: gpu.queue,
      device: gpu.device,
      onReading: (ms) => readings.push(ms),
      now: gpu.clock, // what the old rule read: these pins run it on its own clock, and the reading ignores it
      reload: () => reloads++,
    });
    await drive(gpu, frames);
    assert.equal(reloads, 0, 'the light tier never reloads');
    assert.equal(gpu.queue.submit, submit, 'submit is put back');
    assert.equal(gpu.device.createCommandEncoder, create, 'createCommandEncoder is put back');
    assert.equal(gpu.live.size, 0, 'every query set and buffer is destroyed');
    const wrote = gpu.wrote;
    plain();
    assert.equal(gpu.wrote, wrote, 'a frame after the reading has no timestamp writes');
    return { stored: storage.getItem('margoQuality'), readings, wrote };
  } finally {
    delete globalThis.margoLow;
    delete globalThis.margoPreset;
  }
}

test('the light tier remembers the full tier when the GPU time is under the limit, and never reloads', async () => {
  const fast = await visit({ passMs: FAST_GPU_MS - 1 });
  assert.equal(fast.stored, 'high');
  assert.ok(Math.abs(fast.readings[0] - (FAST_GPU_MS - 1)) < 0.01, `read ${fast.readings[0]} ms`);
  assert.equal((await visit({ passMs: FAST_GPU_MS, passes: 1 })).stored, null, 'at the limit is not under it');
  assert.equal((await visit({ passMs: 16 })).stored, null, 'the Arc 140V in real play stays light');
});

// These two fail on the rule that read submit to done: both pass under timestamps, neither under a limit of 5 on that clock.
test('a one-triangle page reads its own GPU time, not the 4 to 5 ms floor of presenting to a canvas', async () => {
  assert.equal((await visit({ passMs: 0.01, doneMs: 5.1 })).stored, 'high');
});
test('a rival load on the machine does not hold a strong GPU on the light tier', async () => {
  assert.equal((await visit({ passMs: 4.7, doneMs: 11.8 })).stored, 'high');
});
test('a fast submit to done does not promote a slow GPU', async () => {
  assert.equal((await visit({ passMs: 12, doneMs: 3 })).stored, null);
});

test('a frame is the sum of all its encoders, not one submission', async () => {
  const split = await visit({ passMs: 12, encoders: 4 });
  assert.equal(split.stored, null, '3 ms a submission is still a 12 ms frame');
  assert.ok(Math.abs(split.readings[0] - 12) < 0.01, `read ${split.readings[0]} ms`);
});

// An Apple M6 runs a frame's passes side by side: at 60 FPS, 11 passes added up to 31 ms a frame in Chrome and 19 ms in
// WebKit, though the GPU was busy for 8 ms of each frame. Adding them up counts the same time several times over.
test('passes that run at the same time count once', async () => {
  const side = await visit({ passMs: 12, passes: 4, overlap: true });
  assert.ok(Math.abs(side.readings[0] - 3) < 0.01, `read ${side.readings[0]} ms`);
  assert.equal(side.stored, 'high', 'four 3 ms passes side by side are a 3 ms frame');
});

test('without timestamp-query the page stays light, stores nothing and stops at once', async () => {
  const none = await visit({ feature: false });
  assert.equal(none.stored, null);
  assert.deepEqual(none.readings, [undefined]);
  assert.equal(none.wrote, 0);
});

test('frames the reading cannot trust store nothing', async () => {
  assert.equal((await visit({ zero: true })).stored, null, 'a browser returning empty timestamps');
  assert.equal((await visit({}, undefined, { pageTimed: true })).stored, null, 'a page timing its own passes');
  assert.equal((await visit({ passes: 200 })).stored, null, 'more passes than the queries hold');
});

test('applyQualityTier asks for timestamp-query only on a page still to be measured, until the reading starts', () => {
  const asks = [];
  class Adapter {
    features = new Set(['timestamp-query']);
    requestDevice(descriptor) {
      asks.push([...(descriptor?.requiredFeatures ?? [])]);
    }
  }
  const plain = Adapter.prototype.requestDevice,
    adapter = new Adapter();
  globalThis.GPUAdapter = Adapter;
  try {
    for (const [search, saved, expected] of [
      ['?quality=low', {}, []],
      ['?quality=high', {}, []],
      ['', { margoQuality: 'high' }, []],
      ['', { margoQuality: 'held' }, []],
      ['', {}, ['timestamp-query']],
      ['', { margoQuality: 'low' }, ['timestamp-query']],
    ]) {
      asks.length = 0;
      applyQualityTier({ search, storage: memory(saved), userAgent: desktop });
      adapter.requestDevice();
      assert.deepEqual(asks[0], expected, `${search} ${JSON.stringify(saved)}`);
    }
    asks.length = 0;
    adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
    assert.deepEqual(asks[0], ['timestamp-query'], 'never asked twice');
    applyQualityTier({ search: '', storage: memory(), userAgent: phone });
    assert.equal(Adapter.prototype.requestDevice, plain, 'phones leave it alone');
    applyQualityTier({ search: '', storage: memory(), userAgent: desktop });
    assert.notEqual(Adapter.prototype.requestDevice, plain);
    adapter.features = new Set();
    asks.length = 0;
    adapter.requestDevice();
    assert.deepEqual(asks[0], [], 'an adapter without it is not asked for it');
    const gpu = fakeGpu();
    watchQuality({ request: () => {}, queue: gpu.queue, device: gpu.device });
    assert.equal(Adapter.prototype.requestDevice, plain, 'put back when the watcher starts');
  } finally {
    delete globalThis.GPUAdapter;
    delete globalThis.margoLow;
    delete globalThis.margoPreset;
  }
});

test('the result belongs to the page it measured: a light scene does not mark a weak PC high for other pages', async () => {
  const storage = memory(),
    gpu = fakeGpu({ passMs: 0.01 }),
    frames = [];
  try {
    assert.equal(applyQualityTier({ search: '', page: '/triangle/', storage, userAgent: desktop }), 'light');
    watchQuality({ request: (callback) => frames.push(callback), queue: gpu.queue, device: gpu.device });
    await drive(gpu, frames);
    assert.equal(storage.getItem('margoQuality:/triangle/'), 'high');
    assert.equal(applyQualityTier({ search: '', page: '/triangle/', storage, userAgent: desktop }), 'high');
    assert.equal(applyQualityTier({ search: '', page: '/plaza/', storage, userAgent: desktop }), 'light');
    // What older builds stored for the whole origin says nothing about this page.
    storage.setItem('margoQuality', 'high');
    assert.equal(applyQualityTier({ search: '', page: '/plaza/', storage, userAgent: desktop }), 'light');
  } finally {
    delete globalThis.margoLow;
    delete globalThis.margoPreset;
  }
});

test('one slow reading does not hold a browser on the light tier: the next load measures again', async () => {
  assert.equal((await visit({ passMs: 9 })).stored, null, 'a slow session (a remote desktop, say) remembers nothing');
  assert.equal(
    (await visit({ passMs: 2 }, { margoQuality: 'low' })).stored,
    'high',
    "an older 'low' is measured again",
  );
  assert.equal((await visit({ passMs: 2 }, { margoLow: '1' })).stored, 'high', 'and so is the old margoLow key');
});

test('a slow full tier is remembered for good, so the page does not swing between tiers on every load', async () => {
  const storage = memory({ margoQuality: 'high' }),
    frames = [];
  let reloads = 0,
    now = 1000;
  applyQualityTier({ search: '', storage, userAgent: desktop });
  watchQuality({ request: (callback) => frames.push(callback), reload: () => reloads++ });
  for (let i = 0; i < 400 && frames.length; i++) frames.shift()((now += 25));
  assert.equal(reloads, 1);
  const held = storage.getItem('margoQuality');
  assert.notEqual(held, 'high');
  assert.equal(applyQualityTier({ search: '', storage: memory({ margoQuality: held }), userAgent: desktop }), 'light');
  const again = [],
    gpu = fakeGpu({ passMs: 2 }),
    submit = gpu.queue.submit;
  watchQuality({ request: (callback) => again.push(callback), queue: gpu.queue, device: gpu.device });
  await started(again);
  assert.equal(gpu.queue.submit, submit, 'a held page is not read again, so a fast reading cannot undo it');
  assert.equal(again.length, 0);
});

test('a forced tier is for testing: it never stores or reloads', () => {
  const frames = [];
  try {
    applyQualityTier({ search: '?quality=high', storage: memory(), userAgent: desktop });
    watchQuality({
      request: (callback) => frames.push(callback),
      store: () => assert.fail('stored'),
      reload: () => assert.fail('reloaded'),
    });
    assert.equal(frames.length, 0);
  } finally {
    delete globalThis.margoLow;
  }
});

test('the light tier renders HiDPI desktops single-sampled at its pixel ratio', async () => {
  const density = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 });
  const canvas = { width: 1, height: 1, clientWidth: 1440, clientHeight: 900 };
  const engine = new Engine(
    canvas,
    await TransformStore.create(1),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  try {
    globalThis.margoLow = 1;
    engine.render();
    assert.equal(sceneSamples(), 1);
    assert.deepEqual([canvas.width, canvas.height], [1440, 900]);
    globalThis.margoLow = 1.5;
    engine.render();
    assert.deepEqual([canvas.width, canvas.height], [2160, 1350]);
  } finally {
    engine.dispose();
    delete globalThis.margoLow;
    if (density) Object.defineProperty(globalThis, 'devicePixelRatio', density);
    else delete globalThis.devicePixelRatio;
  }
});

test('the light-tier cap runs every other refresh of a 120 Hz display and every refresh at 60 Hz', () => {
  for (const [hz, expected] of [
    [120, 60],
    [60, 60],
    [144, 72],
    [240, 60],
  ]) {
    const engine = {};
    capFrameRate(engine);
    let runs = 0;
    for (let frame = 1; frame <= hz; frame++) runs += engine.pace((frame * 1000) / hz);
    assert.equal(runs, expected, `${hz} Hz`);
  }
});

// A Dell S2725HS on an Apple M6 runs at 100 Hz by default: the old cap dropped every other refresh there, 50 FPS on a
// page asked for 60. Any display that is not close to a multiple of the rate fell short the same way (90 Hz gave 45).
test('the cap never renders below its rate, at any refresh rate', () => {
  for (const [hz, expected] of [
    [75, 75],
    [90, 90],
    [100, 100],
    [165, 83],
    [200, 67],
  ]) {
    const engine = {};
    capFrameRate(engine);
    let runs = 0;
    for (let frame = 1; frame <= hz; frame++) runs += engine.pace((frame * 1000) / hz);
    assert.ok(Math.abs(runs - expected) <= 1, `${hz} Hz ran ${runs}, expected about ${expected}`);
  }
});

test('the cap holds its rate through callback jitter and whole-millisecond timestamps', () => {
  for (const hz of [60, 75, 90, 100, 120, 144, 165, 200, 240])
    for (const [jitter, whole] of [
      [1, false],
      [1, true],
      [2, false],
    ]) {
      const engine = {};
      capFrameRate(engine);
      let seed = 12345,
        runs = 0;
      for (let frame = 1; frame <= hz * 10; frame++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const time = (frame * 1000) / hz + (seed / 2 ** 31 - 1) * jitter;
        runs += engine.pace(whole ? Math.round(time) : time);
      }
      assert.ok(runs / 10 >= 59, `${hz} Hz, jitter ${jitter}, whole ${whole}: ${runs / 10} FPS`);
    }
});

test('slow frames on a fast display do not lift the cap', () => {
  // A GPU that misses refreshes on a 120 Hz panel: 8.33 ms, then two refreshes late. The display is still 120 Hz.
  const engine = {};
  capFrameRate(engine);
  let time = 0,
    runs = 0,
    quick = 0,
    last = -Infinity;
  for (let frame = 0; frame < 600; frame++) {
    time += ((frame % 2 ? 3 : 1) * 1000) / 120;
    if (engine.pace(time)) {
      runs++;
      if (time - last < 12) quick++;
      last = time;
    }
  }
  assert.ok(runs > 0);
  assert.ok(quick <= 2, `${quick} frames ran on a refresh the cap should skip`);
});

test('a page moved to a slower display reaches that display rate within seconds', () => {
  const engine = {};
  capFrameRate(engine);
  let time = 0;
  for (let frame = 0; frame < 240 * 5; frame++) engine.pace((time += 1000 / 240));
  for (let frame = 0; frame < 100 * 10; frame++) engine.pace((time += 10));
  let runs = 0;
  for (let frame = 0; frame < 100; frame++) runs += engine.pace((time += 10));
  assert.equal(runs, 100);
});

test('paceEngine caps a light-tier engine through engine.pace without touching requestAnimationFrame', async () => {
  const frames = [],
    saved = globalThis.requestAnimationFrame,
    savedCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  const raf = globalThis.requestAnimationFrame;
  try {
    for (const [userAgent, quality, expected] of [
      [desktop, '', 60],
      [desktop, 'high', 120],
      [phone, '', 120],
    ]) {
      applyQualityTier({ search: '', storage: memory(quality ? { margoQuality: quality } : {}), userAgent });
      assert.equal(globalThis.requestAnimationFrame, raf, 'the global is left alone');
      const engine = new Engine(
        { width: 4, height: 4, clientWidth: 4, clientHeight: 4 },
        await TransformStore.create(1),
        { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
        undefined,
        null,
      );
      let rendered = 0;
      engine.onFrame(() => rendered++);
      paceEngine(engine);
      engine.start();
      for (let refresh = 1; refresh <= 120; refresh++) frames.shift()((refresh * 1000) / 120);
      assert.equal(rendered, expected, `${userAgent.slice(13, 20)} ${quality}`);
      engine.dispose();
      frames.length = 0;
    }
  } finally {
    globalThis.requestAnimationFrame = saved;
    globalThis.cancelAnimationFrame = savedCancel;
    delete globalThis.margoLow;
  }
});

test('the light-tier reading skips two seconds and gives up after ten, at any refresh rate', async () => {
  try {
    for (const hz of [60, 120]) {
      const frames = [],
        stored = [],
        readings = [],
        gpu = fakeGpu(),
        buffer = gpu.device.createBuffer;
      // Maps that never finish: no frame ever completes, so only the time limit can end it.
      gpu.device.createBuffer = (d) => Object.assign(buffer(d), { mapAsync: () => new Promise(() => {}) });
      applyQualityTier({ search: '', storage: memory(), userAgent: desktop });
      watchQuality({
        request: (callback) => frames.push(callback),
        queue: gpu.queue,
        device: gpu.device,
        store: (value) => stored.push(value),
        onReading: (ms) => readings.push(ms),
      });
      await started(frames);
      let refresh = 0,
        firstWrite;
      while (frames.length && refresh < hz * 20) {
        frames.shift()(500 + (refresh * 1000) / hz);
        gpu.frame();
        if (gpu.wrote && firstWrite === undefined) firstWrite = (refresh * 1000) / hz;
        refresh++;
      }
      assert.ok(firstWrite > 2000 && firstWrite <= 2000 + 1000 / hz, `${hz} Hz: starts after 2 s (${firstWrite})`);
      // Three frames over 10 s: frame 0 at time 0, the tick past the limit that closes the reading, the clean-up frame.
      // Counted in whole frames: 603 / 60 - 10 is 0.05000000000000071 in doubles, over 3 / 60 by rounding alone.
      assert.ok(Math.abs(refresh - 10 * hz) <= 3, `${hz} Hz: stops after 10 s (${refresh} frames)`);
      assert.deepEqual(stored, [], 'too few samples store nothing');
      assert.deepEqual(readings, [undefined]);
    }
  } finally {
    delete globalThis.margoLow;
  }
});

test('redrawAfterRestore renders the two frames after each device restoration until removed', async () => {
  const { redrawAfterRestore } = await import('../dist/index.js');
  const plugins = new Map(),
    frames = [];
  const engine = {
    use(plugin) {
      plugins.set(plugin.name, plugin);
      return engine;
    },
    removePlugin(name) {
      plugins.delete(name);
    },
  };
  let renders = 0;
  const stop = redrawAfterRestore(
    engine,
    () => renders++,
    (callback) => frames.push(callback),
  );
  const [plugin] = plugins.values();
  plugin.onDeviceRestored(engine);
  assert.equal(renders, 0, 'not inside the restoration');
  frames.shift()();
  assert.equal(renders, 1);
  frames.shift()();
  assert.equal(renders, 2, 'a second frame for effects that read the previous one');
  assert.equal(frames.length, 0);
  stop();
  assert.equal(plugins.size, 0);
});

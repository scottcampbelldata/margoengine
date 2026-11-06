import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { autotune } from '@margoengine/compute/autotune';

// A context whose GPU takes the time `cost(size)` says, so which size wins is known. tests/compute-autotune-browser.js
// runs the real thing.
const limits = {
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeInvocationsPerWorkgroup: 256,
};
function stubGpu(cost, { timestamps = true, info = { vendor: 'acme', architecture: 'x', device: '', description: '' } } = {}) {
  const gpu = {
    runs: [],
    compiled: [],
    device: { limits, features: new Set(timestamps ? ['timestamp-query'] : []), adapterInfo: info },
    check() {},
    kernel(code, options) {
      gpu.compiled.push(code);
      return { code, options };
    },
    async done() {},
    async profile(work) {
      const before = gpu.runs.length;
      await work();
      return gpu.runs.slice(before).map((size) => ({ label: 'main', ms: cost(size, gpu.runs.length) }));
    },
  };
  return gpu;
}
const job = (gpu, more = {}) => ({
  name: 'saxpy',
  source: (size) => `@workgroup_size(${size})`,
  run: (_kernel, size) => void gpu.runs.push(size),
  ...more,
});
const memoryStore = () => {
  const map = new Map();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};
const fastest128 = ([x]) => Math.abs(Math.log2(x) - 7) + 1;

test('the fastest size wins, compiled at that size, with every time reported', async () => {
  const gpu = stubGpu(fastest128);
  const result = await autotune(gpu, job(gpu));
  assert.deepEqual(result.workgroupSize, [128, 1, 1]);
  assert.equal(result.kernel.code, '@workgroup_size(128,1,1)');
  assert.equal(result.cached, false);
  assert.deepEqual(
    result.timings.map((t) => [t.workgroupSize[0], t.ms]),
    [
      [256, 2],
      [128, 1],
      [64, 2],
      [32, 3],
    ],
  );
});

test('the defaults stop at what the device can run, and given sizes over its limits are dropped', async () => {
  const gpu = stubGpu(fastest128);
  const result = await autotune(gpu, job(gpu, { candidates: [64, [16, 16], [16, 32], [1, 1, 128], 512] }));
  assert.deepEqual(
    result.timings.map((t) => t.workgroupSize),
    [
      [64, 1, 1],
      [16, 16, 1],
    ],
  );
  await assert.rejects(autotune(gpu, job(gpu, { candidates: [512] })), /none of the 1 candidate/);
  await assert.rejects(autotune(gpu, job(gpu, { candidates: [] })), /at least one candidate/);
  await assert.rejects(autotune(gpu, job(gpu, { candidates: [1.5] })), /whole number/);
});

test('each size gets warmup then trials, in turns, and the median ignores a spike', async () => {
  // The 64 size is cheap but for one huge spike; a mean would give it to 32.
  const gpu = stubGpu(([x], n) => (x === 64 ? (n === 10 ? 1000 : 1) : 2));
  const result = await autotune(gpu, job(gpu, { candidates: [32, 64], trials: 5, warmup: 2 }));
  assert.deepEqual(result.workgroupSize, [64, 1, 1]);
  assert.equal(gpu.runs.length, 2 * (5 + 2));
  assert.deepEqual(
    gpu.runs.slice(0, 6).map(([x]) => x),
    [32, 64, 32, 64, 32, 64],
  );
});

test('a tie keeps the first candidate, which by default is 256', async () => {
  const gpu = stubGpu(() => 1);
  assert.deepEqual((await autotune(gpu, job(gpu))).workgroupSize, [256, 1, 1]);
});

test('equal medians on a coarse clock go to the better mean', async () => {
  // Both read 2 steps most runs, but 64 reads 1 step more often than 32 does, below where the median can see.
  const samples = { 32: [2, 2, 2, 2, 3], 64: [1, 2, 2, 2, 2] },
    seen = { 32: 0, 64: 0 };
  const gpu = stubGpu(([x]) => samples[x][seen[x]++]);
  const result = await autotune(gpu, job(gpu, { candidates: [32, 64], trials: 5, warmup: 0 }));
  assert.equal(result.timings[0].ms, result.timings[1].ms);
  assert.deepEqual(result.workgroupSize, [64, 1, 1]);
});

test('a second call runs nothing, and any change to what was measured measures again', async () => {
  const gpu = stubGpu(fastest128);
  await autotune(gpu, job(gpu));
  const ran = gpu.runs.length;
  const again = await autotune(gpu, job(gpu));
  assert.equal(again.cached, true);
  assert.deepEqual(again.workgroupSize, [128, 1, 1]);
  assert.equal(again.kernel.code, '@workgroup_size(128,1,1)');
  assert.deepEqual(again.timings, []);
  assert.equal(gpu.runs.length, ran);
  for (const change of [
    { name: 'other' },
    { signature: 'n=1024' },
    { candidates: [64, 128] },
    { source: (size) => `// edited\n@workgroup_size(${size})` },
    { refresh: true },
  ])
    assert.equal((await autotune(gpu, job(gpu, change))).cached, false, Object.keys(change)[0]);
});

test('a store carries a result to the next session, of the same adapter only', async () => {
  const store = memoryStore(),
    gpu = stubGpu(fastest128);
  await autotune(gpu, job(gpu, { store }));
  assert.equal(store.map.size, 1);
  assert.equal([...store.map.values()][0], '128,1,1');
  const next = stubGpu(() => 1);
  const result = await autotune(next, job(next, { store }));
  assert.equal(result.cached, true);
  assert.deepEqual(result.workgroupSize, [128, 1, 1]);
  assert.equal(next.runs.length, 0);
  const other = stubGpu(() => 1, { info: { vendor: 'other', architecture: '', device: '', description: '' } });
  assert.equal((await autotune(other, job(other, { store }))).cached, false);
});

test('an async store works, and a stored value that is no candidate is measured over', async () => {
  const inner = memoryStore(),
    store = { getItem: async (key) => inner.getItem(key), setItem: async (key, value) => inner.setItem(key, value) },
    gpu = stubGpu(fastest128);
  await autotune(gpu, job(gpu, { store }));
  const [key] = inner.map.keys();
  inner.map.set(key, 'junk');
  const next = stubGpu(fastest128);
  const result = await autotune(next, job(next, { store }));
  assert.equal(result.cached, false);
  assert.equal(inner.map.get(key), '128,1,1');
});

test('without timestamp queries it times the wall clock', async () => {
  const gpu = stubGpu(() => 0, { timestamps: false });
  let pending = Promise.resolve();
  gpu.done = () => pending;
  const result = await autotune(gpu, {
    name: 'wall',
    source: (size) => `${size}`,
    candidates: [32, 64],
    trials: 3,
    warmup: 0,
    run: (_kernel, [x]) => void (pending = new Promise((done) => setTimeout(done, x === 64 ? 2 : 40))),
  });
  assert.deepEqual(result.workgroupSize, [64, 1, 1]);
  assert.ok(result.timings[0].ms > result.timings[1].ms);
});

test('calls on one context take turns, because profile times one thing at a time', async () => {
  const gpu = stubGpu(fastest128),
    profile = gpu.profile;
  let inside = 0;
  gpu.profile = async (work) => {
    assert.equal(++inside, 1, 'overlapping profile');
    await new Promise((done) => setTimeout(done, 1));
    const out = await profile(work);
    inside--;
    return out;
  };
  const results = await Promise.all([
    autotune(gpu, job(gpu, { name: 'a', trials: 1, warmup: 0 })),
    autotune(gpu, job(gpu, { name: 'b', trials: 1, warmup: 0 })),
    autotune(gpu, job(gpu, { name: 'a', trials: 1, warmup: 0 })),
  ]);
  assert.deepEqual(
    results.map((r) => r.cached),
    [false, false, true],
  );
});

test('a failed call rejects its caller and leaves the next one working', async () => {
  const gpu = stubGpu(fastest128),
    broken = autotune(gpu, job(gpu, { run: () => Promise.reject(new Error('boom')) })),
    fine = autotune(gpu, job(gpu));
  await assert.rejects(broken, /boom/);
  assert.equal((await fine).cached, false);
});

test('an abort stops the measuring and remembers nothing', async () => {
  const gpu = stubGpu(fastest128),
    control = new AbortController(),
    store = memoryStore();
  await assert.rejects(
    autotune(gpu, job(gpu, { store, signal: control.signal, run: () => control.abort(new Error('stop')) })),
    /stop/,
  );
  assert.equal(store.map.size, 0);
  assert.equal((await autotune(gpu, job(gpu))).cached, false);
});

test('wrong input is refused by name', async (t) => {
  const gpu = stubGpu(fastest128);
  await assert.rejects(autotune(gpu, { ...job(gpu), name: '' }), /needs a name/);
  await assert.rejects(autotune(gpu, { name: 'a' }), /source and a run/);
  await assert.rejects(autotune(gpu, job(gpu, { trials: 0 })), /trials/);
  await assert.rejects(autotune(gpu, job(gpu, { warmup: -1 })), /warmup/);
  const cpu = await createCompute({ backend: 'cpu' });
  t.after(() => cpu.dispose());
  await assert.rejects(autotune(cpu, job(gpu)), (error) => error.code === 'unsupported');
});

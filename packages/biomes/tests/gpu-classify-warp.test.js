import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { warpCases, syntheticWarpCases, warpOracle, requireHardwareAdapter } from './gpu-classify-warp-cases.mjs';

const repository = realpathSync(new URL('../../../', import.meta.url));
function resolveSource(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const js = new URL(specifier, context.parentURL);
    const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (!existsSync(js) && existsSync(ts)) {
      const source = realpathSync(ts);
      const within = relative(repository, source);
      if (within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within))
        return nextResolve(pathToFileURL(source).href, context);
    }
  }
  return nextResolve(specifier, context);
}
registerHooks({ resolve: resolveSource });

const { warpLattice, warpPlanes } = await import('../src/classify-warp.ts');
const { classifyWarpGPU, CLASSIFY_WARP_WGSL, WARP_CORNER_BOUND } = await import('../src/gpu-classify-warp.ts');
const cases = [
  ...warpCases().map((s) => ({ ...s, lattice: warpLattice(s.seed, s.cell, s.gx, s.gz, s.n, s.depth) })),
  ...syntheticWarpCases(),
];
const args = (s) => [s.gx, s.gz, s.n, s.depth];
function cpu(s) {
  const n1 = new Int32Array(s.n * s.depth),
    n2 = new Int32Array(n1.length),
    dT = new Int32Array(n1.length);
  warpPlanes(s.lattice, ...args(s), n2, dT, n1);
  return { n1, n2, dT };
}

test('CPU warp planes equal the independent BigInt oracle for real and seeded synthetic lattices', () => {
  assert.equal(cases.length, 16);
  for (const s of cases) {
    assert.deepEqual(cpu(s), warpOracle(s.lattice, ...args(s)), JSON.stringify(args(s)));
    const n2 = new Int32Array(s.n * s.depth),
      dT = new Int32Array(n2.length);
    warpPlanes(s.lattice, ...args(s), n2, dT);
    assert.deepEqual({ n2, dT }, { n2: cpu(s).n2, dT: cpu(s).dT });
  }
});

test('fixtures exercise negative temperature floor and descending lerps with a remainder', () => {
  let negative = false,
    descending = false;
  for (const s of cases) {
    const reference = cpu(s),
      oracle = warpOracle(s.lattice, ...args(s));
    for (let k = 0; k < reference.n1.length; k++) {
      const product = reference.n1[k] * 160;
      if (product < 0 && product % 32768 !== 0) {
        negative = true;
        assert.notEqual(reference.dT[k], Math.trunc(product / 32768));
        assert.equal(reference.dT[k], oracle.dT[k]);
      }
    }
    for (const grid of [s.lattice.warpA, s.lattice.warpB])
      for (let k = 0; k + 1 < grid.length; k++)
        if (grid[k + 1] < grid[k] && ((grid[k + 1] - grid[k]) * 8192) % 65536 !== 0) descending = true;
  }
  assert.ok(negative && descending);
});

test('real fbm corners fit the GPU bound with ample headroom', () => {
  for (const s of cases.slice(0, warpCases().length))
    for (const grid of [s.lattice.warpA, s.lattice.warpB])
      for (const v of grid) {
        assert.ok(v >= 0 && v <= 65535);
        assert.ok(Math.abs(v) < WARP_CORNER_BOUND);
      }
});

function gpuConstants(t) {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, MAP_READ: 1 },
    GPUMapMode: { READ: 1 },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]));
  }
}

// Transport/lifecycle only: this fake fills readback from warpPlanes and never executes WGSL.
function fakeDevice(s, { skip = false, pending = false, onMap, onDestroy } = {}) {
  const reference = cpu(s);
  const buffers = [],
    listeners = new Map();
  let dispatch, started, finishMap;
  const mapStarted = new Promise((resolve) => {
      started = resolve;
    }),
    mapping = new Promise((resolve) => {
      finishMap = resolve;
    });
  const device = {
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    pushErrorScope() {},
    popErrorScope: async () => null,
    createShaderModule: ({ code }) => {
      assert.equal(code, CLASSIFY_WARP_WGSL);
      return { getCompilationInfo: async () => ({ messages: [] }) };
    },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size }) => {
      const buffer = {
        data: new ArrayBuffer(size),
        destroyed: false,
        destroy() {
          this.destroyed = true;
          onDestroy?.();
        },
        unmap() {},
        mapAsync() {
          started();
          onMap?.();
          return pending ? mapping : Promise.resolve();
        },
        getMappedRange() {
          return this.data;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (x, z) => {
          dispatch = [x, z];
        },
        end() {},
      }),
      copyBufferToBuffer: (_src, _a, dst) => {
        const raw = reference,
          count = s.n * s.depth,
          data = new Int32Array(dst.data);
        ['n1', 'n2', 'dT'].forEach((name, g) => data.set(raw[name], g * count));
        if (!skip) for (let k = 0; k < count; k++) data[3 * count + k] = k + 1;
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer, offset, data) =>
        new Uint8Array(buffer.data).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset),
      submit() {},
    },
  };
  return {
    device,
    buffers,
    listeners,
    mapStarted,
    finishMap,
    get dispatch() {
      return dispatch;
    },
  };
}

function freed(f) {
  assert.equal(f.buffers.length, 4);
  assert.ok(f.buffers.every((b) => b.destroyed));
  assert.equal(f.listeners.size, 0);
}

test('transport only fake returns exact planes, dispatches partial groups and frees buffers and listeners', async (t) => {
  gpuConstants(t);
  for (const s of cases) {
    const f = fakeDevice(s),
      result = await classifyWarpGPU(f.device, s.lattice, ...args(s));
    assert.deepEqual(result, cpu(s));
    assert.deepEqual(f.dispatch, [Math.ceil(s.n / 8), Math.ceil(s.depth / 8)]);
    assert.deepEqual(Array.from(new Uint32Array(f.buffers[1].data)), [
      s.n,
      s.depth,
      s.lattice.span,
      s.lattice.rows,
      s.gx - s.lattice.a0 * 8,
      s.gz - s.lattice.b0 * 8,
      0,
      0,
    ]);
    assert.deepEqual(new Int32Array(f.buffers[0].data), Int32Array.from([...s.lattice.warpA, ...s.lattice.warpB]));
    freed(f);
  }
});

test('missing execution markers reject with failed and release buffers', async (t) => {
  gpuConstants(t);
  const s = cases[0],
    f = fakeDevice(s, { skip: true });
  await assert.rejects(classifyWarpGPU(f.device, s.lattice, ...args(s)), { name: 'MargoError', code: 'failed' });
  freed(f);
});

test('already aborted request never touches the device or lattice', async () => {
  const signal = AbortSignal.abort(new Error('cancel warp')),
    unused = new Proxy(
      {},
      {
        get() {
          assert.fail('already aborted request accessed an input');
        },
      },
    );
  await assert.rejects(classifyWarpGPU(unused, unused, 0, 0, 1, 1, { signal }), (e) => e === signal.reason);
});

test('abort during mapping rejects with the reason and releases buffers and listeners', {
  timeout: 2000,
}, async (t) => {
  gpuConstants(t);
  const s = cases[0],
    controller = new AbortController(),
    f = fakeDevice(s, {
      pending: true,
      onMap: () => controller.abort(new Error('cancel mapped warp')),
    });
  const signal = controller.signal;
  let adds = 0,
    removes = 0;
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...a) => {
    adds++;
    return add(...a);
  };
  signal.removeEventListener = (...a) => {
    removes++;
    return remove(...a);
  };
  await assert.rejects(classifyWarpGPU(f.device, s.lattice, ...args(s), { signal }), (e) => e === signal.reason);
  assert.equal(adds, 1);
  assert.equal(removes, 1);
  freed(f);
});

test('validation, mapping and uncaptured errors reject with failed and release resources', {
  timeout: 2000,
}, async (t) => {
  gpuConstants(t);
  const s = cases[0];
  for (const mode of ['compile', 'pipeline', 'dispatch', 'mapping', 'uncaptured', 'allocation']) {
    const f = fakeDevice(s);
    if (mode === 'compile')
      f.device.createShaderModule = () => ({
        getCompilationInfo: async () => ({ messages: [{ message: 'bad shader' }] }),
      });
    if (mode === 'pipeline')
      f.device.createComputePipelineAsync = async () => {
        throw new Error('lost device');
      };
    if (mode === 'dispatch') {
      let scopes = 0;
      f.device.popErrorScope = async () => (++scopes === 2 ? { message: 'bad dispatch' } : null);
    }
    if (mode === 'mapping') {
      const create = f.device.createBuffer;
      f.device.createBuffer = (options) => {
        const b = create(options);
        b.mapAsync = async () => {
          throw new Error('map failed');
        };
        return b;
      };
    }
    if (mode === 'uncaptured') {
      f.device.queue.submit = () => f.listeners.get('uncapturederror')({ error: { message: 'GPU failed' } });
    }
    if (mode === 'allocation') {
      const create = f.device.createBuffer;
      f.device.createBuffer = (options) => {
        if (f.buffers.length === 2) throw new Error('allocation failed');
        return create(options);
      };
    }
    await assert.rejects(classifyWarpGPU(f.device, s.lattice, ...args(s)), { name: 'MargoError', code: 'failed' });
    assert.ok(f.buffers.every((b) => b.destroyed));
    assert.equal(f.listeners.size, 0);
  }
});

test('bad lattice types, lengths, corners, shapes and device limits reject before allocating buffers', async (t) => {
  gpuConstants(t);
  const s = cases[0];
  const bad = [];
  for (const name of ['warpA', 'warpB']) {
    for (const value of [new Int32Array(1), new Uint32Array(s.lattice[name].length), undefined])
      bad.push([{ ...s, lattice: { ...s.lattice, [name]: value } }, TypeError]);
    for (const value of [-WARP_CORNER_BOUND - 1, WARP_CORNER_BOUND + 1, -2147483648, 2147483647]) {
      const grid = s.lattice[name].slice();
      grid[0] = value;
      bad.push([{ ...s, lattice: { ...s.lattice, [name]: grid } }, RangeError]);
    }
  }
  for (const key of ['n', 'depth'])
    for (const v of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) bad.push([{ ...s, [key]: v }, RangeError]);
  for (const key of ['gx', 'gz'])
    for (const v of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, -2147483649, 2147483647])
      bad.push([{ ...s, [key]: v }, RangeError]);
  for (const key of ['a0', 'b0', 'span', 'rows'])
    bad.push([{ ...s, lattice: { ...s.lattice, [key]: s.lattice[key] + 1 } }, RangeError]);
  bad.push([{ ...s, lattice: null }, RangeError]);
  for (const [spec, error] of bad) {
    const f = fakeDevice(s);
    await assert.rejects(classifyWarpGPU(f.device, spec.lattice, ...args(spec)), error);
    assert.equal(f.buffers.length, 0);
    assert.equal(f.listeners.size, 0);
  }
  for (const [limit, value] of [
    ['maxBufferSize', 16],
    ['maxStorageBufferBindingSize', 16],
    ['maxComputeWorkgroupsPerDimension', 1],
  ]) {
    const f = fakeDevice(s);
    f.device.limits[limit] = value;
    await assert.rejects(classifyWarpGPU(f.device, s.lattice, ...args(s)), RangeError);
    assert.equal(f.buffers.length, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('dT uses sign-filling right shift rather than truncating i32 division', () => {
  assert.match(CLASSIFY_WARP_WGSL, /\(n1 \* 160\) >> 15u/);
  const kernel = CLASSIFY_WARP_WGSL.slice(CLASSIFY_WARP_WGSL.indexOf('fn main')).replace(/\/\/[^\n]*/g, '');
  assert.ok(!kernel.includes('/'));
});

test('CPU helper and GPU interpolation remain internal, with no GPU import in the classifier', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
    classifier = readFileSync(new URL('../src/classify.ts', import.meta.url), 'utf8');
  for (const name of ['gpu-classify-warp', 'classify-warp', 'classifyWarpGPU', 'warpPlanes', 'warpLattice']) {
    assert.ok(!root.includes(name));
    assert.ok(!JSON.stringify(manifest.exports).includes(name));
  }
  assert.ok(!classifier.includes('gpu-classify-warp'));
});

test('hardware identity validation rejects missing, fallback, software and virtual adapters', () => {
  const physical = { name: 'NVIDIA RTX A6000', nameSource: 'webgpu', fallback: false };
  assert.equal(requireHardwareAdapter(physical), physical.name);
  for (const patch of [
    { name: '' },
    { nameSource: '' },
    { fallback: true },
    { fallback: null },
    { renderer: 'SwiftShader' },
    { name: 'NVIDIA virtual adapter' },
  ])
    assert.throws(() => requireHardwareAdapter({ ...physical, ...patch }));
});

test('lattice upload is a validated snapshot taken before shader compilation yields', async (t) => {
  gpuConstants(t);
  const original = cases[0],
    s = {
      ...original,
      lattice: { ...original.lattice, warpA: original.lattice.warpA.slice(), warpB: original.lattice.warpB.slice() },
    },
    expected = cpu(s),
    f = fakeDevice(s),
    compile = f.device.createComputePipelineAsync;
  f.device.createComputePipelineAsync = (...a) => {
    s.lattice.warpA.fill(WARP_CORNER_BOUND + 1);
    s.lattice.warpB.fill(-WARP_CORNER_BOUND - 1);
    return compile(...a);
  };
  assert.deepEqual(await classifyWarpGPU(f.device, s.lattice, ...args(s)), expected);
  assert.deepEqual(
    new Int32Array(f.buffers[0].data),
    Int32Array.from([...original.lattice.warpA, ...original.lattice.warpB]),
  );
  freed(f);
});

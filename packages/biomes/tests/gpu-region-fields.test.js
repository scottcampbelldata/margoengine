import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { regionFieldCases, oracleAxes, oracleFields, oracleStored, storedCPU } from './gpu-region-fields-cases.mjs';

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

const module = {
  ...(await import('../src/gpu-region-fields.ts')),
  ...(await import('../src/fields.ts')),
  ...(await import('../src/climate.ts')),
  ...(await import('../src/layers.ts')),
};
const { regionAxes, regionFieldsRef, storedRegionLayers, REGION_FIELDS_WGSL, upsampleRegionFieldsGPU } = module;
const cases = regionFieldCases();
const args = (c) => [c.region, c.cell, c.ox, c.oz, c.width, c.depth];
const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

test('source resolver maps only missing relative JS files to repository TypeScript sources', () => {
  const context = { parentURL: import.meta.url };
  const resolve = (specifier, parent = context) => resolveSource(specifier, parent, (value) => value);
  assert.equal(
    resolve('../src/fixed.js'),
    pathToFileURL(realpathSync(new URL('../src/fixed.ts', import.meta.url))).href,
  );
  for (const specifier of [
    './random.js',
    '../src/missing-region-fixture.js',
    'node:fs',
    'vite',
    'https://example.com/fixed.js',
    new URL('../src/fixed.js', import.meta.url).href,
    fileURLToPath(new URL('../src/fixed.js', import.meta.url)),
    '../../shared/errors.js',
  ])
    assert.equal(resolve(specifier), specifier);
  assert.equal(resolve('../src/fixed.js', { parentURL: 'https://example.com/tests/test.js' }), '../src/fixed.js');
  assert.equal(resolve('../src/fixed.js', {}), '../src/fixed.js');
  const outside = pathToFileURL(repository + '-outside/tests/test.js').href;
  assert.equal(resolve('../src/fixed.js', { parentURL: outside }), '../src/fixed.js');
});

test(`region axes and all five raw fields equal the independent BigInt oracle (${cases.length} rectangles)`, () => {
  for (const c of cases) {
    assert.deepEqual(regionAxes(...args(c)), oracleAxes(c));
    assert.deepEqual(regionFieldsRef(...args(c)), oracleFields(c));
  }
});

test('stored bytes match the unchanged rectFields path, including signed extremes after its existing clamps', () => {
  for (const c of cases) {
    const stored = storedRegionLayers(regionFieldsRef(...args(c))),
      cpu = storedCPU(module, c);
    assert.deepEqual(stored, oracleStored(oracleFields(c)));
    for (const [name, value] of Object.entries(stored)) {
      assert.equal(module.LAYERS[name].format, name === 'exposure' ? 'u8' : 'u16');
      assert.deepEqual(bytes(value), bytes(cpu[name]), `${name}: ${JSON.stringify(args(c).slice(1))}`);
    }
  }
});

test('integer-only WGSL uses the Q16 primitive and guards partial 8x8 workgroups', () => {
  assert.doesNotMatch(REGION_FIELDS_WGSL, /\b(?:f32|f16|float|i64|u64)\b|\d+\.\d+/);
  assert.match(REGION_FIELDS_WGSL, /@compute @workgroup_size\(8, 8\)/);
  assert.match(REGION_FIELDS_WGSL, /fn main\(/);
  assert.match(REGION_FIELDS_WGSL, /id.x >= shape.width \|\| id.y >= shape.depth/);
  assert.match(REGION_FIELDS_WGSL, /output\[5u \* count \+ k\] = i32\(k \+ 1u\)/);
});

test('invalid geometry and grid shapes fail before GPU allocation', async () => {
  const good = args(cases[0]);
  for (const [index, values] of [
    [1, [0, -1, 0.5, NaN, Infinity]],
    [2, [0.5, NaN, Infinity]],
    [3, [0.5, NaN]],
    [4, [0, -1, 1.5, 2 ** 32]],
    [5, [0, -1, 1.5]],
  ]) {
    for (const value of values) {
      const bad = [...good];
      bad[index] = value;
      assert.throws(() => regionAxes(...bad), RangeError);
      await assert.rejects(upsampleRegionFieldsGPU({}, ...bad), RangeError);
    }
  }
  for (const shape of [{ nx: 1 }, { nz: 1 }, { nx: 2.5 }, { nx: 32769 }, { step: 0 }])
    assert.throws(() => regionAxes({ ...good[0], ...shape }, ...good.slice(1)), RangeError);
  for (const rain of [new Int32Array(3), new Uint32Array(4), null])
    assert.throws(() => regionFieldsRef({ ...good[0], rain }, ...good.slice(1)), TypeError);
  const signal = AbortSignal.abort(new Error('stop region request'));
  await assert.rejects(upsampleRegionFieldsGPU({}, ...good, { signal }), (error) => error === signal.reason);
});

test('internal names are absent from the package root and manifest exports', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of [
    'gpu-region-fields',
    'regionAxes',
    'regionFieldsRef',
    'storedRegionLayers',
    'upsampleRegionFieldsGPU',
    'REGION_FIELDS_WGSL',
  ]) {
    assert.ok(!root.includes(name));
    assert.ok(!JSON.stringify(manifest.exports).includes(name));
  }
});

// Transport/lifecycle tests only. These stand-ins do not execute WGSL and are never hardware proof.
function fakeDevice(
  c,
  { validation = 0, skip = false, pending = false, messages = [], mapError, allocationError } = {},
) {
  const buffers = [],
    writes = [],
    listeners = new Map();
  let scopes = 0,
    destroyed = 0,
    dispatch,
    popped = 0;
  let mapped;
  const device = {
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    pushErrorScope: () => {
      scopes++;
    },
    popErrorScope: async () => {
      scopes--;
      return ++popped === validation ? { message: 'fixture validation' } : null;
    },
    createShaderModule: ({ code }) => {
      assert.equal(code, REGION_FIELDS_WGSL);
      return { getCompilationInfo: async () => ({ messages }) };
    },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size, usage }) => {
      if (buffers.length === 2 && allocationError) throw allocationError;
      const buffer = {
        size,
        usage,
        data: new ArrayBuffer(size),
        destroy: () => {
          destroyed++;
        },
        unmap: () => {},
        mapAsync: () => {
          mapped?.();
          if (mapError) return Promise.reject(mapError);
          return pending ? new Promise(() => {}) : Promise.resolve();
        },
        getMappedRange() {
          return this.data;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: ({ entries }) => {
      assert.equal(entries.length, 4);
      return {};
    },
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
        const raw = oracleFields(c),
          count = c.width * c.depth,
          data = new Int32Array(dst.data);
        module.REGION_FIELD_NAMES.forEach((name, g) => data.set(raw[name], g * count));
        if (!skip) for (let k = 0; k < count; k++) data[5 * count + k] = k + 1;
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer, offset, data) => {
        new Uint8Array(buffer.data).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        writes.push(data.slice());
      },
      submit() {},
    },
  };
  return {
    device,
    buffers,
    writes,
    listeners,
    get scopes() {
      return scopes;
    },
    get destroyed() {
      return destroyed;
    },
    get dispatch() {
      return dispatch;
    },
    onMap: (fn) => {
      mapped = fn;
    },
  };
}

test('actual GPU wrapper packs grids and axes, dispatches partial tiles and frees its buffers', async () => {
  Object.assign(globalThis, {
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, MAP_READ: 1 },
    GPUMapMode: { READ: 1 },
  });
  try {
    const c = cases[1],
      f = fakeDevice(c),
      result = await upsampleRegionFieldsGPU(f.device, ...args(c));
    assert.deepEqual(result, oracleFields(c));
    assert.deepEqual(f.dispatch, [2, 2]);
    assert.deepEqual(f.writes[0], Int32Array.from(module.REGION_FIELD_NAMES.flatMap((name) => [...c.region[name]])));
    const axes = oracleAxes(c),
      packedAxes = [];
    for (let i = 0; i < c.width; i++) packedAxes.push(axes.colIndex[i], axes.colFrac[i]);
    for (let j = 0; j < c.depth; j++) packedAxes.push(axes.rowIndex[j], axes.rowFrac[j]);
    assert.deepEqual(f.writes[1], Int32Array.from(packedAxes));
    assert.deepEqual(f.writes[2], Uint32Array.from([c.width, c.depth, c.region.nx, c.region.nz]));
    assert.equal(f.destroyed, 5);
    assert.equal(f.scopes, 0);
    assert.equal(f.listeners.size, 0);
    for (const option of [
      { validation: 1 },
      { validation: 2 },
      { skip: true },
      { messages: [{ type: 'warning', message: 'fixture compilation warning' }] },
      { messages: [{ type: 'error', message: 'fixture compilation error' }] },
      { mapError: new DOMException('fixture device lost', 'OperationError') },
      { allocationError: new TypeError('fixture failed allocation') },
    ]) {
      const failed = fakeDevice(c, option);
      await assert.rejects(upsampleRegionFieldsGPU(failed.device, ...args(c)), { name: 'MargoError', code: 'failed' });
      assert.equal(failed.destroyed, failed.buffers.length);
      assert.equal(failed.scopes, 0);
      assert.equal(failed.listeners.size, 0);
    }
    const abort = new AbortController(),
      waiting = fakeDevice(c, { pending: true });
    waiting.onMap(() => abort.abort(new Error('cancel mapped request')));
    await assert.rejects(
      upsampleRegionFieldsGPU(waiting.device, ...args(c), { signal: abort.signal }),
      (e) => e === abort.signal.reason,
    );
    assert.equal(waiting.destroyed, 5);
    assert.equal(waiting.listeners.size, 0);
    const uncaptured = fakeDevice(c, { pending: true });
    uncaptured.onMap(() =>
      uncaptured.listeners.get('uncapturederror')({ error: { message: 'fixture uncaptured error' } }),
    );
    await assert.rejects(upsampleRegionFieldsGPU(uncaptured.device, ...args(c)), {
      name: 'MargoError',
      code: 'failed',
    });
    assert.equal(uncaptured.destroyed, 5);
    assert.equal(uncaptured.listeners.size, 0);
    const limited = fakeDevice(c);
    limited.device.limits.maxStorageBufferBindingSize = 4;
    await assert.rejects(upsampleRegionFieldsGPU(limited.device, ...args(c)), RangeError);
    assert.equal(limited.buffers.length, 0);
  } finally {
    delete globalThis.GPUBufferUsage;
    delete globalThis.GPUMapMode;
  }
});

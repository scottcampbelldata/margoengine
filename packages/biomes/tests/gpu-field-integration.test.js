// Clean-room checks derived only from Margo fields.ts, gpu-region-fields.ts and gpu-fixed-lerp.ts.
// W3C WGSL https://www.w3.org/TR/2026/CRD-WGSL-20261026/ sections 6.2.3 (#integer-types), 8.10 (#bit-expr),
// 14.3 (#address-spaces): the reused integer interpolation and independent storage samples.
// WebGPU https://www.w3.org/TR/2026/CRD-webgpu-20260915/ sections 5.2 (#buffer-mapping), 16 (#computepass),
// 3.6.2.4 (#gpuadapterinfo), 22.3 (#error-scopes): awaited readback, dispatch, selected identity and validation.
// Standards support transport semantics; parity is checked against Margo's own field loop. No other engine code.
// No new ecology behavior, so no new biome research reference is needed. No classification or performance claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fieldIntegrationCases,
  fieldNames,
  fieldNameSets,
  frameFor,
  requireFieldIntegrationHost,
} from './gpu-field-integration-cases.mjs';

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
  ...(await import('../src/gpu-fields.ts')),
  ...(await import('../src/fields.ts')),
  ...(await import('../src/gpu-region-fields.ts')),
  ...(await import('../src/region.ts')),
  ...(await import('../src/height.ts')),
  ...(await import('../src/relief.ts')),
  ...(await import('../src/climate.ts')),
  ...(await import('../src/layers.ts')),
  ...(await import('../src/fixed.ts')),
  ...(await import('../src/scratch.ts')),
};
const { rectFields, rectFieldsGPU, regionFieldsRef, REGION_FIELD_NAMES, Scratch } = module;
const cases = fieldIntegrationCases();
const args = (r) => [r.ox, r.oz, r.width, r.depth];
const bytes = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

test('height-only fields sample exactly the requested cells and retain the full-field bytes across scratch reuse', () => {
  for (const spec of cases) {
    const frame = frameFor(module, spec),
      scratch = new Scratch();
    for (const r of spec.rectangles) {
      const expected = rectFields(frame, ...args(r), fieldNames).get('height'),
        grids = [],
        heights = {
          ...frame.heights,
          grid(...params) {
            grids.push(params.slice(0, 5));
            return frame.heights.grid(...params);
          },
        },
        actual = rectFields({ ...frame, heights, scratch }, ...args(r), ['height']).get('height');
      assert.deepEqual(grids, [[...args(r), frame.cell]], 'no 24 m TPI apron or derivative cells for height alone');
      equalLayers(new Map([['height', actual]]), new Map([['height', expected]]), 'height only');
      const saved = bytes(actual.data).slice();
      rectFields({ ...frame, scratch }, r.ox + 3, r.oz + 5, r.width, r.depth, fieldNames, true);
      assert.deepEqual(bytes(actual.data), saved, 'requested height survives reuse of working arrays');
    }
  }
});

test('hardware proof host gate accepts the DEV worker OS name and rejects unrelated hosts', () => {
  for (const name of ['DEV', 'dev', 'SCOTT-DEV', 'scott-dev'])
    assert.doesNotThrow(() => requireFieldIntegrationHost(name));
  for (const name of ['', 'OTHER', 'DEV-OTHER', 'OTHER-DEV', 'SCOTT-DEV-OTHER', ' DEV', 'SCOTT-DEV\n'])
    assert.throws(() => requireFieldIntegrationHost(name), /Run this hardware proof on DEV with its NVIDIA RTX A6000/);
});

test('shared cases cover distinct seeds, spacing ratios, tile margins and inclusive clamp fractions', () => {
  assert.equal(new Set(cases.map((spec) => spec.seed)).size, 2);
  assert.equal(new Set(cases.map((spec) => spec.cell / (spec.regionResolution * 1000))).size, 2);
  for (const spec of cases) {
    const frame = frameFor(module, spec),
      cells = spec.tileSize / spec.cell;
    assert.ok(spec.rectangles.some((r) => r.width === 7 && r.depth === 19));
    assert.ok(spec.rectangles.some((r) => r.width === 33 && r.depth === 5));
    assert.ok(spec.rectangles.some((r) => r.ox < cells && r.ox + r.width > cells));
    assert.ok(
      spec.rectangles.some((r) => r.ox === -1 && r.oz === -1 && r.width === cells + 2 && r.depth === cells + 2),
    );
    const edge = spec.rectangles.at(-1),
      axes = module.regionAxes(frame.region, frame.cell, ...args(edge));
    assert.deepEqual([...axes.colFrac, ...axes.rowFrac], [module.ONE, module.ONE]);
  }
});

function equalLayers(actual, expected, label) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label}: layer keys`);
  for (const [name, layer] of expected) {
    const got = actual.get(name);
    assert.deepEqual({ ...got, data: undefined }, { ...layer, data: undefined }, `${label}: ${name} metadata`);
    assert.deepEqual(bytes(got.data), bytes(layer.data), `${label}: ${name} bytes`);
  }
}

test('real seeded regions give exact field bytes with raw samples, subsets and reused temporary scratch', () => {
  assert.deepEqual(
    fieldNames,
    Object.keys(module.LAYERS).filter((name) => name !== 'biome' && name !== 'biomeWeight'),
  );
  for (const spec of cases) {
    const frame = frameFor(module, spec),
      reusable = { ...frame, scratch: new Scratch() };
    for (const r of spec.rectangles) {
      const raw = regionFieldsRef(frame.region, frame.cell, ...args(r));
      for (const names of fieldNameSets) {
        const expected = rectFields(frame, ...args(r), names);
        equalLayers(
          rectFields(frame, ...args(r), names, false, raw),
          expected,
          `seed ${spec.seed} ${JSON.stringify(r)}`,
        );
        equalLayers(rectFields(reusable, ...args(r), names, true, raw), expected, `scratch seed ${spec.seed}`);
      }
    }
  }
});

test('raw samples preserve every existing value clamp before climate and output encoding', () => {
  const frame = frameFor(module, cases[0]),
    r = cases[0].rectangles[0];
  for (const value of [-2147483648, -1, 0, module.ONE, 2147483647]) {
    const region = { ...frame.region };
    for (const name of REGION_FIELD_NAMES) region[name] = new Int32Array(region.nx * region.nz).fill(value);
    const constant = { ...frame, region },
      raw = regionFieldsRef(region, frame.cell, ...args(r));
    equalLayers(
      rectFields(constant, ...args(r), fieldNames, false, raw),
      rectFields(constant, ...args(r), fieldNames),
      `constant raw ${value}`,
    );
  }
});

test('six- and seven-argument CPU defaults retain the pre-integration SHA256', () => {
  // Captured before editing fields.ts at 87860490f93274fe80f11bcb32f77a378dbdfa79 with
  // node packages/biomes/tests/gpu-field-baseline.mjs (temporary source-resolver harness, then removed).
  // First spec/rectangle, all fieldNames in Map order, SHA256 over concatenated data bytes, without metadata.
  const spec = cases[0],
    frame = frameFor(module, spec),
    r = spec.rectangles[0];
  const six = rectFields(frame, ...args(r), fieldNames),
    seven = rectFields(frame, ...args(r), fieldNames, false);
  equalLayers(six, seven, 'CPU defaults');
  for (const result of [six, seven]) {
    const hash = createHash('sha256');
    for (const { data } of result.values()) hash.update(bytes(data));
    assert.equal(hash.digest('hex'), 'f523c684b9ed3e5980ba74c879aaa0f7543442bccefa9d5667101a06ff92b66c');
  }
});

test('every raw plane is validated before taking scratch or sampling heights', () => {
  const frame = frameFor(module, cases[0]),
    r = cases[0].rectangles[0],
    raw = regionFieldsRef(frame.region, frame.cell, ...args(r)),
    guarded = {
      ...frame,
      scratch: {
        take() {
          assert.fail('invalid raw input touched scratch');
        },
      },
      heights: {
        grid() {
          assert.fail('invalid raw input sampled heights');
        },
      },
    };
  for (const name of REGION_FIELD_NAMES)
    for (const bad of [new Int32Array(r.width * r.depth - 1), new Uint32Array(r.width * r.depth), undefined, null])
      assert.throws(() => rectFields(guarded, ...args(r), fieldNames, false, { ...raw, [name]: bad }), {
        name: 'TypeError',
        message: new RegExp(`Raw region ${name}.*Int32Array.*width \\* depth`),
      });
  assert.throws(() => rectFields(guarded, ...args(r), fieldNames, false, null), TypeError);
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

// Transport/lifecycle only: this fake fills readback from regionFieldsRef and never executes WGSL.
function fakeDevice(frame, r, { skip = false, pending = false, onMap, onDestroy } = {}) {
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
      assert.equal(code, module.REGION_FIELDS_WGSL);
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
        const raw = regionFieldsRef(frame.region, frame.cell, ...args(r)),
          count = r.width * r.depth,
          data = new Int32Array(dst.data);
        REGION_FIELD_NAMES.forEach((name, g) => data.set(raw[name], g * count));
        if (!skip) for (let k = 0; k < count; k++) data[5 * count + k] = k + 1;
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer, offset, data) => new Uint8Array(buffer.data).set(bytes(data), offset),
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
  assert.equal(f.buffers.length, 5);
  assert.ok(f.buffers.every((b) => b.destroyed));
  assert.equal(f.listeners.size, 0);
}

test('rectFieldsGPU transport produces every requested layer and releases all buffers', async (t) => {
  gpuConstants(t);
  for (const spec of cases) {
    const frame = frameFor(module, spec);
    for (const r of spec.rectangles)
      for (const names of fieldNameSets) {
        const f = fakeDevice(frame, r),
          result = await rectFieldsGPU(f.device, frame, ...args(r), names);
        equalLayers(result, rectFields(frame, ...args(r), names), `transport seed ${spec.seed} ${JSON.stringify(r)}`);
        assert.deepEqual(f.dispatch, [Math.ceil(r.width / 8), Math.ceil(r.depth / 8)]);
        freed(f);
      }
  }
});

test('missing GPU execution markers reject before producing any field layers', async (t) => {
  gpuConstants(t);
  const frame = frameFor(module, cases[0]),
    r = cases[0].rectangles[0],
    f = fakeDevice(frame, r, { skip: true }),
    guarded = {
      ...frame,
      scratch: {
        take() {
          assert.fail('failed GPU request entered field loop');
        },
      },
    };
  await assert.rejects(rectFieldsGPU(f.device, guarded, ...args(r), fieldNames), {
    name: 'MargoError',
    code: 'failed',
  });
  freed(f);
});

test('already aborted requests reject with the reason before any device or scratch call', async () => {
  const signal = AbortSignal.abort(new Error('stop before GPU request')),
    unused = new Proxy(
      {},
      {
        get() {
          assert.fail('already aborted request accessed frame or device');
        },
      },
    );
  await assert.rejects(rectFieldsGPU(unused, unused, 0, 0, 7, 19, fieldNames, { signal }), (e) => e === signal.reason);
});

test('abort while waiting or after readback rejects with the reason and never takes scratch', async (t) => {
  gpuConstants(t);
  const frame = frameFor(module, cases[0]),
    r = cases[0].rectangles[0],
    guarded = {
      ...frame,
      scratch: {
        take() {
          assert.fail('aborted GPU request took scratch');
        },
      },
    };
  for (const afterReadback of [false, true]) {
    const controller = new AbortController(),
      abort = () => controller.abort(new Error('stop GPU integration')),
      f = fakeDevice(frame, r, afterReadback ? { onDestroy: abort } : { pending: true, onMap: abort });
    await assert.rejects(
      rectFieldsGPU(f.device, guarded, ...args(r), fieldNames, { signal: controller.signal }),
      (e) => e === controller.signal.reason,
    );
    freed(f);
  }
});

test('GPU wait does not borrow scratch and temporary output uses it only after readback', async (t) => {
  gpuConstants(t);
  const frame = frameFor(module, cases[0]),
    r = cases[0].rectangles[0],
    scratch = new Scratch(),
    takes = [],
    shared = {
      ...frame,
      scratch: {
        take(...values) {
          takes.push(values[0]);
          return scratch.take(...values);
        },
      },
    },
    f = fakeDevice(frame, r, { pending: true }),
    pending = rectFieldsGPU(f.device, shared, ...args(r), fieldNames, { temporary: true });
  await f.mapStarted;
  assert.deepEqual(takes, [], 'GPU wait borrowed scratch');
  rectFields(shared, 50, 61, 5, 3, fieldNames, true);
  takes.length = 0;
  f.finishMap();
  const result = await pending;
  equalLayers(result, rectFields(frame, ...args(r), fieldNames), 'temporary GPU scratch');
  for (const name of fieldNames) assert.ok(takes.includes(name), `temporary ${name} did not reuse scratch`);
  freed(f);
});

test('GPU integration stays internal and fields imports region GPU code only as a type', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
    fields = readFileSync(new URL('../src/fields.ts', import.meta.url), 'utf8');
  for (const name of ['gpu-fields', 'rectFieldsGPU', 'gpu-region-fields']) {
    assert.ok(!root.includes(name));
    assert.ok(!JSON.stringify(manifest.exports).includes(name));
  }
  assert.match(fields, /import type \{ RegionFields \} from '\.\/gpu-region-fields\.js';/);
  assert.equal(fields.match(/from ['"]\.\/gpu-region-fields\.js['"]/g)?.length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inputsModuleCode } from './gpu-classify-inputs-entry.mjs';
import { inputsCases, inputsOracle, INPUTS_CASE_COUNT, requireHardwareAdapter } from './gpu-classify-inputs-cases.mjs';
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

const cpuModule = await import('../src/classify.ts');
const { warpLattice, warpPlanes } = await import('../src/classify-warp.ts');
const { presets } = await import('../src/presets.ts');
const { whittaker, holdridge } = await import('../src/zones.ts');
const cases = inputsCases({ ...cpuModule, presets, whittaker, holdridge });
const output = (s) => ({
  ids: new Uint8Array((s.input.n - 2) * ((s.input.depth ?? s.input.n) - 2) * 4),
  weights: new Uint8Array((s.input.n - 2) * ((s.input.depth ?? s.input.n) - 2) * 4),
});
const digest = (o) => createHash('sha256').update(o.ids).update(o.weights).digest('hex');
// Recorded from unchanged classify() at 24e50d3c before extracting either half.
const goldens = [
  '80ba7c7111835480b41b832b6e8e0e2a09a71012fe10e4796822b879ac061cef',
  'bcdcd8f942882e824e61225e1d98d879c8c1c55d09609028d21e709c4a835848',
  '6dd1b74c2212972861a52fca9a03ebbd570c407b5fab13ea07e3be08fbe85851',
  '92558055d6ffe7c1055298972dfb25bba0a6aeb9e3aaa516ccdf0f684269484f',
  '7e87ee71e6018602bcb3b2a2b2ba15b0bea560fef9515f84bb386053f3f12531',
  '158cff710b77c9d37aa35ab5894cf215961e0e4a3a7aae03d28b01cb23da1320',
  '1c843517950588a7ce68793b762fc1ceb5bb8289316dc5795d1fb094ae6249ff',
  '6ee850bd8f82b2de13fa9540f5e4d3b2a5a277ff05ee0956d4f200350bc7e46c',
  '8d4597cba4c3b9ebd48fb972b6506f25cafa8fbae6ef9e2c98aa9d282fc8a399',
  '8d4597cba4c3b9ebd48fb972b6506f25cafa8fbae6ef9e2c98aa9d282fc8a399',
  'ff1a968a3570d5d0c9d38b9e9099c5c909832c8c324803b6e49af72678e09f74',
  '9102ac0de5897028fc2ff1b29a768c84ba7c4b34614c217fef2816cb8e02fd2d',
  '5b0d81dbb66acffd11633d8092dfbe56e4f9457f65eee2cefe69016b221d0a8b',
  '84bdcaef91eaa3d3c73e32679d96faf54812e697829384baf3f190cd1ebdc254',
  '9be131ec02e461d2d6fcfa47ccacd2c2f87ca733d926eb5403a87bdd454c2948',
];
test('CPU split preserves pre-split classification goldens and planes', () => {
  assert.equal(cases.length, INPUTS_CASE_COUNT);
  cases.forEach((s, i) => {
    const expected = output(s),
      actual = output(s);
    cpuModule.classify(s.c, s.input, expected.ids, expected.weights);
    if (i < goldens.length) assert.equal(digest(expected), goldens[i], s.name);
    const planes = cpuModule.classifyInputs(s.c, s.input);
    assert.deepEqual(planes, inputsOracle(s.c, s.input, warpLattice), s.name);
    cpuModule.classifyPlanes(s.c, s.input, planes, actual.ids, actual.weights);
    assert.deepEqual(actual, expected, s.name);
  });
});

// biome-ignore format: Keep literal imports on one line for Factory auditing.
const { classifyInputsGPU, classifyGPU, CLASSIFY_INPUTS_WGSL, SOURCE_BOUND } = await import('../src/gpu-classify-inputs.ts');
const { CLASSIFY_WARP_WGSL } = await import('../src/gpu-classify-warp.ts');

test('hardware_bundle exposes the complete J5 proof graph without starting a browser', { timeout: 15000 }, async () => {
  const context = {};
  runInNewContext(await inputsModuleCode(), context, { timeout: 2000 });
  const proof = context.__margoInputsProof;
  assert.deepEqual(
    Object.keys(proof).sort(),
    [
      'INPUTS_CASE_COUNT',
      'buildRegion',
      'classifier',
      'classify',
      'classifyGPU',
      'classifyInputs',
      'classifyInputsGPU',
      'classifyPlanes',
      'createRelief',
      'divFloor',
      'fieldIntegrationCases',
      'fieldNames',
      'frameFor',
      'heightsOf',
      'holdridge',
      'inputsCases',
      'inputsOracle',
      'presets',
      'quantizeClimate',
      'rectFields',
      'rectFieldsGPU',
      'warpLattice',
      'whittaker',
    ].sort(),
  );
  assert.equal(proof.inputsCases(proof).length, INPUTS_CASE_COUNT);
  assert.equal(
    proof.fieldIntegrationCases().reduce((sum, s) => sum + s.rectangles.length, 0),
    16,
  );
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

// Transport only: readback is filled from CPU planes. This never executes or interprets WGSL.
function fakeDevice(s, { skip, onMap, pending, onPipeline } = {}) {
  const expected = cpuModule.classifyInputs(s.c, s.input);
  const reference = Object.fromEntries(Object.entries(expected).map(([name, p]) => [name, p?.slice()]));
  const cells = s.input.n * (s.input.depth ?? s.input.n),
    n1 = new Int32Array(cells),
    dT = new Int32Array(cells),
    n2 = new Int32Array(cells);
  warpPlanes(
    warpLattice(s.input.seed, s.input.cell, s.input.gx, s.input.gz, s.input.n, s.input.depth ?? s.input.n),
    s.input.gx,
    s.input.gz,
    s.input.n,
    s.input.depth ?? s.input.n,
    n2,
    dT,
    n1,
  );
  const buffers = [],
    listeners = new Map(),
    dispatch = [],
    uploads = [],
    groups = [];
  let phase = 'warp',
    scopes = 0;
  const device = {
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    pushErrorScope() {
      scopes++;
    },
    popErrorScope: async () => {
      scopes--;
      return null;
    },
    createShaderModule: ({ code }) => {
      assert.ok(code === CLASSIFY_WARP_WGSL || code === CLASSIFY_INPUTS_WGSL);
      phase = code === CLASSIFY_WARP_WGSL ? 'warp' : 'inputs';
      return { phase, getCompilationInfo: async () => ({ messages: [] }) };
    },
    createComputePipelineAsync: async ({ compute }) => {
      onPipeline?.(compute.module.phase, compute.entryPoint);
      return { entryPoint: compute.entryPoint, getBindGroupLayout: () => compute.entryPoint };
    },
    createBuffer: ({ size, usage }) => {
      const b = {
        data: new ArrayBuffer(size),
        usage,
        phase,
        destroyed: false,
        unmapped: false,
        destroy() {
          assert.ok(!this.destroyed);
          this.destroyed = true;
        },
        unmap() {
          this.unmapped = true;
        },
        mapAsync() {
          onMap?.(phase);
          return pending === phase ? new Promise(() => {}) : Promise.resolve();
        },
        getMappedRange() {
          return this.data;
        },
      };
      buffers.push(b);
      return b;
    },
    createBindGroup: ({ entries, layout }) => {
      assert.deepEqual(
        entries.map((e) => e.binding),
        layout === 'main' ? [0, 1, 2] : layout === 'inputs' ? [0, 1, 2, 3, 4] : [2, 3, 4],
      );
      groups.push({ entries, layout });
      return {};
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (...dims) => dispatch.push([phase, ...dims]),
        end() {},
      }),
      copyBufferToBuffer: (_src, _a, dst) => {
        const data = new Int32Array(dst.data);
        if (phase === 'warp') {
          data.set(n1);
          data.set(n2, cells);
          data.set(dT, 2 * cells);
          for (let k = 0; k < cells; k++) if (skip !== 'warp' || k !== cells - 1) data[3 * cells + k] = k + 1;
        } else {
          const total = data.length / 2;
          data.set(reference.warped);
          if (!s.c.score) data.set(reference.member, reference.warped.length);
          for (let k = 0; k < total; k++) if (skip !== 'inputs' || k !== total - 1) data[total + k] = k + 1;
        }
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (b, offset, data) => {
        new Uint8Array(b.data).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        uploads.push({ phase, buffer: b, data: data.slice() });
      },
      submit() {},
    },
  };
  return {
    device,
    buffers,
    listeners,
    dispatch,
    uploads,
    groups,
    reference,
    get scopes() {
      return scopes;
    },
  };
}
function freed(f) {
  assert.ok(f.buffers.every((b) => b.destroyed));
  assert.equal(f.listeners.size, 0);
  assert.equal(f.scopes, 0);
}

test('transport packs snapshots, dispatches partial groups and composes exact final classification bytes', async (t) => {
  gpuConstants(t);
  for (const s of cases) {
    const f = fakeDevice(s),
      actual = await classifyInputsGPU(f.device, s.c, s.input);
    assert.deepEqual(actual, f.reference, s.name);
    assert.equal(f.buffers.length, 10);
    assert.ok(f.buffers.filter((b) => b.usage & 1).every((b) => b.unmapped));
    const n = s.input.n,
      depth = s.input.depth ?? n,
      cells = n * depth;
    const dispatch = [
      ['warp', Math.ceil(n / 8), Math.ceil(depth / 8)],
      ['inputs', Math.ceil(n / 8), Math.ceil(depth / 8), s.c.inputs.length],
    ];
    if (!s.c.score) dispatch.push(['inputs', Math.ceil(n / 8), Math.ceil(depth / 8), s.c.ids.length]);
    assert.deepEqual(f.dispatch, dispatch);
    const uploaded = f.uploads.filter((u) => u.phase === 'inputs');
    const packed = new Int32Array(cells * s.c.inputs.length);
    for (let slot = 0; slot < s.c.inputs.length; slot++) {
      const src = s.c.modes[slot] ? s.input.layer(s.c.inputs[slot]) : s.input.user(s.c.inputs[slot]);
      if (src) packed.set(src, slot * cells);
    }
    assert.deepEqual(uploaded[0].data, packed);
    assert.deepEqual(uploaded[1].data.subarray(0, cells), actual.n2);
    assert.deepEqual(
      uploaded[3].data,
      new Uint32Array([
        n,
        depth,
        cells,
        cells * (s.c.inputs.length + (s.c.score ? 0 : s.c.ids.length)),
        s.c.inputs.length,
        s.c.ids.length,
        2 * s.c.inputs.length,
        2 * s.c.inputs.length + s.c.ids.length + 1,
      ]),
    );
    const table = uploaded[2].data,
      d = s.c.envelopes,
      base = 2 * s.c.inputs.length;
    assert.deepEqual(table.subarray(base, base + d.start.length), d.start);
    for (let q = 0; q < d.slot.length; q++)
      assert.deepEqual(
        [...table.subarray(base + d.start.length + 4 * q, base + d.start.length + 4 * q + 4)],
        [d.slot[q], d.lo[q], d.hi[q], d.width[q]],
      );
    freed(f);
    const g = fakeDevice(s),
      got = output(s),
      expected = output(s);
    cpuModule.classify(s.c, s.input, expected.ids, expected.weights);
    await classifyGPU(g.device, s.c, s.input, got.ids, got.weights);
    assert.deepEqual(got, expected, s.name);
    freed(g);
  }
});

test('one missing execution marker in either dispatch rejects failed and frees buffers', async (t) => {
  gpuConstants(t);
  for (const skip of ['warp', 'inputs']) {
    const s = cases[0],
      f = fakeDevice(s, { skip });
    await assert.rejects(classifyInputsGPU(f.device, s.c, s.input), { name: 'MargoError', code: 'failed' });
    freed(f);
  }
});

test('already aborted requests never touch input, outputs or device', async () => {
  const signal = AbortSignal.abort(new Error('cancel classification'));
  const unused = new Proxy(
    {},
    {
      get() {
        assert.fail('aborted request accessed an input');
      },
    },
  );
  await assert.rejects(classifyInputsGPU(unused, unused, unused, { signal }), (e) => e === signal.reason);
  await assert.rejects(classifyGPU(unused, unused, unused, unused, unused, { signal }), (e) => e === signal.reason);
});

test('abort during either mapping preserves reason, releases resources and never writes outputs', {
  timeout: 2000,
}, async (t) => {
  gpuConstants(t);
  for (const phase of ['warp', 'inputs']) {
    const controller = new AbortController(),
      signal = controller.signal,
      s = cases[0],
      out = output(s);
    out.ids.fill(42);
    out.weights.fill(17);
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
    const f = fakeDevice(s, {
      pending: phase,
      onMap: (current) => {
        if (current === phase) controller.abort(new Error('cancel mapping'));
      },
    });
    await assert.rejects(
      classifyGPU(f.device, s.c, s.input, out.ids, out.weights, { signal }),
      (e) => e === signal.reason,
    );
    assert.equal(adds, removes);
    assert.ok(out.ids.every((v) => v === 42) && out.weights.every((v) => v === 17));
    freed(f);
  }
});

test('compile, pipeline, dispatch, map, uncaptured and allocation errors release resources', {
  timeout: 4000,
}, async (t) => {
  gpuConstants(t);
  for (const phase of ['warp', 'inputs'])
    for (const mode of [
      'compile',
      'pipeline',
      'pipeline-sync',
      'dispatch',
      'dispatch-sync',
      'mapping',
      'mapping-sync',
      'uncaptured',
      'allocation',
    ]) {
      const s = cases[0],
        f = fakeDevice(s);
      let current;
      const shader = f.device.createShaderModule;
      f.device.createShaderModule = (opts) => {
        const module = shader(opts);
        current = module.phase;
        if (current === phase && mode === 'compile')
          module.getCompilationInfo = async () => ({ messages: [{ message: 'bad shader' }] });
        return module;
      };
      const pipeline = f.device.createComputePipelineAsync;
      f.device.createComputePipelineAsync = (opts) => {
        if (current === phase && mode === 'pipeline') return Promise.reject(new Error('pipeline failed'));
        if (current === phase && mode === 'pipeline-sync') throw new Error('pipeline failed');
        return pipeline(opts);
      };
      const pop = f.device.popErrorScope;
      // Track each phase's dispatch scope independently.
      if (mode === 'dispatch') {
        let phasePops = 0;
        f.device.popErrorScope = async () => {
          await pop();
          if (current === phase && ++phasePops === 2) return { message: 'bad dispatch' };
          return null;
        };
      }
      const create = f.device.createBuffer;
      f.device.createBuffer = (options) => {
        if (current === phase && mode === 'allocation' && f.buffers.filter((b) => b.phase === phase).length === 2)
          throw new Error('allocation failed');
        const b = create(options);
        if (current === phase && mode === 'mapping')
          b.mapAsync = async () => {
            throw new Error('map failed');
          };
        if (current === phase && mode === 'mapping-sync')
          b.mapAsync = () => {
            throw new Error('map failed');
          };
        return b;
      };
      f.device.queue.submit = () => {
        if (current !== phase) return;
        if (mode === 'dispatch-sync') throw new Error('dispatch failed');
        if (mode === 'uncaptured') f.listeners.get('uncapturederror')({ error: { message: 'GPU failed' } });
      };
      await assert.rejects(
        classifyInputsGPU(f.device, s.c, s.input),
        { name: 'MargoError', code: 'failed' },
        phase + mode,
      );
      freed(f);
    }
});

test('invalid sources, dims, origins and device limits reject before touching GPU allocations', async (t) => {
  gpuConstants(t);
  const s = cases[0],
    bad = [];
  for (const key of ['n', 'depth'])
    for (const v of [0, 1, 2, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      bad.push([{ ...s.input, [key]: v }, s.c, RangeError]);
  for (const key of ['gx', 'gz'])
    for (const v of [NaN, 1.5, -2147483649, 2147483647]) bad.push([{ ...s.input, [key]: v }, s.c, RangeError]);
  for (const key of ['seed', 'cell', 'ecotone']) bad.push([{ ...s.input, [key]: NaN }, s.c, RangeError]);
  for (const mode of [0, 1, 2, 3, 4, 5, 6])
    for (const v of [NaN, Infinity, 1.5, SOURCE_BOUND + 1, -SOURCE_BOUND - 1]) {
      const input = {
        ...s.input,
        layer: () => Array(s.input.n * s.input.depth).fill(v),
        user: () => Array(s.input.n * s.input.depth).fill(v),
      };
      bad.push([input, { ...s.c, modes: new Int32Array(s.c.inputs.length).fill(mode) }, RangeError]);
    }
  bad.push([{ ...s.input, layer: () => [] }, s.c, TypeError]);
  bad.push([s.input, { ...s.c, modes: new Int32Array(1) }, TypeError]);
  bad.push([s.input, { ...s.c, modes: new Int32Array(s.c.inputs.length).fill(7) }, RangeError]);
  for (const key of ['lo', 'hi', 'width', 'slot', 'start']) {
    const d = { ...s.c.envelopes, [key]: s.c.envelopes[key].slice() };
    d[key][0] = key === 'lo' ? NaN : key === 'hi' ? 2147483648 : key === 'width' ? 0 : key === 'slot' ? 1000 : 1;
    bad.push([s.input, { ...s.c, envelopes: d }, RangeError]);
  }
  for (const [input, c, error] of bad) {
    const f = fakeDevice(s);
    await assert.rejects(classifyInputsGPU(f.device, c, input), error);
    assert.equal(f.buffers.length, 0);
    assert.equal(f.uploads.length, 0);
    freed(f);
  }
  for (const [key, value] of [
    ['maxBufferSize', 16],
    ['maxStorageBufferBindingSize', 16],
    ['maxComputeWorkgroupsPerDimension', 1],
  ]) {
    const f = fakeDevice(s);
    f.device.limits[key] = value;
    await assert.rejects(classifyInputsGPU(f.device, s.c, s.input), RangeError);
    assert.equal(f.buffers.length, 0);
    freed(f);
  }
  const f = fakeDevice(s);
  await assert.rejects(classifyGPU(f.device, s.c, s.input, new Uint8Array(0), output(s).weights), TypeError);
  assert.equal(f.buffers.length, 0);
});

test('source and dimension uploads are snapshotted before the first GPU yield', async (t) => {
  gpuConstants(t);
  const s = inputsCases({ ...cpuModule, presets, whittaker, holdridge })[0],
    before = new Map([...s.sources].map(([key, v]) => [key, v.slice()]));
  const dimensions = Object.fromEntries(Object.entries(s.c.envelopes).map(([key, v]) => [key, v.slice()])),
    modes = s.c.modes.slice();
  const f = fakeDevice(s, {
    onPipeline: (phase) => {
      if (phase !== 'warp') return;
      for (const source of s.sources.values()) source.fill(SOURCE_BOUND + 1);
      s.c.modes.fill(7);
      s.c.envelopes.lo.fill(NaN);
      s.c.envelopes.hi.fill(Infinity);
      s.c.envelopes.width.fill(0);
    },
  });
  const actual = await classifyInputsGPU(f.device, s.c, s.input);
  assert.deepEqual(actual, f.reference);
  const upload = f.uploads.find((u) => u.phase === 'inputs').data,
    cells = s.input.n * s.input.depth;
  s.c.inputs.forEach((name, slot) => {
    if (before.has(name)) assert.deepEqual(upload.subarray(slot * cells, (slot + 1) * cells), before.get(name));
  });
  const table = f.uploads.filter((u) => u.phase === 'inputs')[2].data;
  for (let slot = 0; slot < modes.length; slot++) assert.equal(table[2 * slot], modes[slot]);
  const dims = 2 * modes.length + s.c.ids.length + 1;
  for (let q = 0; q < dimensions.slot.length; q++)
    assert.deepEqual(
      [...table.subarray(dims + 4 * q, dims + 4 * q + 4)],
      [dimensions.slot[q], dimensions.lo[q], dimensions.hi[q], dimensions.width[q]],
    );
  freed(f);
});

test('concurrent GPU requests retain their planes while synchronous classification reuses scratch', async (t) => {
  gpuConstants(t);
  const a = cases[0],
    b = cases[1],
    f = fakeDevice(a),
    g = fakeDevice(b);
  const first = classifyInputsGPU(f.device, a.c, a.input),
    second = classifyInputsGPU(g.device, b.c, b.input);
  cpuModule.classifyInputs(cases[2].c, cases[2].input);
  const [x, y] = await Promise.all([first, second]);
  assert.deepEqual(x, f.reference);
  assert.deepEqual(y, g.reference);
  freed(f);
  freed(g);
});

test('GPU inputs and helpers stay internal; kernels have no raw signed division or floating arithmetic', () => {
  const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
    classifier = readFileSync(new URL('../src/classify.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(classifier, /from ['"][^'"]*gpu-/);
  for (const name of ['gpu-classify-inputs', 'classifyGPU', 'classifyInputsGPU', 'classifyPlanes', 'classifyInputs']) {
    assert.ok(!root.includes(name));
    assert.ok(!JSON.stringify(manifest.exports).includes(name));
  }
  const code = CLASSIFY_INPUTS_WGSL.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\bf32\b/);
  for (const rhs of code.matchAll(/\/\s*(\w+)/g)) assert.match(rhs[1], /^\d+u$/);
});
test('hardware gate rejects missing, fallback, software, virtual and mismatched adapters', () => {
  const info = {
    name: 'NVIDIA RTX A6000',
    nameSource: 'webgpu',
    fallback: false,
    device: '0x2230',
    renderer: 'NVIDIA 0x2230',
  };
  assert.equal(requireHardwareAdapter(info), info.name);
  for (const patch of [
    { name: '' },
    { nameSource: '' },
    { fallback: true },
    { fallback: null },
    { renderer: 'SwiftShader' },
    { name: 'NVIDIA virtual adapter' },
    { renderer: 'NVIDIA 0x1234' },
  ])
    assert.throws(() => requireHardwareAdapter({ ...info, ...patch }));
});

// WebGPU methods may throw RangeError too: an allocation failure is not invalid caller input.
test('GPU allocation RangeError uses failed after input validation', async (t) => {
  gpuConstants(t);
  for (const phase of ['warp', 'inputs']) {
    const s = cases[0],
      f = fakeDevice(s),
      create = f.device.createBuffer;
    f.device.createBuffer = (options) => {
      const count = f.buffers.filter((b) => b.phase === phase).length;
      if ((phase === 'warp' || f.buffers.length >= 4) && count === 2) throw new RangeError('device allocation failed');
      return create(options);
    };
    await assert.rejects(classifyInputsGPU(f.device, s.c, s.input), { name: 'MargoError', code: 'failed' });
    freed(f);
  }
});

test('synchronous pipeline failures observe secondary compilation and scope rejections', {
  timeout: 2000,
}, async (t) => {
  gpuConstants(t);
  for (const phase of ['warp', 'inputs']) {
    const s = cases[0],
      f = fakeDevice(s),
      shader = f.device.createShaderModule,
      pipeline = f.device.createComputePipelineAsync,
      pop = f.device.popErrorScope;
    let current;
    f.device.createShaderModule = (options) => {
      const module = shader(options);
      current = module.phase;
      if (current === phase) module.getCompilationInfo = () => Promise.reject(new Error('compile failed'));
      return module;
    };
    f.device.createComputePipelineAsync = (options) => {
      if (current === phase) throw new Error('pipeline sync failed');
      return pipeline(options);
    };
    f.device.popErrorScope = async () => {
      await pop();
      if (current === phase) throw new Error('scope failed');
      return null;
    };
    await assert.rejects(classifyInputsGPU(f.device, s.c, s.input), { name: 'MargoError', code: 'failed' });
    freed(f);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('fixture matrix exercises all J5 source, envelope, selection and paint boundaries', () => {
  const modes = new Set(),
    widths = new Set(),
    reaches = new Set(),
    paint = new Set();
  let earlyZero = false,
    missingLayer = false,
    missingUser = false,
    negativeFloor10 = false,
    negativeRainRemainder = false,
    subQ16 = false;
  for (const s of cases) {
    const { c, input } = s,
      planes = inputsOracle(c, input, warpLattice),
      cells = input.n * (input.depth ?? input.n);
    c.inputs.forEach((name, slot) => {
      const mode = c.modes[slot],
        source = mode ? input.layer(name) : input.user(name);
      modes.add(mode);
      if (!source) {
        if (mode) missingLayer = true;
        else missingUser = true;
      }
      if (source && s.name === 'all modes and signed boundaries') {
        assert.ok(
          source.some((v) => v === SOURCE_BOUND),
          `mode ${mode} positive boundary`,
        );
        assert.ok(
          source.some((v) => v === -SOURCE_BOUND),
          `mode ${mode} negative boundary`,
        );
      }
    });
    const noise = new Int32Array(cells),
      dt = new Int32Array(cells);
    warpPlanes(
      warpLattice(input.seed, input.cell, input.gx, input.gz, input.n, input.depth ?? input.n),
      input.gx,
      input.gz,
      input.n,
      input.depth ?? input.n,
      noise,
      dt,
    );
    negativeFloor10 ||= dt.some((v) => v < 0 && v % 10 !== 0);
    const rainSlot = c.inputs.indexOf('rainfall'),
      rain = input.layer('rainfall');
    if (rainSlot >= 0 && rain)
      negativeRainRemainder ||= rain.some(
        (v, k) => BigInt(v) * BigInt(noise[k]) < 0n && (BigInt(v) * BigInt(noise[k])) % 409600n !== 0n,
      );
    for (const p of c.paint) paint.add(`${p.mode}:${!!p.mask}`);
    if (c.score) continue;
    const d = c.envelopes;
    for (let q = 0; q < d.slot.length; q++) {
      widths.add(d.width[q]);
      for (let k = 0; k < cells; k++) {
        const x = planes.warped[d.slot[q] * cells + k],
          reach = Math.max(d.lo[q] - x, x - d.hi[q]) + (d.width[q] >> 1);
        if (reach === 0) reaches.add('zero');
        if (reach === d.width[q] - 1) reaches.add('last');
        if (reach === d.width[q]) reaches.add('end');
        if (reach > 0 && reach * 65536 < d.width[q]) subQ16 = true;
      }
    }
    for (let b = 0; b < c.ids.length; b++)
      if (d.start[b + 1] - d.start[b] > 1) {
        const first = d.start[b],
          x = planes.warped[d.slot[first] * cells],
          reach = Math.max(d.lo[first] - x, x - d.hi[first]) + (d.width[first] >> 1);
        earlyZero ||= reach >= d.width[first];
      }
  }
  assert.deepEqual([...modes].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(widths.has(1) && widths.has(2147483647));
  assert.deepEqual([...reaches].sort(), ['end', 'last', 'zero']);
  assert.deepEqual(
    { earlyZero, missingLayer, missingUser, negativeFloor10, negativeRainRemainder, subQ16 },
    {
      earlyZero: true,
      missingLayer: true,
      missingUser: true,
      negativeFloor10: true,
      negativeRainRemainder: true,
      subQ16: true,
    },
  );
  for (const mode of [0, 1, 2, 3]) for (const masked of [false, true]) assert.ok(paint.has(`${mode}:${masked}`));
  const ties = cases.find((s) => s.name === 'six ties top four by rank'),
    out = output(ties);
  cpuModule.classify(ties.c, ties.input, out.ids, out.weights);
  assert.deepEqual([...out.ids.subarray(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...out.weights.subarray(0, 4)], [64, 64, 64, 63]);
});

test('zone scorer errors propagate unchanged after GPU resources are released', async (t) => {
  gpuConstants(t);
  const original = cases.find((s) => s.c.kind === 'whittaker'),
    s = { ...original, c: { ...original.c } },
    f = fakeDevice(s),
    reason = new Error('zone scoring failed');
  s.c.score = () => {
    throw reason;
  };
  await assert.rejects(classifyInputsGPU(f.device, s.c, s.input), (e) => e === reason);
  freed(f);
});

test('abort after zone scoring prevents the synchronous tail from writing outputs', async (t) => {
  gpuConstants(t);
  const original = cases.find((s) => s.c.kind === 'holdridge'),
    s = { ...original, c: { ...original.c } },
    f = fakeDevice(s),
    controller = new AbortController(),
    score = s.c.score,
    out = output(s);
  out.ids.fill(42);
  out.weights.fill(17);
  s.c.score = (...a) => {
    score(...a);
    controller.abort(new Error('cancel selection'));
  };
  await assert.rejects(
    classifyGPU(f.device, s.c, s.input, out.ids, out.weights, { signal: controller.signal }),
    (e) => e === controller.signal.reason,
  );
  assert.ok(out.ids.every((v) => v === 42) && out.weights.every((v) => v === 17));
  freed(f);
});

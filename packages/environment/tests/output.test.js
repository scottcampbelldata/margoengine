// ColorOutput on a fake WebGPU device through a real core engine: nothing changes on an sRGB/SDR display or WebGL2;
// on a P3/HDR display the canvas is reconfigured, core draws into an offscreen copy and a last pass writes the canvas;
// it survives device restores, composes with TransparentCanvas in either order and hands Tonemap its HDR/P3 contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineKernel, box } from '@margoengine/core';
import { ColorOutput, TransparentCanvas } from '../dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';

function fakeGPU(t, { display = [], extended = true } = {}) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'matchMedia'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const log = { configs: [], calls: [], uniforms: [], modules: [], groups: [], canvasViews: 0 };
  let config = null;
  const canvasTexture = {
    width: 16,
    height: 16,
    createView: () => {
      log.canvasViews++;
      return { canvas: true };
    },
  };
  const context = {
    configure(c) {
      config = {
        colorSpace: 'srgb',
        alphaMode: 'opaque',
        ...c,
        toneMapping: extended ? (c.toneMapping ?? { mode: 'standard' }) : { mode: 'standard' },
      };
      log.configs.push(config);
    },
    getConfiguration: () => config && { ...config },
    unconfigure() {
      config = null;
    },
    getCurrentTexture: () => canvasTexture,
  };
  const canvas = {
    width: 16,
    height: 16,
    clientWidth: 16,
    clientHeight: 16,
    getContext: (kind) => (kind === 'webgpu' ? context : null),
  };
  const record =
    (name) =>
    (...args) =>
      log.calls.push([name, ...args.map((a) => (typeof a === 'object' && a ? Object.keys(a).sort().join() : a))]);
  const pass = {
    setPipeline: record('setPipeline'),
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed: record('drawIndexed'),
    draw: record('draw'),
    end: record('end'),
  };
  const device = () => ({
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: {
      writeBuffer(buffer, _offset, data) {
        if (buffer.label === 'color output') log.uniforms.push(Array.from(data));
        log.calls.push(['writeBuffer', buffer.size]);
      },
      submit() {},
    },
    createShaderModule: (d) => {
      log.modules.push(d.code);
      return d;
    },
    createBindGroup: (descriptor) => {
      const group = {};
      log.groups.push({
        group,
        label: descriptor.label,
        layout: descriptor.layout,
        entries: descriptor.entries.map(({ binding, resource }) => [binding, resource]),
      });
      return group;
    },
    createBuffer: (d) => ({ size: d.size, label: d.label, destroy() {} }),
    createTexture: (d) => {
      log.calls.push(['createTexture', d.label, d.format]);
      return {
        width: d.size[0],
        height: d.size[1],
        format: d.format,
        label: d.label,
        usage: d.usage,
        dimension: '2d',
        sampleCount: d.sampleCount ?? 1,
        createView: () => ({ label: d.label }),
        destroy() {},
      };
    },
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: (d) => {
      log.calls.push(['createRenderPipeline', d.label, d.fragment?.entryPoint, d.fragment?.targets?.[0]?.format]);
      return { getBindGroupLayout: () => ({}) };
    },
    createCommandEncoder: () => ({
      beginRenderPass: (d) => {
        const color = d.colorAttachments[0];
        log.calls.push([
          'beginRenderPass',
          d.label,
          color && (color.view?.label ?? (color.view?.canvas ? 'canvas' : 'core')),
          color?.resolveTarget?.label,
        ]);
        return pass;
      },
      finish: () => ({}),
    }),
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device() }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 };
  globalThis.matchMedia = (query) => ({ matches: display.includes(query) });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { canvas, context, canvasTexture, log };
}
const P3 = '(color-gamut: p3)',
  HDR = '(dynamic-range: high)';
const engineFor = async (canvas) => {
  const engine = await EngineKernel.create(canvas, { capacity: 2, backend: 'webgpu' });
  engine.createMesh().setGeometry(box());
  return engine;
};

test('on an sRGB/SDR display ColorOutput changes nothing: same configuration and GPU calls as without it', async (t) => {
  const frames = async (attach) => {
    const { canvas, log } = fakeGPU(t),
      engine = await engineFor(canvas);
    try {
      const output = attach ? ColorOutput.attach(engine) : undefined;
      for (let i = 0; i < 3; i++) engine.render();
      if (output) assert.deepEqual([output.gamut, output.hdr], ['srgb', false]);
      return log;
    } finally {
      engine.dispose();
    }
  };
  const without = await frames(false),
    withOutput = await frames(true);
  const settings = (log) => log.configs.map(({ device, ...rest }) => rest);
  assert.deepEqual(withOutput.calls, without.calls);
  assert.deepEqual(settings(withOutput), settings(without));
  assert.equal(withOutput.canvasViews, 3, 'core keeps drawing into the real canvas texture');
});

test('ColorOutput does nothing on the WebGL2 fallback', async (t) => {
  fakeGPU(t, { display: [P3, HDR] });
  const canvas = { width: 4, height: 4, clientWidth: 4, clientHeight: 4, getContext: () => null },
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = await EngineKernel.create(canvas, { backend: 'webgl2', fallback: () => renderer });
  try {
    const output = ColorOutput.attach(engine);
    engine.render();
    assert.deepEqual([output.gamut, output.hdr], ['srgb', false]);
    output.dispose();
  } finally {
    engine.dispose();
  }
});

test('Display P3: canvas colorSpace, core redirected offscreen, a last pass writes the canvas, restore and dispose', async (t) => {
  const { canvas, context, canvasTexture, log } = fakeGPU(t, { display: [P3, HDR] }),
    engine = await engineFor(canvas);
  try {
    const output = ColorOutput.attach(engine, { hdr: false });
    assert.deepEqual([output.gamut, output.hdr], ['p3', false]);
    assert.deepEqual(
      ['format', 'colorSpace', 'toneMapping', 'alphaMode'].map((key) => log.configs.at(-1)[key]),
      ['bgra8unorm', 'display-p3', { mode: 'standard' }, 'opaque'],
    );
    assert.notEqual(context.getCurrentTexture(), canvasTexture, 'core gets the offscreen image');
    log.calls.length = 0;
    engine.render();
    const passes = log.calls.filter((call) => call[0] === 'beginRenderPass');
    assert.deepEqual(
      passes.slice(-3),
      [
        ['beginRenderPass', 'color output resolve', 'core', 'color output image'],
        ['beginRenderPass', 'color output', 'canvas', undefined],
        ['beginRenderPass', undefined, 'core', 'color output image'],
      ],
      "resolves the 4x frame into the image, writes the real canvas; core's own final resolve lands offscreen",
    );
    assert.deepEqual(log.uniforms.at(-1), [1, 1, 0, 0], 'SDR range, P3 conversion, no Tonemap excess, opaque');
    const device = log.configs.at(-1).device;
    await engine.rebootDevice();
    log.calls.length = 0;
    engine.render();
    assert.equal(log.configs.at(-1).colorSpace, 'display-p3');
    assert.notEqual(log.configs.at(-1).device, device, 'reapplied with the restored device');
    assert.ok(
      log.calls.some((call) => call[0] === 'beginRenderPass' && call[1] === 'color output' && call[2] === 'canvas'),
    );
    output.dispose();
    output.dispose();
    assert.equal(log.configs.at(-1).colorSpace, 'srgb');
    assert.equal(context.getCurrentTexture(), canvasTexture, 'unpatched');
    assert.equal(engine.hasPlugin('color-output'), false);
    const views = log.canvasViews;
    engine.render();
    assert.equal(log.canvasViews, views + 1, 'core draws the canvas again');
  } finally {
    engine.dispose();
  }
});

test('HDR composes with TransparentCanvas in either order; a browser without extended tone mapping falls back to SDR', async (t) => {
  for (const first of ['transparent', 'output']) {
    const { canvas, log } = fakeGPU(t, { display: [P3, HDR] }),
      engine = await engineFor(canvas);
    try {
      const attach = (name) =>
        name === 'transparent'
          ? TransparentCanvas.attach(engine)
          : ColorOutput.attach(engine, { gamut: 'srgb', peak: 6 });
      attach(first);
      attach(first === 'transparent' ? 'output' : 'transparent');
      const check = () =>
        assert.deepEqual(
          ['format', 'colorSpace', 'toneMapping', 'alphaMode'].map((key) => log.configs.at(-1)[key]),
          ['rgba16float', 'srgb', { mode: 'extended' }, 'premultiplied'],
          first,
        );
      check();
      engine.render();
      assert.deepEqual(log.uniforms.at(-1), [6, 0, 0, 1]);
      await engine.rebootDevice();
      check();
      assert.ok(
        log.calls.some(
          (call) => call[0] === 'createRenderPipeline' && call[1] === 'color output' && call[3] === 'rgba16float',
        ),
      );
    } finally {
      engine.dispose();
    }
  }
  const { canvas, log } = fakeGPU(t, { display: [P3, HDR], extended: false }),
    engine = await engineFor(canvas);
  try {
    const output = ColorOutput.attach(engine);
    assert.deepEqual([output.gamut, output.hdr], ['p3', false]);
    assert.deepEqual([log.configs.at(-1).format, log.configs.at(-1).colorSpace], ['bgra8unorm', 'display-p3']);
  } finally {
    engine.dispose();
  }
});

test('force skips the media queries; options are validated', async (t) => {
  const { canvas } = fakeGPU(t),
    engine = await engineFor(canvas);
  try {
    const output = ColorOutput.attach(engine, { force: true });
    assert.deepEqual([output.gamut, output.hdr, output.peak], ['p3', true, 4]);
  } finally {
    engine.dispose();
  }
  for (const options of [
    { gamut: 'rec2020' },
    { peak: 0.5 },
    { peak: 17 },
    { peak: NaN },
    { hdr: 1 },
    { force: 'yes' },
  ])
    assert.throws(() => new ColorOutput(options), RangeError);
});

test('Tonemap under ColorOutput grades with the HDR/P3 shader and writes the excess ColorOutput adds back', async (t) => {
  const { canvas, log } = fakeGPU(t, { display: [P3, HDR] }),
    engine = await engineFor(canvas);
  try {
    ColorOutput.attach(engine, { peak: 3 });
    const tonemap = Tonemap.attach(engine, { curve: 'neutral' });
    engine.render();
    engine.render();
    assert.ok(
      log.modules.some((code) => code.includes('fn excess')),
      'output variant of the tonemap shader',
    );
    const passes = log.calls.filter((call) => call[0] === 'beginRenderPass').map((call) => call[2]);
    assert.ok(passes.includes('color output excess'), "excess written to ColorOutput's target");
    assert.deepEqual(log.uniforms.at(-1), [3, 1, 1, 0], 'peak, P3, excess used, opaque');
    tonemap.dispose();
  } finally {
    engine.dispose();
  }
});

test('ColorOutput retains its group until image, excess, pipeline or device identity changes', async (t) => {
  const { canvas, log } = fakeGPU(t, { display: [P3, HDR] }),
    engine = await engineFor(canvas);
  try {
    const output = ColorOutput.attach(engine),
      groups = () => log.groups.filter((group) => group.label === 'color output');
    engine.render();
    const first = groups()[0];
    assert.equal(groups().length, 1);
    assert.equal(first.entries[0][1], first.entries[1][1], 'unused excess samples the same image');
    for (let i = 0; i < 40; i++) engine.render();
    assert.equal(groups().length, 1, 'unchanged frames retain the group');

    canvas.clientWidth = canvas.width = 32;
    engine.render();
    const resized = groups().at(-1);
    assert.equal(groups().length, 2);
    assert.notEqual(resized.entries[0][1], first.entries[0][1]);
    assert.equal(resized.entries[0][1], resized.entries[1][1]);

    const tonemap = Tonemap.attach(engine);
    engine.render();
    const withExcess = groups().at(-1);
    assert.equal(groups().length, 3);
    assert.equal(withExcess.entries[0][1], resized.entries[0][1]);
    assert.notEqual(withExcess.entries[1][1], withExcess.entries[0][1]);
    for (let i = 0; i < 40; i++) engine.render();
    assert.equal(groups().length, 3, 'unchanged excess target retains the group');
    tonemap.dispose();
    engine.render();
    assert.equal(groups().length, 4, 'removing excess invalidates its binding');
    assert.equal(groups().at(-1).entries[0][1], groups().at(-1).entries[1][1]);

    const device = log.configs.at(-1).device,
      createGroup = device.createBindGroup;
    // A new presentation format uses another pipeline and its own bind-group layout.
    output.extended = false;
    engine.render();
    assert.equal(groups().length, 5);
    assert.notEqual(groups().at(-1).layout, groups().at(-2).layout);
    output.extended = true;
    engine.render();
    assert.equal(groups().length, 6, 'returning to the HDR pipeline rebinds it');

    let failed = false;
    device.createBindGroup = function (descriptor) {
      if (!failed && descriptor.label === 'color output') {
        failed = true;
        throw new Error('output group failed');
      }
      return createGroup.call(this, descriptor);
    };
    canvas.clientHeight = canvas.height = 32;
    assert.throws(() => engine.render(), /output group failed/);
    assert.equal(groups().length, 6);
    engine.render();
    assert.equal(groups().length, 7, 'failed creation leaves the previous cache invalid');
    device.createBindGroup = createGroup;

    await engine.rebootDevice();
    engine.render();
    assert.notEqual(log.configs.at(-1).device, device);
    assert.equal(groups().length, 8, 'restored device creates a fresh group');
    for (let i = 0; i < 10; i++) engine.render();
    assert.equal(groups().length, 8);
  } finally {
    engine.dispose();
  }
});

// TransparentCanvas on a fake WebGPU device through a real core engine: canvas alphaMode on attach, after a device
// restore and after dispose; empty pixels written as premultiplied alpha 0; nothing on the WebGL2 fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineKernel, box } from '@margoengine/core';
import { TransparentCanvas, ColorBackground } from '../dist/index.js';

function fakeGPU(t) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const log = { modes: [], devices: [], uniforms: [] },
    context = {
      configure(c) {
        log.modes.push(c.alphaMode ?? 'opaque');
        log.devices.push(c.device);
      },
      unconfigure() {},
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
  const canvas = {
    width: 16,
    height: 16,
    clientWidth: 16,
    clientHeight: 16,
    getContext: (kind) => (kind === 'webgpu' ? context : null),
  };
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed() {},
    draw() {},
    end() {},
  };
  const device = () => ({
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: {
      writeBuffer(buffer, _offset, data) {
        if (buffer.size === 32) log.uniforms.push(Array.from(data));
      },
      submit() {},
    },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createBuffer: (d) => ({ size: d.size, destroy() {} }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
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
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { canvas, log };
}

test('TransparentCanvas switches the canvas to premultiplied, keeps it across device restores and restores opaque on dispose', async (t) => {
  const { canvas, log } = fakeGPU(t),
    engine = await EngineKernel.create(canvas, { capacity: 2, backend: 'webgpu' });
  try {
    engine.createMesh().setGeometry(box());
    const transparency = TransparentCanvas.attach(engine);
    assert.ok(transparency instanceof TransparentCanvas && transparency instanceof ColorBackground);
    engine.render();
    assert.deepEqual(log.uniforms.at(-1), [0, 0, 0, 0, 0, 0, 0, 0], 'empty pixels: premultiplied alpha 0');
    await engine.rebootDevice();
    engine.render();
    assert.deepEqual(
      log.modes,
      ['opaque', 'premultiplied', 'opaque', 'premultiplied'],
      'core reconfigures on restore, the plugin follows',
    );
    assert.notEqual(log.devices[3], log.devices[1], 'reconfigured with the restored device');
    transparency.dispose();
    transparency.dispose();
    assert.deepEqual(log.modes.slice(4), ['opaque'], 'dispose() restores an opaque canvas once');
    assert.equal(engine.hasPlugin('transparent-canvas'), false);
    const scoped = TransparentCanvas.attach(engine);
    {
      using _ = scoped;
    }
    assert.equal(log.modes.at(-1), 'opaque');
  } finally {
    engine.dispose();
  }
});

test('TransparentCanvas does nothing on the WebGL2 fallback; ColorBackground output is unchanged', async () => {
  const canvas = { width: 4, height: 4, clientWidth: 4, clientHeight: 4, getContext: () => null },
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = await EngineKernel.create(canvas, { backend: 'webgl2', fallback: () => renderer });
  try {
    const transparency = TransparentCanvas.attach(engine);
    engine.render();
    transparency.dispose();
  } finally {
    engine.dispose();
  }
  assert.equal(new ColorBackground({ color: '#ff0000' }).color[0], 1);
});

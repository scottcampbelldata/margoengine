import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineKernel, PbrMaterial, Camera, box } from '../../core/dist/index.js';
import {
  ALL_LAYERS,
  getCameraLayers,
  getRenderLayers,
  layerMask,
  setCameraLayers,
  setRenderLayers,
  useLayerSource,
  withLayers,
} from '../dist/layers.js';

// Core engine on a fake WebGPU device (as origin.test.js): kernel, culling, frame graph and statistics are real.
async function engine(t) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    canvas = { width: 400, height: 200, clientWidth: 400, clientHeight: 200, getContext: () => context };
  const resource = (d) => Object.assign({ destroy() {} }, d);
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30, maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createBuffer: resource,
    createTexture: (d) => Object.assign(resource(d), { createView: () => ({}) }),
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        drawIndexed() {},
        setViewport() {},
        setScissorRect() {},
        end() {},
      }),
      finish: () => ({}),
    }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  const e = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 10], target: [0, 0, 0] },
  });
  t.after(() => {
    useLayerSource(null);
    e.dispose();
    for (const [key, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, key, d);
      else delete globalThis[key];
  });
  return e;
}
const part = (e, parent = null) =>
  e
    .createMesh(parent)
    .setGeometry(box(0.5, 0.5, 0.5))
    .setMaterial(new PbrMaterial());

test('masks: layerMask builds bits, meshes default to layer 0 and children inherit their nearest masked ancestor', async (t) => {
  const e = await engine(t),
    root = part(e),
    child = part(e, root),
    grandchild = part(e, child),
    other = part(e);
  assert.equal(layerMask(0, 2), 0b101);
  assert.equal(layerMask(31), 0x80000000);
  assert.throws(() => layerMask(32), RangeError);
  assert.equal(getRenderLayers(other), 1);
  setRenderLayers(root, 0b100);
  setRenderLayers(child, 0b10);
  assert.equal(getRenderLayers(root), 0b100);
  assert.equal(getRenderLayers(grandchild), 0b10, 'nearest ancestor with a mask');
  assert.equal(getRenderLayers(other), 1);
  assert.throws(() => setRenderLayers(other, -1), RangeError);
  assert.throws(() => setRenderLayers(other, 2 ** 32), RangeError);
  assert.throws(() => setRenderLayers(other, 1.5), RangeError);
  assert.equal(getCameraLayers(e.camera), ALL_LAYERS, 'a camera without a mask draws every layer');
  setCameraLayers(e.camera, ALL_LAYERS);
  assert.equal(getCameraLayers(e.camera), ALL_LAYERS);
  useLayerSource((mesh) => (mesh === other ? 8 : 1));
  assert.equal(getRenderLayers(other), 8, 'a source such as bvh getMeshLayers replaces the registry');
  useLayerSource(null);
  assert.throws(() => useLayerSource(5), TypeError);
});

test('withLayers hides meshes outside the mask and excluded meshes for the call only, also when it throws', async (t) => {
  const e = await engine(t),
    a = part(e),
    b = part(e),
    c = part(e),
    hidden = part(e);
  setRenderLayers(b, 0b10);
  hidden.visible = false;
  e.render();
  assert.equal(e.stats.visible, 3);
  const seen = withLayers(
    e,
    1,
    () => {
      e.render();
      return [a.visible, b.visible, c.visible, e.stats.visible];
    },
    [c],
  );
  assert.deepEqual(seen, [true, false, false, 1], 'b is off layer 0, c excluded');
  assert.deepEqual([a.visible, b.visible, c.visible, hidden.visible], [true, true, true, false], 'restored');
  assert.throws(() =>
    withLayers(e, 0b10, () => {
      assert.equal(a.visible, false);
      throw new Error('boom');
    }),
  );
  assert.equal(a.visible, true, 'restored after a throw');
  e.render();
  assert.equal(e.stats.visible, 3);
  assert.throws(() => withLayers(e, -2, () => 0), RangeError);
});

test('core draws each camera and view through its layer mask without touching visibility', async (t) => {
  const e = await engine(t),
    root = part(e),
    child = part(e, root),
    b = part(e);
  setRenderLayers(root, 0b10);
  e.render();
  assert.equal(e.stats.visible, 3, 'no camera mask: every layer');
  setCameraLayers(e.camera, 0b01);
  e.render();
  assert.equal(e.stats.visible, 1, 'the engine camera mask skips layer 1 (root and its child)');
  assert.deepEqual([root.visible, child.visible, b.visible], [true, true, true], 'nothing was hidden');
  setRenderLayers(child, 0b01);
  e.render();
  assert.equal(e.stats.visible, 2, 'a mask change re-collects on the next frame');
  const other = new Camera({ position: [0, 0, 10], target: [0, 0, 0] });
  setCameraLayers(other, 0b10);
  e.render({ views: [{ camera: other, viewport: [0, 0, 1, 1] }] });
  assert.equal(e.stats.visible, 1, 'a view follows its camera mask');
  e.render({ views: [{ camera: other, viewport: [0, 0, 1, 1], layers: ALL_LAYERS }] });
  assert.equal(e.stats.visible, 3, 'unless it sets its own layers');
  setCameraLayers(e.camera, ALL_LAYERS);
});

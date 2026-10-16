// X-ray (hidden-line) outlines on a mock device: core meshes through the renderer's draw hook, gltf-pro models through the replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Selection } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const objects = (h) => ({
  groups: h.counts.groups,
  buffers: h.counts.buffers,
  textures: h.counts.textures,
  views: h.counts.views,
  pipelines: h.pipelines.length,
});

test('x-ray marks the whole selection without the depth test, outlines it dashed before the visible outline, and toggles per set', () => {
  const h = optionalGPU(),
    mesh = { id: 2 },
    uploads = [],
    draws = [];
  h.engine.meshes.set(2, mesh);
  const write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, value) => {
    if (buffer.size === 32) uploads.push(Array.from(value));
    write(buffer, offset, value);
  };
  const selection = new Selection({ xray: true, width: 3 });
  h.engine.use(selection);
  selection.set([mesh]);
  h.context.draw = (options) => {
    if (options) draws.push({ pipeline: options.pipeline, bindings: options.bindings });
  };
  const frame = () => {
    draws.length = uploads.length = 0;
    const compute = h.counts.compute;
    h.frame();
    return h.counts.compute - compute;
  };
  const jfa = frame();
  assert.equal(draws.length, 2, 'whole-selection mask, then the visible mask');
  assert.equal(draws[0].pipeline.depthStencil.depthCompare, 'always');
  assert.equal(draws[0].pipeline.depthStencil.depthWriteEnabled, false);
  assert.match(
    draws[0].pipeline.fragment.module.code,
    /selected\[i\.id\]==0u\)\{discard;\}/,
    'unselected meshes must not erase the hidden mask',
  );
  assert.equal(draws[1].pipeline.depthStencil.depthCompare, 'equal', 'the visible mask is unchanged');
  assert.equal(draws[0].bindings, draws[1].bindings, 'both masks read the same selection flags');
  const composite = h.pipelines.find((p) => p.fragment?.module?.code?.includes('settings[0].w'));
  assert.equal(composite.fragment.targets[0].blend.color.srcFactor, 'src-alpha');
  assert.equal(composite.multisample.count, 4);
  assert.deepEqual(
    uploads.at(-1),
    [3, 0, 4, 0.85, 1, 0.5, 0, 0].map(Math.fround),
    'x-ray defaults: outline width, dash 4 px, opacity 0.85, outline color',
  );
  const stable = objects(h);
  for (let i = 0; i < 4; i++) assert.equal(frame(), jfa);
  assert.deepEqual(objects(h), stable, 'steady x-ray frames create no GPU objects');
  selection.options.xray = { dash: 0, opacity: 0.5, color: [0, 0, 1], width: 2 };
  frame();
  assert.deepEqual(uploads.at(-1), [2, 0, 0, 0.5, 0, 0, 1, 0], 'solid, dimmer hidden lines');
  selection.options.algorithm = 'morphological';
  assert.equal(frame(), 0, 'morphology needs no jump flood');
  assert.equal(draws.length, 2);
  selection.options.algorithm = 'jfa';
  selection.options.xray = false;
  assert.equal(frame(), jfa / 2, 'off: one jump flood');
  assert.equal(draws.length, 1);
  assert.equal(draws[0].pipeline.depthStencil.depthCompare, 'equal');
  for (const xray of [{ opacity: 2 }, { dash: -1 }, { width: 40 }, { color: [2, 0, 0] }, null]) {
    selection.options.xray = xray;
    assert.throws(() => h.frame(), /x-ray/);
  }
  selection.options.xray = true;
  h.context.width = 64;
  frame();
  assert.equal(draws.length, 2, 'resize rebuilds the x-ray pipelines');
  // A second selection set with its own style: one plugin per set.
  const hover = new Selection({ name: 'hover', color: [0, 1, 1] });
  h.engine.use(hover);
  assert.ok(h.engine.hasPlugin('hover') && h.engine.hasPlugin('selection'));
  assert.throws(() => new Selection({ name: '' }), /name/);
  selection.onDeviceRestored(h.engine);
  frame();
  assert.equal(draws.length, 2);
  h.engine.removePlugin('hover');
  selection.dispose();
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'dispose releases the x-ray buffers too',
  );
});

test('x-ray replays selected gltf-pro primitives without the depth test before the equal-depth mask', async () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    c = h.context,
    draws = [];
  device.queue.writeTexture = () => {};
  device.queue.copyExternalImageToTexture = () => {};
  device.queue.submit = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(256),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 6], target: [0, 0, 0], fov: 60 },
    null,
  );
  engine.camera.update(128 / 96, true);
  c.encoder.beginRenderPass = (descriptor) => ({
    descriptor,
    pipeline: null,
    setPipeline(p) {
      this.pipeline = p;
    },
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    draw() {},
    end() {},
    drawIndexed() {
      draws.push(this.pipeline);
    },
  });
  const data = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index = new Uint32Array([0, 1, 2, 0, 2, 3]),
    bytes = new Uint8Array(data.byteLength + index.byteLength);
  bytes.set(new Uint8Array(data.buffer));
  bytes.set(new Uint8Array(index.buffer), data.byteLength);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [
      { buffer: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ children: [1, 2] }, { mesh: 0, translation: [-2, 0, 0] }, { mesh: 0, translation: [2, 0, 0] }],
  };
  const model = new PBRModel(engine, new GLTFAsset(doc, [bytes]));
  engine.use(model);
  const selection = Selection.attach(engine, { xray: { dash: 6 } });
  c.camera = engine.camera;
  c.descriptor = { ...c.descriptor, depthStencil: { format: 'depth24plus-stencil8' } };
  const frame = () => {
    draws.length = 0;
    engine.store.tick(false);
    engine.frameGraph.execute(c);
    return draws.filter((p) => p?.fragment?.targets?.[0]?.format === 'r8unorm').map((p) => p.depthStencil.depthCompare);
  };
  selection.set([model]);
  assert.deepEqual(frame(), ['always', 'always', 'equal', 'equal'], 'both primitives: whole mask, then visible mask');
  const stable = objects(h);
  for (let i = 0; i < 3; i++) frame();
  assert.deepEqual(objects(h), stable, 'the x-ray model replay reuses its own draws and bind group');
  selection.options.xray = false;
  assert.deepEqual(frame(), ['equal', 'equal']);
  selection.dispose();
});

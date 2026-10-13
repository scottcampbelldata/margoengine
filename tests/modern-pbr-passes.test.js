import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF} from '../packages/gltf-pro/dist/index.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';
import {optionalGPU} from './support/optional-gpu.js';

async function scene() {
  const harness = optionalGPU(), device = harness.engine.gpu, store = await TransformStore.create(16);
  const renderer = {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(), primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = ['BLEND', 'MASK', 'BLEND', 'OPAQUE'].map(alphaMode => ({alphaMode, doubleSided: true}));
  fixture.doc.meshes = fixture.doc.materials.map((_, material) => ({primitives: [{...primitive, material}]}));
  fixture.doc.nodes = [{mesh: 0, translation: [0, 0, 1]}, {mesh: 1}, {mesh: 2, translation: [0, 0, -1]}, {mesh: 3}];
  delete fixture.doc.skins; delete fixture.doc.animations;
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(128 / 96, true); store.tick(false);
  const passes = [];
  let active;
  const encoder = {beginRenderPass(descriptor) {
    assert.equal(active, undefined, 'Nested render pass');
    const record = {descriptor, draws: [], ended: false}; passes.push(record); active = record;
    let pipeline, uniform, vertex, index;
    return {
      setPipeline(value) {pipeline = value;},
      setBindGroup(binding, group) {if (binding === 0) uniform = group.entries[0].resource.buffer;},
      setVertexBuffer(_, value) {vertex = value;}, setIndexBuffer(value) {index = value;},
      drawIndexed(count) {record.draws.push({pipeline, uniform, vertex, index, count, node: model.primitives.find(p => p.material.settings[0] === new Float32Array(uniform.data)[88] && p.node.matrix[14] === new Float32Array(uniform.data)[30])?.node});},
      end() {assert.equal(record.ended, false); record.ended = true; active = undefined;}
    };
  }};
  const context = {...harness.context, camera: engine.camera, encoder}, color = {}, depth = {};
  return {engine, model, context, color, depth, passes, resources: harness.resources};
}

test('PBR batches nonblended draws and retains transparent pass boundaries and primitive order', async () => {
  const {engine, model, context, color, depth, passes, resources} = await scene();
  try {
    for (const mode of ['beauty', 'gbuffer', 'ambient']) {
      const start = passes.length;
      model.draw(context, mode, color, depth);
      const rendered = passes.slice(start);
      assert.equal(rendered.length, mode === 'gbuffer' ? 1 : 3);
      for(const pass of rendered) {
        assert.equal(pass.ended, true);
        assert.equal(pass.descriptor.colorAttachments[0].view, color);
        assert.equal(pass.descriptor.depthStencilAttachment.view, depth);
      }
      assert.deepEqual(rendered.map(pass => pass.draws.length), mode === 'gbuffer' ? [4] : [2, 1, 1]);
      const draws = rendered.flatMap(pass => pass.draws);
      assert.deepEqual(draws.map(draw => draw.node), [model.nodes[1], model.nodes[3], model.nodes[2], model.nodes[0]]);
      assert.ok(draws.every(draw => draw.count === 3 && draw.vertex && draw.index));
      assert.equal(new Set(draws.map(draw => draw.uniform)).size, 4);
      for (const draw of draws) {
        assert.equal(draw.pipeline.multisample.count, 4);
        assert.equal(draw.pipeline.fragment.entryPoint, mode === 'beauty' ? 'fragment' : mode === 'gbuffer' ? 'gbuffer' : 'ambientFragment');
        assert.equal(draw.pipeline.depthStencil.depthCompare, mode === 'beauty' ? 'greater-equal' : 'equal');
        const blended = draw.node === model.nodes[0] || draw.node === model.nodes[2];
        assert.equal(!!draw.pipeline.fragment.targets[0].blend, blended && mode !== 'gbuffer');
        assert.equal(draw.pipeline.depthStencil.depthWriteEnabled, mode === 'beauty' && !blended);
      }
    }
    assert.equal(engine.stats.visible, 4);
    assert.equal(engine.stats.drawCalls, 4);
    model.root.visible = false;
    const before = passes.length; model.draw(context, 'beauty', color, depth);
    assert.equal(passes.length, before, 'Hidden hierarchy opened an empty pass');
  } finally {engine.dispose();}
  assert.ok(resources.every(resource => resource.destroyed));
});

test('PBR closes a partially encoded pass after an upload failure and remains usable', async () => {
  const {engine, model, context, color, depth, passes, resources} = await scene();
  const queue = engine.gpu.queue, write = queue.writeBuffer;
  let uploads = 0;
  const failure = new Error('GPU upload failed');
  queue.writeBuffer = (...args) => {if (++uploads === 2) throw failure; return write(...args);};
  try {
    assert.throws(() => model.draw(context, 'beauty', color, depth), error => error === failure);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].draws.length, 1);
    assert.equal(passes[0].ended, true);
    queue.writeBuffer = write;
    model.draw(context, 'beauty', color, depth);
    assert.equal(passes.length, 4);
    assert.equal(passes.slice(1).flatMap(pass => pass.draws).length, 4);
    assert.ok(passes.slice(1).every(pass => pass.ended));
  } finally {queue.writeBuffer = write; engine.dispose();}
  assert.ok(resources.every(resource => resource.destroyed));
});

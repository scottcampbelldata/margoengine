import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF} from '../packages/gltf-pro/dist/index.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';
import {optionalGPU} from './support/optional-gpu.js';

async function scene(materials = ['BLEND', 'MASK', 'BLEND', 'OPAQUE'].map(alphaMode => ({alphaMode, doubleSided: true}))) {
  const harness = optionalGPU(), device = harness.engine.gpu, store = await TransformStore.create(16);
  const renderer = {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(), primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = materials;
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
  return {engine, model, context, color, depth, passes, resources: harness.resources, pipelines: harness.pipelines};
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

test('PBR culls authored single-sided faces in every pass and reuses mirrored and double-sided variants', async () => {
  const {engine, model, context, color, depth, passes, resources, pipelines} = await scene([
    {alphaMode: 'BLEND'}, {alphaMode: 'MASK', doubleSided: false},
    {alphaMode: 'BLEND', doubleSided: true}, {alphaMode: 'OPAQUE'}
  ]);
  const draws = mode => {const start = passes.length; model.draw(context, mode, color, depth); return passes.slice(start).flatMap(pass => pass.draws);};
  try {
    model.nodes[1].scale.x = -1; model.nodes[2].scale.x = -1; engine.store.tick(false);
    assert.deepEqual(model.primitives.map(p => p.material.settings[2]), [0, 0, 1, 0], 'glTF omitted doubleSided defaults to false');
    for (const mode of ['beauty', 'gbuffer', 'ambient']) {
      const rendered = draws(mode);
      assert.deepEqual(rendered.map(draw => draw.pipeline.primitive.cullMode), ['front', 'back', 'none', 'back']);
      assert.ok(rendered.every(draw => (draw.pipeline.primitive.topology ?? 'triangle-list') === 'triangle-list'));
      assert.ok(rendered.every(draw => (draw.pipeline.primitive.frontFace ?? 'ccw') === 'ccw'));
      assert.deepEqual(rendered.map(draw => new Float32Array(draw.uniform.data)[97]), [-1, 1, -1, 1]);
      for (const draw of rendered) {
        const blend = draw.node === model.nodes[0] || draw.node === model.nodes[2];
        assert.equal(!!draw.pipeline.fragment.targets[0].blend, blend && mode !== 'gbuffer');
        assert.equal(draw.pipeline.depthStencil.depthWriteEnabled, mode === 'beauty' && !blend);
      }
    }
    const initial = pipelines.length;
    for (let i = 0; i < 120; i++) draws('beauty');
    assert.equal(pipelines.length, initial, 'Steady rendering must reuse cached raster variants');
    model.primitives[1].material.settings[2] = 1;
    assert.equal(draws('beauty')[0].pipeline.primitive.cullMode, 'none');
    assert.equal(pipelines.length, initial + 1, 'New material sidedness needs its own nonblended variant');
    model.primitives[1].material.settings[2] = 0; model.nodes[1].scale.x = 1; engine.store.tick(false);
    assert.equal(draws('beauty')[0].pipeline.primitive.cullMode, 'back');
    model.nodes[1].scale.x = -1; engine.store.tick(false);
    assert.equal(draws('beauty')[0].pipeline.primitive.cullMode, 'front');
    // MASK alpha-tests (margoAlphaTest constant), so its back-culled variant is its own, not the OPAQUE primitive's.
    assert.equal(pipelines.length, initial + 2, 'Changing determinant or restoring sidedness must reuse existing variants');
    assert.deepEqual(pipelines.slice(-2).map(p => p.fragment.constants), [{margoFaceTest: 0, margoAlphaTest: 1}, {margoFaceTest: 0, margoAlphaTest: 1}]);
    const local = engine.gpu.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM});
    model.addLighting({shader: source => '@group(2) @binding(4) var<uniform> local:vec4f;\n' + source.replace('direct+ambient(s)', 'direct*local.x+ambient(s)'), bindings: () => [{binding: 4, resource: {buffer: local}}]});
    const beforeLighting = pipelines.length, lit = draws('beauty');
    assert.equal(pipelines.length, beforeLighting + 4, 'Each active raster variant must compile its changed lighting shader');
    assert.deepEqual(lit.map(draw => draw.pipeline.primitive.cullMode), ['front', 'back', 'none', 'back']);
    const afterLighting = pipelines.length; draws('beauty'); assert.equal(pipelines.length, afterLighting);
    model.onDeviceRestored(engine); const restored = draws('beauty');
    assert.equal(pipelines.length, afterLighting + 4, 'Restoration must rebuild device-owned raster variants');
    assert.deepEqual(restored.map(draw => draw.pipeline.primitive.cullMode), ['front', 'back', 'none', 'back']);
    local.destroy();
  } finally {engine.dispose();}
  assert.ok(resources.every(resource => resource.destroyed));
});

test('material renderState overrides only beauty pipelines, keys the cache and leaves other materials untouched', async () => {
  const {engine, model, context, color, depth, passes, pipelines} = await scene();
  const draws = mode => {const start = passes.length; model.draw(context, mode, color, depth); return new Map(passes.slice(start).flatMap(pass => pass.draws).map(draw => [draw.node, draw.pipeline]));};
  try {
    const plain = draws('beauty'), initial = pipelines.length;
    const [blend, , , opaque] = model.primitives.map(p => p.material), additive = {color: {srcFactor: 'one', dstFactor: 'one'}, alpha: {srcFactor: 'one', dstFactor: 'one'}};
    blend.renderState = {blend: null, depthWrite: true}; opaque.renderState = {blend: additive, depthCompare: 'always'};
    const custom = draws('beauty');
    assert.equal(pipelines.length, initial + 2, 'renderState is part of the pipeline key');
    const a = custom.get(model.nodes[0]), b = custom.get(model.nodes[3]);
    assert.equal(a.fragment.targets[0].blend, undefined, 'blend: null turns blending off'); assert.equal(a.depthStencil.depthWriteEnabled, true); assert.equal(a.depthStencil.depthCompare, 'greater-equal');
    assert.deepEqual(b.fragment.targets[0].blend, additive); assert.equal(b.depthStencil.depthCompare, 'always'); assert.equal(b.depthStencil.depthWriteEnabled, true);
    for (const node of [model.nodes[1], model.nodes[2]]) assert.equal(custom.get(node), plain.get(node), 'other materials keep their pipelines');
    for (const mode of ['gbuffer', 'ambient']) for (const pipeline of draws(mode).values()) assert.equal(pipeline.depthStencil.depthCompare, 'equal', `${mode} ignores renderState`);
    delete blend.renderState; delete opaque.renderState; const after = pipelines.length, restored = draws('beauty');
    assert.equal(pipelines.length, after, 'without renderState the default pipelines are reused');
    for (const node of model.nodes) assert.equal(restored.get(node), plain.get(node));
  } finally {engine.dispose();}
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../packages/dof/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { TAA } from '../packages/taa/dist/index.js';
import { SSAO, Bloom } from '../packages/post/dist/index.js';
import { Transitions } from '../packages/transitions/dist/index.js';
import { Sky } from '../packages/sky/dist/index.js';
import { optionalGPU } from './support/optional-gpu.js';
import { wgsl } from '../packages/core/src/shaders.ts';

function harness() {
  const h = optionalGPU(),
    c = h.context;
  h.engine.stats = { drawCalls: 0 };
  h.engine.store.visible = new Uint8Array(16);
  c.shader = wgsl;
  c.bindings = [];
  c.descriptor = {
    ...c.descriptor,
    vertex: { entryPoint: 'vertex', buffers: [] },
    fragment: { entryPoint: 'fragment' },
  };
  const originalColor = c.color,
    originalDepth = c.depth,
    originalDescriptor = c.descriptor;
  const passes = [],
    begin = c.encoder.beginRenderPass;
  c.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    let current;
    return {
      ...pass,
      setPipeline(pipeline) {
        current = pipeline;
        passes.push({ pipeline, descriptor });
        const samples = pipeline.multisample?.count ?? 1;
        for (const attachment of descriptor.colorAttachments ?? [])
          if (attachment?.view?.texture)
            assert.equal(attachment.view.texture.sampleCount, samples, 'Color attachment sample count');
        if (descriptor.depthStencilAttachment?.view?.texture) {
          const texture = descriptor.depthStencilAttachment.view.texture;
          assert.equal(texture.sampleCount, samples, 'Depth attachment sample count');
          assert.equal(texture.format, pipeline.depthStencil?.format, 'Depth attachment format');
        }
      },
      setBindGroup(_index, group) {
        if (group.layout.pipeline) assert.equal(group.layout.pipeline, current, 'Bind group auto-layout pipeline');
      },
    };
  };
  const frame = () => {
    c.color = originalColor;
    c.depth = originalDepth;
    c.format = 'bgra8unorm';
    c.shader = wgsl;
    c.bindings = [];
    h.engine.frameGraph.execute(c);
    assert.equal(c.color, originalColor);
    assert.equal(c.depth, originalDepth);
  };
  return { ...h, passes, frame, originalDescriptor };
}

for (const [name, Effect] of [
  ['DOF', DOF],
  ['Tonemap', Tonemap],
  ['TAA', TAA],
  ['SSAO', SSAO],
  ['Bloom', Bloom],
  ['Transitions', Transitions],
])
  test(name + ' rebuilds same-size captures for MSAA/depth changes and retains stable resources', () => {
    const h = harness(),
      effect = new Effect();
    try {
      h.engine.use(effect);
      h.frame();
      const initial = { ...h.counts };
      for (let i = 0; i < 120; i++) h.frame();
      for (const key of ['buffers', 'textures', 'views', 'groups'])
        assert.equal(h.counts[key], initial[key], key + ' during stable frames');
      h.context.descriptor = { ...h.originalDescriptor, multisample: { count: 1 } };
      h.frame();
      const mobile = { ...h.counts };
      assert.ok(mobile.textures > initial.textures);
      h.frame();
      for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], mobile[key]);
      h.context.descriptor = { ...h.context.descriptor, depthStencil: { format: 'depth24plus-stencil8' } };
      h.frame();
      const stencil = { ...h.counts };
      assert.ok(stencil.textures > mobile.textures);
      h.frame();
      for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], stencil[key]);
      h.context.descriptor = h.originalDescriptor;
      h.frame();
      const restored = { ...h.counts };
      h.frame();
      assert.equal(h.counts.groups, restored.groups);
      effect.onDeviceRestored(h.engine);
      h.frame();
    } finally {
      effect.dispose();
      assert.ok(
        h.resources.every((resource) => resource.destroyed),
        'Owned resources survive disposal',
      );
    }
  });

test('TAA motion draw groups follow changed pipelines through MSAA and depth transitions', () => {
  const h = harness(),
    device = h.engine.gpu,
    create = device.createRenderPipeline;
  device.createRenderPipeline = (...args) => {
    const pipeline = create(...args);
    pipeline.getBindGroupLayout = (index) => ({ pipeline, index });
    return pipeline;
  };
  const vertex = device.createBuffer({ size: 72, usage: GPUBufferUsage.VERTEX }),
    index = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX });
  const node = {
    id: 0,
    engine: h.engine,
    geometry: { indices: new Uint32Array([0, 1, 2]) },
    matrix: h.context.camera.matrix.slice(),
    check() {},
  };
  h.engine.meshes.set(0, node);
  h.engine.store.visible[0] = 1;
  h.engine.geometryBuffers = () => ({ vertex, index });
  const taa = new TAA();
  try {
    h.engine.use(taa);
    h.frame();
    h.frame();
    h.context.descriptor = { ...h.originalDescriptor, multisample: { count: 1 } };
    h.frame();
    h.context.descriptor = { ...h.context.descriptor, depthStencil: { format: 'depth24plus' } };
    h.frame();
    h.context.descriptor = h.originalDescriptor;
    h.frame();
    const counts = { ...h.counts };
    for (let i = 0; i < 120; i++) h.frame();
    for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], counts[key]);
  } finally {
    taa.dispose();
    vertex.destroy();
    index.destroy();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

test('Sky rebuilds its depth pipeline without rebuilding atmosphere tables', () => {
  const h = harness(),
    sky = new Sky({ timeScale: 0 });
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.1]) };
  try {
    h.engine.use(sky);
    sky.onPreUpdate(0);
    h.frame();
    const initial = { ...h.counts },
      pipeline = h.passes.at(-1).pipeline;
    h.context.descriptor = { ...h.originalDescriptor, depthStencil: { format: 'depth24plus' } };
    h.frame();
    assert.notEqual(h.passes.at(-1).pipeline, pipeline);
    assert.equal(h.passes.at(-1).pipeline.depthStencil.format, 'depth24plus');
    for (const key of ['buffers', 'textures']) assert.equal(h.counts[key], initial[key]);
    const current = { ...h.counts };
    h.frame();
    for (const key of ['buffers', 'textures', 'groups']) assert.equal(h.counts[key], current[key]);
    sky.onDeviceRestored(h.engine);
    h.frame();
  } finally {
    sky.dispose();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

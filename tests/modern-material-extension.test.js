import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
// Degenerate tangent frames use a finite orthogonal basis; ordinary UV paths retain this shared shader.
const baselineShader = '45df766b2c73181edc3cbd8109a848f17851f03b7cc947dec8d987ff60c2dee5';
// The missing normal-map factor is zero; Camera.up-aware view math also preserves its signed-zero lanes.
const baselineFrame = '0abd32314fbc275319398c26b44726992318ed9a3dce2870d43ae10efa40bf01';

async function scene(primitiveCount = 1) {
  const harness = optionalGPU(),
    store = await TransformStore.create(16),
    device = harness.engine.gpu;
  const samplers = [],
    createSampler = device.createSampler;
  device.createSampler = (descriptor) => {
    samplers.push(descriptor);
    return createSampler(descriptor);
  };
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle();
  if (primitiveCount > 1)
    fixture.doc.meshes[0].primitives = Array.from({ length: primitiveCount }, () => ({
      ...fixture.doc.meshes[0].primitives[0],
    }));
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  assert.ok(!(model instanceof Promise), 'The baseline parser stays synchronous');
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const draws = [],
    uploads = [],
    queueWrite = device.queue.writeBuffer;
  device.queue.writeBuffer = (buffer, offset, values) => {
    uploads.push({
      buffer,
      offset,
      bytes: new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice(),
    });
    return queueWrite(buffer, offset, values);
  };
  const context = {
    ...harness.context,
    camera: engine.camera,
    encoder: {
      beginRenderPass() {
        let pipeline;
        const groups = new Map();
        return {
          setPipeline(value) {
            pipeline = value;
            groups.clear();
          },
          setBindGroup(index, group) {
            groups.set(index, group);
          },
          setVertexBuffer() {},
          setIndexBuffer() {},
          drawIndexed(count) {
            draws.push({ pipeline, groups: new Map(groups), count });
          },
          end() {},
        };
      },
    },
  };
  return {
    ...harness,
    device,
    engine,
    model,
    context,
    draws,
    uploads,
    samplers,
    draw(mode = 'beauty') {
      model.draw(context, mode, context.color, context.depth);
    },
  };
}

test('unextended PBR retains the exact baseline shader, frame bytes, pipeline and bindings', async () => {
  const s = await scene();
  try {
    assert.deepEqual(
      s.resources.filter((resource) => resource.data).map((buffer) => buffer.size),
      [240, 12, 400],
    );
    assert.equal(s.counts.textures, 5);
    for (const mode of ['beauty', 'gbuffer', 'ambient']) {
      const before = s.uploads.length;
      s.draw(mode);
      const draw = s.draws.at(-1),
        pipeline = draw.pipeline,
        frame = draw.groups.get(0).entries[0].resource.buffer;
      assert.equal(digest(pipeline.vertex.module.code), baselineShader);
      assert.equal(digest(new Uint8Array(frame.data)), baselineFrame);
      const priorNormalFactor = new Float32Array(frame.data.slice(0));
      assert.equal(priorNormalFactor[82], 0);
      priorNormalFactor[82] = 1;
      assert.equal(
        digest(new Uint8Array(priorNormalFactor.buffer)),
        '4cb2947198324e7f284d979fc29c0930898f8bd11408b656a9d44cfdf1aee2a0',
        'Only the absent normal-map factor changes from the preceding frame baseline',
      );
      assert.equal(s.uploads.length, before + 1, 'Only the packed frame is uploaded');
      assert.deepEqual([...draw.groups.keys()], [0, 1]);
      assert.deepEqual(
        draw.groups.get(0).entries.map((entry) => entry.binding),
        [0],
      );
      assert.deepEqual(
        draw.groups.get(1).entries.map((entry) => entry.binding),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
      assert.equal(pipeline.layout, 'auto');
      assert.deepEqual(pipeline.vertex.buffers, [
        {
          arrayStride: 80,
          attributes: Array.from({ length: 5 }, (_, i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })),
        },
      ]);
      assert.equal(pipeline.vertex.entryPoint, 'vertex');
      assert.equal(pipeline.fragment.module, pipeline.vertex.module);
      assert.equal(
        pipeline.fragment.entryPoint,
        mode === 'beauty' ? 'fragment' : mode === 'gbuffer' ? 'gbuffer' : 'ambientFragment',
      );
      assert.deepEqual(pipeline.fragment.targets, [
        { format: mode === 'beauty' ? 'bgra8unorm' : 'rgba16float', blend: undefined },
      ]);
      assert.deepEqual(pipeline.multisample, { count: 4 });
      assert.deepEqual(pipeline.primitive, { topology: 'triangle-list', cullMode: 'none' });
      assert.deepEqual(pipeline.depthStencil, {
        format: 'depth32float',
        depthWriteEnabled: mode === 'beauty',
        depthCompare: mode === 'beauty' ? 'greater-equal' : 'equal',
      });
      assert.equal(draw.count, 3);
    }
    assert.equal(s.counts.buffers, 3);
    assert.equal(s.counts.groups, 6);
    assert.equal(s.counts.textures, 5);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('material factors and optional sampled textures occupy group 3 only on extended primitives', async () => {
  const s = await scene(2),
    factors = new Float32Array([0.25, 0.5, 0.75, 1, 2, 3, 4, 5]);
  const view = { external: 'sampled' },
    unsampledView = { external: 'loaded' },
    sampler = { external: 'sampler' };
  s.model.primitives[0].extension = {
    factors,
    textures: [{ view, sampler }, { view: unsampledView }],
    wgsl: 's.base=vec4f(s.base.rgb*materialFactors[0].xyz,s.base.a);',
  };
  try {
    const buffers = s.counts.buffers,
      samplers = s.samplers.length;
    s.draw();
    const [extended, plain] = s.draws,
      code = extended.pipeline.vertex.module.code;
    assert.notEqual(extended.pipeline, plain.pipeline);
    assert.equal(digest(plain.pipeline.vertex.module.code), baselineShader);
    assert.match(code, /@group\(3\)\s*@binding\(0\)\s*var<uniform>\s+materialFactors\s*:\s*array<vec4f,\s*2>/);
    assert.match(code, /@group\(3\)\s*@binding\(1\)\s*var\s+materialTexture0\s*:\s*texture_2d<f32>/);
    assert.match(code, /@group\(3\)\s*@binding\(2\)\s*var\s+materialSampler0\s*:\s*sampler/);
    assert.match(code, /@group\(3\)\s*@binding\(3\)\s*var\s+materialTexture1\s*:\s*texture_2d<f32>/);
    assert.doesNotMatch(code, /materialSampler1/);
    assert.equal(
      code.split('s.base=vec4f(s.base.rgb*materialFactors[0].xyz,s.base.a);').length - 1,
      3,
      'All surface consumers apply the extension',
    );
    assert.deepEqual([...extended.groups.keys()], [0, 1, 2, 3]);
    assert.deepEqual(extended.groups.get(2).entries, [], 'Group 2 stays reserved for lighting');
    assert.deepEqual([...plain.groups.keys()], [0, 1]);
    const entries = extended.groups.get(3).entries,
      buffer = entries[0].resource.buffer;
    assert.deepEqual(
      entries.map((entry) => entry.binding),
      [0, 1, 2, 3],
    );
    assert.equal(entries[1].resource, view);
    assert.equal(entries[2].resource, sampler);
    assert.equal(entries[3].resource, unsampledView);
    assert.equal(buffer.size, factors.byteLength);
    assert.deepEqual([...new Float32Array(buffer.data)], [...factors]);
    assert.equal(s.counts.buffers, buffers + 1);
    assert.equal(s.counts.textures, 5, 'Extensions use caller views without allocating a texture');
    assert.equal(s.samplers.length, samplers, 'Only the baseline material and mip samplers are created');
    const pipelineCount = s.pipelines.length,
      groupCount = s.counts.groups;
    factors[0] = 0.875;
    s.draw();
    assert.equal(new Float32Array(buffer.data)[0], 0.875);
    assert.equal(s.pipelines.length, pipelineCount);
    assert.equal(s.counts.groups, groupCount);
    assert.deepEqual(
      s.uploads.filter((upload) => upload.buffer === buffer).map((upload) => upload.bytes.byteLength),
      [32, 32],
    );
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('extension identity and complete WGSL signatures separate pipelines while factors remain uniforms', async () => {
  const s = await scene(5),
    first = { wgsl: 's.base=vec4f(s.base.rgb*0.5,s.base.a);' },
    second = { wgsl: 's.base=vec4f(s.base.rgb*0.25,s.base.a);' };
  s.model.primitives[1].extension = {};
  s.model.primitives[2].extension = first;
  s.model.primitives[3].extension = { ...first };
  s.model.primitives[4].extension = second;
  try {
    const buffers = s.counts.buffers;
    s.draw();
    const pipelines = s.draws.map((draw) => draw.pipeline);
    assert.equal(new Set(pipelines).size, 4);
    assert.equal(pipelines[2], pipelines[3], 'Identical WGSL can share a pipeline');
    assert.notEqual(pipelines[0], pipelines[1], 'An empty extension still cannot share the baseline pipeline');
    assert.equal(digest(pipelines[0].vertex.module.code), baselineShader);
    assert.ok(
      s.draws.every((draw) => !draw.groups.has(2) && !draw.groups.has(3)),
      'Shader-only extensions have no secondary bindings',
    );
    assert.equal(s.counts.buffers, buffers);
    first.wgsl = 's.base=vec4f(s.base.rgb*0.75,s.base.a);';
    s.draw();
    assert.equal(s.pipelines.length, 5, 'Editing the injection changes the pipeline key');
    assert.notEqual(s.draws[7].pipeline, pipelines[2]);
    first.declarations = 'fn extensionGain()->f32{return 0.75;}';
    s.draw();
    assert.equal(s.pipelines.length, 6, 'Editing helper declarations changes the pipeline key');
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('extensions coexist with lighting in its permanent group 2 allocation', async () => {
  const s = await scene(2),
    lightingBuffer = s.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  const groups = [],
    effect = {
      shader(source, group) {
        groups.push(group);
        return (
          `@group(${group}) @binding(4) var<uniform> extraLight:vec4f;\n` +
          source.replace('direct+ambient(s)', 'direct*extraLight.x+ambient(s)')
        );
      },
      bindings() {
        return [{ binding: 4, resource: { buffer: lightingBuffer } }];
      },
    };
  s.model.addLighting(effect);
  s.model.primitives[0].extension = { factors: new Float32Array([1, 2, 3, 4]) };
  try {
    s.draw();
    const [extended, plain] = s.draws;
    assert.deepEqual(groups, [2, 2]);
    for (const draw of [extended, plain]) {
      assert.match(draw.pipeline.vertex.module.code, /@group\(2\) @binding\(4\) var<uniform> extraLight/);
      assert.equal(draw.groups.get(2).entries[0].resource.buffer, lightingBuffer);
    }
    assert.deepEqual([...extended.groups.keys()], [0, 1, 2, 3]);
    assert.deepEqual([...plain.groups.keys()], [0, 1, 2]);
    assert.notEqual(extended.pipeline, plain.pipeline);
    s.draw('gbuffer');
    assert.equal(groups.length, 2, 'Lighting does not enter g-buffer passes');
    assert.deepEqual(s.draws[2].groups.get(2).entries, []);
    assert.deepEqual([...s.draws[3].groups.keys()], [0, 1]);
  } finally {
    s.engine.dispose();
    lightingBuffer.destroy();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('removing an empty lighting effect still binds the group 2 auto-layout gap', async () => {
  const s = await scene(),
    remove = s.model.addLighting({
      shader(source) {
        return source;
      },
      bindings() {
        return [];
      },
    });
  s.model.primitives[0].extension = { factors: new Float32Array([1, 2, 3, 4]) };
  try {
    s.draw();
    const pipeline = s.draws[0].pipeline;
    remove();
    s.draw();
    assert.equal(s.draws[1].pipeline, pipeline, 'An empty lighting hook has an identical shader signature');
    assert.deepEqual([...s.draws[1].groups.keys()], [0, 1, 2, 3]);
    assert.deepEqual(s.draws[1].groups.get(2).entries, []);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('material defaults, primitive overrides, replacement and removal manage only owned factor buffers', async () => {
  const s = await scene(2),
    material = s.model.primitives[0].material;
  const texture = s.device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const shared = { factors: new Float32Array([1, 2, 3, 4]), textures: [{ view: texture.createView() }] };
  const override = { factors: new Float32Array([5, 6, 7, 8]) };
  material.extension = shared;
  s.model.primitives[0].extension = override;
  try {
    s.draw();
    const first = s.draws[0].groups.get(3).entries[0].resource.buffer,
      second = s.draws[1].groups.get(3).entries[0].resource.buffer;
    assert.deepEqual([...new Float32Array(first.data)], [5, 6, 7, 8]);
    assert.deepEqual([...new Float32Array(second.data)], [1, 2, 3, 4]);
    override.factors = new Float32Array([9, 8, 7, 6, 5, 4, 3, 2]);
    s.draw();
    const resized = s.draws[2].groups.get(3).entries[0].resource.buffer;
    assert.equal(first.destroyed, true);
    assert.equal(resized.size, 32);
    assert.deepEqual([...new Float32Array(resized.data)], [...override.factors]);
    delete s.model.primitives[0].extension;
    s.draw();
    assert.equal(resized.destroyed, true);
    assert.deepEqual([...new Float32Array(s.draws[4].groups.get(3).entries[0].resource.buffer.data)], [1, 2, 3, 4]);
    const inherited = s.draws[4].groups.get(3).entries[0].resource.buffer;
    delete material.extension;
    s.draw();
    assert.equal(inherited.destroyed, true);
    assert.equal(second.destroyed, true);
    for (const draw of s.draws.slice(-2)) {
      assert.deepEqual([...draw.groups.keys()], [0, 1]);
      assert.equal(digest(draw.pipeline.vertex.module.code), baselineShader);
    }
    assert.equal(texture.destroyed, false, 'Caller textures are externally owned');
  } finally {
    s.engine.dispose();
    texture.destroy();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('texture view changes rebuild their bind group and sampler shape changes key the pipeline', async () => {
  const s = await scene(),
    binding = { view: { id: 1 } },
    extension = { textures: [binding] };
  s.model.primitives[0].extension = extension;
  try {
    s.draw();
    const initial = s.draws[0],
      groups = s.counts.groups,
      pipelines = s.pipelines.length;
    binding.view = { id: 2 };
    s.draw();
    assert.equal(s.pipelines.length, pipelines);
    assert.equal(s.draws[1].pipeline, initial.pipeline);
    assert.notEqual(s.draws[1].groups.get(3), initial.groups.get(3));
    assert.equal(s.draws[1].groups.get(3).entries[0].resource, binding.view);
    assert.ok(s.counts.groups > groups);
    const stableGroups = s.counts.groups;
    s.draw();
    assert.equal(s.counts.groups, stableGroups, 'Unchanged extension bindings are reused');
    binding.sampler = { id: 3 };
    s.draw();
    assert.equal(s.pipelines.length, pipelines + 1);
    assert.notEqual(s.draws[3].pipeline, initial.pipeline);
    assert.deepEqual(
      s.draws[3].groups.get(3).entries.map((entry) => entry.binding),
      [1, 2],
    );
    assert.equal(s.draws[3].groups.get(3).entries[1].resource, binding.sampler);
    assert.equal(
      s.resources.filter((resource) => resource.data).length,
      3,
      'Texture-only extensions allocate no factor buffer',
    );
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('restoring the device releases and recreates extension uniforms and disposal frees them', async () => {
  const s = await scene(),
    extension = { factors: new Float32Array([0.1, 0.2, 0.3, 0.4]) };
  s.model.primitives[0].extension = extension;
  try {
    s.draw();
    const old = s.draws[0].groups.get(3).entries[0].resource.buffer;
    s.model.onDeviceRestored(s.engine);
    assert.equal(old.destroyed, true);
    s.draw();
    const restored = s.draws[1].groups.get(3).entries[0].resource.buffer;
    assert.notEqual(restored, old);
    assert.deepEqual([...new Float32Array(restored.data)], [...extension.factors]);
    s.model.dispose();
    assert.equal(restored.destroyed, true);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('invalid or oversized extension factors fail before allocating their secondary uniform', async () => {
  const s = await scene();
  try {
    for (const factors of [
      new Float32Array(3),
      new Float32Array([1, 2, 3, NaN]),
      new Float32Array([1, 2, 3, Infinity]),
      [1, 2, 3, 4],
    ]) {
      s.model.primitives[0].extension = { factors };
      const before = s.counts.buffers;
      assert.throws(() => s.draw(), /extension|factor|vec4|uniform/i);
      assert.equal(s.counts.buffers, before);
    }
    s.device.limits.maxUniformBufferBindingSize = 16;
    s.model.primitives[0].extension = { factors: new Float32Array(8) };
    const before = s.counts.buffers;
    assert.throws(() => s.draw(), /extension|factor|uniform|limit/i);
    assert.equal(s.counts.buffers, before);
    delete s.model.primitives[0].extension;
    s.draw();
    assert.equal(digest(s.draws.at(-1).pipeline.vertex.module.code), baselineShader);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('failed extension uniform uploads release new allocations and allow a later draw to recover', async () => {
  const s = await scene(),
    queueWrite = s.device.queue.writeBuffer,
    failure = new Error('Extension upload failed');
  const extension = { factors: new Float32Array([1, 2, 3, 4]) };
  s.model.primitives[0].extension = extension;
  try {
    s.device.queue.writeBuffer = (buffer, ...args) => {
      if (buffer.size === 16) throw failure;
      return queueWrite(buffer, ...args);
    };
    assert.throws(
      () => s.draw(),
      (error) => error === failure,
    );
    assert.equal(s.resources.at(-1).destroyed, true, 'An untracked new secondary uniform cannot leak');
    s.device.queue.writeBuffer = queueWrite;
    s.draw();
    const first = s.draws[0].groups.get(3).entries[0].resource.buffer;
    assert.deepEqual([...new Float32Array(first.data)], [1, 2, 3, 4]);
    extension.factors = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    s.device.queue.writeBuffer = (buffer, ...args) => {
      if (buffer.size === 32) throw failure;
      return queueWrite(buffer, ...args);
    };
    assert.throws(
      () => s.draw(),
      (error) => error === failure,
    );
    s.device.queue.writeBuffer = queueWrite;
    s.draw();
    const recovered = s.draws[1].groups.get(3).entries[0].resource.buffer;
    assert.equal(first.destroyed, true);
    assert.deepEqual([...new Float32Array(recovered.data)], [...extension.factors]);
  } finally {
    s.device.queue.writeBuffer = queueWrite;
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('ambient hooks affect beauty and ambient passes after lighting without rewriting caller helpers', async () => {
  const s = await scene(),
    helper = 'fn callerColor()->f32{var color=0.5;return color;}';
  s.model.primitives[0].extension = {
    declarations: helper,
    factors: new Float32Array([0.5, 0, 0, 0]),
    ambient: 'materialAmbient*=materialFactors[0].x;',
  };
  s.model.addLighting({
    shader(code) {
      assert.ok(code.includes('direct+ambient(s)'));
      return code.replace('direct+ambient(s)', 'direct*0.75+ambient(s)');
    },
    bindings() {
      return [];
    },
  });
  try {
    for (const mode of ['beauty', 'gbuffer', 'ambient']) {
      s.draw(mode);
      const code = s.draws.at(-1).pipeline.vertex.module.code;
      assert.ok(code.includes(helper));
      assert.equal(code.split('materialAmbient*=materialFactors[0].x;').length - 1, 2);
      assert.match(code, /return vec4f\(materialAmbient,/);
      if (mode === 'beauty') assert.match(code, /direct\*0\.75\+materialAmbient\+s.emissive/);
    }
    for (const ambient of [false, 3, {}, null]) {
      s.model.primitives[0].extension = { ambient };
      assert.throws(() => s.draw(), /extension WGSL/);
    }
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

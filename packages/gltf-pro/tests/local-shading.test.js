import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF, PBRModel, textureTransform } from '../dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function fixture(count = 2) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    data = animatedTriangle(),
    primitive = data.doc.meshes[0].primitives[0];
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  data.doc.materials = Array.from({ length: count }, () => ({ doubleSided: true }));
  data.doc.meshes[0].primitives = Array.from({ length: count }, (_, material) => ({ ...primitive, material }));
  const model = parseGLTF(engine, data.doc, data.buffers),
    context = { ...gpu.context, camera: engine.camera },
    draws = [];
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const pass = () => {
    let pipeline;
    const groups = [];
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup(index, value) {
        groups[index] = value;
      },
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed(count, instances = 1) {
        draws.push({ pipeline, groups: groups.slice(), count, instances });
      },
      end() {},
    };
  };
  context.encoder.beginRenderPass = pass;
  return {
    ...gpu,
    engine,
    device,
    model,
    context,
    draws,
    pass,
    frame(mode = 'beauty', phase = 'all') {
      model.draw(context, mode, context.color, context.depth, phase);
    },
  };
}

function shading(buffer) {
  const resource = { buffer, offset: 0, size: 16 };
  return {
    resource,
    shader(source, group) {
      return (
        `@group(${group}) @binding(32) var<uniform> localShade:vec4f;\n` +
        source.replace('s.base=textureSample', 's.base=localShade*textureSample')
      );
    },
    bindings() {
      return [{ binding: 32, resource }];
    },
  };
}

test('each primitive retains local shading and bindings before model lighting, including after restoration', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const a = f.device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM }),
    b = f.device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM }),
    scene = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM }),
    first = shading(a),
    second = shading(b);
  t.after(() => {
    a.destroy();
    b.destroy();
    scene.destroy();
  });
  f.model.primitives[0].material.shading = first;
  f.model.primitives[1].material.shading = second;
  f.model.addLighting({
    shader(source, group) {
      assert.match(source, /s\.base=localShade\*textureSample/);
      return (
        `@group(${group}) @binding(4) var<uniform> sceneShade:vec4f;\n` +
        source.replace('direct+ambient(s)', 'direct*sceneShade.x+ambient(s)')
      );
    },
    bindings() {
      return [{ binding: 4, resource: { buffer: scene } }];
    },
  });
  f.frame();
  assert.equal(f.draws.length, 2);
  assert.equal(f.draws[0].pipeline, f.draws[1].pipeline, 'Equal shader text may share a pipeline');
  assert.deepEqual(
    f.draws.map((d) => d.groups[2].entries.map((entry) => entry.resource.buffer)),
    [
      [a, scene],
      [b, scene],
    ],
  );
  const pipelines = f.pipelines.length;
  first.resource.offset = 256;
  f.frame();
  assert.equal(f.draws.at(-2).groups[2].entries[0].resource.offset, 256);
  assert.equal(f.pipelines.length, pipelines, 'A binding change must not recompile material shaders');
  assert.equal(f.draws[0].groups[2].entries[0].resource.offset, 0, 'Cached binding snapshots stay immutable');
  f.model.onDeviceRestored(f.engine);
  f.frame();
  assert.deepEqual(
    f.draws.slice(-2).map((d) => d.groups[2].entries[0].resource.buffer),
    [a, b],
  );
});

test('local shading supplies surface bindings to gbuffer, ambient replay and capture', async (t) => {
  const f = await fixture(1);
  t.after(() => f.engine.dispose());
  const buffer = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  f.model.primitives[0].material.shading = shading(buffer);
  f.frame('gbuffer');
  f.frame('ambient');
  f.model.addLighting({ pbr: () => ({ declarations: '', ambient: 's.base.rgb*0.25' }), bindings: () => [] });
  f.frame('ambient');
  f.model.setCapture({ declarations: () => '', targets: [{ format: 'rgba16float' }], begin: f.pass });
  f.frame('capture');
  assert.deepEqual(
    f.draws.map((d) => d.pipeline.fragment.entryPoint),
    ['gbuffer', 'ambientFragment', 'fragment', 'capture'],
  );
  for (const draw of f.draws) {
    assert.match(draw.pipeline.fragment.module.code, /s\.base=localShade\*textureSample/);
    assert.equal(draw.groups[2].entries[0].resource.buffer, buffer);
  }
});

test('extension group 3 never overwrites local shading group 2 when scene lighting is disabled', async (t) => {
  const f = await fixture(1);
  t.after(() => f.engine.dispose());
  const buffer = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  Object.assign(f.model.primitives[0].material, {
    shading: shading(buffer),
    extension: { factors: new Float32Array([1, 0, 0, 0]), lighting: false },
  });
  f.frame();
  const draw = f.draws[0];
  assert.ok(draw.groups[2].entries.length, 'Local shading keeps its occupied binding group');
  assert.equal(draw.groups[2].entries[0].resource.buffer, buffer);
  assert.equal(draw.groups[3].entries[0].resource.buffer.size, 16);
});

test('cross-device renderers reject local material resources before allocating GPU state', async (t) => {
  const f = await fixture(1),
    other = optionalGPU();
  t.after(() => {
    f.engine.dispose();
    other.cleanup();
  });
  const buffer = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  f.model.primitives[0].material.shading = shading(buffer);
  const before = other.resources.length;
  assert.throws(
    () => f.model.createRenderer(other.engine.gpu),
    /Cross-device PBR rendering requires recreating local material shading/,
  );
  assert.equal(other.resources.length, before);
  const renderer = f.model.createRenderer(f.device);
  renderer.dispose();
});

test('an existing cross-device renderer rejects local shading attached after setup', async (t) => {
  const f = await fixture(1),
    other = optionalGPU();
  t.after(() => {
    f.engine.dispose();
    other.cleanup();
  });
  const renderer = f.model.createRenderer(other.engine.gpu),
    buffer = f.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  t.after(() => {
    renderer.dispose();
    buffer.destroy();
  });
  f.model.primitives[0].material.shading = shading(buffer);
  assert.throws(
    () => renderer.prepare(other.context),
    /Cross-device PBR rendering requires recreating local material shading/,
  );
  delete f.model.primitives[0].material.shading;
  renderer.prepare(other.context);
});

test('opaque captures defer both explicit grouped phases and replay blended primitives exactly once', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.model.primitives[1].material.settings[0] = 2;
  PBRModel.beginOpaquePass(f.context);
  f.frame('beauty', 'opaque');
  f.frame('beauty', 'blend');
  assert.equal(f.draws.length, 1, 'Only the opaque group belongs in the opaque capture');
  PBRModel.endOpaquePass(f.context);
  assert.equal(f.draws.length, 2, 'The deferred blended group must be replayed once');
  PBRModel.endOpaquePass(f.context);
  assert.equal(f.draws.length, 2);
  PBRModel.beginOpaquePass(f.context);
  f.frame('beauty', 'opaque');
  PBRModel.endOpaquePass(f.context);
  assert.equal(f.draws.length, 4, 'An explicit opaque call still schedules the model blended primitives');
});

test('opaque captures replay mixed models in the explicit blend phase order', async (t) => {
  const f = await fixture(),
    near = f.model,
    far = parseGLTF(f.engine, near.asset.doc, near.asset.buffers);
  t.after(() => f.engine.dispose());
  near.root.setPosition([0, 0, 1]);
  far.root.setPosition([0, 0, -1]);
  f.engine.store.tick(false);
  near.primitives[1].material.settings[0] = far.primitives[1].material.settings[0] = 2;
  const draw = (model, phase) => model.draw(f.context, 'beauty', f.context.color, f.context.depth, phase);
  PBRModel.beginOpaquePass(f.context);
  draw(near, 'opaque');
  draw(far, 'opaque');
  draw(far, 'blend');
  draw(near, 'blend');
  assert.equal(f.draws.length, 2, 'Only opaque primitives draw before the capture');
  PBRModel.endOpaquePass(f.context);
  assert.deepEqual(
    f.draws.slice(2).map((draw) => {
      const buffer = draw.groups[0].entries[0].resource.buffer;
      return buffer === far.resources[1].uniform ? 'far' : buffer === near.resources[1].uniform ? 'near' : 'other';
    }),
    ['far', 'near'],
    'The deferred blend draws retain far-to-near queue order independently of opaque insertion order',
  );
});

for (const [name, transform, derivatives] of [
  ['UV1', { texCoord: 1 }, true],
  ['rotated UV0', { rotation: Math.PI / 2 }, true],
  ['identity UV0', {}, false],
]) {
  test(`constructed normal map preserves normal scale with ${name} tangent selection`, async (t) => {
    const f = await fixture(1);
    t.after(() => f.engine.dispose());
    const m = f.model.primitives[0].material,
      normalUVs = Array.from({ length: 13 }, () => textureTransform()).flat();
    normalUVs.splice(16, 8, ...textureTransform(transform, transform.texCoord ?? 0));
    Object.assign(m, { extendedFrame: true, ext: [0, 0, 0, 0], uvt: normalUVs });
    m.factors[2] = 0.75;
    f.frame();
    assert.equal(
      f.model.resources[0].values[82],
      0.75,
      'Constructed maps bind through local shading, not glTF map slots',
    );
    const code = f.draws[0].pipeline.fragment.module.code;
    assert.equal(
      code.includes('if(true)'),
      derivatives,
      'Authored UV0 tangents do not describe a different normal-map UV frame',
    );
  });
}

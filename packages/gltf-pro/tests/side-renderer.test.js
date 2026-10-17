import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { loadGLTFProgressive } from '../dist/progressive.js';
import { PBRInstances } from '../dist/instancing.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { pbrShader } from '../src/shader.ts';
import { backSideShader } from '../src/side-shader.ts';
import { instancedShader } from '../src/instancing.ts';

test('back-only instancing gives extension helpers and the surface the same instance handedness', () => {
  const helper = 'fn layer(i:Out,front:bool)->bool {let facing=front==(f.coordsB.y>0);return facing;}\n',
    code = backSideShader(instancedShader(helper + pbrShader));
  assert.equal(code.includes('front==(f.coordsB.y>0)'), false);
  assert.equal([...code.matchAll(/let facing=front==\(i.mirror>0\);/g)].length, 2);
});

async function fixture(
  t,
  { doubleSided = false, mode = 4, scale = [1, 1, 1], omitNormals = false, staticParts = false } = {},
) {
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
    data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  data.doc.nodes[0].scale = scale;
  data.doc.materials[0].doubleSided = doubleSided;
  data.doc.meshes[0].primitives[0].mode = mode;
  if (omitNormals) delete data.doc.meshes[0].primitives[0].attributes.NORMAL;
  if (staticParts) {
    const definition = data.doc.meshes[0].primitives[0];
    delete definition.targets;
    delete definition.attributes.JOINTS_0;
    delete definition.attributes.WEIGHTS_0;
    delete data.doc.meshes[0].weights;
    data.doc.nodes = [
      { mesh: 0, translation: [-1, 0, 0] },
      { mesh: 0, translation: [1, 0, 0], scale: [-1, 1, 1] },
    ];
  }
  const model = parseGLTF(engine, data.doc, data.buffers),
    context = { ...gpu.context, camera: engine.camera },
    draws = [];
  let drawn;
  context.encoder.beginRenderPass = () => {
    let pipeline, vertex, uniform;
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup(index, group) {
        if (index === 0) uniform = group.entries.find((entry) => entry.binding === 0).resource.buffer;
      },
      setVertexBuffer(index, value) {
        if (index === 0) vertex = value;
      },
      setIndexBuffer() {},
      drawIndexed(count, instances = 1) {
        drawn = pipeline;
        draws.push({ pipeline, count, instances, vertex, uniform, values: new Float32Array(uniform.data).slice() });
      },
      end() {},
    };
  };
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  engine.camera.update(128 / 96, true);
  store.tick(false);
  return {
    ...gpu,
    engine,
    model,
    draws,
    frame(mode = 'beauty') {
      drawn = undefined;
      draws.length = 0;
      model.draw(context, mode, context.color, context.depth);
      return drawn;
    },
  };
}

test('parsed materials expose a validated side backed by the current settings array', async (t) => {
  const f = await fixture(t),
    material = f.model.primitives[0].material;
  assert.equal(material.side, 'front');
  material.side = 'back';
  assert.equal(material.settings[2], 2);
  material.settings = [0, 0.5, 1, 0];
  assert.equal(material.side, 'double');
  material.side = 'front';
  assert.equal(material.settings[2], 0);
  assert.throws(() => {
    material.side = 'outside';
  }, TypeError);
  assert.equal(material.side, 'front');
  const double = await fixture(t, { doubleSided: true });
  assert.equal(double.model.primitives[0].material.side, 'double');
});

test('coalesced static triangles keep one draw and live front, back and double side state in every replay', async (t) => {
  const f = await fixture(t, { staticParts: true }),
    material = f.model.primitives[0].material,
    batch = f.model.resources.find((resource) => resource.batch),
    fronts = new Map();
  assert.equal(f.model.primitives.length, 2);
  assert.equal(f.model.primitives[1].material, material);
  assert.ok(batch, 'same-material static nodes, including a mirrored part, form a material batch');
  material.settings[0] = 1;
  const states = [
    { side: 'front', flag: 0, cull: 'back', guard: 'if(margoFaceTest&&!facing&&f.settings.z<0.5)' },
    { side: 'back', flag: 2, cull: 'front', guard: 'if(margoFaceTest&&facing)' },
    { side: 'double', flag: 1, cull: 'none', guard: 'if(margoFaceTest&&!facing&&f.settings.z<0.5)' },
    { side: 'front', flag: 0, cull: 'back', guard: 'if(margoFaceTest&&!facing&&f.settings.z<0.5)' },
  ];
  for (const [index, state] of states.entries()) {
    material.side = state.side;
    for (const mode of ['beauty', 'ambient', 'gbuffer', 'occlusion']) {
      const pipeline = f.frame(mode),
        label = `${state.side} ${mode}`;
      assert.equal(f.draws.length, 1, label);
      assert.equal(f.draws[0].count, 6, label);
      assert.equal(f.draws[0].instances, 1, label);
      assert.equal(f.draws[0].vertex, batch.vertex, label);
      assert.equal(f.draws[0].uniform, batch.uniform, label);
      assert.equal(f.draws[0].values[90], state.flag, label);
      assert.equal(pipeline.primitive.cullMode, state.cull, label);
      assert.equal(pipeline.fragment.constants.margoFaceTest, 0, label);
      assert.ok(pipeline.fragment.module.code.includes(`${state.guard}{discard;}`), label);
      if (index === 0) fronts.set(mode, pipeline);
      if (index === 3) assert.equal(pipeline, fronts.get(mode), 'returning to front reuses the correct batch pipeline');
    }
  }
});

test('occlusion preserves back culling and logical face guards through mirrored nodes and instances', async (t) => {
  for (const [scale, cull] of [
    [[1, 1, 1], 'front'],
    [[-1, 1, 1], 'back'],
  ]) {
    const f = await fixture(t, { scale }),
      primitive = f.model.primitives[0];
    primitive.material.side = 'back';
    const single = f.frame('occlusion');
    assert.equal(single.primitive.cullMode, cull);
    assert.equal(single.fragment.entryPoint, 'margoOcclusion');
    assert.equal(single.fragment.targets.length, 2);
    assert.match(single.fragment.module.code, /if\(facing\)\{discard;\}/);
    assert.match(single.fragment.module.code, /fn margoOcclusion[^]*let s=surface\(i,front\);/);
    assert.equal(f.draws[0].values[90], 2);
    const instances = new PBRInstances(2);
    primitive.instances = instances;
    instances.setMatrixAt(1, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const [side, flag, face] of [
      ['back', 2, 1],
      ['double', 1, 0],
      ['front', 0, 1],
    ]) {
      primitive.material.side = side;
      const pipeline = f.frame('occlusion');
      assert.equal(f.draws.length, 1);
      assert.equal(f.draws[0].instances, 2);
      assert.equal(f.draws[0].values[90], flag);
      assert.equal(pipeline.primitive.cullMode, 'none');
      assert.equal(pipeline.fragment.constants.margoFaceTest, face);
      assert.equal(pipeline.fragment.entryPoint, 'margoOcclusion');
      assert.equal(pipeline.fragment.targets.length, 2);
      assert.match(pipeline.fragment.module.code, /let facing=front==\(i.mirror>0\);/);
      assert.ok(
        pipeline.fragment.module.code.includes(
          side === 'back'
            ? 'if(margoFaceTest&&facing){discard;}'
            : 'if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}',
        ),
      );
    }
  }
});

test('back-side triangles reverse node culling in beauty, ambient and G-buffer passes', async (t) => {
  for (const [scale, cull] of [
    [[1, 1, 1], 'front'],
    [[-1, 1, 1], 'back'],
  ]) {
    const f = await fixture(t, { scale }),
      material = f.model.primitives[0].material;
    material.side = 'back';
    for (const mode of ['beauty', 'ambient', 'gbuffer']) {
      const pipeline = f.frame(mode);
      assert.equal(pipeline.primitive.cullMode, cull, mode);
      assert.equal(f.model.resources[0].values[90], 2);
    }
  }
});

test('structural material side overrides its legacy flag in uniforms and picking snapshots', async (t) => {
  const f = await fixture(t, { doubleSided: true }),
    primitive = f.model.primitives[0];
  primitive.material = { ...primitive.material, side: 'back' };
  const pipeline = f.frame();
  assert.equal(pipeline.primitive.cullMode, 'front');
  assert.equal(f.model.resources[0].values[90], 2);
  const picking = f.model.pickingPrimitives[0],
    snapshot = (await f.model.readPickingGeometry())[0];
  assert.equal(picking.side, 'back');
  assert.equal(picking.doubleSided, false);
  assert.equal(snapshot.side, 'back');
  assert.equal(snapshot.doubleSided, false);
  delete primitive.material.side;
  primitive.material.settings[2] = 1;
  assert.equal(f.model.pickingPrimitives[0].side, 'double');
  assert.equal(f.model.pickingPrimitives[0].doubleSided, true);
});

test('mixed winding instances retain shader face testing for front and back sides', async (t) => {
  const f = await fixture(t),
    primitive = f.model.primitives[0],
    instances = new PBRInstances(2);
  primitive.instances = instances;
  instances.setMatrixAt(1, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const side of ['front', 'back', 'double']) {
    primitive.material.side = side;
    const pipeline = f.frame();
    assert.equal(pipeline.primitive.cullMode, 'none');
    assert.equal(pipeline.fragment.constants.margoFaceTest, side === 'double' ? 0 : 1);
  }
});

test('points and lines ignore side when composing their shader and raster state', async (t) => {
  for (const mode of [0, 3]) {
    const f = await fixture(t, { mode, scale: [-1, 1, 1] }),
      material = f.model.pointsAndLines[0].material,
      front = f.frame();
    material.side = 'back';
    const back = f.frame();
    assert.equal(f.model.resources[0].values[90], 1, 'nontriangle faces never discard for sidedness');
    assert.equal(back.vertex.module.code, front.vertex.module.code);
    assert.equal(back.primitive.cullMode, undefined);
  }
});

test('unlit point material copies retain a live side accessor', async (t) => {
  const f = await fixture(t, { mode: 0, omitNormals: true }),
    material = f.model.pointsAndLines[0].material;
  material.settings = [0, 0.5, 1, 0];
  assert.equal(material.side, 'double');
  material.side = 'back';
  assert.equal(material.settings[2], 2);
});

test('progressive factor-only material copies retain a live side accessor', async (t) => {
  const f = await fixture(t),
    { doc } = animatedTriangle(),
    saved = { Worker: globalThis.Worker, location: globalThis.location };
  delete doc.skins;
  delete doc.animations;
  delete doc.nodes[0].skin;
  const primitive = doc.meshes[0].primitives[0];
  doc.accessors[primitive.attributes.POSITION].min = [-0.6, -0.6, 0];
  doc.accessors[primitive.attributes.POSITION].max = [0.6, 0.6, 0];
  primitive.attributes.TEXCOORD_0 = doc.accessors.push({ componentType: 5126, count: 3, type: 'VEC2' }) - 1;
  doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  doc.textures = [{ source: 0 }];
  doc.images = [{ uri: 'texture.png' }];
  // Isolate the worker boundary while exercising the real progressive loader's ready state.
  globalThis.Worker = class {
    postMessage(message) {
      if (message.url) queueMicrotask(() => this.onmessage({ data: { type: 'doc', doc } }));
    }
    terminate() {}
  };
  globalThis.location = { href: 'http://localhost/' };
  const load = loadGLTFProgressive(f.engine, 'http://localhost/side.gltf');
  try {
    const model = await load.ready,
      material = model.primitives[0].material;
    assert.ok(material.maps.every((map) => map === undefined));
    material.settings = [0, 0.5, 0, 0];
    assert.equal(material.side, 'front');
    material.side = 'back';
    assert.equal(material.settings[2], 2);
  } finally {
    load.abort();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('front and double draws retain the default shader source while back changes only its face guard', async (t) => {
  const f = await fixture(t),
    material = f.model.primitives[0].material;
  const front = f.frame().vertex.module.code;
  assert.equal(front, pbrShader);
  material.side = 'double';
  assert.equal(f.frame().vertex.module.code, front);
  material.side = 'back';
  assert.equal(f.frame().vertex.module.code, front.replace('if(!facing&&f.settings.z<0.5)', 'if(facing)'));
});

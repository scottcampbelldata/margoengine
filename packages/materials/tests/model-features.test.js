// install(model, {features}): skin(), hair(), eye() and alphaHash() on a loaded glTF model's materials, by name. Before
// this, a loaded model had no way to take them: they were reachable only through a materials mesh's Material.features.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf/dist/pbr.js';
import { install, PbrMaterial, createMesh } from '../dist/index.js';
import { skin } from '../dist/skin.js';
import { hair } from '../dist/hair.js';
import { eye } from '../dist/eye.js';
import { alphaHash } from '../dist/alpha-hash.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function scene(name = 'Skin', configure = () => {}) {
  const harness = optionalGPU(),
    store = await TransformStore.create(16),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  const modules = [],
    createShaderModule = device.createShaderModule;
  device.createShaderModule = (descriptor) => {
    modules.push(descriptor.code);
    return createShaderModule(descriptor);
  };
  const engine = new Engine(
    { width: 128, height: 128, clientWidth: 128, clientHeight: 128 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 3], target: [0, 0, 0] },
    null,
  );
  const fixture = materialQuad();
  fixture.doc.materials[0].name = name;
  configure(fixture.doc);
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, []);
  engine.camera.update(1, true);
  store.tick(false);
  const draws = [],
    context = {
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
            drawIndexed() {
              draws.push({ pipeline, groups: new Map(groups) });
            },
            end() {},
          };
        },
      },
    };
  return {
    engine,
    model,
    modules,
    draws,
    draw() {
      modules.length = 0;
      model.draw(context, 'beauty', context.color, context.depth);
      return modules.join('\n');
    },
  };
}

test('install features: skin(), hair() and eye() reach a loaded model by material name, and dispose takes them off', async () => {
  for (const [feature, light] of [
    [skin(), 'margoSkinLight'],
    [hair({ direction: [0, -1, 0] }), 'margoHairLight'],
    [eye(), 'margoEyeLight'],
  ]) {
    const s = await scene('Skin');
    try {
      const plain = s.draw();
      assert.ok(plain.length > 0 && !plain.includes(light), 'the plain material compiles without the feature');
      const installation = install(s.model, { features: { Skin: [feature] } });
      const shaded = s.draw();
      assert.ok(shaded.includes(`return ${light}(s.n,v,l,s.base.rgb)`), `${feature.name}: the sun goes through it`);
      assert.ok(s.model.primitives[0].material.shading, `${feature.name}: the record has the hook`);
      installation.dispose();
      assert.equal(s.model.primitives[0].material.shading, undefined, `${feature.name}: the record's own hook is back`);
      assert.ok(!Object.hasOwn(s.model.primitives[0].material, 'shading'), 'the record is as it was');
    } finally {
      s.engine.dispose();
    }
  }
});

test('install features bind what the feature binds: skin its table at 130 and 131, eye its uniform at 132', async () => {
  for (const [feature, bindings] of [
    [skin(), [130, 131]],
    [eye(), [132]],
  ]) {
    const s = await scene('Skin');
    try {
      install(s.model, { features: { Skin: [feature] } });
      s.draw();
      const entries = s.model.primitives[0].material.shading.bindings().map((e) => e.binding);
      assert.deepEqual(entries, bindings);
    } finally {
      s.engine.dispose();
    }
  }
});

test('install features: alphaHash() makes an OPAQUE glTF material a hashed cut-out, shadows cut alike, dispose restores', async () => {
  const s = await scene('Hair');
  try {
    const record = s.model.primitives[0].material;
    assert.deepEqual(record.settings.slice(0, 2), [0, 0.5]);
    const feature = alphaHash({ cutoff: 0.3 }),
      installation = install(s.model, { features: { Hair: [hair(), feature] } });
    assert.deepEqual(record.settings.slice(0, 2), [1, 0.3], 'MASK at the feature cutoff');
    assert.equal(record.castHashed, feature.castHashed, 'shadow casters get the same hash');
    assert.ok(s.draw().includes('let margoCut=margoAlphaHash(i.margoObject);'), 'the colour pass cuts by the hash');
    installation.dispose();
    assert.deepEqual(record.settings.slice(0, 2), [0, 0.5], 'OPAQUE again, with its own cutoff');
    assert.ok(!Object.hasOwn(record, 'castHashed'));
  } finally {
    s.engine.dispose();
  }
});

test('install features: a MASK material keeps its own cutoff under alphaHash()', async () => {
  const s = await scene('Leaf', (doc) => Object.assign(doc.materials[0], { alphaMode: 'MASK', alphaCutoff: 0.7 }));
  try {
    const record = s.model.primitives[0].material,
      installation = install(s.model, { features: { Leaf: [alphaHash()] } });
    assert.deepEqual(record.settings.slice(0, 2), [1, 0.7]);
    assert.ok(s.draw().includes('&&s.base.a<margoCut)'), 'the hash is the cut');
    installation.dispose();
    assert.deepEqual(record.settings.slice(0, 2), [1, 0.7]);
  } finally {
    s.engine.dispose();
  }
});

test('install features run after a hook the record already had, and give it back', async () => {
  const s = await scene('Skin');
  try {
    const record = s.model.primitives[0].material,
      calls = [],
      own = {
        shader: (code) => (calls.push('shader'), code + '\n// own'),
        lit: (code) => (calls.push('lit'), code),
        bindings: () => [{ binding: 120, resource: {} }],
      };
    record.shading = own;
    const installation = install(s.model, { features: { Skin: [skin()] } });
    const code = s.draw();
    assert.ok(code.includes('// own') && code.includes('margoSkinLight'));
    assert.ok(calls.includes('shader') && calls.includes('lit'));
    assert.deepEqual(
      record.shading.bindings().map((e) => e.binding),
      [120, 130, 131],
    );
    installation.dispose();
    assert.equal(record.shading, own);
  } finally {
    s.engine.dispose();
  }
});

test('install features refuse bad input and leave every record as it was', async () => {
  const s = await scene('Skin');
  try {
    const record = s.model.primitives[0].material;
    assert.throws(() => install(s.model, { features: { Face: [skin()] } }), /no material named "Face".*"Skin"/);
    assert.throws(() => install(s.model, { features: { Skin: skin() } }), /must be an array of features/);
    assert.throws(() => install(s.model, { features: { Skin: [{}] } }), /must be an array of features/);
    assert.throws(() => install(s.model, { features: { Skin: [skin(), skin()] } }), /two of one kind/);
    assert.throws(() => install(s.model, { features: [] }), /Invalid model features/);
    assert.throws(() => install(s.model, null), /Invalid install options/);
    assert.ok(!Object.hasOwn(record, 'shading'), 'nothing changed');
    const first = install(s.model, { features: { Skin: [skin()] } });
    assert.throws(() => install(s.model, { features: { Skin: [hair()] } }), /already has model features/);
    first.dispose();
    install(s.model, { features: { Skin: [hair()] } }).dispose();
  } finally {
    s.engine.dispose();
  }
});

test('install features: disposing the model takes them off; a materials mesh is pointed at Material.features', async () => {
  const s = await scene('Skin');
  try {
    const feature = eye();
    let detached = 0;
    const detach = feature.detach;
    feature.detach = (m) => (detached++, detach(m));
    install(s.model, { features: { Skin: [feature] } });
    s.model.dispose();
    assert.equal(detached, 1, 'the eye let go of its buffers');
    const mesh = createMesh(s.engine, materialQuadGeometry(), new PbrMaterial());
    mesh.primitives[0].material.name = 'Skin';
    assert.throws(() => install(mesh, { features: { Skin: [skin()] } }), /Material\.features/);
  } finally {
    s.engine.dispose();
  }
});

function materialQuadGeometry() {
  return {
    positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

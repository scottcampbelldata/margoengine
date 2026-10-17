// Compact PBR fingerprint includes the GPU-verified WebGPU derivative tangent correction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import * as materials from '../dist/index.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const source = (value) => [value.declarations, value.wgsl, value.direct, value.output].filter(Boolean).join('\n');
async function scene(extensions, images = [], configure = () => {}) {
  const harness = optionalGPU(),
    store = await TransformStore.create(16),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  const copies = [],
    samplers = [],
    createSampler = device.createSampler;
  device.createSampler = (value) => {
    samplers.push(value);
    return createSampler(value);
  };
  device.queue.copyExternalImageToTexture = (...args) => copies.push(args);
  const engine = new Engine(
    { width: 128, height: 128, clientWidth: 128, clientHeight: 128 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 3], target: [0, 0, 0] },
    null,
  );
  const fixture = materialQuad();
  if (extensions) fixture.doc.materials[0].extensions = extensions;
  configure(fixture.doc);
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, images);
  assert.ok(!(model instanceof Promise));
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
            setBindGroup(index, value) {
              groups.set(index, value);
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
    ...harness,
    device,
    engine,
    model,
    draws,
    copies,
    samplers,
    draw() {
      model.draw(context, 'beauty', context.color, context.depth);
    },
  };
}

test('the four lobe factories pack independent finite vec4 factors and allocate no implicit textures', () => {
  const values = [
    materials.sheen({ colorFactor: [0.2, 0.4, 0.6], roughnessFactor: 0.3 }),
    materials.specular({ factor: 0.5, colorFactor: [0.2, 0.4, 0.6] }),
    materials.anisotropy({ strength: 0.75, rotation: 0.25 }),
    materials.iridescence({ factor: 0.5, ior: 1.4, thicknessMinimum: 120, thicknessMaximum: 450 }),
  ];
  const expected = [
    [0.2, 0.4, 0.6, 0.3],
    [0.2, 0.4, 0.6, 0.5],
    [0.75, 0.25, 0, 0],
    [0.5, 1.4, 120, 450],
  ];
  for (let i = 0; i < values.length; i++) {
    assert.ok(values[i].factors instanceof Float32Array);
    assert.deepEqual([...values[i].factors], expected[i].map(Math.fround));
    assert.equal(values[i].textures?.length ?? 0, 0);
    assert.ok(values[i].factors.every(Number.isFinite));
  }
});

test('materialLobes composes all four blocks after caller factors without mutating its base', () => {
  const base = materials.clearcoat({ factor: 0.6, roughnessFactor: 0.2 }),
    before = [...base.factors],
    baseSource = source(base);
  const extension = materials.materialLobes(
    {
      sheen: { colorFactor: [1, 0, 0] },
      specular: { factor: 0.5 },
      anisotropy: { strength: 0.75 },
      iridescence: { factor: 0.8 },
    },
    base,
  );
  assert.deepEqual([...base.factors], before);
  assert.equal(source(base), baseSource);
  assert.deepEqual([...extension.factors.slice(0, 4)], before);
  assert.equal(extension.factors.length, 20);
  assert.match(source(extension), /materialClearcoat/);
});

test('lobe composition rejects malformed caller factor blocks before copying them', () => {
  for (const factors of [
    new Float32Array(),
    new Float32Array([1, 2, 3]),
    new Float32Array([1, 2, NaN, 4]),
    [1, 2, 3, 4],
  ])
    assert.throws(() => materials.sheen({ colorFactor: [1, 0, 0] }, { factors }), /factor|vec4|finite|invalid/i);
});

test('lobe options reject invalid factors, colors, film parameters and nonfinite angles', () => {
  for (const value of [NaN, Infinity, -Infinity, -0.01, 1.01, '1', null]) {
    for (const name of ['specular', 'iridescence'])
      assert.throws(() => materials[name]({ factor: value }), /factor|specular|iridescence|number|invalid/i);
    assert.throws(() => materials.anisotropy({ strength: value }), /strength|anisotropy|number|invalid/i);
    assert.throws(() => materials.sheen({ roughnessFactor: value }), /roughness|sheen|number|invalid/i);
  }
  for (const value of [[1, 1], [1, 1, 1, 1], Array(3), [1, NaN, 1], [-1, 0, 0], null])
    for (const name of ['sheen', 'specular'])
      assert.throws(() => materials[name]({ colorFactor: value }), /color|sheen|specular|invalid/i);
  assert.throws(() => materials.sheen({ colorFactor: [1, 2, 1] }), /color|sheen|invalid/i);
  assert.doesNotThrow(() => materials.specular({ colorFactor: [2, 1, 0.5] }), 'Specular color factors may exceed one');
  for (const ior of [0.99, NaN, Infinity])
    assert.throws(() => materials.iridescence({ ior }), /IOR|ior|iridescence|invalid/i);
  for (const value of [NaN, Infinity, '1', null])
    assert.throws(() => materials.anisotropy({ rotation: value }), /rotation|angle|anisotropy|invalid/i);
  for (const options of [{ thicknessMinimum: -1 }, { thicknessMaximum: -1 }, { thicknessMaximum: Infinity }])
    assert.throws(() => materials.iridescence(options), /thickness|iridescence|invalid/i);
  assert.doesNotThrow(
    () => materials.iridescence({ thicknessMinimum: 400, thicknessMaximum: 100 }),
    'The two nonnegative thickness endpoints may be reversed',
  );
});

test('lobe textures retain caller ownership, optional samplers, transforms and independent UVs', () => {
  const a = { view: { name: 'a' }, sampler: {}, texCoord: 1, transform: { offset: [0.25, 0.125], rotation: 0.37 } },
    b = { view: { name: 'b' } };
  const options = {
    sheen: { colorFactor: [1, 1, 1], sheenColorTexture: a, sheenRoughnessTexture: b },
    specular: { specularTexture: a, specularColorTexture: b },
    anisotropy: { strength: 1, anisotropyTexture: a },
    iridescence: { factor: 1, iridescenceTexture: a, iridescenceThicknessTexture: b },
  };
  const extension = materials.materialLobes(options);
  assert.equal(extension.textures.length, 2);
  assert.equal(extension.textures[0].view, a.view);
  assert.equal(extension.textures[0].sampler, a.sampler);
  assert.equal(extension.textures[1].view, b.view);
  assert.equal(extension.textures[1].sampler, undefined);
  assert.match(source(extension), /materialUV\(uv\(i,1\.0\)/);
  assert.match(source(extension), /textureLoad\(/);
  assert.match(source(extension), /textureSample/);
  const changed = materials.materialLobes({
    ...options,
    anisotropy: { ...options.anisotropy, anisotropyTexture: { ...a, texCoord: 0 } },
  });
  assert.notEqual(source(changed), source(extension), 'UV choice participates in the pipeline signature');
});

test('all new maps reject malformed texture interfaces and unsupported UV sets', () => {
  const fields = {
    sheen: ['sheenColorTexture', 'sheenRoughnessTexture'],
    specular: ['specularTexture', 'specularColorTexture'],
    anisotropy: ['anisotropyTexture'],
    iridescence: ['iridescenceTexture', 'iridescenceThicknessTexture'],
  };
  for (const [name, maps] of Object.entries(fields))
    for (const field of maps)
      for (const value of [
        {},
        { view: {}, texCoord: 2 },
        { view: {}, sampler: null },
        { view: {}, transform: { rotation: null } },
      ])
        assert.throws(
          () => materials[name]({ [field]: value }),
          /texture|UV|coordinate|transform|sampler|rotation|invalid/i,
        );
});

test('unextended models retain the baseline shader and allocation path after installation', async () => {
  const s = await scene();
  try {
    const before = { ...s.counts },
      installation = materials.install(s.model);
    s.draw();
    assert.equal(s.model.primitives[0].material.extension, undefined);
    assert.deepEqual([...s.draws[0].groups.keys()], [0, 1]);
    assert.equal(
      digest(s.draws[0].pipeline.vertex.module.code),
      '0b7dcd50cea837c6c983f1487b23b0a7991a11e8a56d441c6a936b867169bb5d',
    );
    assert.equal(s.counts.textures, before.textures);
    assert.equal(s.counts.buffers, before.buffers);
    installation.dispose();
  } finally {
    s.engine.dispose();
  }
});

test('standard glTF metadata installs all four lobes synchronously through one group 3 block', async () => {
  const s = await scene({
    KHR_materials_sheen: { sheenColorFactor: [0.2, 0.4, 0.6], sheenRoughnessFactor: 0.3 },
    KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [0.2, 0.4, 0.6] },
    KHR_materials_anisotropy: { anisotropyStrength: 0.75, anisotropyRotation: 0.25 },
    KHR_materials_iridescence: {
      iridescenceFactor: 0.5,
      iridescenceIor: 1.4,
      iridescenceThicknessMinimum: 120,
      iridescenceThicknessMaximum: 450,
    },
  });
  try {
    const installation = materials.install(s.model),
      extension = s.model.primitives[0].material.extension;
    assert.ok(!(installation instanceof Promise));
    assert.equal(extension.factors.length, 16);
    assert.equal(extension.textures?.length ?? 0, 0);
    s.draw();
    assert.ok(s.draws.at(-1).groups.has(3));
    assert.equal(s.draws.at(-1).groups.get(0).entries[0].resource.buffer.size, 400);
    installation.dispose();
    assert.equal(s.model.primitives[0].material.extension, undefined);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('normalized lobe configuration uses the same factor blocks as caller factories', async () => {
  const options = {
    sheen: { colorFactor: [0.3, 0.2, 0.1], roughnessFactor: 0.4 },
    specular: { factor: 0.7, colorFactor: [1, 0.8, 0.6] },
    anisotropy: { strength: 0.5, rotation: 0.2 },
    iridescence: { factor: 0.6, ior: 1.4, thicknessMinimum: 120, thicknessMaximum: 300 },
  };
  const s = await scene();
  try {
    Object.assign(s.model.primitives[0].material, options);
    const installation = materials.install(s.model);
    assert.deepEqual(
      [...s.model.primitives[0].material.extension.factors],
      [...materials.materialLobes(options).factors],
    );
    s.draw();
    installation.dispose();
  } finally {
    s.engine.dispose();
  }
});

test('color maps upload in sRGB while factor, roughness and direction maps share linear uploads', async () => {
  const image = {
    width: 1,
    height: 1,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const s = await scene(
    {
      KHR_materials_sheen: {
        sheenColorFactor: [1, 1, 1],
        sheenColorTexture: { index: 0 },
        sheenRoughnessTexture: { index: 0 },
      },
      KHR_materials_specular: { specularColorTexture: { index: 0 }, specularTexture: { index: 0 } },
      KHR_materials_anisotropy: { anisotropyStrength: 1, anisotropyTexture: { index: 0 } },
      KHR_materials_iridescence: {
        iridescenceFactor: 1,
        iridescenceTexture: { index: 0 },
        iridescenceThicknessTexture: { index: 0 },
      },
    },
    [image],
    (doc) => {
      doc.images = [{ uri: 'decoded.png' }];
      doc.textures = [{ source: 0 }];
    },
  );
  try {
    const before = s.resources.length,
      installation = materials.install(s.model),
      owned = s.resources.slice(before).filter((resource) => resource.format);
    assert.deepEqual(owned.map((resource) => resource.format).sort(), ['rgba8unorm', 'rgba8unorm-srgb']);
    assert.equal(s.copies.length, 2);
    s.draw();
    const extension = s.model.primitives[0].material.extension;
    extension.factors[0] = 0.75;
    s.model.onDeviceRestored(s.engine);
    installation.onDeviceRestored(s.engine);
    assert.ok(owned.every((resource) => resource.destroyed));
    assert.equal(s.model.primitives[0].material.extension.factors, extension.factors);
    assert.equal(image.closed, false);
    s.draw();
    installation.dispose();
  } finally {
    s.engine.dispose();
  }
  assert.equal(image.closed, true);
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('lobe factor edits reuse the pipeline while different lobe injections remain isolated', async () => {
  const s = await scene();
  try {
    s.draw();
    const baseline = s.draws.at(-1).pipeline,
      extension = materials.sheen({ colorFactor: [0.2, 0.4, 0.6] });
    s.model.primitives[0].extension = extension;
    s.draw();
    const pipeline = s.draws.at(-1).pipeline,
      count = s.pipelines.length;
    assert.notEqual(pipeline, baseline);
    extension.factors[0] = 0.5;
    s.draw();
    assert.equal(s.pipelines.length, count);
    s.model.primitives[0].extension = materials.anisotropy({ strength: 0.5 });
    s.draw();
    assert.notEqual(s.draws.at(-1).pipeline, pipeline);
  } finally {
    s.engine.dispose();
  }
});

test('a transformed base texture does not retain a removed caller ambient hook', async () => {
  const image = { width: 1, height: 1, close() {} },
    s = await scene(undefined, [image], (doc) => {
      doc.images = [{ uri: 'decoded.png' }];
      doc.textures = [{ source: 0 }];
      doc.materials[0].pbrMetallicRoughness.baseColorTexture = {
        index: 0,
        extensions: { KHR_texture_transform: { offset: [0.25, 0.125] } },
      };
    });
  try {
    const extension = materials.sheen({ colorFactor: [0.3, 0.2, 0.1] }),
      ambient = extension.ambient;
    s.model.primitives[0].extension = extension;
    s.draw();
    assert.equal(typeof ambient, 'string');
    const first = s.draws.at(-1).pipeline;
    assert.ok(first.vertex.module.code.includes(ambient));
    delete extension.ambient;
    s.draw();
    const removed = s.draws.at(-1).pipeline;
    assert.notEqual(removed, first);
    assert.ok(!removed.vertex.module.code.includes(ambient));
    extension.ambient = ambient;
    s.draw();
    assert.equal(s.draws.at(-1).pipeline, first);
  } finally {
    s.engine.dispose();
  }
});

test('composed extension texture and sampler limits reject before allocating a uniform block', async () => {
  for (const samplers of [false, true]) {
    const s = await scene();
    try {
      s.device.limits.maxSampledTexturesPerShaderStage = samplers ? Infinity : 16;
      s.device.limits.maxSamplersPerShaderStage = samplers ? 16 : Infinity;
      const textures = Array.from({ length: 12 }, () => ({ view: {}, ...(samplers ? { sampler: {} } : {}) }));
      s.model.primitives[0].extension = materials.sheen({ colorFactor: [1, 0, 0] }, { textures });
      const before = s.counts.buffers;
      assert.throws(() => s.draw(), /binding|texture|sampler|limit/i);
      assert.equal(s.counts.buffers, before);
    } finally {
      s.engine.dispose();
    }
    assert.ok(s.resources.every((resource) => resource.destroyed));
  }
});

test('invalid lobe metadata and transformed UV1 maps fail before partial installation', async () => {
  for (const definition of [
    { KHR_materials_sheen: { sheenColorFactor: [1, -1, 0] } },
    { KHR_materials_specular: { specularFactor: 2 } },
    { KHR_materials_anisotropy: { anisotropyStrength: 2 } },
    { KHR_materials_iridescence: { iridescenceThicknessMinimum: -1 } },
  ]) {
    const s = await scene(definition);
    try {
      const before = { ...s.counts };
      assert.throws(
        () => materials.install(s.model),
        /sheen|specular|anisotropy|iridescence|factor|thickness|color|invalid/i,
      );
      assert.equal(s.model.primitives[0].material.extension, undefined);
      assert.equal(s.counts.textures, before.textures);
      assert.equal(s.counts.buffers, before.buffers);
    } finally {
      s.engine.dispose();
    }
  }
  const s = await scene();
  try {
    delete s.model.primitives[0].definition.attributes.TEXCOORD_1;
    s.model.primitives[0].material.sheen = {
      colorFactor: [1, 1, 1],
      sheenColorTexture: { view: {}, transform: { texCoord: 1 } },
    };
    assert.throws(() => materials.install(s.model), /UV|TEXCOORD|coordinate/i);
  } finally {
    s.engine.dispose();
  }
});

test('lit lobe metadata rejects unlit and specular-glossiness material models before installation', async () => {
  for (const other of ['KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness']) {
    const s = await scene({ KHR_materials_sheen: { sheenColorFactor: [1, 0, 0] }, [other]: {} });
    try {
      const before = { ...s.counts };
      assert.throws(() => materials.install(s.model), /metallic|roughness|lighting|lit|material/i);
      assert.equal(s.model.primitives[0].material.extension, undefined);
      assert.equal(s.counts.textures, before.textures);
      assert.equal(s.counts.buffers, before.buffers);
    } finally {
      s.engine.dispose();
    }
  }
});

test('caller-owned color texture views survive lobe uninstall and model disposal', async () => {
  const s = await scene(),
    external = s.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  try {
    const view = external.createView();
    s.model.primitives[0].material.sheen = { colorFactor: [1, 1, 1], sheenColorTexture: { view } };
    const installation = materials.install(s.model);
    assert.equal(s.model.primitives[0].material.extension.textures[0].view, view);
    s.draw();
    installation.dispose();
    assert.equal(external.destroyed, false);
    s.model.destroy();
    assert.equal(external.destroyed, false);
  } finally {
    s.engine.dispose();
    external.destroy();
  }
});

test('disposing new lobes restores earlier extensions and preserves caller replacements', async () => {
  const s = await scene({ KHR_materials_sheen: { sheenColorFactor: [1, 0, 0] } });
  try {
    const material = s.model.primitives[0].material,
      previous = { wgsl: 's.emissive*=0.5;' };
    material.extension = previous;
    const first = materials.install(s.model);
    s.draw();
    first.dispose();
    assert.equal(material.extension, previous);
    const second = materials.install(s.model),
      replacement = {};
    material.extension = replacement;
    second.dispose();
    assert.equal(material.extension, replacement);
    const third = materials.install(s.model);
    s.model.destroy();
    assert.equal(third.disposed, true);
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

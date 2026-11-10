import assert from 'node:assert/strict';
import test from 'node:test';
import { convertSpecGlossMaterial, specGlossMaterials, specGlossToMetalRough } from '../dist/spec-gloss.js';
import { GLTFAsset } from '../dist/asset-entry.js';
import { parseGLTFAsync } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { extendedMaterials } from '../dist/extended.js';
import { wgslModule } from '../../../tests/support/wgsl-eval.js';

const name = 'KHR_materials_pbrSpecularGlossiness';
const off = { iridescence: false, anisotropy: false, diffuseTransmission: false };
const close = (actual, expected, epsilon = 1e-12) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < epsilon, `${v} vs ${expected[i]}`));
};

test('linear dielectric, gold, black and saturated endpoints preserve opacity and roughness', () => {
  const dielectric = specGlossToMetalRough([0.2, 0.4, 0.8, 0.3], [0.04, 0.04, 0.04], 0.7);
  close(dielectric.baseColor, [0.2, 0.4, 0.8, 0.3]);
  assert.equal(dielectric.metallic, 0);
  assert.ok(Math.abs(dielectric.roughness - 0.3) < 1e-12);
  const gold = specGlossToMetalRough([0, 0, 0, 0.8], [1, 0.766, 0.336], 0.9);
  close(gold.baseColor, [1, 0.766, 0.336, 0.8]);
  assert.ok(Math.abs(gold.metallic - 1) < 1e-12);
  for (const d of [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
  ])
    for (const s of [
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
    ]) {
      const result = specGlossToMetalRough(d, s);
      assert.ok(
        [...result.baseColor, result.metallic, result.roughness].every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
      );
    }
});

test('authored conversion wins over fallback, preserves ancillary fields and independent UV routing without mutation', () => {
  const diffuseTexture = { index: 2, texCoord: 1, extensions: { KHR_texture_transform: { rotation: 0.3 } } };
  const specularGlossinessTexture = { index: 3, texCoord: 2 };
  const input = {
    name: 'old',
    alphaMode: 'MASK',
    alphaCutoff: 0.25,
    doubleSided: true,
    normalTexture: { index: 1 },
    pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1 },
    extensions: {
      [name]: {
        diffuseFactor: [0.2, 0.4, 0.8, 0.3],
        specularFactor: [0.04, 0.3, 0.6],
        glossinessFactor: 0.75,
        diffuseTexture,
        specularGlossinessTexture,
      },
    },
  };
  const before = structuredClone(input),
    result = convertSpecGlossMaterial(input);
  assert.deepEqual(input, before);
  assert.equal(result.pbrMetallicRoughness.baseColorTexture, diffuseTexture);
  assert.equal(result.extensions.KHR_materials_specular.specularColorTexture, specularGlossinessTexture);
  assert.equal(result.normalTexture, input.normalTexture);
  assert.equal(result.alphaCutoff, 0.25);
  assert.equal(result.doubleSided, true);
  close(result.extensions.KHR_materials_specular.specularColorFactor, [1, 7.5, 15]);
  assert.equal(convertSpecGlossMaterial(before.normalTexture), before.normalTexture);
});

test('default async reader selects the optional entry and required extension needs an implementing reader', async () => {
  const doc = { asset: { version: '2.0' }, extensionsRequired: [name], materials: [{ extensions: { [name]: {} } }] };
  const gpu = optionalGPU(),
    store = await TransformStore.create(32);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  Object.assign(data.doc, { extensionsRequired: [name], materials: doc.materials });
  const model = await parseGLTFAsync(engine, data.doc, data.buffers);
  const hooks = model.asset.hooks;
  assert.deepEqual(hooks.materials.extensions, [name]);
  assert.doesNotThrow(() => new GLTFAsset(doc, [], undefined, hooks));
  assert.throws(() => new GLTFAsset(doc, []), /Required glTF extensions/);
  assert.throws(() => new GLTFAsset(doc, [], undefined, { materials: extendedMaterials }), /Required glTF extensions/);
  await assert.rejects(
    parseGLTFAsync(engine, data.doc, data.buffers, [], { decoders: { materials: false } }),
    /Required glTF extensions/,
  );
  model.dispose();
  engine.dispose();
});

test('fragment conversion matches the double-precision converter over independent diffuse/specular samples', () => {
  const maps = Array(21).fill(undefined);
  maps[12] = { index: 1 };
  const plan = specGlossMaterials.plan(maps, { ...off, specularGlossiness: true });
  const shader = specGlossMaterials.shader(plan);
  assert.match(shader, /uv\(i,12\)\)\.a/);
  assert.match(shader, /s\.roughness=clamp\(1-f\.factors\.x/);
  const code = shader.match(/fn margoSpecGloss[\s\S]*?\n\}/)[0];
  const module = wgslModule(code);
  for (let i = 0; i < 40; i++) {
    const d = [i / 40, ((i * 7) % 40) / 40, ((i * 13) % 40) / 40, 0.5];
    const s = [((i * 3) % 40) / 40, ((i * 11) % 40) / 40, ((i * 17) % 40) / 40];
    const expected = specGlossToMetalRough(d, s);
    close(
      module.call('margoSpecGloss', d.slice(0, 3), s),
      [...expected.baseColor.slice(0, 3), expected.metallic],
      1e-6,
    );
  }
  assert.ok(!specGlossMaterials.shader(specGlossMaterials.plan([], off)).includes('fn margoSpecGloss'));
});

test('malformed factors, holes, textures and extension payloads reject before packing', () => {
  for (const value of [-1, 1.1, Infinity, NaN, '0.5', null])
    assert.throws(() => specGlossToMetalRough([1, 1, 1, 1], [1, 1, 1], value), /spec\/gloss/);
  for (const extension of [
    null,
    [],
    false,
    { diffuseFactor: Array(4) },
    { diffuseFactor: null },
    { specularFactor: null },
    { glossinessFactor: null },
    { specularFactor: [1, 1, NaN] },
    { diffuseTexture: { index: -1 } },
    { specularGlossinessTexture: { index: 0, texCoord: 4 } },
  ])
    assert.throws(() => convertSpecGlossMaterial({ extensions: { [name]: extension } }));
});

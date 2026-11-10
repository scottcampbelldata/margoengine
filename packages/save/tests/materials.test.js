import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial as CoreMaterial } from '@margoengine/core';
import * as materials from '@margoengine/materials';
import { alphaHash } from '@margoengine/materials/alpha-hash';
import { eye } from '@margoengine/materials/eye';
import { layered } from '@margoengine/materials/layered';
import { NodeMaterial, uniform, vec3, texture, positionLocal, storage } from '@margoengine/shader';
import { LightingMaterial } from '@margoengine/shader/lighting';
import { RawShaderMaterial } from '@margoengine/shader/raw';
import { captureMaterials, restoreMaterials } from '../dist/materials.js';
const json = (v) => JSON.parse(JSON.stringify(v));
const pixels = () =>
  new materials.Texture({ data: new Uint8Array([128, 64, 32, 255]), width: 1, height: 1 }, { wrapS: 'repeat' });
test('all mesh material kinds, dormant lobes, UV rows, shared textures and live colours round trip', async () => {
  const values = { core: new CoreMaterial() };
  for (const name of [
    'Material',
    'UnlitMaterial',
    'LambertMaterial',
    'PhongMaterial',
    'ToonMaterial',
    'PbrMaterial',
    'NormalMaterial',
    'MatcapMaterial',
    'DepthMaterial',
    'DistanceMaterial',
    'ShadowCatcherMaterial',
  ])
    values[name] = new materials[name]();
  const map = pixels();
  for (const value of Object.values(values))
    if (value instanceof materials.Material) {
      value.map = map;
      value.color = [0.1, 0.2, 0.3];
      value.emissive = [0.2, 0.1, 0.4];
      value.setUVTransform({ offset: [0.3, 0.4], rotation: 0.7, scale: [2, 3] }, 'map');
    }
  values.PbrMaterial.clearcoat = 0.4;
  values.PbrMaterial.transmission = 0.2;
  values.PbrMaterial.attenuationDistance = Infinity;
  values.PhongMaterial.shininess = 79;
  values.DistanceMaterial.farDistance = 52;
  const archive = json(await captureMaterials(values));
  const restored = await restoreMaterials(archive);
  assert.deepEqual(await captureMaterials(restored), archive);
  for (const [key, value] of Object.entries(values)) {
    assert.equal(restored[key].constructor, value.constructor, key);
    if (value instanceof materials.Material) {
      assert.equal(restored[key].map, restored.Material.map);
      restored[key].color.set([0.3, 0.2, 0.1]);
      assert.equal(restored[key].color[0], 0.3);
    } else assert.deepEqual(restored[key].data, value.data);
  }
  restored.Material.map.source.data[0] = 0;
  assert.equal(map.source.data[0], 128);
});
test('WGSL, node and lighting parameters preserve compiled programs, live uniform sharing and texture bindings', async () => {
  const map = pixels(),
    tint = uniform([0.2, 0.4, 0.6], { name: 'tint' });
  const node = new NodeMaterial({
    colorNode: texture(map).rgb.mul(tint),
    positionNode: positionLocal.add(vec3(0, 0.2, 0)),
    roughnessNode: uniform(0.3),
  });
  const lighting = new LightingMaterial({ colorNode: tint, lightingNode: tint });
  const wgsl = new materials.WgslMaterial({
    wgsl: 'fn shade(i: Out, s: Surface) -> Surface { return s; }',
    uniforms: { tint: [1, 2, 3] },
    textures: { albedo: map },
  });
  const archive = json(await captureMaterials({ node, lighting, wgsl }));
  const restored = await restoreMaterials(archive);
  assert.equal(restored.node.constructor, NodeMaterial);
  assert.equal(restored.lighting.constructor, LightingMaterial);
  assert.equal(restored.node.fragmentCode, node.fragmentCode);
  assert.equal(restored.node.vertexCode, node.vertexCode);
  assert.equal(restored.node.program.declare(2), node.program.declare(2));
  const n = restored.node.program.members.find((m) => m.node?.name === 'tint').node;
  const l = restored.lighting.program.members.find((m) => m.node?.name === 'tint').node;
  assert.equal(n, l);
  n.value = [0.6, 0.5, 0.4];
  assert.deepEqual(l.value, [0.6, 0.5, 0.4]);
  assert.deepEqual(tint.value, [0.2, 0.4, 0.6]);
  assert.deepEqual(restored.wgsl.uniforms, wgsl.uniforms);
  assert.equal(
    restored.node.program.resources.find((r) => r.resource.source)?.resource.source,
    restored.wgsl.textures.albedo,
  );
});
test('feature options retain their private constants and live eye/layer values', async () => {
  const feature = eye({ pupil: 0.2 });
  feature.pupil = 0.55;
  feature.irisColor[0] = 0.7;
  const layers = layered({ layers: [{ color: [0.1, 0.2, 0.3], roughness: 0.4 }] });
  layers.layers[0].roughness = 0.8;
  const material = new materials.Material({ features: [alphaHash({ scale: 2, cutoff: 0.4 }), feature, layers] });
  const restored = await restoreMaterials(json(await captureMaterials({ material })));
  assert.deepEqual(
    restored.material.features.map((f) => f.serialization()),
    material.features.map((f) => f.serialization()),
  );
});
test('raw WGSL typed uniforms, custom render state and external binding factories remain lossless', async () => {
  const group = () => ({ layout: {}, group: {} });
  const raw = new RawShaderMaterial({
    vertexShader: '@vertex fn vertex()->@builtin(position) vec4f {return vec4f(0);}',
    fragmentShader: '@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}',
    uniforms: { scale: { type: 'vec4f', value: new Float32Array([1, 2, 3, 4]) } },
    groups: [group],
    blending: 'additive',
    transparent: true,
  });
  const archive = json(await captureMaterials({ raw }, { externalKey: (v) => (v === group ? 'group' : undefined) }));
  const restored = await restoreMaterials(archive, {
    resolveExternal: (key) => {
      assert.equal(key, 'group');
      return group;
    },
  });
  assert.equal(restored.raw.constructor, RawShaderMaterial);
  assert.equal(restored.raw.vertexShader, raw.vertexShader);
  assert.deepEqual(restored.raw.uniforms, raw.uniforms);
  assert.equal(restored.raw.blending, 'additive');
  await assert.rejects(() => captureMaterials({ raw }), { code: 'state' });
});
test('abort, invalid references and unknown kinds fail without partial results', async () => {
  const material = new materials.Material(),
    state = json(await captureMaterials({ material }));
  state.materials.material = { ref: 99999 };
  await assert.rejects(() => restoreMaterials(state), { code: 'state' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => captureMaterials({ material }, { signal: controller.signal }), { name: 'AbortError' });
});
test('cube textures and typed data retain exact bytes and kind', async () => {
  const cube = new materials.CubeTexture(
    Array.from({ length: 6 }, () => ({ data: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1 })),
  );
  const material = new materials.Material({ envMap: cube });
  const restored = await restoreMaterials(json(await captureMaterials({ material })));
  assert.ok(restored.material.envMap instanceof materials.CubeTexture);
  assert.equal(restored.material.envMap.dimension, 'cube');
  assert.deepEqual(restored.material.envMap.source.faces[0].data, cube.source.faces[0].data);
});

test('implicit alphaHash cutoff ownership survives capture and feature removal', async () => {
  const material = new materials.Material({ features: [alphaHash({ cutoff: 0.4 })] });
  const restored = await restoreMaterials(json(await captureMaterials({ material })));
  assert.equal(restored.material.alphaTest, 0.4);
  material.features = [];
  restored.material.features = [];
  assert.equal(restored.material.alphaTest, material.alphaTest);
  assert.equal(restored.material.alphaTest, 0);
});

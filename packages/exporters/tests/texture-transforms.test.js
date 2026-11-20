import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../dist/index.js';
import { sceneOfGLB } from '../dist/glb-scene.js';
import { readGLB } from './helpers.js';
import { atlas, quad } from './material-animation-fixture.js';

// KHR_texture_transform (Khronos, ratified) is allowed on every textureInfo, so every texture slot of a material
// carries its own transform. Only the base colour slot used to.
const slots = [
  ['baseColorTexture', (m) => m.pbrMetallicRoughness.baseColorTexture],
  ['metallicRoughnessTexture', (m) => m.pbrMetallicRoughness.metallicRoughnessTexture],
  ['normalTexture', (m) => m.normalTexture],
  ['occlusionTexture', (m) => m.occlusionTexture],
  ['emissiveTexture', (m) => m.emissiveTexture],
];
const transformOf = (i) => ({ offset: [0.125 * (i + 1), 0.25], scale: [2 + i, 3], rotation: 0.5 * i });

function materialWith(slotNames) {
  const material = { emissive: [1, 1, 1] };
  slotNames.forEach((name, i) => {
    material[name] = atlas;
    material[`${name}Transform`] = transformOf(i);
  });
  return material;
}

test('every texture slot writes its own KHR_texture_transform, and the file requires the extension', () => {
  const names = slots.map(([name]) => name),
    { json } = readGLB(exportGLB({ nodes: [{ geometry: quad, material: materialWith(names) }] }));
  slots.forEach(([name, pick], i) => {
    const info = pick(json.materials[0]);
    assert.ok(info, name);
    const expected = transformOf(i);
    assert.deepEqual(info.extensions.KHR_texture_transform.offset, expected.offset, name);
    assert.deepEqual(info.extensions.KHR_texture_transform.scale, expected.scale, name);
    assert.equal(info.extensions.KHR_texture_transform.rotation ?? 0, expected.rotation, name);
  });
  assert.ok(json.extensionsUsed.includes('KHR_texture_transform'));
  assert.deepEqual(json.extensionsRequired, ['KHR_texture_transform']);
});

test('a transform on one slot leaves the other slots alone, and round trips through a GLB read', () => {
  const material = { normalTexture: atlas, normalTextureTransform: { offset: [0.5, 0], scale: [2, 2] }, baseColorTexture: atlas },
    { json } = readGLB(exportGLB({ nodes: [{ geometry: quad, material }] }));
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions, undefined);
  assert.deepEqual(json.materials[0].normalTexture.extensions.KHR_texture_transform, {
    offset: [0.5, 0],
    scale: [2, 2],
  });
  const names = slots.map(([name]) => name),
    again = sceneOfGLB(exportGLB({ nodes: [{ geometry: quad, material: materialWith(names) }] })).scene,
    read = (again.nodes[0].primitives?.[0] ?? again.nodes[0]).material;
  names.forEach((name, i) => {
    assert.deepEqual(read[`${name}Transform`], transformOf(i), name);
  });
});

test('a slot transform without its texture, or with a bad value, is refused', () => {
  const one = (material) => () => exportGLB({ nodes: [{ geometry: quad, material }] });
  assert.throws(one({ normalTextureTransform: { offset: [0, 0], scale: [1, 1] } }), /normalTextureTransform needs/);
  assert.throws(
    one({ emissiveTexture: atlas, emissiveTextureTransform: { offset: [0, NaN], scale: [1, 1] } }),
    /Texture transform offset/,
  );
  assert.throws(
    one({
      occlusionTexture: atlas,
      occlusionTextureTransform: { offset: [0, 0], scale: [1, 1], rotation: Infinity },
    }),
    /rotation/,
  );
});

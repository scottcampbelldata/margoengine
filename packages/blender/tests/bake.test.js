// Node graph baking (tools/blender-addon/bake.py): a real Blender 5.2.3 export (tests/fixtures/bake.margo, made by
// tools/blender-addon/tests/blender_bake.py) whose procedural Principled material and Diffuse BSDF were baked to
// images at export. Each texel matches the node maths within the bounds bake-truth.js derives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';
import { bakeErrors } from './bake-truth.js';

const asset = decodeMargo(await readFile(new URL('./fixtures/bake.margo', import.meta.url)));
const byName = (name) => asset.document.materials.find((m) => m.name === name);

test('baked materials carry their channels as textures and their constants as factors', () => {
  const procedural = byName('Procedural'),
    painted = byName('Painted'),
    plain = byName('Plain');
  for (const material of [procedural, painted]) {
    const pbr = material.pbrMetallicRoughness;
    assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture, `${material.name} lost its baked images`);
    // The images hold the values, so the factors must not scale them.
    assert.deepEqual(pbr.baseColorFactor, [1, 1, 1, 1]);
    assert.equal(pbr.metallicFactor, 1);
    assert.equal(pbr.roughnessFactor, 1);
    assert.equal(material.alphaMode, undefined, `${material.name} is opaque`);
    assert.equal(material.normalTexture, undefined, 'no normal input, so no normal bake');
    assert.equal(material.emissiveTexture, undefined, 'no emission, so no emission bake');
  }
  // A direct Principled BSDF is not baked: it keeps its constants and adds no image.
  assert.equal(plain.pbrMetallicRoughness.baseColorTexture, undefined);
  assert.ok(Math.abs(plain.pbrMetallicRoughness.roughnessFactor - 0.7) < 1e-6);
  assert.equal(asset.images.length, 4, 'two images for each of the two baked materials');
  for (const texture of asset.document.textures)
    assert.deepEqual(asset.document.samplers[texture.sampler], { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729 });
});

test('every baked texel matches the node maths of its UV coordinates', async () => {
  const { size, errors, bounds } = await bakeErrors(asset);
  assert.equal(size, 32, 'the fixture bakes at 32 x 32');
  for (const channel of ['r', 'g', 'b'])
    assert.ok(errors[channel] <= bounds.color, `base colour ${channel} is off by ${errors[channel]} (bound ${bounds.color})`);
  for (const channel of ['roughness', 'metallic'])
    assert.ok(errors[channel] <= bounds.linear, `${channel} is off by ${errors[channel]} (bound ${bounds.linear})`);
  // glTF reads roughness from green and metallic from blue; red (occlusion) stays 0.
  assert.equal(errors.occlusion, 0);
  assert.ok(errors.painted <= bounds.constant, `the Diffuse BSDF's albedo is off by ${errors.painted}`);
  // Cycles' roughness pass reports 1 for a Diffuse BSDF (Lambertian): measured in Blender 5.2.3, not assumed.
  assert.equal(errors.paintedRoughness, 0);
});

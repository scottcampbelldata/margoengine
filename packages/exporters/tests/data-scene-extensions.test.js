// Data-scene glTF/GLB: per-texture samplers, KHR_materials_unlit, cameras and KHR_lights_punctual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportGLB, exportGLTF } from '../dist/index.js';
import { readGLB, validate, validator } from './helpers.js';

const needsValidator = validator ? {} : { skip: 'gltf-validator not installed' };
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 1, 1, 1, 1, 0, 0, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
async function png() {
  const { json, bin } = readGLB(new Uint8Array(await readFile(new URL('./fixtures/BoxTextured.glb', import.meta.url))));
  const view = json.bufferViews[json.images[0].bufferView];
  return bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

test('data-scene textures keep their sampler; the default sampler is unchanged', needsValidator, async () => {
  const image = await png(),
    smooth = { image, mimeType: 'image/png' },
    pixel = {
      image,
      mimeType: 'image/png',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmaps: false,
      wrapS: 'clamp',
      wrapT: 'mirror',
    };
  const scene = {
    nodes: [
      { geometry: quad, material: { baseColorTexture: smooth } },
      { geometry: quad, material: { baseColorTexture: pixel, metallicRoughnessTexture: { ...pixel } } },
    ],
  };
  const glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.equal(json.images.length, 1, 'one image for shared bytes');
  assert.deepEqual(json.samplers, [
    { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
    { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33648 },
  ]);
  assert.deepEqual(
    json.textures.map((t) => t.sampler),
    [0, 1, 1],
  );
  assert.equal(json.extensionsUsed, undefined);
  const mipNearest = exportGLTF({
    nodes: [{ geometry: quad, material: { baseColorTexture: { image, mimeType: 'image/png', minFilter: 'nearest' } } }],
  });
  assert.equal(mipNearest.json.samplers[0].minFilter, 9984);
});

test('unlit materials, cameras and punctual lights round-trip through the GLB JSON', needsValidator, async () => {
  const sun = { type: 'directional', color: [1, 0.9, 0.8], intensity: 3 },
    lamp = { type: 'point', name: 'lamp', color: [1, 1, 1], intensity: 20, range: 8 },
    spot = { type: 'spot', color: [0, 0, 1], intensity: 5, innerConeAngle: 0.2, outerConeAngle: 0.6 };
  const scene = {
    nodes: [
      { name: 'tile', geometry: quad, material: { name: 'flat', color: [1, 0, 0], unlit: true } },
      { name: 'sun', rotation: [-0.7071068, 0, 0, 0.7071068], light: sun },
      { name: 'lamps', children: [{ light: lamp, translation: [0, 2, 0] }, { light: lamp }, { light: spot }] },
      {
        name: 'eye',
        translation: [0, 1, 5],
        camera: { type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, zfar: 100, aspectRatio: 1.5 } },
      },
      {
        name: 'top',
        camera: { type: 'orthographic', name: 'Top', orthographic: { xmag: 4, ymag: 3, znear: 0, zfar: 50 } },
      },
    ],
  };
  const glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(json.extensionsUsed, ['KHR_materials_unlit', 'KHR_lights_punctual']);
  assert.equal(json.extensionsRequired, undefined);
  assert.deepEqual(json.materials[0].extensions, { KHR_materials_unlit: {} });
  assert.deepEqual(json.extensions.KHR_lights_punctual.lights, [
    { type: 'directional', color: [1, 0.9, 0.8], intensity: 3 },
    { name: 'lamp', type: 'point', color: [1, 1, 1], intensity: 20, range: 8 },
    { type: 'spot', color: [0, 0, 1], intensity: 5, spot: { innerConeAngle: 0.2, outerConeAngle: 0.6 } },
  ]);
  const byName = (name) => json.nodes.find((n) => n.name === name);
  assert.deepEqual(byName('sun').extensions, { KHR_lights_punctual: { light: 0 } });
  const lamps = byName('lamps').children.map((i) => json.nodes[i].extensions.KHR_lights_punctual.light);
  assert.deepEqual(lamps, [1, 1, 2], 'a shared light object is written once');
  assert.deepEqual(json.cameras, [
    { type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, zfar: 100, aspectRatio: 1.5 } },
    { name: 'Top', type: 'orthographic', orthographic: { xmag: 4, ymag: 3, znear: 0, zfar: 50 } },
  ]);
  assert.equal(byName('eye').camera, 0);
  assert.equal(byName('top').camera, 1);
  assert.deepEqual(exportGLTF(scene).json.extensions, json.extensions);
});

test('invalid samplers, unlit flags, cameras and lights throw before writing', () => {
  const image = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0),
    texture = (extra) => ({
      nodes: [{ geometry: quad, material: { baseColorTexture: { image, mimeType: 'image/png', ...extra } } }],
    });
  assert.throws(() => exportGLB(texture({ magFilter: 'cubic' })), {
    name: 'TypeError',
    message: /magFilter must be nearest or linear/,
  });
  assert.throws(() => exportGLB(texture({ wrapT: 'border' })), TypeError);
  assert.throws(() => exportGLB(texture({ mipmaps: 1 })), TypeError);
  assert.throws(() => exportGLB({ nodes: [{ geometry: quad, material: { unlit: 'yes' } }] }), TypeError);
  assert.throws(() => exportGLB({ nodes: [{ light: 'sun' }] }), TypeError);
  assert.throws(() => exportGLB({ nodes: [{ light: { type: 'area', color: [1, 1, 1], intensity: 1 } }] }), TypeError);
  assert.throws(() => exportGLB({ nodes: [{ light: { type: 'point', color: [1, 1], intensity: 1 } }] }), TypeError);
  assert.throws(
    () => exportGLB({ nodes: [{ light: { type: 'point', color: [1, 1, 1], intensity: -1 } }] }),
    RangeError,
  );
  const cone = { type: 'spot', color: [1, 1, 1], intensity: 1, innerConeAngle: 0.5, outerConeAngle: 0.4 };
  assert.throws(() => exportGLB({ nodes: [{ light: cone }] }), RangeError);
  assert.throws(() => exportGLB({ nodes: [{ camera: { type: 'perspective' } }] }), TypeError);
  assert.throws(
    () => exportGLB({ nodes: [{ camera: { type: 'perspective', perspective: { yfov: 0, znear: 0.1 } } }] }),
    RangeError,
  );
  assert.throws(
    () =>
      exportGLB(
        { nodes: [{ geometry: quad }, { light: { type: 'point', color: [1, 1, 1], intensity: 1 } }] },
        { flatten: true },
      ),
    /Flatten does not support cameras or lights/,
  );
});

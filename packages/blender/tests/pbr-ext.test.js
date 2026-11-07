// @margoengine/blender/pbr-ext: a real Blender 5.2.3 export (tests/fixtures/pbr-ext.margo, made by
// tools/blender-addon/tests/blender_pbr_ext.py) whose Principled BSDFs use transmission, IOR, coat, sheen and
// subsurface. The add-on writes them as glTF material extensions with the values Blender holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';
import { margoMaterialExtensions, parseMargoPBR } from '../dist/pbr-ext.js';

const bytes = await readFile(new URL('./fixtures/pbr-ext.margo', import.meta.url));
const asset = decodeMargo(bytes);
const extensions = (name) => asset.document.materials.find((m) => m.name === name).extensions;
/** Blender holds its sockets as float32, so a value set as 0.05 reads back within float32 rounding. */
const close = (actual, expected, label) => {
  if (Array.isArray(expected)) return expected.forEach((e, i) => close(actual[i], e, `${label}[${i}]`));
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} is not ${expected}`);
};

test('transmission and IOR become KHR_materials_transmission and KHR_materials_ior', () => {
  const glass = extensions('Glass');
  close(glass.KHR_materials_transmission.transmissionFactor, 1, 'transmission');
  close(glass.KHR_materials_ior.ior, 1.45, 'glass IOR');
  close(extensions('Gem').KHR_materials_ior.ior, 2.4, 'gem IOR');
  assert.equal(extensions('Gem').KHR_materials_transmission, undefined, 'an opaque gem has no transmission');
  // IOR 1.5 is glTF's default, so a plain material carries no extension at all.
  assert.equal(extensions('Backdrop'), undefined);
});

test('a baked material keeps its transmission', () => {
  const frosted = asset.document.materials.find((m) => m.name === 'Frosted');
  assert.ok(frosted.pbrMetallicRoughness.metallicRoughnessTexture, 'its procedural roughness was baked');
  close(frosted.extensions.KHR_materials_transmission.transmissionFactor, 1, 'transmission');
});

test('coat and sheen become KHR_materials_clearcoat and KHR_materials_sheen', () => {
  const coat = extensions('Coat').KHR_materials_clearcoat;
  close(coat.clearcoatFactor, 1, 'coat');
  close(coat.clearcoatRoughnessFactor, 0.05, 'coat roughness');
  const sheen = extensions('Velvet').KHR_materials_sheen;
  close(sheen.sheenColorFactor, [0.4, 0.1, 0.6], 'sheen colour (tint times weight 1)');
  close(sheen.sheenRoughnessFactor, 0.3, 'sheen roughness');
});

test('subsurface becomes diffuse transmission into a scattering volume with the radius as mean free path', () => {
  const skin = extensions('Skin');
  close(skin.KHR_materials_diffuse_transmission.diffuseTransmissionFactor, 1, 'subsurface weight');
  close(skin.KHR_materials_diffuse_transmission.diffuseTransmissionColorFactor, [0.8, 0.5, 0.4], 'albedo');
  close(skin.KHR_materials_volume_scatter.multiscatterColorFactor, [0.8, 0.5, 0.4], 'multi-scatter albedo');
  // Radius (1, 0.2, 0.1) times scale 0.05 m: mean free paths 0.05, 0.01 and 0.005 m. One distance d = 0.05 m and
  // colours exp(-d / r) give each channel the extinction 1 / r: -ln(colour) / d.
  const volume = skin.KHR_materials_volume;
  close(volume.attenuationDistance, 0.05, 'attenuation distance');
  close(volume.thicknessFactor, 0.05, 'thickness');
  const paths = volume.attenuationColor.map((c) => -volume.attenuationDistance / Math.log(c));
  close(paths, [0.05, 0.01, 0.005], 'mean free paths');
});

test('the manifest lists the extensions it uses, all of which pbr-ext loads', () => {
  const used = new Set(asset.document.materials.flatMap((m) => Object.keys(m.extensions ?? {})));
  assert.deepEqual(asset.document.extensionsUsed, [...used].sort());
  for (const name of used) assert.ok(margoMaterialExtensions.includes(name), `${name} is not loaded by pbr-ext`);
});

test('parseMargoPBR decodes before any GPU work and honours an aborted signal', async () => {
  const reason = new Error('stop');
  await assert.rejects(parseMargoPBR({}, bytes, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  await assert.rejects(parseMargoPBR({}, new Uint8Array(8)), /Invalid \.margo size/);
});

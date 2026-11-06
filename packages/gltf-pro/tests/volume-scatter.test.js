// KHR_materials_volume_scatter (draft) in the extended shader: the maths, the real Khronos material, and what stays off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extendedMaterials } from '../dist/extended.js';
import { scatterExtinction, scatterShares, volumeScatterWgsl } from '../../shared/volume-scatter.js';

const skull = JSON.parse(readFileSync(new URL('./fixtures/scatter/ScatteringSkull.gltf', import.meta.url), 'utf8'));
const dense = (extra = {}) => ({
  KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: 1 },
  KHR_materials_volume: { attenuationColor: [0.5, 0.5, 0.5], attenuationDistance: 0.1, thicknessFactor: 1 },
  KHR_materials_volume_scatter: { multiscatterColorFactor: [0.5, 0.25, 0.75] },
  ...extra,
});

test('the albedo mapping has the end points of the spec: no multi-scatter colour scatters nothing, white scatters all', () => {
  // m = 0: d = 4.09712 - sqrt(9.59217) = 1, so rho_ss = 0 and sigma_s = 0.
  assert.ok(scatterShares(10, 0, 0, 1)[0] < 1e-4);
  // m = 1: d is about 0, so rho_ss = 1 and all of sigma_t scatters: 1 - exp(-10 x), here x = 0.1.
  assert.ok(Math.abs(scatterShares(10, 1, 0, 0.1)[0] - (1 - Math.exp(-1))) < 1e-6);
  // Crossing with no anisotropy is the spec's T = exp(-sigma_t x) whatever the colour.
  for (const m of [0, 0.2, 0.5, 0.9, 1]) assert.ok(Math.abs(scatterShares(10, m, 0, 0.1)[1] - Math.exp(-1)) < 1e-6);
});

test('anisotropy scales the scattering by 1 - g, up to the extinction', () => {
  const [plain] = scatterShares(10, 1, 0, 0.1),
    [forward] = scatterShares(10, 1, 0.5, 0.1),
    [none] = scatterShares(10, 1, 1, 0.1),
    [back] = scatterShares(10, 1, -1, 0.1);
  assert.ok(Math.abs(forward - (1 - Math.exp(-0.5))) < 1e-6);
  assert.equal(none, 0);
  // Twice sigma_s would pass sigma_t here; it stops there, or the shares could add to more than the light that entered.
  assert.ok(Math.abs(back - plain) < 1e-9);
});

test('no light is made: the scattered lobe plus what goes on through stays within what entered', () => {
  for (const m of [0, 0.1, 0.5, 0.9, 1])
    for (const g of [-1, -0.5, 0, 0.5, 1])
      for (const x of [0, 0.01, 0.1, 1, 100]) {
        const [w, keep] = scatterShares(20, m, g, x);
        // Diffuse transmission takes `keep`; specular transmission takes Beer-Lambert over the same depth.
        assert.ok(m * w + keep <= 1 + 1e-12, `m ${m} g ${g} x ${x}`);
        assert.ok(m * w + Math.exp(-20 * x) <= 1 + 1e-12, `m ${m} g ${g} x ${x}`);
      }
});

test('extinction is -log(c) / d, none without a distance, and stays finite on a black channel', () => {
  assert.ok(Math.abs(scatterExtinction(0.5, 2) - Math.LN2 / 2) < 1e-12);
  assert.equal(scatterExtinction(0.5, Infinity), 0);
  assert.ok(Number.isFinite(Math.fround(scatterExtinction(0, Number.MIN_VALUE))));
});

test('the real Khronos ScatteringSkull material reads as the file states', () => {
  const material = skull.materials[0],
    x = extendedMaterials.parse(material.extensions),
    volume = material.extensions.KHR_materials_volume,
    scatter = material.extensions.KHR_materials_volume_scatter;
  assert.equal(x.features.scatter, true);
  assert.equal(x.features.diffuseTransmission, true);
  // Slots 13-20 are maps 0-7 here: the thickness map in the last one, no colour map in this file.
  assert.equal(x.maps[6], undefined);
  assert.equal(x.maps[7].index, volume.thicknessTexture.index);
  assert.deepEqual(x.rows.slice(16, 19), scatter.multiscatterColorFactor);
  assert.equal(x.rows[19], 0);
  const extinction = volume.attenuationColor.map((c) => -Math.log(c) / volume.attenuationDistance);
  assert.deepEqual(x.rows.slice(20, 23), extinction);
  assert.equal(x.rows[23], volume.thicknessFactor);
});

test('only a medium that light enters scatters', () => {
  const on = (e) => !!extendedMaterials.parse(e)?.features.scatter;
  assert.equal(on(dense()), true);
  assert.equal(
    on({ ...dense({ KHR_materials_transmission: { transmissionFactor: 0.5 } }), KHR_materials_diffuse_transmission: undefined }),
    true,
  );
  assert.equal(on({ ...dense(), KHR_materials_diffuse_transmission: undefined }), false, 'nothing enters');
  assert.equal(on({ ...dense(), KHR_materials_volume: undefined }), false, 'needs KHR_materials_volume');
  const volume = (change) => dense({ KHR_materials_volume: { ...dense().KHR_materials_volume, ...change } });
  assert.equal(on(volume({ thicknessFactor: 0 })), false, 'thin walled');
  assert.equal(on(volume({ attenuationDistance: undefined })), false, 'no extinction');
  assert.equal(on(dense({ KHR_materials_volume_scatter: {} })), false, 'default colour is black');
  assert.equal(extendedMaterials.parse({ KHR_materials_volume_scatter: { multiscatterColorFactor: [1, 1, 1] } }), undefined);
});

test('a bad value is refused with its fix', () => {
  assert.throws(() => extendedMaterials.parse(dense({ KHR_materials_volume_scatter: { multiscatterColorFactor: [2, 0, 0] } })), /multi-scatter color/);
  assert.throws(() => extendedMaterials.parse(dense({ KHR_materials_volume_scatter: { multiscatterColorFactor: [1, 0] } })), /multi-scatter color/);
  assert.throws(
    () => extendedMaterials.parse(dense({ KHR_materials_volume_scatter: { multiscatterColorFactor: [1, 0, 0], scatterAnisotropy: 1.5 } })),
    /scatter anisotropy/,
  );
});

test('the WGSL is in the shader only for a material that scatters', () => {
  const plan = (scatter) =>
      extendedMaterials.plan(Array(21).fill(undefined), {
        iridescence: false,
        anisotropy: false,
        diffuseTransmission: true,
        scatter,
      }),
    on = extendedMaterials.shader(plan(true)),
    off = extendedMaterials.shader(plan(false));
  assert.ok(on.includes(volumeScatterWgsl) && on.includes('s.sc='));
  assert.ok(!off.includes('margoScatterShares') && !off.includes('s.sc'));
});

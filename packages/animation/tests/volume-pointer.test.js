import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { liveVolume } from '../../../tests/support/live-volume.js';

for (const thicknessFactor of [0, 2, 1200]) test(`zero transmission activates and returns to opaque at thickness ${thicknessFactor}`, async (t) => {
  const { model, material, draw } = await liveVolume(t, { thicknessFactor }, {
    initialTransmission: 0, extension: 'KHR_materials_transmission', property: 'transmissionFactor',
    type: 'SCALAR', values: [0, 1],
  });
  const original = structuredClone(model.asset.doc);
  assert.equal(material.tint, undefined);
  draw(); // Populate the opaque draw memo before changing the material's structure.
  const animation = new Animation(model, { pointers: pointerChannels, loop: false });
  assert.deepEqual(animation.warnings, []);
  for (const time of [0.5, 1, 0, 1]) {
    animation.seek(time);
    const depths = [Math.log(4) * thicknessFactor / 2, Math.log(2) * thicknessFactor / 2, 0];
    if (time === 0) {
      assert.equal(material.tint, undefined);
      draw();
    }
    else {
      assert.deepEqual(material.tint, [0.25, 0.5, 1].map((c) => time * c ** (thicknessFactor / 2)));
      assert.deepEqual(material.opticalDepth, depths);
      assert.deepEqual(draw(), depths.map(Math.fround));
    }
  }
  assert.deepEqual(model.asset.doc, original);
});

const cases = [
  { property: 'attenuationColor', type: 'VEC3', values: [0.25, 0.5, 1, 1, 0, 0.25], color: [1, 0, 0.25], thickness: 2, distance: 2 },
  { property: 'thicknessFactor', type: 'SCALAR', values: [2, 4], color: [0.25, 0.5, 1], thickness: 4, distance: 2 },
  { property: 'attenuationDistance', type: 'SCALAR', values: [2, 4], color: [0.25, 0.5, 1], thickness: 2, distance: 4 },
  { property: 'thicknessFactor', type: 'SCALAR', values: [2, 1200], color: [0.25, 0.5, 1], thickness: 1200, distance: 2 },
  { property: 'thicknessFactor', type: 'SCALAR', values: [2, 0], initialColor: [0, 0.5, 1], color: [0, 0.5, 1], thickness: 0, distance: 2 },
];
for (const row of cases) test(`volume pointer ${row.property} reaches the tint draw at thickness ${row.thickness}`, async (t) => {
  const { model, material, draw } = await liveVolume(t, { attenuationColor: row.initialColor ?? [0.25, 0.5, 1] }, row);
  const animation = new Animation(model, { pointers: pointerChannels, loop: false });
  const original = structuredClone(model.asset.doc);
  animation.seek(1);
  const depth = row.thickness / row.distance,
    transmittance = row.color.map((c) => c === 1 ? 1 : c ** depth),
    opticalDepth = row.color.map((c) => c === 1 || depth === 0 ? 0 : -Math.log(c) * depth);
  assert.deepEqual(material.attenuation, transmittance);
  assert.deepEqual(material.opticalDepth, opticalDepth);
  assert.deepEqual(material.tint, transmittance);
  assert.deepEqual(material.volume, [row.thickness, ...row.color.map((c) => c === 1 ? 1 : c ** (1 / row.distance))]);
  assert.deepEqual(draw(), opticalDepth.map((v) => v === Infinity ? -1 : Math.fround(v)));
  assert.deepEqual(model.asset.doc, original, 'playing channels does not rewrite the source asset');
  animation.seek(0);
  assert.deepEqual(material.opticalDepth, (original.materials[0].extensions.KHR_materials_volume.attenuationColor)
    .map((c) => c === 1 ? 0 : -Math.log(c)));
});

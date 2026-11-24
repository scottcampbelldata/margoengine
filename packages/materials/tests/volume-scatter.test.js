// KHR_materials_volume_scatter (draft) through createTransmission and install: the screen-space transmission path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransmission, validateTransmission } from '../dist/transmission.js';

const opaqueColor = { label: 'opaque' };
const volume = (extra = {}) => ({
  thicknessFactor: 2,
  attenuationColor: [0.5, 0.25, 1],
  attenuationDistance: 4,
  multiscatterColorFactor: [0.6, 0.5, 0.4],
  scatterAnisotropy: 0.25,
  ...extra,
});

test('the factors hold the colour, the anisotropy and the extinction after the transmission rows', () => {
  const extension = createTransmission({ factor: 1, opaqueColor, volume: volume() }),
    rows = Array.from(extension.factors);
  assert.equal(rows.length, 16);
  assert.deepEqual(rows.slice(8, 12).map((v) => +v.toFixed(6)), [0.6, 0.5, 0.4, 0.25]);
  // -log(c) / d, and none on the white channel.
  assert.deepEqual(rows.slice(12, 15).map((v) => +v.toFixed(6)), [+(Math.LN2 / 4).toFixed(6), +(Math.LN2 / 2).toFixed(6), 0]);
  assert.match(extension.direct, /materialScatterLobe/);
  assert.match(extension.ambient, /materialScatterLobe/);
  assert.match(extension.declarations, /fn margoScatterShares\(/);
});

test('the view through keeps its Beer-Lambert term: the extinction goes to the lobe alone', () => {
  const plain = createTransmission({ factor: 1, opaqueColor, volume: volume({ multiscatterColorFactor: undefined }) }),
    scattered = createTransmission({ factor: 1, opaqueColor, volume: volume() });
  assert.equal(scattered.output, plain.output);
  assert.deepEqual(Array.from(scattered.factors.slice(0, 8)), Array.from(plain.factors));
});

test('nothing changes where nothing can scatter', () => {
  for (const change of [
    { multiscatterColorFactor: undefined },
    { multiscatterColorFactor: [0, 0, 0] },
    { thicknessFactor: 0 },
    { attenuationDistance: undefined },
    { attenuationColor: [1, 1, 1] },
  ]) {
    const extension = createTransmission({ factor: 1, opaqueColor, volume: volume(change) });
    assert.equal(extension.factors.length, 8, JSON.stringify(change));
    assert.equal(extension.direct, undefined);
    assert.ok(!extension.declarations.includes('margoScatterShares'));
  }
});

test('a colour map takes a texture slot, and a lobe of a base extension stays', () => {
  const view = { label: 'map' },
    extension = createTransmission(
      { factor: 1, opaqueColor, volume: volume({ multiscatterColorTexture: { view } }) },
      { direct: 'direct*=1.0;', ambient: 'materialAmbient*=1.0;' },
    );
  assert.equal(extension.textures.at(-1).view, view);
  assert.match(extension.declarations, /materialTexture1/);
  assert.match(extension.direct, /^direct\*=1\.0;\n/);
  assert.match(extension.ambient, /^materialAmbient\*=1\.0;\n/);
});

test('bad values are refused', () => {
  assert.throws(() => validateTransmission({ factor: 1, volume: volume({ multiscatterColorFactor: [1, 2, 0] }) }), /multi-scatter/);
  assert.throws(() => validateTransmission({ factor: 1, volume: volume({ scatterAnisotropy: -2 }) }), /scatter anisotropy/);
});

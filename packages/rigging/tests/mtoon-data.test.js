import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMToon, mtoonShading } from '../src/mtoon-data.ts';

test('MToon defaults and author-owned arrays remain independent', () => {
  const input = {
    specVersion: '1.0',
    shadeColorFactor: [0.2, 0.3, 0.4],
    shadingShiftTexture: { index: 0, scale: 0.5 },
  };
  const value = normalizeMToon(input);
  assert.equal(value.shadingToonyFactor, 0.9);
  assert.equal(value.giEqualizationFactor, 0.9);
  assert.equal(value.outlineWidthMode, 'none');
  assert.equal(value.transparentWithZWrite, false);
  value.shadeColorFactor[0] = 0.8;
  value.shadingShiftTexture.scale = 0.25;
  assert.equal(input.shadeColorFactor[0], 0.2);
  assert.equal(input.shadingShiftTexture.scale, 0.5);
});
test('MToon scalar validation preserves strict authored ranges', () => {
  for (const field of [
    'shadingToonyFactor',
    'giEqualizationFactor',
    'rimLightingMixFactor',
    'outlineLightingMixFactor',
  ])
    for (const value of [-0.001, 1.001, NaN, Infinity, '0.5'])
      assert.throws(() => normalizeMToon({ specVersion: '1.0', [field]: value }));
  for (const field of ['outlineWidthFactor', 'parametricRimFresnelPowerFactor'])
    assert.throws(() => normalizeMToon({ specVersion: '1.0', [field]: -0.001 }));
  for (const value of [-10, 10, 0.5])
    assert.throws(() => normalizeMToon({ specVersion: '1.0', renderQueueOffsetNumber: value }));
  for (const value of [null, {}, { specVersion: '0.0' }, { specVersion: '1.0', outlineWidthMode: 'pixels' }])
    assert.throws(() => normalizeMToon(value));
});
test('the MToon transition spans both negative and positive light cosines', () => {
  assert.equal(mtoonShading(-1, 0, 0), 0);
  assert.equal(mtoonShading(0, 0, 0), 0.5);
  assert.equal(mtoonShading(1, 0, 0), 1);
  assert.equal(mtoonShading(-0.5, 0.5, 0.5), 0.5);
  assert.equal(mtoonShading(-1e-8, 0, 1), 0);
  assert.equal(mtoonShading(0, 0, 1), 1);
  assert.equal(mtoonShading(1e-8, 0, 1), 1);
  for (const toony of [0, 0.25, 0.9, 1]) {
    let previous = -1;
    for (let k = 0; k <= 200; k++) {
      const value = mtoonShading(k / 100 - 1, 0.25, toony);
      assert.ok(value >= previous && value >= 0 && value <= 1);
      previous = value;
    }
  }
});

test('texture transforms reject non-finite channels while retaining zero and reflected scales', () => {
  for (const transform of [
    { offset: [0, NaN] },
    { scale: [1, Infinity] },
    { rotation: NaN },
    { offset: [1] },
    { texCoord: 4 },
    null,
  ])
    assert.throws(() =>
      normalizeMToon({
        specVersion: '1.0',
        shadeMultiplyTexture: { index: 0, extensions: { KHR_texture_transform: transform } },
      }),
    );
  const value = normalizeMToon({
    specVersion: '1.0',
    shadingShiftFactor: 8,
    parametricRimLiftFactor: -8,
    shadeMultiplyTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [0, -1] } } },
  });
  assert.deepEqual(value.shadeMultiplyTexture.extensions.KHR_texture_transform.scale, [0, -1]);
});

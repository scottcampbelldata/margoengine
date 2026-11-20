import test from 'node:test';
import assert from 'node:assert/strict';
import { liveVolume } from '../../../tests/support/live-volume.js';

test('parsed optical depth follows channel edits and array replacement without losing untouched precision', async (t) => {
  const { material, draw } = await liveVolume(t, { thicknessFactor: 1200, attenuationDistance: 1 });
  const redDepth = Math.log(4) * 1200;
  assert.equal(material.attenuation[0], 0, 'load transmittance underflows but its optical depth must remain finite');
  assert.equal(material.opticalDepth[0], redDepth);
  material.attenuation[1] = 0.125;
  assert.deepEqual(material.opticalDepth, [redDepth, Math.log(8), 0]);
  assert.deepEqual(draw(), [redDepth, Math.log(8), 0].map(Math.fround));
  material.attenuation[0] = 1;
  material.attenuation[2] = 0;
  assert.deepEqual(draw(), [0, Math.fround(Math.log(8)), -1]);
  material.attenuation = [0.5, 0.25, 1];
  assert.deepEqual(draw(), [Math.log(2), Math.log(4), 0].map(Math.fround));
  material.attenuation = [0, 0, 1];
  assert.deepEqual(draw(), [-1, -1, 0], 'replacing an array also invalidates a matching underflow zero');
  material.opticalDepth = undefined;
  material.attenuation = [1, 0.5, 0.25];
  assert.deepEqual(draw(), [0, Math.log(2), Math.log(4)].map(Math.fround));
});

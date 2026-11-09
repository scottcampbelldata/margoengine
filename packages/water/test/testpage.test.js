import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const folding = (e) =>
  e.name === 'MargoError' && e.code === 'failed' && /fold.*https:\/\/margoengine.com\/errors#geometry/.test(e.message);
test('island steep wave is rejected without changing authored input, with a code and help link', () => {
  const waves = [{ direction: [1, 0], amplitude: 5, wavelength: 20, steepness: 0.8 }];
  const saved = structuredClone(waves);
  assert.throws(() => Water.attach(optionalGPU().engine, { waves }), folding);
  assert.deepEqual(waves, saved);
  const water = new Water({ waves: [{ direction: [1, 0], amplitude: 0.1, wavelength: 20, steepness: 0.8 }] });
  assert.throws(() => water.setWaveHeight(5), folding);
  water.dispose();
});

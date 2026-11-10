import test from 'node:test';
import assert from 'node:assert/strict';
import { Underwater } from '../dist/underwater.js';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';

test('underwater validates its surface and medium settings before allocating GPU resources', () => {
  assert.throws(() => new Underwater(), { code: 'state' });
  assert.throws(() => new Underwater({ surface: {} }), { code: 'state' });
  for (const surface of [new Water(), new FFTOcean()]) {
    for (const [key, values] of Object.entries({
      anisotropy: [-1, 1, NaN],
      shafts: [-0.1, 10.1, Infinity],
      steps: [0, 2.5, 129],
      shaftDistance: [0, 10001],
      maxDistance: [0.05, 100001],
      shaftExtent: [0.5, 10001],
      resolution: [8, 48, 2048, 64.5],
      waterline: [-1, 65],
      refractiveIndex: [0.99, 2.01],
      absorption: [[-1, 0, 0], [0, NaN, 0], [0, 0], [101, 0, 0], 'red'],
      scattering: [
        [0, 0, -0.1],
        [0, 0],
      ],
    }))
      for (const value of values)
        assert.throws(() => new Underwater({ surface, [key]: value }), RangeError, `${key}: ${value}`);
    assert.throws(() => new Underwater({ surface, enabled: 1 }), { code: 'state' });
    // Typed arrays are accepted channel lists.
    new Underwater({ surface, absorption: new Float32Array([0.1, 0.2, 0.3]) }).dispose();
    const effect = new Underwater({ surface });
    assert.throws(() => effect.setup({}), { code: 'state' });
    assert.equal(effect.joinStack({}).kind, 'hdr');
    assert.throws(() => effect.joinStack({}), {
      code: 'attached',
      message: /create another Underwater for the other stack; see https:\/\/margoengine.com\/errors#state$/,
    });
    assert.throws(() => effect.setup({}), { code: 'unsupported' });
    effect.dispose();
    effect.dispose();
    assert.throws(() => effect.joinStack({}), { code: 'disposed' });
    surface.dispose();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Caustics } from '../dist/caustics.js';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';

test('caustics validates source and physical map settings before allocating GPU resources', () => {
  assert.throws(() => new Caustics(), { code: 'state' });
  assert.throws(() => new Caustics({ surface: {} }), { code: 'state' });
  for (const surface of [new Water(), new FFTOcean()]) {
    for (const [key, values] of Object.entries({
      size: [0, -1, Infinity],
      resolution: [16, 63, 4096],
      layers: [1, 2.5, 33],
      intensity: [-1, Infinity, 101],
      refractiveIndex: [0.99, 2.01, NaN],
      heightRange: [[0, 0], [1, -1], [NaN, 0], [-100001, 0], [0], [1, 1 + 1e-10]],
      absorption: [
        [-1, 0, 0],
        [0, NaN, 0],
        [0, 0],
      ],
      color: [[101, 0, 0]],
    }))
      for (const value of values)
        assert.throws(() => new Caustics({ surface, [key]: value }), RangeError, `${key}: ${value}`);
    assert.throws(() => new Caustics({ surface, enabled: 1 }), { code: 'state' });
    assert.throws(() => new Caustics({ surface, shadows: {} }), { code: 'state' });
    const effect = new Caustics({ surface, intensity: 0 });
    assert.throws(() => effect.setup({}), { code: 'state' });
    const stage = effect.joinStack({});
    assert.equal(stage.kind, 'hdr');
    assert.throws(() => effect.joinStack({}), {
      code: 'attached',
      message: /create another Caustics for the other stack; see https:\/\/margoengine.com\/errors#state$/,
    });
    effect.engine = {};
    assert.throws(() => effect.setup({}), {
      code: 'attached',
      message: /create another Caustics for the other stack; see https:\/\/margoengine.com\/errors#state$/,
    });
    effect.engine = undefined;
    assert.throws(() => effect.setup({}), { code: 'unsupported' });
    effect.dispose();
    effect.dispose();
    assert.throws(() => effect.joinStack({}), { code: 'disposed' });
    surface.dispose();
  }
});

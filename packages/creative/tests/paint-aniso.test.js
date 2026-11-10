import test from 'node:test';
import assert from 'node:assert/strict';
import { AnisotropicPainterly } from '../dist/paint-aniso.js';
import { harness } from '../../post/test/support.js';
import { anisoReference } from './paint-aniso-reference.js';

test('anisotropic controls reject invalid values and preserve terminal lifecycle', () => {
  for (const options of [
    null,
    [],
    1,
    { radius: 0 },
    { radius: 9 },
    { radius: 1.1 },
    { strength: NaN },
    { strength: 2 },
    { anisotropy: -1 },
    { anisotropy: Infinity },
    { sharpness: 0 },
    { sharpness: 9 },
    { enabled: 1 },
  ])
    assert.throws(() => new AnisotropicPainterly(options), RangeError);
  const h = harness(),
    effect = AnisotropicPainterly.attach(h.engine);
  h.frame();
  effect.options.radius = NaN;
  assert.throws(() => h.frame(), RangeError);
  effect.options.radius = 3;
  effect.enabled = false;
  h.frame();
  effect.enabled = true;
  h.view.state.width = 18;
  h.view.state.height = 10;
  h.frame();
  h.engine.restore();
  h.frame();
  effect.dispose();
  effect.dispose();
  assert.throws(
    () => effect.setup(h.engine),
    (e) => e.code === 'disposed',
  );
});
test('the scalar tensor oracle preserves flat RGBA, copies exactly when disabled and changes noisy structure', () => {
  const flat = Uint8Array.from({ length: 9 * 7 * 4 }, (_, i) => [64, 128, 192, 173][i % 4]);
  assert.deepEqual(anisoReference(flat, 9, 7), flat);
  assert.deepEqual(anisoReference(flat, 9, 7, { strength: 0 }), flat);
  const noisy = Uint8Array.from({ length: 13 * 11 * 4 }, (_, i) => (i * 37 + (i >> 3) * 53) % 256),
    out = anisoReference(noisy, 13, 11);
  assert.notDeepEqual(out, noisy);
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], noisy[i]);
});

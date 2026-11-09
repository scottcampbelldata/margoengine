import test from 'node:test';
import assert from 'node:assert/strict';
import { HeightLighting2D, HeightLight2D, createHeightOccluder, inHeightShadow, heightLightAt } from '../dist/height.js';
import { EmissiveLighting2D, EmissiveSprite2D, emissiveLightAt } from '../dist/emissive.js';
import { SoftLight2D, softShadowFactor } from '../dist/soft.js';
import { Light2D } from '../dist/index.js';

for (const Type of [HeightLighting2D, EmissiveLighting2D]) {
  test(`${Type.name}: F2 uses the frame encoder, F22 unregisters, F25 codes unsupported`, () => {
    let callback, removed;
    const engine = {
      backend: 'webgpu', gpu: {},
      frameGraph: { add(pass) { callback = pass.execute; } },
      removePlugin(name) { removed = name; },
    };
    const plugin = new Type({ name: 'probe', target: 'target' });
    plugin.setup(engine);
    let args;
    plugin.render = (...value) => { args = value; };
    const encoder = {};
    callback({ backend: 'webgpu', encoder });
    assert.deepEqual(args, ['target', encoder]);
    plugin.dispose();
    assert.equal(removed, 'probe');
    assert.throws(() => new Type().setup({ backend: 'webgl2' }), { code: 'unsupported' });
    assert.throws(() => Type.attach({ [Symbol.for('margo.engine')]: { backend: 'webgl2', gpu: null } }), { code: 'unsupported' });
  });
}

test('F19 floating volume intersects the entire height interval, not only its endpoints', () => {
  const light = new HeightLight2D({ x: 10, height: 30, radius: 100 });
  const volume = createHeightOccluder({ shape: 'box', width: 10, depth: 10, elevation: 5, height: 5 });
  assert.equal(inHeightShadow(light, [volume], 0, 0), true);
  assert.deepEqual(heightLightAt(light, [volume], 0, 0), [0, 0, 0]);
  assert.equal(inHeightShadow(light, [{ ...volume, selfShadow: false }], 0, 0), false);
});

test('F23 rejects invalid bloom, rotation, mutated lights and fractional soft samples', () => {
  for (const field of ['bloomStrength', 'bloomThreshold']) {
    for (const value of [NaN, Infinity, -1]) {
      assert.throws(() => new EmissiveSprite2D({ [field]: value }), RangeError);
      assert.throws(() => emissiveLightAt({ [field]: value }, 0, 0), RangeError);
    }
  }
  assert.throws(() => createHeightOccluder({ shape: 'box', height: 1, rotation: NaN }), RangeError);
  assert.throws(() => new SoftLight2D({ samples: 1.5 }), RangeError);
  assert.throws(() => softShadowFactor(new Light2D(), [], 0, 0, { samples: 1.5 }), RangeError);
  const mutated = new HeightLight2D();
  mutated.intensity = NaN;
  assert.throws(() => heightLightAt(mutated, [], 0, 0), RangeError);
});

test('F18 zero radius directional visibility is the exact hard shadow limit', () => {
  const light = new SoftLight2D({ kind: 'directional', angle: 0, sourceRadius: 0 });
  assert.equal(softShadowFactor(light, [0, 0, 0, 100], 10, 0.0005), 0);
});

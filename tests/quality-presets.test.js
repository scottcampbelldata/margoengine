// Reader side of the tier-preset contract (writer: packages/quality/test/quality.test.js). Each feature package reads
// `globalThis.margoPreset[key]` when an effect is constructed, fills only the options the app left undefined, and keeps
// the app's own options object when no preset is set. GPU-call proofs: examples/package-benchmarks/proofs/quality-presets.proof.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {preset} from '../packages/shared/preset.js';
import {QUALITY_PRESETS} from '../packages/quality/dist/index.js';
import {Shadows} from '../packages/shadows/dist/index.js';
import {SSAO, SSR} from '../packages/post/dist/index.js';
import {VolumetricFog} from '../packages/environment/dist/volumetric.js';
import {Clustered} from '../packages/clustered/dist/index.js';
import {LocalShadows} from '../packages/clustered/dist/shadows.js';
import {VFX} from '../packages/vfx/dist/index.js';

const lights = new Clustered();
const readers = {
  shadows: o => new Shadows(o), ssao: o => new SSAO(o), ssr: o => new SSR(o), volumetric: o => new VolumetricFog(o),
  localShadows: o => new LocalShadows({...o, lights}), vfx: o => new VFX(o),
};
const light = QUALITY_PRESETS.light;
const withPreset = (value, work) => {globalThis.margoPreset = value; try {return work();} finally {delete globalThis.margoPreset;}};

test('the shared reader fills only undefined options and returns the same object without a preset', () => {
  const options = {a: 1, b: undefined};
  assert.equal(preset('x', options), options);
  withPreset({x: {a: 2, b: 3, c: 4}}, () => {
    const out = preset('x', options);
    assert.deepEqual(out, {a: 1, b: 3, c: 4}); assert.notEqual(out, options); assert.deepEqual(options, {a: 1, b: undefined}, 'the app object is not changed');
    assert.equal(preset('y', options), options, 'a key the preset does not name');
  });
});

test('every reader keeps the app options object untouched when no preset is set', () => {
  for (const [key, make] of Object.entries(readers)) {
    const options = {}, effect = make(options);
    if (key === 'localShadows') assert.equal(effect.options.lights, lights); else assert.equal(effect.options, options, key);
    for (const name in light[key]) assert.equal(effect.options[name], undefined, `${key}.${name} must stay at the package default`);
  }
});

test('with a preset every reader takes the preset values it was not given, and explicit options win', () => {
  withPreset(light, () => {
    for (const [key, make] of Object.entries(readers)) {
      const filled = make({});
      for (const [name, value] of Object.entries(light[key])) assert.deepEqual(filled.options[name], value, `${key}.${name} from the preset`);
      const explicit = Object.fromEntries(Object.keys(light[key]).map(name => [name, {resolution: 2048, samples: 32, enabled: true, steps: 64, grid: [160, 90, 64], maxLights: 3, capacity: 1_000_000}[name]]));
      const kept = make(explicit);
      for (const [name, value] of Object.entries(explicit)) assert.deepEqual(kept.options[name], value, `${key}.${name} explicit`);
    }
    assert.equal(new VFX({}).capacity, 100_000);
    assert.equal(new VFX({initialCount: 500_000}).capacity, 1_000_000, 'an explicit initialCount above the preset capacity keeps the default capacity');
  });
});

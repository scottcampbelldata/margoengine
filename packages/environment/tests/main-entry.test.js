// `@margoengine/environment/main`: the root without the image decoders (KB-REACT-ENVDECODERS1). react's lights, fog and
// cube camera load it, so their lazy chunk holds no Radiance HDR, OpenEXR or UltraHDR decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as main from '@margoengine/environment/main';
import * as root from '@margoengine/environment';

import * as loaders from '../dist/loaders.js';

test('the main entry is the root without the image decoders', () => {
  for (const name of Object.keys(main)) assert.equal(root[name], main[name], `${name} is the root's own export`);
  const missing = Object.keys(root).filter((name) => !(name in main));
  assert.deepEqual(missing.sort(), Object.keys(loaders).sort(), 'main leaves out exactly what loaders.js holds');
  assert.ok(missing.includes('parseHDR') && missing.includes('loadEnvironmentImage'));
  assert.equal(typeof main.Environment, 'function');
  assert.equal(typeof main.EnvironmentLighting, 'function');
});

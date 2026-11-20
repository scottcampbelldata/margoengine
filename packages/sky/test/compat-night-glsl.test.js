// The WebGL2 compatibility layer's GLSL for a sky that has the `night` entry but no `options.night` is the same text as
// for the sky without the entry (known-bugs.md, KB6171a, "MARGO_COMPAT=1 meadow 4x frame 1"): under ANGLE on Metal the
// stylized night's uniform branch, never taken, moved two cloud pixels of meadow one half-float step, so the stylized
// night is compiled only while `options.night` is set.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sky } from '../dist/base.js';
import { bruneton } from '../dist/bruneton.js';
import { clouds } from '../dist/clouds.js';
import { lighting } from '../dist/lighting.js';
import { night } from '../dist/night.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';

const glsl = (features, options = {}) => {
  const code = new Sky({ model: 'bruneton', ...options }, features).code;
  return translateWGSL({ vertex: { source: code }, fragment: { source: code } }).fragment.source;
};
const nightOnly = ['qstylizedNight', 'qhash21', 'qnightPcg'];

test('meadow: a sky with the night entry and no night set emits the narrow sky GLSL exactly', () => {
  const narrow = glsl({ bruneton, clouds, lighting });
  assert.equal(glsl({ bruneton, clouds, lighting, night }), narrow);
  const stylized = glsl({ bruneton, clouds, lighting, night }, { night: {} });
  for (const name of nightOnly) assert.ok(stylized.includes(`${name}(`), name);
  for (const name of nightOnly) assert.ok(!narrow.includes(`${name}(`), `${name} in the narrow sky`);
});

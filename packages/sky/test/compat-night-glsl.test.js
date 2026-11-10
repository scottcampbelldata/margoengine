// The WebGL2 compatibility layer's GLSL for a sky is the same for every feature the sky shares whether or not `night` is
// present (known-bugs.md, "MARGO_COMPAT=1 meadow 4x frame 1"): the meadow difference under ANGLE on Metal is not in
// the text Margo emits for the shared path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sky } from '../dist/base.js';
import { bruneton } from '../dist/bruneton.js';
import { clouds } from '../dist/clouds.js';
import { lighting } from '../dist/lighting.js';
import { night } from '../dist/night.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';

const glsl = (features) => {
  const code = new Sky({ model: 'bruneton' }, features).code;
  return translateWGSL({ vertex: { source: code }, fragment: { source: code } }).fragment.source;
};
// Local and specialized names carry a counter that the night functions shift; the counter is all that may differ.
const names = (s) => s.replace(/\b([a-z]\w*?)_\d+\b/g, '$1_N').replace(/\b(q\w+?)_s\d+\b/g, '$1_sN');
const nightOnly = ['qstylizedNight', 'qhash21', 'qnightPcg'];
const withoutNight = (s) =>
  s
    .replace(/^\w+ (q\w+)\([^)\n]*\)(;| \{\n[\s\S]*?\n\})\n/gm, (m, name) => (nightOnly.includes(name) ? '' : m))
    .replace(
      / {2}if \(\(uintBitsToFloat\(_uf0_0\[15\]\.w\) > 0\.5\)\) \{\n {4}return qstylizedNight\([^\n]*\n {2}\}\n/,
      '',
    );

test('meadow: the GLSL of the shared sky path does not change when night is added', () => {
  const narrow = glsl({ bruneton, clouds, lighting }),
    withNight = glsl({ bruneton, clouds, lighting, night });
  assert.notEqual(narrow, withNight);
  for (const name of nightOnly) assert.ok(withNight.includes(`${name}(`), name);
  const stripped = names(withoutNight(withNight));
  for (const name of nightOnly) assert.ok(!stripped.includes(`${name}(`), `${name} left`);
  assert.equal(stripped, names(narrow));
});

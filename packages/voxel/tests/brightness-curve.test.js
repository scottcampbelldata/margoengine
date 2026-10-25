// The 0-15 light-level brightness curve in the voxel shader: equal CIE L* steps (CIE 15:2004) turned back into
// relative luminance. The test runs the shader's own statements for one channel instead of a JavaScript copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/render.js', import.meta.url), 'utf8');
const statements = ['let lightness=', 'let cube=', 'let brightness='].map((head) => {
  const at = source.indexOf(head);
  assert.ok(at >= 0, head);
  return source.slice(at, source.indexOf(';', at) + 1);
});
// One channel: the vec2 (sky, block) becomes a scalar, so vector compares and select read as scalar ones.
const body = statements
  .join('\n')
  .replace('vec2f(sky,block)', 'level')
  .replace('vec2f(8.0)', '8.0')
  .concat('\nreturn brightness;');
const curve = new Function('level', 'select', body);
const brightness = (level) => curve(level, (no, yes, c) => (c ? yes : no));
// CIE inverse lightness: Y from L* (0-100).
const luminance = (l) => (l > 8 ? ((l + 16) / 116) ** 3 : (l * 27) / 24389);

test('brightness curve: exactly 0 at level 0 and 1 at level 15', () => {
  assert.equal(brightness(0), 0);
  assert.equal(brightness(15), 1);
});

test('brightness curve: monotonic, darker than linear, equal steps in L*', () => {
  for (let level = 1; level <= 15; level++) {
    const y = brightness(level);
    assert.ok(y > brightness(level - 1), `rises at ${level}`);
    if (level < 15) assert.ok(y < level / 15, `darker than linear at ${level}`);
    assert.ok(Math.abs(y - luminance((100 * level) / 15)) < 1e-12, `L* step at ${level}`);
  }
  // Continuous where the CIE inverse switches from the linear to the cube segment (L* 8).
  const knee = (8 * 15) / 100;
  assert.ok(Math.abs(brightness(knee - 1e-9) - brightness(knee + 1e-9)) < 1e-9);
});

test('brightness curve: sky and block light share it and feed occlusion, the sun and block glow', () => {
  assert.ok(source.includes('let skyLight=brightness.x;'));
  assert.ok(source.includes('brightness.y*ao*f.glow.rgb'));
  assert.ok(source.includes('voxelSun(i.position,skyLight)'));
});

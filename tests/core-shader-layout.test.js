// The shared display curve's place and local name in core's shader, which packages patch by text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../packages/core/src/shaders.ts';
import { neutralShader } from '../packages/shared/display.js';

// c6fbf0357: scatter replaces everything from '@vertex fn vertex(' up to '@fragment' with its own vertex stage, which took
// the curve with it: its lit shader called a function it no longer had.
test('the display curve survives a package replacing the vertex stage', () => {
  const replaced = wgsl.replace(/@vertex fn vertex\([\s\S]*?(?=@fragment)/, '');
  assert.notEqual(replaced, wgsl);
  assert.match(replaced, /fn pbrNeutral\(/);
  assert.match(replaced, /pbrNeutral\(max\(linear/);
});

// f1f54092c: the curve's local was `var color=`, so glTF-pro's variants held the hook point twice.
test('the curve does not use the name of the lighting hook point', () => {
  for (const curve of [neutralShader, /fn pbrNeutral\([^\n]+/.exec(wgsl)[0]]) {
    assert.match(curve, /var v=/);
    assert.doesNotMatch(curve, /var color=/);
  }
});

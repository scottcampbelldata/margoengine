// 5a26b8619: BlockTextures took raw RGBA8 pixels at run time, but its types allowed only canvas images and ImageData, so
// TypeScript users wrapped raw pixels in new ImageData.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the published BlockTextures types take raw pixels, exported as BlockPixels from ./render', () => {
  const read = (file) => readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8'),
    textures = read('textures.d.ts');
  assert.match(textures, /export interface BlockPixels\s*\{/);
  assert.match(textures, /images\?: readonly \([^)]*\bBlockPixels\b[^)]*\)\[\]/);
  assert.match(read('render.d.ts'), /\bBlockPixels\b/);
});

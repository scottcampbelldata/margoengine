// 91344b918: SSAO's appended occlusion fragment built the plain surface, without the material extension's edits or the
// phony assignments that keep its group-3 bindings in an auto layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialExtensionSurface } from '../packages/gltf-pro/src/material-extension.ts';

test('the occlusion entry gets the extension surface edits and bindings', () => {
  const code = materialExtensionSurface('fn a(){let s=surface(i,front);}fn b(){let s=surface(i,front);}', {
    factors: {},
    textures: [{ sampler: true }],
    wgsl: 's.roughness=0.5;',
  });
  assert.equal(code.match(/var s=surface\(i,front\);/g).length, 2);
  for (const part of ['_ = materialFactors;', '_ = materialTexture0;', '_ = materialSampler0;', 's.roughness=0.5;'])
    assert.equal(code.split(part).length - 1, 2, part);
  const source = readFileSync(new URL('../packages/gltf-pro/src/model.ts', import.meta.url), 'utf8');
  assert.match(source, /occlusionShader\(code\);[\s\S]{0,300}materialExtensionSurface\(rewritten\.code, extension\)/);
});

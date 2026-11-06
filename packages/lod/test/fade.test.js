// The fade's shader patches and threshold. Pixels on a real GPU: fade-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../../core/src/shaders.ts';
import { LODFade, coreFadeShader, fadeKeeps, modelFadeShader } from '@margoengine/lod/fade';

test('a value and its negative keep complementary pixels', () => {
  for (const value of [0.1, 0.5, 0.9]) {
    let kept = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const a = fadeKeeps(x, y, value),
          b = fadeKeeps(x, y, -value);
        assert.notEqual(a, b, 'each pixel draws from exactly one level');
        kept += +a;
      }
    assert.ok(Math.abs(kept / 4096 - value) < 0.02, `about ${value} of the pixels: ${kept / 4096}`);
  }
  assert.equal(fadeKeeps(3, 4, 0), true, 'zero keeps everything, so a mesh that is not fading draws in full');
});

test('the core patch reads the value of the mesh id and leaves other shaders alone', () => {
  const code = coreFadeShader(wgsl);
  assert.notEqual(code, wgsl);
  assert.ok(code.includes('o.lod_id=u32(i.factors.w);'));
  assert.ok(code.includes('@location(14) @interpolate(flat) lod_id:u32'));
  assert.ok(code.includes('@group(0) @binding(95) var<storage,read> lod_fades:array<f32>;'));
  assert.ok(code.includes('vec4f {\nif(!lod_fade_keep(i.clip.xy,lod_fades[i.lod_id])){discard;}'));
  assert.equal(coreFadeShader('fn other() {}'), 'fn other() {}', 'a shader with its own outputs is not touched');
});

test('the model patch guards every entry that shades a surface', () => {
  const source = '@fragment fn a() {let s=surface(i,front);}\n@fragment fn b() {let s=surface(i,front);}',
    code = modelFadeShader(source, 2);
  assert.match(code, /@group\(2\) @binding\(97\)/);
  assert.equal(code.match(/lod_fade_keep\(i\.clip\.xy,lod_fade\.x\)/g).length, 2);
});

test('LODFade needs a positive duration', () => {
  const system = { name: 'lod:test' };
  assert.throws(() => new LODFade(system, { duration: 0 }), RangeError);
  assert.equal(new LODFade(system).duration, 0.25);
});

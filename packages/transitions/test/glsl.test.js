import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { translateGLSLTransition, createGLSLTransition, createLiveGLSLTransition } from '../dist/glsl.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { fullscreen } from '../../shared/gpu.js';
import { glslFixtures } from './glsl-fixtures.js';
const header =
  fullscreen +
  `@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var before:texture_2d<f32>;@group(0) @binding(2) var after:texture_2d<f32>;fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f{let s=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(s)),vec2i(0),s-1),0);}`;
for (const fixture of glslFixtures)
  test('GLSL semantic lowering: ' + fixture.name, () => {
    const code = translateGLSLTransition(fixture.source, { uniforms: fixture.uniforms });
    const module = checkWGSL(
      header +
        code +
        '@fragment fn fragment(i:Vertex)->@location(0) vec4f{return transition(before,after,i.uv,settings.x);}',
    );
    assert.ok(module.entryPoints.some((p) => p.stage === 'fragment'));
    assert.equal(code, translateGLSLTransition(fixture.source, { uniforms: fixture.uniforms }));
  });
test('equality rejects types excluded by GLSL ES 1.00', () => {
  for (const source of [
    'vec4 transition(vec2 uv){float a[2];float b[2];if(a==b){return vec4(1.0);}return vec4(0.0);}',
    'struct S{float a[2];};vec4 transition(vec2 uv){S a;S b;if(a!=b){return vec4(1.0);}return vec4(0.0);}',
    'vec4 transition(vec2 uv){if(from==to){return vec4(1.0);}return vec4(0.0);}',
    'vec4 transition(vec2 uv){if(uv==1.0){return vec4(1.0);}return vec4(0.0);}',
  ]) assert.throws(() => translateGLSLTransition(source), (e) => e.code === 'failed');
});

test('invalid GLSL and parameters reject without GPU access; translation has no host execution', async () => {
  for (const source of ['', null, 0, 'x'.repeat(65537)])
    assert.throws(() => translateGLSLTransition(source), TypeError);
  for (const source of [
    'vec4 transition(vec2 uv){return unknown;}',
    'vec4 transition(vec2 uv){return missing(uv);}',
    'vec4 other(vec2 uv){return vec4(0.0);}',
    '#define X Y\n#define Y X\nvec4 transition(vec2 uv){return vec4(X);}',
    '#if 1\nvec4 transition(vec2 uv){return vec4(0.0);}',
    'uniform float q;vec4 transition(vec2 uv){return vec4(q);}',
    'vec4 transition(vec2 uv){' + 'if(true){'.repeat(140) + 'return vec4(0.0);' + '}'.repeat(140) + '}',
  ]) {
    assert.throws(
      () => translateGLSLTransition(source),
      (e) => e.code === 'failed' && /https:/.test(e.message),
    );
  }
  assert.throws(() => translateGLSLTransition(glslFixtures[0].source, { flipY: 1 }), TypeError);
  const c = new AbortController();
  c.abort();
  await assert.rejects(createGLSLTransition({}, glslFixtures[0].source, { signal: c.signal }), { name: 'AbortError' });
  await assert.rejects(createLiveGLSLTransition({}, null, null, glslFixtures[0].source, { signal: c.signal }), {
    name: 'AbortError',
  });
});

// Regression (KB5433): `uniform float weights[2+2];` rejected at parsing (only literal or named lengths were taken),
// and a helper with an unnamed parameter rejected because parameter parsing required an identifier.
test('constant-expression array lengths fold and unnamed helper parameters are accepted', () => {
  const check = (source, uniforms) => {
    const code = translateGLSLTransition(source, { uniforms });
    checkWGSL(
      header +
        code +
        '@fragment fn fragment(i:Vertex)->@location(0) vec4f{return transition(before,after,i.uv,settings.x);}',
    );
    return code;
  };
  const sum = 'vec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),progress*(weights[0]+weights[3]));}';
  const folded = check('uniform float weights[2+2];' + sum, { weights: [0.1, 0.2, 0.3, 0.4] });
  assert.equal(folded, check('uniform float weights[4];' + sum, { weights: [0.1, 0.2, 0.3, 0.4] }));
  check('const int N=2;uniform float weights[N*2-(1-1)];' + sum, { weights: [0.1, 0.2, 0.3, 0.4] });
  check('const int N=3;const int M=N+1;uniform float weights[M];' + sum, { weights: [0.1, 0.2, 0.3, 0.4] });
  // The folded length is checked against the supplied values like a literal one.
  assert.throws(() => check('uniform float weights[2+2];' + sum, { weights: [0.1, 0.2] }), (e) => e.code === 'failed');
  for (const length of ['1/0', 'progress', '2.5', 'N+0', 'K+1'])
    assert.throws(
      () => translateGLSLTransition(`float N=2.0;uniform float weights[${length}];` + sum, { uniforms: { weights: [1, 2] } }),
      (e) => e.code === 'failed',
    );
  check(
    'float w(float, vec2 p){return p.x;}float both(float, float){return 1.0;}' +
      'vec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),w(0.0,uv)*both(1.0,2.0)*progress);}',
  );
});

// Regression (KB0191): the native oracle sampled through a NEAREST sampler, whose subtexel snap on the Radeon 680M read
// texel 11 where the product's sample() truncates to texel 10 (a lookup 6e-4 of a texel below the edge). The oracle now
// reads by the product's rule, so the 'texel edge' fixture compares exactly on every GPU with no allowance.
test('the GLSL oracle reads texels by the product rule, not through a sampler', () => {
  const oracle = readFileSync(new URL('./glsl-browser.js', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../src/builtin.ts', import.meta.url), 'utf8');
  assert.match(product, /return textureLoad\(t,clamp\(vec2i\(uv\*vec2f\(size\)\),vec2i\(0\),size-1\),0\);/);
  assert.match(oracle, /ivec2 c=clamp\(ivec2\(vec2\(uv\.x,1\.0-uv\.y\)\*vec2\(s\)\),ivec2\(0\),s-1\);return texelFetch\(t,ivec2\(c\.x,s\.y-1-c\.y\),0\);/);
  assert.match(oracle, /#define texture2D margoFetch/);
  assert.doesNotMatch(oracle, /return texture\((from|to),uv\)/);
  assert.ok(glslFixtures.some((f) => f.name === 'texel edge'));
});

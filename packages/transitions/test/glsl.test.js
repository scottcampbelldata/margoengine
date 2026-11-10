import test from 'node:test';
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

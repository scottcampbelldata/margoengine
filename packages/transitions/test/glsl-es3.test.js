// GLSL ES 3.00 input: every fixture translates, and the WGSL passes the WebGL2 layer's WGSL checker; the semantic rules
// that differ from WGSL are pinned one by one. The browser grid (glsl-browser.js) compares the same fixtures' pixels
// with the browser's own GLSL compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translateGLSLTransition } from '../dist/glsl.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { fullscreen } from '../../shared/gpu.js';
import { glslES3Fixtures } from './glsl-es3-fixtures.js';
const header =
  fullscreen +
  `@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var before:texture_2d<f32>;@group(0) @binding(2) var after:texture_2d<f32>;fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f{let s=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(s)),vec2i(0),s-1),0);}`;
const check = (code) =>
  checkWGSL(
    header +
      code +
      '@fragment fn fragment(i:Vertex)->@location(0) vec4f{return transition(before,after,i.uv,settings.x);}',
  );
const es3 = (body, head = '') => `#version 300 es\n${head}vec4 transition(vec2 uv){${body}}`;
for (const fixture of glslES3Fixtures)
  test('GLSL ES 3.00 lowering: ' + fixture.name, () => {
    const code = translateGLSLTransition(fixture.source, { uniforms: fixture.uniforms });
    assert.ok(check(code).entryPoints.some((p) => p.stage === 'fragment'));
    assert.equal(code, translateGLSLTransition(fixture.source, { uniforms: fixture.uniforms }));
  });
test('#version 300 es is accepted and sets __VERSION__; other versions are refused', () => {
  const code = translateGLSLTransition(es3('return vec4(float(__VERSION__)/1000.0);'));
  assert.match(code, /i32\(300\)/);
  assert.throws(
    () => translateGLSLTransition('#version 310 es\nvec4 transition(vec2 uv){return vec4(0.0);}'),
    (e) => e.code === 'unsupported' && /3\.00/.test(e.message),
  );
});
test('a case falls into the next until a statement that cannot complete; WGSL cases hold the joined bodies', () => {
  const code = translateGLSLTransition(
    es3('float c=0.0;switch(int(uv.x*4.0)){case 0:c+=1.0;case 1:c+=2.0;break;case 2:default:c=3.0;}return vec4(c);'),
  );
  check(code);
  const [, zero] = /case i32\(0\)\{([^}]*)\}/.exec(code);
  assert.match(zero, /f32\(1\.0\)[\s\S]*f32\(2\.0\)[\s\S]*break/, 'case 0 runs its own body and case 1');
  assert.match(code, /case i32\(2\),default\{/, 'labels sharing statements share one WGSL case');
  // No default label: WGSL needs one, so an empty one is added.
  assert.match(translateGLSLTransition(es3('switch(1){case 1:break;}return vec4(0.0);')), /default\{\}/);
  for (const bad of [
    es3('switch(1){case 1:case 1:break;}return vec4(0.0);'),
    es3('switch(1.0){case 1:break;}return vec4(0.0);'),
    es3('switch(1){break;}return vec4(0.0);'),
    es3('switch(1){case 1:}return vec4(0.0);'),
    es3('int k=1;switch(1){case k:break;}return vec4(0.0);'),
  ])
    assert.throws(() => translateGLSLTransition(bad), (e) => e.code === 'failed', bad);
});
test('shifts take an unsigned amount of the left operand width; signed literals keep their 32-bit pattern', () => {
  const code = translateGLSLTransition(
    es3('ivec2 v=ivec2(1)<<2;int a=0xFFFFFFFF;int b=-2147483648;uint c=4294967295u;return vec4(float(v.x+a+b)+float(c));'),
  );
  check(code);
  assert.match(code, /<<vec2<u32>\(u32\(i32\(2\)\)\)/);
  assert.match(code, /bitcast<i32>\(4294967295u\)/);
  assert.match(code, /i32\(-2147483648\)/);
  assert.throws(() => translateGLSLTransition(es3('int a=0x1FFFFFFFF;return vec4(0.0);')), (e) => e.code === 'failed');
});
test('matrix products take GLSL ES 3.00 result shapes; non-square matrices and mixed constructors lower', () => {
  const code = translateGLSLTransition(
    es3('mat2x3 m=mat2x3(1.0);vec3 a=m*uv;vec2 b=a*m;mat3x2 t=transpose(m);mat3 p=m*t;mat2 q=t*m;vec4 f=vec4(q);mat3 r=mat3(uv,1.0,vec3(0.0),vec2(1.0),0.0);return vec4(a+b.xyx+p[0]+r[1]+f.xyz,1.0);'),
  );
  check(code);
  assert.match(code, /var user_m:mat2x3<f32>/);
  assert.match(code, /var user_t:mat3x2<f32>=transpose/);
});
test('ES 3.00 adds array equality and inverse; ES 1.00 sources keep refusing them', () => {
  const arrays = 'float a[2]=float[2](1.0,2.0);float b[2]=float[](1.0,2.0);return vec4(a==b?1.0:0.0);';
  check(translateGLSLTransition(es3(arrays)));
  assert.throws(() => translateGLSLTransition(`vec4 transition(vec2 uv){${arrays}}`), (e) => e.code === 'failed');
  const inverse = 'mat3 m=inverse(mat3(2.0));mat4 n=inverse(mat4(2.0));mat2 o=inverse(mat2(2.0));return vec4(m[0],n[1][1]+o[0][0]);';
  assert.match(translateGLSLTransition(es3(inverse)), /fn margo_inverse3\(m:mat3x3<f32>\)/);
  check(translateGLSLTransition(es3(inverse)));
  assert.throws(() => translateGLSLTransition(`vec4 transition(vec2 uv){${inverse}}`), (e) => /inverse/.test(e.message));
});
test('unsized arrays need a constructor of their type; array constructors check their element count', () => {
  for (const bad of [
    es3('float a[];return vec4(0.0);'),
    es3('float a[]=vec2[](vec2(1.0));return vec4(0.0);'),
    es3('float a[2]=float[2](1.0);return vec4(0.0);'),
    es3('float x=1.0;return vec4(x.length());'),
  ])
    assert.throws(() => translateGLSLTransition(bad), (e) => e.code === 'failed', bad);
});
test('isnan and isinf decide on the IEEE 754 bit pattern; bit casts and modf lower to WGSL builtins', () => {
  const code = translateGLSLTransition(
    es3('vec2 w;vec2 f=modf(uv,w);bvec2 n=isnan(uv);bool i=isinf(uv.x);return vec4(f+w,float(n.x||i)+intBitsToFloat(floatBitsToInt(uv.y)),1.0);'),
  );
  check(code);
  assert.match(code, /0x7fffffffu\)\)>vec2<u32>\(0x7f800000u\)/);
  assert.match(code, /0x7fffffffu\)\)==u32\(0x7f800000u\)/);
  assert.match(code, /=modf\(/);
  assert.match(code, /bitcast<i32>\(/);
});
test('texelFetch numbers rows from the bottom under the y flip; textureSize is the level size', () => {
  const code = translateGLSLTransition(es3('ivec2 s=textureSize(from,0);return texelFetch(to,s-1,0);'));
  check(code);
  assert.match(code, /textureLoad\(after,vec2i\(temporary_\d+\.x,i32\(textureDimensions\(after,temporary_\d+\)\.y\)-1-temporary_\d+\.y\)/);
  const flat = translateGLSLTransition(es3('return texelFetch(to,ivec2(1),0);'), { flipY: false });
  assert.match(flat, /textureLoad\(after,temporary_\d+\.xy,temporary_\d+\)/);
});

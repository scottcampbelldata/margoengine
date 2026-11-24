// Batch 132 audit of the GLSL front end against the GLSL ES 1.00 specification (Simpson and Kessenich,
// The OpenGL ES Shading Language 1.00, revision 17, Khronos 2009, https://registry.khronos.org/OpenGL/specs/es/2.0/GLSL_ES_Specification_1.00.pdf).
// Each source below is valid GLSL ES 1.00 that translated to WGSL the checker rejected, or failed to parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translateGLSLTransition } from '../dist/glsl.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { fullscreen } from '../../shared/gpu.js';
const header =
  fullscreen +
  `@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var before:texture_2d<f32>;@group(0) @binding(2) var after:texture_2d<f32>;fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f{let s=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(s)),vec2i(0),s-1),0);}`;
const check = (source) => {
  const code = translateGLSLTransition(source);
  checkWGSL(
    header + code + '@fragment fn fragment(i:Vertex)->@location(0) vec4f{return transition(before,after,i.uv,settings.x);}',
  );
  return code;
};
const body = (s) => `vec4 transition(vec2 uv){${s}}`;

test('hexadecimal and octal integer literals (section 4.1.3) carry their values', () => {
  const hex = check(body('int a=0x1F;int b=0XaB;return vec4(float(a+b));'));
  assert.match(hex, /i32\(31\)/);
  assert.match(hex, /i32\(171\)/);
  const octal = check(body('int a=017;int z=0;return vec4(float(a+z));'));
  assert.match(octal, /i32\(15\)/);
  assert.match(octal, /i32\(0\)/);
  // An array sized by an octal or hex literal gets its decimal length.
  assert.match(check(body('float w[010];w[7]=1.0;return vec4(w[7]);')), /array<f32,8>/);
  assert.match(check(body('float w[0x3];w[2]=1.0;return vec4(w[2]);')), /array<f32,3>/);
  // 8 and 9 are not octal digits, and an array length must be positive.
  for (const s of ['int a=09;return vec4(float(a));', 'float w[0];return vec4(0.0);', 'float w[2-3];return vec4(0.0);'])
    assert.throws(() => translateGLSLTransition(body(s)), (e) => e.code === 'failed');
});

test('a declared name comes into scope after its initializer (section 4.2.2)', () => {
  const code = check(body('float ratio=ratio*2.0;float progress=progress;return vec4(ratio,progress,0.0,1.0);'));
  assert.match(code, /var user_ratio:f32=\(\(f32\(textureDimensions\(after\)\.x\)/);
  assert.match(code, /var user_progress:f32=settings\.x;/);
});

test('matrix negation, compound assignment and increments follow sections 5.8 to 5.11', () => {
  check(body('mat2 m=mat2(1.0,2.0,3.0,4.0);m=-m;return vec4(m[0],m[1]);'));
  check(body('mat2 m=mat2(1.0);m*=2.0;m/=4.0;m+=1.0;m-=0.5;return vec4(m[0],m[1]);'));
  check(body('mat2 m=mat2(1.0,2.0,3.0,4.0);vec2 v=uv;v*=m;return vec4(v,0.0,1.0);'));
  check(body('mat3 m=mat3(1.0);m++;--m;return vec4(m[0],1.0);'));
  // A compound assignment evaluates its target once: the index's increment runs once.
  const once = check(body('float a[3];int i=0;a[i++]*=2.0;return vec4(float(i));'));
  assert.equal(once.match(/user_i = \(user_i\+i32\(1\)\)/g)?.length, 1);
  // Negation of a matrix is the matrix times -1: each component's sign flips.
  assert.match(check(body('mat2 m=mat2(1.0);return vec4((-m)[0],0.0,1.0);')), /\*\(-1\.0\)/);
});

test('a scalar constructed from a vector or matrix takes its first component (section 5.4.1)', () => {
  const code = check(body('float f=float(uv);int i=int(vec3(2.5));bool b=bool(uv);float m=float(mat2(3.0));return vec4(f,float(i),float(b),m);'));
  assert.match(code, /var user_f:f32=\(user_uv\)\.x;/);
  assert.match(code, /var user_m:f32=\(mat2x2<f32>\(/);
});

test('a sequence whose left operand is a void call (section 5.9)', () => {
  check('float g=0.0;void bump(){g+=1.0;}' + body('float x=(bump(),g);return vec4(x);'));
});

test('precision statements inside a function and local constant array sizes (sections 4.5.3 and 4.1.9)', () => {
  check(body('precision mediump float;return vec4(uv,0.0,1.0);'));
  const code = check(body('const int N=2;float w[N*2];w[3]=1.0;{const int K=N+1;float v[K];v[2]=w[3];}return vec4(w[3]);'));
  assert.match(code, /array<f32,4>/);
  assert.match(code, /array<f32,3>/);
  // A non-constant local, or a local that shadows a global constant, is not a constant expression.
  for (const s of [
    'int N=2;float w[N];return vec4(0.0);',
    'float w[K];return vec4(0.0);',
  ])
    assert.throws(() => translateGLSLTransition(body(s)), (e) => e.code === 'failed');
  assert.throws(
    () => translateGLSLTransition('const int N=2;' + body('int N=3;float w[N];return vec4(0.0);')),
    (e) => e.code === 'failed',
  );
});

test('the last operand of ?: is an assignment expression, and only l-values take assignments (section 5.8)', () => {
  // `c ? x : y = 2.0` assigns y in the false branch; it used to assign the conditional's temporary and drop the store.
  const code = check(body('float x=0.0;float y=0.0;uv.x<0.5?x:y=2.0;return vec4(x,y,0.0,1.0);'));
  assert.match(code, /user_y = f32\(2\.0\);/);
  for (const s of ['float x;(uv.x<0.5?x:x)=1.0;return vec4(x);', 'float x;(x+1.0)=2.0;return vec4(x);'])
    assert.throws(() => translateGLSLTransition(body(s)), (e) => e.code === 'failed');
});

test('inverse is outside GLSL ES 1.00 and has no WGSL builtin: it rejects at translation', () => {
  assert.throws(
    () => translateGLSLTransition(body('mat2 m=inverse(mat2(2.0));return vec4(m[0],m[1]);')),
    (e) => e.code === 'failed' && /inverse/.test(e.message),
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { glslFn, glslToWGSL, toGLSL, glslTranslations } from '../dist/glsl.js';
import { NodePass, NodeMaterial, texture, uv, vec3, vec4, positionLocal, wgslFn, uniform } from '../dist/index.js';
import { Texture } from '../../materials/dist/index.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import * as compat from '../../webgl2-compat/dist/glsl.js';
import { glslFixtures } from './glsl-fixtures.js';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
// Translation prefixes count translations in this process; snapshots name them glsl_ so a filtered run matches too.
const stable = (s) => s.replace(/glsl\d+_/g, 'glsl_');
/** Generated text is compared byte for byte (line endings aside); UPDATE_SNAPSHOTS=1 rewrites the files. */
async function snapshot(name, text) {
  const file = snapshots + name;
  if (process.env.UPDATE_SNAPSHOTS) {
    await mkdir(snapshots, { recursive: true });
    await writeFile(file, text);
  }
  // A Windows checkout with core.autocrlf writes the snapshots with CRLF; the generated text has LF, as shader.test.js reads it.
  assert.equal(
    text,
    (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
    name + ' changed (UPDATE_SNAPSHOTS=1 to accept)',
  );
}
const image = () => new Texture({ data: new Uint8Array(64 * 4), width: 8, height: 8 }, { colorSpace: 'linear' });
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const refusal = (fn, pattern, line, column) =>
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'MargoError');
    assert.equal(e.code, 'failed');
    assert.match(e.message, pattern);
    assert.match(e.message, /margoengine\.com\/errors#failed/);
    assert.equal(e.line, line, 'line');
    assert.equal(e.column, column, 'column');
    return true;
  });

test('every fixture translates to the pinned WGSL, and the WGSL checks as a NodePass on the WebGL2 layer', async () => {
  for (const f of glslFixtures) {
    const fn = glslToWGSL(f.source);
    await snapshot(`glsl-${slug(f.name)}.wgsl`, stable(fn.code));
    const node = glslFn(f.source)(uv(), 0.25, ...(f.texture ? [image()] : []));
    const pass = new NodePass(node);
    assert.doesNotThrow(() => checkWGSL(pass.code()), f.name);
    assert.ok(pass.code().includes(fn.code), 'the pass declares the translation once');
  }
  assert.deepEqual(glslToWGSL(glslFixtures[3].source).params, [
    { name: 'uv', glsl: 'vec2', type: 'vec2f' },
    { name: 't', glsl: 'float', type: 'f32' },
    { name: 'img', glsl: 'sampler2D', type: '2d' },
  ]);
});

test('two GLSL functions, a wgslFn and same-named helpers share one module without clashing', () => {
  const a = glslFn(`float helper(float x) { return x * 2.0; } vec3 one(vec3 c) { return c * helper(0.5); }`);
  const b = glslFn(`float helper(float x) { return x + 1.0; } vec3 two(vec3 c) { return c + helper(0.0); }`);
  const w = wgslFn('fn helper(x: vec3f) -> vec3f { return x; }');
  const pass = new NodePass(w(a(b(vec3(0.25)))));
  const code = pass.code();
  assert.doesNotThrow(() => checkWGSL(code));
  const names = [...code.matchAll(/\bfn (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, 'every module-scope function has its own name');
  assert.equal(names.filter((n) => /entry$/.test(n)).length, 2);
});

test('toGLSL returns the layer program of a NodePass and of a NodeMaterial that has drawn', async () => {
  const pass = new NodePass(glslFn(glslFixtures[0].source)(uv(), 0.5));
  const program = toGLSL(pass, compat);
  assert.match(program.vertex.source, /^#version 300 es/);
  await snapshot('glsl-pass.frag', stable(program.fragment.source));
  const { pbrShader } = await import('../../gltf/src/shader.ts');
  const tint = glslFn(glslFixtures[0].source);
  const material = new NodeMaterial({
    colorNode: tint(uv(), 0.25).rgb,
    positionNode: positionLocal.add(tint(uv(), 0.5).xyz.mul(0.01)),
  });
  assert.throws(
    () => toGLSL(material, compat),
    (e) => e.name === 'MargoError' && e.code === 'state' && /drawn once/.test(e.message),
  );
  material.shader(pbrShader, 2);
  const lit = toGLSL(material, compat, { clipControl: false });
  assert.match(lit.vertex.source, /void main\(\)/);
  assert.match(lit.fragment.source, /void main\(\)/);
  assert.ok(lit.fragment.uniforms.length > 0 && lit.vertex.uniforms.length > 0, 'binding tables come along');
  assert.match(lit.fragment.source, /glsl\d+_/, 'the translated GLSL function is in the program');
  const wgsl = toGLSL({ vertex: pass.code() }, { translateWGSL: (input) => input });
  assert.equal(wgsl.vertex.source, pass.code());
  assert.equal(wgsl.fragment, undefined);
  assert.throws(() => toGLSL(pass, {}), /toGLSL needs the layer's translator/);
  assert.throws(() => toGLSL(42, compat), /needs a NodePass, a NodeMaterial/);
});

test('a vertex-stage use samples level 0 and a fragment use samples with derivatives, each translated once', () => {
  const source = `vec4 pick(sampler2D img, vec2 uv) { return texture(img, uv); }`;
  const before = glslTranslations.count;
  const pick = glslFn(source),
    t = image();
  assert.equal(glslTranslations.count, before + 1, 'glslFn translates once');
  const material = new NodeMaterial({
    colorNode: pick(t, uv()).rgb,
    positionNode: positionLocal.add(pick(t, uv()).xyz.mul(0.01)),
  });
  glslFn(source)(t, uv());
  const code = material.program.declare(2);
  assert.equal(glslTranslations.count, before + 2, 'one more for the vertex stage, none for repeats');
  assert.match(code, /textureSampleLevel\(argument_0,argument_0s,glsl\d+_uv,0\.0\)/);
  assert.match(code, /textureSample\(argument_0,argument_0s,glsl\d+_uv\)/);
  assert.equal(material.program.resources.length, 1, 'both stages bind the texture once');
});

test('a texture read by texture() and by GLSL binds once', () => {
  const t = image();
  const pick = glslFn(`vec4 pick(sampler2D img, vec2 uv) { return texture(img, uv); }`);
  const pass = new NodePass(pick(t, uv()).add(texture(t, uv())));
  assert.equal(pass.program.resources.length, 1);
  assert.doesNotThrow(() => checkWGSL(pass.code()));
  const other = new NodePass(pick(image(), uv()).add(pick(t, uv())));
  assert.equal(other.program.resources.length, 2, 'other textures are other bindings');
});

test('refusals carry the line and column of the source as written', () => {
  refusal(() => glslToWGSL('float f(float x) {\n  return x +;\n}'), /Unexpected expression token ;/, 2, 13);
  refusal(
    () => glslToWGSL('uniform float k;\nfloat f(float x) {\n  return x * k;\n}'),
    /uniform .*pass it as an argument/,
    1,
    1,
  );
  refusal(
    () => glslToWGSL('// a comment\nfloat f(float x) {\n  return gl_FragCoord.x;\n}'),
    /gl_FragCoord is not available inside a function; pass it as an argument/,
    3,
    10,
  );
  refusal(
    () =>
      glslToWGSL('float f(float x) { return x; }\n#define N 2\nvoid g(out float y) { y = 1.0; }', {
        defines: { M: 1 },
      }),
    /parameter y of g is out/,
    3,
    6,
  );
  refusal(() => glslToWGSL('\n\nfloat f(float x[2]) { return x[0]; }'), /parameter x has type float\[2\]/, 3, 7);
  refusal(() => glslToWGSL('void f(float x) { }'), /f returns void/, 1, 6);
  refusal(() => glslToWGSL('float f(float x) { return x; }', { name: 'g' }), /defines no function g/, 1, 1);
  assert.throws(
    () => glslToWGSL('#version 310 es\nfloat f(float x) { return x; }'),
    (e) => e.code === 'unsupported',
  );
});

test('options: name, defines, flipY and strict', () => {
  const two = `float a(float x) { return x; } float b(float x) { return -x; }`;
  assert.match(glslToWGSL(two).code, /glsl\d+_entry\(a0:f32\)->f32\{return glsl\d+_function_1\(a0\)/);
  assert.match(glslToWGSL(two, { name: 'a' }).code, /glsl\d+_entry\(a0:f32\)->f32\{return glsl\d+_function_0\(a0\)/);
  assert.match(
    glslToWGSL('float f(float x) { return x * SCALE; }', { defines: { SCALE: 3 } }).code,
    /f32\(3\.?0?\)|3\.0|\b3\b/,
  );
  assert.throws(() => glslToWGSL('float f(float x) { return x; }', { defines: { 'no-name': 1 } }), TypeError);
  assert.throws(() => glslToWGSL('float f(float x) { return x; }', { defines: { A: '1\n#define B 2' } }), TypeError);
  const read = `vec4 f(sampler2D s, vec2 p) { return texture(s, p) + texelFetch(s, ivec2(p), 0); }`;
  assert.match(glslToWGSL(read, { flipY: true }).code, /vec2f\(glsl\d+_p\.x,1\.0-glsl\d+_p\.y\)/);
  assert.match(glslToWGSL(read, { flipY: true }).code, /textureDimensions/);
  assert.match(glslToWGSL(read).code, /^@diagnostic\(off,derivative_uniformity\) fn /m);
  assert.doesNotMatch(glslToWGSL(read, { strict: true }).code, /@diagnostic/);
  assert.throws(() => glslToWGSL(read, { strict: 1 }), TypeError);
});

test('arguments: numbers for scalars and vectors, nodes for matrices, Textures of the right dimension for samplers', () => {
  const f = glslFn(`vec2 f(int n, bool b, mat2 m, vec2 v) { return b ? m * v * float(n) : v; }`),
    mat2 = (...v) => uniform(v, { type: 'mat2x2f' });
  assert.doesNotThrow(() => checkWGSL(new NodePass(vec4(f(3, true, mat2(1, 0, 0, 1), uv()), 0, 1)).code()));
  assert.throws(() => f(3, true, 1, uv()), /argument 3 \(m\) must be a node$/);
  assert.throws(() => f(3, 1, mat2(1, 0, 0, 1), uv()), /argument 2 \(b\) must be a node or a boolean/);
  assert.throws(() => f(3, true, mat2(1, 0, 0, 1)), /4 arguments expected, got 3/);
  assert.throws(() => f(3, true, mat2(1, 0, 0, 1), vec3(1)), /must be vec2f, got vec3f/);
  const cube = glslFn(`vec4 f(samplerCube s, vec3 d) { return texture(s, d); }`);
  assert.throws(() => cube(image(), vec3(1)), /dimension cube/);
  assert.doesNotThrow(() => glslFn('float f(float x) { return x; }')(uniform(2)));
});

// Bounded work is the limits themselves (tokens, nesting, macro rounds), each refused with a coded error; a run that did
// not stop would hit the runner's own test timeout, so no wall-clock budget is asserted.
test('hostile input ends in a coded error or a translation', () => {
  assert.throws(() => glslToWGSL('float f(float x) { return x; }'.padEnd(65537)), TypeError);
  refusal(
    () => glslToWGSL(`float f(float x) { return ${'('.repeat(10000)}x${')'.repeat(10000)}; }`),
    /Expression nesting exceeds 128/,
    1,
    154,
  );
  assert.throws(() => glslToWGSL(`float f(float x) { return ${'x+'.repeat(30000)}x; }`), /token limit/);
  assert.throws(
    () => glslToWGSL(`float f(float x) { ${'{'.repeat(200)} ${'}'.repeat(200)} return x; }`),
    (e) => e.code === 'failed' && /Statement nesting exceeds 128/.test(e.message),
  );
  assert.throws(
    () => glslToWGSL('#define A B B\n#define B A A\nfloat f(float x) { return A; }'),
    (e) => e.name === 'MargoError' || e instanceof TypeError,
  );
});

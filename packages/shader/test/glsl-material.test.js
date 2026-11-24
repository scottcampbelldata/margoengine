import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ShaderMaterial, glslProgramToWGSL, glslPrograms } from '../dist/glsl-material.js';
import { RawMesh, RawShaderMaterial } from '../dist/raw.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { programFixtures } from './glsl-material-fixtures.js';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
/** Generated text is compared byte for byte; UPDATE_SNAPSHOTS=1 rewrites the files. */
async function snapshot(name, text) {
  const file = snapshots + name;
  if (process.env.UPDATE_SNAPSHOTS) {
    await mkdir(snapshots, { recursive: true });
    await writeFile(file, text);
  }
  assert.equal(text, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'), name + ' changed (UPDATE_SNAPSHOTS=1 to accept)');
}
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const attributesOf = (f) =>
  Object.fromEntries(Object.entries(f.attributes).map(([k, a]) => [k, { data: a.data, type: a.size === 1 ? 'f32' : `vec${a.size}f` }]));
const material = (f, extra = {}) =>
  new ShaderMaterial({
    vertexShader: f.vertex,
    fragmentShader: f.fragment,
    uniforms: Object.fromEntries(Object.entries(f.uniforms).map(([k, v]) => [k, { value: v[1] }])),
    defines: f.defines?.[0],
    ...extra,
  });
const vs = `#version 300 es
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy; gl_Position = vec4(position, 1.0); }`;
const fs = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
void main() { color = vec4(vUv, 0.0, 1.0); }`;
const refusal = (fn, pattern, stage, line, column) =>
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'MargoError');
    assert.equal(e.code, 'failed');
    assert.match(e.message, pattern);
    assert.match(e.message, /margoengine\.com\/errors#failed/);
    assert.equal(e.stage, stage, 'stage');
    assert.equal(e.line, line, 'line');
    assert.equal(e.column, column, 'column');
    return true;
  });

test('every program fixture translates to the pinned WGSL, and each stage checks on the WebGL2 layer for its mesh', async () => {
  for (const f of programFixtures) {
    const m = material(f),
      mesh = new RawMesh({ material: m, attributes: attributesOf(f), index: f.index });
    const vertex = m.code('vertex', mesh),
      fragment = m.code('fragment', mesh);
    await snapshot(`glsl-program-${slug(f.name)}.wgsl`, `${vertex}\n// fragment\n${fragment}`);
    assert.doesNotThrow(() => checkWGSL(vertex), f.name + ' vertex');
    assert.doesNotThrow(() => checkWGSL(fragment), f.name + ' fragment');
    // With no mesh, absent attributes read GL's generic default; the module still checks.
    assert.doesNotThrow(() => checkWGSL(m.code('vertex')), f.name + ' vertex without a mesh');
  }
});

test('the program tables: uniforms by GLSL type, textures, attributes and varyings in vertex declaration order', () => {
  const w = glslProgramToWGSL({ vertexShader: programFixtures[3].vertex, fragmentShader: programFixtures[3].fragment });
  assert.deepEqual(w.attributes, [
    { name: 'position', glsl: 'vec3', semantic: 'position' },
    { name: 'layer', glsl: 'float' },
  ]);
  assert.deepEqual(w.varyings, [
    { name: 'vUv', glsl: 'vec2', location: 0, interpolation: 'perspective' },
    { name: 'vLayer', glsl: 'int', location: 1, interpolation: 'flat' },
  ]);
  assert.equal(w.version, 300);
  const all = glslProgramToWGSL({ vertexShader: programFixtures[0].vertex, fragmentShader: programFixtures[0].fragment });
  assert.deepEqual(
    all.uniforms.map((u) => [u.name, u.glsl, u.type]),
    [
      ['lift', 'mat4', 'mat4x4f'],
      ['f', 'float', 'f32'],
      ['f2', 'vec2', 'vec2f'],
      ['f3', 'vec3', 'vec3f'],
      ['f4', 'vec4', 'vec4f'],
      ['i', 'int', 'i32'],
      ['i2', 'ivec2', 'vec2i'],
      ['u', 'uint', 'u32'],
      ['u3', 'uvec3', 'vec3u'],
      ['b', 'bool', 'u32'],
      ['b2', 'bvec2', 'vec2u'],
      ['m2', 'mat2', 'vec4f'],
      ['m3', 'mat3', 'mat3x3f'],
    ],
  );
  const tex = glslProgramToWGSL({ vertexShader: programFixtures[5].vertex, fragmentShader: programFixtures[5].fragment });
  assert.deepEqual(tex.textures, [{ name: 'map', glsl: 'sampler2D', dimension: '2d', binding: 'user_map' }]);
  assert.equal(glslProgramToWGSL({ vertexShader: programFixtures[1].vertex, fragmentShader: programFixtures[1].fragment }).version, 100);
});

test('uniforms are live by GLSL name, converted for the raw block, and default to zero', () => {
  const f = programFixtures[0],
    m = material(f, { uniforms: { b: { value: true }, b2: { value: [false, 2] }, f: { value: 0.5 } } });
  assert.ok(m instanceof RawShaderMaterial);
  assert.deepEqual(Object.keys(m.uniforms), ['b', 'b2', 'f', 'lift', 'f2', 'f3', 'f4', 'i', 'i2', 'u', 'u3', 'm2', 'm3']);
  assert.equal(m.uniforms.b.value, true, 'the value as assigned');
  assert.equal(m.uniforms.user_b.value, 1, 'the block stores a bool as 1');
  assert.deepEqual(m.uniforms.user_b2.value, [0, 1], 'any non-zero number is true, as GL converts it');
  assert.deepEqual(m.uniforms.lift.value, new Array(16).fill(0), 'an omitted uniform starts at zero, as GL does');
  m.uniforms.f.value = 0.25;
  assert.equal(m.uniforms.user_f.value, 0.25);
  m.uniforms.f = { value: 0.75 };
  assert.equal(m.uniforms.user_f.value, 0.75, 'a replaced uniform object is read');
  m.uniforms.f2.value = { x: 1, y: 2 };
  assert.deepEqual(m.uniforms.user_f2.value, [1, 2], 'an {x, y} object gives its components');
  m.uniforms.b.value = 'yes';
  assert.throws(() => m.uniforms.user_b.value, { name: 'RangeError', message: /uniform b needs numbers or booleans for bool/ });
});

test('one translation per distinct program and defines; a new defines object or needsUpdate translates again', () => {
  const f = { ...programFixtures[4], fragment: programFixtures[4].fragment + '\n// a source no other test translates' },
    before = glslPrograms.count;
  const a = material(f),
    b = material(f);
  assert.equal(glslPrograms.count - before, 1, 'equal programs share a translation');
  assert.equal(a.code('fragment'), b.code('fragment'));
  const revision = a.revision;
  a.defines = { LEVEL: 1 };
  assert.equal(glslPrograms.count - before, 2);
  assert.ok(a.revision > revision, 'the pipelines rebuild');
  assert.ok(!a.code('fragment').includes('discard'), 'CHECKER is no longer defined');
  a.defines.CHECKER = true;
  a.needsUpdate = true;
  assert.ok(a.code('fragment').includes('discard'));
  assert.equal(a.vertexShader, f.vertex, 'vertexShader reads the GLSL');
  a.fragmentShader = fs.replace('vUv, 0.0', 'vUv, 0.5');
  assert.match(a.code('fragment'), /f32\(0\.5\)/);
});

test('defines that add a uniform or a texture rebuild the uniform block and bindings', () => {
  const frag = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
#ifdef TINT
uniform vec3 tint;
uniform sampler2D map;
#endif
uniform float gain;
void main() {
#ifdef TINT
  color = vec4(tint * gain, 1.0) * texture(map, vUv);
#else
  color = vec4(vUv * gain, 0.0, 1.0);
#endif
}`;
  const m = new ShaderMaterial({ vertexShader: vs, fragmentShader: frag, uniforms: { gain: { value: 2 } } });
  assert.deepEqual(m.members.map((x) => x.name), ['user_gain']);
  m.defines = { TINT: 1 };
  assert.deepEqual(m.members.map((x) => [x.name, x.offset]), [['user_tint', 0], ['user_gain', 12]]);
  assert.deepEqual(Object.keys(m.textures), ['user_map']);
  assert.deepEqual(Object.keys(m.uniforms), ['gain', 'tint', 'map']);
  assert.equal(m.uniforms.user_gain.value, 2, 'values carry over');
  m.uniforms.tint.value = [1, 0.5, 0];
  assert.deepEqual(m.uniforms.user_tint.value, [1, 0.5, 0]);
  assert.doesNotThrow(() => checkWGSL(m.code('fragment')));
});

test('link and syntax errors name the stage, line and column of the GLSL as written', () => {
  const make = (vertexShader, fragmentShader, extra) => () => new ShaderMaterial({ vertexShader, fragmentShader, ...extra });
  refusal(make(vs, fs.replace('in vec2 vUv;', 'in vec3 vUv;')), /varying vUv is vec2 in the vertexShader and vec3 here/, 'fragment', 3, 9);
  refusal(make(vs, fs.replace('in vec2 vUv;', 'in vec2 vUv;\nin float vMissing;').replace('vUv, 0.0', 'vUv, vMissing')), /varying vMissing is read but the vertexShader does not write it/, 'fragment', 4, 10);
  refusal(make(vs, fs.replace('void main() {', 'void main() {\n  float x = 1.0 +;')), /Unexpected expression token ;.*correct the fragmentShader source/, 'fragment', 6, 18);
  refusal(make(vs, fs.replace('out vec4 color;', 'out vec4 color;\nout vec4 extra;')), /2 colour outputs; the scene pass has one colour target/, 'fragment', 5, 10);
  refusal(make(vs.replace('out vec2 vUv;', 'out vec2 vUv;\nuniform float g;'), fs.replace('out vec4 color;', 'out vec4 color;\nuniform int g;')), /uniform g is float in the vertexShader and int here/, 'fragment', 5, 13);
  refusal(make(vs.replace('out vec2 vUv;', 'out vec2 vUv;\nout int k;'), fs), /integer varying k must be flat/, 'vertex', 4, 9);
  refusal(make('attribute vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }', 'precision highp float;\nvoid main() { gl_FragData[1] = vec4(1.0); }'), /gl_FragData above 0 needs more colour targets/, 'fragment', 2, 15);
  refusal(make(vs, 'precision highp float;\nvoid main() { gl_FragColor = vec4(1.0); }'), /vertexShader is GLSL ES 3\.00 and the fragmentShader 1\.00; use one version in both/, 'fragment', 1, 1);
  refusal(make(vs, fs.replace('uniform', '').replace('out vec4 color;', 'out vec4 color;\nstruct Maps { sampler2D map; float k; };\nuniform Maps holder;')), /uniform holder holds a sampler in a struct/, 'fragment', 6, 14);
  assert.throws(make(vs, fs.replace('void main()', 'void other()')), { name: 'MargoError', message: /fragmentShader: Define void main\(\) in the fragmentShader/ });
  assert.throws(make(vs, fs, { glslVersion: 100 }), { name: 'MargoError', message: /declares #version 300 but glslVersion is 100/ });
  assert.throws(make(vs, fs, { clipSpace: 'dx' }), TypeError);
  assert.throws(make(vs, fs, { defines: { 'bad name': 1 } }), TypeError);
  assert.throws(make(vs, fs, { builtins: 'unity' }), TypeError);
  assert.throws(make('x'.repeat(65537), fs), TypeError);
  assert.throws(make(vs, `void main() { ${'a+'.repeat(20000)}a; }`), { name: 'MargoError', message: /token limit/ });
});

test('GL conventions: clip z to reversed depth, rows of gl_FragCoord from the bottom, dFdy along GL window y', () => {
  const frag = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
void main() { color = vec4(gl_FragCoord.xy, dFdy(vUv.y), 1.0); }`;
  const gl = glslProgramToWGSL({ vertexShader: vs, fragmentShader: frag }),
    webgpu = glslProgramToWGSL({ vertexShader: vs, fragmentShader: frag, clipSpace: 'webgpu' });
  assert.match(gl.vertex, /o\.clip\.z=\(o\.clip\.w-o\.clip\.z\)\*0\.5;/);
  assert.doesNotMatch(webgpu.vertex, /o\.clip\.z=/);
  assert.match(gl.fragment, /glsl_FragCoord=vec4f\(p\.x,camera\.resolution\.y-p\.y,1\.0-p\.z,p\.w\)/);
  assert.match(webgpu.fragment, /glsl_FragCoord=p;/);
  assert.match(gl.fragment, /-dpdy\(/);
  assert.doesNotMatch(webgpu.fragment, /-dpdy\(/);
  // flipY flips v at a 2D lookup and nothing else.
  const lookup = fs.replace('in vec2 vUv;', 'in vec2 vUv;\nuniform sampler2D map;').replace('vec4(vUv, 0.0, 1.0)', 'texture(map, vUv)');
  assert.match(glslProgramToWGSL({ vertexShader: vs, fragmentShader: lookup }).fragment, /textureSample\(user_map,user_mapSampler,vec2f\(user_vUv\.x,1\.0-user_vUv\.y\)\)/);
  assert.match(glslProgramToWGSL({ vertexShader: vs, fragmentShader: lookup, flipY: false }).fragment, /textureSample\(user_map,user_mapSampler,user_vUv\)/);
});

test('unfilterable textures bind as unfilterable-float and filter by texel loads as GL does', () => {
  const vertexShader = '#version 300 es\nin vec3 position;void main(){gl_Position=vec4(position,1.0);}',
    fragmentShader =
      '#version 300 es\nprecision highp float;uniform sampler2D a;uniform sampler2D b;uniform sampler2D c;out vec4 o;\n' +
      'void main(){o=texture(a,vec2(0.5))+textureLod(b,vec2(0.5),2.0)+textureGrad(c,vec2(0.5),vec2(0.1),vec2(0.0))+textureOffset(a,vec2(0.5),ivec2(1,2));}';
  const unfilterable = { a: { filter: 'linear', wrap: 'clamp' }, b: { filter: 'mipmap', wrap: 'repeat' }, c: { filter: 'nearest', wrap: 'clamp' } };
  const linked = glslProgramToWGSL({ vertexShader, fragmentShader, builtins: false, unfilterable });
  assert.deepEqual(
    linked.textures.map((t) => [t.name, t.sampleType]),
    [['a', 'unfilterable-float'], ['b', 'unfilterable-float'], ['c', 'unfilterable-float']],
  );
  assert.match(linked.fragment, /margoTapsAuto\(user_a,[^;]*,0\.0,vec2i\(0\),2u\)/);
  assert.match(linked.fragment, /margoTaps\(user_b,[^;]*vec2f\(f32\(2\.0\),1\.0\),vec2i\(0\),5u\)/);
  assert.match(linked.fragment, /textureSampleGrad\(user_c,user_cSampler,/);
  assert.match(linked.fragment, /margoTapsAuto\(user_a,[^;]*,0\.0,vec2i\([^;]*1[^;]*2[^;]*\),2u\)/);
  const plain = glslProgramToWGSL({ vertexShader, fragmentShader, builtins: false });
  assert.doesNotMatch(plain.fragment, /margoTaps/, 'without unfilterable the WGSL is as before');
  const material = new ShaderMaterial({ vertexShader, fragmentShader, builtins: false, unfilterable });
  assert.equal(material.textures.user_a.sampleType, 'unfilterable-float');
  assert.doesNotThrow(() => checkWGSL(material.code('fragment')));
  assert.throws(() => glslProgramToWGSL({ vertexShader, fragmentShader, unfilterable: { a: { filter: 'cubic', wrap: 'clamp' } } }), TypeError);
});

test('a texture or view with its own texture field (the WebGL2 layer\'s objects) is the texture itself, not a {texture, sampler} pair', () => {
  // The WebGL2 layer's texture keeps its GL texture as `texture` and its views keep their texture there; once such a
  // uniform value was read as a pair and its inner object bound (KB-COMPAT-RAWFIRST1).
  const frag = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
uniform sampler2D map;
void main() { color = texture(map, vUv); }`;
  class LayerTexture {
    texture = { gl: true };
    createView() {
      return {};
    }
  }
  class LayerView {
    texture = new LayerTexture();
    dimension = '2d';
  }
  const texture = new LayerTexture(),
    view = new LayerView(),
    m = new ShaderMaterial({ vertexShader: vs, fragmentShader: frag, uniforms: { map: { value: texture } } });
  assert.equal(m.textures.user_map.texture, texture);
  m.uniforms.map.value = view;
  assert.equal(m.textures.user_map.texture, view);
  assert.equal(m.textures.user_map.sampler, undefined);
  const sampler = { magFilter: 'nearest' };
  m.uniforms.map.value = { texture, sampler };
  assert.equal(m.textures.user_map.texture, texture, 'a plain {texture, sampler} object is still a pair');
  assert.equal(m.textures.user_map.sampler, sampler);
});

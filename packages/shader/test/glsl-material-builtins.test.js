// Push 2 of GLSL programs as materials: the engine's values under each convention's names (builtins), shaderMesh,
// matrix and instance attributes, default attribute values, includes, the output colour space and the GL state names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShaderMaterial, glslProgramToWGSL, shaderMesh } from '../dist/glsl-material.js';
import { RawMesh } from '../dist/raw.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';

const fs100 = 'precision highp float;\nvoid main() { gl_FragColor = vec4(1.0); }';
const fs300 = '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(1.0); }';
const checks = (m, mesh) => {
  assert.doesNotThrow(() => checkWGSL(m.code('vertex', mesh)), 'vertex');
  assert.doesNotThrow(() => checkWGSL(m.code('fragment', mesh)), 'fragment');
};
const refused = (fn, pattern) =>
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'MargoError');
    assert.equal(e.code, 'failed');
    assert.match(e.message, pattern);
    return true;
  });

test("'modelViewMatrix': the names a program uses and does not declare are declared for it, and filled by the engine", () => {
  const m = new ShaderMaterial({
    vertexShader: `varying vec3 vN; varying vec2 vUv; varying vec3 vC;
void main() { vN = normalMatrix * normal; vUv = uv; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; varying vec3 vN; varying vec2 vUv; varying vec3 vC;
void main() { vec3 eye = normalize(cameraPosition - (viewMatrix * vec4(vN, 0.0)).xyz); gl_FragColor = vec4(vC * (isOrthographic ? 0.5 : 1.0) + eye * 0.0, 1.0); }`,
    uniforms: {},
  });
  const p = m.program;
  assert.equal(p.builtins, 'modelViewMatrix');
  assert.deepEqual(p.uniforms, [], 'engine names are not material uniforms');
  assert.deepEqual(
    p.attributes.map((a) => [a.name, a.glsl, a.semantic]),
    [
      ['position', 'vec3', 'position'],
      ['normal', 'vec3', 'normal'],
      ['uv', 'vec2', 'uv'],
      ['color', 'vec3', 'color'],
    ],
  );
  const v = m.code('vertex'),
    f = m.code('fragment');
  assert.match(v, /fn margoGLProjection\(\)->mat4x4f\{var p=camera.projection;for\(var c=0;c<4;c\+\+\)\{p\[c\].z=p\[c\].w-2.0\*p\[c\].z;\}return p;\}/);
  assert.match(v, /\(camera.view\*mesh.world\)/);
  assert.match(v, /mat3x3f\(camera.view\[0\].xyz,camera.view\[1\].xyz,camera.view\[2\].xyz\)\*mesh.normal/);
  assert.match(f, /camera.position/);
  // The camera block's projection is viewProjection times the inverse view, so a perspective w is near 0, not 0.
  assert.match(f, /camera.projection\[3\].w>0.5/);
  // The convention's defaults for an absent color and uv: (1, 1, 1) and (0, 0).
  assert.match(v, /user_color=vec3f\(1.0,1.0,1.0\);/);
  assert.match(v, /user_uv=vec2f\(0.0,0.0\);/);
  checks(m);
});

test('a built-in a stage of that convention does not declare for the program is an error, as there', () => {
  assert.throws(
    () => new ShaderMaterial({ vertexShader: 'void main() { gl_Position = projectionMatrix * vec4(0.0); }', fragmentShader: 'precision highp float;\nvoid main() { gl_FragColor = modelMatrix[0]; }' }),
    /modelMatrix/,
  );
});

test("'worldViewProjection' and 'matrix_model': declared names of the program are filled; a name in uniforms stays yours", () => {
  const wvp = new ShaderMaterial({
    vertexShader: `#version 300 es
in vec3 position; in vec2 uv2; uniform mat4 world; uniform mat4 view; uniform mat4 projection; uniform mat4 worldView; uniform mat4 worldViewProjection;
out vec2 vUv;
void main() { vUv = uv2; gl_Position = projection * view * world * vec4(position, 1.0) + worldViewProjection * vec4(0.0) + worldView * vec4(0.0); }`,
    fragmentShader: fs300,
  });
  assert.equal(wvp.program.builtins, 'worldViewProjection');
  assert.deepEqual(wvp.program.uniforms, []);
  assert.equal(wvp.program.attributes[1].semantic, 'uv1');
  assert.match(wvp.code('vertex'), /\(margoGLProjection\(\)\*camera.view\*mesh.world\)/);
  checks(wvp);
  const own = new ShaderMaterial({ vertexShader: wvp.vertexShader, fragmentShader: fs300, uniforms: { view: { value: new Array(16).fill(0) } } });
  assert.deepEqual(own.program.uniforms.map((u) => u.name), ['view'], 'listed in uniforms: the caller sets it');
  const pc = new ShaderMaterial({
    vertexShader: `#version 300 es
in vec3 vertex_position; in vec2 aUv; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; uniform mat3 matrix_normal;
uniform mat4 matrix_viewInverse; uniform mat3 matrix_view3; uniform vec4 camera_params; uniform vec4 screen_size; uniform uint view_index; uniform vec3 view_position;
out vec2 vUv;
void main() { vUv = aUv * screen_size.zw + camera_params.xy * 0.0 + float(view_index) + (matrix_normal * matrix_view3 * view_position).xy * 0.0 + matrix_viewInverse[3].xy * 0.0; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
    fragmentShader: fs300,
    attributes: { aUv: 'uv' },
  });
  assert.equal(pc.program.builtins, 'matrix_model');
  assert.deepEqual(pc.program.attributes.map((a) => a.semantic), ['position', 'uv']);
  assert.match(pc.code('vertex'), /fn margoViewInverse\(\)/);
  assert.match(pc.code('vertex'), /fn margoCameraParams\(\)/);
  checks(pc);
});

test("'auto' refuses a program that uses two conventions; builtins names one; false supplies none", () => {
  const vertexShader = '#version 300 es\nin vec3 position; uniform mat4 view; uniform mat4 matrix_model;\nvoid main() { gl_Position = view * matrix_model * vec4(position, 1.0); }';
  refused(() => new ShaderMaterial({ vertexShader, fragmentShader: fs300 }), /2 conventions \('worldViewProjection': view; 'matrix_model': matrix_model\); choose one with builtins/);
  const one = new ShaderMaterial({ vertexShader, fragmentShader: fs300, builtins: 'matrix_model' });
  assert.deepEqual(one.program.uniforms.map((u) => u.name), ['view']);
  const none = new ShaderMaterial({ vertexShader, fragmentShader: fs300, builtins: false });
  assert.deepEqual(none.program.uniforms.map((u) => u.name), ['view', 'matrix_model']);
  assert.equal(none.program.builtins, false);
  // A declared name of another type is not the engine's under 'auto', and refused under its convention.
  const typed = '#version 300 es\nin vec3 position; uniform vec4 world;\nvoid main() { gl_Position = world; }';
  assert.equal(new ShaderMaterial({ vertexShader: typed, fragmentShader: fs300 }).program.builtins, false);
  refused(() => new ShaderMaterial({ vertexShader: typed, fragmentShader: fs300, builtins: 'worldViewProjection' }), /uniform world is the engine's mat4 under builtins 'worldViewProjection'; declare it mat4/);
  assert.throws(() => new ShaderMaterial({ vertexShader: typed, fragmentShader: fs300, builtins: 'other' }), /builtins must be 'modelViewMatrix', 'worldViewProjection', 'matrix_model', 'auto' or false/);
});

test('clipSpace webgpu hands the projection over unchanged', () => {
  const m = new ShaderMaterial({ vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: fs100, clipSpace: 'webgpu' });
  assert.doesNotMatch(m.code('vertex'), /margoGLProjection/);
  assert.match(m.code('vertex'), /camera.projection\*\(camera.view\*mesh.world\)|camera.projection\*/);
});

test('matrix attributes take one vector attribute a column; an absent one is the identity; defaults are overridable', () => {
  const m = new ShaderMaterial({
    vertexShader: `#version 300 es
in vec3 position; in mat4 instanceMatrix; in vec3 instanceColor; in vec4 tint; out vec3 vC;
void main() { vC = instanceColor * tint.rgb; gl_Position = instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: fs300,
    builtins: false,
    defaultAttributeValues: { tint: [0.5, 0.25, 1] },
  });
  assert.match(m.code('vertex'), /user_instanceMatrix=mat4x4f\(vec4f\(1.0,0.0,0.0,0.0\),vec4f\(0.0,1.0,0.0,0.0\),vec4f\(0.0,0.0,1.0,0.0\),vec4f\(0.0,0.0,0.0,1.0\)\);/);
  assert.match(m.code('vertex'), /user_tint=vec4f\(0.5,0.25,1.0,1.0\);/);
  const mesh = shaderMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, m, {
    instances: { instanceMatrix: [...Array(16).keys(), ...Array(16).keys()].map(Number), instanceColor: [1, 0, 0, 0, 1, 0] },
  });
  assert.deepEqual(
    mesh.layout.map((a) => [a.name, a.type, a.step]),
    [
      ['position', 'vec3f', 'vertex'],
      ['instanceMatrix0', 'vec4f', 'instance'],
      ['instanceMatrix1', 'vec4f', 'instance'],
      ['instanceMatrix2', 'vec4f', 'instance'],
      ['instanceMatrix3', 'vec4f', 'instance'],
      ['instanceColor', 'vec3f', 'instance'],
    ],
  );
  assert.deepEqual([...mesh.getAttribute('instanceMatrix2').data], [8, 9, 10, 11, 8, 9, 10, 11]);
  assert.equal(mesh.instanceCount, 2);
  assert.equal(mesh.frustumCulled, false, 'builtins false: the program places points with its own matrices');
  const v = m.code('vertex', mesh);
  assert.match(v, /user_instanceMatrix=mat4x4f\(a.instanceMatrix0,a.instanceMatrix1,a.instanceMatrix2,a.instanceMatrix3\);/);
  checks(m, mesh);
});

test('shaderMesh maps geometry streams by what each attribute holds, from plain arrays or a core Geometry', () => {
  const m = new ShaderMaterial({
    vertexShader: '#version 300 es\nin vec3 aPos; in vec3 aNormal; in vec2 aUv; out vec2 vUv;\nvoid main() { vUv = aUv + aNormal.xy; gl_Position = vec4(aPos, 1.0); }',
    fragmentShader: fs300,
    attributes: { aPos: 'position', aNormal: 'normal', aUv: 'uv' },
    builtins: false,
  });
  const plain = shaderMesh({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }, m, { frustumCulled: true });
  assert.ok(plain instanceof RawMesh);
  assert.deepEqual(plain.layout.map((a) => a.name), ['aPos', 'aNormal', 'aUv']);
  assert.deepEqual(plain.bounds.center, [1, 1, 0]);
  assert.ok(plain.bounds.radius >= Math.SQRT2 && plain.bounds.radius < Math.SQRT2 + 1e-5);
  assert.equal(plain.frustumCulled, true);
  const core = shaderMesh({ vertices: [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2] }, m);
  assert.deepEqual([...core.getAttribute('aNormal').data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.equal(core.getAttribute('aUv'), undefined, 'absent: reads its default');
  assert.throws(() => shaderMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0] }, m), /per-vertex attributes hold 3 and 1 vertices/);
  assert.throws(() => shaderMesh({ positions: [0, 0, 0, 1] }, m), /aPos needs a multiple of 3 numbers/);
  assert.throws(() => shaderMesh({ positions: [] }, {}), /needs a ShaderMaterial/);
});

test('includes: your text, the two built-in chunks as the display transform in two steps, and refusals with a position', () => {
  const m = new ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: 'precision highp float;\n#include <common>\nvoid main() {\n  gl_FragColor = vec4(half(vec3(2.0)), 1.0);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}',
    includes: { common: 'vec3 half(vec3 x) { return x * 0.5; }' },
  });
  const f = m.code('fragment');
  assert.match(f, /camera.encoding==f32\(0.0\)/);
  assert.match(f, /camera.encoding==f32\(1.0\)/);
  assert.doesNotMatch(f, /margoGLSLOutput\(/, 'the program writes for its target itself');
  checks(m);
  const es3 = new ShaderMaterial({
    vertexShader: '#version 300 es\nin vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: '#version 300 es\nprecision highp float;\nout highp vec4 outColor;\nvoid main() {\n  outColor = vec4(1.0);\n  #include <colorspace_fragment>\n}',
  });
  assert.match(es3.code('fragment'), /user_outColor/);
  checks(es3);
  assert.throws(
    () => new ShaderMaterial({ vertexShader: es3.vertexShader, fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 c;\n#include <lights_pars_begin>\nvoid main() { c = vec4(1.0); }' }),
    (e) => e.code === 'failed' && /#include <lights_pars_begin> is not known; pass its text in includes/.test(e.message) && e.line === 4 && e.stage === 'fragment',
  );
  refused(() => new ShaderMaterial({ vertexShader: '#include <colorspace_fragment>\nvoid main() { gl_Position = vec4(0.0); }', fragmentShader: fs100 }), /belongs in the fragmentShader/);
  refused(() => new ShaderMaterial({ vertexShader: es3.vertexShader, fragmentShader: '#include <a>\n' + fs100, includes: { a: '#include <a>' } }), /nests more than 8 deep/);
});

test("outputColorSpace: 'srgb' is written as returned on an sRGB display target and decoded elsewhere; 'linear' takes the display transform", () => {
  const srgb = new ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: fs100 });
  assert.match(srgb.code('fragment'), /o.color=margoGLSLOutput\(glsl_FragColor\);/);
  assert.match(srgb.code('fragment'), /if\(camera.encoding==1.0\)\{return c;\}/);
  const linear = new ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: fs100, outputColorSpace: 'linear' });
  assert.match(linear.code('fragment'), /o.color=margoDisplay\(glsl_FragColor\);/);
  checks(linear);
  assert.throws(() => new ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: fs100, outputColorSpace: 'p3' }), /outputColorSpace must be 'srgb' or 'linear'/);
});

test('GL state names: side, depthFunc, polygonOffset and custom blending map onto the raw state, live', () => {
  const base = { vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: fs100 };
  const m = new ShaderMaterial({ ...base, side: 'double', depthFunc: 'less', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  assert.equal(m.cull, 'none');
  assert.equal(m.depthCompare, 'greater', "GL's less is reversed Z's greater");
  assert.equal(m.depthFunc, 'less');
  assert.equal(m.depthBias, -2);
  assert.equal(m.depthBiasSlopeScale, -1);
  m.side = 'back';
  assert.equal(m.cull, 'front');
  m.depthFunc = 'greater-equal';
  assert.equal(m.depthCompare, 'less-equal');
  m.polygonOffset = false;
  assert.equal(m.depthBias, 0);
  assert.equal(new ShaderMaterial(base).depthCompare, 'greater-equal', "the default, GL's less-equal");
  assert.equal(new ShaderMaterial(base).side, 'front');
  assert.throws(() => new ShaderMaterial({ ...base, side: 'double', cull: 'none' }), /side or cull, not both/);
  assert.throws(() => (m.side = 'both'), /side must be/);
  assert.throws(() => new ShaderMaterial({ ...base, depthFunc: 'lequal' }), /depthFunc must be one of/);
  const custom = new ShaderMaterial({ ...base, transparent: true, blending: 'custom', blendSrc: 'one', blendDst: 'one', blendEquation: 'max' });
  assert.deepEqual(custom.blend(), {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  });
  assert.equal(new ShaderMaterial({ ...base, blending: 'subtractive' }).blend().color.operation, 'reverse-subtract');
});

test('glslProgramToWGSL takes builtins too and reports the convention', () => {
  const w = glslProgramToWGSL({ vertexShader: 'void main() { gl_Position = projectionMatrix * vec4(position, 1.0); }', fragmentShader: fs100 });
  assert.equal(w.builtins, 'modelViewMatrix');
  assert.deepEqual(w.attributes, [{ name: 'position', glsl: 'vec3', semantic: 'position' }]);
});

test('every builtins fixture of the GPU check links, and both stages check on the WebGL2 layer for its shaderMesh', async () => {
  const { builtinFixtures } = await import('./glsl-material-builtins-fixtures.js');
  for (const f of builtinFixtures) {
    const uniforms = Object.fromEntries(Object.entries(f.uniforms).map(([k, v]) => [k, { value: v[1] }]));
    const m = new ShaderMaterial({ vertexShader: f.vertex, fragmentShader: f.fragment, uniforms, ...f.options });
    const mesh = shaderMesh(f.geometry, m, { instances: f.instances });
    assert.ok(mesh.layout.length >= 2, f.name);
    checks(m, mesh);
  }
});

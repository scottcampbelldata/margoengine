import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureMaterialLibrary, restoreMaterialLibrary } from '@margoengine/materials/serialization';
import { ShaderMaterial, shaderMesh, glslProgramToWGSL } from '../dist/glsl-material.js';
import { RawMesh, RawShaderMaterial } from '../dist/raw.js';
import { shaderMaterialCodecs, glslMaterialCodec } from '../dist/serialization.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { dataFixtures } from './glsl-material-data-fixtures.js';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
async function snapshot(name, text) {
  const file = snapshots + name;
  if (process.env.UPDATE_SNAPSHOTS) {
    await mkdir(snapshots, { recursive: true });
    await writeFile(file, text);
  }
  assert.equal(text, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'), name + ' changed (UPDATE_SNAPSHOTS=1 to accept)');
}
const snapshotNames = ['structs', 'sampler-kinds', 'sampler-loop', 'points', 'flat-list', 'flat-strip', 'wireframe'];
const valuesOf = (f) => Object.fromEntries(Object.entries(f.values?.[0] ?? {}).map(([k, v]) => [k, { value: v }]));
const make = (f, extra = {}) => new ShaderMaterial({ vertexShader: f.vertex, fragmentShader: f.fragment, uniforms: valuesOf(f), flipY: f.flipY ?? true, ...f.options, ...extra });
const meshOf = (f, m) =>
  f.geometry
    ? shaderMesh(f.geometry, m, { attributes: f.meshAttributes, ...(f.topology ? { topology: f.topology } : {}) })
    : new RawMesh({ material: m, attributes: Object.fromEntries(Object.entries(f.attributes).map(([k, a]) => [k, { data: a.data, type: a.size === 1 ? 'f32' : `vec${a.size}f` }])), index: f.index });
const vs = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
const fs = (body, head = '') => `#version 300 es
precision highp float;
${head}
out vec4 color;
void main() { ${body} }`;

test('every data fixture translates to the pinned WGSL, and each stage checks on the WebGL2 layer for its mesh', async () => {
  for (const [i, f] of dataFixtures.entries()) {
    const m = make(f),
      mesh = meshOf(f, m),
      vertex = m.code('vertex', mesh),
      fragment = m.code('fragment', mesh);
    await snapshot(`glsl-data-${snapshotNames[i]}.wgsl`, `${vertex}\n// fragment\n${fragment}`);
    assert.doesNotThrow(() => checkWGSL(vertex), f.name + ' vertex');
    assert.doesNotThrow(() => checkWGSL(fragment), f.name + ' fragment');
  }
});

test('structs, block instances and arrays are listed one member per leaf under the names GL gives them', () => {
  const w = glslProgramToWGSL({ vertexShader: dataFixtures[0].vertex, fragmentShader: dataFixtures[0].fragment }),
    by = Object.fromEntries(w.uniforms.map((u) => [u.name, u]));
  assert.deepEqual(by['rig.fill[1].color'], { name: 'rig.fill[1].color', glsl: 'vec3', type: 'vec3f', member: 'user_rig__fill__1__color', root: 'rig', path: ['fill', [1, 0], 'color'] });
  assert.deepEqual(by['rig.weights[2]'].path, ['weights', [2, 1]]);
  assert.equal(by['rig.key.on'].type, 'u32');
  assert.equal(by['rig.key.spin'].type, 'vec4f');
  assert.deepEqual(by['offsets[1]'], { name: 'offsets[1]', glsl: 'vec2', type: 'vec2f', member: 'user_offsets__1', root: 'offsets', path: [[1, 2]] });
  assert.deepEqual(by.palette, { name: 'palette', glsl: 'vec4[3]', type: 'vec4f', member: 'user_palette', count: 3 });
  assert.deepEqual(by.skew, { name: 'skew', glsl: 'mat2x3', type: 'mat4x4f', member: 'user_skew' });
  assert.equal(by['tone.scale'].root, 'tone');
  assert.deepEqual(by.bias, { name: 'bias', glsl: 'float', type: 'f32', member: 'user_bias' });
  assert.ok(by['shift[1]'], 'a vertex-stage array');
});

test('a sampler array binds one texture per element; integer and shadow samplers bind their sample types', () => {
  const w = glslProgramToWGSL({ vertexShader: dataFixtures[1].vertex, fragmentShader: dataFixtures[1].fragment });
  assert.deepEqual(w.textures, [
    { name: 'maps[0]', glsl: 'sampler2D', dimension: '2d', binding: 'user_maps__0', root: 'maps', index: 0 },
    { name: 'maps[1]', glsl: 'sampler2D', dimension: '2d', binding: 'user_maps__1', root: 'maps', index: 1 },
    { name: 'counts', glsl: 'usampler2D', dimension: '2d', sampleType: 'uint', binding: 'user_counts' },
    { name: 'depth', glsl: 'sampler2DShadow', dimension: '2d', sampleType: 'depth', binding: 'user_depth' },
  ]);
  const loop = glslProgramToWGSL({ vertexShader: dataFixtures[2].vertex, fragmentShader: dataFixtures[2].fragment });
  assert.match(loop.fragment, /select\(select\(textureSample\(user_maps__0,user_maps__0Sampler/, 'a loop index reads every element and keeps one');
  const kinds = ['isampler3D', 'usampler2DArray', 'samplerCubeShadow', 'sampler2DArrayShadow', 'sampler2DShadow'].map((t, i) => `precision highp ${t};\nuniform ${t} s${i};`).join('\n'),
    kindsShader = fs(
      'ivec4 a = texture(s0, vec3(0.5)); uvec4 b = texture(s1, vec3(0.5, 0.5, 1.0)); float c = texture(s2, vec4(1.0, 0.0, 0.0, 0.5)) + texture(s3, vec4(0.5, 0.5, 1.0, 0.5)) + textureLod(s4, vec3(0.5), 0.0); color = vec4(vec2(a.xy) + vec2(b.xy), c, 1.0);',
      kinds,
    ),
    all = glslProgramToWGSL({ vertexShader: vs, fragmentShader: kindsShader });
  checkWGSL(new ShaderMaterial({ vertexShader: vs, fragmentShader: kindsShader }).code('fragment'));
  assert.match(all.fragment, /textureSampleCompare\(user_s2,user_s2Sampler,/);
  assert.match(all.fragment, /textureSampleCompareLevel\(user_s4,user_s4Sampler,/);
  assert.match(all.fragment, /textureLoad\(user_s1,/);
});

test('uniform values reach each leaf: nested objects, element lists, flat number runs and a zero value shaped like the type', () => {
  const f = dataFixtures[0],
    m = make(f),
    raw = m.uniforms;
  assert.deepEqual(raw.user_rig__fill__0__color.value, [0, 0.5, 0]);
  assert.equal(raw.user_rig__fill__1__on.value, 0);
  assert.deepEqual(raw.user_offsets__1.value, [0.375, -0.125], 'a flat run of vec2 numbers');
  assert.deepEqual(raw.user_palette.value, [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]);
  assert.deepEqual(raw.user_skew.value, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'columns padded into a mat4x4f');
  m.uniforms.rig.value = { ...f.values[0].rig, key: { ...f.values[0].rig.key, power: 3 } };
  assert.equal(raw.user_rig__key__power.value, 3, 'a new root value is read live');
  const blank = new ShaderMaterial({ vertexShader: f.vertex, fragmentShader: f.fragment });
  assert.deepEqual(blank.uniforms.rig.value.fill[1].color, [0, 0, 0]);
  assert.deepEqual(blank.uniforms.rig.value.weights, [0, 0, 0]);
  assert.equal(blank.uniforms.tone.value.scale, 0);
  assert.deepEqual(Object.keys(blank.uniforms).sort(), ['bias', 'gains', 'offsets', 'palette', 'rig', 'shift', 'skew', 'steps', 'tone']);
});

test('sized points become squares of six corners, one instance a point; a point list indexed is read in index order', () => {
  const f = dataFixtures[3],
    m = make(f),
    mesh = meshOf(f, m);
  assert.equal(m.program.points, true);
  assert.deepEqual(mesh.layout.map((l) => `${l.name}:${l.step}`), ['position:instance', 'size:instance', 'tint:instance', 'gl_PointCorner:vertex']);
  assert.equal(mesh.instanceCount, 3);
  assert.equal(mesh.topology, 'triangle-list');
  assert.match(m.code('vertex', mesh), /c\.xy\+a\.gl_PointCorner\*max\(glsl_PointSize,1\.0\)\/camera\.viewport\.zw\*c\.w/);
  const indexed = shaderMesh({ positions: f.geometry.positions, indices: [2, 0] }, m, { attributes: f.meshAttributes, topology: 'point-list' });
  assert.equal(indexed.instanceCount, 2);
  assert.deepEqual(Array.from(indexed.getAttribute('size').data), [8, 8]);
  assert.throws(() => shaderMesh(f.geometry, m, { attributes: f.meshAttributes, instances: { tint: [1, 1, 1] }, topology: 'point-list' }), /one instance a point/);
  // A program without gl_PointSize keeps WebGPU's one-pixel points.
  const plain = new ShaderMaterial({ vertexShader: 'attribute vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
  assert.equal(shaderMesh(f.geometry, plain, { topology: 'point-list' }).topology, 'point-list');
});

test('a program with a flat varying lists each primitive from its last vertex, winding kept', () => {
  const m = make(dataFixtures[4]),
    positions = new Array(18).fill(0),
    order = (topology, indices) => Array.from(shaderMesh({ positions, ...(indices ? { indices } : {}) }, m, { topology })['indices']);
  assert.deepEqual(order('triangle-list', [0, 1, 2, 0, 2, 3]), [2, 0, 1, 3, 0, 2]);
  assert.deepEqual(order('triangle-strip'), [2, 0, 1, 3, 2, 1, 4, 2, 3, 5, 4, 3]);
  assert.deepEqual(order('triangle-strip', new Uint16Array([0, 1, 2, 3, 0xffff, 3, 4, 5])), [2, 0, 1, 3, 2, 1, 5, 3, 4]);
  assert.deepEqual(order('line-list', [0, 1, 2, 3]), [1, 0, 3, 2]);
  assert.deepEqual(order('line-strip'), [1, 0, 2, 1, 3, 2, 4, 3, 5, 4]);
  const smooth = new ShaderMaterial({ vertexShader: 'attribute vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
  assert.deepEqual(Array.from(shaderMesh({ positions, indices: [0, 1, 2] }, smooth)['indices']), [0, 1, 2], 'no flat varying, no change');
});

test('wireframe draws the unique edges of a triangle list or strip as a line list, live', () => {
  const material = new RawShaderMaterial({ vertexShader: '@vertex fn v(a:Attributes)->@builtin(position) vec4f{return vec4f(a.p,0,1);}\n@fragment fn f()->@location(0) vec4f{return vec4f(1);}' }),
    p = { p: { data: new Float32Array(12), type: 'vec2f' } },
    list = new RawMesh({ material, attributes: p, index: [0, 1, 2, 0, 2, 3] });
  assert.equal(list.drawTopology, 'triangle-list');
  material.wireframe = true;
  assert.equal(list.drawTopology, 'line-list');
  assert.deepEqual(Array.from(list['edges'](6)), [0, 1, 1, 2, 2, 0, 2, 3, 3, 0]);
  const strip = new RawMesh({ material, attributes: p, topology: 'triangle-strip' });
  assert.deepEqual(Array.from(strip['edges'](5)), [0, 1, 1, 2, 2, 0, 2, 3, 3, 1, 3, 4, 4, 2]);
  const lines = new RawMesh({ material, attributes: p, topology: 'line-list' });
  assert.equal(lines.drawTopology, 'line-list', 'lines stay lines');
  const glsl = make(dataFixtures[6]);
  assert.equal(glsl.wireframe, true);
});

test('struct and block refusals, sampler limits and fault positions', () => {
  const refuse = (fragmentShader, pattern) => assert.throws(() => new ShaderMaterial({ vertexShader: vs, fragmentShader }), (e) => (assert.match(e.message, pattern), true));
  refuse(fs('color = vec4(holder.k);', 'struct Maps { sampler2D map; float k; };\nuniform Maps holder;'), /uniform holder holds a sampler in a struct/);
  refuse(fs('color = vec4(b.k);', 'uniform B { sampler2D m; float k; } b;'), /A uniform block holds no samplers/);
  refuse(fs('color = vec4(texture(c, vec3(1.0)));', 'precision highp isamplerCube;\nuniform isamplerCube c;'), /isamplerCube lookups need a cube texture of integers/);
  refuse(fs('color = vec4(texelFetch(d, ivec2(0), 0));', 'precision highp sampler2DShadow;\nuniform sampler2DShadow d;'), /texelFetch takes no shadow sampler/);
  refuse(fs('color = texture(m[2], vec2(0.5));', 'uniform sampler2D m[2];'), /Sampler array index 2 is outside its 2 elements/);
  refuse(fs('color = tap(m, vec2(0.5));', 'uniform sampler2D m[2];\nvec4 tap(sampler2D s[2], vec2 p) { return texture(s[0], p); }'), /takes a sampler array element; index it with a constant/);
  // The struct types of a uniform both stages declare must match by name and fields.
  assert.throws(
    () => new ShaderMaterial({ vertexShader: '#version 300 es\nin vec2 position;\nstruct L { float a; };\nuniform L l;\nvoid main() { gl_Position = vec4(position * l.a, 0.0, 1.0); }', fragmentShader: fs('color = vec4(l.a);', 'struct L { float a; float b; };\nuniform L l;') }),
    /uniform l is L in the vertexShader and L here/,
  );
});

test('a ShaderMaterial keeps its GLSL, options, uniform values and render state through a save and restore', async () => {
  const f = dataFixtures[0],
    material = new ShaderMaterial({
      vertexShader: f.vertex,
      fragmentShader: f.fragment,
      uniforms: valuesOf(f),
      defines: { LEVEL: 2 },
      flipY: false,
      outputColorSpace: 'linear',
      side: 'double',
      transparent: true,
      blending: 'additive',
      depthFunc: 'less',
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
      wireframe: true,
      name: 'saved',
    });
  material.uniforms.bias.value = 0.25;
  const codecs = [...shaderMaterialCodecs, glslMaterialCodec(ShaderMaterial)];
  const archive = await captureMaterialLibrary({ material }, { codecs });
  const restored = (await restoreMaterialLibrary(JSON.parse(JSON.stringify(archive)), { codecs })).material;
  assert.ok(restored instanceof ShaderMaterial);
  assert.equal(restored.vertexShader, f.vertex);
  assert.equal(restored.fragmentShader, f.fragment);
  assert.deepEqual(restored.defines, { LEVEL: 2 });
  assert.equal(restored.code('fragment'), material.code('fragment'));
  assert.equal(restored.uniforms.bias.value, 0.25);
  assert.deepEqual(restored.uniforms.rig.value, f.values[0].rig);
  for (const key of ['side', 'transparent', 'blending', 'depthFunc', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'depthBias', 'depthBiasSlopeScale', 'wireframe', 'name'])
    assert.deepEqual(restored[key], material[key], key);
  // Without the GLSL codec a ShaderMaterial is refused, never saved as its WGSL translation.
  await assert.rejects(async () => captureMaterialLibrary({ material }, { codecs: shaderMaterialCodecs }));
  assert.throws(() => glslMaterialCodec(RawShaderMaterial), TypeError);
  // A plain RawShaderMaterial still restores as one, with its wireframe.
  const raw = new RawShaderMaterial({ vertexShader: '@vertex fn v()->@builtin(position) vec4f{return vec4f(0);}\n@fragment fn f()->@location(0) vec4f{return vec4f(1);}', wireframe: true });
  const back = (await restoreMaterialLibrary(JSON.parse(JSON.stringify(await captureMaterialLibrary({ raw }, { codecs: shaderMaterialCodecs }))), { codecs: shaderMaterialCodecs })).raw;
  assert.equal(back.constructor, RawShaderMaterial);
  assert.equal(back.wireframe, true);
});

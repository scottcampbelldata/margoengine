import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputePass, NodeMaterial, storage, texture, uv, vec2, vec3, vec4 } from '../dist/index.js';
import * as U from '../dist/utils.js';

const map = { bind: () => undefined };
const count = (text, part) => text.split(part).length - 1;
const fragment = (nodes) => new NodeMaterial(nodes).fragmentCode;
const compute = (body) =>
  new ComputePass(4, (i) => {
    const a = vec3(i.toFloat().mul(0.25), 0.5, 0.75);
    return storage(4, 'vec4f').store(i, vec4(body(a), 1));
  }).code;

test('normalMap works out the derivative frame once and reads no tangents by default', () => {
  const code = fragment({
    normalNode: U.normalMap(texture(map).rgb),
    emissiveNode: U.normalMap(texture(map).rgb, { strength: 0.5 }),
  });
  assert.equal(count(code, 'nodeCotangentFrame('), 1); // the two maps share one frame
  assert.doesNotMatch(code, /i\.tangent/);
  assert.match(code, /dpdx\(i\.position\)/);
});

test('the tangents frame reads the mesh and needs no derivatives of the UV', () => {
  const code = fragment({ normalNode: U.normalMap(texture(map).rgb, { frame: 'tangents' }) });
  assert.doesNotMatch(code, /nodeCotangentFrame/);
  assert.match(code, /i\.tangent/);
  assert.throws(() => U.normalMap(vec3(0), { frame: 'mesh' }), /'derivatives' or 'tangents'/);
});

test('flipY turns only the derivative bitangent', () => {
  const up = fragment({ normalNode: U.normalMap(vec3(0.5, 1, 0.5)) }),
    down = fragment({ normalNode: U.normalMap(vec3(0.5, 1, 0.5), { flipY: false }) });
  assert.notEqual(up, down);
  assert.equal(
    fragment({ normalNode: U.normalMap(vec3(0.5, 1, 0.5), { frame: 'tangents', flipY: false }) }),
    fragment({ normalNode: U.normalMap(vec3(0.5, 1, 0.5), { frame: 'tangents' }) }),
  );
});

test('parallaxUV searches with explicit levels, and one step does not loop', () => {
  const search = fragment({ colorNode: texture(map, U.parallaxUV(map)).rgb }),
    single = fragment({ colorNode: texture(map, U.parallaxUV(map, { steps: 1 })).rgb });
  assert.match(search, /for \(/);
  assert.match(search, /break;/);
  assert.match(search, /textureSampleLevel/);
  assert.doesNotMatch(single, /break;/);
  for (const steps of [0, 1.5, 257, Number.NaN]) assert.throws(() => U.parallaxUV(map, { steps }), RangeError);
});

test('triplanar takes a texture or a function, three projections of each', () => {
  const seen = [];
  U.triplanar((q) => {
    seen.push(q);
    return vec4(q, 0, 1);
  });
  assert.equal(seen.length, 3);
  assert.equal(count(fragment({ colorNode: U.triplanar(map).rgb }), 'textureSample(ndt'), 3);
  assert.throws(() => U.triplanar(map, { position: vec2(0) }), /triplanar position must be vec3f/);
});

test('blend modes keep the type, and a full opacity adds no mix', () => {
  const base = vec3(0.2),
    top = vec3(0.7);
  for (const name of Object.keys(U).filter((k) => k.startsWith('blend'))) {
    assert.equal(U[name](base, top).type, 'vec3f', name);
    assert.equal(U[name](base, top, 0.5).type, 'vec3f', name);
    assert.equal(U[name](base, 0.5).type, 'vec3f', name);
  }
  assert.doesNotMatch(
    compute((a) => U.blendMultiply(a, a)),
    /mix\(/,
  );
  assert.match(
    compute((a) => U.blendMultiply(a, a, 0.5)),
    /mix\(/,
  );
  assert.throws(() => U.blendScreen(base, vec2(0)), /blend top must be vec3f/);
});

test('remap takes scalars and vectors and defaults to 0..1', () => {
  assert.equal(U.remap(vec2(0.5), 0, 1, -1, 1).type, 'vec2f');
  assert.equal(U.remap(uv().x, 0, 2).type, 'f32');
  assert.match(
    compute((a) => U.remapClamp(a, 0, 2, 1, 3)),
    /saturate/,
  );
});

test('colour and UV helpers type-check their operands', () => {
  assert.equal(U.luminance(vec3(1)).type, 'f32');
  assert.equal(U.saturation(vec3(1), 0.5).type, 'vec3f');
  assert.equal(U.hue(vec3(1), 1).type, 'vec3f');
  assert.equal(U.rotateUV(uv(), 1).type, 'vec2f');
  assert.equal(U.rotateAxis(vec3(1), vec3(0, 1, 0), 1).type, 'vec3f');
  assert.equal(U.equirectUV(vec3(0, 0, -1)).type, 'vec2f');
  assert.equal(U.matcapUV().type, 'vec2f');
  for (const f of [U.oscSine, U.oscSquare, U.oscTriangle, U.oscSawtooth]) {
    assert.equal(f().type, 'f32');
    assert.equal(f(2).type, 'f32');
  }
  assert.throws(() => U.rotateUV(vec3(0), 1), /rotateUV coord must be vec2f/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeMaterial,
  bitangentWorld,
  cameraFar,
  cameraNear,
  instanceColor,
  instanceIndex,
  instanceMatrix,
  instanceUV,
  linearDepth,
  modelMatrix,
  normalView,
  positionLocal,
  positionView,
  projectionMatrix,
  tangentLocal,
  tangentWorld,
  texture3D,
  textureCube,
  uv,
  varying,
  vec3,
  vec4,
  vertexIndex,
  viewMatrix,
  discard,
} from '../dist/index.js';
import { Texture } from '../../materials/dist/index.js';
import { displacedDepth } from '../../shared/displacement.js';

const { pbrShader, extendedPBRShader, physicalShader } = await import('../../gltf-pro/src/shader.ts');
const { instancedShader, rowsShader } = await import('../../gltf-pro/src/instanced-shader.ts');
const { shadowDepth } = await import('../../shadows/src/shader.ts');

test('view-space, tangent and depth inputs compile in both stages', () => {
  for (const x of [positionView, normalView, tangentWorld, bitangentWorld]) {
    const m = new NodeMaterial({ emissiveNode: x, positionNode: positionLocal.add(varying(x).mul(0)) });
    assert.ok(m.fragmentCode.includes('s.emissive') && m.vertexCode.includes('f.'));
  }
  const m = new NodeMaterial({ emissiveNode: tangentLocal, opacityNode: linearDepth });
  assert.match(m.vertexCode, /o\.ndv0 = margoTangent\(normalize\(i\.normal\.xyz\), i\.tangent\.xyz\);/, 'tangentLocal reaches the fragment as a varying');
  assert.ok(m.fragmentCode.includes('(-(f.view * vec4f(i.position, 1.0)).z)'));
});

test('matrices and camera planes read the frame, through one helper for the projection', () => {
  const m = new NodeMaterial({
      emissiveNode: modelMatrix.mul(viewMatrix).mul(projectionMatrix).mul(vec4(1, 0, 0, 1)).xyz.mul(cameraNear).mul(cameraFar),
    }),
    code = m.shader(pbrShader, 2);
  assert.equal(code.split('fn margoProjection()').length, 2);
  assert.ok(code.includes('f.model') && code.includes('margoProjection()[3].z'));
});

test('the built-in vertex inputs join the Input struct only when a graph reads them', () => {
  const plain = new NodeMaterial({ colorNode: vec3(1, 0, 0) }).shader(pbrShader, 2);
  assert.ok(!plain.includes('vertex_index') && !plain.includes('instance_index'));
  const m = new NodeMaterial({ emissiveNode: vec3(vertexIndex.toFloat(), instanceIndex.toFloat(), 0) });
  for (const source of [pbrShader, extendedPBRShader, physicalShader()]) {
    const code = m.shader(source, 2);
    assert.match(code, /struct Input \{[^}]*@builtin\(vertex_index\) ndVertex:u32,\n\s*@builtin\(instance_index\) ndInstance:u32\n\}/);
  }
  assert.match(m.varyingFields, /@interpolate\(flat\) ndv0:u32/);
});

test('instance inputs are constants without instances and the instance row with them', () => {
  const m = new NodeMaterial({
      emissiveNode: instanceColor.rgb.mul(instanceUV.x),
      positionNode: instanceMatrix.mul(vec4(positionLocal, 1)).xyz,
    }),
    code = m.shader(pbrShader, 2);
  assert.ok(code.includes('const margoInstanceColor:vec4f=vec4f(1);'));
  assert.ok(code.includes('const margoInstanceUV:vec4f=vec4f(1,1,0,0);'));
  assert.ok(code.includes('const margoInstanceMatrix:mat4x4f='));
  const instanced = instancedShader(code);
  assert.ok(instanced.includes('let margoInstanceColor=k.tint;') && instanced.includes('let margoInstanceUV=k.uvt;'));
  assert.ok(instanced.indexOf('let margoInstanceMatrix=') < instanced.indexOf('let p=margoI*'));
});

test('a uniform-row instanced draw shares the graph instance index, an entry point naming the built-in once', () => {
  const code = new NodeMaterial({ emissiveNode: vec3(instanceIndex.toFloat()) }).shader(pbrShader, 2),
    rows = rowsShader(instancedShader(code), 64);
  assert.equal(rows.split('@builtin(instance_index)').length, 2);
  assert.ok(rows.includes('margoK=i.ndInstance%64u;'));
});

test('cube and 3D textures declare their own kind, and the wrong kind is refused', () => {
  const volume = new Texture(
      { data: new Uint8Array(32), width: 2, height: 2, depth: 2, format: 'rgba8unorm' },
      { dimension: '3d' },
    ),
    flat = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }),
    cube = { bind: () => undefined, dimension: 'cube' };
  const m = new NodeMaterial({ emissiveNode: texture3D(volume, vec3(0.5)).rgb.add(textureCube(cube, vec3(0, 1, 0)).rgb) }),
    code = m.shader(pbrShader, 2);
  assert.ok(code.includes('texture_3d<f32>') && code.includes('texture_cube<f32>'));
  assert.throws(() => textureCube(flat, vec3(0, 1, 0)), /dimension cube, not 2d/);
  assert.throws(() => texture3D(flat, vec3(0.5)), /dimension 3d/);
  assert.throws(() => textureCube({}, vec3(0, 1, 0)), /textureCube\(\) needs a Texture/);
});

test('a depth pass reads the vertex index, and inputs it does not have leave that half of the graph out', () => {
  const device = {},
    indexed = new NodeMaterial({ positionNode: positionLocal.add(vertexIndex.toFloat()) }),
    code = displacedDepth(shadowDepth(true), 1, indexed.caster(device));
  assert.match(code, /struct In \{[^}]*@builtin\(vertex_index\) ndVertex:u32\}/);
  for (const node of [positionView, tangentWorld, instanceUV.xyz])
    assert.equal(new NodeMaterial({ positionNode: positionLocal.add(node) }).caster(device), undefined);
  assert.equal(new NodeMaterial({ positionNode: modelMatrix.mul(vec4(positionLocal, 1)).xyz }).caster(device), undefined);
  assert.equal(new NodeMaterial({ colorNode: discard(linearDepth.lessThan(1), vec3(1)) }).caster(device), undefined);
  const kept = new NodeMaterial({ colorNode: discard(varying(tangentWorld).x.lessThan(0), vec3(uv(), 1)) });
  assert.equal(kept.caster(device), undefined, 'a varying the depth pass cannot compute takes its cut with it');
});

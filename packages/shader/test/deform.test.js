import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial, positionLocal, storage, vec3 } from '../dist/index.js';
import { morphing, skinning, worldNormal } from '../dist/deform.js';
import { displacedDepth } from '../../shared/displacement.js';

const { pbrShader } = await import('../../gltf-pro/src/shader.ts');
const { shadowDepth } = await import('../../shadows/src/shader.ts');

const skin = () =>
    skinning({
      bones: storage(new Float32Array(32), 'vec4f'),
      joints: storage(new Uint32Array(16), 'vec4u'),
      weights: storage(new Float32Array(16), 'vec4f'),
    }),
  morph = (normals) =>
    morphing({
      count: 2,
      vertices: 4,
      positions: storage(new Float32Array(32), 'vec4f'),
      normals: normals ? storage(new Float32Array(32), 'vec4f') : undefined,
      weights: storage(new Float32Array(2), 'f32'),
    });

test('skinning reads four bones per vertex through the vertex index, in the vertex stage only', () => {
  const m = new NodeMaterial({ positionNode: skin().position(), positionNormals: 'keep' }),
    code = m.shader(pbrShader, 2);
  assert.ok(m.vertexCode.includes('i.ndVertex'));
  assert.equal(m.fragmentCode.includes('ndb'), false, 'the fragment stage reads no skin buffer');
  assert.equal(code.split('var<storage, read>').length, 4, 'bones, joints and weights, read only as a vertex stage needs');
});

test('morphing folds its targets in a bounded loop, each target a block of vertices', () => {
  const m = new NodeMaterial({ positionNode: morph().position(), positionNormals: 'keep' });
  assert.match(m.vertexCode, /for \(/);
  assert.ok(m.vertexCode.includes('i.ndVertex'));
});

test('a morph without normal offsets hands the base normal back', () => {
  const base = vec3(0, 0, 1);
  assert.equal(morph(false).normal(base), base);
  assert.notEqual(morph(true).normal(base), base);
});

test('a morph refuses a count or vertex count that is not a whole number of at least 1', () => {
  const options = {
    positions: storage(new Float32Array(4), 'vec4f'),
    weights: storage(new Float32Array(1), 'f32'),
  };
  assert.throws(() => morphing({ ...options, count: 0, vertices: 1 }), /whole count/);
  assert.throws(() => morphing({ ...options, count: 1, vertices: 1.5 }), /whole count/);
});

test('deformation chains: morph into skin, with an effect on top', () => {
  const s = skin(),
    m = new NodeMaterial({
      positionNode: s.position(morph().position()).add(vec3(0, 1, 0)),
      normalNode: worldNormal(s.normal()),
    });
  assert.equal(m.shader(pbrShader, 2).split('var<storage, read>').length, 6);
});

test('a skinned depth pass draws the same deformation, reading the vertex index', () => {
  const m = new NodeMaterial({ positionNode: skin().position(positionLocal) }),
    displacement = m.caster({});
  assert.ok(displacement, 'nothing about skinning needs the camera');
  const code = displacedDepth(shadowDepth(true), 1, displacement);
  assert.match(code, /@builtin\(vertex_index\) ndVertex:u32/);
  assert.equal(code.split('var<storage, read>').length, 4);
});

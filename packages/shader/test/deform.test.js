import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial, positionLocal, storage, vec3 } from '../dist/index.js';
import { morphing, skinning, skinningFromModel, worldNormal } from '../dist/deform.js';
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

// A model of two joints on one node, in the shape gltf-pro gives it.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  shift = (x, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  skinned = ({ attributes = { JOINTS_0: 1, WEIGHTS_0: 2 }, skin = 0, inverseBind = 3 } = {}) => {
    const vertices = new Float32Array(40);
    vertices.set([1, 2, 3, 1, 0, 1, 0], 0);
    vertices.set([0.25, 0.75], 12);
    vertices.set([4, 5, 6, 1, 0, 0, 1], 20);
    const accessors = { 1: [0, 1, 0, 0, 1, 0, 0, 0], 2: [0.5, 0.5, 0, 0, 1, 0, 0, 0], 3: [...shift(-1), ...identity] };
    return {
      model: {
        nodes: [{ matrix: identity }, { matrix: shift(10) }, { matrix: shift(0, 20) }],
        asset: {
          doc: { nodes: [{ skin }], skins: [{ joints: [1, 2], inverseBindMatrices: inverseBind ?? undefined }] },
          accessor: (index) => accessors[index],
        },
      },
      primitive: { nodeIndex: 0, vertices, indices: new Uint32Array([0, 1, 0]), definition: { attributes } },
    };
  };

test('skinningFromModel reads the joints, the weights and the bind pose of a loaded primitive', () => {
  const { model, primitive } = skinned(),
    skin = skinningFromModel(model, primitive);
  assert.deepEqual([...skin.joints.data], [0, 1, 0, 0, 1, 0, 0, 0]);
  assert.ok(skin.joints.data instanceof Uint32Array, 'joints are integers in the shader');
  assert.deepEqual([...skin.weights.data], [0.5, 0.5, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual([...skin.geometry.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...skin.geometry.normals], [0, 1, 0, 0, 0, 1]);
  assert.deepEqual([...skin.geometry.uvs], [0.25, 0.75, 0, 0]);
  assert.equal(skin.geometry.indices, primitive.indices);
  const m = new NodeMaterial({ positionNode: skin.position(), positionNormals: 'keep' });
  m.shader(pbrShader, 2);
  assert.ok(m.vertexCode.includes('i.ndVertex'));
});

test('the palette is each joint times its inverse bind matrix, and update follows the nodes', () => {
  const { model, primitive } = skinned(),
    skin = skinningFromModel(model, primitive),
    bone = (i) => [...skin.bones.data.subarray(i * 16, i * 16 + 16)];
  assert.deepEqual(bone(0), shift(9), 'a shift of 10 after a bind of -1');
  assert.deepEqual(bone(1), shift(0, 20));
  const before = skin.bones.version;
  model.nodes[2].matrix = shift(0, 0, 7);
  skin.update();
  assert.deepEqual(bone(1), shift(0, 0, 7));
  assert.notEqual(skin.bones.version, before, 'the GPU copy is told');
});

test('a skin with no inverse bind matrices uses the joints as they are', () => {
  const { model, primitive } = skinned({ inverseBind: null });
  assert.deepEqual([...skinningFromModel(model, primitive).bones.data.subarray(0, 16)], shift(10));
});

test('a primitive with no skin, and one with eight influences, say why', () => {
  const none = skinned({ skin: null }),
    wide = skinned({ attributes: { JOINTS_0: 1, WEIGHTS_0: 2, JOINTS_1: 1, WEIGHTS_1: 2 } });
  assert.throws(() => skinningFromModel(none.model, none.primitive), { code: 'state' });
  assert.throws(() => skinningFromModel(wide.model, wide.primitive), { code: 'unsupported' });
});

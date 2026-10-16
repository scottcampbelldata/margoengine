import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  animationDocument,
  animationDefinition,
  animationChannel,
  animationSampler,
  animationNode,
  animationAccessor,
  animationIndex,
  animationPath,
  animationInterpolation,
  skinDefinition,
  morphDefinition,
} from '../src/gltf.ts';

test('animation subset retains checked channels, sampler metadata, skin attributes and morph indices', () => {
  const source = {
      nodes: [{ skin: 0 }],
      accessors: [{ componentType: 5123, normalized: false }],
      animations: [
        {
          name: 'Walk',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
      skins: [{ joints: [0] }],
    },
    doc = animationDocument(source);
  const definition = animationDefinition(doc.animations[0]),
    channel = animationChannel(definition.channels[0]),
    sampler = animationSampler(definition.samplers[0]);
  assert.equal(definition.name, 'Walk');
  assert.deepEqual(channel, { sampler: 0, target: { node: 0, path: 'translation' } });
  assert.equal(animationIndex(channel.target.node, 1, 'node'), 0);
  assert.equal(animationPath(channel.target.path), 'translation');
  assert.equal(animationInterpolation(sampler.interpolation), 'LINEAR');
  assert.equal(animationNode(doc.nodes[0]).skin, 0);
  assert.deepEqual(animationAccessor(doc, 0), { componentType: 5123, normalized: false });
  assert.deepEqual(skinDefinition(doc.skins[0], 1), { joints: [0], inverseBindMatrices: undefined });
  const primitive = morphDefinition({
    targets: [{ POSITION: 4, NORMAL: 5, TANGENT: 6 }],
    attributes: { JOINTS_0: 0, WEIGHTS_0: 1, JOINTS_1: 2, WEIGHTS_1: 3 },
  });
  assert.deepEqual(primitive.targets, [{ POSITION: 4, NORMAL: 5, TANGENT: 6 }]);
  assert.deepEqual(primitive.attributes, { JOINTS_0: 0, WEIGHTS_0: 1, JOINTS_1: 2, WEIGHTS_1: 3 });
});
test('animation schema keeps malformed definitions and invalid target/time diagnostics', () => {
  for (const value of [
    null,
    [],
    { channels: [], samplers: null },
    { channels: null, samplers: [] },
    { name: 3, channels: [], samplers: [] },
  ])
    assert.throws(() => animationDefinition(value), /Invalid glTF animation/);
  for (const value of [undefined, '0', -1, 1, 0.5, NaN])
    assert.throws(() => animationIndex(value, 1, 'node'), /Invalid animation node/);
  for (const target of [{}, null, 'node']) assert.equal(animationChannel({ target }).target.node, undefined);
  for (const path of [null, 0, 'position', 'color'])
    assert.throws(() => animationPath(path), /Invalid animation target/);
  for (const interpolation of [null, 0, 'BEZIER'])
    assert.throws(() => animationInterpolation(interpolation), /Invalid animation time\/interpolation/);
  for (const interpolation of ['STEP', 'LINEAR', 'CUBICSPLINE'])
    assert.equal(animationInterpolation(interpolation), interpolation);
  assert.throws(() => animationSampler(null), /Invalid glTF animation/);
  assert.throws(() => animationNode(null), /Invalid animation target/);
});
test('checked skins reject duplicate, missing, non-integer and out-of-range joints', () => {
  for (const joints of [undefined, [], [0, 0], [-1], [1], [0.5], ['0'], [NaN]])
    assert.throws(() => skinDefinition({ joints }, 1), /Invalid skin joints/);
  assert.throws(() => skinDefinition(null, 1), /Invalid skin joints/);
  const inverseBindMatrices = 3;
  assert.deepEqual(skinDefinition({ joints: [0], inverseBindMatrices }, 1), { joints: [0], inverseBindMatrices });
});
test('morph subset preserves loader accessor validation and rejects non-object targets or attributes', () => {
  for (const value of [null, { targets: 3 }, { targets: [null] }, { targets: [[]] }, { attributes: 3 }])
    assert.throws(() => morphDefinition(value), /Invalid glTF morph target|Invalid skin attributes/);
  assert.equal(
    morphDefinition({ targets: [{ POSITION: 'invalid' }] }).targets[0].POSITION,
    'invalid',
    'The native asset accessor still validates each referenced index',
  );
  assert.deepEqual(morphDefinition({}), { targets: [], attributes: {} });
  const doc = animationDocument({ nodes: [{}] });
  assert.equal(animationAccessor(doc, 0), undefined);
  assert.equal(animationAccessor(doc, '0'), undefined);
});
test('animation source no longer propagates any from the glTF JSON boundary', async () => {
  for (const file of ['index.ts', 'gltf.ts'])
    assert.doesNotMatch(await readFile(new URL('../src/' + file, import.meta.url), 'utf8'), /\bany\b/);
});

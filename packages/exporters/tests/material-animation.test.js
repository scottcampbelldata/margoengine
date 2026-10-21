import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB, exportGLTF } from '../dist/index.js';
import { readGLB, accessor } from './helpers.js';
import { material, quad, channel, fixture } from './material-animation-fixture.js';

test('public exporter writes literal fixed material pointers, ordered after node clips, without changing inputs', () => {
  const { scene, node } = fixture(),
    before = structuredClone(scene);
  scene.animations = [
    { name: 'node', channels: [{ node, path: 'translation', times: [0, 0.5], values: [0, 0, 0, 1, 0, 0] }] },
  ];
  before.animations = structuredClone(scene.animations);
  const bytes = exportGLB(scene),
    { json, bin } = readGLB(bytes);
  assert.equal(json.animations.length, 2);
  assert.equal(json.animations[0].name, 'node');
  assert.deepEqual(
    json.meshes[0].primitives.map((p) => p.material),
    [0, 1, 1],
  );
  assert.equal(json.materials.length, 2);
  assert.deepEqual(json.materials[1].pbrMetallicRoughness.baseColorTexture.extensions, {
    KHR_texture_transform: { offset: [0, 0], scale: [0.25, 1] },
  });
  assert.ok(json.extensionsUsed.includes('KHR_texture_transform'));
  assert.ok(json.extensionsUsed.includes('KHR_animation_pointer'));
  assert.deepEqual(json.extensionsRequired, ['KHR_texture_transform']);
  const clip = json.animations[1];
  for (const [i, property, values] of [
    [0, 'offset', [0, 0, 0.25, 0, 0.5, 0, 0.75, 0, 0, 0]],
    [1, 'scale', [0.25, 1, 0.25, 1, 0.25, 1, 0.25, 1, 0.25, 1]],
  ]) {
    assert.deepEqual(clip.channels[i].target, {
      path: 'pointer',
      extensions: {
        KHR_animation_pointer: {
          pointer: '/materials/1/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/' + property,
        },
      },
    });
    const sampler = clip.samplers[i];
    assert.equal(sampler.interpolation, 'STEP');
    for (const [id, type, expected] of [
      [sampler.input, 'SCALAR', [0, 0.125, 0.25, 0.375, 0.5]],
      [sampler.output, 'VEC2', values],
    ]) {
      const a = json.accessors[id],
        v = json.bufferViews[a.bufferView];
      assert.equal(a.componentType, 5126);
      assert.equal(a.count, 5);
      assert.equal(a.type, type);
      assert.equal(v.byteOffset % 4, 0);
      assert.ok(v.byteOffset + v.byteLength <= bin.length);
      assert.deepEqual([...accessor(json, bin, id)], expected);
    }
  }
  assert.deepEqual(json.samplers, [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }]);
  assert.deepEqual(scene, before);
  assert.deepEqual(exportGLTF(scene).json.animations, json.animations);
});

test('authored starts, inset scales, zero and negative scales stay literal and distinct equal materials stay distinct', () => {
  const { scene } = fixture(2);
  let { json, bin } = readGLB(exportGLB(scene));
  assert.equal(json.animations?.length, 1, 'material clip must be emitted');
  assert.deepEqual(
    [...accessor(json, bin, json.animations[0].samplers[0].output)],
    [0.5, 0, 0.75, 0, 0, 0, 0.25, 0, 0.5, 0],
  );
  const a = material([0.5 / 64, 0.5 / 16], [15 / 64, 15 / 16]),
    b = material([0.5 / 64, 0.5 / 16], [15 / 64, 15 / 16]);
  const inset = [0.5 / 64, 0.5 / 16, 16.5 / 64, 0.5 / 16, 32.5 / 64, 0.5 / 16, 48.5 / 64, 0.5 / 16, 0.5 / 64, 0.5 / 16];
  ({ json, bin } = readGLB(
    exportGLB({
      nodes: [
        {
          primitives: [
            { geometry: quad, material: a },
            { geometry: quad, material: b },
          ],
        },
      ],
      materialAnimations: [{ channels: [channel(b, 'offset', inset)] }],
    }),
  ));
  assert.equal(json.materials.length, 2);
  assert.deepEqual([...accessor(json, bin, json.animations[0].samplers[0].output)], inset);
  assert.deepEqual(json.materials[1].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform.scale, [
    15 / 64,
    15 / 16,
  ]);
  assert.doesNotThrow(() => exportGLB({ nodes: [{ geometry: quad, material: material([0, 0], [0, -1]) }] }));
});

test('material channel validation rejects unsupported shapes, unknown identities and non-Float32 tracks before returning bytes', () => {
  for (const mutate of [
    (f) => (f.scene.materialAnimations = null),
    (f) => (f.scene.materialAnimations = [null]),
    (f) => (f.scene.materialAnimations[0].channels = []),
    (f) => (f.scene.materialAnimations[0].channels = [null]),
    (f) => (f.scene.materialAnimations[0].name = 7),
    (f) => (f.scene.materialAnimations[0].channels[0].material = { ...f.animated }),
    (f) => (f.scene.nodes[0].visible = false),
    (f) => delete f.animated.baseColorTextureTransform,
    (f) => delete f.animated.baseColorTexture,
    (f) => (f.animated.baseColorTextureTransform = []),
    (f) => (f.animated.baseColorTextureTransform.offset = [0]),
    (f) => (f.animated.baseColorTextureTransform.scale = [1, Infinity]),
    (f) => (f.animated.baseColorTextureTransform.offset = [1e40, 0]),
    (f) => (f.scene.materialAnimations[0].channels[0].texture = 'normalTexture'),
    (f) => (f.scene.materialAnimations[0].channels[0].property = 'rotation'),
    (f) => (f.scene.materialAnimations[0].channels[0].interpolation = 'LINEAR'),
    (f) => delete f.scene.materialAnimations[0].channels[0].interpolation,
    (f) => (f.scene.materialAnimations[0].channels[0].times = []),
    (f) => (f.scene.materialAnimations[0].channels[0].times = [0, 1, 1, 2, 3]),
    (f) => (f.scene.materialAnimations[0].channels[0].times = [0, 1, 1 + 1e-9, 2, 3]),
    (f) => (f.scene.materialAnimations[0].channels[0].times = [-1, 0, 1, 2, 3]),
    (f) => (f.scene.materialAnimations[0].channels[0].times = [0, 1, 2, 3, 1e40]),
    (f) => (f.scene.materialAnimations[0].channels[0].values = [0, 0]),
    (f) => (f.scene.materialAnimations[0].channels[0].values[3] = NaN),
    (f) => f.scene.materialAnimations[0].channels.push(f.scene.materialAnimations[0].channels[0]),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => exportGLB(f.scene), { name: /TypeError|RangeError/ });
  }
  assert.throws(() => exportGLB(fixture().scene, { flatten: true }), /Flatten/);
  const f = fixture();
  f.scene.materialAnimations.push(f.scene.materialAnimations[0]);
  assert.equal(readGLB(exportGLB(f.scene)).json.animations.length, 2, 'separate clips may share a target');
});

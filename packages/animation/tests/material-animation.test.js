import test from 'node:test';
import assert from 'node:assert/strict';
import * as animation from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { exportGLB } from '@margoengine/exporters';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';
import { fixture, material, channel, quad } from '../../exporters/tests/material-animation-fixture.js';

async function load(t, scene) {
  const engine = await loadedPBREngine();
  engine.gpu.queue.copyExternalImageToTexture = () => {};
  engine.gpu.queue.submit = () => {};
  engine.gpu.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (source) => {
    const view = new DataView(await source.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  };
  t.after(() => {
    engine.dispose();
    if (bitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = bitmap;
  });
  return parseGLTFAsync(engine, exportGLB(scene), {});
}

test('public material player seeks real parsed glTF STEP tracks and synchronizes maps and retained UV rows', async (t) => {
  assert.equal(typeof animation.createMaterialAnimation, 'function');
  const { scene } = fixture(),
    model = await load(t, scene),
    doc = structuredClone(model.asset.doc);
  const still = model.primitives[0].material,
    target = model.primitives[1].material;
  const stillBefore = structuredClone(still),
    originalMap = target.maps[0],
    originalTransform = originalMap.extensions.KHR_texture_transform;
  const originalMaps = target.maps,
    mapsBefore = structuredClone(target.maps);
  const otherRows = target.uvt.slice(8),
    factors = target.factors.slice(),
    settings = target.settings.slice();
  const player = animation.createMaterialAnimation(model);
  for (const [seconds, x] of [
    [0, 0],
    [0.124999, 0],
    [0.125, 0.25],
    [0.25, 0.5],
    [0.375, 0.75],
    [0.5, 0],
  ]) {
    player.seek(seconds);
    assert.equal(model.primitives[1].material, target);
    assert.equal(model.primitives[2].material, target);
    assert.deepEqual(target.maps[0].extensions.KHR_texture_transform, { offset: [x, 0], scale: [0.25, 1] });
    assert.deepEqual(target.uvt.slice(0, 8), [0.25, 0, x, 0, -0, 1, 0, 0]);
    assert.deepEqual(target.uvt.slice(8), otherRows);
    assert.deepEqual(target.factors, factors);
    assert.deepEqual(target.settings, settings);
    const pick = model.pickingPrimitives.find((p) => p.primitive === model.primitives[1]);
    assert.ok(pick, 'real model setup supplies a public picking primitive');
    assert.deepEqual([...pick.alphaTransform], [0.25, 0, x, 0, -0, 1, 0, 0]);
    assert.equal(pick.cutoff, 0.25);
    assert.equal(pick.doubleSided, true);
    assert.deepEqual(still, stillBefore);
    assert.deepEqual(model.asset.doc, doc);
    assert.deepEqual(originalMaps, mapsBefore, 'the input maps array stays unchanged at every sample');
  }
  assert.deepEqual(originalTransform, { offset: [0, 0], scale: [0.25, 1] });
  assert.deepEqual(originalMaps, mapsBefore, 'do not mutate the original maps array');
  player.seek(0.25);
  const cachedMap = target.maps[0],
    cachedRows = target.uvt;
  player.seek(0.3);
  assert.equal(target.maps[0], cachedMap);
  assert.equal(target.uvt, cachedRows);
  player.dispose();
  player.dispose();
  assert.equal(target.maps[0], cachedMap);
  assert.throws(() => player.seek(0), /disposed/);
});

test('authored start2 samples and independent water/fire loops preserve a static same-atlas neighbor', async (t) => {
  const f = fixture(2),
    model = await load(t, f.scene),
    player = animation.createMaterialAnimation(model);
  for (const [seconds, x] of [
    [0, 0.5],
    [0.124999, 0.5],
    [0.125, 0.75],
    [0.25, 0],
    [0.375, 0.25],
    [0.5, 0.5],
    [10, 0.5],
  ]) {
    player.seek(seconds);
    assert.equal(model.primitives[1].material.uvt[2], x);
  }
  player.dispose();
  const water = material(),
    fire = material([0, 0], [1 / 6, 1]),
    still = material([0.75, 0]);
  const scene = {
    nodes: [{ primitives: [water, fire, still].map((m) => ({ geometry: quad, material: m })) }],
    materialAnimations: [
      { channels: [channel(water)] },
      {
        channels: [
          channel(
            fire,
            'offset',
            [0, 0, 1 / 6, 0, 2 / 6, 0, 3 / 6, 0, 4 / 6, 0, 5 / 6, 0, 0, 0],
            [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75],
          ),
        ],
      },
    ],
  };
  const loops = await load(t, scene),
    a = animation.createMaterialAnimation(loops, { loop: true }),
    b = animation.createMaterialAnimation(loops, { clip: 1, loop: true });
  const control = structuredClone(loops.primitives[2].material);
  for (const [seconds, wa, fi] of [
    [0, 0, 0],
    [0.125, 1, 1],
    [0.25, 2, 2],
    [0.375, 3, 3],
    [0.5, 0, 4],
    [0.625, 1, 5],
    [0.75, 2, 0],
    [1, 0, 2],
    [1.5, 0, 0],
  ]) {
    a.seek(seconds);
    b.seek(seconds);
    assert.equal(loops.primitives[0].material.uvt[2], wa / 4);
    assert.equal(loops.primitives[1].material.uvt[2], Math.fround(fi / 6));
    assert.deepEqual(loops.primitives[2].material, control);
  }
  a.dispose();
  b.dispose();
});

test('ownership conflicts reject atomically, disjoint properties compose, disposal releases claims and model cleanup', async (t) => {
  const f = fixture();
  f.scene.materialAnimations.push({ channels: [channel(f.animated)] });
  f.scene.materialAnimations.push({ channels: [channel(f.animated, 'scale', [1, 1, 2, 2, 3, 3, 4, 4, 5, 5])] });
  const model = await load(t, f.scene),
    target = model.primitives[1].material,
    before = structuredClone(target);
  const a = animation.createMaterialAnimation(model);
  assert.deepEqual(target, before, 'construction does not seek');
  assert.throws(() => animation.createMaterialAnimation(model, { clip: 1 }), /owned|active|attached/);
  assert.deepEqual(target, before);
  assert.throws(() => animation.createMaterialAnimation(model, { clip: 2 }), /owned|active|attached/);
  a.dispose();
  f.scene.materialAnimations[0].channels.pop();
  const separated = await load(t, f.scene),
    offset = animation.createMaterialAnimation(separated),
    scale = animation.createMaterialAnimation(separated, { clip: 2 });
  offset.seek(0.25);
  scale.seek(0.125);
  assert.deepEqual(separated.primitives[1].material.uvt.slice(0, 8), [2, 0, 0.5, 0, -0, 2, 0, 0]);
  offset.seek(0.25);
  assert.equal(separated.primitives[1].material.uvt[0], 2, 'cached offset must preserve other active scale');
  offset.dispose();
  const reused = animation.createMaterialAnimation(separated);
  reused.dispose();
  separated.dispose();
  assert.throws(() => scale.seek(0), /disposed/);
  scale.dispose();
  assert.throws(() => animation.createMaterialAnimation(separated), /disposed/);
});

test('all bindings and samples preflight before writes, changed materials stay untouched, invalid options and seeks reject', async (t) => {
  const f = fixture();
  f.scene.materialAnimations[0].channels.push(channel(f.still));
  const model = await load(t, f.scene),
    target = model.primitives[1].material,
    player = animation.createMaterialAnimation(model);
  const before = structuredClone(target);
  for (const seconds of [-1, NaN, Infinity, '0', null]) assert.throws(() => player.seek(seconds), /finite|seconds/);
  assert.deepEqual(target, before);
  const replacement = structuredClone(model.primitives[0].material),
    replacementBefore = structuredClone(replacement);
  model.primitives[0].material = replacement;
  assert.throws(() => player.seek(0.25), /changed|binding|replaced/);
  assert.deepEqual(target, before);
  assert.deepEqual(replacement, replacementBefore);
  player.dispose();
  for (const options of [
    null,
    [],
    { clip: null },
    { clip: -1 },
    { clip: 99 },
    { clip: 0.5 },
    { clip: '0' },
    { loop: 1 },
  ])
    assert.throws(() => animation.createMaterialAnimation(model, options));
  assert.throws(() => animation.createMaterialAnimation({}));
});

test('node-only clips remain node animations and mixed clips skip only fully validated supported pointers', async (t) => {
  const f = fixture(),
    model = await load(t, f.scene);
  const def = model.asset.doc.animations[0];
  // Real node clips use their own correctly typed exported accessors.
  const n = fixture();
  n.scene.animations = [
    { channels: [{ node: n.node, path: 'translation', times: [0, 0.5], values: [0, 0, 0, 2, 0, 0] }] },
  ];
  const mixed = await load(t, n.scene),
    mixedDoc = mixed.asset.doc;
  assert.throws(() => animation.createMaterialAnimation(mixed), /material|track/);
  const ordinary = new animation.Animation(mixed, { loop: false });
  ordinary.seek(0.5);
  ordinary.dispose();
  mixedDoc.animations[0].channels.push(
    ...mixedDoc.animations[1].channels.map((c) => ({ ...c, sampler: c.sampler + 1 })),
  );
  mixedDoc.animations[0].samplers.push(...mixedDoc.animations[1].samplers);
  const nodes = new animation.Animation(mixed, { loop: false }),
    materials = animation.createMaterialAnimation(mixed);
  nodes.seek(0.25);
  materials.seek(0.25);
  assert.equal(mixed.nodes[0].position.x, 1);
  assert.equal(mixed.primitives[1].material.uvt[2], 0.5);
  nodes.dispose();
  materials.dispose();
  const unknown = structuredClone(def.channels[0]);
  unknown.target.extensions.KHR_animation_pointer.pointer = '/materials/1/name';
  def.channels.push(unknown);
  assert.match(new animation.Animation(model).warnings.at(-1), /\/materials\/1\/name is not played/);
  assert.throws(() => new animation.Animation(model, { pointers: pointerChannels }), /pointer|material/);
  assert.throws(() => animation.createMaterialAnimation(model), /pointer|material/);
});

test('selected clip validates pointer tokens, accessors, STEP values, duplicates and defined initial target properties', async (t) => {
  const model = await load(t, fixture().scene),
    original = structuredClone(model.asset.doc),
    target = model.primitives[1].material,
    before = structuredClone(target);
  for (let i = 0; i < original.accessors.length; i++) model.asset.accessor(i);
  const cases = [
    (d) => (d.animations[0].channels[0].target.node = 0),
    (d) => (d.animations[0].channels[0].target.path = 'translation'),
    (d) => delete d.animations[0].channels[0].target.extensions,
    (d) =>
      (d.animations[0].channels[0].target.extensions.KHR_animation_pointer.pointer =
        '/materials/01/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset'),
    (d) =>
      (d.animations[0].channels[0].target.extensions.KHR_animation_pointer.pointer =
        '/materials/99/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset'),
    (d) =>
      (d.animations[0].channels[0].target.extensions.KHR_animation_pointer.pointer =
        '/materials/1/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/rotation'),
    (d) => (d.animations[0].samplers[0].interpolation = 'LINEAR'),
    (d) => (d.animations[0].samplers[0].input = '0'),
    (d) => (d.accessors[d.animations[0].samplers[0].input].componentType = 5123),
    (d) => (d.accessors[d.animations[0].samplers[0].output].type = 'VEC3'),
    (d) => (d.accessors[d.animations[0].samplers[0].output].normalized = true),
    (d) => (d.accessors[d.animations[0].samplers[0].output].count = 4),
    (d) => d.animations[0].channels.push(d.animations[0].channels[0]),
    (d) => delete d.materials[1].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform.offset,
  ];
  for (const change of cases) {
    Object.assign(model.asset.doc, structuredClone(original));
    change(model.asset.doc);
    assert.throws(() => animation.createMaterialAnimation(model));
    assert.deepEqual(target, before);
  }
  Object.assign(model.asset.doc, original);
  const player = animation.createMaterialAnimation(model);
  player.dispose();
});

test('a zero-duration single-key looping clip holds its key at all finite times', async (t) => {
  const f = fixture();
  f.scene.materialAnimations = [{ channels: [channel(f.animated, 'offset', [0.5, 0], [0])] }];
  const model = await load(t, f.scene),
    player = animation.createMaterialAnimation(model, { loop: true });
  for (const seconds of [0, 0.125, 100, Number.MAX_VALUE]) {
    player.seek(seconds);
    assert.equal(model.primitives[1].material.uvt[2], 0.5);
  }
  player.dispose();
});

test('each actual material instance is updated once, metadata is preserved, and alias claims cannot overlap', async (t) => {
  const f = fixture(),
    model = await load(t, f.scene);
  const first = model.primitives[1].material,
    second = structuredClone(first);
  model.primitives[2].material = second;
  const maps = first.maps.slice(),
    normalMap = { index: 0, texCoord: 1 };
  maps[1] = normalMap;
  maps[0] = {
    ...maps[0],
    texCoord: 0,
    extensions: {
      ...maps[0].extensions,
      custom: { token: 'keep' },
      KHR_texture_transform: { ...maps[0].extensions.KHR_texture_transform, rotation: Math.PI / 2, texCoord: 1 },
    },
  };
  first.maps = maps;
  const original = structuredClone(maps),
    tail = first.uvt.slice(8);
  let sets = 0,
    current = maps;
  Object.defineProperty(first, 'maps', {
    enumerable: true,
    configurable: true,
    get: () => current,
    set: (value) => {
      sets++;
      current = value;
    },
  });
  const player = animation.createMaterialAnimation(model);
  player.seek(0.25);
  assert.equal(sets, 1, 'offset and scale compose into one map assignment per actual material');
  assert.equal(first.maps[1], normalMap);
  assert.deepEqual(first.maps[0].extensions.custom, { token: 'keep' });
  assert.equal(first.maps[0].texCoord, 0);
  assert.equal(first.maps[0].extensions.KHR_texture_transform.texCoord, 1);
  assert.equal(first.maps[0].extensions.KHR_texture_transform.rotation, Math.PI / 2);
  assert.ok(Math.abs(first.uvt[0]) < 1e-15);
  assert.equal(first.uvt[1], 1);
  assert.equal(first.uvt[2], 0.5);
  assert.equal(first.uvt[3], 1);
  assert.equal(first.uvt[4], -0.25);
  assert.deepEqual(first.uvt.slice(8), tail);
  assert.equal(second.uvt[2], 0.5, 'all material instances for the document material are addressed');
  assert.deepEqual(maps, original, 'caller-supplied maps and metadata remain untouched');
  player.seek(0.3);
  assert.equal(sets, 1, 'an identical effective STEP sample causes no setter churn');
  assert.throws(() => animation.createMaterialAnimation(model), /owned/);
  player.dispose();
  const alias = fixture();
  alias.scene.materialAnimations[0].channels.push(channel(alias.still));
  const aliased = await load(t, alias.scene);
  aliased.primitives[0].material = aliased.primitives[1].material;
  assert.throws(() => animation.createMaterialAnimation(aliased), /Aliased/);
});

test('accessor data must have finite increasing times and finite VEC2 values, then player owns detached samples', async (t) => {
  const f = fixture(),
    model = await load(t, f.scene),
    sampler = model.asset.doc.animations[0].samplers[0];
  const times = model.asset.accessor(sampler.input, 'SCALAR'),
    values = model.asset.accessor(sampler.output, 'VEC2'),
    savedTimes = times.slice(),
    savedValues = values.slice();
  for (const change of [
    () => (times[1] = 0),
    () => (times[0] = -1),
    () => (times[1] = NaN),
    () => (values[1] = Infinity),
  ]) {
    times.set(savedTimes);
    values.set(savedValues);
    change();
    assert.throws(() => animation.createMaterialAnimation(model));
  }
  times.set(savedTimes);
  values.set(savedValues);
  const player = animation.createMaterialAnimation(model);
  times.fill(0);
  values.fill(0);
  player.seek(0.25);
  assert.equal(model.primitives[1].material.uvt[2], 0.5, 'sampling is detached from accessor cache');
  player.dispose();
  times.set(savedTimes);
  values.set(savedValues);
});

test('constructor failures take no callbacks or claims and disposal removes the registered model callback', async (t) => {
  const f = fixture(),
    model = await load(t, f.scene),
    register = model.onDispose.bind(model);
  let callbacks = 0;
  model.onDispose = (callback) => {
    callbacks++;
    const remove = register(callback);
    return () => {
      callbacks--;
      remove();
    };
  };
  assert.throws(() => animation.createMaterialAnimation(model, { clip: 99 }));
  assert.equal(callbacks, 0);
  const player = animation.createMaterialAnimation(model);
  assert.equal(callbacks, 1);
  assert.throws(() => animation.createMaterialAnimation(model));
  assert.equal(callbacks, 1);
  player.dispose();
  assert.equal(callbacks, 0);
  player.dispose();
  assert.equal(callbacks, 0);
  const next = animation.createMaterialAnimation(model);
  assert.equal(callbacks, 1);
  model.dispose();
  assert.equal(callbacks, 0);
  assert.throws(() => next.seek(0), /disposed/);
});

test('empty and node-only documents reject material playback without changing ordinary Animation', async (t) => {
  const f = fixture();
  delete f.scene.materialAnimations;
  const model = await load(t, f.scene);
  assert.throws(() => animation.createMaterialAnimation(model), /clip/);
  const node = new animation.Animation(model);
  assert.equal(node.clips.length, 0);
  node.dispose();
});

test('stale primitive nodes reject construction and seek before any material write', async (t) => {
  const model = await load(t, fixture().scene),
    player = animation.createMaterialAnimation(model);
  const before = structuredClone(model.primitives[1].material);
  model.primitives[1].node.dispose();
  assert.throws(() => player.seek(0.25), /stale|binding/);
  assert.deepEqual(model.primitives[1].material, before);
  player.dispose();
  assert.throws(() => animation.createMaterialAnimation(model), /stale|binding/);
});

test('non-dyadic Float32 key boundaries and zero/negative scale samples use the exact decoded values', async (t) => {
  const f = fixture();
  f.scene.materialAnimations = [
    {
      channels: [
        channel(f.animated, 'offset', [0, 0, 0.25, 0, 0.5, 0], [0, 0.1, 0.2]),
        channel(f.animated, 'scale', [0, -1, 0, -1, 0, -1], [0, 0.1, 0.2]),
      ],
    },
  ];
  const model = await load(t, f.scene),
    player = animation.createMaterialAnimation(model);
  for (const [seconds, x] of [
    [0, 0],
    [0.1, 0],
    [0.10000000149011612, 0.25],
    [0.2, 0.25],
    [0.20000000298023224, 0.5],
  ]) {
    player.seek(seconds);
    const m = model.primitives[1].material;
    assert.deepEqual(m.maps[0].extensions.KHR_texture_transform, { offset: [x, 0], scale: [0, -1] });
    assert.deepEqual(m.uvt.slice(0, 8), [0, -0, x, 0, -0, -1, 0, 0]);
  }
  player.dispose();
});

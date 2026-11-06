// cloneModel: an independent copy of a skinned glTF-pro model that animates apart from its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { exportGLB } from '../../exporters/dist/index.js';
import { Animation } from '../dist/index.js';
import { cloneModel } from '../dist/skeleton-utils.js';
import { skinnedStrip } from '../test/fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { axisAngle, engine, fromGLB, model, near, position, quaternion, sameRotation } from './support/models.js';

test('a clone has its own nodes in the source pose, shares the parsed asset, and animates independently', async () => {
  const e = await engine(),
    source = model(e, skinnedStrip()),
    meshes = e.meshes.size;
  source.root.setPosition([3, 0, 0]);
  source.nodes[2].setQuaternion(axisAngle([0, 0, 1], 30));
  source.nodes[1].visible = false;
  const clone = await cloneModel(source);
  assert.ok(clone instanceof PBRModel && clone !== source);
  assert.equal(clone.asset, source.asset, 'one parsed document, buffers and accessors');
  assert.equal(clone.nodes.length, source.nodes.length);
  assert.equal(e.meshes.size, meshes * 2, 'a root and nodes of its own');
  for (let i = 0; i < source.nodes.length; i++) assert.notEqual(clone.nodes[i], source.nodes[i]);
  near(position(clone.root), [3, 0, 0], 0, 'root transform copied');
  sameRotation(quaternion(clone.nodes[2]), axisAngle([0, 0, 1], 30), 1e-7, 'pose copied');
  assert.equal(clone.nodes[1].visible, false, 'visibility copied');
  assert.deepEqual(clone.primitives[0].vertices, source.primitives[0].vertices);
  assert.equal(clone.root.engine.plugins.has(clone.name), false, 'not registered: neither is the source');

  const a = new Animation(source),
    b = new Animation(clone);
  a.seek(0.25);
  b.seek(0.75);
  sameRotation(quaternion(source.nodes[2]), axisAngle([0, 0, 1], 22.5), 1e-6, 'source at 0.25');
  sameRotation(quaternion(clone.nodes[2]), axisAngle([0, 0, 1], 67.5), 1e-6, 'clone at 0.75');
  // Disposing the source leaves the clone working.
  a.dispose();
  source.dispose();
  b.seek(0.5);
  sameRotation(quaternion(clone.nodes[2]), axisAngle([0, 0, 1], 45), 1e-6, 'clone after source disposal');
  clone.dispose();
  assert.equal(e.meshes.size, 0);
});

test('a prepared static scene clone shares the packed arrays; morph weights are copied', async () => {
  const e = await engine(),
    vertices = new Float32Array(3 * 20),
    doc = {
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0, name: 'tile' }],
    };
  vertices.set([0, 0, 0, 1, 0, 0, 1, 0], 0);
  vertices.set([1, 0, 0, 1, 0, 0, 1, 0], 20);
  vertices.set([0, 1, 0, 1, 0, 0, 1, 0], 40);
  const source = new PBRModel(e, new GLTFAsset(doc, []), [], [[{ vertices, indices: new Uint32Array([0, 1, 2]) }]]),
    clone = await cloneModel(source);
  assert.equal(clone.primitives[0].vertices, source.primitives[0].vertices, 'same packed array');
  assert.equal(clone.nodes[0].name, 'tile');
  // Morph weights set on the source carry over, and stay separate afterwards.
  const face = fromGLB(
      e,
      exportGLB({
        nodes: [
          {
            name: 'face',
            geometry: {
              positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
              normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
              indices: [0, 1, 2],
              morphs: [{ positions: [0, 0, 0, 0, 0, 0, 0, 0.5, 0] }, { positions: [0.5, 0, 0, 0, 0, 0, 0, 0, 0] }],
            },
          },
        ],
      }),
    ),
    animation = new Animation(face);
  animation.setMorph(0, 1, 0.6);
  const copy = await cloneModel(face);
  near(copy.primitives[0].weights, [0, 0.6], 1e-7, 'weights copied');
  animation.setMorph(0, 0, 1);
  near(copy.primitives[0].weights, [0, 0.6], 1e-7, 'weights independent');
});

test('a registered source registers its clone, and a failure there disposes the clone', async () => {
  const e = await engine(),
    source = model(e, skinnedStrip()),
    meshes = e.meshes.size;
  // Registered as loadGLTF leaves it (this engine has no GPU, so the clone's own setup must fail and clean up).
  e.plugins.set(source.name, source);
  await assert.rejects(cloneModel(source), /requires WebGPU/);
  assert.equal(e.meshes.size, meshes, 'the failed clone left no nodes behind');
  e.plugins.delete(source.name);
});

test('cloneModel rejects anything but a live model', async () => {
  await assert.rejects(cloneModel({}), TypeError);
  const source = model(await engine(), skinnedStrip());
  source.dispose();
  await assert.rejects(cloneModel(source), (error) => error.code === 'disposed');
});

test('cloneModel holds the source image instead of copying it, closing it with the last model', async () => {
  const e = await engine(),
    image = {
      width: 1,
      height: 1,
      closed: 0,
      close() {
        this.closed++;
      },
    },
    vertices = new Float32Array(3 * 20),
    doc = {
      asset: { version: '2.0' },
      images: [{ uri: 'unused.png' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0, name: 'tile' }],
    };
  vertices.set([0, 0, 0, 1, 0, 0, 1, 0], 0);
  vertices.set([1, 0, 0, 1, 0, 0, 1, 0], 20);
  vertices.set([0, 1, 0, 1, 0, 0, 1, 0], 40);
  const source = new PBRModel(e, new GLTFAsset(doc, []), [image], [[{ vertices, indices: new Uint32Array([0, 1, 2]) }]]),
    created = globalThis.createImageBitmap;
  globalThis.createImageBitmap = () => assert.fail('a clone copied the bitmap');
  try {
    const clone = await cloneModel(source);
    assert.equal(clone.image(0), image);
    source.dispose();
    assert.equal(image.closed, 0, 'the clone still holds it');
    clone.dispose();
    assert.equal(image.closed, 1);
  } finally {
    if (created === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = created;
  }
});

test('cloneModel of a registered model runs no engine tick, skinned or static, and the next tick places the copy', async (t) => {
  // p-skeleton-clone: each copy ran a tick of every mesh of the engine, so a crowd cost quadratic time.
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    vertices = new Float32Array(3 * 20),
    doc = {
      asset: { version: '2.0' },
      materials: [{}],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }],
    };
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  vertices.set([0, 0, 0, 1, 0, 0, 1, 0], 0);
  vertices.set([1, 0, 0, 1, 0, 0, 1, 0], 20);
  vertices.set([0, 1, 0, 1, 0, 0, 1, 0], 40);
  store.tick(false);
  const geometry = [[{ vertices, indices: new Uint32Array([0, 1, 2]) }]],
    statics = new PBRModel(e, new GLTFAsset(doc, []), [], geometry),
    skinned = model(e, skinnedStrip());
  e.use(statics);
  e.use(skinned);
  store.tick(false);
  const tick = store.tick;
  let ticks = 0;
  store.tick = function (...args) {
    ticks++;
    return tick.apply(this, args);
  };
  t.after(() => {
    store.tick = tick;
  });
  const copies = [];
  for (let i = 0; i < 5; i++) copies.push(await cloneModel(statics), await cloneModel(skinned));
  assert.equal(ticks, 0, 'ten copies, no tick');
  assert.ok(copies.every((copy) => e.plugins.get(copy.name) === copy));
  assert.equal(copies[0]['staticBatches'].length, 1, 'a static copy holds its batch');
  assert.equal(copies[0]['staticBatches'][0].primitive.vertices, statics['staticBatches'][0].primitive.vertices);
  assert.equal(copies[1]['staticBatches'].length, 0);
  assert.equal(copies[0].nodes[1].matrix[12], 0, 'not published yet: the documented cost');
  const bounds = copies[0].bounds;
  assert.equal(copies[0].nodes[1].matrix[12], 3, 'model.bounds ticks first');
  assert.equal(bounds[3], 4);
});

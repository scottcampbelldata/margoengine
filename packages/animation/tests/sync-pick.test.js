// Synchronous raycasts against meshes a GPU deformer writes: each deformer evaluates its pose on the CPU for them
// (packages/shared/pose-source.js), so `Raycaster.intersectObjects` and `intersectEngine` hit the current pose and never
// the bind pose. Before, they threw MargoError 'unsupported' as soon as an Animation or a Skin was attached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Raycaster, getPrimitiveBVH } from '../../bvh/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { Animation, Skeleton, Skin } from '../dist/index.js';
import { dualQuaternionSkinning } from '../dist/dqs.js';
import { MorphWeightPlayer } from '../dist/morph-gpu.js';
import { GeometryCachePlayer, encodeGeometryCache } from '../dist/geometry-cache.js';
import { bent, skinnedStrip } from '../test/fixture.js';
import { model, near } from './support/models.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { posedVertices } from '../../shared/pose-source.js';

async function gpuEngine(t) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  engine.store.tick(false);
  return engine;
}
const down = (x, y) => {
  const ray = new Raycaster([x, y, 5], [0, 0, -1]);
  ray.side = 'double';
  return ray;
};

test('a skinned glTF model under Animation is hit where its bones put it, synchronously', async (t) => {
  const engine = await gpuEngine(t),
    strip = model(engine, skinnedStrip());
  engine.use(strip);
  const animation = Animation.attach(strip),
    primitive = strip.primitives[0],
    bind = primitive.vertices.slice();
  animation.playing = false;
  assert.ok(primitive.deformed, 'the GPU pass writes the primitive');
  // Bind pose: the strip lies along x from 0 to 2, 0.2 high.
  assert.equal(down(1.7, 0.1).intersectObjects(engine, [strip]).length, 1);
  assert.deepEqual(down(0.9, 0.7).intersectObjects(engine, [strip]), []);
  // Joint 1 at x = 1 has turned its half 45 degrees about +Z: the point (1.7, 0.1) of the strip is now here.
  animation.seek(0.5);
  const [x, y] = bent(1.7, 0.1, 0.5),
    [hit] = down(x, y).intersectObjects(engine, [strip]);
  assert.ok(y > 0.5, 'above the bind pose');
  assert.ok(Math.abs(hit.distance - 5) < 1e-5);
  near(hit.point, [x, y, 0], 1e-5);
  assert.equal(hit.model, strip);
  assert.equal(hit.primitive, primitive);
  assert.equal(hit.mesh, primitive.node);
  assert.deepEqual(down(1.7, 0.1).intersectObjects(engine, [strip]), [], 'the bind pose no longer answers');
  assert.equal(down(x, y).intersectEngine(engine)[0].model, strip, 'intersectEngine finds it too');
  // Every vertex against the fixture's closed form.
  const pose = posedVertices(primitive);
  for (let i = 0; i < bind.length; i += 20) {
    const expected = bent(bind[i], bind[i + 1], 0.5);
    near(pose.vertices.subarray(i, i + 3), expected, 1e-6, `vertex ${i / 20}`);
    near(pose.vertices.subarray(i + 4, i + 7), [0, 0, 1], 1e-6, `normal ${i / 20}`);
    assert.deepEqual(pose.vertices.subarray(i + 12, i + 14), bind.subarray(i + 12, i + 14), 'uv is the bind uv');
  }
  // One evaluation per pose: rays at an unchanged pose reuse the vertices and the tree; a new pose refits that tree.
  const revision = pose.revision,
    tree = getPrimitiveBVH(primitive),
    refits = tree.revision;
  for (let k = 0; k < 5; k++) down(1.2, 0.3).intersectObjects(engine, [strip]);
  assert.deepEqual([posedVertices(primitive).revision, tree.revision], [revision, refits]);
  animation.seek(0.25);
  down(1.2, 0.3).intersectObjects(engine, [strip]);
  assert.deepEqual([posedVertices(primitive).revision, tree.revision], [revision + 1, refits + 1]);
  assert.equal(getPrimitiveBVH(primitive), tree);
  // Without the Animation the primitive is its bind pose again.
  animation.dispose();
  assert.equal(primitive.deformed, undefined);
  assert.equal(posedVertices(primitive), undefined);
  assert.equal(down(1.7, 0.1).intersectObjects(engine, [strip]).length, 1);
});

test('a morph target and a moved joint both reach a synchronous ray', async (t) => {
  const engine = await gpuEngine(t),
    triangle = model(engine, animatedTriangle());
  engine.use(triangle);
  const animation = Animation.attach(triangle),
    primitive = triangle.primitives[0];
  animation.playing = false;
  // The triangle's right edge is at x = 0.575 where y = -0.55; the target moves every vertex 0.3 along x.
  assert.deepEqual(down(0.8, -0.55).intersectObjects(engine, [triangle]), []);
  primitive.weights[0] = 1;
  assert.ok(Math.abs(down(0.8, -0.55).intersectObjects(engine, [triangle])[0].distance - 5) < 1e-6);
  primitive.weights[0] = 0.5;
  assert.deepEqual(down(0.8, -0.55).intersectObjects(engine, [triangle]), []);
  assert.equal(down(0.7, -0.55).intersectObjects(engine, [triangle]).length, 1);
  // The joint (node 1) lifts the whole triangle towards the ray.
  triangle.nodes[1].setPosition([0, 0, 2]);
  assert.ok(Math.abs(down(0.7, -0.55).intersectObjects(engine, [triangle])[0].distance - 3) < 1e-6);
});

test('eight influences blend all eight joints by their normalised weights', async (t) => {
  const engine = await gpuEngine(t),
    fixture = animatedTriangle(),
    { doc, buffers } = fixture,
    attributes = doc.meshes[0].primitives[0].attributes,
    append = (data, componentType) => {
      buffers.push(data);
      doc.buffers.push({ byteLength: data.byteLength });
      doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
      doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType, count: 3, type: 'VEC4' });
      return doc.accessors.length - 1;
    };
  doc.nodes = [{ mesh: 0, skin: 0, children: [1, 2, 3, 4, 5, 6, 7, 8] }, ...Array.from({ length: 8 }, () => ({}))];
  doc.skins = [{ joints: [1, 2, 3, 4, 5, 6, 7, 8] }];
  doc.animations = [];
  buffers[attributes.JOINTS_0] = new Uint16Array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
  buffers[attributes.WEIGHTS_0] = new Float32Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  attributes.JOINTS_1 = append(new Uint16Array([4, 5, 6, 7, 4, 5, 6, 7, 4, 5, 6, 7]), 5123);
  attributes.WEIGHTS_1 = append(new Float32Array([5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8]), 5126);
  const triangle = model(engine, fixture);
  engine.use(triangle);
  Animation.attach(triangle).playing = false;
  // Joint k rises k units: the blend is the weighted mean, sum of (k + 1) * k over 36.
  for (let k = 0; k < 8; k++) triangle.nodes[k + 1].setPosition([0, 0, k]);
  const [hit] = down(0, 0).intersectObjects(engine, [triangle]);
  assert.ok(Math.abs(hit.distance - (5 - 168 / 36)) < 1e-5, String(hit.distance));
  near(hit.normal, [0, 0, 1], 1e-6);
});

test('a skinning mode has no CPU pose, so a synchronous ray refuses rather than test the bind pose', async (t) => {
  const engine = await gpuEngine(t),
    strip = model(engine, skinnedStrip());
  engine.use(strip);
  Animation.attach(strip, { skinning: dualQuaternionSkinning });
  assert.throws(
    () => down(1.7, 0.1).intersectObjects(engine, [strip]),
    (e) => e.code === 'unsupported' && /intersectModel/.test(e.message),
  );
});

test('morph weights the GPU samples are not on the CPU, so that model refuses too', async (t) => {
  const engine = await gpuEngine(t),
    fixture = animatedTriangle(),
    { doc, buffers } = fixture,
    values = new Float32Array([0, 1]),
    output = doc.accessors.length;
  buffers.push(values);
  doc.buffers.push({ byteLength: values.byteLength });
  doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: values.byteLength });
  doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType: 5126, count: 2, type: 'SCALAR' });
  doc.animations.push({
    name: 'Talk',
    channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
    samplers: [{ input: doc.animations[0].samplers[0].input, output }],
  });
  const triangle = model(engine, fixture);
  engine.use(triangle);
  const animation = Animation.attach(triangle);
  animation.playing = false;
  assert.equal(down(0, 0).intersectObjects(engine, [triangle]).length, 1);
  const player = MorphWeightPlayer.attach(engine, 'Talk').add(animation);
  assert.throws(() => down(0, 0).intersectObjects(engine, [triangle]), { code: 'unsupported' });
  // The GPU keeps the weights the player last wrote, so removing it does not bring the CPU pose back.
  player.remove(animation);
  assert.throws(() => down(0, 0).intersectObjects(engine, [triangle]), { code: 'unsupported' });
});

test('a Skin on a createMesh mesh is hit at the skeleton pose by an ordinary scene raycast', async (t) => {
  const engine = await gpuEngine(t),
    skeleton = new Skeleton([{ name: 'root', parent: -1 }]),
    mesh = createMesh(
      engine,
      {
        positions: [0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 0, 1, 1, 1],
        indices: [0, 1, 2, 2, 1, 3],
      },
      new Material({ color: [1, 1, 1, 1] }),
    ),
    skin = Skin.attach(mesh, skeleton, new Array(16).fill(0), new Array(16).fill(1));
  assert.ok(mesh.primitives[0].deformed);
  assert.ok(Math.abs(down(0.5, 0.5).intersectObjects(engine, [mesh])[0].distance - 5) < 1e-6);
  skeleton.setPose(0, { translation: [0, 0, 3] });
  assert.ok(Math.abs(down(0.5, 0.5).intersectObjects(engine, [mesh])[0].distance - 2) < 1e-6);
  const tree = getPrimitiveBVH(mesh.primitives[0]);
  skeleton.setPose(0, { translation: [10, 0, 0] });
  assert.deepEqual(down(0.5, 0.5).intersectObjects(engine, [mesh]), []);
  assert.equal(down(10.5, 0.5).intersectObjects(engine, [mesh]).length, 1);
  assert.equal(getPrimitiveBVH(mesh.primitives[0]), tree, 'one tree, refitted');
  skin.dispose();
  assert.equal(down(0.5, 0.5).intersectObjects(engine, [mesh]).length, 1, 'the bind pose once the skin is gone');
  mesh.dispose();
});

test('a geometry cache is hit at the frame on show', async (t) => {
  const engine = await gpuEngine(t),
    // A square fan around the origin whose height is its frame number.
    positions = new Float32Array(3 * 5 * 3),
    indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
  for (let f = 0; f < 3; f++)
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ].forEach(([x, y], i) => positions.set([x, y, f], (f * 5 + i) * 3));
  const player = await GeometryCachePlayer.attach(
    engine,
    encodeGeometryCache(10, [{ frameCount: 3, positions, indices }]),
  );
  await player.done;
  const distance = () => down(0.2, 0.1).intersectObjects(engine, [player.model])[0].distance;
  assert.ok(player.model.primitives[0].deformed);
  assert.ok(Math.abs(distance() - 5) < 1e-6);
  player.onPreUpdate(0.1);
  assert.ok(Math.abs(distance() - 4) < 1e-5);
  player.onPreUpdate(0.05);
  assert.ok(Math.abs(distance() - 3.5) < 1e-5, 'half way between frames');
  player.dispose();
});

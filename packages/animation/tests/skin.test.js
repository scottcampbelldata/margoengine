// Skeleton and Skin from raw bone, joint and weight arrays: pose maths, validation, and the GPU deformation hookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { Skeleton, Skin } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const q90z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const close = (actual, expected, tolerance = 1e-9, label = '') => {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label}[${i}] ${actual[i]} != ${expected[i]}`);
};
/** Root at the origin, forearm one unit up, hand one more unit up. */
const arm = () =>
  new Skeleton([
    { name: 'upper', parent: -1 },
    { name: 'forearm', parent: 0, translation: [0, 1, 0] },
    { name: 'hand', parent: 1, translation: [0, 1, 0] },
  ]);
const at = (matrices, bone) => Array.from(matrices.subarray(bone * 16 + 12, bone * 16 + 15));

test('bone matrices compose parent before child and inverse binds come from the base pose', () => {
  const s = arm();
  assert.equal(s.count, 3);
  assert.equal(s.root, 0);
  assert.equal(s.index('hand'), 2);
  assert.equal(s.index('nope'), -1);
  close(at(s.matrices, 2), [0, 2, 0]);
  close(
    s.skinMatrices,
    [...Array(3)].flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    1e-12,
  );
  const revision = s.revision;
  s.setPose(0, { rotation: q90z });
  assert.ok(s.revision > revision);
  close(at(s.matrices, 1), [-1, 0, 0], 1e-12);
  close(at(s.matrices, 2), [-2, 0, 0], 1e-12);
  // The skin matrix of the hand moves its bind position (0, 2, 0) to its posed position.
  const m = s.skinMatrices.subarray(32, 48);
  close([m[4] * 2 + m[12], m[5] * 2 + m[13], m[6] * 2 + m[14]], [-2, 0, 0], 1e-12);
  // World matrix: the skinned mesh's matrix times the bone's.
  const parent = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
  close(Array.from(s.worldMatrix(2, parent).subarray(12, 15)), [3, 0, 0], 1e-6);
  const pose = s.getPose(0);
  close(pose.rotation, q90z, 1e-12);
  close(pose.translation, [0, 0, 0]);
  close(pose.scale, [1, 1, 1]);
  // Rotations are normalised on input.
  s.setPose(1, { rotation: [0, 0, 2, 2] });
  close(s.getPose(1).rotation, q90z, 1e-12);
});

test('restorePose resets one bone, a bone and its nested bones, or every bone', () => {
  const s = arm();
  for (let i = 0; i < 3; i++) s.setPose(i, { translation: [i, 5, 0], scale: [2, 2, 2] });
  s.restorePose(1);
  close(s.getPose(1).translation, [0, 1, 0]);
  close(s.getPose(2).translation, [2, 5, 0], 0, 'nested bone keeps its pose');
  s.restorePose(1, true);
  close(s.getPose(2).translation, [0, 1, 0]);
  close(s.getPose(0).translation, [0, 5, 0], 0, 'parent keeps its pose');
  s.restorePose();
  close(s.getPose(0).scale, [1, 1, 1]);
  close(at(s.matrices, 2), [0, 2, 0]);
});

test('setBindPose makes the current pose the base pose and re-derives every inverse bind matrix', () => {
  const s = arm();
  s.setPose(0, { rotation: q90z }).setPose(2, { translation: [0, 3, 0] });
  const posed = s.matrices.slice();
  s.setBindPose();
  close(
    s.skinMatrices,
    [...Array(3)].flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    1e-12,
  );
  close(s.matrices, posed, 0, 'binding does not move bones');
  s.setPose(2, { translation: [0, 9, 0] }).restorePose();
  close(s.getPose(2).translation, [0, 3, 0], 0, 'restore returns to the new base pose');
  // A singular pose cannot be bound and leaves the base pose alone.
  s.setPose(1, { scale: [0, 1, 1] });
  assert.throws(() => s.setBindPose(), { name: 'RangeError', message: /bone 1 bind pose is singular/ });
  close(s.restorePose().getPose(1).scale, [1, 1, 1]);
  // Explicit inverse binds are kept as given.
  const inverse = new Float64Array(16 * 2);
  inverse.set([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], 16);
  const given = new Skeleton(
    [
      { name: 'a', parent: -1 },
      { name: 'b', parent: 0, translation: [0, 1, 0] },
    ],
    inverse,
  );
  close(given.inverseBindMatrices, inverse, 0);
  close(given.skinMatrices.subarray(0, 16), inverse.subarray(0, 16), 0);
});

test('skeleton and skin input is validated', () => {
  const bone = (name, parent, extra) => ({ name, parent, ...extra });
  const bad = (bones, pattern, name = 'RangeError', inverse) =>
    assert.throws(() => new Skeleton(bones, inverse), { name, message: pattern });
  bad([], /nonempty array/, 'TypeError');
  bad([bone('a', -1), bone('a', 0)], /names repeat/, 'TypeError');
  bad([bone('', -1)], /nonempty string name/, 'TypeError');
  bad([bone('a', -1), bone('b', -1)], /2 root bones/);
  bad([bone('a', 1), bone('b', 0)], /0 root bones/);
  bad([bone('a', -1), bone('b', 2), bone('c', 1)], /cycle/);
  bad([bone('a', -1), bone('b', 1)], /parent 1 is invalid/);
  bad([bone('a', -1), bone('b', 5)], /parent 5 is invalid/);
  bad([bone('a', -1), bone('b', 0.5)], /parent 0.5 is invalid/);
  bad([bone('a', -1, { translation: [0, 0] })], /translation needs 3 numbers/, 'TypeError');
  bad([bone('a', -1, { scale: [1, Number.NaN, 1] })], /non-finite/);
  bad([bone('a', -1, { rotation: [0, 0, 0, 0] })], /zero quaternion/);
  bad([bone('a', -1)], /needs 16 numbers/, 'TypeError', new Float32Array(15));
  const s = arm();
  assert.throws(() => s.setPose(3, { translation: [0, 0, 0] }), {
    name: 'RangeError',
    message: /bone 3 does not exist/,
  });
  assert.throws(() => s.restorePose(-1), RangeError);
  assert.throws(() => new Skin({}, [0, 0, 0, 0], [1, 0, 0, 0]), TypeError);
  assert.throws(() => new Skin(s, [0, 0, 0], [1, 0, 0]), { name: 'RangeError', message: /four bone indices/ });
  assert.throws(() => new Skin(s, [0, 0, 0, 3], [1, 0, 0, 0]), { name: 'RangeError', message: /joint 3 at vertex 0/ });
  assert.throws(() => new Skin(s, [0, 0, 0, 0], [1, -1, 0, 0]), { name: 'RangeError', message: /weight -1/ });
  assert.throws(() => new Skin(s, [0, 0, 0, 0], [1, 0, 0]), { name: 'RangeError', message: /one weight per joint/ });
  const skin = new Skin(s, [0, 0, 0, 0], [1, 0, 0, 0]);
  assert.throws(() => skin.setInfluences(1, [0, 0, 0, 0], [1, 0, 0, 0]), /exceed the 1 vertices/);
});

async function world() {
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  let passes = 0;
  const context = {
    backend: 'webgpu',
    device,
    encoder: {
      beginComputePass() {
        passes++;
        return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
      },
    },
  };
  return { h, engine, context, passes: () => passes };
}
const strip = {
  positions: [0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1, 1, 1],
  indices: [0, 1, 2, 2, 1, 3],
};

test('an attached skin deforms a createMesh mesh on the GPU with normalised weights and ranged weight updates', async () => {
  const { engine, context, passes } = await world(),
    s = arm(),
    mesh = createMesh(engine, strip, new Material({ color: [1, 1, 1, 1] }));
  assert.throws(() => Skin.attach(mesh, s, [0, 0, 0, 0], [1, 0, 0, 0]), { message: /1 vertices but the mesh has 4/ });
  assert.throws(() => Skin.attach({ primitives: [] }, s, [0, 0, 0, 0], [1, 0, 0, 0]), TypeError);
  const skin = Skin.attach(
    mesh,
    s,
    [0, 1, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 2, 2, 2, 2],
    [2, 2, 0, 0, 0, 0, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(skin.mesh, mesh);
  assert.throws(() => Skin.attach(mesh, s, new Array(16).fill(0), new Array(16).fill(1)), {
    name: 'MargoError',
    code: 'attached',
  });
  const output = mesh.primitives[0].deformed;
  assert.ok(output && output.usage & GPUBufferUsage.VERTEX, 'the mesh draws the deformed buffer');
  assert.equal(typeof mesh.prepareDeformation, 'function');
  const groupEntries = (b) => skin.gpu.group.entries[b].resource.buffer;
  s.setPose(0, { rotation: q90z });
  mesh.prepareDeformation(context);
  assert.equal(passes(), 1);
  const influences = groupEntries(5).data,
    ids = new Uint32Array(influences),
    weights = new Float32Array(influences);
  assert.deepEqual(Array.from(ids.subarray(0, 4)), [0, 1, 0, 0]);
  close(weights.subarray(4, 8), [0.5, 0.5, 0, 0], 0, 'weights normalise');
  assert.deepEqual(Array.from(ids.subarray(8, 12)), [0, 0, 0, 0], 'zero-sum weights follow the root');
  close(weights.subarray(12, 16), [1, 0, 0, 0], 0);
  close(weights.subarray(20, 24), [0.25, 0.75, 0, 0], 0);
  close(new Float32Array(groupEntries(4).data), Float32Array.from(s.skinMatrices), 0, 'palette');
  close(new Float32Array(groupEntries(0).data), mesh.primitives[0].vertices, 0, 'source vertices');
  assert.deepEqual(Array.from(new Uint32Array(groupEntries(6).data)), [4, 0, 3, 0]);
  mesh.prepareDeformation(context);
  assert.equal(passes(), 1, 'an unchanged skin dispatches nothing');
  skin.setInfluences(3, [1, 2, 0, 0], [1, 1, 0, 0]);
  weights[4] = 9; // only the changed vertex range uploads
  mesh.prepareDeformation(context);
  assert.equal(passes(), 2);
  close(weights.subarray(28, 32), [0.5, 0.5, 0, 0], 0);
  assert.equal(weights[4], 9);
  skin.dispose();
  assert.equal(mesh.primitives[0].deformed, undefined);
  assert.equal(mesh.prepareDeformation, undefined);
  assert.ok(output.destroyed);
  // A new skin can take over; disposing the mesh disposes it (also through Symbol.dispose).
  const other = Skin.attach(mesh, s, new Array(16).fill(0), new Array(16).fill(1)),
    buffer = mesh.primitives[0].deformed;
  assert.equal(engine.hasPlugin(skin.name), false);
  assert.equal(engine.hasPlugin(other.name), true);
  mesh.dispose();
  assert.ok(buffer.destroyed);
  assert.equal(engine.hasPlugin(other.name), false);
  other[Symbol.dispose]();
  assert.throws(() => Skin.attach(mesh, s, new Array(16).fill(0), new Array(16).fill(1)), { code: 'disposed' });
  assert.throws(() => engine.use(new Skin(s, [0, 0, 0, 0], [1, 0, 0, 0])), { code: 'state' });
});

test('CPU skinning bends a two-bone arm, blends weights, follows the root on zero weights and keeps mirrored normals', () => {
  const s = new Skeleton([
      { name: 'upper', parent: -1 },
      { name: 'forearm', parent: 0, translation: [0, 1, 0] },
    ]),
    // (0, 1.5, 0) on the forearm; (0, 2, 0) half on each bone (weights 3 + 3 normalise); (1, 0, 0) with zero weights.
    positions = [0, 1.5, 0, 0, 2, 0, 1, 0, 0],
    normals = [1, 0, 0, 1, 0, 0, 0, 0, 1],
    skin = new Skin(s, [1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1], [1, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0]);
  close(skin.pose(positions).positions, positions, 0, 'bind pose is the rest geometry');
  assert.equal(skin.pose(positions).normals, undefined);
  s.setPose(1, { rotation: q90z });
  let posed = skin.pose(positions, normals);
  // Forearm: T(0, 1, 0) R(90 z) times the inverse bind T(0, -1, 0), so (0, 1.5, 0) -> (-0.5, 1, 0).
  close(posed.positions, [-0.5, 1, 0, -0.5, 1.5, 0, 1, 0, 0], 1e-6);
  close(posed.normals.subarray(0, 3), [0, 1, 0], 1e-6, 'rotated normal');
  close(posed.normals.subarray(3, 6), [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6, 'blended normal');
  s.setPose(0, { rotation: q90z });
  close(skin.pose(positions).positions.subarray(6, 9), [0, 1, 0], 1e-6, 'zero-sum weights follow the root');
  // A mirroring scale flips positions and keeps normals pointing out of the mirrored surface.
  s.restorePose().setPose(0, { scale: [-1, 1, 1] });
  posed = skin.pose(positions, normals);
  close(posed.positions.subarray(6, 9), [-1, 0, 0], 1e-6);
  close(posed.normals.subarray(0, 3), [-1, 0, 0], 1e-6);
  // setBindPose makes the current pose the rest: the mesh stays where it is drawn now.
  s.setPose(1, { rotation: q90z }).setBindPose();
  close(skin.pose(positions).positions, positions, 1e-6);
  assert.throws(() => skin.pose([0, 0, 0]), { name: 'TypeError', message: /Skin positions needs 9 numbers/ });
  assert.throws(() => skin.pose(positions, [0, 0, Number.NaN, 0, 0, 0, 0, 0, 0]), RangeError);
});

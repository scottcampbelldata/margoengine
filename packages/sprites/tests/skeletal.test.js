// Node checks of @margoengine/sprites/skeletal: bone transforms, linear blend skinning, clips and errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridMesh, poseSkeleton, SkeletalLayer, Skeleton2D, SkinnedMesh } from '../dist/skeletal.js';

const close = (actual, expected, message) =>
  [...actual].forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-9, `${message}: ${[...actual]} vs ${expected}`),
  );

test('bones: parents before children whatever the order given; names, parents and cycles are checked', () => {
  const s = new Skeleton2D([
    { name: 'tip', parent: 'arm', x: 5 },
    { name: 'arm', x: 10 },
  ]);
  assert.deepEqual(
    s.bones.map((b) => b.name),
    ['arm', 'tip'],
  );
  assert.equal(s.bone('tip').parent, s.bone('arm'));
  assert.throws(() => new Skeleton2D([]), TypeError);
  assert.throws(() => new Skeleton2D([{ name: 'a' }, { name: 'a' }]), TypeError);
  assert.throws(() => new Skeleton2D([{ name: 'a', parent: 'z' }]), /unknown parent/);
  assert.throws(
    () =>
      new Skeleton2D([
        { name: 'a', parent: 'b' },
        { name: 'b', parent: 'a' },
      ]),
    /cycle/,
  );
});

test('world transforms: y down, rotation clockwise, children follow parents', () => {
  const s = new Skeleton2D([
    { name: 'arm', x: 10, rotation: Math.PI / 2 },
    { name: 'tip', parent: 'arm', x: 5, scaleX: 2 },
  ]);
  // A clockwise quarter turn sends the child's +x offset straight down the screen.
  close(s.bone('tip').world.subarray(4), [10, 5], 'child origin');
  close(s.bone('tip').world.subarray(0, 4), [0, 2, -1, 0], 'child axes: scaled x down, y to the left');
  s.bone('arm').rotation = 0;
  s.update();
  close(s.bone('tip').world.subarray(4), [15, 0], 'after an update');
  s.resetPose();
  s.update();
  close(s.bone('tip').world.subarray(4), [10, 5], 'resetPose');
  s.bone('arm').x = NaN;
  assert.throws(() => s.update(), RangeError);
});

const strip = () => {
  const s = new Skeleton2D([{ name: 'root' }, { name: 'tip', parent: 'root', y: 4 }]),
    grid = gridMesh([0, 0, 4, 8], 1, 2);
  // Rows 0 and 1 follow the root; the bottom row half root, half tip at first, then all tip.
  const joints = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    weights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0];
  return { s, mesh: new SkinnedMesh({ skeleton: s, ...grid, joints, weights }) };
};

test('linear blend skinning: the bind pose is unchanged, rigid parts turn exactly, shared vertices average', () => {
  const { s, mesh } = strip();
  close(mesh.deform(), [0, 0, 4, 0, 0, 4, 4, 4, 0, 8, 4, 8], 'bind pose');
  s.bone('tip').rotation = Math.PI / 2;
  s.update();
  // About the tip at (0, 4): (0, 8) turns to (-4, 4) and (4, 8) to (-4, 8); vertex 4 is half that and half its rest.
  close(mesh.deform(), [0, 0, 4, 0, 0, 4, 4, 4, (0 - 4) / 2, (8 + 4) / 2, -4, 8], 'tip turned');
  s.bone('root').x = 3;
  s.update();
  close(mesh.deform().subarray(0, 2), [3, 0], 'the root carries everything');
});

test('a mesh checks its arrays, indices, joints and weights', () => {
  const { s } = strip(),
    grid = gridMesh([0, 0, 1, 1], 1, 1),
    ok = { skeleton: s, ...grid, joints: new Array(16).fill(0), weights: new Array(16).fill(1) };
  assert.doesNotThrow(() => new SkinnedMesh(ok));
  assert.throws(() => new SkinnedMesh({ ...ok, skeleton: {} }), TypeError);
  assert.throws(() => new SkinnedMesh({ ...ok, uvs: [0, 0] }), /vertex count/);
  assert.throws(() => new SkinnedMesh({ ...ok, indices: [0, 1] }), /whole triangles/);
  assert.throws(() => new SkinnedMesh({ ...ok, indices: [0, 1, 9] }), /index out of range/);
  assert.throws(() => new SkinnedMesh({ ...ok, joints: new Array(16).fill(5) }), /joint out of range/);
  assert.throws(() => new SkinnedMesh({ ...ok, weights: new Array(16).fill(0) }), /no weight/);
  assert.throws(() => new SkinnedMesh({ ...ok, weights: new Array(16).fill(-1) }), /below 0/);
  assert.throws(() => gridMesh([0, 0, 1, 1], 0, 1), RangeError);
});

test('clips: linear keys, the short way round, loop and hold, unknown bones refused', () => {
  const s = new Skeleton2D([{ name: 'arm' }]),
    arm = s.bone('arm');
  const clip = {
    duration: 2,
    bones: {
      arm: {
        x: [
          [0, 0],
          [2, 10],
        ],
        rotation: [
          [0, 3],
          [1, -3],
        ],
      },
    },
  };
  poseSkeleton(s, clip, 0.5);
  assert.equal(arm.x, 2.5);
  // From 3 to -3 the short way passes pi, not 0.
  // The short way from 3 to -3 is +(2 pi - 6), so half way is 3 + (2 pi - 6) / 2 = pi.
  assert.ok(Math.abs(arm.rotation - Math.PI) < 1e-12, `${arm.rotation}`);
  poseSkeleton(s, clip, 2.5);
  assert.equal(arm.x, 2.5, 'loops');
  poseSkeleton(s, clip, 9, false);
  assert.equal(arm.x, 10, 'holds the end');
  assert.throws(() => poseSkeleton(s, { duration: 1, bones: { leg: { x: [[0, 1]] } } }, 0), /unknown bone/);
  assert.throws(
    () =>
      poseSkeleton(
        s,
        {
          duration: 1,
          bones: {
            arm: {
              x: [
                [1, 0],
                [0, 1],
              ],
            },
          },
        },
        0,
      ),
    /Invalid keys/,
  );
  assert.throws(() => poseSkeleton(s, { duration: 1, bones: { arm: { x: [[0, 1, 2]] } } }, 0), /Invalid keys/);
  assert.throws(() => poseSkeleton(s, { duration: 0, bones: {} }, 0), RangeError);
});

test('the layer: one layer per mesh, coded errors', () => {
  const { mesh } = strip(),
    layer = new SkeletalLayer({ atlas: { width: 4, height: 8, data: new Uint8Array(128) } });
  assert.throws(() => new SkeletalLayer({}), TypeError);
  layer.add(mesh);
  assert.throws(() => new SkeletalLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } }).add(mesh), {
    code: 'attached',
  });
  assert.equal(layer.remove(mesh), true);
  assert.throws(() => layer.add({}), TypeError);
  layer.dispose();
  assert.throws(() => layer.add(mesh), { code: 'disposed' });
  assert.throws(() => new SkeletalLayer({ atlas: {} }).setup({ backend: 'webgl2' }), { code: 'unsupported' });
  assert.throws(() => new SkeletalLayer({ atlas: {} }).setAtlas(undefined), TypeError);
});

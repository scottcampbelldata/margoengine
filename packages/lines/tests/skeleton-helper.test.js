import test from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton } from '../../animation/dist/index.js';
import { SkeletonHelper, Line } from '../dist/index.js';

const point = (line, i) => [...line.points.subarray(i * 4, i * 4 + 3)].map((v) => Math.round(v * 1e5) / 1e5);
const color = (line, i) => [...line.colors.subarray(i * 4, i * 4 + 3)];
const rig = () =>
  new Skeleton([
    { name: 'root', parent: -1, translation: [0, 1, 0] },
    { name: 'spine', parent: 0, translation: [0, 1, 0] },
    { name: 'arm', parent: 1, translation: [1, 0, 0] },
    { name: 'leg', parent: 0, translation: [0, -1, 0] },
  ]);

test("SkeletonHelper draws an animation Skeleton's bones parent to child and follows its pose", () => {
  const skeleton = rig(),
    helper = new SkeletonHelper(skeleton);
  assert.ok(helper instanceof Line);
  assert.equal(helper.mode, 'segments');
  assert.equal(helper.count, 6, 'one segment per bone with a parent');
  assert.equal(helper.material.onTop, true, 'drawn over the scene, as three.js');
  assert.equal(helper.material.fog, false, 'debug lines stay clear of fog');
  assert.deepEqual(color(helper, 0), [0, 1, 0], 'parent end green');
  assert.deepEqual(color(helper, 1), [0, 0, 1], 'child end blue');
  assert.equal(helper.update({}), true);
  assert.deepEqual(
    [point(helper, 0), point(helper, 1)],
    [
      [0, 1, 0],
      [0, 2, 0],
    ],
    'root to spine',
  );
  assert.deepEqual(
    [point(helper, 2), point(helper, 3)],
    [
      [0, 2, 0],
      [1, 2, 0],
    ],
    'spine to arm',
  );
  assert.deepEqual(
    [point(helper, 4), point(helper, 5)],
    [
      [0, 1, 0],
      [0, 0, 0],
    ],
    'root to leg',
  );
  const version = helper.version;
  helper.update({});
  assert.equal(helper.version, version, 'an unchanged pose rewrites nothing');
  // A quarter turn about z at the spine swings the arm from +x to +y.
  skeleton.setPose(1, { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
  helper.update({});
  assert.notEqual(helper.version, version);
  assert.deepEqual(point(helper, 3), [0, 3, 0]);
  helper.setColors('#ff0000', [0, 0, 0]);
  assert.deepEqual(
    [color(helper, 0), color(helper, 1)],
    [
      [0, 0, 0],
      [1, 0, 0],
    ],
  );
});

test('SkeletonHelper takes plain parents and matrices, a mesh to follow, and rejects bad skeletons', () => {
  const matrices = new Float64Array(32);
  matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
  matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 0, 1], 16);
  const one = new SkeletonHelper({ parents: [-1, 0], matrices }, { onTop: false, width: 3 });
  one.update({});
  assert.deepEqual(
    [point(one, 0), point(one, 1)],
    [
      [2, 0, 0],
      [2, 3, 0],
    ],
  );
  assert.equal(one.material.onTop, false);
  assert.equal(one.material.width, 3);
  matrices[29] = 5;
  one.update({});
  assert.deepEqual(point(one, 1), [2, 5, 0], 'matrices without a revision are compared each frame');
  const single = new SkeletonHelper({ parents: [-1], matrices: new Float64Array(16) });
  assert.equal(single.count, 2, 'a lone root keeps one degenerate segment');
  const moved = new SkeletonHelper(rig(), { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] });
  assert.equal(moved.matrix[12], 5, 'the skeleton space is placed by the model matrix');
  assert.throws(() => new SkeletonHelper(null), TypeError);
  assert.throws(() => new SkeletonHelper({ parents: [], matrices }), TypeError);
  assert.throws(() => new SkeletonHelper({ parents: [-1, 1], matrices }), /bone 1 parent 1 is not another bone/);
  assert.throws(() => new SkeletonHelper({ parents: [-1, 0] }), TypeError);
  assert.throws(() => new SkeletonHelper({ parents: [-1, 0], joints: [{}] }), TypeError);
  assert.throws(() => new SkeletonHelper({ parents: [-1, 0], matrices: new Float64Array(16) }).update({}), RangeError);
});

test('SkeletonHelper.fromGLTF joins each skin joint to its parent node when that is a joint', () => {
  const mesh = () => ({ check() {} }),
    nodes = [mesh(), mesh(), mesh(), mesh(), mesh()],
    model = {
      nodes,
      asset: {
        doc: {
          // Node 0 (not a joint) holds joints 1 -> 2 -> 3; node 4 is a joint whose parent is node 0.
          nodes: [{ children: [1, 4] }, { children: [2] }, { children: [3] }, {}, {}],
          skins: [{ joints: [3, 1, 2, 4] }],
        },
      },
    };
  const helper = SkeletonHelper.fromGLTF(model);
  assert.deepEqual(helper.skeleton.parents, [2, -1, 1, -1]);
  assert.deepEqual(helper.skeleton.joints, [nodes[3], nodes[1], nodes[2], nodes[4]]);
  assert.equal(helper.count, 4, 'two bones have a joint parent');
  assert.throws(() => SkeletonHelper.fromGLTF(model, 1), /has no skin 1/);
  assert.throws(() => SkeletonHelper.fromGLTF({}), TypeError);
});

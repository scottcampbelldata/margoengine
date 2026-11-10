import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Skeleton2D,
  SkinnedMesh,
  gridMesh,
  poseSkeleton,
  SkeletalLayer,
  solveTwoBoneIK,
  solveChainIK,
} from '../dist/skeletal.js';

const arm = () =>
  new Skeleton2D([
    { name: 'root', length: 5 },
    { name: 'tip', parent: 'root', x: 5, length: 3 },
  ]);
const endpoint = (b) => [b.world[4] + b.world[0] * b.length, b.world[5] + b.world[1] * b.length];
test('two-bone IK reaches inside and outside targets, both bends, reflection, offsets and partial mix', () => {
  for (const bendPositive of [true, false])
    for (const sx of [1, -1]) {
      const s = arm();
      s.bone('root').scaleX = sx;
      const r = solveTwoBoneIK(s, 'root', 'tip', [4, 2], { bendPositive, tolerance: 1e-10 });
      assert.ok(r.converged, JSON.stringify(r));
      assert.equal(Math.sign(s.bone('tip').rotation), bendPositive ? 1 : -1);
      const p = endpoint(s.bone('tip'));
      assert.ok(Math.hypot(p[0] - 4, p[1] - 2) < 1e-10);
    }
  const s = arm();
  assert.equal(solveTwoBoneIK(s, 'root', 'tip', [50, 0]).distance, 42);
  s.resetPose();
  solveTwoBoneIK(s, 'root', 'tip', [4, 2], { mix: 0 });
  assert.equal(s.bone('tip').rotation, 0);
  solveTwoBoneIK(s, 'root', 'tip', [4, 2], { mix: 0.5 });
  assert.ok(s.bone('tip').rotation > 0 && s.bone('tip').rotation < Math.PI);
  const offset = new Skeleton2D([{ name: 'r' }, { name: 't', parent: 'r', x: 3, y: 4, length: 3 }]);
  assert.ok(solveTwoBoneIK(offset, 'r', 't', [5, 2], { tolerance: 1e-10 }).converged);
});
test('chain IK folds straight chains and preserves local lengths under reflected and anisotropic ancestors', () => {
  for (const scaleX of [1, -1]) {
    const s = new Skeleton2D([
      { name: 'parent', x: 2, y: 3, rotation: 0.3, scaleX, scaleY: 1.4 },
      { name: 'a', parent: 'parent', length: 3 },
      { name: 'b', parent: 'a', x: 3, length: 3 },
      { name: 'c', parent: 'b', x: 3, length: 2 },
    ]);
    s.bone('a').rotation = 0.7;
    s.bone('b').rotation = -0.9;
    s.bone('c').rotation = 0.5;
    s.update();
    const target = endpoint(s.bone('c'));
    s.resetPose();
    s.update();
    const r = solveChainIK(s, ['a', 'b', 'c'], target, { iterations: 256, tolerance: 1e-7 });
    assert.ok(r.converged, JSON.stringify(r));
    assert.equal(s.bone('b').x, 3);
    assert.equal(s.bone('c').length, 2);
  }
  const s = arm();
  assert.ok(solveChainIK(s, ['root', 'tip'], [4, 0], { iterations: 256, tolerance: 1e-7 }).converged);
  assert.throws(() => solveChainIK(s, ['tip', 'root'], [0, 0]), RangeError);
  assert.throws(() => solveChainIK(s, ['root', 'tip'], [NaN, 0]), RangeError);
  assert.throws(() => solveChainIK(s, ['root', 'tip'], [0, 0], { iterations: Infinity }), RangeError);
});
test('Bezier timing solves x before y, supports overshoot and stepped keys, and rejects bad curves', () => {
  const s = arm(),
    clip = {
      duration: 2,
      bones: {
        root: {
          x: [
            [0, 0],
            [2, 10],
          ],
        },
      },
      curves: { root: { x: [[0, 0, 1, 0]] } },
    };
  poseSkeleton(s, clip, 1, false);
  assert.ok(Math.abs(s.bone('root').x - 1.25) < 1e-10);
  clip.curves.root.x = ['stepped'];
  poseSkeleton(s, clip, 1, false);
  assert.equal(s.bone('root').x, 0);
  poseSkeleton(s, clip, 2, false);
  assert.equal(s.bone('root').x, 10);
  clip.curves.root.x = [[1.1, 0, 1, 1]];
  assert.throws(() => poseSkeleton(s, clip, 1), RangeError);
  assert.throws(() => poseSkeleton(s, { duration: Infinity, bones: {} }, 0), RangeError);
});
const mesh = (s) =>
  new SkinnedMesh({
    skeleton: s,
    ...gridMesh([0, 0, 1, 1], 1, 1),
    joints: new Array(16).fill(0),
    weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  });
test('slots swap and hide attachments; draw-order keys seek backwards to setup state', () => {
  const s = arm(),
    red = mesh(s),
    blue = mesh(s),
    other = mesh(s);
  const a = s.addSlot({ name: 'a', bone: 'root', attachments: { red, blue, alias: red }, attachment: 'red' });
  s.addSlot({ name: 'b', bone: 'tip', attachments: { other }, attachment: 'other' });
  const clip = {
    duration: 2,
    bones: {},
    slots: {
      a: [
        { time: 0.5, attachment: 'blue' },
        { time: 1, attachment: null },
      ],
    },
    drawOrder: [{ time: 0.5, slots: ['b', 'a'] }],
  };
  poseSkeleton(s, clip, 0.75, false);
  assert.equal(a.mesh, blue);
  assert.deepEqual(
    s.drawOrder.map((v) => v.name),
    ['b', 'a'],
  );
  poseSkeleton(s, clip, 1.5, false);
  assert.equal(a.mesh, undefined);
  poseSkeleton(s, clip, 0, false);
  assert.equal(a.mesh, red);
  assert.deepEqual(
    s.drawOrder.map((v) => v.name),
    ['a', 'b'],
  );
  assert.throws(() => a.setAttachment('absent'), RangeError);
  assert.throws(() => s.setDrawOrder(['a', 'a']), RangeError);
  const layer = new SkeletalLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } });
  layer.addSkeleton(s);
  assert.equal(red.owner, layer);
  assert.throws(() => layer.add(red), { code: 'attached' });
  assert.equal(layer.removeSkeleton(s), true);
  assert.equal(red.owner, undefined);
  layer.addSkeleton(s);
  layer.dispose();
  assert.equal(red.owner, undefined);
});

test('skinning rejects non-finite weights and fractional indices, and normalizes before float32 conversion', () => {
  const s = arm(),
    make = (weights) =>
      new SkinnedMesh({ skeleton: s, ...gridMesh([0, 0, 1, 1], 1, 1), joints: new Array(16).fill(0), weights });
  assert.throws(() => make(new Array(16).fill(Infinity)), RangeError);
  const m = make(new Array(16).fill(1e308));
  assert.deepEqual([...m.deform()], [0, 0, 1, 0, 0, 1, 1, 1]);
  assert.throws(
    () =>
      new SkinnedMesh({
        skeleton: s,
        ...gridMesh([0, 0, 1, 1], 1, 1),
        indices: [0, 0.5, 2],
        joints: new Array(16).fill(0),
        weights: new Array(16).fill(1),
      }),
    RangeError,
  );
});

test('a bone index above 65535 retains its identity in the skinning buffer', () => {
  const s = new Skeleton2D(Array.from({ length: 65537 }, (_, i) => ({ name: `b${i}` })));
  const m = new SkinnedMesh({
    skeleton: s,
    ...gridMesh([0, 0, 1, 1], 1, 1),
    joints: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 65536 : 0)),
    weights: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  });
  s.bone('b65536').x = 3;
  s.update();
  assert.equal(m.deform()[0], 3);
});

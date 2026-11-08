// @margoengine/voxel-edit/rig: voxel parts on a skeleton, posed, matrices and baked grids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnGrid } from '../dist/index.js';
import { rigRotation, sampleRigClip, slerpRotation, VoxelRig } from '../dist/rig.js';

const box = (sx, sy, sz, value) => ({ size: [sx, sy, sz], voxels: new Uint8Array(sx * sy * sz).fill(value) });
const at = (grid, x, y, z) => grid.voxels[x + grid.size[0] * (z + grid.size[2] * y)];
// A body 4 x 6 x 1 at x 0-4, y 0-6, an arm 6 x 1 x 1 sticking out along +x from the shoulder (4, 5, 0), a hand on it.
const figure = () =>
  new VoxelRig({
    bones: [
      { name: 'body' },
      { name: 'arm', parent: 'body', joint: [4, 5, 0] },
      { name: 'hand', parent: 'arm', joint: [10, 6, 0] },
    ],
    parts: [
      { bone: 'body', grid: box(4, 6, 1, 1), offset: [0, 0, 0] },
      { bone: 'arm', grid: box(6, 1, 1, 2), offset: [4, 5, 0] },
      { bone: 'hand', grid: box(2, 1, 1, 3), offset: [10, 5, 0] },
    ],
  });

test('the rest pose bakes the parts at their offsets and gives translation matrices', () => {
  const rig = figure(),
    [body, arm, hand] = rig.matrices();
  assert.deepEqual([...arm], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 0, 1]);
  assert.deepEqual([...body.slice(12, 15)], [0, 0, 0]);
  assert.deepEqual([...hand.slice(12, 15)], [10, 5, 0]);
  const { grid, origin } = rig.bake();
  assert.deepEqual(origin, [0, 0, 0]);
  assert.deepEqual(grid.size, [12, 6, 1]);
  assert.equal(at(grid, 0, 0, 0), 1);
  assert.equal(at(grid, 4, 5, 0), 2);
  assert.equal(at(grid, 9, 5, 0), 2);
  assert.equal(at(grid, 11, 5, 0), 3);
  assert.equal(at(grid, 6, 0, 0), 0);
  assert.equal(grid.voxels.filter((v) => v).length, 24 + 6 + 2);
});

test('turning a bone carries its children, and a quarter turn bakes exactly as turnGrid', () => {
  const rig = figure(),
    // Arm down: -90 degrees about z at the shoulder; the hand comes along.
    { grid, origin } = rig.bake({ rotations: { arm: rigRotation([0, 0, 1], -90) } });
  // The arm turns about its lower shoulder edge: it hangs at x 4, y -1 to 4, the hand below it at y -3 and -2.
  assert.deepEqual(origin, [0, -3, 0]);
  assert.deepEqual(grid.size, [5, 9, 1]);
  const cell = (x, y) => at(grid, x - origin[0], y - origin[1], 0);
  for (let y = -1; y < 5; y++) assert.equal(cell(4, y), 2, `arm cell at y ${y}`);
  assert.equal(cell(4, -2), 3);
  assert.equal(cell(4, -3), 3);
  assert.equal(cell(4, 5), 0);
  assert.equal(grid.voxels.filter((v) => v).length, 32, 'no cell is lost or doubled');
  // A lone part turned a quarter about y about its own corner box gives turnGrid's cells.
  const voxels = Uint8Array.from({ length: 3 * 2 * 5 }, (_, i) => 1 + (i % 7)),
    part = { size: [3, 2, 5], voxels },
    lone = new VoxelRig({ bones: [{ name: 'b', joint: [0, 0, 0] }], parts: [{ bone: 'b', grid: part }] }),
    turned = lone.bake({ rotations: { b: rigRotation([0, 1, 0], 90) } }),
    reference = turnGrid(part, { axis: 'y', turns: 1 }).grid;
  assert.deepEqual(turned.grid.size, reference.size);
  assert.deepEqual([...turned.grid.voxels], [...reference.voxels]);
});

test('a pose moves the model, later parts draw over earlier ones and odd angles keep the part solid', () => {
  const rig = figure(),
    moved = rig.bake({ translation: [3, -1, 2] });
  assert.deepEqual(moved.origin, [3, -1, 2]);
  const over = new VoxelRig({
    bones: [{ name: 'a' }],
    parts: [
      { bone: 'a', grid: box(2, 2, 2, 5) },
      { bone: 'a', grid: box(1, 1, 1, 9), offset: [1, 1, 1] },
    ],
  }).bake();
  assert.equal(at(over.grid, 1, 1, 1), 9);
  assert.equal(at(over.grid, 0, 0, 0), 5);
  // A 20 x 4 x 4 bar turned 30 degrees: every cell along its axis, out to its length, is filled.
  const bar = new VoxelRig({
      bones: [{ name: 'a', joint: [0, 2, 2] }],
      parts: [{ bone: 'a', grid: box(20, 4, 4, 1), offset: [0, 0, 0] }],
    }),
    { grid, origin } = bar.bake({ rotations: { a: rigRotation([0, 0, 1], 30) } });
  for (let s = 0.5; s < 19.5; s += 0.5) {
    const x = Math.floor(s * Math.cos(Math.PI / 6)) - origin[0],
      y = Math.floor(2 + s * Math.sin(Math.PI / 6)) - origin[1];
    assert.equal(at(grid, x, y, 2 - origin[2]), 1, `axis point ${s}`);
  }
  const filled = grid.voxels.filter((v) => v).length;
  assert.ok(Math.abs(filled - 320) <= 32, `about the bar's 320 cells: ${filled}`);
});

test('clips interpolate rotations by slerp, hold their ends and loop', () => {
  const up = rigRotation([0, 0, 1], 0),
    down = rigRotation([0, 0, 1], -90),
    clip = { duration: 2, loop: true, tracks: [{ bone: 'arm', times: [0, 1], rotations: [up, down] }] },
    half = sampleRigClip(clip, 0.5).arm,
    expected = rigRotation([0, 0, 1], -45);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(half[i] - expected[i]) < 1e-12);
  assert.deepEqual(sampleRigClip(clip, 1.5).arm, down);
  assert.deepEqual(sampleRigClip({ ...clip, loop: false }, 5).arm, down);
  const wrapped = sampleRigClip(clip, 2.5).arm;
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(wrapped[i] - expected[i]) < 1e-12);
  // The short way round: -q is the same turn.
  const neg = slerpRotation(
    up,
    down.map((v) => -v),
    0.5,
  );
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(Math.abs(neg[i]) - Math.abs(expected[i])) < 1e-12);
});

test('malformed rigs, poses and clips are refused with a fix', () => {
  const grid = box(1, 1, 1, 1),
    bad = [
      () => new VoxelRig({ bones: [], parts: [] }),
      () => new VoxelRig({ bones: [{ name: 'a' }, { name: 'a' }], parts: [] }),
      () => new VoxelRig({ bones: [{ name: 'b', parent: 'a' }, { name: 'a' }], parts: [] }),
      () => new VoxelRig({ bones: [{ name: 'a' }], parts: [{ bone: 'z', grid }] }),
      () => new VoxelRig({ bones: [{ name: 'a', joint: [0, 0] }], parts: [] }),
      () => figure().matrices({ rotations: { tail: [0, 0, 0, 1] } }),
      () => figure().matrices({ rotations: { arm: [0, 0, 0, 2] } }),
      () => figure().bake({}, { maxCells: 10 }),
      () => rigRotation([0, 0, 0], 90),
      () =>
        sampleRigClip(
          {
            duration: 1,
            tracks: [
              {
                bone: 'a',
                times: [1, 0],
                rotations: [
                  [0, 0, 0, 1],
                  [0, 0, 0, 1],
                ],
              },
            ],
          },
          0,
        ),
      () => sampleRigClip({ duration: 0, tracks: [] }, 0),
    ];
  for (const make of bad)
    assert.throws(make, (e) => (e instanceof TypeError || e instanceof RangeError) && /; \S/.test(e.message));
});

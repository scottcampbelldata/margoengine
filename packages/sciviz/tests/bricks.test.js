// Brick layout, view selection, the memory budget, slot reuse and the border copy of @margoengine/sciviz/bricks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arraySource,
  BrickCache,
  brickKey,
  brickRegion,
  fillBrick,
  fitBudget,
  planBricks,
  selectBricks,
} from '@margoengine/sciviz/bricks';

const SLOT_64 = 66 ** 3 * 2;

// A perspective-free box to clip matrix: the [0, 1] box scaled by `s` around the view centre, shifted by `dx`.
const flatView = (s = 2, dx = 0) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -s / 2 + dx, -s / 2, 0, 1]);

test('a plan halves levels until one brick covers the volume', () => {
  const plan = planBricks([4096, 1024, 200], 64, 1);
  assert.deepEqual(plan.levels[0].bricks, [64, 16, 4]);
  assert.deepEqual(plan.levels[1].bricks, [32, 8, 2]);
  assert.deepEqual(plan.levels[1].dims, [2048, 512, 100]);
  assert.deepEqual(plan.levels.at(-1).bricks, [1, 1, 1]);
  assert.equal(plan.levels.length, 7);
  const keys = new Set();
  plan.levels.forEach(({ bricks }, level) => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [bricks[0] - 1, bricks[1] - 1, bricks[2] - 1],
    ])
      keys.add(brickKey(plan, { level, x, y, z }));
  });
  assert.equal(keys.size, 13, 'first and last brick of each level have their own key (the root has one)');
  assert.equal(brickKey(plan, { level: plan.levels.length - 1, x: 0, y: 0, z: 0 }), plan.count - 1);
});

test('bad plans and budgets name the fix', () => {
  assert.throws(() => planBricks([1, 2, 2]), RangeError);
  assert.throws(() => planBricks([8, 8, 8], 2), /brickSize/);
  assert.throws(() => planBricks([8, 8, 8], 4, -1), /border/);
  const plan = planBricks([256, 256, 256]);
  assert.throws(() => fitBudget(plan, 100, 2048), /raise it or lower brickSize/);
  assert.throws(() => fitBudget(plan, 0, 2048), /memoryBudget/);
  assert.throws(() => fitBudget(plan, 1e9, 32), /lower brickSize/);
  assert.throws(() => fitBudget(planBricks([64000, 2, 2], 4), 1e9, 2048), /raise brickSize/);
});

test('the budget caps the atlas, the page table counts and the texture limit holds', () => {
  const plan = planBricks([4096, 1024, 1024]),
    pages = 64 * 16 * 16 * 8;
  for (const budget of [SLOT_64 + pages, 2 ** 26, 2 ** 29, 2 ** 31]) {
    const fit = fitBudget(plan, budget, 2048);
    assert.ok(fit.atlasBytes + fit.pageBytes <= budget, `${budget}: ${fit.atlasBytes} + ${fit.pageBytes}`);
    assert.equal(fit.capacity, fit.slots[0] * fit.slots[1] * fit.slots[2]);
    assert.ok(fit.capacity >= 1);
    assert.ok(fit.slots.every((n) => n * 66 <= 2048));
    // At most one cube layer of slots goes unused by rounding.
    assert.ok(budget - pages - fit.atlasBytes < SLOT_64 * fit.slots[0] * fit.slots[1] + SLOT_64, `${budget}`);
  }
  assert.equal(fitBudget(plan, SLOT_64 + pages, 2048).capacity, 1);
  // Never more slots than the bricks of all frames.
  const small = planBricks([64, 64, 64]);
  assert.equal(small.count, 1);
  assert.equal(fitBudget(small, 2 ** 30, 2048).capacity, 1);
  assert.equal(fitBudget(small, 2 ** 30, 2048, 3).capacity, 3);
  // A low texture limit stops the atlas growing past it, whatever the budget.
  assert.deepEqual(fitBudget(plan, 2 ** 40, 198).slots, [3, 3, 3]);
});

test('selection keeps the root, closes over parents and stays within capacity', () => {
  const plan = planBricks([1024, 1024, 1024]);
  for (const capacity of [1, 2, 9, 50, 500]) {
    const list = selectBricks(plan, flatView(), 1000, 1000, capacity, 0);
    assert.ok(list.length <= capacity, `${capacity}: ${list.length}`);
    assert.equal(list[0].level, plan.levels.length - 1);
    const keys = new Set();
    for (const brick of list) {
      if (brick.level < plan.levels.length - 1) {
        const parent = { level: brick.level + 1, x: brick.x >> 1, y: brick.y >> 1, z: brick.z >> 1 };
        assert.ok(keys.has(brickKey(plan, parent)), 'parent selected first');
      }
      keys.add(brickKey(plan, brick));
    }
    assert.equal(keys.size, list.length);
  }
});

test('selection stops at the detail asked for and splits the largest voxels first', () => {
  const plan = planBricks([512, 512, 512]);
  // 512 voxels over 512 pixels: level 0 voxels cover one pixel, so detail 1 wants level 1 but nothing finer than 0.
  const scale = 2,
    wide = selectBricks(plan, flatView(scale), 512, 512, 1e6, 8);
  assert.ok(wide.every((b) => b.level >= 2));
  const near = selectBricks(plan, flatView(scale), 512, 512, 1e6, 0.5);
  assert.ok(near.some((b) => b.level === 0));
  // Larger on screen: more bricks are wanted.
  assert.ok(
    selectBricks(plan, flatView(4), 512, 512, 1e6, 1).length >=
      selectBricks(plan, flatView(1), 512, 512, 1e6, 1).length,
  );
  // A tight budget refines the level above before any level under it.
  const tight = selectBricks(plan, flatView(scale), 512, 512, 9, 0);
  assert.deepEqual(tight.map((b) => b.level).sort(), [2, 2, 2, 2, 2, 2, 2, 2, 3]);
});

test('selection culls what the view cannot see and wants everything near the eye', () => {
  const plan = planBricks([512, 512, 512]);
  // Shifted right by half the view, so the box's left half alone shows: no brick wholly past the right edge.
  const list = selectBricks(plan, flatView(2, 1), 512, 512, 1e6, 0);
  const level0 = list.filter((b) => b.level === 0);
  assert.ok(level0.length > 0);
  assert.ok(level0.every((b) => b.x <= 4));
  // A view entirely elsewhere keeps only the root.
  assert.equal(selectBricks(plan, flatView(2, 50), 512, 512, 1e6, 0).length, 1);
  // Bricks crossing the eye plane count as infinitely large.
  const crossing = new Float32Array(flatView());
  crossing[3] = 1;
  crossing[15] = -0.5;
  const near = selectBricks(plan, crossing, 512, 512, 9, 1);
  assert.equal(near[0].error, Infinity);
});

test('the cache reuses the least recently used slot and never one it must keep', () => {
  const cache = new BrickCache(3),
    none = () => false;
  assert.deepEqual(cache.place(10, none), { slot: 0 });
  assert.deepEqual(cache.place(11, none), { slot: 1 });
  assert.deepEqual(cache.place(12, none), { slot: 2 });
  assert.equal(cache.size, 3);
  cache.touch(10);
  assert.deepEqual(cache.place(13, none), { slot: 1, evicted: 11 });
  assert.equal(cache.has(11), false);
  // 12 is oldest but kept: 10 goes.
  assert.deepEqual(
    cache.place(14, (k) => k === 12),
    { slot: 0, evicted: 10 },
  );
  assert.equal(
    cache.place(15, () => true),
    undefined,
  );
  assert.equal(cache.size, 3);
  assert.equal(cache.slot(14), 0);
});

test('a brick repeats its neighbours at its border and clamps at the grid edge', () => {
  const dims = [8, 8, 8],
    plan = planBricks(dims, 4, 1),
    values = Float32Array.from({ length: 512 }, (_, i) => i / 511),
    source = arraySource(values, dims);
  const read = (brick) => {
    const { origin, size } = brickRegion(plan, brick),
      slot = new Uint16Array(6 ** 3);
    fillBrick(plan, brick, source.read({ level: 0, frame: 0, origin, size }), 0, 1, slot);
    return slot;
  };
  assert.deepEqual(brickRegion(plan, { level: 0, x: 0, y: 0, z: 0 }), { origin: [0, 0, 0], size: [5, 5, 5] });
  assert.deepEqual(brickRegion(plan, { level: 0, x: 1, y: 1, z: 1 }), { origin: [3, 3, 3], size: [5, 5, 5] });
  const left = read({ level: 0, x: 0, y: 0, z: 0 }),
    right = read({ level: 0, x: 1, y: 0, z: 0 }),
    at = (slot, i, j, k) => slot[i + 6 * (j + 6 * k)];
  for (let k = 1; k < 5; k++)
    for (let j = 1; j < 5; j++) {
      // left's voxel 3 and 4 (its border) are right's border 0 and voxel 1: same data at the shared edge.
      assert.equal(at(left, 4, j, k), at(right, 0, j, k));
      assert.equal(at(left, 5, j, k), at(right, 1, j, k));
    }
  // Past the grid's edge the edge voxel repeats, as clamp-to-edge does.
  assert.equal(at(left, 0, 1, 1), at(left, 1, 1, 1));
  assert.equal(at(right, 5, 1, 1), at(right, 4, 1, 1));
  // Without a border each slot holds its own voxels only.
  const bare = planBricks(dims, 4, 0);
  assert.deepEqual(brickRegion(bare, { level: 0, x: 1, y: 0, z: 0 }), { origin: [4, 0, 0], size: [4, 4, 4] });
});

test('a partial brick pads with its last voxel; NaN draws as the low end', () => {
  const dims = [6, 4, 4],
    plan = planBricks(dims, 4, 1),
    values = new Float32Array(96).fill(1);
  values[5 + 6 * (1 + 4 * 1)] = Number.NaN;
  const brick = { level: 0, x: 1, y: 0, z: 0 },
    { origin, size } = brickRegion(plan, brick);
  assert.deepEqual(
    [origin, size],
    [
      [3, 0, 0],
      [3, 4, 4],
    ],
  );
  const slot = new Uint16Array(6 ** 3);
  fillBrick(plan, brick, arraySource(values, dims).read({ level: 0, frame: 0, origin, size }), 0, 1, slot);
  const ONE = 0x3c00;
  assert.equal(slot[2 + 6 * (2 + 6 * 2)], 0, 'NaN voxel (x 5, y 1, z 1 in slot coordinates 2, 2, 2) is 0');
  assert.equal(slot[3 + 6 * (2 + 6 * 2)], 0, 'padded from the NaN voxel');
  assert.equal(slot[1 + 6 * (2 + 6 * 2)], ONE);
});

test('arraySource averages coarser levels, skips NaN and checks its size', () => {
  const values = new Float32Array(8).fill(2);
  values[0] = 6;
  values[7] = Number.NaN;
  const source = arraySource(values, [2, 2, 2]);
  assert.deepEqual([...source.range], [2, 6]);
  const coarse = source.read({ level: 1, frame: 0, origin: [0, 0, 0], size: [1, 1, 1] });
  assert.ok(Math.abs(coarse[0] - (6 + 2 * 6) / 7) < 1e-6);
  assert.throws(() => arraySource(new Float32Array(7), [2, 2, 2]), /holds 7 values/);
  // Frames: one array per time step, and a range over all of them.
  const frames = arraySource([new Float32Array(8), new Float32Array(8).fill(4)], [2, 2, 2]);
  assert.equal(frames.frames, 2);
  assert.deepEqual([...frames.range], [0, 4]);
  assert.equal(frames.read({ level: 0, frame: 1, origin: [1, 1, 1], size: [1, 1, 1] })[0], 4);
  // A flat field still has a range the transfer function can span.
  assert.deepEqual([...arraySource(new Float32Array(8).fill(3), [2, 2, 2]).range], [2.5, 3.5]);
});

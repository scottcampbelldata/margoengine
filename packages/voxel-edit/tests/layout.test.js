import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '@margoengine/math/mathutils';
import {
  cellAt,
  cellIndex,
  cropGrid,
  fitGrid,
  flipGrid,
  insideGrid,
  invertGrid,
  occupiedBounds,
  rotateGrid,
  shiftGrid,
  turnGrid,
} from '../dist/index.js';

// Margo Voxel Studio's frozen kernels (src/editor/document.ts transformModel, flipModel, rotateModel, translateModel,
// resizeModel, shrinkModel with types.ts modelBounds, invertModel), cell and selection parts, kept as the oracle.
function studioTransform(model, selection, size, transform) {
  const voxels = new Uint8Array(size[0] * size[1] * size[2]),
    out = new Set();
  let clipped = false;
  for (let i = 0; i < model.voxels.length; i++) {
    if (!model.voxels[i] && !selection.has(i)) continue;
    const point = transform(cellAt(model.size, i));
    if (!insideGrid(size, ...point)) {
      if (model.voxels[i]) clipped = true;
      continue;
    }
    const next = cellIndex(size, ...point);
    voxels[next] = model.voxels[i];
    if (selection.has(i)) out.add(next);
  }
  return { size, voxels, selection: [...out], clipped };
}
const studioFlip = (model, selection, axis) =>
  studioTransform(model, selection, model.size, (point) => {
    point[axis] = model.size[axis] - 1 - point[axis];
    return point;
  });
const studioFlipPivot = (size, axis, pivot) => {
  pivot = [...pivot];
  pivot[axis] = size[axis] - pivot[axis];
  return pivot;
};
function studioRotate(model, selection, axis) {
  const [sx, sy, sz] = model.size,
    size = axis === 0 ? [sx, sz, sy] : axis === 1 ? [sz, sy, sx] : [sy, sx, sz];
  return studioTransform(model, selection, size, ([x, y, z]) =>
    axis === 0 ? [x, sz - 1 - z, y] : axis === 1 ? [z, y, sx - 1 - x] : [sy - 1 - y, x, z],
  );
}
const studioRotatePivot = ([sx, sy, sz], axis, [x, y, z]) =>
  axis === 0 ? [x, sz - z, y] : axis === 1 ? [z, y, sx - x] : [sy - y, x, z];
const studioTranslate = (model, selection, delta) =>
  studioTransform(model, selection, model.size, (point) => point.map((n, axis) => n + delta[axis]));
function studioResize(model, selection, size) {
  const voxels = new Uint8Array(size[0] * size[1] * size[2]),
    out = new Set();
  for (let i = 0; i < model.voxels.length; i++) {
    const point = cellAt(model.size, i);
    if (!insideGrid(size, ...point)) continue;
    const destination = cellIndex(size, ...point);
    voxels[destination] = model.voxels[i];
    if (selection.has(i)) out.add(destination);
  }
  return { size, voxels, selection: [...out] };
}
function studioBounds(model) {
  const min = [...model.size],
    max = [0, 0, 0];
  let occupied = false;
  const [sx, , sz] = model.size;
  for (let index = 0; index < model.voxels.length; index++) {
    if (!model.voxels[index]) continue;
    occupied = true;
    const point = [index % sx, Math.floor(index / (sx * sz)), Math.floor(index / sx) % sz];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis] + 1);
    }
  }
  return occupied ? { min, max } : { min: [0, 0, 0], max: [...model.size] };
}
function studioShrink(model, selection) {
  const { min, max } = studioBounds(model),
    size = max.map((value, axis) => value - min[axis]);
  return studioTransform(model, selection, size, (point) => point.map((value, axis) => value - min[axis]));
}

function randomModel(random, empty = false) {
  const size = [1 + Math.floor(random() * 7), 1 + Math.floor(random() * 7), 1 + Math.floor(random() * 7)],
    voxels = new Uint8Array(size[0] * size[1] * size[2]),
    selection = new Set();
  if (!empty)
    for (let i = 0; i < voxels.length; i++) {
      if (random() < 0.3) voxels[i] = 1 + Math.floor(random() * 255);
      if (random() < 0.2) selection.add(i);
    }
  return { model: { size, voxels }, selection };
}
const AXES = ['x', 'y', 'z'];
const same = (ours, theirs) => {
  assert.deepEqual(ours.grid.size, theirs.size);
  assert.deepEqual(ours.grid.voxels, theirs.voxels);
  assert.deepEqual(Array.from(ours.selection), theirs.selection);
  if ('clipped' in theirs) assert.equal(ours.clipped > 0, theirs.clipped);
};

test("flipGrid, turnGrid and shiftGrid match Studio's frozen kernels, selection and pivots included", () => {
  const random = createRandom(27);
  for (let round = 0; round < 200; round++) {
    const { model, selection } = randomModel(random),
      axis = round % 3,
      pivot = [random() * model.size[0], random() * model.size[1], random() * model.size[2]];
    const flip = flipGrid(model, { axis: AXES[axis], selection });
    same(flip, studioFlip(model, selection, axis));
    assert.equal(flip.clipped, 0);
    assert.deepEqual(flip.mapPoint(pivot), studioFlipPivot(model.size, axis, pivot));
    const turn = turnGrid(model, { axis: AXES[axis], selection });
    same(turn, studioRotate(model, selection, axis));
    assert.deepEqual(turn.mapPoint(pivot), studioRotatePivot(model.size, axis, pivot));
    // Several turns are that many of Studio's single turns.
    let expected = { model, selection, pivot };
    for (let k = 1; k <= 4; k++) {
      const step = studioRotate(expected.model, expected.selection, axis);
      expected = {
        model: { size: step.size, voxels: step.voxels },
        selection: new Set(step.selection),
        pivot: studioRotatePivot(expected.model.size, axis, expected.pivot),
      };
      for (const turns of [k, k - 4]) {
        const ours = turnGrid(model, { axis: AXES[axis], turns, selection });
        // Studio turned one step at a time, so its selection set comes back in another order.
        same(
          { ...ours, selection: [...ours.selection].sort((a, b) => a - b) },
          {
            ...step,
            selection: [...expected.selection].sort((a, b) => a - b),
          },
        );
        assert.deepEqual(ours.mapPoint(pivot), expected.pivot);
      }
    }
    const delta = [Math.floor(random() * 9) - 4, Math.floor(random() * 9) - 4, Math.floor(random() * 9) - 4],
      shift = shiftGrid(model, { offset: delta, selection });
    same(shift, studioTranslate(model, selection, delta));
    assert.deepEqual(
      shift.mapPoint(pivot),
      pivot.map((v, a) => v + delta[a]),
    );
  }
});

test('turnGrid is the exact right-handed quarter turn rotateGrid gives on cubes', () => {
  const random = createRandom(4),
    voxels = new Uint8Array(125).map(() => (random() < 0.4 ? 1 + Math.floor(random() * 9) : 0)),
    cube = { size: [5, 5, 5], voxels };
  for (const axis of AXES)
    for (const turns of [1, 2, 3])
      assert.deepEqual(turnGrid(cube, { axis, turns }).grid, rotateGrid(cube, { axis, degrees: 90 * turns }).grid);
  const slab = { size: [4, 2, 1], voxels: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
    turned = turnGrid(slab, { axis: 'z' });
  assert.deepEqual(turned.grid.size, [2, 4, 1], 'odd turns swap the other two sizes, so nothing clips');
  assert.deepEqual([turned.changed, turned.clipped], [12, 0], 'cells outside either box read as air');
  assert.deepEqual(turnGrid(slab, { axis: 'z', turns: 0 }).grid, slab);
  const moved = shiftGrid(slab, { offset: [2, 0, 0] });
  assert.deepEqual(Array.from(moved.grid.voxels), [0, 0, 1, 2, 0, 0, 5, 6]);
  assert.deepEqual([moved.changed, moved.clipped], [8, 4]);
  assert.throws(() => turnGrid(slab, { axis: 'w' }), TypeError);
  assert.throws(() => turnGrid(slab, { axis: 'x', turns: 0.5 }), RangeError);
  assert.throws(() => shiftGrid(slab, { offset: [0.5, 0, 0] }), RangeError);
  assert.throws(() => flipGrid(slab, { axis: 'x', selection: [8] }), /not a cell/);
  assert.throws(() => flipGrid(slab, { axis: 'x', selection: 3 }), TypeError);
});

test("occupiedBounds, cropGrid and fitGrid match Studio's resize and shrink", () => {
  const random = createRandom(28);
  for (let round = 0; round < 200; round++) {
    const { model, selection } = randomModel(random, round % 17 === 0),
      size = [1 + Math.floor(random() * 8), 1 + Math.floor(random() * 8), 1 + Math.floor(random() * 8)],
      resized = cropGrid(model, { origin: [0, 0, 0], size, selection });
    same(resized, studioResize(model, selection, size));
    const bounds = occupiedBounds(model),
      studio = studioBounds(model);
    if (bounds) assert.deepEqual(bounds, studio);
    else assert.deepEqual(studio, { min: [0, 0, 0], max: model.size });
    const fit = fitGrid(model, { selection });
    same(fit, studioShrink(model, selection));
    assert.deepEqual(fit.origin, studio.min);
    assert.deepEqual(fit.mapPoint([1.5, 2, 0.25]), [1.5 - studio.min[0], 2 - studio.min[1], 0.25 - studio.min[2]]);
  }
  const grid = { size: [3, 1, 1], voxels: Uint8Array.from([0, 7, 9]) },
    window = cropGrid(grid, { origin: [-2, 0, 0], size: [4, 1, 2] });
  assert.deepEqual(Array.from(window.grid.voxels), [0, 0, 0, 7, 0, 0, 0, 0]);
  assert.equal(window.clipped, 1, 'the cell at x = 2 falls past the new box');
  assert.throws(() => cropGrid(grid, { origin: [0, 0, 0], size: [0, 1, 1] }), RangeError);
  assert.throws(() => cropGrid(grid, { origin: [0, 0, 0], size: [5000, 5000, 5000] }), /maxCells/);
  assert.equal(occupiedBounds({ size: [2, 2, 2], voxels: new Uint8Array(8) }), null);
});

test("invertGrid swaps occupancy with an explicit fill index (Studio's invert)", () => {
  const grid = { size: [2, 2, 1], voxels: Uint8Array.from([0, 4, 200, 0]) },
    inverted = invertGrid(grid, { color: 9 });
  assert.deepEqual(Array.from(inverted.grid.voxels), [9, 0, 0, 9]);
  assert.deepEqual([inverted.changed, inverted.clipped], [4, 0]);
  assert.deepEqual(invertGrid(inverted.grid, { color: 1 }).grid.voxels, Uint8Array.from([0, 1, 1, 0]));
  assert.throws(() => invertGrid(grid, { color: 0 }), /palette index/);
  assert.throws(() => invertGrid(grid, { color: 1, maxCells: 3 }), /maxCells/);
});

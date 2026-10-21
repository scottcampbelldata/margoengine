import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '@margoengine/math/mathutils';
import { cellAt, cellIndex, insideGrid, mergePalettes } from '../dist/index.js';
import { faceCells, mirrorCells, pasteCells, stampCells } from '../dist/edit.js';
import { SparseGrid } from '../dist/sparse.js';

// Margo Voxel Studio's frozen brush kernel (src/editor/document.ts applyCells: brush cube, XYZ mirrors, selection
// filter, dense write), kept as the oracle.
function studioApply(model, cells, { tool, side, mirror, color, selection }) {
  const targets = new Set(),
    low = -Math.floor((side - 1) / 2);
  for (const cell of cells)
    for (let dy = low; dy < low + side; dy++)
      for (let dz = low; dz < low + side; dz++)
        for (let dx = low; dx < low + side; dx++) {
          const point = [cell[0] + dx, cell[1] + dy, cell[2] + dz],
            xs = mirror[0] ? [point[0], model.size[0] - 1 - point[0]] : [point[0]],
            ys = mirror[1] ? [point[1], model.size[1] - 1 - point[1]] : [point[1]],
            zs = mirror[2] ? [point[2], model.size[2] - 1 - point[2]] : [point[2]];
          for (const x of xs)
            for (const y of ys)
              for (const z of zs)
                if (insideGrid(model.size, x, y, z)) {
                  const index = cellIndex(model.size, x, y, z);
                  if (!selection.size || selection.has(index)) targets.add(index);
                }
        }
  const voxels = model.voxels.slice(),
    value = tool === 'erase' ? 0 : color;
  for (const index of targets) {
    if (tool === 'paint' && !model.voxels[index]) continue;
    if (model.voxels[index] !== value) voxels[index] = value;
  }
  return { targets: [...targets], voxels };
}

// Studio's frozen face stroke (faceStroke): each surface cell, moved one cell along the normal when attaching,
// mirrored; attach copies the source cell's index, the last write wins.
function studioFace(model, surface, normal, { tool, mirror, color, selection }) {
  let voxels;
  for (const source of surface) {
    const sourceColor = model.voxels[cellIndex(model.size, ...source)],
      point = source.map((n, axis) => n + (tool === 'attach' ? normal[axis] : 0)),
      xs = mirror[0] ? [point[0], model.size[0] - 1 - point[0]] : [point[0]],
      ys = mirror[1] ? [point[1], model.size[1] - 1 - point[1]] : [point[1]],
      zs = mirror[2] ? [point[2], model.size[2] - 1 - point[2]] : [point[2]];
    for (const x of xs)
      for (const y of ys)
        for (const z of zs) {
          if (!insideGrid(model.size, x, y, z)) continue;
          const index = cellIndex(model.size, x, y, z);
          if (selection.size && !selection.has(index)) continue;
          if (tool === 'paint' && !model.voxels[index]) continue;
          const value = tool === 'erase' ? 0 : tool === 'paint' ? color : sourceColor;
          if ((voxels ?? model.voxels)[index] !== value) {
            voxels ??= model.voxels.slice();
            voxels[index] = value;
          }
        }
  }
  return voxels ?? model.voxels;
}

// Studio's frozen clipboard paste (pasteAt), identities given as keys; throws where the palette is full.
function studioPaste(target, targetKeys, clip, clipKeys, origin) {
  const placed = clip
      .map(([x, y, z, color]) => ({ point: [x + origin[0], y + origin[1], z + origin[2]], color }))
      .filter((cell) => insideGrid(target.size, ...cell.point)),
    destinations = new Set(placed.map((cell) => cellIndex(target.size, ...cell.point))),
    used = new Set();
  for (let i = 0; i < target.voxels.length; i++)
    if (target.voxels[i] && !destinations.has(i)) used.add(target.voxels[i]);
  const identities = [...targetKeys],
    remap = new Map(),
    assigned = [];
  for (const source of new Set(placed.map((cell) => cell.color))) {
    const identity = clipKeys[source];
    let index =
      identities[source] === identity ? source : identities.findIndex((c, slot) => slot > 0 && c === identity);
    if (index < 1) {
      index = 1;
      while (index < 256 && used.has(index)) index++;
      if (index === 256) throw new RangeError('Paste requires more than 255 color/material identities in one model.');
      identities[index] = identity;
      assigned.push({ from: source, to: index });
    }
    used.add(index);
    remap.set(source, index);
  }
  const voxels = target.voxels.slice();
  for (const cell of placed) voxels[cellIndex(target.size, ...cell.point)] = remap.get(cell.color);
  return { voxels, selection: [...destinations], assigned, remap };
}

function randomModel(random, n = 7) {
  const size = [2 + Math.floor(random() * n), 2 + Math.floor(random() * n), 2 + Math.floor(random() * n)],
    voxels = new Uint8Array(size[0] * size[1] * size[2]);
  for (let i = 0; i < voxels.length; i++) if (random() < 0.35) voxels[i] = 1 + Math.floor(random() * 6);
  return { size, voxels };
}
const randomSelection = (random, model) =>
  new Set(random() < 0.5 ? [] : [...model.voxels.keys()].filter(() => random() < 0.4));

test("mirrorCells + stampCells reproduce Studio's mirrored brush, dense and sparse", () => {
  const random = createRandom(31);
  for (let round = 0; round < 300; round++) {
    const model = randomModel(random),
      mirror = [random() < 0.5, random() < 0.5, random() < 0.5],
      side = 1 + Math.floor(random() * 4),
      tool = ['attach', 'paint', 'erase'][round % 3],
      color = 1 + Math.floor(random() * 255),
      selection = randomSelection(random, model),
      cells = Array.from({ length: 1 + Math.floor(random() * 4) }, () => [
        Math.floor(random() * (model.size[0] + 2)) - 1,
        Math.floor(random() * (model.size[1] + 2)) - 1,
        Math.floor(random() * (model.size[2] + 2)) - 1,
      ]),
      studio = studioApply(model, cells, { tool, side, mirror, color, selection: new Set() }),
      stamp = mirrorCells(cells, { size: model.size, mirror, side });
    assert.deepEqual(Array.from(stamp.cells), studio.targets, 'same cells, same order, centre planes once');
    const options = {
        operation: { attach: 'fill', paint: 'paint', erase: 'erase' }[tool],
        color,
        ...(selection.size ? { selection } : {}),
      },
      dense = stampCells(model, stamp.cells, options),
      expected = studioApply(model, cells, { tool, side, mirror, color, selection }).voxels;
    assert.deepEqual(dense.grid.voxels, expected);
    const sparse = stampCells(SparseGrid.fromGrid(model), stamp.cells, options);
    assert.deepEqual(sparse.grid.readWindow([0, 0, 0], model.size).voxels, expected);
    assert.equal(sparse.delta.changed, dense.changed);
  }
});

test("indexed mirror samples reproduce Studio's mirrored face strokes", () => {
  const random = createRandom(32),
    normals = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
  let strokes = 0;
  for (let round = 0; round < 600; round++) {
    const model = randomModel(random),
      filled = [...model.voxels.keys()].filter((i) => model.voxels[i]);
    if (!filled.length) continue;
    const seed = cellAt(model.size, filled[Math.floor(random() * filled.length)]),
      normal = normals[round % 6],
      surface = Array.from(faceCells(model, seed, normal), (i) => cellAt(model.size, i));
    if (!surface.length) continue;
    strokes++;
    const mirror = [random() < 0.6, random() < 0.6, random() < 0.6],
      tool = ['attach', 'paint', 'erase'][round % 3],
      color = 1 + Math.floor(random() * 255),
      selection = randomSelection(random, model),
      samples = surface.map((s) => [
        ...s.map((n, a) => n + (tool === 'attach' ? normal[a] : 0)),
        model.voxels[cellIndex(model.size, ...s)],
      ]),
      stamp = mirrorCells(samples, { size: model.size, mirror }),
      ours = stampCells(model, stamp.cells, {
        operation: { attach: 'fill', paint: 'paint', erase: 'erase' }[tool],
        ...(tool === 'paint' ? { color } : { values: stamp.values }),
        ...(selection.size ? { selection } : {}),
      });
    assert.deepEqual(ours.grid.voxels, studioFace(model, surface, normal, { tool, mirror, color, selection }));
  }
  assert.ok(strokes > 150, `${strokes} strokes`);
});

test('mirrorCells keeps a centre-plane cell once and refuses bad input', () => {
  const stamp = mirrorCells([[2, 0, 0]], { size: [5, 1, 1], mirror: [true, false, false] });
  assert.deepEqual(Array.from(stamp.cells), [2]);
  assert.equal(stamp.values, undefined);
  const indexed = mirrorCells(
    [
      [1, 0, 0, 4],
      [3, 0, 0, 9],
    ],
    { size: [5, 1, 1], mirror: [true, false, false] },
  );
  assert.deepEqual(
    [Array.from(indexed.cells), Array.from(indexed.values)],
    [
      [1, 3],
      [9, 9],
    ],
  );
  assert.throws(() => mirrorCells([[0.5, 0, 0]], { size: [2, 2, 2], mirror: [false, false, false] }), RangeError);
  assert.throws(
    () =>
      mirrorCells(
        [
          [0, 0, 0],
          [0, 0, 0, 1],
        ],
        { size: [2, 2, 2], mirror: [true, true, true] },
      ),
    TypeError,
  );
  assert.throws(() => mirrorCells([[0, 0, 0]], { size: [2, 2, 2], mirror: [1, 0, 0] }), TypeError);
  assert.throws(
    () => mirrorCells([[0, 0, 0]], { size: [2, 2, 2], mirror: [true, true, true], maxCells: 7 }),
    /maxCells/,
  );
  assert.throws(
    () => stampCells({ size: [2, 1, 1], voxels: new Uint8Array(2) }, [2], { operation: 'erase' }),
    /cell index/,
  );
  assert.throws(
    () => stampCells({ size: [2, 1, 1], voxels: new Uint8Array(2) }, [0], { operation: 'fill' }),
    /color or values/,
  );
});

test("pasteCells maps palettes and places cells as Studio's clipboard does, dense and sparse", () => {
  const random = createRandom(30);
  let overflows = 0;
  for (let round = 0; round < 400; round++) {
    const tight = round % 4 === 0,
      target = tight ? { size: [255, 2, 1], voxels: new Uint8Array(510) } : randomModel(random, 6),
      targetKeys = Array.from({ length: 256 }, (_, i) => `k${tight ? i : Math.floor(random() * 12)}`),
      // Half the full-palette rounds paste identities the target already has, so they fit.
      clipKeys =
        tight && round % 8 === 0
          ? targetKeys
          : Array.from({ length: 256 }, (_, i) => `k${tight ? 300 + i : Math.floor(random() * 16)}`);
    // Every slot used twice: a paste frees a slot only by covering both of its cells.
    if (tight) for (let i = 0; i < target.voxels.length; i++) target.voxels[i] = 1 + (i % 255);
    const clip = Array.from({ length: 1 + Math.floor(random() * (tight ? 10 : 30)) }, () => [
        Math.floor(random() * (tight ? 12 : 5)),
        Math.floor(random() * (tight ? 2 : 5)),
        tight ? 0 : Math.floor(random() * 5),
        1 + Math.floor(random() * 254),
      ]).filter((cell, i, all) => all.findIndex((other) => other.slice(0, 3).join() === cell.slice(0, 3).join()) === i),
      offset = tight
        ? [0, 0, 0]
        : [Math.floor(random() * 7) - 2, Math.floor(random() * 7) - 2, Math.floor(random() * 7) - 2],
      options = { offset, targetKeys, clipKeys };
    let studio;
    try {
      studio = studioPaste(target, targetKeys, clip, clipKeys, offset);
    } catch {
      studio = undefined;
    }
    const dense = pasteCells(target, clip, options),
      sparse = pasteCells(SparseGrid.fromGrid(target), clip, options);
    if (!studio) {
      overflows++;
      assert.equal(dense.status, 'overflow');
      assert.ok(dense.needed > dense.free);
      assert.deepEqual(sparse, dense);
      continue;
    }
    assert.equal(dense.status, 'pasted');
    assert.deepEqual(dense.grid.voxels, studio.voxels);
    assert.deepEqual(Array.from(dense.selection), studio.selection);
    assert.deepEqual(dense.assignments, studio.assigned);
    for (const [from, to] of studio.remap) assert.equal(dense.paletteMap[from], to);
    assert.equal(sparse.status, 'pasted');
    assert.deepEqual(sparse.grid.readWindow([0, 0, 0], target.size).voxels, studio.voxels);
    assert.deepEqual(Array.from(sparse.selection), studio.selection);
    assert.deepEqual(sparse.assignments, studio.assigned);
  }
  assert.ok(overflows > 30 && overflows < 70, `${overflows} overflows`);
});

test('equal-looking slots stay distinct and a full palette refuses atomically', () => {
  const keys = Array.from({ length: 256 }, (_, i) => `slot${i}`);
  keys[3] = keys[5] = 'red-glass';
  const target = { size: [3, 1, 1], voxels: Uint8Array.from([3, 5, 0]) },
    pasted = pasteCells(target, [[2, 0, 0, 5]], { offset: [0, 0, 0], targetKeys: keys, clipKeys: keys });
  assert.equal(pasted.grid.voxels[2], 5, 'slot 5 keeps slot 5, not the first equal-looking slot 3');
  const used = new Uint8Array(256);
  used[3] = used[5] = 1;
  assert.equal(
    mergePalettes({ baseKeys: keys, toolKeys: keys, baseUsed: used, toolUsed: used }).paletteMap[5],
    3,
    'mergePalettes, by contrast, reuses the first equal identity',
  );
  // Slots 1-255 all used; cell 255 repeats slot 1, so covering it frees nothing.
  const full = { size: [256, 1, 1], voxels: Uint8Array.from({ length: 256 }, (_, i) => (i < 255 ? i + 1 : 1)) },
    fresh = keys.map((key) => `${key}!`),
    refused = pasteCells(full, [[0, 0, 0, 1]], { offset: [300, 0, 0], targetKeys: keys, clipKeys: fresh });
  assert.equal(refused.status, 'pasted', 'a clip that lands outside needs no slot');
  assert.equal(refused.clipped, 1);
  const overflow = pasteCells(full, [[0, 0, 0, 1]], { offset: [255, 0, 0], targetKeys: keys, clipKeys: fresh });
  assert.deepEqual(overflow, { status: 'overflow', needed: 1, free: 0 });
  const freed = pasteCells(full, [[0, 0, 0, 1]], { offset: [10, 0, 0], targetKeys: keys, clipKeys: fresh });
  assert.equal(freed.status, 'pasted', 'the overwritten cell frees its slot 11');
  assert.deepEqual(freed.assignments, [{ from: 1, to: 11 }]);
  assert.throws(
    () => pasteCells(full, [[0, 0, 0, 0]], { offset: [0, 0, 0], targetKeys: keys, clipKeys: keys }),
    RangeError,
  );
  assert.throws(
    () => pasteCells(full, [], { offset: [0, 0, 0], targetKeys: keys.slice(1), clipKeys: keys }),
    TypeError,
  );
});

// Node checks of @margoengine/tilemap/iso and /hex: cell boxes, outlines, picking, neighbours, paint order, hex cubes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellToCube, cubeToCell, hexDistance, hexLine, hexRing, roundCube } from '../dist/hex.js';
import {
  cellBox,
  cellCenter,
  cellNeighbors,
  cellPolygon,
  GridTileMap,
  mapPixelSize,
  paintOrder,
  pixelToCell,
  visibleCells,
} from '../dist/iso.js';

const iso = { width: 4, height: 3, tileWidth: 32, tileHeight: 16, orientation: 'isometric' };
const staggered = { ...iso, orientation: 'staggered', staggerAxis: 'y', staggerIndex: 'odd' };
const hexY = {
  ...iso,
  tileWidth: 28,
  tileHeight: 32,
  orientation: 'hexagonal',
  hexSideLength: 16,
  staggerAxis: 'y',
  staggerIndex: 'odd',
};
const hexX = { ...hexY, tileWidth: 32, tileHeight: 28, staggerAxis: 'x', staggerIndex: 'even' };

test('isometric: cell boxes, centres and the map box, from x = (c - r + rows - 1) tw / 2, y = (c + r) th / 2', () => {
  assert.deepEqual(cellBox(iso, 0, 0), { x: 32, y: 0, width: 32, height: 16 });
  assert.deepEqual(cellBox(iso, 3, 0), { x: 80, y: 24, width: 32, height: 16 });
  assert.deepEqual(cellBox(iso, 0, 2), { x: 0, y: 16, width: 32, height: 16 });
  assert.deepEqual(cellCenter(iso, 1, 1), [48, 24]);
  assert.deepEqual(mapPixelSize(iso), [112, 56]);
  assert.deepEqual(cellPolygon(iso, 0, 0), [
    [48, 0],
    [64, 8],
    [48, 16],
    [32, 8],
  ]);
});

test('staggered and hexagonal: pushed rows or columns move half a cell, steps are (size + side) / 2', () => {
  assert.deepEqual(cellBox(staggered, 1, 0), { x: 32, y: 0, width: 32, height: 16 });
  assert.deepEqual(cellBox(staggered, 1, 1), { x: 48, y: 8, width: 32, height: 16 });
  assert.deepEqual(cellBox({ ...staggered, staggerIndex: 'even' }, 1, 0), { x: 48, y: 0, width: 32, height: 16 });
  assert.deepEqual(mapPixelSize(staggered), [144, 32]);
  // Pointy hexes: rows step (32 + 16) / 2 = 24 down.
  assert.deepEqual(cellBox(hexY, 2, 1), { x: 70, y: 24, width: 28, height: 32 });
  assert.deepEqual(mapPixelSize(hexY), [126, 80]);
  assert.deepEqual(cellPolygon(hexY, 0, 0), [
    [14, 0],
    [28, 8],
    [28, 24],
    [14, 32],
    [0, 24],
    [0, 8],
  ]);
  // Flat hexes, even columns pushed down by 14; columns step (32 + 16) / 2 = 24 across.
  assert.deepEqual(cellBox(hexX, 0, 0), { x: 0, y: 14, width: 32, height: 28 });
  assert.deepEqual(cellBox(hexX, 1, 0), { x: 24, y: 0, width: 32, height: 28 });
  assert.deepEqual(mapPixelSize(hexX), [104, 98]);
  assert.throws(() => cellBox({ ...hexY, hexSideLength: 40 }, 0, 0), /hexSideLength/);
  assert.throws(() => cellBox({ ...iso, orientation: 'oblique' }, 0, 0), /not a layout/);
});

test('picking: every cell centre maps back to its cell, on every layout', () => {
  for (const map of [iso, staggered, hexY, hexX, { ...iso, orientation: 'orthogonal' }])
    for (let y = -1; y <= map.height; y++)
      for (let x = -1; x <= map.width; x++) {
        const [cx, cy] = cellCenter(map, x, y);
        assert.deepEqual(pixelToCell(map, cx, cy), [x, y], `${map.orientation} ${map.staggerAxis} ${x},${y}`);
        // A point a little inside each corner of the outline is still this cell.
        for (const [px, py] of cellPolygon(map, x, y))
          assert.deepEqual(pixelToCell(map, px + (cx - px) * 0.1, py + (cy - py) * 0.1), [x, y]);
      }
});

test('neighbours share an edge: each one has an outline corner pair in common with the cell', () => {
  const shares = (map, a, b) => {
    const pa = cellPolygon(map, ...a).map(String),
      pb = new Set(cellPolygon(map, ...b).map(String));
    return pa.filter((p) => pb.has(p)).length >= 2;
  };
  for (const [map, n] of [
    [iso, 4],
    [staggered, 4],
    [{ ...staggered, staggerAxis: 'x' }, 4],
    [hexY, 6],
    [hexX, 6],
  ])
    for (const cell of [
      [1, 1],
      [2, 2],
      [1, 2],
      [2, 1],
    ]) {
      const list = cellNeighbors(map, ...cell);
      assert.equal(list.length, n);
      assert.equal(new Set(list.map(String)).size, n);
      for (const other of list) assert.ok(shares(map, cell, other), `${map.orientation} ${cell} ${other}`);
    }
});

test('paint order: diagonals on isometric maps, raised columns before lowered on x-staggered rows', () => {
  assert.deepEqual([...paintOrder(iso)], [0, 4, 1, 8, 5, 2, 9, 6, 3, 10, 7, 11]);
  assert.deepEqual([...paintOrder({ ...hexX, width: 3, height: 2 })], [1, 0, 2, 4, 3, 5]);
  assert.deepEqual([...paintOrder(staggered)], [...Array(12).keys()]);
  // visibleCells keeps the same order for a view over the whole map.
  assert.deepEqual(visibleCells(iso, iso, [0, 0, 112, 56]), [...paintOrder(iso)]);
  assert.deepEqual(visibleCells(hexX, hexX, [0, 0, 104, 98]), [...paintOrder(hexX)]);
  assert.deepEqual(visibleCells(iso, iso, [0, 0, 0, 0]), []);
  // Part views never miss a cell whose box reaches into them, on any layout.
  for (const map of [iso, staggered, hexY, hexX])
    for (const view of [
      [0, 16, 16, 32],
      [40, 10, 70, 30],
      [90, 50, 100, 60],
    ]) {
      const seen = new Set(visibleCells(map, map, view));
      for (let y = 0; y < map.height; y++)
        for (let x = 0; x < map.width; x++) {
          const b = cellBox(map, x, y),
            reaches = b.x < view[2] && b.x + b.width > view[0] && b.y < view[3] && b.y + b.height > view[1];
          if (reaches) assert.ok(seen.has(y * map.width + x), `${map.orientation} ${view} misses ${x},${y}`);
        }
    }
  assert.ok(visibleCells(iso, iso, [0, 16, 16, 32]).includes(8));
});

test('hex cubes: neighbours are one step, rings and lines walk the grid, round trips hold', () => {
  for (const map of [hexY, { ...hexY, staggerIndex: 'even' }, hexX, { ...hexX, staggerIndex: 'odd' }])
    for (let y = -2; y <= 3; y++)
      for (let x = -2; x <= 3; x++) {
        const cube = cellToCube(map, x, y);
        assert.equal(cube[0] + cube[1] + cube[2], 0);
        assert.deepEqual(cubeToCell(map, cube), [x, y]);
        for (const n of cellNeighbors(map, x, y)) assert.equal(hexDistance(map, [x, y], n), 1);
        const ring = hexRing(map, x, y, 2);
        assert.equal(ring.length, 12);
        for (const c of ring) assert.equal(hexDistance(map, [x, y], c), 2);
      }
  const line = hexLine(hexY, [0, 0], [3, 2]);
  assert.equal(line.length, hexDistance(hexY, [0, 0], [3, 2]) + 1);
  for (let i = 1; i < line.length; i++) assert.equal(hexDistance(hexY, line[i - 1], line[i]), 1);
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line.at(-1), [3, 2]);
  // (0.6, -0.3, -0.3) is 0.6 from the origin and 0.7 from (1, 0, -1) and (1, -1, 0): it rounds to the origin.
  assert.deepEqual(roundCube(0.6, -0.3, -0.3), [0, 0, 0]);
  // (0.9, -0.1, -0.8) rounds each to (1, 0, -1); s moved most, so it is fixed from the other two.
  assert.deepEqual(roundCube(0.9, -0.1, -0.8), [1, 0, -1]);
  assert.throws(() => cellToCube(iso, 0, 0), /hexagonal or staggered/);
  assert.throws(() => hexRing(hexY, 0, 0, -1), RangeError);
});

test('GridTileMap: options are checked and WebGL is refused with a code', () => {
  const map = { ...iso, tilesets: [], layers: [] };
  assert.throws(() => new GridTileMap({ atlases: {} }), TypeError);
  assert.throws(() => new GridTileMap({ map }), TypeError);
  assert.throws(() => new GridTileMap({ map, atlases: {}, order: NaN }), RangeError);
  assert.throws(() => new GridTileMap({ map: { ...map, orientation: 'oblique' }, atlases: {} }), /not a layout/);
  assert.throws(() => new GridTileMap({ map, atlases: {} }).setup({ backend: 'webgl2' }), { code: 'unsupported' });
});

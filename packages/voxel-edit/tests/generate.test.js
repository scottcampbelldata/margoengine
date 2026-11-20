import assert from 'node:assert/strict';
import test from 'node:test';
import { heightmapToVoxels, textToVoxels } from '../dist/generate.js';
import { cellIndex } from '../dist/index.js';

test('grey heightmaps create rounded columns, Y up with row order preserved', () => {
  const image = { width: 2, height: 2, data: Uint8Array.of(0, 85, 170, 255) },
    original = image.data.slice();
  const { grid, palette, colorsReduced } = heightmapToVoxels(image, { height: 3 });
  assert.deepEqual(grid.size, [2, 3, 2]);
  const columns = [];
  for (let z = 0; z < 2; z++)
    for (let x = 0; x < 2; x++) {
      let count = 0;
      for (let y = 0; y < 3; y++) if (grid.voxels[cellIndex(grid.size, x, y, z)]) count++;
      columns.push(count);
    }
  assert.deepEqual(columns, [0, 1, 2, 3]);
  assert.deepEqual(image.data, original);
  assert.equal(palette[7], 255);
  assert.equal(colorsReduced, false);
  assert.equal(heightmapToVoxels(image, { height: 3, invert: true }).grid.voxels.filter(Boolean).length, 6);
});

test('RGBA channel, transparency and palette are independent of column height', () => {
  const image = { width: 3, height: 1, data: Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 128, 255, 255, 255, 0) };
  const out = heightmapToVoxels(image, { height: 10 });
  assert.equal(out.grid.voxels.filter(Boolean).length, 9); // red 2, green 7, transparent 0
  assert.deepEqual([...out.palette.slice(4, 12)], [255, 0, 0, 255, 0, 255, 0, 128]);
  assert.equal(heightmapToVoxels(image, { height: 10, channel: 'red' }).grid.voxels.filter(Boolean).length, 10);
  assert.equal(
    heightmapToVoxels(image, { height: 10, channel: 'alpha', alphaThreshold: 128 }).grid.voxels.filter(Boolean).length,
    10,
  );
});

test('generation validates and budgets before allocation; cancellation propagates', () => {
  const image = { width: 2, height: 2, data: new Uint8Array(4) };
  assert.throws(() => heightmapToVoxels(image, { height: 100, maxCells: 100 }), /maxCells|heightmap/);
  for (const data of [new Uint8Array(3), new Float32Array(4)])
    assert.throws(() => heightmapToVoxels({ ...image, data }));
  for (const height of [0, -1, Infinity, 1.5]) assert.throws(() => heightmapToVoxels(image, { height }));
  assert.throws(() => heightmapToVoxels(image, { channel: 'unknown' }));
  assert.throws(() => heightmapToVoxels(image, { invert: 2 }));
  const reason = new Error('cancel'),
    signal = AbortSignal.abort(reason);
  assert.throws(
    () => heightmapToVoxels(image, { signal }),
    (e) => e === reason,
  );
  assert.throws(
    () => textToVoxels('M', { font: '12px serif', signal }),
    (e) => e === reason,
  );
  assert.throws(() => textToVoxels('M', { font: '12px serif', depth: 0 }));
  assert.throws(() => textToVoxels('M', { font: '12px serif', color: [0, 0, 0, 0] }));
});

test('many image colours use the same deterministic palette reduction as file import', () => {
  const data = new Uint8Array(300 * 4);
  for (let i = 0; i < 300; i++) data.set([i & 255, i >> 8, 255, 255], 4 * i);
  const a = heightmapToVoxels({ width: 300, height: 1, data }, { height: 1, channel: 'blue' });
  assert.equal(a.grid.voxels.filter(Boolean).length, 300);
  assert.equal(a.colorsReduced, true);
  assert.deepEqual(a, heightmapToVoxels({ width: 300, height: 1, data }, { height: 1, channel: 'blue' }));
});

test('a grey heightmap ignores alphaThreshold, which applies to RGBA samples only', () => {
  const image = { width: 2, height: 1, data: Uint8Array.from([255, 128]) };
  // Grey samples read as alpha 255, so the top threshold (255) once turned every grey column into air.
  assert.equal(heightmapToVoxels(image, { height: 2, alphaThreshold: 255 }).grid.voxels.filter(Boolean).length, 3);
});

// A stand-in 2D context: each glyph's ink is a box 3 px right of the pen (a side bearing) and 2 px below the baseline
// (a descender only), 4 px wide and 3 px tall.
function inkContext() {
  const ink = [];
  let width = 1,
    height = 1;
  const canvas = {
    get width() {
      return width;
    },
    set width(v) {
      width = v;
      ink.length = 0;
    },
    get height() {
      return height;
    },
    set height(v) {
      height = v;
      ink.length = 0;
    },
  };
  return {
    canvas,
    font: '',
    measureText: (text) =>
      text
        ? { actualBoundingBoxLeft: -3, actualBoundingBoxRight: 7, actualBoundingBoxAscent: -2, actualBoundingBoxDescent: 5 }
        : { actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 },
    fillText: (text, x, y) => text && ink.push([x + 3, y + 2]),
    getImageData: (x0, y0, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (const [x, y] of ink)
        for (let row = y; row < y + 3; row++)
          for (let col = x; col < x + 4; col++) if (col < w && row < h) data[(row * w + col) * 4 + 3] = 255;
      return { data };
    },
  };
}

test('textToVoxels crops to the ink: no empty columns for a side bearing or rows above ink below the baseline', () => {
  const { grid } = textToVoxels('x', { font: '10px test', context: inkContext() });
  assert.deepEqual(grid.size, [4, 3, 1]);
  assert.equal(grid.voxels.filter(Boolean).length, 12);
  // Blank text is still one empty cell.
  assert.deepEqual(textToVoxels('', { font: '10px test', context: inkContext() }).grid.size, [1, 1, 1]);
});

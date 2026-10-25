// padTileGrid: each tile of an existing grid keeps its pixels exactly and gains `padding` copies of its own border, so
// filtering and mip levels never reach a neighbour; margins, spacing, drawable (flipped) images and remapTileUVs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { padTileGrid, remapTileUVs } from '../dist/atlas.js';

// A tileset whose every pixel names its tile and position: r = tile column, g = tile row, b = x in tile, a = y in tile.
// Gutter pixels (margin, spacing) are 255 so a test sees any that leak.
function tileset(columns, rows, tw, th, margin = 0, spacing = 0) {
  const width = 2 * margin + columns * tw + (columns - 1) * spacing,
    height = 2 * margin + rows * th + (rows - 1) * spacing,
    data = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++) {
          const o = ((margin + row * (th + spacing) + y) * width + margin + column * (tw + spacing) + x) * 4;
          data.set([column, row, x, y], o);
        }
  return { width, height, data };
}
const pixel = ({ data, width }, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

function checkPadded(grid, columns, rows, tw, th, p, flip = false) {
  const { width, height } = grid.image;
  assert.deepEqual(
    [grid.columns, grid.rows, width, height],
    [columns, rows, columns * (tw + 2 * p), rows * (th + 2 * p)],
  );
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      for (let y = -p; y < th + p; y++)
        for (let x = -p; x < tw + p; x++) {
          const oy = row * (th + 2 * p) + p + y,
            got = pixel(grid.image, column * (tw + 2 * p) + p + x, flip ? height - 1 - oy : oy);
          const cx = Math.min(tw - 1, Math.max(0, x)),
            cy = Math.min(th - 1, Math.max(0, y));
          assert.deepEqual(got, [column, row, cx, cy], `tile ${column},${row} at ${x},${y}`);
        }
}

test('padTileGrid repeats each tile border and keeps the tile pixels exact', () => {
  const grid = padTileGrid(tileset(3, 2, 4, 3), { tileWidth: 4, tileHeight: 3, padding: 2 });
  checkPadded(grid, 3, 2, 4, 3, 2);
  assert.equal(grid.padding, 2);
  assert.equal(grid.regions.length, 6);
  // Region k maps the tile's 0-1 UVs onto its interior pixels: the centre of texel (1, 2) of tile (2, 1).
  const r = grid.regions[1 * 3 + 2],
    W = grid.image.width,
    H = grid.image.height,
    x = Math.floor((r.offset[0] + (1.5 / 4) * r.scale[0]) * W),
    y = Math.floor((r.offset[1] + (2.5 / 3) * r.scale[1]) * H);
  assert.deepEqual(pixel(grid.image, x, y), [2, 1, 1, 2]);
  checkPadded(padTileGrid(tileset(2, 2, 2, 2), { tileWidth: 2, tileHeight: 2, padding: 0 }), 2, 2, 2, 2, 0);
  checkPadded(padTileGrid(tileset(1, 1, 1, 1), { tileWidth: 1, tileHeight: 1 }), 1, 1, 1, 1, 2);
});

test('padTileGrid skips margins and spacing and ignores a partial last row or column', () => {
  const source = tileset(3, 2, 4, 4, 1, 2);
  // Two extra pixels on the right and bottom: not enough for another tile.
  const wider = {
    width: source.width + 2,
    height: source.height + 2,
    data: new Uint8Array((source.width + 2) * (source.height + 2) * 4),
  };
  for (let y = 0; y < source.height; y++)
    wider.data.set(source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4), y * wider.width * 4);
  for (const image of [source, wider])
    checkPadded(padTileGrid(image, { tileWidth: 4, tileHeight: 4, padding: 3, margin: 1, spacing: 2 }), 3, 2, 4, 4, 3);
});

test('padTileGrid reads drawable images flipped like packAtlas and keeps their orientation', () => {
  const source = tileset(2, 2, 3, 2);
  // A drawable image whose 2D context returns `source` rows top first.
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      assert.deepEqual([w, h], [source.width, source.height]);
    }
    getContext() {
      return { drawImage() {}, getImageData: () => source };
    }
  };
  try {
    const grid = padTileGrid(
      { width: source.width, height: source.height },
      { tileWidth: 3, tileHeight: 2, padding: 1 },
    );
    checkPadded(grid, 2, 2, 3, 2, 1, true);
    // The region of tile (0, 0), the top-left of the drawn image, is at the top of the flipped atlas rows.
    const r = grid.regions[0];
    assert.equal(r.offset[1], (grid.image.height - 1 - 2) / grid.image.height);
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});

test('remapTileUVs moves source-grid UVs into the padded tiles', () => {
  const source = tileset(3, 2, 4, 4, 1, 2),
    grid = padTileGrid(source, { tileWidth: 4, tileHeight: 4, padding: 2, margin: 1, spacing: 2 }),
    // Corners and centre of tile (1, 1) in source UVs, v counted like image rows.
    x0 = 1 + 6,
    y0 = 1 + 6,
    uvs = [x0, y0, x0 + 4, y0, x0 + 4, y0 + 4, x0 + 2, y0 + 2].map(
      (n, i) => n / (i % 2 ? source.height : source.width),
    ),
    out = remapTileUVs(uvs, [4, 4, 4, 4], grid, { width: source.width, height: source.height, margin: 1, spacing: 2 });
  const px = (i) => [out[i * 2] * grid.image.width, out[i * 2 + 1] * grid.image.height];
  const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-4, `${a} vs ${b}`));
  close(px(0), [8 + 2, 8 + 2]);
  close(px(1), [8 + 2 + 4, 8 + 2]);
  close(px(2), [8 + 2 + 4, 8 + 2 + 4]);
  close(px(3), [8 + 4, 8 + 4]);
  assert.throws(() => remapTileUVs([0, 0], [6], grid, source), { name: 'RangeError', message: /use 0 to 5/ });
  assert.throws(() => remapTileUVs([0, 0, 1, 1], [0], grid, source), RangeError);
});

test('padTileGrid rejects grids that do not fit and bad options with the fix in the message', () => {
  const image = tileset(2, 2, 4, 4);
  assert.throws(() => padTileGrid(image, { tileWidth: 0, tileHeight: 4 }), {
    name: 'RangeError',
    message: /tile size/,
  });
  assert.throws(() => padTileGrid(image, { tileWidth: 4, tileHeight: 4, padding: -1 }), RangeError);
  assert.throws(() => padTileGrid(image, { tileWidth: 4, tileHeight: 4, spacing: 1.5 }), RangeError);
  assert.throws(() => padTileGrid(image, { tileWidth: 9, tileHeight: 4 }), {
    name: 'RangeError',
    message: /do not fit/,
  });
  assert.throws(
    () => padTileGrid({ width: 4, height: 4, data: new Uint8Array(8) }, { tileWidth: 2, tileHeight: 2 }),
    RangeError,
  );
  assert.throws(
    () =>
      padTileGrid(
        { width: 4096, height: 4096, data: new Uint8Array(4096 * 4096 * 4) },
        { tileWidth: 1, tileHeight: 1, padding: 1 },
      ),
    { name: 'RangeError', message: /less padding/ },
  );
});

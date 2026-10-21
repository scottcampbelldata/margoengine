import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '@margoengine/math/mathutils';
import { cellIndex, sliceLayout, stackSlices } from '../dist/index.js';

// Fixtures and expectations from Margo Voxel Studio's slice import tests (src/ingest/slices.test.ts).
const rgba = (red, green = 0, blue = 0, alpha = 255) => [red, green, blue, alpha];
const image = (width, height, colors) => ({ width, height, data: new Uint8ClampedArray(colors.flat()) });
const hex = (palette, index) =>
  `#${Array.from(palette.subarray(4 * index, 4 * index + 4), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const colorAt = ({ grid, palette }, x, y, z) => {
  const index = grid.voxels[cellIndex(grid.size, x, y, z)];
  return index ? hex(palette, index) : null;
};

// Studio's frozen stacking kernel (src/ingest/slices.ts stackSlices), palette as hex strings, kept as the oracle.
function studioStack(
  pixels,
  { frameWidth, frameHeight, columns, frameCount, axis = 'y', topToBottom = true, alphaThreshold = 1 },
) {
  columns ??= pixels.width / frameWidth;
  frameCount ??= columns * (pixels.height / frameHeight);
  const size =
      axis === 'y'
        ? [frameWidth, frameCount, frameHeight]
        : axis === 'z'
          ? [frameWidth, frameHeight, frameCount]
          : [frameCount, frameHeight, frameWidth],
    colors = new Map(),
    palette = Array(256).fill('#00000000'),
    keyAt = (o) =>
      (pixels.data[o] | (pixels.data[o + 1] << 8) | (pixels.data[o + 2] << 16) | (pixels.data[o + 3] << 24)) >>> 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const left = (frame % columns) * frameWidth,
      top = Math.floor(frame / columns) * frameHeight;
    for (let row = 0; row < frameHeight; row++)
      for (let column = 0; column < frameWidth; column++) {
        const offset = ((top + row) * pixels.width + left + column) * 4;
        if (pixels.data[offset + 3] < alphaThreshold) continue;
        const key = keyAt(offset);
        if (colors.has(key)) continue;
        if (colors.size === 255) throw new RangeError('more than 255 colors');
        const index = colors.size + 1;
        colors.set(key, index);
        palette[index] =
          `#${Array.from(pixels.data.subarray(offset, offset + 4), (b) => b.toString(16).padStart(2, '0')).join('')}`;
      }
  }
  const voxels = new Uint8Array(size[0] * size[1] * size[2]);
  for (let frame = 0; frame < frameCount; frame++) {
    const left = (frame % columns) * frameWidth,
      top = Math.floor(frame / columns) * frameHeight,
      depth = topToBottom ? frameCount - 1 - frame : frame;
    for (let row = 0; row < frameHeight; row++)
      for (let column = 0; column < frameWidth; column++) {
        const offset = ((top + row) * pixels.width + left + column) * 4;
        if (pixels.data[offset + 3] < alphaThreshold) continue;
        const point =
          axis === 'y'
            ? [column, depth, row]
            : axis === 'z'
              ? [column, frameHeight - 1 - row, depth]
              : [depth, frameHeight - 1 - row, column];
        voxels[cellIndex(size, ...point)] = colors.get(keyAt(offset));
      }
  }
  return { size, voxels, palette };
}

test('rectangular sprite frames are read row-major and keep image rows along positive Z', () => {
  const pixels = image(4, 2, [
      rgba(255),
      rgba(0, 255),
      rgba(0, 0, 255),
      rgba(255, 255),
      rgba(0, 255, 255),
      rgba(255, 0, 255),
      rgba(255, 255, 255),
      rgba(0),
    ]),
    stack = stackSlices(pixels, { frameWidth: 2, frameHeight: 1 });
  assert.deepEqual(stack.grid.size, [2, 4, 1]);
  assert.equal(colorAt(stack, 0, 3, 0), '#ff0000ff');
  assert.equal(colorAt(stack, 1, 3, 0), '#00ff00ff');
  assert.equal(colorAt(stack, 0, 2, 0), '#0000ffff');
  assert.equal(colorAt(stack, 1, 2, 0), '#ffff00ff');
  assert.equal(colorAt(stack, 0, 1, 0), '#00ffffff');
  assert.equal(colorAt(stack, 1, 0, 0), '#000000ff');
  assert.equal(stack.colors, 8);
});

test('top-to-bottom false places frame zero on the bottom; transparency and exact alpha are kept', () => {
  const low = stackSlices(image(2, 3, [rgba(1), rgba(2), rgba(3), rgba(4), rgba(5), rgba(6)]), {
    frameWidth: 1,
    frameHeight: 3,
    topToBottom: false,
  });
  assert.deepEqual(low.grid.size, [1, 2, 3]);
  assert.equal(colorAt(low, 0, 0, 0), '#010000ff');
  assert.equal(colorAt(low, 0, 0, 2), '#050000ff');
  assert.equal(colorAt(low, 0, 1, 0), '#020000ff');
  const alpha = stackSlices(image(4, 1, [rgba(1, 2, 3, 0), rgba(1, 2, 3, 1), rgba(1, 2, 3, 128), rgba(1, 2, 3, 1)]), {
    frameWidth: 4,
    frameHeight: 1,
  });
  assert.deepEqual([...alpha.grid.voxels], [0, 1, 2, 1]);
  assert.equal(hex(alpha.palette, 1), '#01020301');
  assert.equal(hex(alpha.palette, 2), '#01020380');
  assert.equal(hex(alpha.palette, 0), '#00000000');
  const filtered = stackSlices(image(3, 1, [rgba(1, 2, 3, 127), rgba(1, 2, 3, 128), rgba(1, 2, 3, 255)]), {
    frameWidth: 3,
    frameHeight: 1,
    alphaThreshold: 128,
  });
  assert.deepEqual([...filtered.grid.voxels], [0, 1, 2]);
});

test('the palette only uses selected frames; 255 colours fit and 256 refuse without quantizing', () => {
  const picked = stackSlices(image(3, 2, [rgba(11), rgba(22), rgba(33), rgba(44), rgba(55), rgba(66)]), {
    frameWidth: 1,
    frameHeight: 1,
    columns: 2,
    frameCount: 3,
    topToBottom: false,
  });
  assert.deepEqual([...picked.grid.voxels], [1, 2, 3]);
  assert.deepEqual(
    [1, 2, 3].map((i) => hex(picked.palette, i)),
    ['#0b0000ff', '#160000ff', '#2c0000ff'],
  );
  const colors = Array.from({ length: 256 }, (_, index) => rgba(index));
  assert.equal(
    stackSlices(image(255, 1, colors.slice(0, 255)), { frameWidth: 255, frameHeight: 1 }).grid.voxels[254],
    255,
  );
  assert.throws(() => stackSlices(image(256, 1, colors), { frameWidth: 256, frameHeight: 1 }), /255.*colou?r/i);
});

test('alternative stack axes map image columns and upright rows; empty frames keep their depth', () => {
  const pixels = image(2, 2, [rgba(1), rgba(2), rgba(3), rgba(4)]),
    alongZ = stackSlices(pixels, { frameWidth: 1, frameHeight: 2, axis: 'z' });
  assert.deepEqual(alongZ.grid.size, [1, 2, 2]);
  assert.equal(colorAt(alongZ, 0, 1, 1), '#010000ff');
  assert.equal(colorAt(alongZ, 0, 0, 1), '#030000ff');
  assert.equal(colorAt(alongZ, 0, 1, 0), '#020000ff');
  const alongX = stackSlices(pixels, { frameWidth: 1, frameHeight: 2, axis: 'x' });
  assert.deepEqual(alongX.grid.size, [2, 2, 1]);
  assert.equal(colorAt(alongX, 1, 1, 0), '#010000ff');
  assert.equal(colorAt(alongX, 1, 0, 0), '#030000ff');
  assert.equal(colorAt(alongX, 0, 1, 0), '#020000ff');
  const gap = stackSlices(image(1, 3, [rgba(10), rgba(10, 0, 0, 0), rgba(20)]), { frameWidth: 1, frameHeight: 1 });
  assert.deepEqual(
    [gap.grid.size, [...gap.grid.voxels]],
    [
      [1, 3, 1],
      [2, 0, 1],
    ],
  );
  assert.deepEqual(
    [...stackSlices(image(1, 1, [rgba(99, 99, 99, 0)]), { frameWidth: 1, frameHeight: 1 }).grid.voxels],
    [0],
  );
});

test('invalid frame grids, counts, buffers, thresholds, axes and budgets are refused before allocation', () => {
  const pixels = image(
    2,
    2,
    Array.from({ length: 4 }, () => rgba(1)),
  );
  for (const options of [
    { frameWidth: 0, frameHeight: 1 },
    { frameWidth: 1.5, frameHeight: 1 },
    { frameWidth: 3, frameHeight: 1 },
    { frameWidth: 1, frameHeight: 3 },
    { frameWidth: 1, frameHeight: 1, columns: 3 },
    { frameWidth: 1, frameHeight: 1, columns: 0 },
    { frameWidth: 1, frameHeight: 1, frameCount: 0 },
    { frameWidth: 1, frameHeight: 1, frameCount: 5 },
    { frameWidth: 1, frameHeight: 1, alphaThreshold: 0 },
    { frameWidth: 1, frameHeight: 1, alphaThreshold: 256 },
    { frameWidth: 1, frameHeight: 1, axis: 'w' },
  ])
    assert.throws(() => stackSlices(pixels, options), RangeError);
  assert.throws(
    () =>
      stackSlices(
        image(
          3,
          2,
          Array.from({ length: 6 }, () => rgba(1)),
        ),
        { frameWidth: 2, frameHeight: 1 },
      ),
    /grid of frames/,
  );
  assert.throws(
    () => stackSlices({ width: 2, height: 2, data: new Uint8ClampedArray(4) }, { frameWidth: 1, frameHeight: 1 }),
    /buffer/,
  );
  assert.throws(
    () => stackSlices({ width: 0, height: 1, data: new Uint8ClampedArray() }, { frameWidth: 1, frameHeight: 1 }),
    RangeError,
  );
  assert.throws(() => sliceLayout(4096, 4097, { frameWidth: 1024, frameHeight: 1 }), /maxCells/);
  assert.throws(() => sliceLayout(64, 64, { frameWidth: 1, frameHeight: 1, maxCells: 4095 }), /maxCells/);
  assert.deepEqual(sliceLayout(4, 6, { frameWidth: 2, frameHeight: 3, frameCount: 3 }).size, [2, 3, 3]);
});

test('a fixed palette takes the first exact index and refuses colours it lacks', () => {
  const palette = new Uint8Array(1024);
  palette.set([255, 0, 0, 255], 4 * 7);
  palette.set([255, 0, 0, 255], 4 * 9);
  palette.set([0, 0, 255, 128], 4 * 3);
  const stack = stackSlices(image(3, 1, [rgba(255), rgba(0, 0, 255, 128), rgba(0, 0, 0, 0)]), {
    frameWidth: 3,
    frameHeight: 1,
    palette,
  });
  assert.deepEqual([...stack.grid.voxels], [7, 3, 0]);
  assert.deepEqual(stack.palette, palette);
  assert.notEqual(stack.palette, palette, 'the result owns a copy');
  assert.equal(stack.colors, 2);
  assert.throws(() => stackSlices(image(1, 1, [rgba(1)]), { frameWidth: 1, frameHeight: 1, palette }), /lacks/);
  assert.throws(
    () => stackSlices(image(1, 1, [rgba(1)]), { frameWidth: 1, frameHeight: 1, palette: new Uint8Array(4) }),
    TypeError,
  );
});

test("stackSlices matches Studio's frozen stacking on random sheets", () => {
  const random = createRandom(32);
  for (let round = 0; round < 150; round++) {
    const frameWidth = 1 + Math.floor(random() * 4),
      frameHeight = 1 + Math.floor(random() * 4),
      across = 1 + Math.floor(random() * 4),
      down = 1 + Math.floor(random() * 3),
      width = frameWidth * across,
      height = frameHeight * down,
      colors = Array.from({ length: width * height }, () =>
        rgba(
          Math.floor(random() * 6) * 40,
          Math.floor(random() * 3) * 90,
          7,
          [0, 1, 128, 255][Math.floor(random() * 4)],
        ),
      ),
      pixels = image(width, height, colors),
      columns = 1 + Math.floor(random() * across),
      options = {
        frameWidth,
        frameHeight,
        columns,
        frameCount: 1 + Math.floor(random() * columns * down),
        axis: ['x', 'y', 'z'][round % 3],
        topToBottom: random() < 0.5,
        alphaThreshold: [1, 2, 129][Math.floor(random() * 3)],
      },
      ours = stackSlices(pixels, options),
      theirs = studioStack(pixels, options);
    assert.deepEqual(ours.grid.size, theirs.size);
    assert.deepEqual(ours.grid.voxels, theirs.voxels);
    assert.deepEqual(
      Array.from({ length: 256 }, (_, i) => hex(ours.palette, i)),
      theirs.palette,
    );
  }
});

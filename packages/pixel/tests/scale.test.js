// Node checks of @margoengine/pixel/scale: the fitted rectangle and the CPU Scale2x, against values worked out by hand,
// and option errors. The GPU pass itself is proved by scale-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitRect, PixelScale, scale2x } from '../dist/scale.js';

test('fitRect: the limiting side fills the view, the other keeps the shape rounded down, centred', () => {
  // 7 x 5 in 23 x 17: 23 / 7 = 3.29 limits (17 / 5 = 3.4), so 23 x floor(5 * 23 / 7) = 23 x 16, one row to spare.
  assert.deepEqual(fitRect(7, 5, 23, 17), [0, 0, 23, 16]);
  // 320 x 180 in 1366 x 768: 768 / 180 = 4.27 limits, so floor(320 * 768 / 180) = 1365 wide, 0 left over on the left.
  assert.deepEqual(fitRect(320, 180, 1366, 768), [0, 0, 1365, 768]);
  // 160 x 90 in 1000 x 1000: width limits, 90 * 1000 / 160 = 562.5 rounds down to 562, (1000 - 562) / 2 = 219 above.
  assert.deepEqual(fitRect(160, 90, 1000, 1000), [0, 219, 1000, 562]);
  assert.deepEqual(fitRect(160, 90, 1000, 1000, 'stretch'), [0, 0, 1000, 1000]);
});

const image = (width, height, rows) => {
  const colors = { '.': [0, 0, 0, 255], '#': [255, 255, 255, 255], r: [255, 0, 0, 255] },
    data = new Uint8Array(width * height * 4);
  rows
    .join('')
    .split('')
    .forEach((c, i) => data.set(colors[c], i * 4));
  return { width, height, data };
};
const rows = ({ width, height, data }) => {
  const out = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const v = data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
      line += v[0] === 255 && v[1] === 255 ? '#' : v[0] === 255 ? 'r' : '.';
    }
    out.push(line);
  }
  return out;
};

test('scale2x rounds a diagonal step and leaves flat areas and lone dots as plain doubles', () => {
  // A 45 degree line, worked out texel by texel: the middle texel stays whole (its four neighbours are all dark), and
  // each dark texel beside the line fills the corner between its two white neighbours, so the middle rows become a
  // solid stair three wide. At the map's edge the repeated edge texels make the end caps lose one corner each.
  assert.deepEqual(rows(scale2x(image(3, 3, ['#..', '.#.', '..#']))), [
    '##....',
    '#.#...',
    '.###..',
    '..###.',
    '...#.#',
    '....##',
  ]);
  // A lone dot: every neighbour matches its opposite too, so nothing changes.
  assert.deepEqual(rows(scale2x(image(3, 3, ['...', '.r.', '...']))), [
    '......',
    '......',
    '..rr..',
    '..rr..',
    '......',
    '......',
  ]);
  assert.deepEqual(rows(scale2x(image(2, 1, ['##']))), ['####', '####']);
});

test('bad options are refused', () => {
  assert.throws(() => new PixelScale({}), TypeError);
  assert.throws(() => new PixelScale({ source: {}, filter: 'blur' }), RangeError);
  assert.throws(() => new PixelScale({ source: {}, order: Number.NaN }), RangeError);
  assert.throws(() => scale2x({ width: 2, height: 2, data: new Uint8Array(4) }), RangeError);
});

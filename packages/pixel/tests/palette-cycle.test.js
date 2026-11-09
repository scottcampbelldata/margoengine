// Node checks of palette cycling and mixing in @margoengine/pixel/palette, against values worked out by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cyclePalette, mixPalettes, PaletteQuantize } from '../dist/palette.js';

const PALETTE = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffffff'];

test('a run rotates by rate * seconds whole entries, wrapping inside it; other entries stay', () => {
  const cycle = { from: 1, to: 3, rate: 2 };
  assert.deepEqual(cyclePalette(PALETTE, [cycle], 0), PALETTE);
  // Shift 1: entry 1 shows what started one before it in the run (entry 3, wrapped), 2 shows 1, 3 shows 2.
  assert.deepEqual(cyclePalette(PALETTE, [cycle], 0.5), ['#000000', '#0000ff', '#ff0000', '#00ff00', '#ffffff']);
  // Shift 3 is a whole turn of the 3-entry run; 0.7 s is shift 1.4, still a step of 1 without blending.
  assert.deepEqual(cyclePalette(PALETTE, [cycle], 1.5), PALETTE);
  assert.deepEqual(cyclePalette(PALETTE, [cycle], 0.7), cyclePalette(PALETTE, [cycle], 0.5));
  // Below 0 the colours run the other way: entry 1 shows entry 2.
  assert.deepEqual(cyclePalette(PALETTE, [{ ...cycle, rate: -2 }], 0.5), [
    '#000000',
    '#00ff00',
    '#0000ff',
    '#ff0000',
    '#ffffff',
  ]);
});

test('blending mixes the two entries a step lies between in Oklab', () => {
  // Black (L = 0) to white (L = 1) halfway: L = 0.5 is linear grey 0.5^3 = 0.125, sRGB 1.055 * 0.125^(1/2.4) - 0.055
  // = 0.3886, 99.1 of 255 = 0x63.
  const run = ['#000000', '#ffffff'];
  assert.deepEqual(cyclePalette(run, [{ from: 0, to: 1, rate: 1, blend: true }], 0.5), ['#636363', '#636363']);
  assert.deepEqual(mixPalettes(['#000000'], ['#ffffff'], 0.5), ['#636363']);
  assert.deepEqual(mixPalettes(PALETTE, PALETTE.slice().reverse(), 0), PALETTE);
  assert.deepEqual(mixPalettes(PALETTE, PALETTE.slice().reverse(), 1), PALETTE.slice().reverse());
});

test('bad cycles, mixes and swaps are refused', () => {
  assert.throws(() => cyclePalette(PALETTE, [{ from: 2, to: 2, rate: 1 }], 0), RangeError);
  assert.throws(() => cyclePalette(PALETTE, [{ from: 3, to: 5, rate: 1 }], 0), RangeError);
  assert.throws(() => cyclePalette(PALETTE, [{ from: 0, to: 2, rate: Number.NaN }], 0), RangeError);
  assert.throws(
    () =>
      cyclePalette(
        PALETTE,
        [
          { from: 0, to: 2, rate: 1 },
          { from: 2, to: 4, rate: 1 },
        ],
        0,
      ),
    /must not share entry 2/,
  );
  assert.throws(() => cyclePalette(PALETTE, [], Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => mixPalettes(PALETTE, ['#000000'], 0.5), RangeError);
  assert.throws(() => mixPalettes(PALETTE, PALETTE, 1.5), RangeError);
  const pass = new PaletteQuantize({ palette: PALETTE, source: {}, target: {} });
  assert.throws(() => pass.setSwap(['#000000']), /as many colours/);
  pass.setSwap(PALETTE.slice().reverse());
});

test('large finite cycle shifts preserve the permutation before subtracting small indices', () => {
  for (const rate of [1e20, -1e20, 1e308, -1e308])
    for (const blend of [false, true]) {
      const cycle = { from: 1, to: 3, rate, blend };
      assert.deepEqual(cyclePalette(PALETTE, [cycle], 1), cyclePalette(PALETTE, [{ ...cycle, rate: rate % 3 }], 1));
      assert.deepEqual(cyclePalette(PALETTE, [cycle], 0), PALETTE);
    }
});

test('cycle product overflow throws a coded error with help for either blend direction', () => {
  for (const rate of [1e308, -1e308])
    for (const blend of [false, true])
      assert.throws(
        () => cyclePalette(PALETTE, [{ from: 1, to: 3, rate, blend }], 2),
        (error) =>
          error.code === 'state' && /finite|overflow/.test(error.message) && /errors#pixel-palette/.test(error.message),
      );
});

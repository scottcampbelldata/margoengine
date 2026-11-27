// The images behind tests/fixtures/jpeg-libjpeg-turbo/ and the cjpeg arguments each file was made with. The generator
// and the tests compute the same samples, so a lossless file needs no stored reference.

/**
 * `width * height * components` samples of `precision` bits: smooth ramps, so prediction matters, with noise from a
 * fixed sequence, and pairs of samples half the range apart, which at 16 bits need difference category 16.
 */
export function image({ width = 37, height = 23, components = 1, precision, smooth = false }) {
  const max = 2 ** precision - 1,
    data = new Uint16Array(width * height * components);
  let state = 2463534242;
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < components; c++, i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const ramp = (x / width) * (c === 1 ? 0.3 : 0.6) + (y / height) * (c === 2 ? 0.1 : 0.35),
          noise = ((state >>> 8) / 2 ** 24) * (smooth ? 0.04 : 0.9);
        data[i] = Math.floor(((ramp + noise) % 1) * max);
      }
  if (!smooth && data.length >= (width * 3 + 8) * components) {
    // Neighbours at the ends of the range and half of it apart.
    const half = 2 ** (precision - 1);
    data.set([0, half, 0, max, 0, half - 1, max, half], width * 3 * components);
  }
  return { width, height, components, precision, data };
}

const lossless = (precision, selection, transform = 0, more = {}, restart) => ({
  precision,
  transform,
  ...more,
  args: ['-lossless', `${selection},${transform}`, ...(restart ? ['-restart', restart] : [])],
});
const dct = (precision, args, more = {}) => ({ precision, smooth: true, ...more, args: ['-quality', '92', ...args] });

export const cases = {
  // Every selection value of T.81 Table H.1.
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((p) => [`grey8-sv${p}`, lossless(8, p)])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((p) => [`grey16-sv${p}`, lossless(16, p)])),
  'grey2-sv1': lossless(2, 1),
  'grey10-sv4-restart': lossless(10, 4, 0, {}, '1'),
  'grey12-sv7-point2': lossless(12, 7, 2),
  'grey12-sv6-restart': lossless(12, 6, 0, {}, '3'),
  'grey16-sv5-point5-restart': lossless(16, 5, 5, {}, '2'),
  'grey8-one-column': lossless(8, 4, 0, { width: 1, height: 19 }),
  'grey8-one-row': lossless(8, 7, 0, { width: 53, height: 1 }),
  'rgb8-sv1': lossless(8, 1, 0, { components: 3 }),
  'rgb8-sv5-restart': lossless(8, 5, 0, { components: 3 }, '4'),
  'rgb12-sv2-point1': lossless(12, 2, 1, { components: 3 }),
  'rgb16-sv6': lossless(16, 6, 0, { components: 3 }),
  // 12-bit DCT: extended sequential and progressive.
  'dct12-grey': dct(12, []),
  'dct12-grey-restart': dct(12, ['-restart', '2'], { width: 61, height: 45 }),
  'dct12-grey-progressive': dct(12, ['-progressive'], { width: 61, height: 45 }),
  'dct12-grey-q100': dct(12, ['-quality', '100'], { smooth: false }),
  'dct12-rgb': dct(12, ['-rgb'], { components: 3 }),
  'dct12-ycbcr-420': dct(12, ['-sample', '2x2'], { components: 3, width: 64, height: 48 }),
  'dct12-ycbcr-444-progressive': dct(12, ['-sample', '1x1', '-progressive'], { components: 3, width: 40, height: 24 }),
};

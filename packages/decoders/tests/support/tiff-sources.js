// Deterministic source images for the libtiff fixtures (tests/generate-tiff-libtiff.mjs) and the tests that compare
// against them.

/** A small linear congruential generator, so the images never change. */
const random = (seed) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 2 ** 24;

/**
 * A 2,700 x 40 bilevel image, one sample per pixel (1 is black under WhiteIsZero): shapes that stay put from row to
 * row (vertical and pass modes), runs at the 64 and 1,728 make-up edges, a black run past 2,560 (a repeated make-up
 * code), rows starting black, single-pixel stripes, and all-white and all-black rows.
 */
export function bilevel() {
  const width = 2700,
    height = 40,
    next = random(7),
    samples = new Array(width * height).fill(0),
    paint = (y, from, to) => {
      for (let x = Math.max(0, from); x < Math.min(width, to); x++) samples[y * width + x] = 1;
    };
  const boxes = Array.from({ length: 40 }, () => {
    const x = Math.floor(next() * width),
      y = Math.floor(next() * height);
    return [x, y, x + 1 + Math.floor(next() * 90), y + 1 + Math.floor(next() * 12)];
  });
  for (let y = 0; y < height; y++) {
    for (const [x0, y0, x1, y1] of boxes) if (y >= y0 && y < y1) paint(y, x0 + (y & 3), x1 - (y % 5));
    if (y === 3) paint(y, 0, width);
    if (y === 5) paint(y, 0, 1);
    if (y === 9) paint(y, 10, 10 + 2600);
    if (y === 11) for (let x = 0; x < width; x += 2) paint(y, x, x + 1);
    if (y === 13) paint(y, 64, 128), paint(y, 1792, 1792 + 1728);
    if (y === 17) samples.fill(0, y * width, (y + 1) * width);
    if (y >= 20 && y < 30) paint(y, 300 + y, 900 - y), paint(y, 2000 - 3 * y, 2004 + 3 * y);
    if (y === 31) for (let x = 0; x < width; x++) if (next() < 0.3) paint(y, x, x + 1);
  }
  return { width, height, samples };
}

/** `width` x `height` pixels of `spp` 8-bit samples: smooth ramps with a little noise, different per sample. */
export function colour(width, height, spp) {
  const next = random(11 + spp),
    samples = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < spp; c++) {
        const ramp = [x / width, y / height, (x + y) / (width + height), 1 - x / width][c % 4];
        samples.push(Math.min(255, Math.max(0, Math.round(255 * ramp + (next() - 0.5) * 24))));
      }
  return samples;
}

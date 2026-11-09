// The flat pixels of a mirror against its reference, for scripts/env-mirror-gpu-check.js at 4x MSAA.
//
// At 1x the mirror equals the scene reflected in the mirror plane to one 8-bit step at every pixel, edges included. At
// 4x it cannot at edges, for two reasons that hold for any correct mirror:
// 1. The capture camera is a proper camera (the main camera reflected in the plane, its up reflected and its handedness
//    kept), so the captured picture is the reflected scene flipped left to right, and the mirror flips it back. The
//    WebGPU 4x sample positions, (3/8, 1/8), (7/8, 3/8), (1/8, 5/8), (5/8, 7/8), are not symmetric under that flip:
//    flipped they are (5/8, 1/8), (1/8, 3/8), (7/8, 5/8), (3/8, 7/8), a different set, so a straight edge through a
//    pixel can cover one sample more or fewer in the capture than in the reference (never more than one).
// 2. The capture resolves its samples in linear HDR; a main pass without post-processing resolves them in the canvas
//    format after encoding. Averages of the same samples taken before and after a curve differ wherever the samples
//    differ, which is only at edges.
// Measured on the Radeon 680M (2026-11-08): flat pixels match to one step, every difference over 4 sits at an edge, and
// the mirror against the scene from the reflected camera, flipped back, with post-processing on (both causes gone) has
// p99 0. A p99 over flat and edge pixels together depends on how many pixels are edges (285 of 28374 channel values
// over 4 in the orthographic view, p99 5; 261 of 26739 in the perspective one, p99 4), so it passed or failed with the
// geometry, not the mirror. The check therefore holds flat pixels to rounding against the reflected scene and every
// pixel to the usual bounds against that mirror view.

/** Channel difference (in 8-bit steps) at or below which a 3x3 reference neighbourhood counts as flat. */
export const FLAT = 2;

/**
 * Compares `image` with `reference` over the pixels of `mask` (1 = compare) whose 3x3 neighbourhood in `reference` is
 * flat: every channel within {@link FLAT} steps. Images are `{ pixels }` with RGBA8 values, `width` x `height`.
 * Returns `{ pixels, max }`: how many such pixels, and the largest channel difference among them.
 */
export function compareFlat(image, reference, mask, width, height) {
  const a = image.pixels,
    r = reference.pixels,
    result = { pixels: 0, max: 0 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let flat = true;
      for (let c = 0; flat && c < 3; c++) {
        let low = 255,
          high = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(width - 1, Math.max(0, x + dx)),
              ny = Math.min(height - 1, Math.max(0, y + dy)),
              v = r[(ny * width + nx) * 4 + c];
            low = Math.min(low, v);
            high = Math.max(high, v);
          }
        flat = high - low <= FLAT;
      }
      if (!flat) continue;
      result.pixels++;
      for (let c = 0; c < 3; c++) result.max = Math.max(result.max, Math.abs(a[i * 4 + c] - r[i * 4 + c]));
    }
  return result;
}

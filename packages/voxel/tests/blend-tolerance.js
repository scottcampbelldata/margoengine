// The one place where a voxel GPU check allows a pixel difference: 1 ulp on blended views at 4x MSAA, and nowhere else.
//
// Why: on the RTX A6000 (Dawn D3D12, driver 32.0.16.1742) the GPU's blend unit now and then reads the 4x colour
// target's destination samples differently from one frame to the next at partly covered pixels, so a frame can differ
// from the previous identical frame by 1 unit in 8 bits (1 ulp on rgba16float). Margo hands the GPU the same bytes every
// frame; the cause, the repro and what is still open are in docs/known-bugs.md, "4x MSAA blending is not repeatable on
// the RTX A6000 under CPU load". Everything else (1x views, unblended views, other checks) stays exact.
//
// Shared by render-browser-check.html (in the page) and blend-tolerance.test.js (in Node), so the rule is tested.

/** Largest per-channel difference allowed on a blended 4x view: 1 unit in 8 bits, or 1 half-float ulp on HDR data. */
export const BLENDED_4X_MAX_CHANNEL_DIFF = 1;

/**
 * The tolerance for one view: `BLENDED_4X_MAX_CHANNEL_DIFF` when the view blends (translucent layer in view) and the
 * scene is drawn at 4x MSAA, otherwise 0 (exact).
 * @param {{samples: number, blended: boolean}} view
 * @returns {number}
 */
export const toleranceFor = ({ samples, blended }) => (samples === 4 && blended ? BLENDED_4X_MAX_CHANNEL_DIFF : 0);

/** One half-float (rgba16float) ulp at the magnitude of `x`. */
export function halfUlp(x) {
  const m = Math.abs(x);
  return m < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(m)) - 10);
}

/**
 * Compares two RGBA images. A pixel differs when a channel is further apart than `tolerance`: 8-bit units for byte
 * images, half-float ulps (at the larger of the two values) for Float32Array HDR images. Reports the pixels that differ
 * at that tolerance and, always, at tolerance 0 (`strictDiffering`, `strictBlocks`), so a run shows both.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number[]} bg background RGB in the same units; pixels equal to it in `b` are not "lit"
 * @param {number} width image width in pixels
 * @param {number} [tolerance] maximum per-channel difference that still counts as equal (default 0, exact)
 */
export function compareImages(a, b, bg, width, tolerance = 0) {
  const hdr = a instanceof Float32Array,
    n = a.length / 4,
    diff = new Uint8Array(n),
    strict = new Uint8Array(n),
    at = [];
  let differing = 0,
    strictDiffering = 0,
    lit = 0,
    max = 0;
  for (let p = 0; p < a.length; p += 4) {
    let d = 0,
      over = false;
    for (let c = 0; c < 4; c++) {
      const e = Math.abs(a[p + c] - b[p + c]);
      d = Math.max(d, e);
      if (e > tolerance * (hdr ? halfUlp(Math.max(Math.abs(a[p + c]), Math.abs(b[p + c]))) : 1)) over = true;
    }
    const nan = !Object.is(a[p], b[p]) && d === 0;
    if (d > 0 || nan) {
      strictDiffering++;
      strict[p / 4] = 1;
    }
    if (over || nan) {
      differing++;
      diff[p / 4] = 1;
      if (at.length < 8)
        at.push([(p / 4) % width, Math.floor(p / 4 / width), [...a.slice(p, p + 4)], [...b.slice(p, p + 4)]]);
    }
    max = Math.max(max, d);
    if (Math.abs(b[p] - bg[0]) + Math.abs(b[p + 1] - bg[1]) + Math.abs(b[p + 2] - bg[2]) > 0) lit++;
  }
  const blocksOf = (m) => {
    let blocks = 0;
    for (let i = 0; i < n - width - 1; i++)
      if (m[i] && m[i + 1] && m[i + width] && m[i + width + 1] && (i + 1) % width) blocks++;
    return blocks;
  };
  return {
    differing,
    lit,
    pixels: n,
    max,
    blocks: blocksOf(diff),
    at,
    tolerance,
    strictDiffering,
    strictBlocks: blocksOf(strict),
  };
}

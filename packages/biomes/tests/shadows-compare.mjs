// The pixel comparison of the biomes shadows check (shadows-check.html), apart so Node can test it without a GPU.
// Frames are RGBA float arrays read back from the scene texture, row by row.

/** Rec. 709 luminance of each RGBA pixel. */
export function luma(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let k = 0; k < out.length; k++)
    out[k] = 0.2126 * rgba[k * 4] + 0.7152 * rgba[k * 4 + 1] + 0.0722 * rgba[k * 4 + 2];
  return out;
}

/**
 * Compares a frame drawn with shadows against the same scene drawn without them. `first` and `again` are two frames
 * without shadows, each from a view built from scratch: `control` counts the values in which they differ, and only when
 * it is 0 can a pixel that changes in `shadowed` be put down to the shadows. `darker` is the share of pixels at least 20
 * percent darker with shadows; `brighter` counts pixels past 1 percent brighter (the shadowed shader is compiled apart,
 * so unshadowed pixels may round differently), `bright` lists up to 12 of them as [x, y, without, with]; `lit` is the
 * share of pixels brighter than 0.002 without shadows.
 */
export function compareShadows(first, again, shadowed, width) {
  if (
    first.length !== again.length ||
    first.length !== shadowed.length ||
    first.length % 4 ||
    (first.length / 4) % width
  )
    throw new RangeError('compareShadows needs three RGBA frames of the same size, whole rows of `width` pixels');
  let control = 0;
  for (let k = 0; k < first.length; k++) if (!Object.is(first[k], again[k])) control++;
  const a = luma(first),
    b = luma(shadowed),
    bright = [];
  let darker = 0,
    brighter = 0,
    lit = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] > 0.002) lit++;
    if (b[k] < a[k] * 0.8) darker++;
    if (b[k] > a[k] * 1.01 + 1e-4) {
      brighter++;
      if (bright.length < 12) bright.push([k % width, Math.floor(k / width), a[k], b[k]]);
    }
  }
  return { pixels: a.length, control, darker: darker / a.length, brighter, bright, lit: lit / a.length };
}

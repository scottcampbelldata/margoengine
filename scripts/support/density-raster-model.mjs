// The pixel and opacity rules behind the density comparison with regl-scatterplot and deck.gl
// (docs/sciviz-density.md). Pure functions with no imports, so Node tests and the browser probe share them. Window
// coordinates are in pixels from the top left corner, y down.
//
// Sources: OpenGL ES 3.0.6 (Khronos, 2019, https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf) 3.4.1
// (a point covers the pixel centres inside its square), 2.1.6.2 (float to unsigned normalized may round to either
// neighbour) and 4.1.7 (blending); Direct3D 11 rasterization rules (Microsoft,
// https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d10-graphics-programming-guide-rasterizer-stage-rules)
// (a point is a one pixel square drawn with the top-left rule). The 1/256 pixel grid, its ties and which side of a
// boundary wins are measured from outside on one device, not taken from a specification.

/** Nearest 1/256 pixel, ties to the even step. */
export function snapSubpixel(value) {
  const steps = value * 256,
    low = Math.floor(steps),
    rest = steps - low;
  return (rest > 0.5 || (rest === 0.5 && low % 2 !== 0) ? low + 1 : low) / 256;
}

/** The pixel Margo's density raster counts a point in: the one containing the unsnapped position. */
export function containingPixel(x, y) {
  return [Math.floor(x), Math.floor(y)];
}

/**
 * The pixel a one pixel square point lights on the measured device: the position snaps to 1/256 pixel, then the
 * top-left rule gives a point on a vertical boundary to the pixel on its left and a point on a horizontal boundary to
 * the pixel below it.
 */
export function squarePointPixel(x, y) {
  return [Math.ceil(snapSubpixel(x)) - 1, Math.floor(snapSubpixel(y))];
}

/** A one pixel disc: the square point's pixel, lit only if its centre is within half a pixel of the snapped point. */
export function discPointPixel(x, y) {
  const pixel = squarePointPixel(x, y),
    dx = pixel[0] + 0.5 - snapSubpixel(x),
    dy = pixel[1] + 0.5 - snapSubpixel(y);
  return dx * dx + dy * dy <= 0.25 ? pixel : null;
}

/** The output byte of `count` coincident white marks of opacity `alpha` over black, composited without rounding. */
export function exactOverByte(count, alpha) {
  return Math.round(255 * (1 - (1 - alpha) ** count));
}

/** The same marks blended one by one into an 8-bit target that rounds each result to the nearest byte. */
export function unorm8OverByte(count, alpha) {
  let byte = 0;
  for (let i = 0; i < count; i++) {
    const next = Math.round(byte + alpha * (255 - byte));
    if (next === byte) break;
    byte = next;
  }
  return byte;
}

/** The coverage rule, opacity and accumulation law measured for each rival in the comparison's configuration. */
export const RIVAL_RULES = {
  'regl-scatterplot': { pixel: squarePointPixel, alpha: 0.08, blend: exactOverByte },
  'deck.gl': { pixel: discPointPixel, alpha: 20 / 255, blend: unorm8OverByte },
};

/**
 * How many probe observations of a rival its rules fail to predict. `stacks` holds [count, byte] for coincident
 * marks; `sweep` holds [x offset, y offset, lit pixel offsets] for single marks inside pixel (0, 0).
 */
export function checkProbes(name, stacks, sweep) {
  const rules = RIVAL_RULES[name];
  const stackMisses = stacks.filter(([count, byte]) => rules.blend(count, rules.alpha) !== byte).length;
  const sweepMisses = sweep.filter(([x, y, lit]) => {
    const at = rules.pixel(x, y);
    return JSON.stringify(lit) !== JSON.stringify(at ? [at] : []);
  }).length;
  return { stacks: stacks.length, stackMisses, sweep: sweep.length, sweepMisses };
}

/** Differences between two single channel images: mean and largest byte difference, pixels more than 2 apart. */
export function compareBytes(a, b) {
  if (a.length !== b.length || !a.length) throw new RangeError('compareBytes needs two images of one non-zero size');
  let sum = 0,
    max = 0,
    above2 = 0,
    differing = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
    if (d > 2) above2++;
    if (d) differing++;
  }
  return { mean: sum / a.length, max, above2, differing };
}

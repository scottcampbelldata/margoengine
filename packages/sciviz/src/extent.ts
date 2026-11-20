// The data range sciviz fits axes and colour maps to.

/**
 * Min and max of the finite values of CPU data; [0, 1] when there are none. NaN and infinities are skipped: an
 * infinite value has no place on an axis, and as a colour map's end it pushed every finite value to one end colour.
 */
export function extent(data: ArrayLike<number>): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

/**
 * Extents of each coordinate of interleaved xyz positions, finite values only ([0, 1] for a coordinate with none). A
 * data value past the largest float32 is infinite once stored, and fitting an axis to it left nothing drawable.
 */
export function positionBounds(p: Float32Array): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (!Number.isFinite(v)) continue;
      if (v < b[k * 2]) b[k * 2] = v;
      if (v > b[k * 2 + 1]) b[k * 2 + 1] = v;
    }
  for (let k = 0; k < 3; k++) if (!(b[k * 2] <= b[k * 2 + 1])) [b[k * 2], b[k * 2 + 1]] = [0, 1];
  return b;
}

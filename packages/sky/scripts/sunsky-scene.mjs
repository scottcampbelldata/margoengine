/** Y-up directions; sampling is a declared grid, not a full-hemisphere integral. */
export function direction(elevation, azimuth = 0) {
  const e = (elevation * Math.PI) / 180,
    a = (azimuth * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}

/** Swap Y/Z for Mitsuba's documented Z-up sunsky coordinate frame. */
export const toZUp = ([x, y, z]) => [x, z, y];

export function skyCases() {
  const directions = [5, 15, 30, 60, 90].flatMap((e) =>
    (e === 90 ? [0] : [0, 45, 90, 135, 180, 225, 270, 315]).map((a) => direction(e, a)),
  );
  return [10, 45, 75].flatMap((elevation) =>
    [2, 3, 6].map((turbidity) => ({
      elevation,
      turbidity,
      sun: direction(elevation),
      directions,
    })),
  );
}

const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Compare angular RGB radiance after independently normalizing each sky by its zenith Y.
 * Margo's artistic luminance units are not Mitsuba's physical radiometric units.
 */
export function radianceError(ours, reference) {
  if (ours.length !== reference.length || ours.length === 0) throw new Error('radiance layout mismatch');
  const a = luminance(ours.at(-1)),
    b = luminance(reference.at(-1));
  if (!(a > 0 && b > 0)) throw new Error('nonpositive zenith radiance');
  let abs = 0,
    max = 0,
    sum = 0;
  for (let i = 0; i < ours.length; i++)
    for (let c = 0; c < 3; c++) {
      if (!Number.isFinite(ours[i][c]) || !Number.isFinite(reference[i][c])) throw new Error('nonfinite radiance');
      const d = Math.abs(ours[i][c] / a - reference[i][c] / b);
      abs += d;
      max = Math.max(max, d);
      sum += Math.abs(reference[i][c] / b);
    }
  return { mae: abs / (ours.length * 3), relative: abs / sum, max, margoZenithY: a, mitsubaZenithY: b };
}

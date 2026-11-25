// Display-linear CPU oracle of Grade's ranges, written from the README's formula, independent of the package's code.
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
  clamp = (x) => Math.min(1, Math.max(0, x)),
  smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

/** The fully saturated RGB of a hue in degrees, by the six sectors of the HSV hexcone. */
function pure(hue) {
  const sector = Math.floor(hue / 60) % 6,
    up = (hue / 60) % 1,
    down = 1 - up;
  return [
    [1, up, 0],
    [down, 1, 0],
    [0, 1, up],
    [0, down, 1],
    [up, 0, 1],
    [1, 0, down],
  ][sector];
}

export function rangesOracle(input, ranges) {
  const l = luma(input),
    low = 1 - smooth(0, 0.5, l),
    high = smooth(0.5, 1, l);
  const parts = [
    [ranges.shadows, low],
    [ranges.midtones, 1 - low - high],
    [ranges.highlights, high],
  ];
  const gain = [0, 0, 0];
  let saturation = 0;
  for (const [range, weight] of parts) {
    let s = weight;
    const g = [weight, weight, weight];
    for (const r of [ranges.global ?? {}, range ?? {}]) {
      const tint = pure(r.hue ?? 0),
        y = luma(tint);
      for (let k = 0; k < 3; k++) g[k] *= 2 ** (r.exposure ?? 0) * (1 + (r.density ?? 0) * (tint[k] - y));
      s *= r.saturation ?? 1;
    }
    for (let k = 0; k < 3; k++) gain[k] += g[k];
    saturation += s;
  }
  const t = input.map((x, k) => clamp(x * gain[k])),
    y = luma(t);
  return t.map((x) => clamp(y + (x - y) * saturation));
}

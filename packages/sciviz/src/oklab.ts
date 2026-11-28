// OKLab (Ottosson 2020), on its own so entries that only blend colours do not pull in the colormap tables.

/** OKLab of a linear-light sRGB colour (Ottosson 2020). */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear-light sRGB of an OKLab colour (Ottosson 2020); may fall outside [0, 1]. */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A colour ramp through OKLab stops: `parse` checks the stops once, `sample` maps t in [0, 1] to linear rgb. */
export interface OklabRamp {
  sample(t: number, out: Float32Array | number[], at: number): void;
}

/** Stops are `#rrggbb` or sRGB `[r, g, b]` in 0 to 1; `what` names the caller in the error. */
export function oklabRamp(colors: readonly (string | readonly number[])[], what: string): OklabRamp {
  const stops = (colors ?? []).map((c) => {
    const rgb = typeof c === 'string' && /^#[\da-f]{6}$/i.test(c)
      ? [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16) / 255)
      : Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ? c : null;
    if (!rgb) throw new RangeError(`${what} colours must be #rrggbb or [r, g, b] in 0 to 1`);
    return linearToOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
  });
  if (stops.length < 2) throw new RangeError(`${what} colours need at least two colours`);
  return {
    sample(t, out, at) {
      const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1),
        j = Math.min(stops.length - 2, Math.floor(x)),
        f = x - j,
        a = stops[j],
        b = stops[j + 1],
        rgb = oklabToLinear(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      out[at] = Math.max(0, rgb[0]);
      out[at + 1] = Math.max(0, rgb[1]);
      out[at + 2] = Math.max(0, rgb[2]);
    },
  };
}

/** The IEC 61966-2-1 sRGB transfer, encoded to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

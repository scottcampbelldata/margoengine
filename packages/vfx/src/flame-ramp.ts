// The blackbody colour of a flame and its colour ramp, shared by the flame volume of `@margoengine/vfx/flame` and the
// flame rows of `@margoengine/vfx/settings` (sources: flame.ts and docs/clean-room.md "Flame volumes": Planck 1901,
// Wyman, Sloan and Shirley 2013, Nguyen, Fedkiw and Jensen 2002).

/** The brightest channel a flame pixel may show, scene-linear (1 is the display's white at the exposure of the scene). */
export const FLAME_PEAK = 1;
/** Stops of {@link flameRamp}, fractions of a hearth flame's life. */
const STOPS = [0, 0.12, 0.25, 0.4, 0.6, 0.8, 1] as const;

// ---------------------------------------------------------------------------------------------------------------
// Blackbody colour
// ---------------------------------------------------------------------------------------------------------------

const C2 = 1.438776877e-2; // h c / k, m K
const lobe = (l: number, mu: number, s1: number, s2: number): number => {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};
/** The CIE 1931 colour matching functions at a wavelength in nanometres (Wyman, Sloan and Shirley 2013). */
function matching(l: number): [number, number, number] {
  return [
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8),
  ];
}
const kelvinIn = (kelvin: number): number => {
  if (!(Number.isFinite(kelvin) && kelvin >= 500 && kelvin <= 40000))
    throw new RangeError(`Blackbody temperature is ${kelvin}; pass kelvin from 500 to 40000`);
  return kelvin;
};
/** The XYZ of a blackbody at `kelvin`, in the units of the spectral radiance integrated over 360 to 830 nm. */
export function blackbodyXYZ(kelvin: number): [number, number, number] {
  let x = 0,
    y = 0,
    z = 0;
  for (let l = 360; l <= 830; l += 5) {
    const m = l * 1e-9,
      radiance = 1 / (m ** 5 * Math.expm1(C2 / (m * kelvin))),
      [a, b, c] = matching(l);
    x += radiance * a;
    y += radiance * b;
    z += radiance * c;
  }
  return [x, y, z];
}
/**
 * The CIE 1931 chromaticity `[x, y]` of a blackbody (Planck's law through the Wyman fits of the observer).
 * @throws RangeError for a temperature outside 500 to 40,000 K.
 * @example blackbodyChromaticity(2000); // [0.527, 0.413]
 */
export function blackbodyChromaticity(kelvin: number): [number, number] {
  const [x, y, z] = blackbodyXYZ(kelvinIn(kelvin)),
    s = x + y + z;
  return [x / s, y / s];
}
/**
 * The luminance of a blackbody at `kelvin` relative to one at `reference` (the Y of Planck's law over the observer's
 * luminous efficiency): it falls by a factor of thousands from 1,900 K to 1,000 K, which a camera's exposure cannot hold.
 */
export function blackbodyLuminanceRatio(kelvin: number, reference: number): number {
  return blackbodyXYZ(kelvinIn(kelvin))[1] / blackbodyXYZ(kelvinIn(reference))[1];
}
/**
 * The luminous efficacy of a blackbody's radiation at `kelvin`, lumens per radiant watt: 683 lm/W times Planck's
 * spectral radiance weighted by the photopic curve (the Wyman fit of y-bar, 360 to 830 nm), over the total radiance
 * sigma T^4 / pi (Stefan-Boltzmann). About 0.5 lm/W at 1,760 K (a flame's radiating soot), 16 at 2,856 K (CIE
 * illuminant A), 55 at 4,000 K and 95 at 7,000 K, the published blackbody efficacies.
 * @throws RangeError for a temperature outside 500 to 40,000 K.
 * @example blackbodyLuminousEfficacy(4000); // about 54.8
 */
export function blackbodyLuminousEfficacy(kelvin: number): number {
  const t = kelvinIn(kelvin);
  let y = 0;
  for (let l = 360; l <= 830; l++) {
    const m = l * 1e-9;
    y += (1.191042972e-16 / (m ** 5 * Math.expm1(C2 / (m * t)))) * matching(l)[1] * 1e-9;
  }
  return (683 * y) / ((5.670374419e-8 * t ** 4) / Math.PI);
}
/**
 * The linear sRGB colour of a blackbody at `kelvin`, scaled so its largest channel is 1 and negative channels (colours
 * outside the sRGB gamut, the blues of a cool flame) cut to 0.
 * @throws RangeError for a temperature outside 500 to 40,000 K.
 * @example blackbodyColor(1500); // [1, 0.32, 0]
 */
export function blackbodyColor(kelvin: number): [number, number, number] {
  const [x, y, z] = blackbodyXYZ(kelvinIn(kelvin)),
    rgb = [
      3.2406 * x - 1.5372 * y - 0.4986 * z,
      -0.9689 * x + 1.8758 * y + 0.0415 * z,
      0.0557 * x - 0.204 * y + 1.057 * z,
    ].map((v) => Math.max(v, 0)),
    top = Math.max(...rgb);
  return rgb.map((v) => v / top) as [number, number, number];
}

// ---------------------------------------------------------------------------------------------------------------
// The colour ramp
// ---------------------------------------------------------------------------------------------------------------

/** What {@link flameRamp} takes; every field has a default. */
export interface FlameRampOptions {
  /** Temperature of the hot core where a flame is born, kelvin, 800 to 3000. Default 2200 (a `Flame`; 2600 in `flameRamp`) (the colour a luminous wood flame looks, once the eye and a camera's white balance have moved a 1,500 K blackbody toward warm white). */
  core?: number;
  /** Temperature at the end of a flame's life, the cool edge, kelvin, 600 to the core. Default 1000 (glowing soot). */
  edge?: number;
  /** How fast the flame cools: T(t) = edge + (core - edge) (1 - t)^cooling, 0.2 to 5. Default 1.2. */
  cooling?: number;
  /**
   * How much of the blackbody's luminance fall is kept, 0 to 1: a stop shows (L(T) / L(core))^exposure of the peak, as
   * an exposure maps the flame's radiance (Nguyen et al. 2002). 0 keeps every stop at the peak (no ramp in
   * brightness), 1 is the physical fall, which is black at the edge. Default 0.3.
   */
  exposure?: number;
  /** The brightest channel any stop may show, scene-linear, above 0. Default {@link FLAME_PEAK}. */
  peak?: number;
}
/** One stop of a colour ramp: the fraction of the particle's life and its linear RGB. */
export interface FlameStop {
  at: number;
  color: [number, number, number];
}
export const rampIn = (v: number, name: string, min: number, max: number): number => {
  if (!(Number.isFinite(v) && v >= min && v <= max))
    throw new RangeError(`Flame ramp ${name} is ${v}; pass a finite number from ${min} to ${max}`);
  return v;
};
/**
 * The colour of a flame over its life, from the core's temperature to the edge's: each stop is the blackbody colour of
 * its temperature, as bright as the exposure keeps it, and none passes `peak`, so the volume has a clear core-to-edge
 * ramp and cannot blow out. Seven stops (the colour curve holds eight).
 * @throws RangeError for an option out of range.
 */
export function flameRamp(options: FlameRampOptions = {}): FlameStop[] {
  const core = rampIn(options.core ?? 2600, 'core', 800, 3000),
    edge = rampIn(options.edge ?? 1000, 'edge', 600, core),
    cooling = rampIn(options.cooling ?? 1.2, 'cooling', 0.2, 5),
    exposure = rampIn(options.exposure ?? 0.3, 'exposure', 0, 1),
    peak = rampIn(options.peak ?? FLAME_PEAK, 'peak', 1e-6, 1000),
    top = blackbodyXYZ(core)[1];
  return STOPS.map((at) => {
    const kelvin = edge + (core - edge) * (1 - at) ** cooling,
      scale = peak * Math.min(1, (blackbodyXYZ(kelvin)[1] / top) ** exposure);
    return { at, color: blackbodyColor(kelvin).map((v) => v * scale) as [number, number, number] };
  });
}

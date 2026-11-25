// Cloud types from a weather state, and the light a cloud deck passes: CPU only, so a panel, a test or a film's timeline
// can read them without a GPU.
//
// Sources: Schneider, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine", SIGGRAPH Advances in
// Real-Time Rendering 2017 (cloud types by height and coverage); WMO International Cloud Atlas (cumulus bases about
// 1,000 to 2,500 m, stratus 300 to 900 m, cumulonimbus up to 8,000 m and more); Bohren, "Multiple scattering of light
// and some of its observable consequences", Am. J. Phys. 55(6), 1987 (two-stream transmission of a thick cloud, below);
// Meador and Weaver, "Two-stream approximations to radiative transfer in planetary atmospheres", J. Atmos. Sci. 37,
// 1980 (the same bound, T = 1 / (1 + tau (1 - g) / 2)).

/** What a weather state tells the clouds: the weather package's `cloud`, `rain` and `lightning`, each 0 to 1. */
export interface CloudWeather {
  /** Share of the sky under cloud, 0 to 1. */
  readonly cloud: number;
  /** Rain, 0 to 1. Default 0. */
  readonly rain?: number;
  /** Lightning, 0 to 1. Default 0. */
  readonly lightning?: number;
}
/**
 * A cloud type to force: fair-weather cumulus, stratus, the storm's cumulonimbus, or a hurricane's deck (eyewall, bands
 * and canopy, 500 to 15,000 m, shaped by `VolumetricClouds`' `hurricane` option; see {@link cloudLayerFor}).
 */
export type CloudType = 'cumulus' | 'stratus' | 'storm' | 'hurricane';
/** The layer values a weather gives: the {@link VolumetricCloudOptions} `coverage`, `bottom`, `top` and `density`. */
export interface CloudLayer {
  readonly coverage: number;
  /** Cloud base above the ground, metres. */
  readonly bottom: number;
  /** Cloud tops above the ground, metres. */
  readonly top: number;
  /** Extinction per metre inside the densest cloud. */
  readonly density: number;
}
/** The three types the layer blends: fair-weather cumulus, stratus and the storm's cumulonimbus. */
export interface CloudTypeWeights {
  readonly cumulus: number;
  readonly stratus: number;
  readonly storm: number;
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const unit = (value: number | undefined, name: string): number => {
  const v = value ?? 0;
  if (!(v >= 0 && v <= 1)) throw new RangeError(`Invalid cloud weather ${name}; pass a number from 0 to 1.`);
  return v;
};
// The three weights, written into `w` without allocating (the clouds' deck hook calls it every frame).
function weightsInto(
  weather: CloudWeather,
  w: { cumulus: number; stratus: number; storm: number },
  type?: CloudType,
): void {
  if (type !== undefined) {
    w.cumulus = type === 'cumulus' ? 1 : 0;
    w.stratus = type === 'stratus' ? 1 : 0;
    w.storm = type === 'storm' ? 1 : 0;
    return;
  }
  const cloud = unit(weather.cloud, 'cloud'),
    storm = Math.max(unit(weather.rain, 'rain'), unit(weather.lightning, 'lightning')) * smooth(0.3, 0.7, cloud),
    stratus = (1 - storm) * smooth(0.55, 0.85, cloud);
  w.cumulus = 1 - storm - stratus;
  w.stratus = stratus;
  w.storm = storm;
}
const scratchWeights = { cumulus: 1, stratus: 0, storm: 0 };
/**
 * How much of each cloud type a weather has. Rain or lightning makes a storm; otherwise a sky over 55 to 85 percent
 * cloud is stratus, and the rest is fair-weather cumulus. The three weights add up to 1.
 * @throws RangeError for a `cloud`, `rain` or `lightning` outside 0 to 1.
 * @example cloudTypeWeights({ cloud: 1 }); // { cumulus: 0, stratus: 1, storm: 0 }
 */
export function cloudTypeWeights(weather: CloudWeather): CloudTypeWeights {
  const w = { cumulus: 1, stratus: 0, storm: 0 };
  weightsInto(weather, w);
  return w;
}
/** A {@link CloudLayer} whose fields can be written: the out value of {@link cloudLayerFor}. */
export type MutableCloudLayer = { -readonly [K in keyof CloudLayer]: CloudLayer[K] };
/**
 * The layer a weather gives, the three types blended by {@link cloudTypeWeights}: fair cumulus (cover up to half the
 * sky, base 1,000 to tops 2,500 m, extinction 0.03 a metre), stratus (cover as `cloud`, 300 to 900 m, 0.08) and storm
 * (all of the sky, 600 to 8,000 m, 0.1). Extinction follows the liquid water of the type (0.02 to 0.1 a metre).
 * `VolumetricClouds` takes it from its `weather` option for each of `coverage`, `bottom`, `top` and `density` left unset.
 * `out`, when given, receives the values and is returned (no allocation). `type` forces one type whatever the weather
 * says (its `cloud` still sets the stratus cover and caps the cumulus cover at a half).
 * `'hurricane'` gives the hurricane deck: all cover, 500 to 15,000 m, 0.1 a metre (the storm field draws the eye and
 * bands inside it).
 * @throws RangeError for a `cloud`, `rain` or `lightning` outside 0 to 1, or a `type` that is not one of the four.
 * @example cloudLayerFor({ cloud: 1, rain: 0.9, lightning: 0.8 }); // the storm deck, 600 to 8,000 m
 * @example cloudLayerFor({ cloud: 0.7 }, undefined, 'storm'); // a storm deck under a part-cloudy forecast
 */
export function cloudLayerFor(
  weather: CloudWeather,
  out: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
  type?: CloudType,
): CloudLayer {
  if (type !== undefined && type !== 'cumulus' && type !== 'stratus' && type !== 'storm' && type !== 'hurricane')
    throw new RangeError(`Invalid cloud type ${String(type)}; pass 'cumulus', 'stratus', 'storm' or 'hurricane'.`);
  if (type === 'hurricane') {
    unit(weather.cloud, 'cloud');
    unit(weather.rain, 'rain');
    unit(weather.lightning, 'lightning');
    // The hurricane's deck: base 500 m in the moist boundary layer, tops near the tropopause at 15 km (Houze 2010,
    // "Clouds in tropical cyclones", Mon. Wea. Rev. 138), the storm's density; the storm field shapes the cover.
    out.coverage = 1;
    out.bottom = 500;
    out.top = 15000;
    out.density = 0.1;
    return out;
  }
  const w = scratchWeights;
  weightsInto(weather, w, type);
  const cloud = weather.cloud;
  out.coverage = w.cumulus * Math.min(cloud, 0.5) + w.stratus * cloud + w.storm;
  out.bottom = w.cumulus * 1000 + w.stratus * 300 + w.storm * 600;
  out.top = w.cumulus * 2500 + w.stratus * 900 + w.storm * 8000;
  out.density = w.cumulus * 0.03 + w.stratus * 0.08 + w.storm * 0.1;
  return out;
}
/** The scattering asymmetry of cloud droplets the two-stream bound uses. */
const G = 0.85;
/**
 * The share of the light a cloud of vertical optical depth `tau` passes, by the two-stream bound
 * T = 1 / (1 + tau (1 - g) / 2) with g = 0.85 (Meador and Weaver 1980; Bohren 1987): 0.73 at tau 5, 0.4 at 20, 0.14 at
 * 80. It is the diffuse light under a thick cloud over the light above it; the base of a thick cloud is dark and
 * flat, its top bright.
 * @throws RangeError for a `tau` below 0.
 */
export function cloudTransmission(tau: number): number {
  if (!(tau >= 0)) throw new RangeError('Invalid optical depth; pass 0 or more.');
  return 1 / (1 + (tau * (1 - G)) / 2);
}
/**
 * The share of a light the deck passes to the ground: the sky not covered passes all of it, the covered part passes
 * {@link cloudTransmission} of the layer's optical depth along the light, `density` times the layer's thickness times
 * 0.35 (the mean of the density profile) over `up`, the sine of the light's elevation (at least 0.1, as a low light
 * crosses a flat layer in a long slant). 1 when the light is on or below the horizon (nothing to dim).
 * @example cloudDeckTransmittance({ coverage: 1, bottom: 300, top: 900, density: 0.08 }, 1); // 0.44
 */
export function cloudDeckTransmittance(layer: CloudLayer, up: number): number {
  if (!(up > 0) || !(layer.coverage > 0)) return 1;
  const tau = (layer.density * (layer.top - layer.bottom) * 0.35) / Math.max(0.1, Math.min(1, up));
  return 1 - layer.coverage + layer.coverage * cloudTransmission(tau);
}

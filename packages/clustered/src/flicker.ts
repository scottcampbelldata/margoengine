import type { EngineKernel } from '@margoengine/core';
import type { PointLight, SpotLight } from './index.js';
import { blackbodyColor } from '@margoengine/math/color';
import type { Vec3 } from '@margoengine/math';

/** A named flicker shape, or your own: seconds in, a brightness scale of 0 or more out. */
export type FlickerCurve = 'candle' | 'fire' | 'fluorescent' | 'pulse' | 'strobe' | ((time: number) => number);
/** How one light flickers. */
export interface FlickerOptions {
  /** Default `'candle'`. */
  curve?: FlickerCurve;
  /** Multiplies time. Default 1. */
  speed?: number;
  /** Keeps lights with one curve out of step. Default: the light's place in the list. */
  seed?: number;
}
/**
 * What `animateFlicker` sets the lights on: a `Clustered`, or one group of a `LightGroups`
 * (`@margoengine/clustered/groups`) so other lights on the same `Clustered` stay as they are.
 */
export interface FlickerTarget {
  setLights(lights: readonly (PointLight | SpotLight)[]): unknown;
  /** True once the target is disposed (`Clustered`, `LightGroup`): the flicker then sets nothing on it. */
  readonly isDisposed?: boolean;
}
/** A light with its flicker; a light without one keeps its intensity. */
export type FlickerLight = (PointLight | SpotLight) & { flicker?: FlickerOptions };

// Value noise from 0 to 1, smooth between whole numbers.
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
function noise(x: number): number {
  const i = Math.floor(x),
    f = x - i;
  return hash(i) + (hash(i + 1) - hash(i)) * f * f * (3 - 2 * f);
}
/**
 * The brightness scale of a flicker curve at `time` seconds, the same every time for one seed. Named curves stay
 * within 0 to 1.
 * @throws TypeError for an unknown curve.
 * @throws RangeError when your own curve returns a negative or non-finite value.
 */
export function flickerAt(curve: FlickerCurve, time: number, seed = 0): number {
  const at = time + seed * 17.3;
  if (typeof curve === 'function') {
    const value = curve(time);
    if (!(value >= 0 && Number.isFinite(value)))
      throw new RangeError('Invalid flicker curve result; return a finite brightness of 0 or more');
    return value;
  }
  switch (curve) {
    case 'candle':
      return 0.8 + 0.2 * (0.7 * noise(at * 7) + 0.3 * noise(at * 19));
    case 'fire':
      return 0.5 + 0.5 * (0.6 * noise(at * 4) + 0.4 * noise(at * 11));
    case 'fluorescent':
      return hash(Math.floor(at * 12)) > 0.9 ? 0.15 : 1;
    case 'pulse':
      return 0.5 + 0.5 * Math.sin(at * 2 * Math.PI);
    case 'strobe':
      return at - Math.floor(at) < 0.1 ? 1 : 0;
    default:
      throw new TypeError(
        'Invalid flicker curve; use candle, fire, fluorescent, pulse, strobe or a function of seconds',
      );
  }
}
/**
 * Mean brightness scale of the flame curves over time: `'candle'` is 0.8 + 0.2 x value noise and `'fire'` 0.5 + 0.5 x
 * value noise, and value noise averages 0.5, so 0.9 and 0.75. A flickering light of intensity I gives I x mean on
 * average, which is what a photometer measures of a real flame.
 */
export const flameFlickerMean: { readonly candle: number; readonly fire: number } = Object.freeze({
  candle: 0.9,
  fire: 0.75,
});
/** {@link flameLight} options. */
export interface FlameLightOptions {
  /** Colour temperature in Kelvin, 1,667 to 25,000 (`blackbodyColor` from `@margoengine/math/color`). */
  kelvin: number;
  /** Luminous flux in lumens, 0 or more, averaged over the flicker, spread evenly over 4 pi sr. */
  lumens: number;
  /** The light's range in metres, above 0 (`PointLight` `range`). */
  range: number;
  /** Flicker curve, `'candle'` (default) or `'fire'`. */
  curve?: 'candle' | 'fire';
  /** Flicker speed. Default 1. */
  speed?: number;
  /** Flicker seed. Default 0. */
  seed?: number;
  /**
   * The flame's size, metres, 0 or more: half its width across, as `PointLight.radius` takes it (a sphere light, and the
   * default `shadow.radius`, so `LocalShadows` gives its shadows the penumbra a flame that wide casts). Default 0, a
   * point with hard shadows.
   */
  radius?: number;
}
/** A flame as a point light without its position: spread it into a `PointLight` and give `animateFlicker` the result. */
export interface FlameLight {
  readonly color: Vec3;
  readonly intensity: number;
  readonly range: number;
  /** The flame's half width, metres (`PointLight.radius`): 0 is a point. */
  readonly radius: number;
  readonly flicker: { readonly curve: 'candle' | 'fire'; readonly speed: number; readonly seed: number };
}
/**
 * A flame's light from what can be measured of it: its colour from its colour temperature (a blackbody's, linear sRGB
 * with its largest channel 1) and its intensity so that, averaged over its flicker ({@link flameFlickerMean}), it
 * gives `lumens / 4 pi` candela, Margo's point-light unit (`@margoengine/clustered/units`).
 * @throws RangeError for a temperature outside 1,667 to 25,000 K, negative or non-finite lumens, a range not above 0,
 * a negative or non-finite radius, or an unknown curve.
 */
export function flameLight(options: FlameLightOptions): FlameLight {
  const { kelvin, lumens, range, curve = 'candle', speed = 1, seed = 0, radius = 0 } = options;
  if (
    !(lumens >= 0 && Number.isFinite(lumens)) ||
    !(range > 0 && Number.isFinite(range)) ||
    !(radius >= 0 && Number.isFinite(radius)) ||
    !(curve in flameFlickerMean)
  )
    throw new RangeError(
      'Invalid flame light; give lumens of 0 or more, a range above 0, a radius of 0 or more and the candle or fire curve.',
    );
  const color = blackbodyColor(kelvin) as unknown as Vec3,
    y = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  return Object.freeze({
    color,
    intensity: lumens / (4 * Math.PI) / (y * flameFlickerMean[curve]),
    range,
    radius,
    flicker: Object.freeze({ curve, speed, seed }),
  });
}
/**
 * A kerosene hurricane lantern, measured. Colour: a kerosene wick flame is about 1,900 K (tabulated correlated colour
 * temperature of a candle or kerosene flame; measured kerosene flames range 1,580 to 2,290 K: S. Tatsuta,
 * "Quantitative Determination of Flame Color Based on Correlated Color Temperature and Its Application in Spray
 * Flames", Trans. JSME B 72(720), 2006, doi:10.1299/kikaib.72.1875). Light: 82 lm, the brightest kerosene hurricane
 * lantern measured on a goniophotometer by E. Mills, "Technical and Economic Performance Analysis of Kerosene Lamps
 * and Alternative Approaches to Illumination in Developing Countries", Lawrence Berkeley National Laboratory, 2003
 * (a 22 mm flat wick in a clean globe; 6.5 cd spread over 4 pi sr; a 12 mm wick gave 48 lm). Flicker: `'candle'` at
 * speed 0.6. Range: 18 m, where the light's window (1 - (d / range)^4)^2 keeps 0.99 of the inverse square within
 * 4.9 m and 0.91 at 8.3 m, so it does not cut the light short where it still shows. Size: with a clear globe (the
 * default) the light comes from the flame, as wide as its flat wick, 22 mm (Mills 2003, the same lantern), so `radius`
 * is {@link HURRICANE_FLAME_RADIUS}, 11 mm. A shadow edge a distance d_o from the flame lands on a receiver at d_r with
 * a penumbra 2 x 0.011 x (d_r - d_o) / d_o wide across a vertical edge (similar triangles; the PCSS estimate of
 * Fernando, "Percentage-Closer Soft Shadows", SIGGRAPH 2005 sketches): 8 cm on the snow 3.5 m from the lantern behind a
 * window jamb 1 m from it. As a point (radius 0, until 2026-11-16) its window threw hard-edged light on the snow
 * (KB-CABIN-GROUNDEDGE1). `globe: 'frosted'` or `'sooted'`: a frosted globe scatters the flame's light, and soot on
 * the glass does too, so the light leaves from the whole globe; `radius` is then {@link HURRICANE_GLOBE_RADIUS}, about
 * six times the flame's, and every shadow edge is that much softer. Soot also dims the light by an amount that
 * depends on the soot; that is left to `flameLight`'s `lumens`.
 * @example
 * const lantern = {position: [0, 1.2, 0], ...hurricaneLantern()};
 * const stop = animateFlicker(engine, clustered, [lantern]);
 * const softer = hurricaneLantern({globe: 'frosted'}); // radius 0.065 m
 */
export function hurricaneLantern(options: { seed?: number; globe?: 'clear' | 'frosted' | 'sooted' } = {}): FlameLight {
  const globe = options.globe ?? 'clear';
  if (globe !== 'clear' && globe !== 'frosted' && globe !== 'sooted')
    throw new RangeError("Invalid hurricane lantern globe; give 'clear', 'frosted' or 'sooted'.");
  return flameLight({
    kelvin: 1900,
    lumens: 82,
    range: 18,
    curve: 'candle',
    speed: 0.6,
    seed: options.seed ?? 0,
    radius: globe === 'clear' ? HURRICANE_FLAME_RADIUS : HURRICANE_GLOBE_RADIUS,
  });
}
/** Half the width of a hurricane lantern's flame, metres: its 22 mm flat wick (Mills, LBNL 2003) over 2. */
export const HURRICANE_FLAME_RADIUS = 0.011;
/**
 * Radius of the sphere that stands in for a lit hurricane-lantern globe, metres: the sphere with the globe's side-on
 * area. The globe of the Dietz No. 2 Blizzard, the classic hurricane lantern for a 7/8 inch (22 mm) wick, is 6 3/4 in
 * (171 mm) tall, 3 3/8 in (86 mm) across its base and 2 3/4 in (70 mm) across its top (Lehman's, "Clear Globes for
 * Dietz Blizzard Lanterns", replacement globe dimensions), so side on it covers 0.171 x (0.086 + 0.070) / 2 =
 * 0.01334 m^2, a disc of radius sqrt(0.01334 / pi) = 0.065 m.
 */
export const HURRICANE_GLOBE_RADIUS = 0.065;
/**
 * What a flame looks like, not what it lights: the surface that draws it glows at the light's own radiance, its
 * luminous intensity over its projected area. Spread it into an emissive material, `UnlitMaterial` of
 * `@margoengine/materials` (`emissive` the light's colour, `emissiveIntensity` the radiance per unit of it), and give
 * that material to `animateFlicker` as the light's emitter so it flickers with the light.
 */
export interface FlameEmission {
  /** The light's colour, linear sRGB with its largest channel 1. */
  readonly emissive: Vec3;
  /** Radiance per unit of `emissive` at the light's steady intensity: `intensity / area`, so cd/m2 over luminance. */
  readonly emissiveIntensity: number;
}
/**
 * The radiance a light's flame shows: its intensity over the flame's projected area, by default that of the sphere the
 * light is (`pi radius^2`, the area a sphere light of that radius shows from every side, so the flame is as bright as
 * the light it gives, and as bright as its highlights on a mirror). A hurricane lantern's 6.5 cd over its 11 mm flame
 * (Mills, LBNL 2003) is 6.5 / (pi 0.011^2) = 17,000 cd/m2 averaged over its flicker. Draw the flame with the same
 * projected area: an ellipsoid with semi-axes `a` across and `b` up shows `pi a b` from the side. A light colour above
 * 1 (one of luminance 1, say) comes back scaled to a top channel of 1 with the scale in `emissiveIntensity`, since a
 * material's emissive colour is in [0, 1]; the radiance, colour times intensity, is the same.
 * @example
 * const lantern = {position: [0, 1.2, 0], ...hurricaneLantern()};
 * const flame = new UnlitMaterial({color: [0, 0, 0], ...flameEmission(lantern)});
 * const stop = animateFlicker(engine, clustered, [lantern], {emitters: [flame]});
 * @throws RangeError for a light without a positive radius when no area is given, an area not above 0, or a negative
 * or non-finite intensity.
 */
export function flameEmission(
  light: { readonly color: Vec3 | readonly number[]; readonly intensity: number; readonly radius?: number },
  area = Math.PI * (light.radius ?? 0) ** 2,
): FlameEmission {
  if (!(area > 0 && Number.isFinite(area)) || !(light.intensity >= 0 && Number.isFinite(light.intensity)))
    throw new RangeError(
      'Invalid flame emission; give a light with a radius above 0 (or an area above 0, m2) and an intensity of 0 or more.',
    );
  // A material's emissive colour is in [0, 1]; a light colour may be above 1 (a colour of luminance 1, say), so the
  // colour is scaled to a top channel of 1 and the scale moves into the intensity: the radiance is unchanged.
  const top = Math.max(light.color[0], light.color[1], light.color[2]),
    scale = top > 0 ? top : 1;
  return Object.freeze({
    emissive: [light.color[0] / scale, light.color[1] / scale, light.color[2] / scale] as Vec3,
    emissiveIntensity: (light.intensity * scale) / area,
  });
}
/** A surface that flickers with a light: anything with a live `emissiveIntensity`, such as a materials `Material`. */
export interface FlickerEmitter {
  emissiveIntensity: number;
}
/** {@link animateFlicker} options. */
export interface AnimateFlickerOptions {
  /**
   * The surface each light shows, by the light's place in the list (undefined for none): its `emissiveIntensity` is
   * scaled by the light's flicker every frame, as the light's intensity is, and put back when the flicker stops.
   */
  emitters?: readonly (FlickerEmitter | undefined)[];
}
/**
 * Sets `lights` on `clustered` (a `Clustered` or a light group) and scales their intensities, and the emissive
 * intensities of their `emitters`, by their flicker curves every frame, on the CPU, with one `setLights` a frame.
 * Returns a function that stops it and puts the steady intensities back.
 */
export function animateFlicker(
  engine: EngineKernel,
  clustered: FlickerTarget,
  lights: readonly FlickerLight[],
  options: AnimateFlickerOptions = {},
): () => void {
  const live = lights.map((light) => ({ ...light })),
    emitters = options.emitters ?? [],
    steady = emitters.map((emitter) => emitter?.emissiveIntensity ?? 0);
  if (emitters.length > lights.length) throw new RangeError('Invalid flicker emitters; give at most one per light.');
  let time = 0;
  const apply = () => {
    // A target disposed before the flicker stops (its scene or engine went first) has nothing left to light.
    if (clustered.isDisposed) return;
    lights.forEach((light, i) => {
      if (light.flicker) {
        const { curve = 'candle', speed = 1, seed = i } = light.flicker,
          scale = flickerAt(curve, time * speed, seed),
          emitter = emitters[i];
        live[i].intensity = (light.intensity ?? 1) * scale;
        if (emitter) emitter.emissiveIntensity = steady[i] * scale;
      }
    });
    clustered.setLights(live);
  };
  apply();
  const stop = engine.onFrame((_, delta) => {
    time += delta;
    apply();
  });
  return () => {
    stop();
    emitters.forEach((emitter, i) => {
      if (emitter) emitter.emissiveIntensity = steady[i];
    });
    if (!clustered.isDisposed) clustered.setLights(lights);
  };
}

// Physical light units for Margo's lights, as plain conversions (no GPU, no state). Margo's light intensities already are
// photometric quantities, the convention of glTF's KHR_lights_punctual that gltf-pro's `applyGLTFLights` passes through
// unchanged: a point or spot light's `intensity` is luminous intensity in candela (lm/sr), a directional light's (core's sun,
// `@margoengine/clustered/directional`) is illuminance in lux (lm/m^2) on a surface facing it, and a rectangle area light's
// is luminance in nits (cd/m^2). The renderer's linear output is then luminance in nits; `exposureFromEV100` scales it for
// display. Formulas: luminous flux is intensity integrated over solid angle; illuminance at normal incidence falls with the
// square of distance; a Lambertian emitter of luminance L and area A emits pi L A lumens per side.

/** The cone of a spot light, as `SpotLight` takes it: `outerAngle` with an optional `innerAngle`, or `angle` with `penumbra`. */
export interface SpotCone {
  outerAngle?: number;
  innerAngle?: number;
  angle?: number;
  penumbra?: number;
}
/** What an IES profile (`@margoengine/clustered/ies`) contributes: its peak candela and its total flux in lumens. */
export interface PhotometricProfile {
  readonly peak: number;
  readonly flux: number;
}

const positive = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new RangeError(`${label} must be a finite number of 0 or more`);
  return value;
};
/**
 * Solid angle (steradians) a light of uniform intensity spreads its flux over: 4 pi for a point light; for a spot, the
 * cone with its smooth edge, 2 pi (1 - (cos outer + cos inner) / 2). The edge is a smoothstep in the cosine, which
 * integrates to half its width, so this is exact for clustered's cone, hard edge (inner = outer) included.
 */
export function lightSolidAngle(cone?: SpotCone): number {
  if (cone === undefined) return 4 * Math.PI;
  if (typeof cone !== 'object' || cone === null)
    throw new TypeError('A spot cone is an object: {outerAngle, innerAngle?} or {angle, penumbra?}');
  const outer = cone.angle ?? cone.outerAngle,
    inner = cone.angle !== undefined ? cone.angle * (1 - (cone.penumbra ?? 0)) : (cone.innerAngle ?? 0);
  if (
    typeof outer !== 'number' ||
    !(outer > 0 && outer <= Math.PI / 2) ||
    !(inner >= 0 && inner <= outer) ||
    (cone.angle !== undefined && cone.outerAngle !== undefined)
  )
    throw new RangeError('Spot cone: outer angle in (0, pi/2] radians, inner (or penumbra) inside it, one form only');
  return 2 * Math.PI * (1 - (Math.cos(outer) + Math.cos(inner)) / 2);
}
/**
 * Candela of a point light (no `shape`), a spot light (its cone) or a profiled light (an IES profile: the peak intensity
 * for that flux) that emits `lumens`. Point and spot lights take the result as `intensity`; so does an IES-profiled one.
 */
export function lumensToCandela(lumens: number, shape?: SpotCone | PhotometricProfile): number {
  positive(lumens, 'Lumens');
  if (shape && 'flux' in shape) {
    if (!(shape.flux > 0 && shape.peak >= 0))
      throw new RangeError('A profile needs a flux above 0 and a peak of 0 or more');
    return (lumens * shape.peak) / shape.flux;
  }
  return lumens / lightSolidAngle(shape);
}
/** Lumens emitted by a point light (no `shape`), spot light or profiled light of `candela` intensity (the inverse). */
export function candelaToLumens(candela: number, shape?: SpotCone | PhotometricProfile): number {
  positive(candela, 'Candela');
  if (shape && 'flux' in shape) {
    if (!(shape.peak > 0 && shape.flux >= 0))
      throw new RangeError('A profile needs a peak above 0 and a flux of 0 or more');
    return (candela * shape.flux) / shape.peak;
  }
  return candela * lightSolidAngle(shape);
}
/** Lux on a surface facing a point or spot light of `candela` at `distance` metres (inverse square, normal incidence). */
export function candelaToLux(candela: number, distance: number): number {
  positive(candela, 'Candela');
  if (!(positive(distance, 'Distance') > 0)) throw new RangeError('Distance must be above 0');
  return candela / (distance * distance);
}
/** Candela a point or spot light needs for `lux` on a surface facing it at `distance` metres. */
export function luxToCandela(lux: number, distance: number): number {
  positive(lux, 'Lux');
  positive(distance, 'Distance');
  return lux * distance * distance;
}
/**
 * Lumens a rectangle area light of `nits` luminance emits over `width` x `height` metres: pi L A per emitting side (a
 * Lambertian emitter), twice that when `twoSided`.
 */
export function nitsToLumens(nits: number, width: number, height: number, twoSided = false): number {
  return positive(nits, 'Nits') * Math.PI * positive(width, 'Width') * positive(height, 'Height') * (twoSided ? 2 : 1);
}
/** Luminance (nits) for a rectangle area light that emits `lumens` over `width` x `height` metres (the inverse). */
export function lumensToNits(lumens: number, width: number, height: number, twoSided = false): number {
  const area = positive(width, 'Width') * positive(height, 'Height');
  if (!(area > 0)) throw new RangeError('Area light width and height must be above 0');
  return positive(lumens, 'Lumens') / (Math.PI * area * (twoSided ? 2 : 1));
}
/**
 * Candela of a point light matching a rectangle area light of `nits` over `width` x `height` metres seen face on from
 * far away (luminance times area): how `@margoengine/clustered/area` relates the two.
 */
export function nitsToCandela(nits: number, width: number, height: number): number {
  return positive(nits, 'Nits') * positive(width, 'Width') * positive(height, 'Height');
}
// EV = log2(N^2 / t) at ISO 100: ISO 2720.
/** Exposure value at ISO 100 of a camera with f-number `aperture`, `shutter` seconds and `iso` sensitivity. */
export function ev100(aperture: number, shutter: number, iso = 100): number {
  if (!(aperture > 0 && shutter > 0 && iso > 0) || ![aperture, shutter, iso].every(Number.isFinite))
    throw new RangeError('Aperture, shutter and ISO must be finite numbers above 0');
  return Math.log2(((aperture * aperture) / shutter) * (100 / iso));
}
/**
 * The factor that maps scene luminance (nits) to display values for an exposure of `ev` at ISO 100: 1 / (1.2 x 2^ev).
 * The luminance that saturates an ISO 100 sensor at that exposure (saturation-based speed, ISO 12232: 78 / (100 x 0.65)
 * x 2^ev, about 1.2 x 2^ev) maps to 1. Multiply the lights by it (`Clustered.intensityScale`, core's sun strength) to
 * render physical units.
 */
export function exposureFromEV100(ev: number): number {
  if (typeof ev !== 'number' || !Number.isFinite(ev)) throw new RangeError('EV100 must be a finite number');
  return 1 / (1.2 * 2 ** ev);
}

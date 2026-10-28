// Named, checked setters over core's packed light arrays, typed angles, and a sky that lights the scene.
// Lives in @margoengine/sky (not core or stage, which are frozen): the sun's angles and the sky's own sunlight are here.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { SkyLightingOptions, SkyOptions } from './base.js';

const toRadians = Math.PI / 180;

/**
 * An angle that knows its unit. Make one with {@link degrees} or {@link radians}; read it back with `.degrees` or
 * `.radians`. It is not a number: arithmetic or `Number(angle)` throws a TypeError, so a radians value can never be
 * read as degrees by accident. In a template string it prints as `35deg`.
 */
export class Angle {
  /** The angle in degrees. */
  readonly degrees: number;
  /** The angle in radians. */
  readonly radians: number;
  /** Use {@link degrees} or {@link radians} instead. */
  private constructor(degrees: number, radians: number) {
    this.degrees = degrees;
    this.radians = radians;
    Object.freeze(this);
  }
  /** @internal */
  static from(value: number, unit: 'degrees' | 'radians'): Angle {
    if (!Number.isFinite(value)) throw new RangeError(`Invalid angle ${value}; pass a finite number of ${unit}.`);
    return unit === 'degrees' ? new Angle(value, value * toRadians) : new Angle(value / toRadians, value);
  }
  /** Throws a TypeError for numeric use; a string hint gives `<degrees>deg`. */
  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'string') return `${this.degrees}deg`;
    throw new TypeError('An Angle is not a number; read angle.degrees or angle.radians.');
  }
}

/**
 * An angle in degrees.
 * @throws RangeError when `value` is not finite.
 * @example const elevation = degrees(35);
 */
export function degrees(value: number): Angle {
  return Angle.from(value, 'degrees');
}

/**
 * An angle in radians, for values that come from `Math.atan2` and friends.
 * @throws RangeError when `value` is not finite.
 * @example const elevation = radians(Math.atan2(y, x));
 */
export function radians(value: number): Angle {
  return Angle.from(value, 'radians');
}

/** True for an {@link Angle} made by {@link degrees} or {@link radians}. */
export function isAngle(value: unknown): value is Angle {
  return value instanceof Angle;
}

/** What {@link setSun} and {@link setAmbient} write: an `Engine` (its active scene) or a `Scene`. */
export interface LightingTarget {
  readonly lighting: { direction: Float32Array; radiance: Float32Array; ambient?: Float32Array };
  /** Checked for a sky that drives this light every frame, so a setter never writes a value the sky overwrites. */
  readonly plugins?: ReadonlyMap<string, unknown>;
}

/**
 * Sun options for {@link setSun}. Give the direction either as `direction` or as `azimuth` with `elevation`, not both.
 * An option left out keeps the light's current value; core's defaults are direction [3, 5, 4], white, intensity 3.
 */
export interface SunOptions {
  /** World-space vector toward the sun, any non-zero length. Default (core's): [3, 5, 4]. */
  direction?: Vec3;
  /** Compass angle around +Y, from +Z toward +X: `degrees(0)` is +Z, `degrees(90)` is +X. Needs `elevation`. */
  azimuth?: Angle;
  /** Height above the horizon, `degrees(-90)` to `degrees(90)`; `degrees(90)` is straight up. Needs `azimuth`. */
  elevation?: Angle;
  /** Linear RGB sun colour, each component >= 0. Default (core's): [1, 1, 1]. */
  color?: Vec3;
  /** Sun strength, >= 0; scales the colour. Default (core's): 3. */
  intensity?: number;
}

/** The sun as {@link getSun} reads it: a unit direction toward the sun, its colour and its strength. */
export interface SunLight {
  direction: Vec3;
  color: Vec3;
  intensity: number;
}

/**
 * Ambient options for {@link setAmbient}. The light every surface gets from all sides is `color * intensity` times its
 * base colour. An option left out keeps the current value; core's defaults are white and 0.15.
 */
export interface AmbientOptions {
  /** Linear RGB tint, each component >= 0. Default (core's): [1, 1, 1]. */
  color?: Vec3;
  /** Ambient strength, >= 0. Default (core's): 0.15. */
  intensity?: number;
}

/** The ambient light as {@link getAmbient} reads it. */
export interface AmbientLight {
  color: Vec3;
  intensity: number;
}

const strength = (value: unknown, name: string): number => {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number.`);
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid ${name} ${value}; use a finite number >= 0.`);
  return value;
};

const vector = (value: unknown, name: string, positive: boolean): Vec3 => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value))
    throw new TypeError(`${name} must be an array of 3 numbers.`);
  const v = value as ArrayLike<unknown>;
  if (v.length !== 3 || ![0, 1, 2].every((i) => typeof v[i] === 'number'))
    throw new TypeError(`${name} must be an array of 3 numbers.`);
  const out = [v[0], v[1], v[2]] as Vec3;
  if (out.some((c) => !Number.isFinite(c)) || (positive && out.some((c) => c < 0)))
    throw new RangeError(`Invalid ${name}; use finite components${positive ? ' of 0 or more' : ''}.`);
  return out;
};

const angle = (value: unknown, name: string): Angle => {
  if (!isAngle(value))
    throw new TypeError(`${name} must be an Angle; wrap the number as degrees(${String(value)}) or radians(...).`);
  return value;
};

/** The sky on this target whose options drive the given part of its light, if any. */
const drivingSky = (target: LightingTarget, ambient: boolean): string | undefined => {
  for (const [name, plugin] of target.plugins ?? []) {
    const options = (plugin as { options?: { lighting?: SkyLightingOptions; environment?: boolean } }).options;
    if (typeof options !== 'object' || options === null) continue;
    if (ambient ? options.lighting?.ambient || options.environment : options.lighting) return name;
  }
  return undefined;
};

const lightingOf = (target: LightingTarget) => {
  const lighting = (target as Partial<LightingTarget> | null)?.lighting;
  if (
    !lighting ||
    !(lighting.direction instanceof Float32Array) ||
    lighting.direction.length !== 4 ||
    !(lighting.radiance instanceof Float32Array) ||
    lighting.radiance.length !== 4
  )
    throw new TypeError('Pass an Engine or a Scene: an object with lighting.direction and lighting.radiance.');
  return lighting;
};

/**
 * The unit direction toward the sun for typed angles, with the same convention as `sunDirectionFromAngles`.
 * @throws TypeError when either angle is not an {@link Angle}; RangeError when the elevation is outside -90..90 degrees.
 * @example const toSun = sunDirectionFrom(degrees(135), degrees(35));
 */
export function sunDirectionFrom(azimuth: Angle, elevation: Angle): Vec3 {
  const az = angle(azimuth, 'azimuth').radians,
    el = angle(elevation, 'elevation');
  if (Math.abs(el.degrees) > 90) throw new RangeError(`Invalid elevation ${el}; use -90 to 90 degrees.`);
  const c = Math.cos(el.radians);
  return [Math.sin(az) * c, Math.sin(el.radians), Math.cos(az) * c];
}

/**
 * Sets the scene's sun (core's directional light) with named options; see {@link SunOptions} for the defaults.
 * Writes `lighting.direction` (xyz, w = intensity) and `lighting.radiance` (rgb = colour); every value is checked
 * before anything is written, so a bad call changes nothing.
 * @returns The sun after the change, as {@link getSun} reads it.
 * @throws TypeError for a wrong shape, a plain number as an angle, or `direction` together with angles.
 * @throws RangeError for a zero or non-finite direction, a negative colour or intensity, or an elevation past 90.
 * @throws MargoError `state` when a sky with `lighting` drives this sun every frame; set the sky's options instead.
 * @example setSun(engine, { azimuth: degrees(135), elevation: degrees(35), intensity: 3 });
 */
export function setSun(target: LightingTarget, options: SunOptions): SunLight {
  const lighting = lightingOf(target);
  if (typeof options !== 'object' || options === null) throw new TypeError('Pass sun options as an object.');
  const angled = options.azimuth !== undefined || options.elevation !== undefined;
  if (angled && options.direction !== undefined)
    throw new TypeError('Give the sun either direction or azimuth and elevation, not both.');
  if (angled && (options.azimuth === undefined || options.elevation === undefined))
    throw new TypeError('Give the sun both azimuth and elevation.');
  let direction: Vec3 | undefined;
  if (angled) direction = sunDirectionFrom(options.azimuth!, options.elevation!);
  else if (options.direction !== undefined) {
    direction = vector(options.direction, 'sun direction', false);
    if (!Math.hypot(...direction)) throw new RangeError('Invalid sun direction; use a non-zero vector toward the sun.');
  }
  const color = options.color === undefined ? undefined : vector(options.color, 'sun color', true),
    intensity = options.intensity === undefined ? undefined : strength(options.intensity, 'sun intensity');
  const sky = drivingSky(target, false);
  if (sky !== undefined && (direction || color || intensity !== undefined))
    throw new MargoError(
      'state',
      `Sky '${sky}' sets the sun every frame from its lighting option; set sky.options.sunDirection and sky.options.lighting instead`,
    );
  if (direction) lighting.direction.set(direction);
  if (intensity !== undefined) lighting.direction[3] = intensity;
  if (color) lighting.radiance.set(color);
  return getSun(target);
}

/**
 * Reads the scene's sun from core's packed arrays: a unit direction, the colour and the intensity.
 * @throws TypeError when `target` has no lighting.
 */
export function getSun(target: LightingTarget): SunLight {
  const { direction: d, radiance: r } = lightingOf(target),
    length = Math.hypot(d[0], d[1], d[2]) || 1;
  return { direction: [d[0] / length, d[1] / length, d[2] / length], color: [r[0], r[1], r[2]], intensity: d[3] };
}

/**
 * Sets the scene's ambient light with named options; see {@link AmbientOptions} for the defaults. Writes
 * `lighting.radiance[3]` (intensity) and `lighting.ambient` (colour), checking every value first.
 * @returns The ambient light after the change, as {@link getAmbient} reads it.
 * @throws TypeError for a wrong shape; RangeError for a negative or non-finite value.
 * @throws MargoError `state` when a sky with `lighting.ambient` or `environment` lights this scene instead.
 * @example setAmbient(engine, { color: [0.6, 0.7, 1], intensity: 0.3 });
 */
export function setAmbient(target: LightingTarget, options: AmbientOptions): AmbientLight {
  const lighting = lightingOf(target);
  if (typeof options !== 'object' || options === null) throw new TypeError('Pass ambient options as an object.');
  const color = options.color === undefined ? undefined : vector(options.color, 'ambient color', true),
    intensity = options.intensity === undefined ? undefined : strength(options.intensity, 'ambient intensity');
  if (color && !(lighting.ambient instanceof Float32Array && lighting.ambient.length >= 3))
    throw new TypeError('This lighting has no ambient colour array; pass an Engine or a Scene, or leave out color.');
  const sky = drivingSky(target, true);
  if (sky !== undefined && (color || intensity !== undefined))
    throw new MargoError(
      'state',
      `Sky '${sky}' lights this scene's ambient from the sky; set sky.options.lighting.ambient instead`,
    );
  if (color) lighting.ambient!.set(color);
  if (intensity !== undefined) lighting.radiance[3] = intensity;
  return getAmbient(target);
}

/**
 * Reads the scene's ambient light: the colour (`lighting.ambient`, white when absent) and intensity (`radiance[3]`).
 * @throws TypeError when `target` has no lighting.
 */
export function getAmbient(target: LightingTarget): AmbientLight {
  const { radiance, ambient: a } = lightingOf(target);
  return { color: a ? [a[0], a[1], a[2]] : [1, 1, 1], intensity: radiance[3] };
}

/** Options for {@link sunlitSky}. Every field is optional. */
export interface SunlitSkyOptions {
  /** Compass angle of the sun, as in {@link SunOptions.azimuth}. Default `degrees(135)`. */
  azimuth?: Angle;
  /** Sun height above the horizon, as in {@link SunOptions.elevation}. Default `degrees(35)`. */
  elevation?: Angle;
  /**
   * Sun strength with the sun overhead; the atmosphere dims and warms a lower sun. Default 3, core's own sun strength,
   * so a scene keeps its brightness when the sky takes over the light.
   */
  intensity?: number;
  /**
   * Light the scene's surfaces from the sky's colours as well as from the sun (the sky's `lighting.ambient`). Default
   * true, with the floor of `skyEnvironmentFloor`. false keeps core's constant ambient term.
   */
  skyAmbient?: boolean;
}

/**
 * Sky options in which the sky lights the scene: the sun disc and the engine's sun share one direction from typed
 * angles, and surfaces get the sky's own colours as ambient light. Pass the result to `Sky.attach` (the root `Sky`,
 * or `Sky` from `@margoengine/sky/base` with the `lighting` feature). Spread it to add other sky options.
 * A `Sky` without `lighting` (its default, kept for existing scenes) draws a backdrop and lights nothing.
 * @throws TypeError when an angle is a plain number; RangeError for an elevation past 90 or a negative intensity.
 * @example const sky = Sky.attach(engine, sunlitSky({ elevation: degrees(35) }));
 */
export function sunlitSky(options: SunlitSkyOptions = {}): SkyOptions & { lighting: SkyLightingOptions } {
  if (typeof options !== 'object' || options === null) throw new TypeError('Pass sunlit sky options as an object.');
  const [x, y, z] = sunDirectionFrom(options.azimuth ?? degrees(135), options.elevation ?? degrees(35));
  const lighting: SkyLightingOptions = { intensity: strength(options.intensity ?? 3, 'sun intensity') };
  // Same values as skyEnvironmentFloor in ./base.js (checked by test/sun.test.js), copied so this entry stays small.
  if (options.skyAmbient ?? true) lighting.ambient = { day: [0.04, 0.04, 0.04], night: [0.01, 0.015, 0.03] };
  return { sunDirection: [x, y, z], lighting };
}

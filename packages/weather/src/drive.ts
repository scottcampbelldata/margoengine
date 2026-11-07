// The weather drawn from its state with no wiring by hand: `WeatherDrive` reads a weather (a `WeatherMachine`, or
// `WeatherRegions` sampled at the camera) every frame and writes its numbers into whatever draws it: the sky's cloud
// sheet and fog, `VolumetricClouds`, `@margoengine/environment`'s `Fog` and `VolumetricFog`, the sky's rain and snow and
// this package's `Hail`. Each target is duck-typed, so this entry imports none of those packages.
import { MargoError } from '@margoengine/math/errors';
import { fogDensity, hailSettings, skyWeather, windAt } from './sky-settings.js';
import type { WeatherState } from './state.js';
import type { WindField } from './wind.js';

/** The weather to follow: a `WeatherMachine`, or anything with a `state` (and optionally `update`, `wind` and `time`). */
export interface DriveSource {
  /** The weather now. */
  readonly state: WeatherState;
  /** Steps the weather; called with each frame's delta when `advance` is on. */
  update?(delta: number): unknown;
  /** Its wind field, sampled at the camera for the wind of rain, snow and hail. */
  readonly wind?: WindField;
  /** Seconds of weather time, for the wind field. */
  readonly time?: number;
}

/** The sky (`Sky` from `@margoengine/sky`): its cloud sheet and its fog. */
export interface SkyTarget {
  readonly options: {
    clouds?: { coverage?: number; speed?: number; height?: number };
    fog?: { density?: number; falloff?: 'exp' | 'exp2' };
  };
}
/** A cloud layer (`VolumetricClouds` from `@margoengine/sky/volumetric-clouds`). */
export interface CloudLayerTarget {
  readonly options: { coverage?: number; density?: number; wind?: readonly [number, number] };
}
/** Scene fog with a squared falloff (`Fog` from `@margoengine/environment`). */
export interface SceneFogTarget {
  density: number;
}
/** A fog volume (`VolumetricFog` from `@margoengine/environment`): extinction per metre. */
export interface FogVolumeTarget {
  readonly options: { density?: number };
}
/** Rain and snow (`Weather` from `@margoengine/sky/weather`). */
export interface PrecipitationTarget {
  readonly options: object;
}

/** {@link WeatherDrive} settings, read every frame from `drive.options`. */
export interface DriveOptions {
  /** The weather to follow. */
  weather: DriveSource;
  /** Step the weather with each frame's delta (call its `update` yourself when false). Default true. */
  advance?: boolean;
  /** The sky: when it has them, its cloud sheet's coverage and its fog's density. */
  sky?: SkyTarget;
  /** Volumetric cloud layers: coverage, density and wind. */
  clouds?: CloudLayerTarget | readonly CloudLayerTarget[];
  /** Scene fog (squared falloff): its density. */
  fog?: SceneFogTarget;
  /** Fog volumes: their extinction. */
  fogVolumes?: FogVolumeTarget | readonly FogVolumeTarget[];
  /** The sky's rain and snow: `skyWeather` of the state. */
  precipitation?: PrecipitationTarget;
  /** Hail: `hailSettings` of the state. */
  hail?: PrecipitationTarget;
  /** Where to sample the wind (the camera); default the origin. Set it each frame, or give `listener`. */
  position?: readonly [number, number, number];
  /** Something whose `position` is the camera, read each frame (an engine's `camera`). */
  listener?: { readonly position: ArrayLike<number> };
  /** Wind aloft over the wind at the ground, for the cloud drift. Default 3. */
  windAloft?: number;
}

/** The numbers the drive writes for a state; exported so you can drive anything else the same way. */
export interface DriveSettings {
  /** Cloud cover for a cloud sheet or layer, 0..1. */
  coverage: number;
  /** Volumetric cloud extinction per metre: 0.02 fair-weather, rising to 0.08 in storms. */
  cloudDensity: number;
  /** Cloud drift `[x, z]` in metres per second. */
  cloudWind: [number, number];
  /** Fog extinction per metre (`fogDensity`), for an exponential fog or a fog volume. */
  extinction: number;
  /** The density of a squared-falloff fog that leaves the same 5 percent of contrast at the same distance. */
  squaredDensity: number;
}

/**
 * The settings a state gives. Cloud coverage is `cloud`; layer density rises from 0.02 by 0.06 times the strongest
 * of rain, snow, hail and lightning (cumulus is about 0.02 to 0.1 per metre); clouds drift with the mean wind times
 * `windAloft`. Fog: `fogDensity`, an extinction sigma, for which contrast falls to 5 percent at 3 / sigma; a fog of
 * `1 - exp(-(d * k)^2)` reaches that at the same distance when k = sigma / sqrt(3).
 */
export function driveSettings(state: WeatherState, windAloft = 3): DriveSettings {
  const extinction = fogDensity(state),
    storm = Math.max(state.rain, state.snow, state.hail, state.lightning),
    k = state.wind * windAloft;
  return {
    coverage: state.cloud,
    cloudDensity: 0.02 + 0.06 * storm,
    cloudWind: [Math.sin(state.windDirection) * k, Math.cos(state.windDirection) * k],
    extinction,
    squaredDensity: extinction / Math.sqrt(3),
  };
}

const list = <T>(value: T | readonly T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** Throws for an invalid field of `o`. */
export function validateDrive(o: DriveOptions): void {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('WeatherDrive options must be an object; pass {weather}');
  if (typeof o.weather !== 'object' || o.weather === null || typeof o.weather.state !== 'object')
    throw new TypeError('WeatherDrive weather needs a state; pass a WeatherMachine');
  if (o.advance !== undefined && typeof o.advance !== 'boolean')
    throw new TypeError('WeatherDrive advance must be true or false');
  if (
    o.windAloft !== undefined &&
    (typeof o.windAloft !== 'number' || !Number.isFinite(o.windAloft) || o.windAloft < 0 || o.windAloft > 20)
  )
    throw new RangeError('WeatherDrive windAloft must be a number from 0 to 20; pass a finite value in range');
  for (const [name, target] of [
    ['sky', o.sky],
    ['precipitation', o.precipitation],
    ['hail', o.hail],
    ...list(o.clouds).map((c) => ['clouds', c] as const),
    ...list(o.fogVolumes).map((c) => ['fogVolumes', c] as const),
  ] as const)
    if (target !== undefined && (typeof target !== 'object' || target === null || typeof target.options !== 'object'))
      throw new TypeError(`WeatherDrive ${name} needs an object with options; pass the attached effect`);
  if (o.fog !== undefined && (typeof o.fog !== 'object' || o.fog === null || typeof o.fog.density !== 'number'))
    throw new TypeError('WeatherDrive fog needs a numeric density; pass an environment Fog');
}

/**
 * Writes a weather's state into the sky, clouds, fog, rain and hail each frame. `WeatherDrive.attach(engine, options)`
 * runs it as an engine plugin (and steps the weather); without an engine call `update(delta)` yourself.
 * @throws TypeError / RangeError on invalid options; MargoError `'disposed'` after `dispose()`.
 * @example
 * WeatherDrive.attach(engine, {weather: machine, sky, clouds, listener: engine.camera});
 */
export class WeatherDrive {
  readonly name: string = 'weather-drive';
  private disposed = false;
  private engine?: { removePlugin(name: string): void };
  private last?: DriveSettings;

  constructor(readonly options: DriveOptions) {
    validateDrive(options);
  }

  /** Adds the drive to an engine (anything with `use`); it then runs before every frame. */
  static attach(engine: { use(plugin: object): unknown }, options: DriveOptions): WeatherDrive {
    const drive = new WeatherDrive(options);
    engine.use(drive);
    return drive;
  }

  /** What was written last, or undefined before the first update. */
  get settings(): DriveSettings | undefined {
    return this.last;
  }

  /** Steps the weather (with `advance`) and writes its state into every target. */
  update(delta = 0): DriveSettings {
    if (this.disposed) throw new MargoError('disposed', 'WeatherDrive is disposed; attach a new WeatherDrive');
    const o = this.options;
    validateDrive(o);
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid WeatherDrive delta; pass a finite delta of 0 or more seconds.');
    if (o.advance ?? true) o.weather.update?.(delta);
    const state = o.weather.state,
      s = driveSettings(state, o.windAloft ?? 3);
    if (o.sky) {
      const sky = o.sky.options;
      if (sky.clouds) sky.clouds.coverage = s.coverage;
      if (sky.fog) sky.fog.density = Math.min(1, sky.fog.falloff === 'exp' ? s.extinction : s.squaredDensity);
    }
    for (const layer of list(o.clouds))
      Object.assign(layer.options, { coverage: s.coverage, density: s.cloudDensity, wind: s.cloudWind });
    if (o.fog) o.fog.density = s.squaredDensity;
    for (const volume of list(o.fogVolumes)) volume.options.density = s.extinction;
    if (o.precipitation || o.hail) {
      const p = o.listener?.position ?? o.position ?? [0, 0, 0],
        wind = o.weather.wind ? windAt(o.weather.wind, p[0], p[1], p[2], o.weather.time ?? 0) : undefined;
      if (o.precipitation) Object.assign(o.precipitation.options, skyWeather(state, wind));
      if (o.hail) Object.assign(o.hail.options, hailSettings(state, wind));
    }
    return (this.last = s);
  }

  /** Engine plugin hooks. */
  setup(engine: { removePlugin(name: string): void }): void {
    if (this.disposed) throw new MargoError('disposed', 'WeatherDrive is disposed; attach a new WeatherDrive');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }

  /** Stops driving; the targets keep their last values. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

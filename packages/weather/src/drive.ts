// The weather drawn from its state with no wiring by hand: `WeatherDrive` reads a weather (a `WeatherMachine`, or
// `WeatherRegions` sampled at the camera) every frame and writes its numbers into whatever draws it: the sky's cloud
// sheet and fog, `VolumetricClouds`, `@margoengine/environment`'s `Fog` and `VolumetricFog`, the sky's rain and snow and
// this package's `Hail`. Each target is duck-typed, so this entry imports none of those packages.
import { MargoError } from '@margoengine/math/errors';
import {
  CLEAR_AIR_EXTINCTION,
  KOSCHMIEDER,
  ashColor,
  ashExtinction,
  ashForExtinction,
  dustColor,
  dustExtinction,
  dustFromWind,
  rainRate,
  smokeColor,
  smokeExtinction,
  smokeFromEmission,
  sprayColor,
  sprayExtinction,
  sprayFromWind,
  sunTransmittance,
  hazeLight,
  hazeLightDecay,
  hazeReflectance,
  fireHazeLight,
  fireLayerLight,
  SMOKE_LAYER_DEPTH,
  visibility,
  windProfile,
} from './air.js';
import { clusterFires, type FirePoint } from './fire-sources.js';
import { heldFromWeather } from '../../shared/settings.js';
import { FuelMoistureModel, type DeadFuelMoisture } from './fuel-moisture.js';
import { grassWind, scatterWind } from './wind-settings.js';
import { fogDensity, hailSettings, skyWeather, windAt, type SkyWeatherSettings } from './sky-settings.js';
import type { WeatherState } from './state.js';
import type { WindField } from './wind.js';

/** A glow the drive writes on the sky (`SkyFireSpot` of `@margoengine/sky`). */
export interface SkyFireSpotTarget {
  readonly color: readonly [number, number, number];
  readonly x: number;
  readonly z: number;
  readonly height?: number;
  readonly reach?: number;
}
/** What the sky's fog or air takes of the fires. */
type SpotHolder = { fireSpots?: readonly SkyFireSpotTarget[]; fireSight?: number };
/** The weather to follow: a `WeatherMachine`, or anything with a `state` (and optionally `update`, `wind` and `time`). */
export interface DriveSource {
  /** The weather now. */
  readonly state: WeatherState;
  /** Steps the weather; called with each frame's delta when `advance` is on. */
  update?(delta: number): unknown;
  /** Steps the weather as `update` does but calls no listener; a seek's replayed steps use it when it is there. */
  advanceTime?(delta: number): unknown;
  /** Its wind field, sampled at the camera for the wind of rain, snow and hail. */
  readonly wind?: WindField;
  /** Seconds of weather time, for the wind field. */
  readonly time?: number;
  /** Puts the weather back to time 0 (GAP-FILM-RESET); a drive that steps it (`advance`) calls it from its own `resetTime`. */
  resetTime?(): unknown;
}

/** The sky (`Sky` from `@margoengine/sky`): its cloud sheet and its fog. */
/** One engine light of a sky: direction XYZ and intensity in `direction`, RGB radiance in `radiance`. */
export interface SkyLightTarget {
  readonly direction: ArrayLike<number>;
  readonly radiance: ArrayLike<number>;
}
export interface SkyTarget {
  readonly options: {
    clouds?: { coverage?: number; speed?: number; height?: number };
    fog?: {
      density?: number;
      falloff?: 'exp' | 'exp2';
      color?: readonly [number, number, number];
      fireSpots?: readonly SkyFireSpotTarget[];
      /** How fast the haze's light falls with depth below the eye (sky `fog.lightDecay`, KB-SKY-HAZEBELOW1). */
      lightDecay?: readonly [number, number, number];
    };
    /**
     * The air the sun shines through; smoke dims and reddens its `sunColor`, ash and spray dim it grey, and the light
     * the layers scatter down lights the sky (`scatteredLight`). Made as `{}` under a load when the sky has a `look` or
     * takes one (`airControls`).
     */
    atmosphere?: {
      sunColor?: readonly [number, number, number];
      scatteredLight?: readonly [number, number, number];
      layerTransmittance?: readonly [number, number, number];
      fireSpots?: readonly SkyFireSpotTarget[];
      fireSight?: number;
      /** The look's sun strength (`atmosphere.sunIntensity`), which the sky's `scatteredLight` glow takes. Default 1. */
      sunIntensity?: number;
    };
    look?: object;
    /** The sky's exposure in stops, which its drawn haze takes. Default 0. */
    exposure?: number;
    /** The sky's engine lighting: its `intensity` is the noon sun's light the haze colours are referred to. Default 1. */
    lighting?: { intensity?: number };
  };
  /**
   * The sky's day/night blend (`Sky.nightFactor`), 0 by day and 1 at night: the haze colour hands its sunlight over to
   * the night's light by it, as the sky hands its own light to the moon and twilight. Unset: the sky's blend of its sun.
   */
  readonly nightFactor?: number;
  /** The moon's engine light under the clouds (`Sky.moonUnderClouds`): direction XYZ and intensity, RGB radiance. */
  readonly moonUnderClouds?: SkyLightTarget;
  /** The twilight sky's engine light (`Sky.twilightLight`): direction XYZ and intensity, RGB radiance. */
  readonly twilightLight?: SkyLightTarget;
  /** True when the sky takes `atmosphere` (`Sky.airControls`: it has the `look` feature, as the root `Sky` does). */
  readonly airControls?: boolean;
  /** The unit vector to the sun (`Sky.sun`): its y is the sine of the elevation the smoke's sun dimming reads. Zenith when absent. */
  readonly sun?: ArrayLike<number>;
  /**
   * The zenith sun on level ground in the sky's units (`Sky.zenithSun`). With it the haze colour the drive writes is in
   * the units the sky draws its own haze and pall in (KB-SKY-PALLHAZE1); without it the colour stays a share of a white
   * surface's light.
   */
  readonly zenithSun?: number;
  /** The factor the sky draws in besides its exposure (`Sky.pictureScale`). Default 1. */
  readonly pictureScale?: number;
}
/**
 * A wildfire (`FireFront` from `@margoengine/vfx/fire-front`): its `smokeEmission`, grams of fine smoke a second, raises
 * the weather's `smoke`, and its dead fuel moisture (`moisture`, `moisture10`, `moisture100`) follows the weather's
 * while unset.
 */
export interface FireTarget {
  readonly options: object;
  readonly smokeEmission: number;
  /** The flames' radiant power now, watts (`FireFront.radiantPower`): it lights the smoke haze from below. None gives no light. */
  readonly radiantPower?: number;
  /**
   * The noon sun its smoke's glow is referred to (`FireFront.noon`, KB-VFX-GLOWUNITS1): the drive writes its sky's
   * `lighting.intensity` here each frame, so the columns over a fire take the same share of the noon light as the haze.
   */
  noon?: number;
  /**
   * Light of the air round its smoke columns (`FireFront.air`, KB-VFX-COLUMNAMBIENT1): the drive writes the fires' light
   * on the smoke pall over this fire each frame (shares of the noon sun, red, green and blue), so its columns take the
   * pall's light.
   */
  air?: readonly [number, number, number];
  /**
   * Its burning segments (`FireFront.segments()`): world metres on the ground and convective heat, watts. A fire that
   * has them lights the sky's pall and haze as spots over where it burns (KB-SKY-PALLFALLOFF1), its radiant power
   * shared among them by their heat; one that has none lights them evenly (`fireHazeLight`).
   */
  segments?(): readonly { readonly x: number; readonly y: number; readonly z: number; readonly heat: number }[];
}
/** A cloud layer (`VolumetricClouds` from `@margoengine/sky/volumetric-clouds`). */
export interface CloudLayerTarget {
  readonly options: {
    coverage?: number;
    density?: number;
    wind?: readonly [number, number];
    /** The weather state, so the layer takes its cloud type (base and tops) from it (`VolumetricCloudOptions.weather`). */
    weather?: { readonly cloud: number; readonly rain?: number; readonly lightning?: number };
    /** A hurricane the layer draws: its cover, density and turning cloud are the storm's, so the drive writes only `weather`. */
    hurricane?: unknown;
    /** The layer's cloud type; `'hurricane'` is a storm's layer as `hurricane` is. */
    type?: string;
  };
}
/** Scene fog with a squared falloff (`Fog` from `@margoengine/environment`). */
export interface SceneFogTarget {
  density: number;
}
/** A fog volume (`VolumetricFog` from `@margoengine/environment`): extinction per metre and its scattering colour. */
export interface FogVolumeTarget {
  readonly options: {
    density?: number;
    visibility?: number;
    wind?: readonly [number, number, number];
    color?: readonly [number, number, number];
  };
}
/** Scatter (`Scatter` from `@margoengine/scatter`), with or without a `wind` option: the drive writes its wind. */
export interface ScatterTarget {
  readonly options: { wind?: readonly [number, number, number] | readonly [number, number, number, number] };
}
/** A creative `GrassField`: its `windDirection`, `windStrength` and `windSpeed` are rewritten. */
export interface GrassTarget {
  windDirection: readonly [number, number];
  windStrength: number;
  windSpeed: number;
}
/**
 * A volcanic eruption (`Eruption` from `@margoengine/weather/eruption`): `visibility(x, z)` is how far one sees through its
 * falling ash at a place, metres, which the drive turns into the weather's `ash` at the camera.
 */
export interface EruptionTarget {
  visibility(x: number, z: number): number;
}
/** A particle effect (`VFX` from `@margoengine/vfx`, a `Fire`'s flames, embers and steam): its `wind` option is rewritten. */
export interface VfxTarget {
  readonly options: { wind?: unknown };
  setWind(wind: readonly [number, number] | undefined): unknown;
}
/** A sea (`Water` from `@margoengine/water` built without `waves`, so its sea follows a wind): the drive calls its `setWind` with the state's mean wind. */
export interface WaterTarget {
  readonly options: { wind?: unknown; waves?: unknown };
  setWind(wind: { speed: number; direction?: readonly [number, number] }): unknown;
  /** Where its swell breaks on its coast, [x, z] segments (`Water.breakerLine`); the drive reads it when `surf` is unset. */
  breakerLine?(): readonly (readonly (readonly [number, number])[])[];
}
/**
 * Wind-blown sand (`BlownSand` from `@margoengine/vfx/blown-sand`): its `wind` follows the state's mean wind while it is
 * unset or `{speed: 0}` (a wind a person gave it, a `WindField` or any speed above 0, overrides), and its `fog` takes the
 * air's extinction (dust included) while it is unset.
 */
export interface BlownSandTarget {
  readonly options: { wind?: unknown; fog?: number; threshold?: number };
}
/**
 * Ground that changes over film time (`GroundChange` from `@margoengine/terrain/ground-change`): its `look.rain`, the
 * wetness of its cut soil, mud and ash, follows the state's rain (0 to 1) while it is not held by a value set by hand.
 */
export interface GroundTarget {
  readonly options: object;
  readonly look: { rain?: number | null };
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
  /**
   * Scatters to bend with the wind, whether or not they were built with a `wind` option: their `wind` becomes
   * `scatterWind` of the field (direction and (U / 20)^2 as the strength), and their culling reach widens for it. Found
   * by name (`scatter:N`) when not given.
   */
  scatter?: ScatterTarget | readonly ScatterTarget[];
  /** Creative grass fields to bend with the wind (`grassWind` of the field). Found by name (`grass-field:N`) when not given. */
  grass?: GrassTarget | readonly GrassTarget[];
  /**
   * Particle effects that lean with the wind: their wind becomes the field's `[x, z]` m/s (`VFXOptions.wind`: the
   * horizontal velocity relaxes toward it, so smoke rising at w leans atan(U / w)), unless it was given a wind of its
   * own (anything but unset or `[0, 0]` that this drive did not write): that overrides the weather.
   * Found by name (`vfx:N`, which
   * includes a `Fire`'s parts) when not given.
   */
  vfx?: VfxTarget | readonly VfxTarget[];
  /**
   * Blown-sand layers to follow the weather: wind speed, direction and gustiness, and the extinction of the air as their
   * `fog`. Found by name (`blown-sand:N`) when not given. While one is in the scene the wind over its sand raises the
   * state's dust (`dustFromWind` at the layer's `threshold`, 6.6 m/s by default) when that is more than the state holds,
   * so a sandstorm needs no dust set by hand; `dustFromSand: false` turns that off.
   */
  blownSand?: BlownSandTarget | readonly BlownSandTarget[];
  /**
   * Changing ground and rock whose wetness follows the rain (see {@link GroundTarget}). Found by name (`ground-change:N`, and a `RockSurface`'s `terrain:rocks:N`) when not
   * given.
   */
  grounds?: GroundTarget | readonly GroundTarget[];
  /** Raise the dust with the wind over the sand of a blown-sand layer (see `blownSand`). Default true. */
  dustFromSand?: boolean;
  /**
   * Light on the dust haze: the sky fog's colour while dust makes up most of the air's extinction is `dustColor()` times
   * this, times the light on the haze, which falls as the sun sets and is the moon's and the twilight sky's at night
   * (`airLight`). Default 1.
   */
  dustLight?: number;
  /**
   * Fires whose smoke the weather carries and which spread in its wind (a fire front's `setWind`, as `vfx` effects; a
   * wind the fire was given by hand overrides it): the smoke they make (`smokeFromEmission` of their summed `smokeEmission` in the
   * state's wind over `smokeWidth`) raises the state's `smoke` when it is more than the state holds. Found by name
   * (`fire-front:N`) when not given. `smokeFromFire: false` turns that off.
   */
  fires?: FireTarget | readonly FireTarget[];
  /** Raise the smoke with the fires of the scene (see `fires`). Default true. */
  smokeFromFire?: boolean;
  /** Crosswind width in metres over which a fire's smoke mixes. Default 2,000. */
  smokeWidth?: number;
  /**
   * Light of the fires on the smoke haze (KB-WEATHER-FIREHAZE1): the light on the sky fog gains the fires' summed
   * `radiantPower` as `fireHazeLight` gives it over `smokeWidth`, times this, so a valley burning under its smoke glows
   * orange from below, at night with no other light. 0 turns it off. Default 1.
   */
  fireLight?: number;
  /**
   * Dry and wet the dead fuel of the fires with the weather: each fire's `moisture`, `moisture10` and `moisture100` that is
   * unset (or the drive's own last value) becomes the 1, 10 and 100 hour fuel moisture of `FuelMoistureModel`:
   * the equilibrium moisture of the state's humidity and temperature at the fuel bed (warmed by the sun by the cloud
   * cover in daylight), 35 percent in rain, each class moving toward it with its timelag. A value a person set is kept.
   * Default true.
   */
  fuelMoistureFromWeather?: boolean;
  /** Fuel time over weather time for the fires' fuel moisture (a film that shows an afternoon in a minute). Default 1. */
  fuelTimeScale?: number;
  /** The fuel moisture the fires start from. Default the weather's target at the first frame with a fire. */
  fuelMoistureStart?: DeadFuelMoisture;
  /**
   * Light on the smoke haze: the sky fog's colour while smoke makes up most of the air's extinction is `smokeColor()` times
   * this (see `dustLight`). Default 1.
   */
  smokeLight?: number;
  /**
   * Eruptions whose falling ash the weather carries: the ash at the camera (`ashForExtinction` of 3.912 over the eruption's
   * `visibility` there, less the clear air) raises the state's `ash` when it is more than the state holds. Found by name
   * (`eruption:N`, as `Eruption.attach` names them) when not given. `ashFromEruption: false` turns that off.
   */
  eruptions?: EruptionTarget | readonly EruptionTarget[];
  /** Raise the ash with the eruptions of the scene (see `eruptions`). Default true. */
  ashFromEruption?: boolean;
  /** Light on the ash haze: the fog colour's share of the ash is `ashColor()` times this (see `dustLight`). Default 1. */
  ashLight?: number;
  /**
   * The breaker line of a coast, [x, z] world points joined in order (one point for a single breaking reef): the spray
   * at the camera is the open sea's times 1 + 29 exp(-d / 2,000) at its distance d from the line (`sprayFromWind`, de
   * Leeuw et al. 2000), so the haze thickens near breaking water. Unset: the breaker lines of the scene's seas
   * (`Water.breakerLine`, from a `Water` given `terrain.heights`), else the open sea's spray only.
   */
  surf?: readonly (readonly [number, number])[];
  /**
   * Raise sea spray with the wind over the scene's seas (`water` targets, or `water:N` plugins found by name) and the
   * `surf`: `sprayFromWind` of the state's wind raises the state's `spray` when it is more than the state holds. Default true.
   */
  sprayFromSea?: boolean;
  /** Light on the spray haze: the fog colour's share of the spray is `sprayColor()` times this (see `dustLight`). Default 1. */
  sprayLight?: number;
  /**
   * Seas to raise with the wind: each `Water` built without `waves` (its `wind` option or the 6 m/s default) gets `setWind` with the
   * state's mean wind speed and direction, only when they change. Found by name (`water:N`) when not given.
   */
  water?: WaterTarget | readonly WaterTarget[];
  /** Where to sample the wind (the camera); default the origin. Set it each frame, or give `listener`. */
  position?: readonly [number, number, number];
  /** Something whose `position` is the camera, read each frame (an engine's `camera`). */
  listener?: { readonly position: ArrayLike<number> };
  /**
   * Cloud drift over the wind at 10 m, a plain factor. Default unset: each cloud layer drifts at the wind at its own
   * base height, U10 (z / 10)^(1/7) (`windProfile`), 2.05 times the ground wind at 1,500 m.
   */
  windAloft?: number;
  /**
   * Find the targets by name among the scene's plugins when none is given: the sky (`sky`), cloud layer
   * (`sky:volumetric-clouds`), fog volume (`volumetric-fog`), rain and snow (`weather`) and `hail`. A target handed in
   * wins; false turns discovery off. Default true.
   */
  auto?: boolean;
  /**
   * Fog volumes to blow with the wind at the listener: their `wind` becomes `[x, 0, z]` of the wind field each frame,
   * so their noise streams past with the gusts (blowing snow, drifting mist). Needs a weather with a wind field. They
   * need not be in `fogVolumes`, so a scene can set a fog's density itself and still let the drive blow it.
   */
  fogWind?: FogVolumeTarget | readonly FogVolumeTarget[];
}

/** The numbers the drive writes for a state; exported so you can drive anything else the same way. */
export interface DriveSettings {
  /** Cloud cover for a cloud sheet or layer, 0..1. */
  coverage: number;
  /** Volumetric cloud extinction per metre: 0.02 fair-weather, rising to 0.08 in storms. */
  cloudDensity: number;
  /** Cloud drift `[x, z]` in metres per second at the cloud height (the wind at that height). */
  cloudWind: [number, number];
  /** Dust (0 to 1) the air holds: the state's, or more where wind over blown sand raises it. */
  dust: number;
  /** Smoke (0 to 1) the air holds: the state's, or more where a fire front raises it. */
  smoke: number;
  /** Ash (0 to 1) the air holds: the state's, or more where an eruption's falling ash raises it. */
  ash: number;
  /** Sea spray (0 to 1) the air holds: the state's, or more where a wind over the sea and its surf raises it. */
  spray: number;
  /** Visibility in metres the state leaves (`visibility`). */
  visibility: number;
  /** Rain rate in mm/h (`rainRate`). */
  rainRate: number;
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
export function driveSettings(state: WeatherState, windAloft?: number, cloudHeight = 1500): DriveSettings {
  const extinction = fogDensity(state),
    storm = Math.max(state.rain, state.snow, state.hail, state.lightning),
    k = windAloft === undefined ? windProfile(state.wind, cloudHeight) : state.wind * windAloft;
  return {
    coverage: state.cloud,
    cloudDensity: 0.02 + 0.06 * storm,
    cloudWind: [Math.sin(state.windDirection) * k, Math.cos(state.windDirection) * k],
    dust: state.dust,
    smoke: state.smoke,
    ash: state.ash,
    spray: state.spray,
    visibility: visibility(state),
    rainRate: rainRate(state),
    extinction,
    squaredDensity: extinction / Math.sqrt(3),
  };
}

// The weather is the master: a value a person set (the settings appliers mark it with `holdFromWeather`) is an override
// the drive never writes, and a value handed back with null (released) follows the weather again.
const put = (target: object, key: string, value: unknown): void => {
  if (!heldFromWeather(target, key)) (target as Record<string, unknown>)[key] = value;
};
const putAll = (target: object, values: object): void => {
  for (const [key, value] of Object.entries(values)) put(target, key, value);
};
// The sky Weather's settings from a state. Its `lightning` is merged into the one a person gave (rate and threshold
// only), never put over it: the light, the deck's flash, the seed, the strength and the link are theirs. A state with no
// storm stops the strikes (`rate` 0) and leaves the rest where it was.
const putSky = (options: object, settings: SkyWeatherSettings): void => {
  const { lightning, ...rest } = settings;
  putAll(options, rest);
  if (heldFromWeather(options, 'lightning')) return;
  const target = options as { lightning?: Record<string, unknown> },
    own = target.lightning;
  if (typeof own === 'object' && own !== null) {
    put(own, 'rate', lightning?.rate ?? 0);
    if (lightning) put(own, 'threshold', lightning.threshold);
  } else if (lightning) target.lightning = { ...lightning };
};

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
  if (
    o.dustLight !== undefined &&
    (typeof o.dustLight !== 'number' || !Number.isFinite(o.dustLight) || o.dustLight < 0 || o.dustLight > 100)
  )
    throw new RangeError('WeatherDrive dustLight must be a number from 0 to 100; pass a finite value in range');
  if (
    o.smokeLight !== undefined &&
    (typeof o.smokeLight !== 'number' || !Number.isFinite(o.smokeLight) || o.smokeLight < 0 || o.smokeLight > 100)
  )
    throw new RangeError('WeatherDrive smokeLight must be a number from 0 to 100; pass a finite value in range');
  for (const key of ['ashLight', 'sprayLight', 'fireLight'] as const) {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100))
      throw new RangeError(`WeatherDrive ${key} must be a number from 0 to 100; pass a finite value in range`);
  }
  for (const key of ['ashFromEruption', 'sprayFromSea'] as const)
    if (o[key] !== undefined && typeof o[key] !== 'boolean')
      throw new TypeError(`WeatherDrive ${key} must be true or false`);
  for (const e of list(o.eruptions))
    if (typeof e !== 'object' || e === null || typeof e.visibility !== 'function')
      throw new TypeError('WeatherDrive eruptions need visibility(x, z); pass an Eruption');
  if (
    o.surf !== undefined &&
    (!Array.isArray(o.surf) ||
      o.surf.length === 0 ||
      !o.surf.every((q) => Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1])))
  )
    throw new TypeError('WeatherDrive surf must be a list of [x, z] world points; pass at least one finite point');
  if (
    o.smokeWidth !== undefined &&
    (typeof o.smokeWidth !== 'number' || !Number.isFinite(o.smokeWidth) || !(o.smokeWidth > 0))
  )
    throw new RangeError('WeatherDrive smokeWidth must be a number above 0 metres; pass a finite value in range');
  if (o.smokeFromFire !== undefined && typeof o.smokeFromFire !== 'boolean')
    throw new TypeError('WeatherDrive smokeFromFire must be true or false');
  if (o.fuelMoistureFromWeather !== undefined && typeof o.fuelMoistureFromWeather !== 'boolean')
    throw new TypeError('WeatherDrive fuelMoistureFromWeather must be true or false');
  if (
    o.fuelTimeScale !== undefined &&
    (typeof o.fuelTimeScale !== 'number' ||
      !Number.isFinite(o.fuelTimeScale) ||
      o.fuelTimeScale < 0 ||
      o.fuelTimeScale > 1e6)
  )
    throw new RangeError(
      'WeatherDrive fuelTimeScale must be a number from 0 to 1,000,000; pass a finite value in range',
    );
  if (o.dustFromSand !== undefined && typeof o.dustFromSand !== 'boolean')
    throw new TypeError('WeatherDrive dustFromSand must be true or false');
  for (const [name, target] of [
    ['sky', o.sky],
    ['precipitation', o.precipitation],
    ['hail', o.hail],
    ...list(o.clouds).map((c) => ['clouds', c] as const),
    ...list(o.fogVolumes).map((c) => ['fogVolumes', c] as const),
    ...list(o.fogWind).map((c) => ['fogWind', c] as const),
    ...list(o.water).map((c) => ['water', c] as const),
    ...list(o.blownSand).map((c) => ['blownSand', c] as const),
    ...list(o.grounds).map((c) => ['grounds', c] as const),
    ...list(o.fires).map((c) => ['fires', c] as const),
  ] as const)
    if (target !== undefined && (typeof target !== 'object' || target === null || typeof target.options !== 'object'))
      throw new TypeError(`WeatherDrive ${name} needs an object with options; pass the attached effect`);
  if (o.fog !== undefined && (typeof o.fog !== 'object' || o.fog === null || typeof o.fog.density !== 'number'))
    throw new TypeError('WeatherDrive fog needs a numeric density; pass an environment Fog');
}

// The engine calls the drive makes: it leaves the scene it joined (`sceneOf`), never the active one. An engine
// (EngineKernel) has it; setup keeps its published parameter type.
interface DriveEngine {
  sceneOf?(plugin: object): { removePlugin(name: string): void } | undefined;
  readonly plugins?: ReadonlyMap<string, object>;
}

// The plugin names the drive looks for when no target is handed in, and what each must hold to be driven.
const FOUND = {
  sky: 'sky',
  clouds: 'sky:volumetric-clouds',
  fogVolumes: 'volumetric-fog',
  precipitation: 'weather',
  hail: 'hail',
} as const;

/** Distance in the x-z plane from (x, z) to the polyline `line` (a single point is a point). */
function surfDistance(line: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Math.hypot(x - line[0]![0], z - line[0]![1]);
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1]!,
      [bx, bz] = line[i]!,
      dx = bx - ax,
      dz = bz - az,
      l = dx * dx + dz * dz,
      u = l > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
    best = Math.min(best, Math.hypot(x - ax - u * dx, z - az - u * dz));
  }
  return best;
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
  private engine?: DriveEngine;
  private last?: DriveSettings;
  /** advanceTime stepped the weather since the engine's last frame with time in it. */
  private stepped = false;
  /** How many engine frames in a row found such a step: two or more is a doubled clock. */
  private doubled = 0;
  private readonly seas = new WeakMap<object, string>();
  private readonly rains = new WeakMap<object, number>();
  private readonly winds = new WeakMap<object, unknown>();
  private readonly fogs = new WeakMap<object, number>();
  private readonly sandWinds = new WeakMap<object, object>();
  private readonly fogColors = new WeakMap<object, { original: unknown; wrote: unknown }>();
  // The lightDecay each fog had before the drive wrote one, and the one it wrote (KB-SKY-HAZEBELOW1).
  private readonly fogDecays = new WeakMap<object, { original: unknown; wrote: unknown }>();
  private readonly sunColors = new WeakMap<object, { original: unknown; wrote: unknown }>();
  // The scatteredLight each atmosphere had before the drive wrote one, and the one it wrote (KB-AIR-SKYLIGHT1).
  private readonly skyLights = new WeakMap<object, { original: unknown; wrote: unknown }>();
  // The layerTransmittance each atmosphere had before the drive wrote one, and the one it wrote (KB-SKY-NIGHTPALL1).
  private readonly layerSkies = new WeakMap<object, { original: unknown; wrote: unknown }>();
  // The fireSpots each fog and atmosphere had before the drive wrote them, and the list it wrote (KB-SKY-PALLFALLOFF1).
  private readonly spotLists = new WeakMap<
    object,
    { original: readonly SkyFireSpotTarget[] | undefined; wrote: readonly SkyFireSpotTarget[] }
  >();
  private readonly sights = new WeakMap<object, { original: number | undefined; wrote: number }>();
  private readonly fuelWrote = new WeakMap<object, DeadFuelMoisture>();
  private fuel?: FuelMoistureModel;

  constructor(readonly options: DriveOptions) {
    validateDrive(options);
  }

  /** The dead fuel moisture the drive gives the fires now, or undefined before a frame with a fire. */
  get fuelMoisture(): DeadFuelMoisture | undefined {
    return this.fuel?.moisture;
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

  /** Seconds of the weather it follows (its `time`, 0 when it has none): `seek` checks it reads 0 at a fresh start. */
  get time(): number {
    return this.options.weather.time ?? 0;
  }

  /** Steps the weather (with `advance`) and writes its state into every target. */
  update(delta = 0): DriveSettings {
    return this.apply(delta, false);
  }

  /**
   * One frame of the drive with no listener call: steps the weather with its `advanceTime` (with `advance`) and writes
   * the same targets `update` writes. `seek` from `@margoengine/cutscene/seek` runs it for each replayed step, before
   * the sky's `Weather` and the clouds that read those targets, as the engine runs them in attach order.
   */
  advanceTime(delta: number): void {
    this.apply(delta, true);
    // A step besides the engine's own (KB-LOOK-TV-SHIMMER2): see onPreUpdate.
    if (delta > 0 && this.engine && (this.options.advance ?? true)) this.stepped = true;
  }

  /**
   * Back to time 0, as a fresh drive with the same options (GAP-FILM-RESET): the weather it steps (with `advance`) is
   * reset with it, the dead fuel moisture starts again from `fuelMoistureStart` on the next frame with a fire, and
   * nothing counts as written yet. The targets keep what was last written until the next frame writes them again.
   */
  resetTime(): void {
    if (this.disposed) throw new MargoError('disposed', 'WeatherDrive is disposed; attach a new WeatherDrive');
    if (this.options.advance ?? true) this.options.weather.resetTime?.();
    this.fuel = this.last = undefined;
    this.stepped = false;
    this.doubled = 0;
  }

  private apply(delta: number, replay: boolean): DriveSettings {
    if (this.disposed) throw new MargoError('disposed', 'WeatherDrive is disposed; attach a new WeatherDrive');
    const o = this.options;
    validateDrive(o);
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid WeatherDrive delta; pass a finite delta of 0 or more seconds.');
    if (o.advance ?? true) {
      const w = o.weather;
      if (replay && w.advanceTime) w.advanceTime(delta);
      else w.update?.(delta);
    }
    const found = (o.auto ?? true) ? this.engine?.plugins : undefined,
      sands =
        o.blownSand !== undefined
          ? list(o.blownSand)
          : found
            ? ([...found]
                .filter(
                  ([n, p]) =>
                    n.startsWith('blown-sand:') &&
                    typeof (p as BlownSandTarget).options === 'object' &&
                    (p as BlownSandTarget).options !== null,
                )
                .map(([, p]) => p) as BlownSandTarget[])
            : [];
    let state = o.weather.state;
    if (sands.length > 0 && (o.dustFromSand ?? true)) {
      let raised = 0;
      for (const sand of sands) raised = Math.max(raised, dustFromWind(state.wind, sand.options.threshold));
      if (raised > state.dust) state = { ...state, dust: raised };
    }
    const fires =
      o.fires !== undefined
        ? list(o.fires)
        : found
          ? ([...found]
              .filter(([n, p]) => n.startsWith('fire-front:') && typeof (p as FireTarget).smokeEmission === 'number')
              .map(([, p]) => p) as FireTarget[])
          : [];
    if (fires.length > 0 && (o.smokeFromFire ?? true)) {
      let grams = 0;
      for (const fire of fires) grams += fire.smokeEmission;
      const raised = smokeFromEmission(grams, state.wind, o.smokeWidth);
      if (raised > state.smoke) state = { ...state, smoke: raised };
    }
    // The columns' glow takes the noon sun the haze is referred to (KB-VFX-GLOWUNITS1), for a front that has the setter.
    const litSky = o.sky ?? (found?.get(FOUND.sky) as SkyTarget | undefined);
    if (litSky) {
      const noon = litSky.options.lighting?.intensity ?? 1;
      if (noon > 0) for (const fire of fires) if ('noon' in fire && fire.noon !== noon) fire.noon = noon;
    }
    // The flames' light on the haze over them (KB-WEATHER-FIREHAZE1), from the fronts that report their radiant power.
    // Fires that say where they burn light the sky's pall and haze brightest over their sources and less away from them
    // (`fireLayerLight`, KB-SKY-PALLFALLOFF1); the power of the others lights them evenly (`fireHazeLight`).
    const scale = o.fireLight ?? 1,
      burning: FirePoint[] = [];
    let even = 0;
    for (const fire of scale > 0 ? fires : []) {
      const p = fire.radiantPower;
      if (!(typeof p === 'number' && Number.isFinite(p) && p > 0)) continue;
      const placed = fire.segments?.().filter(isPlaced) ?? [];
      let heat = 0;
      for (const s of placed) heat += s.heat;
      if (heat > 0) for (const s of placed) burning.push({ x: s.x, y: s.y, z: s.z, power: (p * s.heat) / heat });
      else even += p;
    }
    const fireLight = even > 0 ? fireHazeLight(even, o.smokeWidth) : undefined;
    if (fireLight) for (let i = 0; i < 3; i++) fireLight[i] *= scale;
    // The same light on the pall over each fire lights its own columns (KB-VFX-COLUMNAMBIENT1): the spots' light at its
    // heat-weighted centre, plus the even light, so a column over a burning front glows with the pall round it.
    const clusters = clusterFires(burning);
    for (const fire of fires) {
      if (!('air' in fire)) continue;
      const placed = scale > 0 ? (fire.segments?.().filter(isPlaced) ?? []) : [];
      let heat = 0,
        cx = 0,
        cz = 0;
      for (const s of placed) {
        heat += s.heat;
        cx += s.x * s.heat;
        cz += s.z * s.heat;
      }
      const air: [number, number, number] = fireLight ? [fireLight[0], fireLight[1], fireLight[2]] : [0, 0, 0];
      if (heat > 0)
        for (const c of clusters) {
          const l = fireLayerLight(c.power, c.spread, Math.hypot(c.x - cx / heat, c.z - cz / heat));
          for (let i = 0; i < 3; i++) air[i]! += l[i]! * scale;
        }
      fire.air = air[0] > 0 || air[1] > 0 || air[2] > 0 ? air : undefined;
    }
    const spots = clusters.map((s) => ({
      light: fireLayerLight(s.power, s.spread).map((v) => v * scale),
      x: s.x,
      z: s.z,
      height: s.y + SMOKE_LAYER_DEPTH / 2,
      reach: Math.hypot(SMOKE_LAYER_DEPTH / 2, s.spread),
    }));
    const here = o.listener?.position ?? o.position ?? [0, 0, 0];
    const eruptions =
      o.eruptions !== undefined
        ? list(o.eruptions)
        : found
          ? ([...found]
              .filter(([n, p]) => n.startsWith('eruption:') && typeof (p as EruptionTarget).visibility === 'function')
              .map(([, p]) => p) as EruptionTarget[])
          : [];
    if (eruptions.length > 0 && (o.ashFromEruption ?? true)) {
      // Each eruption's ash extinction at the camera (its visibility holds the clear air, taken off here); they add.
      let extinction = 0;
      for (const e of eruptions)
        extinction += Math.max(0, KOSCHMIEDER / e.visibility(here[0]!, here[2]!) - CLEAR_AIR_EXTINCTION);
      const raised = ashForExtinction(extinction);
      if (raised > state.ash) state = { ...state, ash: raised };
    }
    const coasts =
      o.water !== undefined
        ? list(o.water)
        : found
          ? ([...found].filter(([n]) => n.startsWith('water:')).map(([, p]) => p) as WaterTarget[])
          : [];
    if ((coasts.length > 0 || o.surf !== undefined) && (o.sprayFromSea ?? true)) {
      // The surf line given, else every sea's own breaker line (a Water with `terrain.heights`).
      const lines =
        o.surf !== undefined
          ? [o.surf]
          : coasts.flatMap((w) => (typeof w.breakerLine === 'function' ? w.breakerLine() : []));
      let distance = Infinity;
      for (const line of lines)
        if (line.length > 0) distance = Math.min(distance, surfDistance(line, here[0]!, here[2]!));
      const raised = sprayFromWind(state.wind, distance);
      if (raised > state.spray) state = { ...state, spray: raised };
    }
    if (fires.length > 0 && (o.fuelMoistureFromWeather ?? true))
      this.wetFuel(fires, state, delta, o.sky ?? (found?.get(FOUND.sky) as SkyTarget | undefined));
    const s = driveSettings(state, o.windAloft),
      find = <T extends { options: object }>(name: string): T | undefined => {
        const p = found?.get(name) as T | undefined;
        return p !== undefined && p !== (this as object) && typeof p.options === 'object' && p.options !== null
          ? p
          : undefined;
      },
      skyTarget = o.sky ?? find<SkyTarget>(FOUND.sky),
      cloudTargets = o.clouds !== undefined ? list(o.clouds) : list(find<CloudLayerTarget>(FOUND.clouds)),
      volumeTargets = o.fogVolumes !== undefined ? list(o.fogVolumes) : list(find<FogVolumeTarget>(FOUND.fogVolumes)),
      rainTarget = o.precipitation ?? find<PrecipitationTarget>(FOUND.precipitation),
      hailTarget = o.hail ?? find<PrecipitationTarget>(FOUND.hail);
    if (skyTarget) {
      const sky = skyTarget.options;
      if (sky.clouds) put(sky.clouds, 'coverage', s.coverage);
      if (sky.fog) {
        put(sky.fog, 'density', Math.min(1, sky.fog.falloff === 'exp' ? s.extinction : s.squaredDensity));
        this.tintFog(
          sky.fog,
          state,
          s.extinction,
          [o.dustLight ?? 1, o.smokeLight ?? 1, o.ashLight ?? 1, o.sprayLight ?? 1],
          skyTarget,
          fireLight,
          spots,
        );
      }
      this.dimSun(skyTarget, state, fireLight, spots, s.extinction);
    }
    const grounds =
      o.grounds !== undefined
        ? list(o.grounds)
        : found
          ? ([...found]
              .filter(
                ([n, p]) =>
                  (n.startsWith('ground-change:') || n.startsWith('terrain:rocks:')) &&
                  typeof (p as GroundTarget).look === 'object' &&
                  (p as GroundTarget).look !== null,
              )
              .map(([, p]) => p) as GroundTarget[])
          : [];
    for (const ground of grounds) if (!heldFromWeather(ground.look, 'rain')) ground.look.rain = state.rain;
    for (const sand of sands) {
      // Its wind: the state's mean wind and gustiness, written into one object of the drive's own while the layer has none
      // of a person's (unset, or a speed of 0).
      const now = sand.options.wind as { speed?: number } | undefined,
        mine = this.sandWinds.get(sand);
      if (
        !heldFromWeather(sand.options, 'wind') &&
        (now === undefined ||
          now === mine ||
          (typeof now === 'object' && now !== null && !('options' in now) && now.speed === 0))
      ) {
        const w = (now === mine && mine ? mine : {}) as { speed: number; direction: number; gust: number };
        w.speed = state.wind;
        w.direction = state.windDirection;
        w.gust = state.gust;
        this.sandWinds.set(sand, w);
        (sand.options as { wind?: unknown }).wind = w;
      }
      if (
        !heldFromWeather(sand.options, 'fog') &&
        (sand.options.fog === undefined || sand.options.fog === this.fogs.get(sand))
      ) {
        const fog = Math.min(1, s.extinction);
        this.fogs.set(sand, fog);
        sand.options.fog = fog;
      }
    }
    // The wind the field gives at the listener: rain, hail, fog and clouds all follow this one vector.
    const p = here,
      wind = o.weather.wind ? windAt(o.weather.wind, p[0], p[1], p[2], o.weather.time ?? 0) : undefined;
    for (const layer of cloudTargets) {
      // Each layer drifts with the field's direction at the wind of its own base height (`windProfile`: U10 (z / 10)^(1/7)),
      // or the state's mean wind without a field; `windAloft` gives a plain factor over the 10 m wind instead.
      const base = (layer.options as { bottom?: number }).bottom ?? 1500,
        k = o.windAloft ?? windProfile(1, base),
        drift: [number, number] =
          wind || o.windAloft === undefined
            ? wind
              ? [wind[0] * k, wind[1] * k]
              : driveSettings(state, undefined, base).cloudWind
            : s.cloudWind;
      // A storm's layer (a hurricane) owns its cover, density and turning cloud: the drive gives it the weather only, and
      // takes back the coverage, density and drift it wrote before the storm came (a value held by hand stays).
      if (layer.options.hurricane !== undefined || layer.options.type === 'hurricane') {
        put(layer.options, 'weather', state);
        for (const key of ['coverage', 'density', 'wind'] as const)
          if (!heldFromWeather(layer.options, key)) delete layer.options[key];
        continue;
      }
      putAll(layer.options, { weather: state, coverage: s.coverage, density: s.cloudDensity, wind: drift });
    }
    if (o.fog) put(o.fog, 'density', s.squaredDensity);
    // A fog volume given a `visibility` (which its `density` must not accompany) is an override: the drive leaves it.
    for (const volume of volumeTargets)
      if (volume.options.visibility === undefined) {
        put(volume.options, 'density', s.extinction);
        this.tintVolume(volume.options, state, s.extinction);
      }
    const blown = o.fogWind !== undefined ? list(o.fogWind) : o.fogVolumes === undefined ? volumeTargets : [],
      blow = blown.length > 0 && o.weather.wind !== undefined;
    if (wind) {
      const named = <T extends object>(prefix: string, test: (p: T) => boolean): T[] =>
          found ? ([...found].filter(([n, p]) => n.startsWith(prefix) && test(p as T)).map(([, p]) => p) as T[]) : [],
        scatters =
          o.scatter !== undefined
            ? list(o.scatter)
            : named<ScatterTarget>('scatter:', (p) => typeof p.options === 'object' && p.options !== null),
        grasses =
          o.grass !== undefined
            ? list(o.grass)
            : named<GrassTarget>('grass-field:', (p) => typeof p.windStrength === 'number');
      for (const sc of scatters) {
        const was = sc.options.wind;
        put(sc.options, 'wind', scatterWind(wind, was ? [was[0], was[1]] : undefined));
      }
      for (const g of grasses) {
        const w = grassWind(wind, g.windDirection);
        putAll(g, w);
      }
      const effects: VfxTarget[] =
        o.vfx !== undefined
          ? [...list(o.vfx)]
          : [
              ...named<VfxTarget>('vfx:', (p) => typeof p.setWind === 'function' && typeof p.options === 'object'),
              ...named<VfxTarget>(
                'fire-front:',
                (p) => typeof p.setWind === 'function' && typeof p.options === 'object',
              ),
            ];
      // The fires given by hand spread in the same wind as those found by name (a front stepped without an engine, as a
      // scene rolls a fire's past, is found by nobody).
      if (o.fires !== undefined)
        for (const f of list(o.fires) as unknown as VfxTarget[])
          if (typeof f.setWind === 'function' && !effects.includes(f)) effects.push(f);
      for (const effect of effects) {
        // A wind a person gave the effect (not the one this drive wrote, and not [0, 0], which is no wind) overrides the weather.
        const now = effect.options.wind;
        if (heldFromWeather(effect.options, 'wind')) continue;
        if (
          now !== undefined &&
          now !== this.winds.get(effect) &&
          !(Array.isArray(now) && now[0] === 0 && now[1] === 0)
        )
          continue;
        const own: [number, number] = [wind[0], wind[1]];
        this.winds.set(effect, own);
        effect.options.wind = own;
      }
    }
    // The sea follows the state's mean wind (not a gust of the field): its swell takes seconds to answer.
    const seaKey = state.wind.toFixed(4) + ',' + state.windDirection.toFixed(4);
    const seas =
      o.water !== undefined
        ? list(o.water)
        : found
          ? ([...found]
              .filter(([n, p]) => n.startsWith('water:') && typeof (p as WaterTarget).setWind === 'function')
              .map(([, p]) => p)
              .filter((p) => {
                const w = p as WaterTarget;
                return typeof w.options === 'object' && w.options !== null && w.options.waves === undefined;
              }) as WaterTarget[])
          : [];
    for (const sea of seas) {
      if (heldFromWeather(sea, 'wind') || heldFromWeather(sea.options, 'wind')) {
        this.seas.delete(sea);
        continue;
      }
      if (this.seas.get(sea) === seaKey) continue;
      this.seas.set(sea, seaKey);
      sea.setWind(
        state.wind > 1e-6
          ? { speed: state.wind, direction: [Math.sin(state.windDirection), Math.cos(state.windDirection)] }
          : { speed: 0 },
      );
    }
    // A sea that takes rain (a `Flood` from `@margoengine/water/flood`) gets the state's rain rate in mm/h, unless a person set its rain.
    for (const sea of seas) {
      const wet = sea as WaterTarget & { setRainRate?: (rate: number) => unknown };
      if (typeof wet.setRainRate !== 'function' || heldFromWeather(wet, 'rain')) {
        this.rains.delete(sea);
        continue;
      }
      if (this.rains.get(sea) === s.rainRate) continue;
      this.rains.set(sea, s.rainRate);
      wet.setRainRate(s.rainRate);
    }
    if (rainTarget || hailTarget || blow) {
      if (rainTarget) putSky(rainTarget.options, skyWeather(state, wind));
      if (hailTarget) putAll(hailTarget.options, hailSettings(state, wind));
      if (blow && wind) for (const volume of blown) put(volume.options, 'wind', [wind[0], 0, wind[1]]);
    }
    return (this.last = s);
  }

  // The fires' dead fuel follows the weather's (FuelMoistureModel): written into each class a person has not set (unset,
  // null or the value this drive wrote last); the sun's correction applies while the sky's sun is up (always without one).
  private wetFuel(fires: readonly FireTarget[], state: WeatherState, delta: number, sky: SkyTarget | undefined): void {
    const o = this.options;
    if (!this.fuel) this.fuel = new FuelMoistureModel({ start: o.fuelMoistureStart, timeScale: o.fuelTimeScale ?? 1 });
    this.fuel.timeScale = o.fuelTimeScale ?? 1;
    const day = sky?.sun === undefined || (sky.sun[1] ?? 1) > 0,
      now = this.fuel.step(state, delta, day);
    for (const fire of fires) {
      const f = fire.options as Record<string, unknown>,
        last = this.fuelWrote.get(fire);
      for (const key of ['moisture', 'moisture10', 'moisture100'] as const)
        if (
          !heldFromWeather(f, key) &&
          (f[key] === undefined || f[key] === null || (last !== undefined && f[key] === last[key]))
        )
          f[key] = now[key];
      this.fuelWrote.set(fire, now);
    }
  }

  // Dust, smoke, ash and spray give the sky fog their colour while together they are at least half the air's extinction,
  // each by its share of their extinction (one alone gives its own colour exactly), lit by the light that still reaches
  // the air through the smoke, ash and spray (`hazeLight`), so a thick layer darkens the haze; the colour the fog had
  // comes back when they are not. A colour a person set meanwhile is kept as the one to come back to. As the sun sets
  // the haze's sunlight hands over to the night's light on the air by the sky's own blend (`airLight`,
  // KB-WEATHER-NIGHTHAZE1), so the haze is moonlit at night, not the afternoon's. The fires below add their own light
  // (`fire`, `fireHazeLight`, KB-WEATHER-FIREHAZE1), so the haze over a burning valley glows orange at night.
  private tintFog(
    fog: SpotHolder & { color?: readonly [number, number, number]; lightDecay?: readonly [number, number, number] },
    state: WeatherState,
    extinction: number,
    lights: readonly number[],
    sky: SkyTarget,
    fire?: readonly number[],
    spots: readonly Spot[] = [],
  ): void {
    if (heldFromWeather(fog, 'color')) return this.writeSpots(fog, []);
    const record = this.fogColors.get(fog),
      parts = [
        dustExtinction(state.dust),
        smokeExtinction(state.smoke),
        ashExtinction(state.ash),
        sprayExtinction(state.spray),
      ],
      total = parts[0]! + parts[1]! + parts[2]! + parts[3]!;
    this.decayFog(fog, total > 0 && total >= 0.5 * extinction ? hazeLightDecay(state, extinction) : undefined);
    if (total > 0 && total >= 0.5 * extinction) {
      const colors = [dustColor, smokeColor, ashColor, sprayColor],
        color: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        if (parts[k] === 0) continue;
        const share = parts[k]! / total,
          c = colors[k]!(),
          lit = lights[k]!;
        for (let i = 0; i < 3; i++) color[i] += share === 1 ? c[i]! * lit : c[i]! * share * lit;
      }
      const light = airLight(sky, state),
        k = hazeUnits(sky);
      // The haze round each source takes its light in the haze's own colour (KB-SKY-PALLFALLOFF1).
      this.writeSpots(
        fog,
        spots.map(({ light: on, x, z, reach }) => ({
          color: tinted(color, on).map((c) => c * k) as [number, number, number],
          x,
          z,
          reach,
        })),
      );
      const original = record && fog.color === record.wrote ? record.original : fog.color;
      // A sky that draws the whole load (its pall, KB-AIR-SKYLIGHT1) is where a long path through the haze ends, so the
      // fog takes the sky's own radiance toward each ray, as with no load (KB-SKY-HAZEHORIZON1).
      if (parts[0] === 0 && drawsLoad(sky)) {
        this.fogColors.set(fog, { original, wrote: undefined });
        delete fog.color;
        return;
      }
      for (let i = 0; i < 3; i++) color[i] *= ((light ? light[i]! : 1) + (fire ? fire[i]! : 0)) * k;
      this.fogColors.set(fog, { original, wrote: color });
      fog.color = color;
    } else {
      this.writeSpots(fog, []);
      if (!record) return;
      this.fogColors.delete(fog);
      if (fog.color === record.wrote) {
        if (record.original === undefined) delete fog.color;
        else fog.color = record.original as readonly [number, number, number];
      }
    }
  }

  // The haze's light below the eye (`lightDecay`, KB-SKY-HAZEBELOW1), written while the load colours the fog and given
  // back as the colour is: what the fog had comes back when the load leaves; one a person set meanwhile, or one held by a
  // setting, is left alone.
  private decayFog(fog: { lightDecay?: readonly [number, number, number] }, decay: [number, number, number] | undefined): void {
    if (heldFromWeather(fog, 'lightDecay')) return;
    const record = this.fogDecays.get(fog);
    if (decay) {
      const original = record && fog.lightDecay === record.wrote ? record.original : fog.lightDecay;
      this.fogDecays.set(fog, { original, wrote: decay });
      fog.lightDecay = decay;
    } else if (record) {
      this.fogDecays.delete(fog);
      if (fog.lightDecay !== record.wrote) return;
      if (record.original === undefined) delete fog.lightDecay;
      else fog.lightDecay = record.original as readonly [number, number, number];
    }
  }

  // The fires' spots on the sky's fog or air (`fireSpots`), written and given back as the other colours are: what it had
  // comes back when no fire says where it burns or the load leaves; a list a person set meanwhile, or one held by a
  // setting, is left alone.
  private writeSpots(target: SpotHolder, next: readonly SkyFireSpotTarget[]): void {
    if (heldFromWeather(target, 'fireSpots')) return;
    const record = this.spotLists.get(target);
    if (next.length) {
      const original = record && target.fireSpots === record.wrote ? record.original : target.fireSpots;
      this.spotLists.set(target, { original, wrote: next });
      target.fireSpots = next;
    } else if (record) {
      this.spotLists.delete(target);
      if (target.fireSpots !== record.wrote) return;
      if (record.original === undefined) delete target.fireSpots;
      else target.fireSpots = record.original;
    }
  }

  // Dust, smoke, ash and spray give a fog volume's scattering colour their own: each load's colour (the diffusion colour
  // the sky fog takes) by its share of the volume's extinction, the rest of the air (clear air, fog, rain, snow) white,
  // so the colour moves smoothly with the load. The volume is lit by the scene's own lights, so no haze light is put on
  // it. With no load the colour it had comes back (an unset one is unset again), so load 0 is bit for bit; a colour held
  // by a setting (`air.color` of `@margoengine/environment/settings`) is never written, and a colour a person set
  // meanwhile is kept as the one to come back to.
  private tintVolume(options: FogVolumeTarget['options'], state: WeatherState, extinction: number): void {
    if (heldFromWeather(options, 'color')) return;
    const record = this.fogColors.get(options),
      parts = [
        dustExtinction(state.dust),
        smokeExtinction(state.smoke),
        ashExtinction(state.ash),
        sprayExtinction(state.spray),
      ],
      total = parts[0]! + parts[1]! + parts[2]! + parts[3]!;
    if (total > 0) {
      const all = Math.max(extinction, total),
        colors = [dustColor, smokeColor, ashColor, sprayColor],
        color: [number, number, number] = [all - total, all - total, all - total];
      for (let k = 0; k < 4; k++) {
        if (parts[k] === 0) continue;
        const c = colors[k]!();
        for (let i = 0; i < 3; i++) color[i] += parts[k]! * c[i]!;
      }
      for (let i = 0; i < 3; i++) color[i] /= all;
      const original = record && options.color === record.wrote ? record.original : options.color;
      this.fogColors.set(options, { original, wrote: color });
      (options as { color?: readonly [number, number, number] }).color = color;
    } else if (record) {
      this.fogColors.delete(options);
      if (options.color === record.wrote) {
        if (record.original === undefined) delete (options as { color?: unknown }).color;
        else (options as { color?: unknown }).color = record.original;
      }
    }
  }

  // Smoke dims and reddens the sun, ash and spray dim it grey: the sky's sun colour (above the air) times the share of the
  // direct sun the air lets through at the sun's elevation (`sunTransmittance`). With none of them the sky is not
  // touched, so its values stay bit for bit; when they clear the colour it had comes back. A colour a person set
  // meanwhile is kept as the one to come back to.
  private dimSun(
    sky: SkyTarget,
    state: WeatherState,
    fire?: readonly number[],
    spots: readonly Spot[] = [],
    extinction = 0,
  ): void {
    const o = sky.options,
      loaded = state.smoke > 0 || state.ash > 0 || state.spray > 0;
    let atm = o.atmosphere;
    if (atm === undefined && loaded && (o.look !== undefined || sky.airControls === true)) atm = o.atmosphere = {};
    if (atm === undefined) return;
    this.lightSky(atm, state, sky, loaded, fire);
    this.layerSky(atm, state, loaded);
    // Straight over each source the layer sends back down the light on it times its reflectance, as the even share does.
    const back = hazeReflectance(state);
    this.writeSpots(
      atm,
      (loaded ? spots : []).map(({ light, x, z, height, reach }) => ({
        color: tinted(back, light),
        x,
        z,
        height,
        reach,
      })),
    );
    // A low ray sees the lit layer as far across as the haze's light comes from (the sky fog's 2 / density).
    this.writeSight(atm, loaded && spots.length && extinction > 0 ? Math.min(1e6, 2 / extinction) : undefined);
    if (heldFromWeather(atm, 'sunColor')) return;
    const record = this.sunColors.get(atm);
    if (loaded) {
      const t = sunTransmittance(state, sunElevation(sky)),
        original = (record && atm.sunColor === record.wrote ? record.original : atm.sunColor) as
          | readonly [number, number, number]
          | undefined,
        base = original ?? [1, 1, 1],
        color: readonly [number, number, number] = [base[0] * t[0], base[1] * t[1], base[2] * t[2]];
      this.sunColors.set(atm, { original, wrote: color });
      atm.sunColor = color;
    } else if (record) {
      this.sunColors.delete(atm);
      if (atm.sunColor === record.wrote) {
        if (record.original === undefined) delete atm.sunColor;
        else atm.sunColor = record.original as readonly [number, number, number];
      }
    }
  }

  // `atmosphere.fireSight` with the spots, written and given back as they are.
  private writeSight(atm: SpotHolder, next: number | undefined): void {
    if (heldFromWeather(atm, 'fireSight')) return;
    const record = this.sights.get(atm);
    if (next !== undefined) {
      const original = record && atm.fireSight === record.wrote ? record.original : atm.fireSight;
      this.sights.set(atm, { original, wrote: next });
      atm.fireSight = next;
    } else if (record) {
      this.sights.delete(atm);
      if (atm.fireSight !== record.wrote) return;
      if (record.original === undefined) delete atm.fireSight;
      else atm.fireSight = record.original;
    }
  }

  // The sky under the load (KB-AIR-SKYLIGHT1): the sun's light the smoke, ash and spray scatter down, hazeLight less the
  // direct share t, times the sine of the sun's elevation (the sun on level ground), lights the day sky evenly as a
  // layer lit from above does (`scatteredLight`, a share of the zenith sun on the ground, times the sun colour above the
  // air), while `sunColor` takes the dome down by t with the sun. So under a thick load the dome, its reflections, its
  // light on the scene and a fog volume's ambient are the layer's dim grey glow, not the clear sky. Cleared as sunColor is.
  // At night the moon and twilight light the layer from above in the same way (each its light in units of the noon sun,
  // as the haze's night light takes it, `airLight`), and the fires under it light it from below: it sends back down
  // their light times its reflectance (`hazeReflectance`), so a pall over a burning valley glows orange (KB-SKY-NIGHTPALL1).
  private lightSky(
    atm: NonNullable<SkyTarget['options']['atmosphere']>,
    state: WeatherState,
    sky: SkyTarget,
    loaded: boolean,
    fire?: readonly number[],
  ): void {
    if (heldFromWeather(atm, 'scatteredLight')) return;
    const record = this.skyLights.get(atm);
    if (loaded) {
      const elevation = sunElevation(sky),
        t = sunTransmittance(state, elevation),
        light = hazeLight(state, elevation),
        up = Math.max(0, Math.sin(elevation)),
        sunRecord = this.sunColors.get(atm),
        above = ((sunRecord && atm.sunColor === sunRecord.wrote ? sunRecord.original : atm.sunColor) ?? [
          1, 1, 1,
        ]) as readonly number[],
        original = (record && atm.scatteredLight === record.wrote ? record.original : atm.scatteredLight) as
          | readonly [number, number, number]
          | undefined,
        base = original ?? [0, 0, 0],
        night = [0, 0, 0],
        reference = sky.options.lighting?.intensity ?? 1;
      for (const source of [sky.moonUnderClouds, sky.twilightLight]) {
        const strength = source ? (source.direction[3] ?? 0) : 0,
          y = source ? Math.min(1, Math.max(-1, source.direction[1] ?? 1)) : 0;
        if (!source || !(strength > 0) || !(y > 0) || !(reference > 0)) continue;
        const e = Math.asin(y),
          through = hazeLight(state, e),
          direct = sunTransmittance(state, e);
        for (let i = 0; i < 3; i++)
          night[i] += (Math.max(0, through[i]! - direct[i]!) * y * strength * (source.radiance[i] ?? 0)) / reference;
      }
      if (fire) {
        const back = hazeReflectance(state);
        for (let i = 0; i < 3; i++) night[i] += back[i]! * fire[i]!;
      }
      const color = [0, 1, 2].map((i) =>
        Math.min(4, base[i]! + Math.max(0, light[i]! - t[i]!) * up * above[i]! + night[i]!),
      ) as unknown as readonly [number, number, number];
      this.skyLights.set(atm, { original, wrote: color });
      atm.scatteredLight = color;
    } else if (record) {
      this.skyLights.delete(atm);
      if (atm.scatteredLight === record.wrote) {
        if (record.original === undefined) delete atm.scatteredLight;
        else atm.scatteredLight = record.original as readonly [number, number, number];
      }
    }
  }

  // The night's own light (stars, moon, twilight, the clouds above) is seen through the smoke, ash and spray: the sky's
  // `layerTransmittance` is the direct share straight up (`sunTransmittance` at 90 degrees), which the sky takes along
  // each ray (KB-SKY-NIGHTPALL1). Untouched with no load; cleared as sunColor is.
  private layerSky(atm: NonNullable<SkyTarget['options']['atmosphere']>, state: WeatherState, loaded: boolean): void {
    if (heldFromWeather(atm, 'layerTransmittance')) return;
    const record = this.layerSkies.get(atm);
    if (loaded) {
      const t = sunTransmittance(state, Math.PI / 2),
        original = (record && atm.layerTransmittance === record.wrote ? record.original : atm.layerTransmittance) as
          | readonly [number, number, number]
          | undefined,
        base = original ?? [1, 1, 1],
        color: readonly [number, number, number] = [base[0] * t[0], base[1] * t[1], base[2] * t[2]];
      this.layerSkies.set(atm, { original, wrote: color });
      atm.layerTransmittance = color;
    } else if (record) {
      this.layerSkies.delete(atm);
      if (atm.layerTransmittance === record.wrote) {
        if (record.original === undefined) delete atm.layerTransmittance;
        else atm.layerTransmittance = record.original as readonly [number, number, number];
      }
    }
  }

  /** Engine plugin hooks. */
  setup(engine: { removePlugin(name: string): void }): void {
    if (this.disposed) throw new MargoError('disposed', 'WeatherDrive is disposed; attach a new WeatherDrive');
    this.engine = engine as DriveEngine;
  }
  onPreUpdate(delta: number): void {
    // An engine that runs this drive steps its weather every frame: stepped again with advanceTime between two of its
    // frames, and again between the next two, the weather runs twice (or more) as fast as the clock that drives both
    // (KB-LOOK-TV-SHIMMER2: a shot page called scene.advanceTime each sub-frame, so the gale's gusts and the fire ran at
    // double speed). One burst between frames (rolling a fire's past, a seek after resetTime) is allowed.
    if (delta > 0) {
      this.doubled = this.stepped ? this.doubled + 1 : 0;
      this.stepped = false;
      if (this.doubled >= 2)
        throw new MargoError(
          'state',
          'WeatherDrive stepped with advanceTime between engine frames runs its weather too fast; leave it to the engine, or attach it with advance: false',
        );
    }
    this.update(delta);
  }

  /** Stops driving; the targets keep their last values. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf?.(this)?.removePlugin(this.name);
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * The share of the noon sun's light that lights the haze, red, green and blue, or undefined when it is all of it (a day
 * sky with no smoke, ash or spray, so a dust haze keeps its colour bit for bit). By day it is the light that reaches the
 * air through the load ({@link hazeLight} at the sun's elevation). The sky hands its light over from the sun to the
 * night by its blend n (`Sky.nightFactor`: 0 with the sun 4.6 degrees up, 1 at 6.9 degrees down), and the haze does
 * the same: (1 - n) times the day share, plus n times the night's light on the air, the moon under the clouds and the
 * twilight sky (`Sky.moonUnderClouds`, `Sky.twilightLight`, each its intensity times its colour, through the load at its
 * own elevation) over the sky's `lighting.intensity`, the noon sun the haze colours are referred to. Airlight is the
 * haze's diffusion colour times the light on it (Koschmieder 1924; H. W. Jensen, F. Durand, M. M. Stark, S. Premoze,
 * J. Dorsey and P. Shirley, "A Physically-Based Night Sky Model", SIGGRAPH 2001: the night's airlight is the moon's and
 * the sky's light scattered by the same air), so a sky with no night lights gives a black haze at night.
 */
function airLight(sky: SkyTarget, state: WeatherState): [number, number, number] | undefined {
  const loaded = state.smoke > 0 || state.ash > 0 || state.spray > 0,
    night = nightBlend(sky),
    day: [number, number, number] | undefined = loaded ? hazeLight(state, sunElevation(sky)) : undefined;
  if (night === 0) return day;
  const reference = sky.options.lighting?.intensity ?? 1,
    light: [number, number, number] = [0, 0, 0];
  for (const source of [sky.moonUnderClouds, sky.twilightLight]) {
    const strength = source ? (source.direction[3] ?? 0) : 0;
    if (!source || !(strength > 0)) continue;
    const through = loaded
      ? hazeLight(state, Math.asin(Math.min(1, Math.max(-1, source.direction[1] ?? 1))))
      : undefined;
    for (let i = 0; i < 3; i++)
      light[i] += (strength * (source.radiance[i] ?? 0) * (through ? through[i]! : 1)) / reference;
  }
  for (let i = 0; i < 3; i++) light[i] = (1 - night) * (day ? day[i]! : 1) + night * (reference > 0 ? light[i]! : 0);
  return light;
}

// The radiance the haze's light shares are drawn in (KB-SKY-PALLHAZE1): a share of 1 is the zenith sun's light on a
// white surface, E / pi, which in the sky's units is its zenith sun over pi (as the sky draws its `scatteredLight` glow,
// look.ts) at the sky's exposure and picture scale, so a long path through the haze ends at the sky's own horizon
// (Koschmieder 1924). Until 2026-11-27 the share was drawn as engine radiance as it was, about 2.2 times darker than the
// sky behind it under a sun of 5, so every far ridge in a pall was a dark cut-out. A sky without `zenithSun` keeps 1.
function hazeUnits(sky: SkyTarget): number {
  const zenith = sky.zenithSun;
  if (typeof zenith !== 'number' || !(zenith > 0)) return 1;
  return (
    (zenith * (sky.options.atmosphere?.sunIntensity ?? 1) * 2 ** (sky.options.exposure ?? 0) * (sky.pictureScale ?? 1)) /
    Math.PI
  );
}

// Whether the sky draws the smoke, ash and spray it is under (`dimSun`: an atmosphere it has, or one the drive makes for
// a sky with a look or air controls, whose glow and sun colour the drive writes), so its radiance toward the horizon is
// the haze's own airlight at the end of a long path (KB-SKY-HAZEHORIZON1).
function drawsLoad(sky: SkyTarget): boolean {
  const o = sky.options,
    atm = o.atmosphere;
  if (atm === undefined) return o.look !== undefined || sky.airControls === true;
  return !heldFromWeather(atm, 'scatteredLight') && !heldFromWeather(atm, 'sunColor');
}

// The sky's own day/night blend: its nightFactor, else the same smoothstep of its sun (base.ts, (sun.y + 0.12) / 0.2).
function nightBlend(sky: SkyTarget): number {
  if (typeof sky.nightFactor === 'number' && Number.isFinite(sky.nightFactor))
    return Math.min(1, Math.max(0, sky.nightFactor));
  const y = sky.sun ? (sky.sun[1] ?? 1) : 1,
    t = Math.max(0, Math.min(1, (y + 0.12) / 0.2));
  return 1 - t * t * (3 - 2 * t);
}

/** The sun's elevation in radians over the horizon from the sky's sun direction (straight up when it has none). */
function sunElevation(sky: SkyTarget): number {
  return Math.asin(sky.sun ? Math.min(1, Math.max(-1, sky.sun[1] ?? 1)) : 1);
}

/** A source's light straight over it (a share of the noon sun, RGB), where, the layer's lit height and its reach. */
interface Spot {
  light: number[];
  x: number;
  z: number;
  height: number;
  reach: number;
}

/** A colour times a light, each channel at most 4 (the sky's limit). */
const tinted = (color: readonly number[], light: readonly number[]): [number, number, number] => [
  Math.min(4, color[0]! * light[0]!),
  Math.min(4, color[1]! * light[1]!),
  Math.min(4, color[2]! * light[2]!),
];

/** A segment that can be placed: finite, with heat. */
const isPlaced = (s: { x: number; y: number; z: number; heat: number }): boolean =>
  s.heat > 0 && [s.x, s.y, s.z, s.heat].every(Number.isFinite);

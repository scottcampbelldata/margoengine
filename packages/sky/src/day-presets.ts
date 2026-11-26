// Day presets: four times of day as Sky options and the light that goes with them. The sun's colour and strength are
// not stored here: they come from the sky's own transmittance (`sunlight` in @margoengine/sky), so the light a preset
// gives always matches the sky it draws. What each preset stores is where the sun is, how hazy and cloudy the air is,
// how strong the direct sun is overhead and the least diffuse light any side receives.
import { overcastShare, sunDirectionFromAngles, sunlight } from './base.js';
import type { SkyOptions } from './base.js';

/** Three numbers: a direction or a linear RGB colour. */
export type Vec3 = readonly [number, number, number];

/** The preset names, in the order of {@link DAY_PRESETS}. */
export const dayPresetNames = ['noon', 'goldenHour', 'overcast', 'dawn'] as const;
/** One of {@link dayPresetNames}. */
export type DayPresetName = (typeof dayPresetNames)[number];

/** What a day preset holds. Angles in degrees; colours linear RGB. */
export interface DayPreset {
  /** Compass angle of the sun: 0 is +Z (south), 90 is +X (east), 270 is -X (west); as `@margoengine/sky/sun`. */
  readonly azimuth: number;
  /** Height of the sun above the horizon, -90 to 90. */
  readonly elevation: number;
  /** Haze of the air (Sky's `turbidity`, 2 clear to 10 hazy). */
  readonly turbidity: number;
  /** Cloud sheet coverage 0 to 1; 0 draws no cloud sheet. */
  readonly clouds: number;
  /** Exposure of the sky backdrop in stops (Sky's `exposure`); lit meshes are not changed by it. */
  readonly exposure: number;
  /** Direct sun strength with the sun overhead (Sky's `lighting.intensity`); the air dims and warms it lower down. */
  readonly intensity: number;
  /** Least diffuse light any side receives by day (Sky's `lighting.ambient.day`). */
  readonly ambient: Vec3;
}

// Margo design values. The sun heights follow the usual definitions: a summer noon at mid latitudes (about 70
// degrees), the photographers' golden hour (the sun below about 6 degrees, here 5 in the west) and dawn as the sun
// clears the eastern horizon (1 degree). Overcast follows the CIE standard overcast sky (CIE S 011/E:2003, type 1):
// the overcast deck (the cloud sheet at full cover) hides the sun's disc, so no direct light, and gives a nearly even,
// grey diffuse light from the whole sky. Above the deck the sun is the clear day's (strength 5); the deck passes the
// two-stream share of it (clouds.ts), and the sky, 0.6 stops darker, lights the scene with its own picture: the
// overcast ground then gets about a fifth of the clear noon ground's light (0.2 measured by night-check day-presets,
// 2026-11-17), as daylight measurements give (horizontal illuminance about 10 to 25 klux under overcast against about
// 100 klux on a clear summer noon). Clear-day sun strength 5 makes direct sun about four fifths of the noon ground's light. The diffuse floors are tinted toward what lights shadows at each time: blue sky at noon,
// grey cloud when overcast, the warm low sky at golden hour and the cool twilight sky at dawn. A floor stays under the
// light the ground reflects onto a surface facing down (Sky `lighting.ground`, about a fifth of the level ground's), so
// the sky's own light keeps its direction: the overcast floor was 0.26 to 0.29, above the light of the sky's zenith on
// a winter afternoon, which lit every side alike (an eye's lower white as bright as its middle, KB-SKY-FLOOR1).
const preset = (p: DayPreset): DayPreset => Object.freeze({ ...p, ambient: Object.freeze([...p.ambient]) as Vec3 });
/** The four day presets. Frozen; copy one with `{...DAY_PRESETS.noon, elevation: 60}` to make another. */
export const DAY_PRESETS: Readonly<Record<DayPresetName, DayPreset>> = Object.freeze({
  noon: preset({
    azimuth: 0,
    elevation: 70,
    turbidity: 2.2,
    clouds: 0,
    exposure: 0,
    intensity: 5,
    ambient: [0.07, 0.08, 0.1],
  }),
  goldenHour: preset({
    azimuth: 270,
    elevation: 5,
    turbidity: 3,
    clouds: 0.2,
    exposure: 0.5,
    intensity: 5,
    ambient: [0.06, 0.05, 0.045],
  }),
  overcast: preset({
    azimuth: 20,
    elevation: 45,
    turbidity: 6,
    clouds: 1,
    exposure: -0.6,
    intensity: 5,
    ambient: [0.03, 0.031, 0.033],
  }),
  dawn: preset({
    azimuth: 90,
    elevation: 1,
    turbidity: 2.6,
    clouds: 0.1,
    exposure: 1,
    intensity: 5,
    ambient: [0.035, 0.04, 0.065],
  }),
});

const NIGHT_FLOOR: Vec3 = [0.01, 0.015, 0.03];

/** A preset name or a {@link DayPreset} (yours or a changed copy of one). */
export type DayPresetInput = DayPresetName | DayPreset;

const resolve = (input: DayPresetInput): DayPreset => {
  if (typeof input === 'string') {
    if (!Object.hasOwn(DAY_PRESETS, input))
      throw new RangeError(`Unknown day preset "${input}"; use one of ${dayPresetNames.join(', ')}.`);
    return DAY_PRESETS[input];
  }
  const p = input;
  const ok = (v: unknown, low: number, high: number) => typeof v === 'number' && v >= low && v <= high;
  if (
    typeof p !== 'object' ||
    p === null ||
    !ok(p.azimuth, -360, 360) ||
    !ok(p.elevation, -90, 90) ||
    !ok(p.turbidity, 1, 10) ||
    !ok(p.clouds, 0, 1) ||
    !ok(p.exposure, -16, 16) ||
    !ok(p.intensity, 0, 1e6) ||
    !Array.isArray(p.ambient) ||
    p.ambient.length !== 3 ||
    !p.ambient.every((v) => ok(v, 0, 1e6))
  )
    throw new RangeError(
      'Invalid day preset; give azimuth -360..360, elevation -90..90, turbidity 1..10, clouds 0..1, exposure -16..16, intensity >= 0 and three ambient values >= 0.',
    );
  return p;
};

const direction = (p: DayPreset): [number, number, number] => {
  const d = sunDirectionFromAngles(p.azimuth, p.elevation);
  return [d[0], d[1], d[2]];
};

/**
 * Sky options for a preset: pass them to `new Sky(..)` or `Sky.attach(engine, ..)` from `@margoengine/sky` (the root
 * `Sky`, which has the clouds and lighting features these use). The clock is held (`timeScale: 0`) and the sun set by
 * `sunDirection`; the sky's `lighting` drives the engine's sun from it, dimmed and warmed by the sky's air. A fresh
 * object each call, so change it freely.
 * @throws RangeError for an unknown name or an invalid preset.
 * @example
 * const sky = Sky.attach(engine, dayPreset('goldenHour'));
 */
export function dayPreset(input: DayPresetInput): SkyOptions {
  const p = resolve(input);
  const options: SkyOptions = {
    sunDirection: direction(p),
    timeScale: 0,
    turbidity: p.turbidity,
    exposure: p.exposure,
    lighting: {
      intensity: p.intensity,
      ambient: { day: [p.ambient[0], p.ambient[1], p.ambient[2]], night: [...NIGHT_FLOOR] },
    },
  };
  if (p.clouds > 0) options.clouds = { coverage: p.clouds };
  // The sun below the horizon (KB-SCENES-NIGHTSUN1): the sky draws the night (stars and a phased moon, `night` with its
  // defaults) and the moon lights the scene with the sky's own moonlight (`lighting.moon: {}`, Krisciunas and Schaefer
  // 1991 lux with the night's blue shift), which takes over from the sun as it sets. With the sun up nothing changes,
  // so no day preset's sky moves.
  if (p.elevation < 0) {
    options.night = {};
    options.lighting!.moon = {};
  }
  return options;
}

/**
 * Switches a running sky to a preset: writes the preset's options into `sky.options` (read every frame), removing a
 * cloud sheet the preset has none of. Other options (fog, night, model) are kept.
 * @throws RangeError for an unknown name or an invalid preset.
 */
export function applyDayPreset(sky: { readonly options: SkyOptions }, input: DayPresetInput): void {
  const options = dayPreset(input);
  if (!options.clouds) delete sky.options.clouds;
  Object.assign(sky.options, options);
}

/** The light of a preset, for a scene that lights itself instead of through the sky's `lighting`. */
export interface DayLight {
  /** Unit world vector toward the sun. */
  readonly direction: Vec3;
  /** Sun colour, linear RGB with its largest channel 1. */
  readonly color: Vec3;
  /** Sun strength: the preset's `intensity` times the share of sunlight the air lets through (0 once it has set). */
  readonly intensity: number;
  /** Least diffuse light any side receives. */
  readonly ambient: Vec3;
}

/**
 * The sun a preset gives, worked out as the sky does (its transmittance at ground level), so it is what
 * `dayPreset(..)`'s `lighting` drives into the engine on the first frame: `color` is the engine light's radiance and
 * `intensity` its strength.
 * @throws RangeError for an unknown name or an invalid preset.
 */
export function dayLight(input: DayPresetInput): DayLight {
  const p = resolve(input),
    d = direction(p),
    s = sunlight(d[1], 0.001, p.turbidity),
    peak = Math.max(s[0], s[1], s[2]);
  const color: Vec3 = peak > 0 ? [s[0] / peak, s[1] / peak, s[2] / peak] : [1, 1, 1];
  return Object.freeze({
    direction: Object.freeze(d),
    color: Object.freeze(color),
    // The overcast deck hides the sun (Sky does the same): no direct light under a full overcast.
    intensity: p.intensity * peak * (1 - overcastShare(p.clouds)),
    ambient: Object.freeze([...p.ambient] as unknown as Vec3),
  });
}

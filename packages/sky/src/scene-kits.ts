// Scene kits: the values of several packages chosen together for one kind of scene, so a scene built from them looks
// right with no tuning and every part agrees with the others (one moon, fog as thick as the snowfall, a grade for the
// light the kit gives). A kit is plain data: the scene attaches each package with its part. `snowNight` is the first,
// a snowbound night with a lit interior: moonlit sky, falling snow, snow cover, the snow's bounce light, froxel fog, a
// hearth fire with embers and kettle steam, firelight, bloom and an AgX grade. `whiteout` is a blizzard at dusk with one
// lit window.
import type { SkyOptions } from './index.js';
import type { WeatherOptions } from './weather.js';
import type { TonemapOptions } from '@margoengine/tonemap';
import { moonlight } from '@margoengine/sky/moonlight';
import { SUN_ILLUMINANCE } from './twilight.js';
import { flameLight, hurricaneLantern } from '@margoengine/clustered/flicker';

type Vec3 = readonly [number, number, number];
type Color = readonly [number, number, number, number];

/** Snowfall intensity, by the visibility it leaves (Federal Meteorological Handbook No. 1, snow intensity). */
export type Snowfall = 'light' | 'moderate' | 'heavy';
/** The snowfall names, lightest first. */
export const snowfallNames: readonly Snowfall[] = Object.freeze(['light', 'moderate', 'heavy'] as const);

/** Snow cover for `Snow` (`@margoengine/weather/snow`). */
export interface KitSnowCover {
  readonly cover: number;
  readonly depth: number;
  readonly variation: number;
  readonly drift: number;
}
/** Froxel fog for `VolumetricFog` (`@margoengine/environment/volumetric`); scene-specific parts (depth, lights, shadows) are the scene's. */
export interface KitFog {
  readonly density: number;
  readonly heightFalloff: number;
  readonly height: number;
  readonly anisotropy: number;
  readonly color: Vec3;
  readonly ambient: Vec3;
  readonly multipleScattering: number;
  readonly noise: number;
  readonly noiseScale: number;
  readonly wind: Vec3;
  readonly range: number;
}
/** A particle effect for `VFX` (`@margoengine/vfx`), placed by the scene with `position`. */
export interface KitParticles {
  readonly capacity: number;
  readonly rate: number;
  readonly lifetime: readonly [number, number];
  readonly size: number;
  readonly velocity: Vec3;
  readonly spread: number;
  readonly gravity: Vec3;
  readonly turbulence: number;
  readonly frequency: number;
  readonly color: Color;
  readonly intensity: number;
  readonly emissionExtent: Vec3;
  readonly emitter: { readonly shape: 'cone'; readonly radius: number; readonly angle: number; readonly speed: number };
  /** Velocity-stretched billboards (`@margoengine/vfx/stretch`): seconds of travel each streak is long. None: discs. */
  readonly stretch?: { readonly factor: number };
  /**
   * `@margoengine/vfx/schedule` (in the full `@margoengine/vfx` entry): `prewarm` is the part's longest lifetime, so
   * the first frame already shows a fire that has been burning, not an empty grate that fills over the first second.
   */
  readonly schedule: { readonly prewarm: number };
  readonly curves: {
    readonly size: readonly number[];
    readonly alpha: readonly number[];
    readonly color: readonly { readonly at: number; readonly color: Vec3 }[];
  };
}
/**
 * The hearth: its fire light (a flame line of `Clustered` point lights, `lineLights` of `clustered/line`, on
 * `clustered/flicker`'s fire curve) and its particles. `Fire` (`@margoengine/vfx/fire`) builds a fire from it.
 */
export interface KitHearth {
  readonly light: {
    readonly color: Vec3;
    /** The whole flame line's intensity, shared by its points. */
    readonly intensity: number;
    readonly range: number;
    /** Length of the flame line along the logs, metres. */
    readonly length: number;
    /** Height of the flame line over the flames' births (the fuel top), metres: the flames' radiance centroid. */
    readonly height: number;
    /**
     * Each point's size for `length`, metres: its sphere radius (`PointLight.radius`) and shadow radius
     * (`shadow.radius`, PCSS through `LocalShadows`).
     */
    readonly radius: number;
    readonly flicker: { readonly curve: 'fire'; readonly speed: number; readonly seed: number };
  };
  /** Height of the embers' births over the flames' births, metres. */
  readonly emberHeight: number;
  /** A lantern by the window: a flame-coloured `Clustered` point light on the `candle` flicker curve, the window's glow. */
  readonly lamp: {
    readonly color: Vec3;
    readonly intensity: number;
    readonly range: number;
    /**
     * Half the flame's width, metres (`PointLight.radius`): a sphere light, and the `shadow.radius` of a `castShadow`
     * lamp, so the window's shadow edges on the snow get the penumbra a real flame casts.
     */
    readonly radius: number;
    readonly flicker: { readonly curve: 'candle'; readonly speed: number; readonly seed: number };
  };
  /**
   * The flames. Place them with `position` at the centre of the fuel's top (the tops of the logs): births fill a box
   * 0.6 m along the logs, 0.14 m across them and 0.09 m high around it, so every flame starts on the fuel and rises off
   * it, as a flame does from the burning surface. Births under the log tops or in front of the logs drew the young,
   * half-transparent flames over the log faces: the fire's base read as a soft smear.
   */
  readonly fire: KitParticles;
  readonly embers: KitParticles;
  readonly steam: KitParticles;
}
/**
 * The moonlight the snow sends back up, for `HemisphereLight` (`@margoengine/environment`): nothing from above (the sky
 * already lights the scene) and, from below, the radiance of the moonlit snow. Under the eaves, below sills and on
 * the logs' undersides it is most of the light there is.
 */
export interface KitBounce {
  readonly sky: Vec3;
  readonly ground: Vec3;
  readonly intensity: number;
}
/** Everything {@link snowNight} chooses. Frozen. */
export interface SnowNightKit {
  readonly name: 'snowNight';
  readonly snowfall: Snowfall;
  /** Metres at which a dark object fades to 2% contrast in the falling snow. */
  readonly visibility: number;
  /** `Sky` options (features `night` and `lighting`; `preetham` for the dusk glow). */
  readonly sky: SkyOptions;
  /** `Weather` options of `@margoengine/sky/weather`: the falling snow. */
  readonly precipitation: WeatherOptions;
  readonly cover: KitSnowCover;
  readonly fog: KitFog;
  readonly bounce: KitBounce;
  /** `Bloom` options (`@margoengine/post/bloom`). */
  readonly bloom: { readonly strength: number; readonly threshold: number; readonly radius: number };
  readonly tonemap: TonemapOptions;
  readonly hearth: KitHearth;
}
/** {@link snowNight} options. Out of range throws RangeError. */
export interface SnowNightOptions {
  /** Default `'moderate'`. */
  snowfall?: Snowfall;
  /** Moon phase, -1 new to 1 full. Default 0.75. */
  moonPhase?: number;
  /** Direction toward the moon (normalized). Default [-0.45, 0.42, -1]. */
  moonDirection?: Vec3;
  /** Scales the fire, its light and its particles' birth rates, 0.25 to 4. Default 1. */
  fire?: number;
  /**
   * Metres from the camera to what the shot is focused on (the snow's `lens.focalDistance`), 0.3 or more. Default 10.
   */
  focalDistance?: number;
}

// Visibility in falling snow by intensity: the Federal Meteorological Handbook No. 1 (Office of the Federal Coordinator
// for Meteorology, FCM-H1, Table "Intensity of snow based on visibility"): light at 5/8 statute mile or more, moderate
// between 5/16 and 5/8, heavy at 5/16 or less. A kit takes a value inside each band: 1,600 m, 750 m and 350 m. The fog
// density follows from it by Koschmieder (1924): an object fades to 2% contrast at 3.912 / density metres. The snow
// particle intensity rises with the band (sky Weather's own 0 to 1 scale).
const SNOWFALL: Readonly<Record<Snowfall, { visibility: number; intensity: number }>> = {
  light: { visibility: 1600, intensity: 0.35 },
  moderate: { visibility: 750, intensity: 0.65 },
  heavy: { visibility: 350, intensity: 1 },
};

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};
/**
 * Visible albedo of fresh snow. Clean fresh snow reflects 0.9 and more of visible light and aged or dusty snow less
 * (Warren, "Optical properties of snow", Reviews of Geophysics 20(1), 1982, doi:10.1029/RG020i001p00067; Wiscombe and
 * Warren, "A model for the spectral albedo of snow. I: Pure snow", J. Atmos. Sci. 37(12), 1980); 0.85 sits in the 0.8
 * to 0.9 of fresh snow under a night sky.
 */
export const SNOW_ALBEDO = 0.85;

/**
 * The radiance of a lit snow plane, Lambertian, as a `HemisphereLight` ground colour: albedo times the irradiance on
 * the plane over pi, in the engine's units, where core's diffuse is albedo / pi times a light's irradiance and an
 * ambient colour C lights a surface of albedo a with a times C. The moon, a directional light of `moon` irradiance
 * from `direction` (unit), gives `moon * direction.y`; the sky's ambient floor `ambient`, already in ambient units,
 * gives `pi * ambient`. A HemisphereLight with this ground colour lights a surface facing down with all of it and a
 * wall with half: the view factor from a tilted surface to an infinite plane, (1 - n.y) / 2, the isotropic
 * ground-reflected term of Liu and Jordan ("The long-term average performance of flat-plate solar-energy collectors",
 * Solar Energy 7(2), 1963).
 */
export function snowBounce(moon: Vec3, direction: Vec3, ambient: Vec3, albedo = SNOW_ALBEDO): Vec3 {
  const up = Math.max(0, direction[1]);
  return [0, 1, 2].map((i) => albedo * ((moon[i] * up) / Math.PI + ambient[i])) as unknown as Vec3;
}

const range = (name: string, value: number, low: number, high: number, kit = 'snowNight'): number => {
  if (typeof value !== 'number' || !(value >= low && value <= high))
    throw new RangeError(`Invalid ${kit} ${name} ${String(value)}; use a number from ${low} to ${high}.`);
  return value;
};

/** Rec. 709 luminance of a linear RGB colour. */
const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/**
 * A wood fire's colour temperature, Kelvin: 1,860 K, the "firelight" source of Zukauskas, Vaicekauskas, Tuzikas,
 * Petrulis, Stanikunas, Svegzda, Eidikas and Vitta ("Firelight LED Source: Toward a Balanced Approach to the
 * Performance of Solid-State Lighting for Outdoor Environments", IEEE Photonics Journal 6(3), 2014,
 * doi:10.1109/JPHOT.2014.2319102), inside the 1,700 to 2,500 K firelight range of Zabiliute, Vaicekauskas, Vitta and
 * Zukauskas ("Phosphor-converted LEDs with low circadian action for outdoor lighting", Optics Letters 39(3), 2014,
 * doi:10.1364/OL.39.000563). Direct measurement agrees: J. J. McCann ("Ideal illuminants for rod/L-cone color",
 * Color Imaging XI, Proc. SPIE 6058, 2006) measured 18 spectra of a fireplace's wood fire with a PR650
 * spectroradiometer (380 to 780 nm) and fitted them to blackbody exitance: the smokeless wood flame about 1,700 K, flame
 * with its smoke above 2,000 K, a wax candle close to 2,000 K; 1,860 K lies between the first two, as a hearth's light
 * mixes both. The hearth's colour comes from it through `flameLight` (`@margoengine/clustered/flicker`,
 * Planck x CIE 1931 to linear sRGB): [1, 0.224, 0]. Until 2026-11-16 the glow was [1, 0.48, 0.17], a 3,000 K
 * blackbody's colour, far whiter than a fire (KB-FIRE-GLOW-CCT1).
 */
export const FIRELIGHT_KELVIN = 1860;
/**
 * The hearth's light, lumens averaged over its `'fire'` flicker (mean 0.75), at `fire` 1: 48.2 lm, the luminous output
 * it had before its colour was corrected (intensity 9 at the 3,000 K colour's luminance 0.568, 5.11 cd at its peak), so
 * the correction changes the fire's colour only. A Margo design value: a hearth fire for one small room.
 */
const FIRE_LUMENS = 9 * 0.56817 * 0.75 * 4 * Math.PI;
/** The window lantern: a measured kerosene hurricane lantern (`hurricaneLantern`), out of step with the fire (seed 5). */
const lantern = () => {
  const l = hurricaneLantern({ seed: 5 });
  return {
    color: [...l.color] as Vec3,
    intensity: l.intensity,
    range: l.range,
    radius: l.radius,
    flicker: { ...l.flicker, curve: 'candle' as const },
  };
};
/**
 * The whiteout window's lamp: a kerosene flame's 1,900 K (as `hurricaneLantern`) on the `'candle'` flicker, giving
 * 114 lm averaged over it, the luminous output it had before its colour was corrected (intensity 16 at the 3,450 K
 * colour [1, 0.56, 0.24], luminance 0.630; KB-FIRE-GLOW-CCT1). A Margo design value: one lamp seen through a blizzard.
 */
const WINDOW_LAMP = flameLight({
  kelvin: 1900,
  lumens: 16 * 0.63046 * 0.9 * 4 * Math.PI,
  range: 10,
  speed: 0.5,
  seed: 7,
});
/** The flames' colour at birth, their brightest. */
const FLAME_BIRTH: Vec3 = [1, 0.5, 0.12];
/**
 * The flames are as bright as the light they give (Scott, 2026-11-16, KB-FIRE-RECEIVER1). Each of the hearth's two
 * flame-line points is a sphere of the line's own 0.155 m share holding half of its intensity 9, radiance
 * 2.56 cd / (pi 0.155^2) = 33.9 in luminance (half the hearth light's peak, 5.11 cd); the flames' brightest colour, at birth (luminance 0.579), shows that
 * at intensity 58.5. At 3.5 they showed 2.0: Fire grew the spheres to 0.634 m to match them, which put the firebox back
 * inside the spheres, so it was lit at their whole radiance and read as bright as the flames.
 */
const FIRE_LIGHT = flameLight({ kelvin: FIRELIGHT_KELVIN, lumens: FIRE_LUMENS, range: 9, curve: 'fire', seed: 3 });
const FLAME_INTENSITY =
  (0.5 * FIRE_LIGHT.intensity * luminance(FIRE_LIGHT.color)) / (Math.PI * 0.155 ** 2 * luminance(FLAME_BIRTH));

/** Fog density per metre for a visibility in metres (Koschmieder: 2% contrast at 3.912 / density). */
export function fogDensityForVisibility(visibility: number): number {
  return 3.912 / range('visibility', visibility, 1, 1e6);
}

/**
 * The snowbound night kit: a moonlit sky, falling snow as thick as `snowfall`, deep snow cover, froxel fog that hides
 * the far trees at the snowfall's visibility, a hearth fire with embers and kettle steam, its flickering light, bloom
 * and an AgX grade for a night lit by fire. Every call returns a fresh frozen kit.
 * @throws RangeError for an unknown snowfall or an out-of-range option.
 * @example
 * const kit = snowNight({snowfall: 'heavy'});
 * const sky = Sky.attach(engine, structuredClone(kit.sky), {preetham, night, lighting});
 */
export function snowNight(options: SnowNightOptions = {}): SnowNightKit {
  const snowfall = options.snowfall ?? 'moderate';
  if (!Object.prototype.hasOwnProperty.call(SNOWFALL, snowfall))
    throw new RangeError(`Unknown snowfall "${String(snowfall)}"; use one of ${snowfallNames.join(', ')}.`);
  const moonPhase = range('moonPhase', options.moonPhase ?? 0.75, -1, 1),
    fire = range('fire', options.fire ?? 1, 0.25, 4),
    focalDistance = range('focalDistance', options.focalDistance ?? 10, 0.3, 1e6),
    m = options.moonDirection ?? [-0.45, 0.42, -1];
  if (!Array.isArray(m) || m.length !== 3 || !m.every(Number.isFinite) || m[1] <= 0)
    throw new RangeError(
      'Invalid snowNight moonDirection; give [x, y, z] with y above 0 (the moon above the horizon).',
    );
  const length = Math.hypot(m[0], m[1], m[2]),
    moonDirection: Vec3 = [m[0] / length, m[1] / length, m[2] / length],
    { visibility, intensity } = SNOWFALL[snowfall],
    // The moon's light is the sky's own for the moon it draws (`moonlight`, `@margoengine/sky/moonlight`): its phase,
    // its altitude and the air's extinction set the lux, the night's blue shift its colour. The kit sets none of it.
    moon = moonlight(moonPhase, moonDirection),
    nightAmbient: Vec3 = [0.016, 0.02, 0.032];
  // Margo design values. The night is a deep blue, lit by a moon low behind the snow and the snow's own glow; the moon's
  // light is cold and weak against the fire (about 1/15 of its strength at the window), so the lit window reads warm.
  // The grade lifts the night a little over half a stop and keeps the fire's highlights in AgX's shoulder; white balance at 5600 K
  // keeps the snow blue and the firelight orange instead of neutralising either.
  return freeze({
    name: 'snowNight' as const,
    snowfall,
    visibility,
    sky: {
      model: 'preetham' as const,
      hours: 23,
      timeScale: 0,
      turbidity: 4,
      exposure: -1.5,
      night: {
        zenithColor: [0.006, 0.009, 0.022] as Vec3,
        horizonColor: [0.035, 0.045, 0.07] as Vec3,
        hazeDensity: 1.6,
        moonDirection,
        moonColor: [5.6, 6.4, 8] as Vec3,
        moonSize: 0.028,
        moonPhase,
        glowIntensity: 0.9,
        starIntensity: 0.35,
        starTwinkleIntensity: 0.6,
      },
      lighting: {
        intensity: 1,
        moon: {},
        ambient: { day: [0.03, 0.035, 0.045] as Vec3, night: nightAmbient },
      },
    },
    precipitation: {
      precipitation: 'snow' as const,
      intensity,
      fadeSeconds: 0,
      // Real flake sizes (sky Weather's default, Gunn and Marshall 1958 with Locatelli and Hobbs 1974), most of them
      // under a pixel, each keeping only its own light: 750,000 at intensity 1 give the snow its density
      // (KB-SNOW-NEARCAM2).
      particles: 750000,
      radius: 22,
      height: 16,
      wind: [0.6, -0.3] as const,
      brightness: 0.55,
      opacity: 0.85,
      // A night exterior is shot with the lens wide open (f/1.4 on a full-frame sensor), so the flakes passing close to
      // the camera are out of focus: faint, soft discs, not sharp specks (KB-SNOW-NEARCAM1).
      lens: { focalDistance, aperture: 1.4, filmGauge: 36 },
      // The night's shutter: 1/48 s, a 180 degree shutter at 24 frames a second (the exposure a night exterior is shot
      // at before the shutter is opened wider), so a flake near the lens streaks with its light spread along it.
      exposure: 1 / 48,
    },
    cover: { cover: 1, depth: 0.12, variation: 0.5, drift: 3 },
    fog: {
      density: fogDensityForVisibility(visibility),
      heightFalloff: 0.06,
      height: 0,
      anisotropy: 0.45,
      color: [0.82, 0.88, 1] as Vec3,
      ambient: [0.006, 0.008, 0.013] as Vec3,
      multipleScattering: 3,
      noise: 0.35,
      noiseScale: 9,
      wind: [0.6, 0, -0.3] as Vec3,
      range: 90,
    },
    // The snow's bounce: the moonlit snow lights what faces it from below, the undersides the moon and the sky leave
    // black (eaves, sills, the logs' lower faces), as on a real snowy night.
    bounce: {
      sky: [0, 0, 0] as Vec3,
      ground: snowBounce(moon.color.map((c) => c * moon.intensity) as unknown as Vec3, moonDirection, nightAmbient),
      intensity: 1,
    },
    // The eye's own glare round the lantern and the fire (KB-CABIN-BLOOM1): the Stiles-Holladay veiling luminance
    // 10 E / theta^2 (theta in degrees, E lux at the eye; Vos, CIE Journal 3(2), 1984; the glare PSF of Spencer et al.,
    // SIGGRAPH 1995) puts the same light in every octave of angle, 20 pi ln 2 (pi / 180)^2 = 1.3% of it, so the chain's
    // levels weigh alike (radius 0.5) and its six octaves carry 8% (strength 0.08). At 0.12 with radius 0.8 three
    // quarters of the glow sat in the widest level: the lantern's real 17,000 cd/m2 flame hazed the whole wall.
    bloom: { strength: 0.08, threshold: 1.2, radius: 0.5 },
    tonemap: { curve: 'agx' as const, exposure: 0.6, contrast: 1.08, temperature: 5600, vignette: 0.22 },
    hearth: {
      light: {
        // A wood fire's glow at FIRELIGHT_KELVIN and FIRE_LUMENS (KB-FIRE-GLOW-CCT1).
        color: [...FIRE_LIGHT.color] as Vec3,
        intensity: FIRE_LIGHT.intensity * fire,
        range: FIRE_LIGHT.range,
        // The flames run along the logs, about 0.62 m end to end, and the light stands at their radiance centroid,
        // 0.14 m over the fuel top: the mean height of the flames below, weighted by alpha x size^2 x luminance over
        // their life (rising at 0.25 + 0.45 m/s and 1.2 m/s^2 for 0.3 to 0.6 s, 0.136 m). 0.3 m was the height over
        // the old births, 0.16 m under the log tops: with the births on the fuel top it put the line 0.16 m over the
        // flames, 6 cm from the kettle's spout. Each of the line's two points has half the flame's length as its
        // radius (lineShadowRadius): a sphere light that bounds the kettle's highlight and one soft, widening shadow
        // of the stand's legs and the logs, not two hard copies.
        length: 0.62,
        height: 0.14,
        radius: 0.155,
        flicker: { ...FIRE_LIGHT.flicker, curve: 'fire' as const },
      },
      emberHeight: 0.1,
      // A kerosene hurricane lantern, measured (KB-CABIN-LANTERN1): `hurricaneLantern` of @margoengine/clustered/flicker.
      lamp: lantern(),
      // Flames: short-lived streaks stretched along their rise (tongues, not discs), packed low over the logs, yellow
      // at birth and red as they cool. Soft round discs at a high birth rate piled into one overexposed blob.
      fire: {
        // Holds every live flame at the birth rate (rate x longest lifetime) up to `fire` 4: a fixed 4,000 capped a
        // fire of 2.3 or more, so the flames stopped growing with the light.
        capacity: 4000 * Math.max(1, fire),
        rate: 1800 * fire,
        lifetime: [0.3, 0.6] as const,
        size: 0.05,
        velocity: [0, 0.25, 0] as Vec3,
        spread: 0.05,
        gravity: [0, 1.2, 0] as Vec3,
        turbulence: 0.45,
        frequency: 6,
        color: [1, 1, 1, 1] as Color,
        intensity: FLAME_INTENSITY,
        // Births on the fuel's top (`position`), within the logs' length and their tops' depth. The old box (0.2 by 0.02
        // by 0.08 m around a point 0.16 m under the log tops, plus a 0.16 m cone disc) put a third of the births in front
        // of the logs and most of them under their tops: the young flames, still fading in, lay over the log faces as a
        // haze, a 10 to 90% flame rise 35 px tall at the hearth close-up (1080p) where the flame now rises in 4.
        emissionExtent: [0.28, 0.045, 0.05] as Vec3,
        emitter: { shape: 'cone' as const, radius: 0.02, angle: 0.12, speed: 0.45 },
        stretch: { factor: 0.09 },
        schedule: { prewarm: 0.6 },
        curves: {
          size: [0.8, 1, 0.7, 0.15],
          alpha: [0, 0.85, 0.5, 0],
          color: [
            { at: 0, color: [...FLAME_BIRTH] as Vec3 },
            { at: 0.3, color: [1, 0.3, 0.04] as Vec3 },
            { at: 1, color: [0.3, 0.04, 0] as Vec3 },
          ],
        },
      },
      // Embers: a few small sparks that streak up and cool, not a cloud over the room.
      embers: {
        capacity: 1000,
        rate: 45 * fire,
        lifetime: [1, 2] as const,
        size: 0.012,
        velocity: [0, 0.5, 0] as Vec3,
        spread: 0.15,
        gravity: [0, 0.35, 0] as Vec3,
        turbulence: 0.8,
        frequency: 2,
        color: [1, 1, 1, 1] as Color,
        intensity: 5,
        emissionExtent: [0.2, 0.03, 0.08] as Vec3,
        emitter: { shape: 'cone' as const, radius: 0.15, angle: 0.3, speed: 0.8 },
        stretch: { factor: 0.03 },
        schedule: { prewarm: 2 },
        curves: {
          size: [1, 0.8, 0.5, 0.1],
          alpha: [0, 1, 1, 0],
          color: [
            { at: 0, color: [1, 0.6, 0.2] as Vec3 },
            { at: 0.5, color: [1, 0.3, 0.04] as Vec3 },
            { at: 1, color: [0.35, 0.03, 0] as Vec3 },
          ],
        },
      },
      // Steam: many faint puffs that overlap into one soft plume. 150 puffs a second at a fifth opacity each read
      // as separate bubbles over the fire.
      steam: {
        capacity: 1200,
        rate: 400,
        lifetime: [1.6, 2.8] as const,
        size: 0.14,
        velocity: [0.08, 0.05, 0] as Vec3,
        spread: 0.04,
        gravity: [0, 0.35, 0] as Vec3,
        turbulence: 0.5,
        frequency: 4,
        color: [0.9, 0.92, 0.95, 0.32] as Color,
        intensity: 1,
        emissionExtent: [0.004, 0.004, 0.004] as Vec3,
        emitter: { shape: 'cone' as const, radius: 0.008, angle: 0.3, speed: 0.35 },
        schedule: { prewarm: 2.8 },
        curves: {
          size: [0.12, 0.5, 0.85, 1],
          alpha: [0, 0.1, 0.05, 0],
          color: [
            { at: 0, color: [1, 1, 1] as Vec3 },
            { at: 1, color: [0.85, 0.88, 0.95] as Vec3 },
          ],
        },
      },
    },
  });
}

/** A weather state for `WeatherMachine` (`@margoengine/weather`): every field of its `WeatherState`, so a kit's states blend and set as they are. */
export interface KitWeatherState {
  readonly rain: number;
  readonly snow: number;
  readonly hail: number;
  readonly wind: number;
  readonly gust: number;
  readonly windDirection: number;
  readonly cloud: number;
  readonly fog: number;
  readonly lightning: number;
  readonly dust: number;
  readonly smoke: number;
  /** Volcanic ash, 0 to 1 (none in a whiteout). */
  readonly ash: number;
  /** Sea spray, 0 to 1 (none in a whiteout). */
  readonly spray: number;
  /** Relative humidity, 0 to 1. */
  readonly humidity: number;
  /** Air temperature, degrees Celsius. */
  readonly temperature: number;
}
/** Everything {@link whiteout} chooses. Frozen. */
export interface WhiteoutKit {
  readonly name: 'whiteout';
  /** Metres at which a dark object fades to 2% contrast in the storm. */
  readonly visibility: number;
  /** The same in the lull, when the storm eases. */
  readonly lullVisibility: number;
  /** `Sky` options (features `night` and `lighting`): an overcast dusk lit by the snow, no moon or stars showing. */
  readonly sky: SkyOptions;
  /**
   * The blizzard as a weather state: drive the snow and the wind with `WeatherMachine` and `WeatherDrive`
   * (`@margoengine/weather`). Its `fog` is the drive's thickest that `visibility` allows: the drive's fog stops at
   * 196 m, so give the fog volume `fogDensityForVisibility(whiteoutVisibility(kit, level))` yourself.
   */
  readonly storm: KitWeatherState;
  /** The storm easing: lighter snow, a weaker wind and the fog of `lullVisibility`. Blend to it to open the view. */
  readonly lull: KitWeatherState;
  /** `Weather` options of `@margoengine/sky/weather` the drive leaves alone: flake count, box, colour and opacity. */
  readonly precipitation: WeatherOptions;
  readonly cover: KitSnowCover;
  /** Froxel fog: `density` is the storm's; a dense layer of blowing snow under `height`, streaky noise. */
  readonly fog: KitFog;
  readonly bloom: { readonly strength: number; readonly threshold: number; readonly radius: number };
  readonly tonemap: TonemapOptions;
  /** The one lit window: a warm lamp inside, a `Clustered` point light on the `candle` flicker curve. */
  readonly window: {
    readonly light: {
      readonly color: Vec3;
      readonly intensity: number;
      readonly range: number;
      readonly flicker: { readonly curve: 'candle'; readonly speed: number; readonly seed: number };
    };
  };
}
/** {@link whiteout} options. Out of range throws RangeError. */
export interface WhiteoutOptions {
  /** Mean wind in metres per second, 16 to 40 (a blizzard blows at 35 mph, 15.6 m/s, or more). Default 18. */
  wind?: number;
  /** Gustiness 0 to 1 (`WindField` gust). Default 0.55. */
  gust?: number;
  /** Direction the wind blows toward in radians; 0 is +Z. Default 0.3. */
  windDirection?: number;
  /** Storm visibility in metres, 30 to 400 (a blizzard leaves a quarter mile, 402 m, or less). Default 90. */
  visibility?: number;
  /** Visibility in the lull, 400 to 5,000 m. Default 1,200. */
  lullVisibility?: number;
}

// The fog `WeatherDrive` writes for a state is `fogDensity(state)` of @margoengine/weather: 0.0002 * 100^t per metre,
// t = min(1, fog + 0.15 * max(rain, snow, hail)). The kit solves it for the fog that gives its visibility (Koschmieder,
// as `fogDensityForVisibility`), so the drive's fog and the kit's agree down to the thickest it gives, 0.02 (196 m).
const fogForVisibility = (visibility: number, snow: number): number =>
  Math.min(1, Math.log(fogDensityForVisibility(visibility) / 0.0002) / Math.log(100)) - 0.15 * snow;

/**
 * Visibility in metres at a storm level: 0 the kit's lull, 1 its storm. It moves evenly in the log of the distance,
 * with the smoothstep ease of `blendStates` (`@margoengine/weather`), so it follows a blend of `lull` to `storm` by
 * the same level. Give the fog `fogDensityForVisibility` of it.
 * @throws RangeError for a level outside 0 to 1.
 */
export function whiteoutVisibility(kit: Pick<WhiteoutKit, 'visibility' | 'lullVisibility'>, level: number): number {
  const t = range('level', level, 0, 1, 'whiteoutVisibility'),
    eased = t * t * (3 - 2 * t);
  return kit.lullVisibility * (kit.visibility / kit.lullVisibility) ** eased;
}

// The blizzard's sky is overcast: all of it under cloud (the weather state's `cloud` and the moon's `cloudCover`).
const STORM_CLOUD = 1;
/**
 * The whiteout kit: a blizzard at dusk on open ground with one lit window. A wind of `wind` gusting by `gust` drives
 * dense snow sideways, a layer of blowing snow streams along the ground, the fog leaves `visibility` metres, and a
 * warm lamp lights the window. `storm` and `lull` are weather states to drive it with `WeatherMachine` and
 * `WeatherDrive`; blend between them to open and close the view. Every call returns a fresh frozen kit.
 * @throws RangeError for an out-of-range option.
 * @example
 * const kit = whiteout();
 * const machine = new WeatherMachine({...kit.storm});
 * WeatherDrive.attach(engine, {weather: machine, precipitation: Weather.attach(engine, {...kit.precipitation}), listener: engine.camera});
 */
export function whiteout(options: WhiteoutOptions = {}): WhiteoutKit {
  const wind = range('wind', options.wind ?? 18, 16, 40, 'whiteout'),
    gust = range('gust', options.gust ?? 0.55, 0, 1, 'whiteout'),
    windDirection = range('windDirection', options.windDirection ?? 0.3, -Math.PI * 2, Math.PI * 2, 'whiteout'),
    visibility = range('visibility', options.visibility ?? 90, 30, 400, 'whiteout'),
    lullVisibility = range('lullVisibility', options.lullVisibility ?? 1200, 400, 5000, 'whiteout'),
    lullSnow = 0.35;
  // A blizzard: the US National Weather Service warns of one for sustained wind or frequent gusts of 35 mph or more
  // with falling or blowing snow that leaves a quarter mile of visibility or less, for three hours or more. The rest
  // are Margo design values: an overcast dusk just after sunset, the sky lit only by the snow; the moon behind the
  // overcast lights it as the sky derives it (moonlight from its phase and altitude, dimmed by the storm's cloud cover
  // `storm.cloud` through cloudTransmittance, @margoengine/sky/moonlight); the fog's ambient is
  // the light that sky gives the blowing snow, so the storm reads as a pale blue-grey wall; the window's lamp is the
  // one warm light, a kerosene flame at 1,900 K (WINDOW_LAMP).
  return freeze({
    name: 'whiteout' as const,
    visibility,
    lullVisibility,
    sky: {
      model: 'preetham' as const,
      hours: 18.4,
      timeScale: 0,
      turbidity: 8,
      exposure: -1,
      night: {
        zenithColor: [0.03, 0.038, 0.056] as Vec3,
        horizonColor: [0.075, 0.085, 0.105] as Vec3,
        hazeDensity: 2.4,
        moonDirection: [0.4, 0.5, -0.77] as Vec3,
        // The moon is behind the overcast: its disc and the stars do not show; only its light reaches the snow.
        moonColor: [0, 0, 0] as Vec3,
        moonSize: 0.03,
        moonPhase: 0.5,
        glowIntensity: 0,
        starIntensity: 0,
        starTwinkleIntensity: 0,
      },
      lighting: {
        // Lit in lux, so the twilight after sunset (the sun 6 degrees down at 18.4 h: 2.99 lux under a clear sky, a
        // quarter of it under the overcast, USNO Circular 171) and the moon behind the cloud share one scale.
        intensity: SUN_ILLUMINANCE,
        twilight: { cloudCover: STORM_CLOUD },
        moon: { cloudCover: STORM_CLOUD },
        ambient: { day: [0.05, 0.056, 0.068] as Vec3, night: [0.032, 0.037, 0.05] as Vec3 },
      },
    },
    storm: {
      rain: 0,
      snow: 1,
      hail: 0,
      wind,
      gust,
      windDirection,
      cloud: STORM_CLOUD,
      fog: fogForVisibility(visibility, 1),
      lightning: 0,
      dust: 0,
      smoke: 0,
      ash: 0,
      spray: 0,
      // The weather package's blizzard air: 0.85 humidity at -8 C.
      humidity: 0.85,
      temperature: -8,
    },
    lull: {
      rain: 0,
      snow: lullSnow,
      hail: 0,
      wind: wind / 3,
      gust: gust / 2,
      windDirection,
      cloud: 0.9,
      fog: fogForVisibility(lullVisibility, lullSnow),
      lightning: 0,
      dust: 0,
      smoke: 0,
      ash: 0,
      spray: 0,
      // Calmer snow in the same cold air: the snow preset's 0.9 humidity.
      humidity: 0.9,
      temperature: -8,
    },
    precipitation: {
      precipitation: 'snow' as const,
      intensity: 1,
      fadeSeconds: 0,
      // Real flake sizes, each keeping only its own light (KB-SNOW-NEARCAM2): 31.25 times the 60,000 the 24 mm flakes
      // took, the ratio of their light, keeps the blizzard as thick.
      particles: 1875000,
      radius: 16,
      height: 12,
      wind: [Math.sin(windDirection) * wind, Math.cos(windDirection) * wind] as const,
      brightness: 0.9,
      opacity: 0.9,
    },
    cover: { cover: 1, depth: 0.12, variation: 0.6, drift: 2 },
    fog: {
      density: fogDensityForVisibility(visibility),
      heightFalloff: 0.08,
      height: 1.2,
      anisotropy: 0.55,
      color: [0.84, 0.9, 1] as Vec3,
      ambient: [0.05, 0.058, 0.075] as Vec3,
      multipleScattering: 3,
      noise: 0.55,
      noiseScale: 6,
      wind: [Math.sin(windDirection) * wind, 0, Math.cos(windDirection) * wind] as Vec3,
      range: 120,
    },
    bloom: { strength: 0.16, threshold: 1, radius: 0.85 },
    tonemap: { curve: 'agx' as const, exposure: 0.8, contrast: 1.06, temperature: 5600, vignette: 0.25 },
    window: {
      light: {
        color: [...WINDOW_LAMP.color] as Vec3,
        intensity: WINDOW_LAMP.intensity,
        range: WINDOW_LAMP.range,
        flicker: { ...WINDOW_LAMP.flicker, curve: 'candle' as const },
      },
    },
  });
}

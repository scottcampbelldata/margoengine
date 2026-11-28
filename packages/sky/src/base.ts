/// <reference lib="esnext.disposable" preserve="true" />
import { ditherShader } from '../../shared/dither.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fullscreen, group, compute, dispatch } from '../../shared/gpu.js';
import { overlayPass } from '../../shared/pass.js';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { margoError } from '../../shared/errors.js';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { celestialShader } from './celestial.js';
import { sunDirection } from './clock.js';
import {
  cloudTransmittance,
  moonLook,
  moonlight,
  moonlightColor,
  moonPhase,
  type MoonBrightnessName,
  type MoonColorName,
  type Moonlight,
  type MoonLook,
  type MoonPhase,
} from './moonlight.js';
import { SUN_ILLUMINANCE, twilightIlluminance, twilightLightColor } from './twilight.js';
import { head, mid, transmittance, sunlight, zenithTransmittance } from './atmosphere.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { linearHdr } from '../../shared/hdr-format.js';
export { sunlight } from './atmosphere.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: {
  STORAGE_BINDING: number;
  TEXTURE_BINDING: number;
  RENDER_ATTACHMENT: number;
  COPY_SRC: number;
};
type SkyPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * `lighting` option (needs the `lighting` feature): the sky drives the engine's directional light from the sun and
 * moon and, with `ambient`, lights PBR meshes from the sky. Colours are linear RGB. Invalid values throw RangeError.
 */
export interface SkyLightingOptions {
  /** Direct sun strength with the sun overhead (default 1); the atmosphere's transmittance dims and warms it lower down. */
  intensity?: number;
  /** Floor for the engine light's strength (default 0). */
  minimum?: number;
  /** Sun colour with the sun overhead, linear RGB (default white); the transmittance tints it toward the horizon. */
  color?: Vec3;
  /** @deprecated Ignored: the atmosphere's transmittance now colours the low sun. Still validated. */
  sunset?: Vec3;
  /**
   * Moonlight; omitted means no moon light. With `{}` the light follows the moon the sky draws, by {@link moonlight}:
   * its illuminance in lux (a directional light's unit, `@margoengine/clustered/units`) from the night's `moonPhase`
   * (a full moon without a night) and the moon's altitude through air of `extinction` magnitudes per airmass (0 to 2,
   * default 0.172), and its colour from moonlight's own with the night's blue shift. Each scene can still pick its
   * own moon: `intensity` (>= 0, a directional light's intensity) replaces the derived strength, `brightness` (0 to
   * 10,000, default 1) scales it and the drawn disc (2 for a moon twice as bright, 0.5 for half), and `color` (linear
   * RGB) replaces the light's colour. Presets, derived in {@link moonLook}, change the light and the disc together:
   * `brightness: 'bright'` is the perigee supermoon (1.164 times the light, a disc 1.079 times as wide) and `'dim'` the
   * moon behind thin cloud (half the light); `color: 'blood'` is the totally eclipsed moon (1.06e-4 of the light,
   * reddened through the Earth's limb) and `'reddened'` the orange moon seen through the air 5 degrees up. `cloudCover` (0 to 1) is the share of the sky the cloud hides between the moon and the scene; it dims the
   * scene's moonlight by {@link cloudTransmittance} (Kasten and Czeplak 1980: a quarter of it under overcast) and, unless
   * `color` is set, takes it bluer as the dimmer light falls toward scotopic levels. Default: the `clouds` sheet's
   * coverage when the sky has one, else 0. The cloud dims only the light under it: {@link Sky.lights} keeps the
   * moonlight above the cloud (what lights the cloud tops and the moon's disc) and {@link Sky.moonUnderClouds} holds
   * what the engine light takes. Give `cloudCover: 0` when cloud shadows (`@margoengine/sky/cloud-shadows`) already
   * dim the moon's light.
   * @example
   * // A moon twice as bright as the real one, behind a sky three quarters covered:
   * const lighting = { moon: { brightness: 2, cloudCover: 0.75 } };
   * // A blood moon in eclipse at perigee:
   * const eclipse = { moon: { brightness: 'bright', color: 'blood' } } as const;
   */
  moon?: {
    intensity?: number;
    brightness?: number | MoonBrightnessName;
    color?: Vec3 | MoonColorName;
    extinction?: number;
    cloudCover?: number;
  };
  /**
   * Twilight: once the sun has set the sky still lights the scene, by the U.S. Naval Observatory's measured sky
   * illuminance against the sun's altitude ({@link twilightIlluminance}: 756 lux at sunset, 2.99 at the end of civil
   * twilight, 0.0043 at the end of nautical) in the colour of sunlight scattered down from the air above the Earth's
   * shadow, ozone included ({@link twilightColor}), with the night's blue shift for its level. It arrives from the sun's
   * side of the sky, 45 degrees up, with the horizontal illuminance measured, in the sun's units: 1 is
   * {@link SUN_ILLUMINANCE} lux, so with `intensity: SUN_ILLUMINANCE` (lux, as the moon) it gives its lux, and with the
   * default `intensity` of 1 it is that share of noon. It takes over the sky's light from the environment by the sky's
   * night blend ({@link Sky.nightFactor}: 0 with the sun 4.6 degrees up, 1 at 6.9 degrees down), so it grows in
   * without a step, and the engine light is the sun's beam plus it, summed as irradiance vectors, until the moon is the
   * stronger ({@link Sky.twilightLight}). `brightness` (0 to 10,000, default 1) scales it, `cloudCover` (0 to 1,
   * default the `clouds` sheet's coverage, else 0) dims it by {@link cloudTransmittance}, `color` (linear RGB)
   * replaces its colour, and `false` turns it off. Default `{}`.
   * @example
   * // An overcast dusk lit in lux, the sun six degrees down:
   * const lighting = { intensity: SUN_ILLUMINANCE, twilight: { cloudCover: 1 } };
   */
  twilight?: false | { brightness?: number; cloudCover?: number; color?: Vec3 };
  /**
   * Lights core's PBR meshes from the sky itself (directional diffuse from spherical harmonics and sky reflections),
   * with this RGB floor by day and by night, blended by `nightFactor`, as the least diffuse light any side receives.
   */
  ambient?: { day: Vec3; night: Vec3 };
  /**
   * Albedo of the ground under the sky, 0 to 1, for the light it reflects onto surfaces facing down (with `ambient`):
   * a level Lambertian ground lit by the sky and the sun. Default 0.2, the daylight models' standard ground; about 0.3
   * to 0.4 for dry sand, 0.8 for fresh snow, 0.1 for grass and wet earth; 0 keeps the sky map's dark ground.
   */
  ground?: number;
}
/** `clouds` option (needs the `clouds` feature): an animated procedural cloud sheet. Invalid values throw RangeError. */
export interface SkyCloudOptions {
  /** Sky fraction covered, 0..1. Default 0.45. */
  coverage?: number;
  /** Drift in metres per second along a fixed XZ direction, -100..100 (signed). Default 8. */
  speed?: number;
  /** Sheet height in metres, 100-10,000. Default 1500. */
  height?: number;
  /**
   * Optical depth of the overcast deck the sheet closes into from 80 to 100 percent cover, 1-200 (KB-SKY-OVERCAST1): under
   * a full overcast the sky is the CIE overcast gradation of 1 / (1 + 0.075 depth) of the light above the deck, with no
   * sun disc and no direct sun. Default 20, a stratus deck (`DECK_DEPTH` in `@margoengine/sky/clouds`).
   */
  depth?: number;
}
/**
 * `fog` option (needs the `fog` feature): distance and height fog over the scene, coloured by the sky. Invalid values
 * throw RangeError.
 */
export interface SkyFogOptions {
  /**
   * Override the active scene capture's sampleable depth. Omit to read the current frame from a PostStack or other
   * scene capture. There is no fog when the chosen source has no depth texture.
   */
  depth?: () => GPUTexture | undefined;
  /** Density per metre, 0..1 (0 turns fog off). Default 0.01. */
  density?: number;
  /** Distance from the camera, in metres, where fog starts, >= 0. Default 40. */
  start?: number;
  /** 'exp2' (default): 1 - exp(-(d * density)^2); 'exp': 1 - exp(-d * density). */
  falloff?: 'exp' | 'exp2';
  /** Extra density per metre below y = 0, as a fraction (default 0). */
  height?: number;
  /**
   * Height falloff of the haze, metres (exponential height fog): the density is `density` at `base` and falls by e every
   * `scaleHeight` metres above it, integrated along each ray, so a drone looking down sees through the thin air above the
   * haze layer instead of the ground-level haze over its whole path. 0 (default) keeps the density the same at every height.
   */
  scaleHeight?: number;
  /** World height, metres, where the haze has its `density` (with `scaleHeight`). Default 0. */
  base?: number;
  /** Fixed linear fog colour instead of the sky's radiance in the view direction. */
  color?: Vec3;
  /**
   * Colour fires add to the haze round them, on top of the fog's colour (KB-SKY-PALLFALLOFF1): at most eight spots
   * ({@link SkyFireSpot}). Each pixel's haze takes each spot's colour times the mean of `(R^2 / (R^2 + r^2))^1.5` (r the
   * horizontal distance from the spot, R its `reach`), the law the sky's smoke layer takes (`atmosphere.fireSpots`),
   * along its line of sight seen from above, as far as 2 / `density` from the eye, where the haze's light comes from. The
   * mean is the exact line integral of that law (the analytic airlight along a ray of B. Sun, R. Ramamoorthi,
   * S. Narasimhan and S. Nayar, "A Practical Analytic Single Scattering Model for Real Time Rendering", SIGGRAPH 2005,
   * https://doi.org/10.1145/1186822.1073309). A `WeatherDrive` writes it from its fire fronts. Default none.
   */
  fireSpots?: readonly SkyFireSpot[];
  /**
   * How fast the haze's light falls with depth below the eye, red, green and blue, per unit of the haze's optical depth
   * (`fogBelowLight`, KB-SKY-HAZEBELOW1): a ray going down takes in-scatter from haze deeper in the layer, lit by e^(-k
   * tau) of the light at the eye at a vertical optical depth tau under it, so a far ground that the haze hides fully is
   * darker the steeper it is seen and is no longer one flat colour. The two-stream diffusion exponent sqrt(g1^2 - g2^2)
   * of the haze's albedo and asymmetry (Meador and Weaver 1980); a `WeatherDrive` writes it from its dust, smoke, ash and
   * spray (`hazeLightDecay` in `@margoengine/weather`). Rays at or above the horizon are unchanged. Default [0, 0, 0]
   * (haze that absorbs nothing, as clean fog): every ray below the horizon takes the fog's colour as it is.
   */
  lightDecay?: Vec3;
  /**
   * The clear air's Rayleigh scattering inside the haze, red, green and blue, per metre at sea level (thinning by e every
   * 8 km of the eye's height), used when the fog takes the sky's colour (no `color`; KB-SKY-HAZETINT1). The haze's
   * total extinction is `density`; this much of it is the air's own blue-weighted share, so at a short or moderate
   * optical depth x the in-scattered light is the sky's horizon colour times (1 - e^(-x k)) / (1 - e^(-x)) per channel,
   * with k = 1 + (rayleigh - rayleigh green) / density: bluer for a thin haze, the horizon's own colour for a thick
   * one, as aerial perspective is (Hillaire 2020; E. Bruneton and F. Neyret 2008; the transmittance per channel
   * approximated by the haze's single opacity). Default [5.802e-6, 1.3558e-5, 3.31e-5] (Hillaire 2020 Table 1, Earth's
   * Rayleigh scattering at sea level); [0, 0, 0] gives every distance the sky's colour as it is. Over 0.05 / density
   * a channel is held at k 0.05 to 20.
   */
  rayleigh?: Vec3;
}
/** One glow a fire puts on a haze (`fog.fireSpots`) or on the smoke layer over it (`atmosphere.fireSpots`). */
export interface SkyFireSpot {
  /** Linear RGB 0-4 over the fire: added to the haze's colour, or, on the layer, a share of the zenith sun. */
  color: Vec3;
  /** World x of the point over the fire where it is brightest, metres. */
  x: number;
  /** World z of that point, metres. */
  z: number;
  /** The smoke layer's lit height there, world y, metres (`atmosphere.fireSpots` only). Default 1000. */
  height?: number;
  /** How far it reaches from straight over the fire, metres, 1 to 1e6. Default 1000. */
  reach?: number;
}
/** Stylized night: gradient, twinkling stars and a phased moon. Replaces the default night gradient when set; read every frame. */
export interface SkyNightOptions {
  zenithColor?: Vec3;
  horizonColor?: Vec3;
  /** The moon disc's colour and radiance, linear RGB. Default [6.4, 7.6, 9.6]: brighter than the cloud it lights. */
  moonColor?: Vec3;
  moonDirection?: Vec3;
  /** Angular radius in radians, between 0 and PI / 2 (exclusive). Default 0.038. */
  moonSize?: number;
  /**
   * -1 new, 0 half, 1 full, clamped; or a name from {@link MOON_PHASES}: `'new'`, `'waxingCrescent'`, `'firstQuarter'`
   * (also `'half'` and `'quarter'`), `'waxingGibbous'`, `'full'`, `'waningGibbous'`, `'lastQuarter'`,
   * `'waningCrescent'`. A waning name lights the left limb, a number or a waxing name the right one (unless
   * `moonLitBySun`). Default 0.85.
   */
  moonPhase?: MoonPhase;
  /** Turn the lit limb toward the sky's sun, as the real moon's (set by `AstroSky`). Default false: a fixed side. */
  moonLitBySun?: boolean;
  glowIntensity?: number;
  starIntensity?: number;
  /** Twinkle amplitude; zero holds stars steady. Default 1. */
  starTwinkleIntensity?: number;
  /** Horizon haze thickness; zero removes the gradient. Default 1. */
  hazeDensity?: number;
}
/**
 * `atmosphere` option (needs the `look` feature): the air the sun shines through, as the Bruneton model's coefficients
 * (Hillaire 2020 Table 1 at the defaults, Earth's). The `bruneton` day model draws the whole sky from them; under
 * `preetham` (an analytic fit with turbidity only) the dome keeps its fit and the sun's disc, its colour on clouds and
 * the engine light follow the air. Every field is optional and read every frame; a change rebuilds the tables.
 */
export interface SkyAtmosphereOptions {
  /** Sun strength above the air, a multiple of the default, 0-100. Scales the day sky, the disc and the engine light. Default 1. */
  sunIntensity?: number;
  /** Sun colour above the air, linear RGB 0-4: tints the day sky, the disc and the engine light. Default [1, 1, 1]. */
  sunColor?: Vec3;
  /** Rayleigh scattering (the blue of a clear sky), a multiple of Earth's, 0-20. Default 1. */
  rayleigh?: number;
  /** Rayleigh spectrum, linear RGB 0-4, times `rayleigh` x 0.0331 per km. Default Earth's, about [0.175, 0.41, 1]. */
  rayleighColor?: Vec3;
  /** Mie scattering (haze), a multiple of what `turbidity` gives, 0-50. Default 1. */
  mie?: number;
  /**
   * Mie single-scattering colour, linear RGB 0-1: the share of each channel the haze scatters; the rest it absorbs (its
   * extinction stays grey), so [1, 0.5, 0.3] is reddish dust that eats blue. Default [1, 1, 1] (grey haze).
   */
  mieColor?: Vec3;
  /** Mie phase asymmetry (Cornette-Shanks), -0.95 to 0.95: higher is a tighter glow round the sun. Default 0.8. */
  mieAnisotropy?: number;
  /** Ozone absorption, a multiple of Earth's layer (Hillaire 2020), 0-20: deepens twilight blue. Default 0 (the sky as before, which had none). */
  ozone?: number;
  /**
   * Light a haze layer low under the sky scatters down (smoke, ash or sea spray, which the sky model does not hold), as a
   * share of the zenith sun on level ground, linear RGB 0-4: the layer, lit from above, shines evenly over the day sky
   * with that irradiance over pi, so it reaches the dome, its reflections, the light the sky gives the scene and the sky
   * fog. Under a thick load the sky is the layer's grey glow, as under an overcast. A `WeatherDrive` writes it with
   * `sunColor` (the direct share) from its smoke, ash and spray. Default [0, 0, 0] (no layer).
   */
  scatteredLight?: Vec3;
  /**
   * The direct transmittance of that haze layer straight up, linear RGB 0-1: the night's own light (stars, the moon,
   * twilight and the clouds above the layer) is seen through it, t^(1 / sin e) along a ray e up (e floored at 3
   * degrees), and the layer's glow (`scatteredLight`) shows in front, so a starry sky goes out under a thick smoke pall.
   * The day sky takes the layer through `sunColor` and `scatteredLight` instead. A `WeatherDrive` writes it from its
   * smoke, ash and spray. Default [1, 1, 1] (no layer).
   */
  layerTransmittance?: Vec3;
  /**
   * Fires under that haze layer light it from below, brightest straight over them (KB-SKY-PALLFALLOFF1): at most eight
   * spots ({@link SkyFireSpot}), `color` the light the layer sends down over the spot as a share of the zenith sun on
   * level ground (as `scatteredLight`). Each ray meets a spot's lit `height` at a point r metres across from it, where
   * the layer takes `(R^2 / (R^2 + r^2))^1.5` of it (an isotropic source's light on a plane, cos / d^2, R the spot's
   * `reach`), and the spots add, so the layer glows over each fire and falls off between and beyond them and toward
   * the horizon away from them. Shown at night, in front of the night sky as `scatteredLight` is. A `WeatherDrive`
   * writes it from its fire fronts. Default none.
   */
  fireSpots?: readonly SkyFireSpot[];
  /**
   * How far across a ray sees the layer `fireSpots` light, metres, 0 to 1e6: beyond the visual range through the smoke a
   * low ray meets only the air before it, so it takes the layer at this horizontal distance in place of the far point it
   * would reach, and the sky low behind a ridge takes the light of the haze on it (the visual range of H. Koschmieder,
   * "Theorie der horizontalen Sichtweite", Beitraege zur Physik der freien Atmosphaere 12, 1924). 0 (default) sets no
   * limit. A `WeatherDrive` writes 2 / extinction.
   */
  fireSight?: number;
}
/** One stop of {@link SkyLookOptions.gradient}: an elevation in degrees, -90 (straight down) to 90, and a linear RGB colour 0-1. */
export interface SkyGradientStop {
  elevation: number;
  color: Vec3;
}
/**
 * `look` option (needs the `look` feature): art direction over the physical sky, read every frame. Every strength is 0
 * and every scale 1 by default, so a look with nothing moved draws the physical sky. Tints recolour at the same
 * luminance (brightness stays with the sky and `exposure`); the gradient replaces the sky by its strength; the glow
 * adds light. They apply to the sky, its fog colour, its reflections and the light it gives the scene.
 */
export interface SkyLookOptions {
  /** Tint toward the zenith, linear RGB 0-1. Default [0.25, 0.45, 1]. */
  zenithColor?: Vec3;
  /** How far the zenith takes `zenithColor`, 0-1, fading to 0 at the horizon. Default 0. */
  zenithStrength?: number;
  /** Tint at the horizon, linear RGB 0-1. Default [1, 0.8, 0.6]. */
  horizonColor?: Vec3;
  /** How far the horizon takes `horizonColor`, 0-1, fading over about 30 degrees. Default 0. */
  horizonStrength?: number;
  /** Tint below the horizon, linear RGB 0-1. Default [0.3, 0.25, 0.2]. */
  groundColor?: Vec3;
  /** How far the ground takes `groundColor`, 0-1. Default 0. */
  groundStrength?: number;
  /** 2 to 8 stops by rising elevation. Default: ground [0.3, 0.27, 0.24] at -90, haze [0.85, 0.85, 0.9] at 0, blue [0.25, 0.45, 0.9] at 90. */
  gradient?: readonly SkyGradientStop[];
  /** How far the sky is replaced by the gradient, 0-1. Default 0. */
  gradientStrength?: number;
  /** Radiance of a gradient colour of 1, in the sky's units, 0-1000. Default 1. */
  gradientIntensity?: number;
  /** Sun disc radius, a multiple of the drawn disc's (0.014 rad), 0.1-20. Default 1. */
  sunDiscSize?: number;
  /** Sun disc colour, linear RGB 0-4. Default [1, 1, 1]. */
  sunDiscColor?: Vec3;
  /** Sun disc strength, 0-100. Default 1. */
  sunDiscIntensity?: number;
  /**
   * Softness of the sun disc's edge, 0 to 1. Default 0, the disc edge a pixel wide; 1 spreads the edge over the whole
   * radius, a soft round sun as an animated feature draws it. The glow round the disc is unchanged.
   */
  sunDiscSoftness?: number;
  /** Horizon glow colour, linear RGB 0-1. Default [1, 0.45, 0.15]. */
  glowColor?: Vec3;
  /** Horizon glow radiance, in the sky's units, 0-100. Default 0 (none). */
  glowStrength?: number;
  /** Height of the glow band, degrees, 0.5-90. Default 8. */
  glowWidth?: number;
  /** 0: the glow runs round the whole horizon; 1: it gathers on the sun's side. Default 0.5. */
  glowSunward?: number;
  /** Cloud sheet colour, a linear RGB multiplier 0-4. Default [1, 1, 1]. */
  cloudColor?: Vec3;
  /** Cloud sheet density, a multiple 0-4 (0 clear, 1 as drawn, more opaque above). Default 1. */
  cloudDensity?: number;
}
/**
 * Sky settings, read every frame from `sky.options`. An option whose feature entry is missing (`night`, `clouds`,
 * `fog`, `lighting`, `model`, `look`, `atmosphere`) throws a TypeError naming the entry to import; a value out of range throws RangeError.
 */
export interface SkyOptions {
  /** Explicit world-space direction toward the sun; normalized each frame and overrides the clock's direction. */
  sunDirection?: readonly [number, number, number];
  /** Stylized night (needs `night`). Omitted: the default night gradient. */
  night?: SkyNightOptions;
  /** Cloud sheet (needs `clouds`). Omitted: no clouds. */
  clouds?: SkyCloudOptions;
  /** Scene fog (needs `fog`). Omitted: no fog. */
  fog?: SkyFogOptions;
  /** Day model (needs the entry of the same name). Default `'preetham'`. */
  model?: 'preetham' | 'bruneton';
  /**
   * Ground albedo for the Bruneton model (needs `bruneton`), 0-1: one number or linear RGB. The ground reflects this
   * share of the light on it back into the air, which brightens the sky most near the horizon: about 0.8 for fresh
   * snow, 0.3 to 0.4 for desert sand, 0.1 to 0.25 for grass and forest. Changing it rebuilds the tables. The Preetham
   * fit has no ground term and ignores it. Default 0 (a black ground, the sky as without the option).
   */
  groundAlbedo?: number | readonly [number, number, number];
  /** Clock, hours 0-24 (12 is noon, 6 sunrise); advanced by `timeScale` and wrapped into 0..24. Default 12. */
  hours?: number;
  /** Clock hours per real second, -24..24. Default 1 / 3600 (real time). */
  timeScale?: number;
  /** Atmospheric haze, 1-10. Default 2. The Preetham model reads values below 2 as 2 (its fit breaks down below that). */
  turbidity?: number;
  /**
   * Exposure of the sky, in stops, -16..16. Default 0: its backdrop, its fog colour, its reflection map and the light
   * that map gives surfaces (not the engine sun's beam). Scene exposure is `exposure` on `Tonemap` from
   * `@margoengine/tonemap`.
   */
  exposure?: number;
  /**
   * Draw the day sky in the engine light's units when it lights the scene (`lighting` or `environment`; default true):
   * its backdrop, fog, reflection map, the clouds and air drawn over it take {@link Sky.lightScale}, as its light map
   * already does, so the sky stands to the ground the engine sun lights as it does outdoors. The night is drawn as it
   * was (the factor fades to 1 with the night blend). false keeps the sky's own units, too bright against the ground
   * (preetham 1.4 times at a sun of 5, bruneton about 6 times at 3), so its blue swamps a tan ground under a distance
   * fog (KB-SKY-SANDGREY1).
   */
  balance?: boolean;
  /** Sun/moon scene lighting (needs `lighting`). Omitted: the sky does not drive engine lighting. */
  lighting?: SkyLightingOptions;
  /**
   * The air's coefficients (needs `look`). Omitted: Earth's, compiled as constants. Setting or clearing it (or `look`)
   * recompiles the sky's shaders once; values then move live.
   */
  atmosphere?: SkyAtmosphereOptions;
  /** Art direction over the sky (needs `look`). Omitted: the physical sky alone. */
  look?: SkyLookOptions;
  /**
   * Fallback image-based lighting from this sky (needs `lighting`), without driving the sun: PBR meshes get diffuse
   * light from the sky's spherical harmonics and split-sum sky reflections, so metals are not black when the sky is
   * the only light. Gives way to an explicit environment: when an `EnvironmentLighting` has already patched the
   * scene shader the sky adds nothing, and `lighting.ambient` (when set) takes precedence over it. The floor is {@link skyEnvironmentFloor}. Default false.
   */
  environment?: boolean;
  /**
   * Record which pixels this sky draws: each frame it also writes `coverageTexture`, 1 where the sky shows (no
   * geometry in front of it) and 0 where something is drawn over it, for look checks and masks. False draws and
   * allocates nothing extra. Default false.
   */
  coverage?: boolean;
}
// The Preetham sky's zenith sun on the ground in its own units: 4 pi times the clouds' sunIntensity default (0.55),
// which makes the clear noon sky give 0.165 of the light on level ground (Erbs, Klein and Duffie 1982).
const PREETHAM_SUN = 4 * Math.PI * 0.55;
// Floats of the look's uniform block after the 64 at byte 256 (`LOOK_FLOATS` of @margoengine/sky/look; a test pins the two).
const LOOK_FLOATS = 208;
/**
 * How much of a cloud sheet of `coverage` 0 to 1 is the overcast deck (KB-SKY-OVERCAST1): 0 up to 80 percent cover, a
 * smoothstep to 1 at full cover, as the sky draws it. Under the deck the engine sun fades out by the same share.
 * @example overcastShare(0.9); // 0.5
 */
export function overcastShare(coverage: number): number {
  const t = Math.min(1, Math.max(0, (coverage - 0.8) / 0.2));
  return t * t * (3 - 2 * t);
}
const luminance = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// The moon colour the uniform holds while no moon light is set: its strength is then 0, so it shows nowhere.
const UNLIT_MOON_COLOR: Vec3 = [0.25, 0.45, 0.75];
// The lighting moon's direction when no stylized night is set (Margo choice).
const DEFAULT_MOON: Vec3 = [-0.3, 0.22, -1];
// Where the stylized night draws its moon when it does not place one: the default in night.ts write (Margo choice).
const NIGHT_MOON_DIRECTION: Vec3 = [0.4, 0.7, 0.5];
/** Least diffuse light (linear RGB) the `environment` fallback gives any side, by day and by night. */
export const skyEnvironmentFloor: { readonly day: Vec3; readonly night: Vec3 } = {
  day: [0.04, 0.04, 0.04],
  night: [0.01, 0.015, 0.03],
};
export { sunDirection } from './clock.js';
export { SUN_ILLUMINANCE, twilightColor, twilightIlluminance, twilightLightColor } from './twilight.js';
export {
  cloudTransmittance,
  moonAirmass,
  moonlight,
  moonlightColor,
  moonLook,
  moonPhase,
  moonWaning,
  MOON_EXTINCTION,
  MOON_PHASES,
  type MoonBrightnessName,
  type MoonColorName,
  type Moonlight,
  type MoonLook,
  type MoonPhase,
  type MoonPhaseName,
} from './moonlight.js';
/**
 * Direction toward the sun from azimuth (+Z toward +X) and elevation, both in DEGREES (not radians). Elevation is
 * -90..90. A radians value such as 0.61 is read as 0.61 degrees, a sun on the horizon; with typed angles
 * (`sunDirectionFrom(degrees(135), degrees(35))` from `@margoengine/sky/sun`) the unit cannot be mixed up.
 */
export function sunDirectionFromAngles(azimuth: number, elevation: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(azimuth) || !Number.isFinite(elevation) || Math.abs(elevation) > 90 || out.length !== 3)
    throw new RangeError('Sun angles need a finite azimuth and elevation from -90 to 90 degrees');
  const az = (azimuth * Math.PI) / 180,
    el = (elevation * Math.PI) / 180;
  out[0] = Math.sin(az) * Math.cos(el);
  out[1] = Math.sin(el);
  out[2] = Math.cos(az) * Math.cos(el);
  return out;
}

/**
 * A renderer accepting optional sky ambient lighting: native PBR (materials meshes, gltf/pbr and VoxelRenderer) through
 * `pbr`, or `@margoengine/terrain`'s `Terrain` through `shader` and `finish`.
 */
export interface SkyLightingTarget {
  addLighting(effect: {
    pbr(group: number): { readonly declarations: string; readonly ambient?: string } | undefined;
    shader(source: string, group: number): string;
    finish(source: string, group: number): string;
    bindings(): GPUBindGroupEntry[];
  }): () => void;
}
/** Bruneton's precomputed tables: the view the sky samples and the passes that refill them. */
export interface SkyTables {
  view: GPUTextureView;
  /** Refills the tables; `albedo` is the ground albedo, linear RGB 0-1, and 0 or absent leaves the ground black. */
  run(c: SkyPassContext, albedo?: Readonly<ArrayLike<number>>): void;
  /** Compiles the table passes again through `extend` (the look's air), or as built without it; the textures stay. */
  recode?(extend: ((code: string) => string) | undefined, uniform: GPUBufferBinding): void;
}
/** Features add each GPU object they create here at once, so a setup that fails part-way still releases it. */
type Owned = { destroy(): void }[];
type Lights = { direction: Float32Array; radiance: Float32Array };
/**
 * The optional parts of a sky. Pass the exports of the feature entries, for example
 * `{bruneton, clouds}` from `@margoengine/sky/bruneton` and `@margoengine/sky/clouds`; the shapes are internal.
 */
export interface SkyFeatures {
  preetham?: { readonly wgsl: string };
  bruneton?: {
    readonly phase: string;
    readonly tail: string;
    /** WGSL `brunetonSky(table, r, mu, mus, nu)`: the sky from the table, single scattering's phases applied per pixel. */
    readonly sky: string;
    create(
      device: GPUDevice,
      uniform: GPUBufferBinding,
      transmission: GPUTextureView,
      owned: Owned,
      extend?: (code: string) => string,
    ): SkyTables;
  };
  /** The `look` and `atmosphere` options: the WGSL rewrite, checks and the extra uniform block. */
  look?: {
    extend(code: string, full: boolean): string;
    validate(options: SkyOptions): void;
    air(options: SkyOptions, out: Float32Array): Float32Array;
    write(out: Float32Array, options: SkyOptions, air: Float32Array, zenith?: number, picture?: number): void;
  };
  /** `field`: the WGSL of the cloud noise alone, `cloudOctaves` over a km position, for other passes that read the same clouds. */
  clouds?: { readonly wgsl: string; readonly field?: string; validate(clouds: SkyCloudOptions): void };
  night?: {
    readonly wgsl: string;
    validate(night: SkyNightOptions): void;
    write(values: Float32Array, night: SkyNightOptions, time: number): void;
  };
  fog?: {
    validate(fog: SkyFogOptions): void;
    create(code: string): {
      draw(c: SkyPassContext, fog: SkyFogOptions, entries: GPUBindGroupEntry[]): void;
      release(): void;
    };
  };
  reflection?: {
    create(
      device: GPUDevice,
      code: string,
      entries: GPUBindGroupEntry[],
      owned: Owned,
    ): {
      texture: GPUTexture;
      run(c: SkyPassContext, layer?: GPUTexture): void;
      recode(code: string, entries: GPUBindGroupEntry[]): void;
    };
  };
  lighting?: {
    validate(lighting: SkyLightingOptions): void;
    create(
      device: GPUDevice,
      code: string,
      entries: GPUBindGroupEntry[],
      owned: Owned,
    ): {
      update(
        target: Lights,
        sky: Sky,
        lighting: SkyLightingOptions | undefined,
        ambient: { readonly day: Vec3; readonly night: Vec3 } | undefined,
        night: number,
        scale: number,
      ): void;
      pass(c: SkyPassContext, layer?: GPUTexture): void;
      /** Patches core's scene shader with the sky's ambient (`margoAmbient`) and adds its bindings; after `pass`. */
      patch(c: SkyPassContext): void;
      recode(code: string, entries: GPUBindGroupEntry[]): void;
      pbr(group: number): { readonly declarations: string; readonly ambient: string } | undefined;
      bindings(): GPUBindGroupEntry[];
      /** Terrain's lit shader with the sky's ambient in place of its flat term (bindings in `group`); unchanged before the first ambient frame. */
      terrain(source: string, group: number): string;
      /** Settles once the ambient projection takes its route (the WebGL2 layer's, loaded by import()); never rejects. */
      readonly ready: Promise<void>;
    };
  };
}
// Absent features leave out their WGSL; with every feature the text is the root `Sky`'s shader. Only the day model in
// use is called (KB2224a): Apple's compile under WebKit rounds by the shape of the code, so a branch between the two
// models moved pixels by one half-float step; a model switch recompiles instead (Sky.recode). The stylized night is
// compiled only while `options.night` is set, for the same reason: under the WebGL2 layer on ANGLE Metal a program that
// also held the stylized night's uniform branch rounded two cloud pixels of a sky without a night one half-float step
// apart (KB6171a); setting or clearing `night` recompiles.
// With the look or air set (`extended`) the text is rewritten by the look feature (look.ts), and only then.
function compose(f: SkyFeatures, model: SkyOptions['model'], stylized: boolean, extended = false): [string, string] {
  const [atmosphere, code] = composeSky(f, model, stylized);
  return extended && f.look ? [f.look.extend(atmosphere, false), f.look.extend(code, true)] : [atmosphere, code];
}
function composeSky(f: SkyFeatures, model: SkyOptions['model'], stylized: boolean): [string, string] {
  const b = f.bruneton,
    n = stylized && f.night,
    p = !!f.preetham && model !== 'bruneton',
    day = model === 'bruneton' && b,
    atmosphere = head + (b?.phase ?? '') + mid + (b?.tail ?? '');
  return [
    atmosphere,
    fullscreen +
      atmosphere +
      (f.clouds?.wgsl ??
        `
fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {return color;}
`) +
      celestialShader +
      `
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
` +
      (day ? day.sky : '') +
      // Margo tuning: the night fallback gradient and, below, the sun disc x60 and bloom x0.8.
      (n ? n.wgsl : '') +
      `// footprint: the sample's angular size in radians, which filters stars and the moon; 0 leaves them out (fog).
fn nightSky(w:vec3f,footprint:f32)->vec3f {
` +
      (n
        ? ` if(frame.sunlight.w>0.5){return stylizedNight(w,footprint);}
`
        : '') +
      ` return mix(vec3f(0.012,0.019,0.038),vec3f(0.003,0.006,0.02),sqrt(max(0.0,w.y)));
}
` +
      (f.preetham?.wgsl ?? '') +
      `fn daySky(direction:vec3f)->vec3f {
 // Keep the coarse table's dark ground hemisphere out of the visible ocean horizon.
 let w=normalize(vec3f(direction.x,max(0.01,direction.y),direction.z));
 let s=frame.sun.xyz;
 var color=vec3f(0);` +
      (p ? 'color=preetham(w,s);' : '') +
      (day ? 'let r=R+clamp(frame.eye.w,0.001,99.9);color=brunetonSky(scattering,r,w.y,s.y,dot(w,s));' : '') +
      `
 return color;
}
fn skyRadiance(w:vec3f,footprint:f32)->vec3f {if(frame.sun.w>=1.0){return nightSky(w,footprint);}return mix(daySky(w),nightSky(w,footprint),frame.sun.w);}
${displayShader}
// Dither for the 8-bit canvas (Gjol, "Low Complexity, High Fidelity: INSIDE", GDC 2016, as in @margoengine/post Bloom):
// triangular noise of up to one 8-bit step from a hash of the pixel (C. Wellons' lowbias32, public domain), kept within
// each channel's distance to 0 and 1 so black stays black and nothing clips. Without it the smooth gradient steps one
// level per channel every few rows and the three staircases beat into visible bands.
${ditherShader}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz)*select(-1.0,1.0,p.w>=0.0);let s=frame.sun.xyz;
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sky=skyRadiance(w,footprint);var color=sky;
 let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 color=cloudSky(color,sky,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);color+=dither(i.position.xy)*min(vec3f(1.0/255.0),min(color,1.0-color));}return vec4f(color,1);
}`,
  ];
}
/**
 * A sky built from the features given: `new Sky(options, {bruneton, clouds})`. Without a day model (Preetham or
 * Bruneton) the sun must stay below the horizon. `Sky` from `@margoengine/sky` is this class with every feature.
 * @throws TypeError when an option needs a feature entry that was not given; RangeError when a value is out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the camera
 * matrix is not invertible.
 */
export class Sky implements EnginePlugin {
  private readonly presentation = overlayPass();
  private readonly attachment = this.presentation.colorAttachments[0];
  private readonly depthAttachment = this.presentation.depthStencilAttachment;
  readonly name: string = 'sky';
  /**
   * A layer over the sky in its environment: `reflectionTexture` (from the frame-graph step at order 3.5 on, before
   * Water draws at 4) and the scene's sky light (`lighting`, from the next frame). A 64 x 32 `rgba16float` texture in the
   * map's layout (u turns round +Y from -X, v runs down from the zenith) holding light, premultiplied, at 2 to the sky's
   * exposure times {@link Sky.pictureScale} (the units of the reflection map it lies over), and opacity. `VolumetricClouds` given this sky set it to their deck each frame they draw, and clear it
   * when they stop; undefined: the sky alone.
   */
  environmentLayer: GPUTexture | undefined = undefined;
  /**
   * The layer over the sky in the scene's light only (`lighting`, from the next frame), in the layout of
   * {@link Sky.environmentLayer}; undefined: that layer lights the scene too. `VolumetricClouds` set it to their deck
   * without the sun and moon light the engine lights already carry under it ({@link Sky.deck}), so each light reaches
   * the scene once, and clear it when they stop.
   */
  environmentLightLayer: GPUTexture | undefined = undefined;
  /**
   * The factor that takes the sky's own units (its picture, reflection map and light map) into the engine light's, set
   * each update: lighting.intensity (without `lighting`, the engine sun's own intensity) over the zenith sun on the ground in sky units (4 pi x 0.55
   * for Preetham; 20 times the zenith transmittance down to the eye for Bruneton). The scene's sky light is the light
   * map times this, so the sun and the sky's light on the ground keep their measured ratio at any intensity
   * (KB-SKY-SUNUNITS1). 0 before the first update.
   */
  lightScale = 0;
  /**
   * The zenith sun on level ground in the sky's own units this frame, set each update (4 pi x 0.55 for Preetham; 20
   * times the zenith transmittance down to the eye for Bruneton): the unit of `atmosphere.scatteredLight`, so a layer
   * drawn over the sky (`VolumetricClouds`) can take the same haze glow in front of it. 0 before the first update.
   */
  zenithSun = 0;
  /**
   * The factor everything the sky draws takes from its own units into the engine light's, besides its `exposure`, set
   * each update: {@link Sky.lightScale} by day while the sky lights the scene with `balance` (the default), fading to 1
   * with the night blend; 1 with `balance: false`, for a sky that only draws a backdrop, and before the first update.
   * Its backdrop, fog, reflection map and light map are drawn at 2^exposure times this, and a layer drawn over the sky in sky units (`VolumetricClouds`, `AerialPerspective`, light
   * shafts) takes the same factor, so all of them meet the ground in one unit (KB-SKY-SANDGREY1).
   */
  pictureScale = 1;
  /**
   * The share of a light at elevation sine `up` a cloud deck passes, set by `VolumetricClouds` (its `dimLight`, on by
   * default) and cleared when they go: the sun's engine light (`lights[0]`) and the moonlight under the cloud
   * ({@link Sky.moonUnderClouds}, in place of `lighting.moon.cloudCover`) are scaled by it, so a scene under the deck is
   * lit as overcast without cloud shadows wired. Default undefined: nothing dims them.
   */
  deck: ((up: number) => number) | undefined = undefined;
  /**
   * True when this sky has the `look` feature, so `atmosphere` and `look` may be set (the root `Sky` always has it). A
   * `WeatherDrive` reads it to give the sky an `atmosphere` under smoke, ash or spray, so the sun and the sky dim.
   */
  get airControls(): boolean {
    return !!this.features.look;
  }
  private engine?: Engine;
  private uniform?: GPUBuffer;
  // The 256-byte uniform of a sky without the look or air, and the 560-byte one (the look's block at 256) while they
  // are set; each made the first time it is needed and kept, so clearing the look binds the original buffer again.
  private plain?: GPUBuffer;
  private wide?: GPUBuffer;
  private transmission?: GPUTexture;
  private tables?: SkyTables;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private entries: GPUBindGroupEntry[] = [];
  private render?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private format = '';
  private computedT = NaN;
  private scatteringT = NaN;
  // The ground albedo the tables were built with, and this frame's (the fourth value flags a change).
  private readonly scatteringA = new Float64Array(3);
  private readonly albedo = new Float32Array(4);
  private readonly values = new Float32Array(64);
  // The look and air block written after the 64 values at byte 256 while `extended`, and the air its tables were made with.
  private readonly extra = new Float32Array(LOOK_FLOATS);
  private readonly air = new Float32Array(9);
  private readonly computedAir = new Float32Array(9).fill(NaN);
  private extended: boolean;
  private seconds = 0;
  private readonly inverse = this.values.subarray(0, 16);
  private readonly scratch = new Float64Array(52);
  private readonly sunColor = new Float32Array(3);
  readonly sun = new Float32Array(3);
  readonly moon = Float32Array.from(DEFAULT_MOON, (v) => v / Math.hypot(...DEFAULT_MOON));
  private readonly moonlit: Moonlight = { illuminance: 0, color: [0, 0, 0], intensity: 0 };
  // This frame's moon presets (lighting.moon brightness and color), for the disc the night draws.
  private disc: MoonLook | undefined;
  private readonly lookKey: unknown[] = [];
  // moonLook for this frame's moon, recomputed only when an input changes, so a steady moon allocates nothing.
  private look(moon: NonNullable<SkyLightingOptions['moon']>): MoonLook {
    const key = this.lookKey,
      up = this.moon[1];
    if (
      !this.disc ||
      key[0] !== moon.brightness ||
      key[1] !== moon.color ||
      key[2] !== up ||
      key[3] !== moon.extinction
    ) {
      this.disc = moonLook(moon.brightness, moon.color, up, moon.extinction);
      key[0] = moon.brightness;
      key[1] = moon.color;
      key[2] = up;
      key[3] = moon.extinction;
    }
    return this.disc;
  }
  private readonly aboveColor: [number, number, number] = [0, 0, 0];
  private readonly belowColor: [number, number, number] = [0, 0, 0];
  private disposed = false;
  private cloudTime = 0;
  // The `hours` given at construction: advanceTime moves options.hours on, and resetTime puts it back.
  private readonly startHours: number | undefined;
  // The coverage record: [size key, resolved texture, its view, pipeline, multisampled texture view].
  private cover?: [string, GPUTexture, GPUTextureView, GPURenderPipeline, GPUTextureView?, GPUTexture?];
  private reflectionRequested = false;
  private owned: Owned = [];
  private atmosphere: string;
  private code: string;
  private model: SkyOptions['model'];
  /** Whether the compiled shaders hold the stylized night (`options.night` set when they were composed). */
  private stylized: boolean;
  private reflection?: ReturnType<NonNullable<SkyFeatures['reflection']>['create']>;
  private fogPass?: ReturnType<NonNullable<SkyFeatures['fog']>['create']>;
  private lit?: ReturnType<NonNullable<SkyFeatures['lighting']>['create']>;
  private targets = new Map<SkyLightingTarget, () => void>();
  /** Borrowed linear HDR sky environment (needs the reflection feature); rebuilt on device restoration. */
  /**
   * The cloud layer this frame, for what must match it (`cloudShadows` from `@margoengine/shadows/light-function`):
   * `field` is its noise as WGSL, `drift` the metres it has moved along the wind. Undefined without clouds.
   */
  get cloudLayer(): { field: string; coverage: number; drift: number; height: number } | undefined {
    const options = this.options.clouds,
      field = this.features.clouds?.field;
    if (!options || !field) return undefined;
    return { field, coverage: options.coverage ?? 0.45, drift: this.cloudTime, height: options.height ?? 1500 };
  }
  /**
   * With `options.coverage` set, the pixels the sky drew in the last frame: an `r8unorm` texture the size of the frame
   * target, 1 where its draw passed the depth test (the sky shows), 0 where geometry is in front, and the share of
   * the samples at a multisampled edge. Views drawn into a target of their own are left out. Undefined before the
   * first frame with the option. Borrowed: replaced when the size changes, destroyed when the option is cleared, on
   * device restoration and by `dispose()`.
   */
  get coverageTexture(): GPUTexture | undefined {
    return this.cover?.[1];
  }
  get reflectionTexture(): GPUTexture | undefined {
    this.reflectionRequested = true;
    return this.reflection?.texture;
  }
  /** Dusk/dawn blend, 0 in daylight and 1 at night, updated before rendering. */
  get nightFactor(): number {
    return this.values[23];
  }
  /** Retained sun/moon directions (XYZ, intensity) and RGB radiance for direct reflections. */
  readonly lights = [
    { direction: new Float32Array([1, 0, 0, 0]), radiance: new Float32Array(3) },
    { direction: new Float32Array([...this.moon, 0]), radiance: new Float32Array(3) },
  ] as const;
  /**
   * The moon's light under the clouds, as the engine light takes it when the moon is the stronger body: `lights[1]`
   * dimmed by `lighting.moon.cloudCover` ({@link cloudTransmittance}) and, unless `color` is set, recoloured for the
   * dimmer level ({@link moonlightColor}). Direction XYZ and intensity, RGB radiance; equal to `lights[1]` under a clear sky.
   */
  readonly moonUnderClouds = { direction: new Float32Array([...this.moon, 0]), radiance: new Float32Array(3) };
  /**
   * The twilight sky's light once the sun has set (`lighting.twilight`): direction XYZ (toward the sun's side of the
   * sky, 45 degrees up) and intensity in the sun's units, RGB radiance, the USNO sky illuminance times the sky's
   * night blend ({@link Sky.nightFactor}), which hands the day sky's light over to it. Intensity 0 while the sun is more
   * than 4.6 degrees up or with no
   * `lighting`.
   */
  readonly twilightLight = { direction: new Float32Array([0, 1, 0, 0]), radiance: new Float32Array([1, 1, 1]) };
  private readonly twilightColor: [number, number, number] = [1, 1, 1];
  constructor(
    readonly options: SkyOptions = {},
    private readonly features: SkyFeatures = {},
  ) {
    this.startHours = options.hours;
    this.model = options.model;
    this.stylized = !!options.night;
    this.extended = !!(options.look || options.atmosphere) && !!features.look;
    [this.atmosphere, this.code] = compose(features, this.model, this.stylized, this.extended);
    this.validate();
  }
  /** Adds this sky's native diffuse and specular ambient to a PBR model or VoxelRenderer; returns a remover. */
  add(target: SkyLightingTarget): () => void {
    if (this.disposed) throw margoError('disposed', 'Sky is disposed; create a new Sky');
    if (!target || typeof target.addLighting !== 'function')
      throw new TypeError('Sky lighting target needs addLighting; pass a native PBR model or VoxelRenderer');
    let release = this.targets.get(target);
    if (!release) {
      const remove = target.addLighting(this);
      release = () => {
        if (this.targets.get(target) === release) {
          this.targets.delete(target);
          remove();
        }
      };
      this.targets.set(target, release);
    }
    return release;
  }
  /**
   * The sky's diffuse light on a surface facing `normal` (a unit vector, default straight up: level ground), as the
   * scene's shader took it in the last drawn frame: irradiance over pi in the engine light's units, linear RGB, from
   * the nine harmonics and never below the ambient floor (`lighting.ambient`). Lit by it, a surface of albedo a sends
   * a x this toward the eye, as the sun's beam gives a x intensity x colour x cos / pi. Resolves undefined while the
   * sky lights nothing (no `lighting.ambient` or `environment`) or before its first ambient frame.
   * @example
   * const level = await sky.irradiance(); // [r, g, b] on level ground, or undefined
   */
  async irradiance(
    normal: readonly [number, number, number] = [0, 1, 0],
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<[number, number, number] | undefined> {
    if (!Array.isArray(normal) || normal.length !== 3 || normal.some((v) => !Number.isFinite(v)))
      throw new RangeError('Sky irradiance needs a normal of three finite numbers');
    const length = Math.hypot(...normal);
    if (!(length > 0)) throw new RangeError('Sky irradiance needs a normal of nonzero length');
    signal?.throwIfAborted();
    // The ten rows skyIrradiance reads (nine harmonics, then the floor and the light scale), binding 8 of the sky's
    // light, copied after every submitted pass so the numbers are the ones the scene was shaded with.
    const entry = this.ambient() ? this.lit?.bindings().find((b) => b.binding === 8) : undefined,
      source = (entry?.resource as GPUBufferBinding | undefined)?.buffer,
      d = this.engine?.gpu;
    if (!source || !d) return undefined;
    const copy = d.createBuffer({ size: 160, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      encoder = d.createCommandEncoder();
    let rows: Float32Array;
    try {
      encoder.copyBufferToBuffer(source, 0, copy, 0, 160);
      d.queue.submit([encoder.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      rows = new Float32Array(copy.getMappedRange().slice(0));
    } finally {
      copy.destroy();
    }
    signal?.throwIfAborted();
    const [x, y, z] = normal.map((v) => v / length),
      basis = [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y],
      out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 9; k++) sum += rows[k * 4 + c] * basis[k];
      out[c] = Math.max(sum * rows[39], rows[36 + c]);
    }
    return out;
  }
  /**
   * Settles once every frame lights the scene with the sky's ambient as it will from then on. With the `lighting`
   * feature on the WebGL2 compatibility layer the sky loads its ambient projection's route (a dynamic import) when it
   * attaches; until it has loaded the WebGPU projection runs on the layer's CPU tier, which sums the ambient in its own
   * order. Resolved at once on WebGPU and without the `lighting` feature. Read it after attaching, and await it before a
   * frame that must be exact: a film frame, a pixel comparison (KB-COMPAT-READY1).
   *
   * @example
   * ```ts
   * const sky = Sky.attach(engine, { lighting: {} }, { lighting }); // lighting from '@margoengine/sky/lighting'
   * await sky.ready;
   * engine.render();
   * ```
   */
  get ready(): Promise<void> {
    return this.lit?.ready ?? Promise.resolve();
  }
  /** Native PBR hook for optional surface renderers; undefined until this sky's ambient resources are ready. */
  pbr(group: number): { readonly declarations: string; readonly ambient: string } | undefined {
    return this.ambient() ? this.lit?.pbr(group) : undefined;
  }
  /** Bindings of the native PBR sky ambient hook, borrowed until device restoration. */
  bindings(): GPUBindGroupEntry[] {
    return this.ambient() ? (this.lit?.bindings() ?? []) : [];
  }
  /** Terrain lighting hook (`Sky.add(terrain)`): unchanged here; the sky's light goes in at `finish`, after every effect. */
  shader(source: string, group: number): string {
    void group;
    return source;
  }
  /**
   * Terrain lighting hook: the terrain's lit shader with the sky's diffuse and specular ambient in place of its flat
   * `lighting.ambient` x `radiance[3]` term, after every other effect patched it (layer materials, relief lighting), so
   * shaded ground takes the sky's colour as core meshes beside it do. Unchanged until the sky's ambient is ready.
   */
  finish(source: string, group: number): string {
    return this.ambient() ? (this.lit?.terrain(source, group) ?? source) : source;
  }
  /**
   * The ambient floor in force this frame: `lighting.ambient`, else the `environment` fallback, else undefined.
   */
  private ambient(): { readonly day: Vec3; readonly night: Vec3 } | undefined {
    const o = this.options;
    if (o.lighting?.ambient) return o.lighting.ambient;
    return o.environment ? skyEnvironmentFloor : undefined;
  }
  private validate(): void {
    const o = this.options,
      f = this.features,
      model = o.model ?? 'preetham';
    if (
      o.sunDirection !== undefined &&
      (!Array.isArray(o.sunDirection) ||
        o.sunDirection.length !== 3 ||
        o.sunDirection.some((v) => !Number.isFinite(Math.fround(v))) ||
        !(Math.hypot(...o.sunDirection) > 0))
    )
      throw new RangeError('Sky sun direction needs three finite components and nonzero length');
    if (
      (o.model !== undefined && o.model !== 'preetham' && o.model !== 'bruneton') ||
      !Number.isFinite(o.hours ?? 12) ||
      !Number.isFinite(o.timeScale ?? 1 / 3600) ||
      Math.abs(o.timeScale ?? 1 / 3600) > 24 ||
      !Number.isFinite(o.turbidity ?? 2) ||
      (o.turbidity ?? 2) < 1 ||
      (o.turbidity ?? 2) > 10 ||
      !Number.isFinite(o.exposure ?? 0) ||
      Math.abs(o.exposure ?? 0) > 16 ||
      (o.balance !== undefined && typeof o.balance !== 'boolean')
    )
      throw new RangeError(
        'Invalid sky options; keep timeScale within ±24, turbidity from 1 to 10, exposure within ±16 and hours finite, ' +
          'balance a boolean, and use model "preetham" or "bruneton".',
      );
    if ((o.model !== undefined || f.preetham || f.bruneton) && !f[model])
      throw new TypeError(`Sky model '${model}' needs ${model} from @margoengine/sky/${model}`);
    const albedo = o.groundAlbedo;
    if (albedo !== undefined) {
      const values = typeof albedo === 'number' ? [albedo] : albedo;
      if (
        !Array.isArray(values) ||
        (typeof albedo !== 'number' && values.length !== 3) ||
        values.some((v) => !(typeof v === 'number' && v >= 0 && v <= 1))
      )
        throw new RangeError('Invalid sky groundAlbedo; use a number from 0 to 1 or three of them (linear RGB)');
      if (!f.bruneton) throw new TypeError('Sky groundAlbedo needs bruneton from @margoengine/sky/bruneton');
    }
    if (o.coverage !== undefined && typeof o.coverage !== 'boolean')
      throw new RangeError('Sky coverage must be true or false; pass a boolean');
    if (o.environment !== undefined && typeof o.environment !== 'boolean')
      throw new RangeError('Sky environment must be true or false; pass a boolean');
    if (o.environment && !f.lighting)
      throw new TypeError('Sky environment needs lighting from @margoengine/sky/lighting');
    if (o.look !== undefined || o.atmosphere !== undefined) {
      if (!f.look) throw new TypeError('Sky look and atmosphere need look from @margoengine/sky/look');
      f.look.validate(o);
    }
    for (const key of ['clouds', 'fog', 'night', 'lighting'] as const) {
      const value = o[key],
        feature = f[key];
      if (value === undefined) continue;
      if (!feature) throw new TypeError(`Sky ${key} needs ${key} from @margoengine/sky/${key}`);
      (feature.validate as (value: unknown) => void)(value);
    }
  }
  static attach(engine: EngineKernel, options: SkyOptions = {}, features: SkyFeatures = {}): Sky {
    const runtime = engineRuntime(engine);
    // Core calls a second plugin of one name only "Invalid plugin"; say that it is a second sky and what to do instead.
    if (runtime.plugins.has('sky'))
      throw margoError(
        'attached',
        'This scene already has a Sky; change sky.options on that one, or dispose() it first',
      );
    const effect = new this(options, features);
    runtime.use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Sky requires WebGPU; attach a new Sky to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu,
      f = this.features;
    const u = this.bindUniform(d);
    this.transmission = d.createTexture({
      size: [128, 32],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const t = this.transmission.createView();
    this.tables = f.bruneton?.create(d, u, t, this.owned, this.extend());
    this.entries = this.skyEntries(u);
    this.pipeline = compute(d, this.atmosphere + transmittance);
    this.group = group(d, this.pipeline, [u, t]);
    this.reflection = f.reflection?.create(d, this.code, this.entries, this.owned);
    this.lit = f.lighting?.create(d, this.code, this.entries, this.owned);
  }
  registerPasses(graph: FrameGraph): void {
    if (this.features.lighting)
      graph.add({
        name: 'sky:lighting',
        order: -6,
        execute: (c) => {
          // The scene's ambient light is the sky of this frame: upload it first, then render and project it. The
          // shader patch waits for sky:environment, so an explicit environment can take the ambient first.
          if (c.backend === 'webgpu' && this.options.lighting?.ambient) {
            this.prepare(c);
            this.lit!.pass(c, this.environmentLightLayer ?? this.environmentLayer);
          }
        },
      });
    if (this.features.lighting)
      graph.add({
        name: 'sky:environment',
        // After the scene effects that patch the shader at -1 (EnvironmentLighting, light probes): one ambient term per
        // shader, and an explicit environment owns it. The sky's ambient (`lighting.ambient`, or the `environment`
        // fallback) lights only what none of them has already lit, found by the term they leave in the shader; the sky
        // still drives the sun and moon. Two `let margoAmbient=` failed to compile and lost the GPU (KB-ENV-AMBIENT-DUP1).
        order: -0.5,
        execute: (c) => {
          if (c.backend !== 'webgpu' || c.shader.includes('let margoAmbient=')) return;
          if (this.options.lighting?.ambient) this.lit!.patch(c);
          else if (this.options.environment) {
            this.prepare(c);
            this.lit!.pass(c, this.environmentLightLayer ?? this.environmentLayer);
            this.lit!.patch(c);
          }
        },
      });
    graph.add({
      name: 'sky:atmosphere',
      order: 2,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
    // The reflection map is drawn clear at 2, where VolumetricClouds (3) take their own sky light from it, then again
    // with the environment layer (their deck) over it, before Water (4) reflects it.
    if (this.features.reflection)
      graph.add({
        name: 'sky:environment-layer',
        order: 3.5,
        execute: (c) => {
          if (c.backend === 'webgpu' && this.environmentLayer && this.reflectionRequested)
            this.reflection?.run(c, this.environmentLayer);
        },
      });
    if (this.features.fog)
      graph.add({
        name: 'sky:fog',
        order: 5,
        execute: (c) => {
          if (c.backend === 'webgpu' && this.options.fog)
            (this.fogPass ??= this.features.fog!.create(this.code)).draw(c, this.options.fog, this.entries);
        },
      });
  }
  /** Seconds on this sky's clock: the sum of the deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  /**
   * Puts the sky's clocks back to 0 (the cloud sheet's drift, the star time) and `options.hours` back to the value it
   * was built with, as a fresh sky with the same options has them, so a later `seek` (`resetClocks` from
   * `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.cloudTime = 0;
    this.seconds = 0;
    this.options.hours = this.startHours;
  }
  /**
   * Moves the sky's clocks by `delta` seconds without drawing: the cloud sheet's drift, the star time and `hours`.
   * Each frame update runs it first, so `seek` from `@margoengine/cutscene/seek` replays these steps exactly.
   */
  advanceTime(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid sky delta; pass a finite delta of 0 or more seconds.');
    this.cloudTime += delta * (this.options.clouds?.speed ?? 8);
    this.seconds += delta;
    this.options.hours = ((((this.options.hours ?? 12) + delta * (this.options.timeScale ?? 1 / 3600)) % 24) + 24) % 24;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
    if (this.options.sunDirection) {
      const length = Math.hypot(...this.options.sunDirection);
      for (let i = 0; i < 3; i++) this.sun[i] = this.options.sunDirection[i] / length;
    } else sunDirection(this.options.hours ?? 12, this.sun);
    // Margo design choice: the day/night blend window (sun.y + 0.12) / 0.2. The moon's light is the drawn moon's
    // (moonlight.ts); until 2026-11-16 it was a tenth of the sun's whatever the phase (KB-CABIN-MOON1).
    const l = this.options.lighting,
      t = Math.max(0, Math.min(1, (this.sun[1] + 0.12) / 0.2)),
      night = 1 - t * t * (3 - 2 * t);
    if (night < 1 && !this.features.preetham && !this.features.bruneton)
      throw new RangeError('Daylight needs a day model: preetham or bruneton from @margoengine/sky');
    // With a night set, the lighting moon is the night's moon, placed or at the night's default, so the disc, its
    // glow, the cloud lighting, the glints and the scene light agree; without one it keeps its own default. Until
    // 2026-11-13 a night without moonDirection drew its moon at NIGHT_MOON_DIRECTION but lit from DEFAULT_MOON, so a
    // second, unseen moon lit the clouds and threw a bright glow elsewhere in the sky. With a night set, its disc is
    // drawn once, by the night (the sky and skyEnvironment add moonRadiance only while frame.sunlight.w is 0): until
    // 2026-11-13 both drew one, so a 0.018 rad lighting disc sat inside the night's own and the moon read as two discs.
    const placed = this.options.night?.moonDirection,
      to = placed ?? (this.options.night ? NIGHT_MOON_DIRECTION : DEFAULT_MOON),
      span = Math.hypot(to[0], to[1], to[2]);
    for (let i = 0; i < 3; i++) this.moon[i] = to[i] / span;
    const moonT = Math.max(0, Math.min(1, -this.sun[1] / 0.12)),
      moonVisibility = moonT * moonT * (3 - 2 * moonT),
      lit = l?.moon
        ? moonlight(
            this.options.night ? moonPhase(this.options.night.moonPhase ?? 0.85) : 1,
            this.moon,
            l.moon.extinction,
            this.moonlit,
          )
        : undefined,
      // The presets (moonLook) scale the light and change the drawn disc; prepare() applies the disc's share.
      look = l?.moon ? this.look(l.moon) : undefined,
      brightness = look?.light ?? 1,
      set = typeof l?.moon?.color === 'object' ? l.moon.color : undefined,
      moonColor =
        set ?? (lit ? moonlightColor(lit.illuminance * brightness, this.aboveColor, look!.source) : UNLIT_MOON_COLOR),
      moonIntensity = l?.moon ? (l.moon.intensity ?? lit!.illuminance / (luminance(moonColor) || 1)) * brightness : 0;
    this.disc = look;
    // Under the cloud: Kasten and Czeplak's share of the illuminance, its colour for that level (moonlight.ts).
    const cover = l?.moon?.cloudCover ?? (this.options.clouds ? (this.options.clouds.coverage ?? 0.45) : 0),
      belowLux =
        moonIntensity * luminance(moonColor) * (this.deck ? this.deck(this.moon[1]) : cloudTransmittance(cover)),
      belowColor = set ?? (l?.moon ? moonlightColor(belowLux, this.belowColor, look!.source) : UNLIT_MOON_COLOR);
    this.values[23] = night;
    this.values.set(this.moon, 28);
    this.values[31] = moonIntensity * moonVisibility;
    this.values.set(moonColor, 32);
    // The sun's strength and colour come from the atmosphere's transmittance (the sky's own model), relative to noon.
    // Surfaces add their own N.L, so no further elevation factor: the low sun is dimmed and warmed once, by the air.
    // The eye altitude is this frame's camera's: prepare() sets values[19] only when the sky passes run, after this, so
    // reading it here lit each frame with the camera of the frame before and the first frame from sea level
    // (GAP-FILM-LATE, GAP-FILM-READY).
    const eye = Math.max(0.001, (this.engine?.camera.position[1] ?? 0) / 1000),
      a = this.options.atmosphere,
      s = sunlight(
        this.sun[1],
        eye,
        this.options.turbidity ?? 2,
        this.sunColor,
        a && this.features.look ? this.features.look.air(this.options, this.air) : undefined,
      );
    // The air's sun above it (sunIntensity, sunColor) scales the sunlight the clouds take and the engine light.
    if (a) for (let i = 0; i < 3; i++) s[i] *= (a.sunColor?.[i] ?? 1) * (a.sunIntensity ?? 1);
    const peak = Math.max(s[0], s[1], s[2]);
    this.values.set(s, 60);
    this.lights[0].direction.set(this.sun);
    // The overcast deck hides the sun (CIE sky type 1): the engine sun fades out with it from 80 to 100 percent cover.
    const sheet = this.features.clouds && this.options.clouds ? (this.options.clouds.coverage ?? 0.45) : 0;
    this.lights[0].direction[3] = l
      ? (l.intensity ?? 1) * peak * (this.deck ? this.deck(this.sun[1]) : 1) * (1 - overcastShare(sheet))
      : 0;
    for (let i = 0; i < 3; i++) this.lights[0].radiance[i] = (l?.color?.[i] ?? 1) * (peak > 0 ? s[i] / peak : 1);
    this.lights[1].direction.set(this.moon);
    this.lights[1].direction[3] = this.values[31];
    this.lights[1].radiance.set(moonColor);
    this.moonUnderClouds.direction.set(this.moon);
    this.moonUnderClouds.direction[3] = (belowLux / (luminance(belowColor) || 1)) * moonVisibility;
    this.moonUnderClouds.radiance.set(belowColor);
    // Twilight (twilight.ts): the USNO sky illuminance from the sun's side 45 degrees up, cross-faded with the day
    // sky by the same night blend: the environment (SH and reflections) draws the day sky times 1 - night
    // (skyRadiance, environment.ts), so twilight carries the sky's light times night and the two never count it twice.
    // The blend starts at 0 with the sun 4.6 degrees up, so the light grows in continuously instead of switching on
    // at the full 756 lux when the sun's centre crosses the horizon (KB-TWILIGHT1).
    const tw = l && l.twilight !== false ? (l.twilight ?? {}) : undefined,
      t2 = this.twilightLight.direction;
    t2[3] = 0;
    if (tw && night > 0) {
      const lux =
          night *
          twilightIlluminance(Math.asin(this.sun[1])) *
          (tw.brightness ?? 1) *
          cloudTransmittance(tw.cloudCover ?? (this.options.clouds ? (this.options.clouds.coverage ?? 0.45) : 0)),
        c = tw.color ?? twilightLightColor(-Math.asin(this.sun[1]), lux, this.twilightColor),
        flat = Math.hypot(this.sun[0], this.sun[2]) / Math.SQRT1_2;
      t2[0] = flat > 0 ? this.sun[0] / flat : 0;
      t2[1] = flat > 0 ? Math.SQRT1_2 : 1;
      t2[2] = flat > 0 ? this.sun[2] / flat : 0;
      t2[3] = ((lux / SUN_ILLUMINANCE) * (l!.intensity ?? 1)) / t2[1] / (luminance(c) || 1);
      this.twilightLight.radiance.set(c);
    }
    // The light map is in the sky's own units; the engine's sun is lighting.intensity times its share of the zenith
    // sun on the ground. One factor a frame takes the map into the sun's units, so the clear sky gives its measured
    // share of the light on level ground (0.1 to 0.2, Erbs, Klein and Duffie 1982) at any intensity. The zenith sun on
    // the ground in sky units: Preetham's is 4 pi x 0.55, the clouds' sun calibrated to that share at noon (turbidity
    // 2); Bruneton's is 20 sky units above the air times the zenith transmittance down to the eye. The environment
    // fallback drives no sun: its sky is the light of the engine's own sun, whatever set it. Until 2026-11-17 the map lit the scene in sky units, 1.4 times
    // the sun on level ground, and a brighter sun only diluted it (KB-SKY-SUNUNITS1).
    const zenith =
      this.options.model === 'bruneton'
        ? 20 * zenithTransmittance(eye, this.options.turbidity ?? 2, a && this.features.look ? this.air : undefined)
        : PREETHAM_SUN;
    this.zenithSun = zenith;
    this.lightScale = zenith > 0 ? (l ? (l.intensity ?? 1) : (this.engine?.lighting?.direction[3] ?? 0)) / zenith : 0;
    // The day sky drawn in the same units (KB-SKY-SANDGREY1): the picture, fog and maps take lightScale by day through
    // the exposure uniform, so the light map takes only what is left of it. The night keeps its own look.
    const lights = !!this.lit && !!(l || this.options.environment);
    this.pictureScale =
      lights && this.options.balance !== false && this.lightScale > 0
        ? this.lightScale + (1 - this.lightScale) * night
        : 1;
    if (lights)
      this.lit!.update(this.engine!.lighting, this, l, this.ambient(), night, this.lightScale / this.pictureScale);
  }
  /** Uploads this frame's uniform and refreshes the tables; idempotent within a frame (lighting runs it earlier). */
  private prepare(c: SkyPassContext): void {
    this.validate();
    const extended = !!(this.options.look || this.options.atmosphere);
    if (this.options.model !== this.model || !!this.options.night !== this.stylized || extended !== this.extended)
      this.recode();
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.scratch))
      throw new MargoError('state', 'Invalid sky camera; give the camera a finite, invertible projection');
    this.values.set(c.camera.position, 16);
    this.values[19] = Math.max(0.001, c.camera.position[1] / 1000);
    this.values.set(this.sun, 20);
    this.values[24] = +(this.options.model === 'bruneton');
    this.values[25] = (this.options.exposure ?? 0) + Math.log2(this.pictureScale);
    this.values[26] = this.options.turbidity ?? 2;
    this.values[36] = this.options.clouds ? (this.options.clouds.coverage ?? 0.45) : 0;
    this.values[37] = this.cloudTime;
    this.values[38] = this.options.clouds?.height ?? 1500;
    // The overcast deck's two-stream transmission, 1 / (1 + 0.075 depth), in the model's units: the clouds' sun is
    // Preetham's (4 pi x 0.55 sky units at the zenith on the ground) and Bruneton's zenith sun is 20 x the zenith
    // transmittance, about 2.6 times as many (clouds.ts cloudDeck reads it from moonColor.w, which nothing else reads).
    const units =
      this.options.model === 'bruneton'
        ? (20 *
            zenithTransmittance(
              this.values[19],
              this.options.turbidity ?? 2,
              this.options.atmosphere && this.features.look ? this.air : undefined,
            )) /
          PREETHAM_SUN
        : 1;
    this.values[35] = this.options.clouds ? units / (1 + (this.options.clouds.depth ?? 20) * 0.075) : 0;
    this.values[27] = +linearHdr(c.format);
    // Uniform layout of SkyNightOptions: zenith+twinkle, horizon+haze, moon direction+cos(size), moon colour+sin(size), phase/glow/stars/time; then the sun colour (60-62, set before update) and the enabled flag (63).
    const n = this.options.night;
    this.values[63] = +!!n;
    if (n) {
      this.features.night!.write(this.values, n, this.seconds);
      // The moon presets of lighting.moon (moonLook) change the disc the night draws: its colour and its width.
      const look = this.disc;
      if (look) {
        for (let i = 0; i < 3; i++) this.values[52 + i] *= look.disc[i];
        const size = Math.min(1.57, (n.moonSize ?? 0.038) * look.size);
        this.values[51] = Math.cos(size);
        this.values[55] = Math.sin(size);
      }
    }
    if (this.extended) this.features.look!.air(this.options, this.air);
    // The Mie asymmetry the Bruneton sky's per-pixel phase reads (clouds.w, free in the Frame): the look's, else 0.8.
    if (this.options.model === 'bruneton') this.values[39] = this.extended ? this.air[7] : 0.8;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    // The air changes the tables as turbidity does: a new value refills them.
    let air = false;
    if (this.extended) {
      const look = this.features.look!;
      look.write(
        this.extra,
        this.options,
        this.air,
        this.zenithSun,
        2 ** (this.options.exposure ?? 0) * this.pictureScale,
      );
      c.device.queue.writeBuffer(this.uniform!, 256, this.extra as Float32Array<ArrayBuffer>);
      for (let i = 0; i < 9; i++) air ||= this.air[i] !== this.computedAir[i];
      this.computedAir.set(this.air);
    }
    const turbidity = this.options.turbidity ?? 2;
    if (this.computedT !== turbidity || air) dispatch(c, this.pipeline!, this.group!, 16, 4);
    const albedo = this.options.groundAlbedo ?? 0,
      a = this.albedo;
    a[3] = 0;
    for (let i = 0; i < 3; i++) {
      a[i] = typeof albedo === 'number' ? albedo : albedo[i];
      if (a[i] !== this.scatteringA[i]) a[3] = 1;
    }
    if (this.options.model === 'bruneton' && (this.scatteringT !== turbidity || a[3] || air)) {
      this.tables!.run(c, a);
      this.scatteringT = turbidity;
      for (let i = 0; i < 3; i++) this.scatteringA[i] = a[i];
    }
    this.computedT = turbidity;
  }
  /**
   * A live model switch, or a stylized night set or cleared: the sky, fog, reflection and lighting shaders are compiled
   * again; `reflectionTexture` and the lighting resources stay the same objects.
   */
  private recode(): void {
    this.model = this.options.model;
    this.stylized = !!this.options.night;
    const extended = !!(this.options.look || this.options.atmosphere) && !!this.features.look;
    if (extended !== this.extended) {
      // The air lives in the transmittance and Bruneton tables too: compile them again and refill them.
      this.extended = extended;
      this.atmosphere = compose(this.features, this.model, this.stylized, extended)[0];
      if (this.engine?.gpu && this.uniform) {
        const u = this.bindUniform(this.engine.gpu);
        this.pipeline = compute(this.engine.gpu, this.atmosphere + transmittance);
        this.group = group(this.engine.gpu, this.pipeline, [u, this.transmission!.createView()]);
        this.tables?.recode?.(this.extend(), u);
      }
      this.computedT = this.scatteringT = NaN;
      this.computedAir.fill(NaN);
    }
    this.code = compose(this.features, this.model, this.stylized, extended)[1];
    if (this.uniform) this.entries = this.skyEntries({ buffer: this.uniform });
    this.format = '';
    this.fogPass?.release();
    this.fogPass = undefined;
    this.reflection?.recode(this.code, this.entries);
    this.lit?.recode(this.code, this.entries);
  }
  /** The uniform for the current program: 64 values, then the look's 72 while extended (see `plain` and `wide`). */
  private bindUniform(d: GPUDevice): GPUBufferBinding {
    let b = this.extended ? this.wide : this.plain;
    if (!b) {
      b = d.createBuffer({
        size: this.extended ? 256 + LOOK_FLOATS * 4 : 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      if (this.extended) this.wide = b;
      else this.plain = b;
    }
    this.uniform = b;
    return { buffer: b };
  }
  /** The look's rewrite of the table shaders while the look or air is set, else undefined (the tables as built). */
  private extend(): ((code: string) => string) | undefined {
    const look = this.features.look;
    return this.extended && look ? (code) => look.extend(code, false) : undefined;
  }
  /** The uniform, and the Bruneton tables only when the shaders read them (auto layouts drop unused bindings). */
  private skyEntries(u: GPUBufferBinding): GPUBindGroupEntry[] {
    return [
      { binding: 0, resource: u },
      ...(this.tables && this.model === 'bruneton' ? [{ binding: 1, resource: this.tables.view }] : []),
    ];
  }
  private draw(c: SkyPassContext): void {
    this.prepare(c);
    if (this.reflectionRequested) this.reflection?.run(c);
    const format = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil!.format;
    if (this.format !== format) {
      const module = c.device.createShaderModule({ code: this.code });
      this.render = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: false,
        },
      });
      this.bind = c.device.createBindGroup({
        layout: this.render.getBindGroupLayout(0),
        entries: [...this.entries, { binding: 2, resource: this.transmission!.createView() }],
      });
      this.format = format;
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.render!);
    pass.setBindGroup(0, this.bind!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    if (this.options.coverage) {
      if (!c.view?.target) this.drawCoverage(c);
    } else this.dropCoverage();
  }
  /**
   * The coverage record: the sky's own full-screen triangle at its depth, against the same depth with the same test,
   * writing 1 into an `r8unorm` target (resolved when multisampled), so it covers exactly the samples the sky drew.
   */
  private drawCoverage(c: SkyPassContext): void {
    const d = c.device,
      n = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      size = [c.width, c.height],
      key = size + ':' + n + ':' + depth;
    if (this.cover?.[0] !== key) {
      this.dropCoverage();
      const texture = d.createTexture({
          size,
          format: 'r8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
        samples =
          n > 1
            ? d.createTexture({ size, format: 'r8unorm', sampleCount: n, usage: GPUTextureUsage.RENDER_ATTACHMENT })
            : undefined,
        module = d.createShaderModule({
          code: fullscreen + '@fragment fn fragment()->@location(0) vec4f{return vec4f(1);}',
        });
      this.cover = [
        key,
        texture,
        texture.createView(),
        d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r8unorm' }] },
          multisample: c.descriptor.multisample,
          depthStencil: { format: depth, depthCompare: 'greater-equal', depthWriteEnabled: false },
        }),
        samples?.createView(),
        samples,
      ];
    }
    const [, , view, pipeline, many] = this.cover!,
      pass = c.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: many ?? view,
            resolveTarget: many && view,
            loadOp: viewLoadOp(c),
            clearValue: [0, 0, 0, 0],
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
      });
    pass.setPipeline(pipeline);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private dropCoverage(): void {
    this.cover?.[1].destroy();
    this.cover?.[5]?.destroy();
    this.cover = undefined;
  }
  private release(): void {
    this.dropCoverage();
    this.plain?.destroy();
    this.wide?.destroy();
    this.fogPass?.release();
    this.transmission?.destroy();
    for (const r of this.owned) r.destroy();
    this.owned = [];
    this.uniform = this.plain = this.wide = this.transmission = undefined;
    this.lit = this.fogPass = this.tables = this.reflection = undefined;
    this.pipeline = this.group = this.render = this.bind = undefined;
    this.entries = [];
    this.format = '';
    this.computedT = this.scatteringT = NaN;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.targets.values()]) release();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

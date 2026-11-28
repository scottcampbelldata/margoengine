/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { cloudLayerFor, isCloudLayerName, type MutableCloudLayer } from './cloud-types.js';
import { ParticleOverlay } from '../../shared/particle-overlay.js';
import { fullscreen } from '../../shared/gpu.js';
import { applyView, viewSize } from '../../shared/view-rect.js';
import { publishReactiveMask, reactiveMaskWanted } from '../../shared/reactive-mask.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type WeatherPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Speed of sound in air at 20 C, metres per second: thunder follows lightning by `distance / speed`. */
export const speedOfSound = 343;

/** `lightning` option of {@link Weather}: storms that flash the scene and report each strike and its thunder. */
export interface WeatherLightningOptions {
  /** Strikes per minute when `intensity` is 1; the rate rises from 0 at `threshold`. Default 6. */
  rate?: number;
  /** Intensity (0..1) below which no lightning strikes. Default 0.6. */
  threshold?: number;
  /** Nearest strike, metres from the listener. Default 300. */
  minDistance?: number;
  /** Farthest strike, metres. Default 6000. */
  maxDistance?: number;
  /** Peak brightness of the flash overlay, linear light added to the whole frame. Default 0.35. 0 turns the overlay off. */
  strength?: number;
  /** Colour of the flash, linear RGB. Default a cool white. */
  color?: Vec3;
  /** Seed of the strike generator: the same seed and frame times give the same storm. Default 1. */
  seed?: number;
  /**
   * Holds the flash at this brightness, 0 to 1, in place of the strikes' own (for stills: the overlay, `flash` and
   * {@link Weather.lightningLight} all take it, at the last strike's place). Omitted: the strikes drive it.
   */
  hold?: number;
  /** The flash's light in the scene, {@link Weather.lightningLight}. Every field has a measured default. */
  light?: WeatherLightningLightOptions;
  /** The flash's light inside the cloud deck, {@link Weather.cloudFlash}. Every field has a measured default. */
  cloud?: WeatherLightningCloudOptions;
  /**
   * Where the flash goes with no wiring: `true` (the default) or an object lights the scene's cloud deck, fog and light
   * list by themselves ({@link WeatherLightningLinkOptions}); `false` leaves all three to you (`weather.cloudFlash`,
   * `weather.lightningLight`).
   */
  link?: boolean | WeatherLightningLinkOptions;
  /** The drawn bolt, read by `LightningBolt` (`@margoengine/sky/lightning-bolt`); also the channel the light follows. */
  bolt?: LightningBoltOptions;
}

/**
 * `lightning.link` of {@link Weather}: what the weather wires the flash into among the scene's plugins, found by name
 * each frame (a plugin attached later is found too). A value you set yourself always wins: a deck given its own `flash`,
 * a fog given its own `lightning`, are left alone.
 */
export interface WeatherLightningLinkOptions {
  /** Every `VolumetricClouds` (`sky:volumetric-clouds`) without a `flash` takes {@link Weather.cloudFlash}, so the deck lights from inside. Default true. */
  clouds?: boolean;
  /** Every `VolumetricFog` (`volumetric-fog`) without a `lightning` takes `{light: weather.lightningLight}`, so the lit deck lights the air under it. Default true. */
  fog?: boolean;
  /**
   * The scene's `LightGroups` (`clustered-groups`, `@margoengine/clustered/groups`) gets a group holding
   * {@link Weather.lightningLight} while a flash lasts, so the ground, the sea and the props flash by themselves, with
   * a shadow where the lights have shadow maps. Default true.
   */
  lights?: boolean;
  /** Name of the light group. Default `'lightning'`. */
  group?: string;
}

/**
 * `lightning.cloud` of {@link Weather}: the part of a strike's light given off inside the cloud deck, which lights the
 * deck from within ({@link Weather.cloudFlash}, for `VolumetricClouds` `flash`).
 */
export interface WeatherLightningCloudOptions {
  /**
   * Height of the cloud base above the strike point, metres, 0 to 20,000. Default {@link LIGHTNING_CLOUD_BASE}, the
   * `VolumetricClouds` default `bottom`; give the deck's own `bottom`.
   */
  base?: number;
  /**
   * Peak luminous intensity in candela, 0 or more. Default the share of `lightning.light.peak` the channel gives off
   * above `base`, {@link lightningCloudShare}.
   */
  peak?: number;
  /** Size of the flash's core in metres, 1 to 100,000 (`VolumetricClouds` `flash.radius`). Default 200. */
  radius?: number;
  /** Multiplies the deck's flash (after the light's own `scale`), 0 to 1,000. Default 1. */
  scale?: number;
}

/**
 * `lightning.bolt` of {@link Weather}: the drawn bolt of `LightningBolt` (`@margoengine/sky/lightning-bolt`), read every
 * frame; the same object holds the channel's shape and its look. Every field has a default. Changing a shape field
 * (everything but `scale`, `width`, `glow` and `fade`) grows the channel of a live strike again.
 */
export interface LightningBoltOptions {
  /** Multiplies the bolt's brightness, 0 or more; 0 draws nothing. Default 1. */
  scale?: number;
  /** Width of the hot core, metres, 0.01 to 100. Default 1.5 (at least one pixel wide on screen). */
  width?: number;
  /** Width of the glow around the channel, metres, 0 to 2,000: 0 draws the core alone. Default 80. */
  glow?: number;
  /** Chance each channel point forks a branch, 0 to 0.5. Default 0.06. */
  branching?: number;
  /** Half angle of the cone each growth step is drawn in, degrees, 5 to 85: how crooked the channel is. Default 50. */
  spread?: number;
  /** Growth steps down the main channel, 8 to 400: how fine its kinks are. Default 80. */
  detail?: number;
  /** Seconds the hot core takes to fade to 1/e after a return stroke, 0.001 to 1; the glow keeps the flash's 70 ms. Default 0.03. */
  fade?: number;
  /** Height of the channel's top above the strike, metres. Default the cloud base (`lightning.cloud.base`, else 1,500). */
  top?: number;
}

/** `lightning.light` of {@link Weather}: the point light a strike gives the scene, {@link Weather.lightningLight}. */
export interface WeatherLightningLightOptions {
  /** Peak luminous intensity in candela, 0 or more. Default {@link LIGHTNING_PEAK_CANDELA}, a measured first stroke's light. */
  peak?: number;
  /** Height of the light above the strike point, metres, 0 to 20,000. Default {@link LIGHTNING_LIGHT_HEIGHT}. */
  height?: number;
  /** Linear RGB, any scale (the largest channel is taken as 1). Default {@link LIGHTNING_COLOR}, a 30,000 K channel. */
  color?: Vec3;
  /** Multiplies `peak` (the deck's flash follows it), 0 to 1,000: a slider's brightness. Default 1. */
  scale?: number;
  /** Metres where the light ends (a point light's `range`), 1 to 1,000,000. Default 1.5 times `maxDistance`. */
  range?: number;
  /**
   * The light's shadow: `true` or `{near, far}` (metres from the light, `far` default 3,000; near default 1) gives the
   * light a shadow map when the lights have them (`ClusteredOptions.shadows`), `false` none. Default `true` while the
   * scene's `Clustered` has a free shadow map slot for it ({@link WeatherLightningLinkOptions.lights}), else none.
   */
  shadow?: boolean | { near?: number; far?: number };
  /**
   * The light follows the bolt's channel as a few lights along it (Reed and Wyvill 1994 light the scene from the
   * channel) in place of one point light 700 m up: `true` always (the point light stays where no `LightningBolt`
   * supplies a channel), `false` never. Default: while a `LightningBolt` is attached to this weather. The total light
   * stays `peak` times the strokes' level, shared by height as the channel's light falls with it.
   */
  line?: boolean;
  /** Lights along the channel, 1 to 8. Default 3. */
  segments?: number;
}

/**
 * Peak luminous intensity of the lightning light, candela: 1.43e7, a first return stroke's measured light spread over
 * the scene flash. A first stroke radiates 2.3e9 W at peak (mean of strokes 5 to 35 km away, 0.4 to 1.1 um; Y. Guo
 * and E. P. Krider, "The optical and radiation field signatures produced by lightning return strokes", J. Geophys.
 * Res. 87(C11):8913-8922, 1982) for a characteristic width, energy over peak power, of 36 us (the means of M. G. Quick
 * and E. P. Krider, "Optical power and energy radiated by return strokes in rocket-triggered lightning", J. Geophys.
 * Res. Atmos. 122:8816-8832, 2017: 150 J/m over 4.2 MW/m), 82 kJ of light. The channel at peak is a plasma of 28,000
 * to 31,000 K (R. E. Orville, "A high-speed time-resolved spectroscopic study of the lightning return stroke: Part II,
 * a quantitative analysis", J. Atmos. Sci. 25(5):839-851, 1968); a 30,000 K Planck spectrum over the band, weighted by
 * the photopic curve (C. Wyman, P.-P. Sloan and P. Shirley, "Simple analytic approximations to the CIE XYZ color
 * matching functions", JCGT 2(2), 2013), gives 161.7 lm per watt. A frame records that light over its exposure, not
 * the microseconds it lasts, so the light keeps the stroke's luminous energy over the flash envelope of
 * {@link lightningFlash} (8 ms rise, 70 ms fall: 0.074 s at peak) and 4 pi sr. The real spectrum is lines, many in
 * the near infrared (O I 777 nm, N I 868 nm), so the efficacy is an upper estimate; `lightning.light.peak` sets another.
 */
export const LIGHTNING_PEAK_CANDELA = (2.3e9 * (150 / 4.2e6) * 161.7) / (0.074 * 4 * Math.PI);
/**
 * Height of the lightning light above the strike point, metres: 700. A return stroke's light falls off with height
 * along the channel as exp(-z / 0.6 to 0.8 km) (C. D. Jordan and M. A. Uman, "Variation in light intensity with height
 * and time from subsequent lightning return strokes", J. Geophys. Res. 88(C11):6555-6562, 1983), so the light's centre
 * on a channel much longer than that sits at the decay length.
 */
export const LIGHTNING_LIGHT_HEIGHT = 700;
/** Default height of the cloud base for {@link Weather.cloudFlash}, metres: 1500, the `VolumetricClouds` default `bottom`. */
export const LIGHTNING_CLOUD_BASE = 1500;
/**
 * Share of a return stroke's light the channel gives off above a cloud base `base` metres up: e^(-base / 700). Its
 * light per metre falls off with height as exp(-z / 0.6 to 0.8 km) (Jordan and Uman 1983, {@link LIGHTNING_LIGHT_HEIGHT}),
 * so the part above the base carries e^(-base / decay) of it, with its centre one decay length above the base, the
 * position of {@link Weather.cloudFlash}. 0.117 for the default 1500 m base, 0.395 for a 650 m storm deck.
 * @throws RangeError for a negative or non-finite base.
 */
export function lightningCloudShare(base: number): number {
  if (!(base >= 0 && base < Infinity)) throw new RangeError('Invalid lightning cloud base; give 0 or more metres.');
  return Math.exp(-base / LIGHTNING_LIGHT_HEIGHT);
}
/**
 * Colour of a 30,000 K channel (Orville 1968), linear sRGB, largest channel 1: the chromaticity (0.2502, 0.2488) of
 * its Planck spectrum by Wyman et al.'s fits, through `chromaticityToLinearSRGB` (`@margoengine/math/color`).
 */
export const LIGHTNING_COLOR: Vec3 = [0.3623, 0.4973, 1];

/**
 * A bolt's channel as the light of the scene: `lights` gives up to `count` points along it, each with its share of the
 * light (`weight`, summing to 1) and the size of the line it stands for. Set by `LightningBolt` on `Weather.channelSource`.
 */
export interface LightningChannelSource {
  lights(
    strike: LightningStrike,
    count: number,
    decay: number,
  ): readonly { position: Vec3; weight: number; radius: number }[];
}

/** A strike whose light has not died away: {@link Weather.liveStrikes}. */
export interface LiveStrike {
  readonly strike: LightningStrike;
  /** Seconds since it struck. */
  readonly age: number;
  /** Start of each return stroke, seconds after the strike. */
  readonly offsets: readonly number[];
  /** Relative peak of each return stroke, 0..1. */
  readonly amplitudes: readonly number[];
}

/** {@link Weather.lightningLight}: a point light (`PointLight` of `@margoengine/clustered`), changed in place each frame. */
export interface LightningLight {
  position: [number, number, number];
  color: [number, number, number];
  /** Candela over the colour's luminance, so the light gives `peak` times the strokes' level in candela. */
  intensity: number;
  range: number;
  /** 2: inverse square. */
  decay: number;
  /** The shadow map the light asks for when the lights have them ({@link WeatherLightningLightOptions.shadow}); unset otherwise. */
  shadow?: { near: number; far: number };
  /** Size of the sphere the light stands for, metres (set on the lights along a channel). */
  radius?: number;
}

/**
 * Settings of a {@link Weather}, read every frame from `weather.options`. A value out of range throws RangeError, a
 * value of the wrong shape TypeError.
 */
export interface WeatherOptions {
  /** `'rain'` streaks, `'snow'` flakes, `'sleet'` (both at once, by `snowShare`), or `'none'`. Default `'rain'`. */
  precipitation?: 'rain' | 'snow' | 'sleet' | 'none';
  /** With `'sleet'`: the share of the precipitation that falls as snow, 0 to 1; the rest is rain. Default 0.5. */
  snowShare?: number;
  /** Target amount, 0 (dry) to 1 (storm). The visible {@link Weather.amount} eases to it over `fadeSeconds`. Default 0.5, or {@link rainIntensity} of `rainRate` when that is given. */
  intensity?: number;
  /**
   * Rain rate in millimetres of water per hour, 0 to 300. The rain's drops then fall at the speed of the drops that carry
   * the water, the median volume diameter {@link rainDropDiameter} of that rate (Marshall and Palmer 1948) at Gunn and
   * Kinzer's terminal speed ({@link rainFallSpeed}), so the streaks slant by atan(wind / fall) ({@link rainSlant}) and
   * lengthen with the speed (the streak is the distance a drop falls in the shutter time); a drizzle falls at 1 to 2
   * m/s, a downpour at 7. Unset keeps a fixed fall of 9 m/s. `WeatherDrive` (`@margoengine/weather`) sets it from the state.
   */
  rainRate?: number;
  /**
   * Where the rain rate comes from instead of `rainRate`: anything with `rainRateAt(position)` giving mm/h at a world
   * position, read at the camera every frame, such as the clouds' rain shafts (`VolumetricClouds` `rain`), so the rain
   * round the camera is the rain the shafts draw there and stops when the camera walks out from under them. Default none.
   */
  rainFrom?: { rainRateAt(position: readonly [number, number, number]): number };
  /** Seconds the amount takes to move across its whole range, 0 or more (0 jumps). Default 4. */
  fadeSeconds?: number;
  /** Horizontal wind in metres per second, world X and Z. Rain slants and snow drifts with it. Default [0, 0]. */
  wind?: readonly [number, number];
  /** Half-width in metres of the box around the camera that holds the particles, 2..200. Default 25. */
  radius?: number;
  /** Height in metres of that box, 2..200. Default 20. */
  height?: number;
  /**
   * Particles at intensity 1, 0..2,000,000. Default 24,000 for rain and 500,000 for snow: flakes are drawn at their real
   * size ({@link snowflakeDiameter}), most of them under a pixel, so it takes this many to give the falling snow its
   * density (KB-SNOW-NEARCAM2).
   */
  particles?: number;
  /**
   * Snowfall rate in millimetres of melted water per hour, 0.01 to 30: it sets the flakes' size distribution, Gunn and
   * Marshall's (1958) exponential, which broadens as the snow falls harder ({@link snowflakeDiameter}). Default 1.
   */
  snowfallRate?: number;
  /**
   * The range of flake sizes drawn, `[smallest, largest]` largest dimension in millimetres, 0.5 to 30, smallest first.
   * Default `[2, 10]`, the range over which Locatelli and Hobbs (1974) measured the mass of aggregate snowflakes; the
   * smaller single crystals, outside that mass law, are not drawn (their haze is the fog's).
   */
  flakeSizes?: readonly [number, number];
  /** Particle colour, linear RGB. Default a pale grey-blue for rain and white for snow. */
  color?: Vec3;
  /** Scales the particle colour, 0 or more: lower it at night (`1 - sky.nightFactor`). Default 1. */
  brightness?: number;
  /** Opacity of one particle, 0..1. Default 0.35 for rain and 0.8 for snow. */
  opacity?: number;
  /**
   * Also draw each frame's streak and flake coverage (0 to 1, depth tested like the particles) into an r8unorm mask,
   * {@link Weather.reactiveMask}, published to the frame for TAA, which reads it with no option: TAA then keeps little
   * history where the particles are, so they stay crisp over a sky whose history it keeps (volumetric clouds) instead
   * of being averaged away. Default: on while TAA (or another reader of reactive masks) runs, off otherwise; `true`
   * draws it every frame, `false` never.
   */
  reactive?: boolean;
  /**
   * Seconds the camera's shutter stays open, 0 to 1. Each snow flake is drawn as the capsule it sweeps over that time
   * along its motion (wind, fall and sway), its light spread over the capsule as a camera's time average records it,
   * so a flake in a gale streaks instead of showing as a frozen disc, or as a row of dots when sub-frames are summed
   * (give each sub-frame its own share of the shutter). Rain keeps its fixed streak. Default 0, a still disc; a camera
   * shooting at 24 fps with a 180 degree shutter opens for 1/48 s (the `snowNight` kit's night exposure).
   */
  exposure?: number;
  /**
   * The lens the snow is seen through. A flake off the focal plane draws as its blur disc, the thin lens's circle of
   * confusion added to its own size in quadrature, with its light spread over that disc (Potmesil and Chakravarty
   * 1981), so a flake right in front of the camera shows as the faint, soft disc a real lens makes of it, not as a
   * sharp speck. Names and defaults follow `@margoengine/dof`. `false` draws every flake sharp. Default
   * `{focalDistance: 10, aperture: 2.8, filmGauge: 36}`. Rain keeps its streaks sharp.
   */
  lens?: WeatherLensOptions | false;
  /**
   * Metres from the camera over which particles fade in: none nearer than the first, all from the second. The first is
   * never taken nearer than the camera's near plane. Default [0.4, 2].
   */
  nearFade?: readonly [number, number];
  /**
   * The range of raindrop diameters drawn, `[smallest, largest]` in millimetres, 0.1 to 8, smallest first. Each drop
   * takes its own diameter from Marshall and Palmer's exponential for the rain rate ({@link rainDropSample}), falls at
   * Gunn and Kinzer's terminal speed for that size, so it streaks for its own length and slants by its own
   * atan(wind / fall), and carries the light Garg and Nayar give a streak, its diameter over its speed
   * ({@link rainStreakWeight}). Drops above about 6 mm break up in the air (Villermaux and Bossa 2009). Default [0.5, 6].
   */
  dropSizes?: readonly [number, number];
  /**
   * How much the rain gathers into moving sheets, 0 (even rain) to 1: the drops' light is scaled by a smooth field that
   * travels with the wind, from a quarter in the gaps to twice in the sheets, keeping the mean ({@link rainSheet}).
   * Default 0.5.
   */
  rainVariation?: number;
  /**
   * Gust strength, 0 (steady wind) to 1: two gust fronts travel downwind at the wind speed and add up to this share of
   * the wind to each drop's motion, so the streaks' slant changes across the frame and over time ({@link rainGust}).
   * Nothing gusts in still air. Default 0.5.
   */
  gusts?: number;
  /** Storms; omitted means no lightning. */
  lightning?: WeatherLightningOptions;
}

/** The lens of {@link WeatherOptions.lens}: where it focuses and how wide it opens, as `@margoengine/dof` names them. */
export interface WeatherLensOptions {
  /** Metres from the camera to the plane in focus, along the view axis, above the focal length. Default 10. */
  focalDistance?: number;
  /** Lens f-number, 0.5 to 64: lower opens the lens and blurs what is off the focal plane more. Default 2.8. */
  aperture?: number;
  /**
   * Sensor size in millimetres along the view's longer side, 1 to 100: with the camera's field of view it gives the
   * focal length, as a real lens on that sensor would have it (36 full frame, 24.9 Super 35). Default 36.
   */
  filmGauge?: number;
}

/**
 * The thin lens of {@link WeatherOptions.lens} for a view `width` x `height` pixels and a vertical field of view of
 * `fov` degrees: `scale`, half the aperture's diameter times the focal length in pixels (pixel metres), `focus`, the
 * focal distance, and `focalLength`, metres. A point `depth` metres along the view axis blurs to a disc of radius
 * `scale * |depth - focus| / (depth * (focus - focalLength))` pixels ({@link snowflakeBokeh}).
 */
export function weatherLens(
  lens: WeatherLensOptions | false | undefined,
  width: number,
  height: number,
  fov: number,
): { scale: number; focus: number; focalLength: number } {
  const focus = (lens && lens.focalDistance) || 10;
  if (lens === false) return { scale: 0, focus, focalLength: 0 };
  const pixels = height / (2 * Math.tan((fov * Math.PI) / 360)),
    focalLength = (((lens?.filmGauge ?? 36) / 1000) * pixels) / Math.max(width, height),
    aperture = focalLength / (lens?.aperture ?? 2.8);
  if (!(focus > focalLength))
    throw new RangeError('Weather lens focalDistance must be farther than the focal length; pass a larger distance');
  return { scale: 0.5 * aperture * pixels, focus, focalLength };
}

/**
 * How a flake `pixels` in radius when sharp draws `depth` metres from the camera through the lens `weatherLens`
 * gives: its blur disc's `radius` in pixels, its circle of confusion added in quadrature (a disc convolved with the
 * aperture's disc keeps about the sum of their second moments), and `alpha`, the share of its peak opacity the disc
 * keeps when the flake's light is spread over it (pixels^2 / radius^2). A flake under a pixel is drawn a pixel wide
 * with its alpha scaled by its true area over the pixel's, so it keeps its light without being drawn larger than it
 * is (the point-sample coverage of Reeves 1983, "Particle systems", ACM TOG 2(2); the area-ratio fade of thin features
 * of Persson 2014, "Phone-wire AA", GPU Pro 5): light is opacity times disc area, `alpha * radius^2 = pixels^2`.
 */
export function snowflakeBokeh(
  pixels: number,
  depth: number,
  lens: { scale: number; focus: number; focalLength: number },
): { radius: number; alpha: number } {
  const coc =
      lens.scale === 0 ? 0 : (lens.scale * Math.abs(depth - lens.focus)) / (depth * (lens.focus - lens.focalLength)),
    radius = Math.max(Math.hypot(pixels, coc), 1);
  return { radius, alpha: (pixels * pixels) / (radius * radius) };
}

/**
 * Mass of an aggregate snowflake in milligrams per millimetre of its largest dimension to the power 1.4: Locatelli and
 * Hobbs (1974, "Fall speeds and masses of solid precipitation particles", J. Geophys. Res. 79(15), 2185 to 2197,
 * doi:10.1029/JC079i015p02185), aggregates of unrimed radiating assemblages of dendrites or dendrites, M = 0.073 D^1.4
 * for D 2 to 10 mm; the same aggregates fall at V = 0.8 D^0.16 m/s, 0.89 to 1.16 m/s over that range.
 */
export const SNOWFLAKE_MASS_COEFFICIENT = 0.073;

/**
 * The size law of {@link snowflakeDiameter} for a snowfall rate `rate` in mm of melted water per hour and the drawn
 * range `sizes` (largest dimension, mm): Gunn and Marshall's slope `lambda` per mm of melted diameter and the melted
 * diameters `low` and `high` (mm) of the range's ends, with `span = 1 - exp(-lambda (high - low))`.
 */
export function snowflakeSizeLaw(
  rate = 1,
  sizes: readonly [number, number] = [2, 10],
): { lambda: number; low: number; high: number; span: number } {
  const melted = (d: number) => Math.cbrt((6 * SNOWFLAKE_MASS_COEFFICIENT * d ** 1.4) / Math.PI),
    lambda = 2.55 * rate ** -0.48,
    low = melted(sizes[0]),
    high = melted(sizes[1]);
  return { lambda, low, high, span: 1 - Math.exp(-lambda * (high - low)) };
}

/**
 * The largest dimension in metres of the flake at quantile `u` (0 to 1) of a snowfall of `rate` mm of melted water per
 * hour, drawn over `sizes` mm. Melted diameters follow Gunn and Marshall's exponential, N(D) = N0 exp(-lambda D) with
 * lambda = 25.5 R^-0.48 per cm (Gunn and Marshall 1958, "The distribution with size of aggregate snowflakes", J.
 * Meteorol. 15(5), 452 to 461; Sekhon and Srivastava 1970, J. Atmos. Sci. 27(2), 299 to 307, refit it with 22.9
 * R^-0.45), cut to the melted diameters of `sizes` and drawn by its inverse; a melted diameter m (mm) is a flake whose
 * mass, pi m^3 / 6 mg of water, is Locatelli and Hobbs's 0.073 D^1.4 ({@link SNOWFLAKE_MASS_COEFFICIENT}). At 1 mm/h
 * over 2 to 10 mm the mean flake is 4.2 mm across. The shader draws each flake's size from the same sum.
 */
export function snowflakeDiameter(u: number, rate = 1, sizes: readonly [number, number] = [2, 10]): number {
  const { lambda, low, span } = snowflakeSizeLaw(rate, sizes),
    m = low - Math.log(1 - u * span) / lambda;
  return ((Math.PI * m ** 3) / (6 * SNOWFLAKE_MASS_COEFFICIENT)) ** (1 / 1.4) / 1000;
}

/**
 * Fall speed in m/s of an aggregate snowflake 1 mm across, the coefficient of {@link snowflakeFallSpeed}: Locatelli
 * and Hobbs (1974, Table 1), aggregates of unrimed radiating assemblages of dendrites or dendrites, V = 0.8 D^0.16
 * (D 2 to 10 mm, 28 flakes), the same aggregates whose mass law ({@link SNOWFLAKE_MASS_COEFFICIENT}) draws the sizes.
 */
export const SNOWFLAKE_FALL_COEFFICIENT = 0.8;
/** The exponent of {@link snowflakeFallSpeed}, Locatelli and Hobbs (1974, Table 1): V = 0.8 D^0.16. */
export const SNOWFLAKE_FALL_EXPONENT = 0.16;

/**
 * Terminal fall speed in m/s of an aggregate snowflake whose largest dimension is `diameter` metres: Locatelli and
 * Hobbs's (1974, Table 1) V = 0.8 D^0.16 with D in mm, 0.89 m/s at 2 mm, 1.00 m/s at the mean 4.2 mm flake and 1.16 m/s
 * at 10 mm. Each snow flake of a {@link Weather} falls at this speed for its own size ({@link snowflakeDiameter}), in
 * steps of 1/512 m/s. Later video disdrometer measurements of aggregates over 0.5 to 20 mm find their speeds rising
 * with temperature (Brandes, Ikeda, Thompson and Schoenhuber 2008, "Aggregate terminal velocity/temperature
 * relations", J. Appl. Meteorol. Climatol. 47(10), 2729 to 2736, doi:10.1175/2008JAMC1869.1), and turbulence spreads
 * the speeds of falling snow about its still-air law (Garrett and Yuter 2014, Geophys. Res. Lett. 41(18), 6515 to
 * 6522, doi:10.1002/2014GL061016). Rimed aggregates fall faster (Locatelli and Hobbs, densely rimed aggregates of
 * dendrites, V = 0.79 D^0.27) and are heavier for their size (M = 0.037 D^1.9), a different size law not drawn here.
 */
export function snowflakeFallSpeed(diameter: number): number {
  return SNOWFLAKE_FALL_COEFFICIENT * (diameter * 1000) ** SNOWFLAKE_FALL_EXPONENT;
}

/**
 * What keeps rain and snow off: the cover map `WeatherFX` (`@margoengine/sky/weather-fx`) draws each frame, its frame
 * uniform (binding 1) and its top-down depth (binding 2). While both are set the weather draws its particles with
 * `shader(code)`, its own WGSL with the cover read in, which drops every particle under cover.
 */
export interface WeatherOcclusion {
  readonly buffer: GPUBuffer | undefined;
  readonly view: GPUTextureView | undefined;
  shader(code: string): string;
}

/** One lightning strike, given to {@link Weather.onLightning} listeners and, later, to {@link Weather.onThunder} ones. */
export interface LightningStrike {
  /** 1 for the first strike, counting up. */
  id: number;
  /** Seconds of weather time at which it struck. */
  time: number;
  /** Metres from the listener. */
  distance: number;
  /** Direction from the listener in radians, 0 toward +Z and pi/2 toward +X. */
  azimuth: number;
  /** Where it hit the ground: the listener's position plus the offset, at y = 0, in world metres. */
  position: Vec3;
  /** Peak flash brightness, 0..1, falling off with distance. */
  strength: number;
  /** Return strokes in the flash, 1..4. */
  strokes: number;
  /** Seconds until the thunder is heard: `distance / speedOfSound`. */
  thunderDelay: number;
  /** Seconds the rumble lasts, longer the farther the strike. */
  rumble: number;
  /** Loudness of the thunder, 0..1, falling off with distance. */
  loudness: number;
}

/** Overrides for {@link Weather.strike}: a strike you place yourself. */
export interface StrikeOptions {
  /** Metres from the listener. Default random within the lightning range, or 1000. */
  distance?: number;
  /** Radians, 0 toward +Z. Default random. */
  azimuth?: number;
  /** Peak brightness 0..1. Default from the distance. */
  strength?: number;
}

/**
 * Brightness (0..1) of a strike `seconds` after it started: each stroke rises in about 8 ms and falls with a time
 * constant of 70 ms; the flash is the brightest stroke. `offsets` are the strokes' start times, `amplitudes` their
 * relative peaks.
 */
export function lightningFlash(seconds: number, offsets: readonly number[], amplitudes: readonly number[]): number {
  let flash = 0;
  for (let i = 0; i < offsets.length; i++) {
    const t = seconds - offsets[i];
    if (t < 0) continue;
    const level = t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.07);
    flash = Math.max(flash, amplitudes[i] * level);
  }
  return flash;
}

/** Seconds for thunder to cover `distance` metres at `speed` metres per second (default {@link speedOfSound}). */
export function thunderDelay(distance: number, speed: number = speedOfSound): number {
  if (!(distance >= 0) || !Number.isFinite(distance) || !(speed > 0) || !Number.isFinite(speed))
    throw new RangeError('Thunder delay needs a distance of 0 or more and a speed above 0; pass finite numbers');
  return distance / speed;
}

// The `LightGroups` (`@margoengine/clustered/groups`) the flash is listed in: duck-typed, this entry imports none of it.
interface LinkedGroups {
  readonly isDisposed: boolean;
  readonly clustered: { readonly isDisposed: boolean; readonly shadowSlots?: number };
  readonly list: readonly { shadow?: unknown }[];
  group(name: string): LinkedGroup;
}
interface LinkedGroup {
  readonly isDisposed: boolean;
  setLights(lights: readonly object[]): unknown;
  dispose(): void;
}

interface Active {
  strike: LightningStrike;
  offsets: number[];
  amplitudes: number[];
  age: number;
  heard: boolean;
}

// Hash: the PCG hash (O'Neill, PCG, 2014; GPU form in Jarzynski and Olano, JCGT 9(3), 2020); integer maths is exact
// on every GPU. Each particle takes three hashes for its place in the box and one for its size; the hash of the size
// hash gives its two sway phases (16 bits each).
// Snow sway: each flake swings 0.35 m on its own phase. The phase must not follow the flake's place along the axis it
// swings on: with phase x * 3.1 the map x -> x + 0.35 sin(t + 3.1 x) has slope 1 + 1.085 cos(...), which passes zero, so
// flakes folded into sheets of x = constant (caustics) that showed as a column of snow wherever one passed the camera
// (Whiteout Pass, whiteout-window end frame). A phase drawn per flake moves each one on its own and keeps the snow
// evenly spread (a uniform box shifted by independent offsets stays uniform).
// Snow sizes (params.y, volume.w, extra.w; `snowflakeDiameter`): each flake's melted diameter is drawn from Gunn and
// Marshall's exponential by its inverse, cut to the drawn range, and turned into its largest dimension by Locatelli
// and Hobbs's aggregate mass, D = (pi m^3 / (6 * 0.073))^(1 / 1.4) mm. Its light is opacity times its true area: a
// flake under a pixel is drawn a pixel wide with alpha sharp^2, so it keeps its light without being drawn larger.
// Snow exposure (screen.w, seconds; kept out of the shader text, whose comments ship until KB-WGSL1 strips sky): the
// vertex stage draws each flake as the capsule it sweeps over that time, from where it was (the tail) to where it is,
// at its velocity: wind, fall and the sway's own rate. Exposure 0 leaves the disc. The fragment shades the time average
// a camera records of the disc moving along that sweep, (1 / L) times the integral over s from 0 to L of the disc's
// falloff at (x, y - s), in flake radii (4-point Gauss-Legendre on each side of the middle of the part of the sweep the
// disc reaches). It keeps the disc's light (1.596 radii squared) for any sweep and tapers at both ends, so the capsules
// of a shot's consecutive sub-frames add up to an even streak; a capsule shaded at full strength out to its round
// ends doubled the light where two met, and the streaks showed as rows of beads.
// Rain drops (rain, look): each drop's diameter is drawn from Marshall and Palmer's exponential (rain.x slope per mm,
// rain.y share, rain.z smallest mm; `rainDropSample`) and falls at Gunn and Kinzer's speed for it times rain.w (1 with a
// rain rate, else the fixed fall over the median drop's speed), quantised to k / 512 m/s and wrapped like the snow's
// fall phase. Its streak is its own velocity over the streak seconds, its light its diameter over its speed over the
// mean (look.z; `rainStreakWeight`), its width the drop's own size where that is wider than the base width, with the
// light spread over it. look.x: the sheet field's strength (`rainSheet`, evaluated in the rain's frame, q less the
// wind's drift, whose waves fit the box). look.y: the gusts (`rainGust`), look.w the gust clock in seconds (wrapped at
// RAIN_GUST_PERIOD): the drop moves by the gust velocity's time integral and streaks along wind plus gust.
const shader = `
struct Weather {
 camera:mat4x4f, eye:vec4f, volume:vec4f, drift:vec4f, colour:vec4f, screen:vec4f, params:vec4f, extra:vec4f, lens:vec4f, rain:vec4f, look:vec4f,
}
@group(0) @binding(0) var<uniform> w:Weather;
struct Out {@builtin(position) position:vec4f,@location(0) @interpolate(perspective,centroid) uv:vec2f,@location(1) @interpolate(perspective,centroid) alpha:f32,@location(2) @interpolate(perspective,centroid) sweep:f32}
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let x=((s>>((s>>28u)+4u))^s)*277803737u;return (x>>22u)^x;}
fn rnd(i:u32,k:u32)->f32 {return f32(pcg(i*4u+k+bitcast<u32>(w.params.z))>>8u)*5.9604645e-8;}
fn flakeSize(ii:u32)->f32 {
 let melted=w.volume.w-log(1.0-rnd(ii,3u)*w.extra.w)/w.params.y;
 let sizeMeters=0.0005*pow(7.172586*melted*melted*melted,0.71428571);
 return sizeMeters;
}
fn dropSize(ii:u32)->f32 {return w.rain.z-log(1.0-rnd(ii,3u)*w.rain.y)/w.rain.x;}
fn dropFall(d:f32)->f32 {return max(0.1,9.65-10.3*exp(-0.6*d))*w.rain.w;}
const corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
const culled=Out(vec4f(2,2,2,1),vec2f(0),0.0,0.0);
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let corner=corners[vi];
 let size=w.volume.xyz;
 let start=vec3f(rnd(ii,0u),rnd(ii,1u),rnd(ii,2u))*size;
 // The drift (velocity times time, wrapped on the CPU) keeps the numbers small; the box follows the camera.
 let sizeMeters=flakeSize(ii);
 let flakes=w.params.x>0.5;
 let drop=dropSize(ii);
 let k=u32(round(select(dropFall(drop),w.extra.y*pow(sizeMeters*2000.0,0.16),flakes)*512.0));
 let fall=f32(k)*0.001953125;
 let fallen=-f32((k*u32(w.drift.y))&0xffffffu)*5.9604645e-8*size.y;
 let rel=fract((start+vec3f(w.drift.x,fallen,w.drift.z)-w.eye.xyz)/size)-0.5;
 var q=w.eye.xyz+rel*size;
 let wind=vec2f(w.extra.x,w.extra.z);
 let speed=length(wind);
 var gust=0.0;
 if(!flakes&&speed>0.01){
  let u=max(speed,0.5);
  let along=dot(q.xz,wind/speed);
  let p1=0.52359878*(along/u-w.look.w);
  let p2=1.5707963*(along/u-w.look.w);
  gust=w.look.y*(0.6*sin(p1)+0.4*sin(p2));
  q+=vec3f(wind.x,0.0,wind.y)*w.look.y*(0.6*cos(p1)/0.52359878+0.4*cos(p2)/1.5707963);
 }
 let snow=w.params.x>0.5;
 let ph=pcg(pcg(ii*4u+3u+bitcast<u32>(w.params.z)));
 let phase=vec2f(f32(ph&0xffffu),f32(ph>>16u))*9.5873799e-5;
 if(snow){q+=vec3f(sin(w.drift.w+phase.x),0.0,cos(w.drift.w*0.8+phase.y))*0.35;}
 let edge=max(max(abs(rel.x),abs(rel.z)),abs(rel.y));
 let nearDistance=length(q-w.eye.xyz);
 let fade=(1.0-smoothstep(0.7,1.0,edge*2.0))*smoothstep(w.lens.z,w.lens.w,nearDistance);
 let vp=w.screen.xy;
 var out:Out;
 if(snow){
  let c=w.camera*vec4f(q,1);
  if(c.w<0.1){return culled;}
  let sharp=sizeMeters*w.screen.z/c.w;
  let coc=w.lens.x*abs(c.w-w.lens.y)/(c.w*w.eye.w);
  let px=max(sqrt(sharp*sharp+coc*coc),1.0);
  let sway=vec3f(cos(w.drift.w+phase.x)*1.3,0.0,-sin(w.drift.w*0.8+phase.y)*1.04)*0.35;
  let velocity=vec3f(w.extra.x,-fall,w.extra.z)+sway;
  var t=w.camera*vec4f(q-velocity*w.screen.w,1);
  if(t.w<0.1){t=c;}
  let pa=c.xy/c.w*vp*0.5;
  let pb=t.xy/t.w*vp*0.5;
  let d=pa-pb;
  let sweep=length(d);
  let dir=select(vec2f(0,1),d/sweep,sweep>0.0001);
  let normal=vec2f(dir.y,-dir.x);
  let head=corner.y>0.0;
  let along=select(-px,sweep+px,head);
  let e=select(t,c,head);
  out.position=vec4f((pb+dir*along+normal*corner.x*px)*2.0/vp*e.w,e.z,e.w);
  out.uv=vec2f(corner.x,along/px);
  out.sweep=sweep/px;
  out.alpha=fade*sharp*sharp/(px*px);
  return out;
 }
 let velocity=vec3f(w.extra.x*(1.0+gust),-fall,w.extra.z*(1.0+gust));
 let tail=q-velocity*w.params.y;
 let a=w.camera*vec4f(q,1);
 let b=w.camera*vec4f(tail,1);
 if(a.w<0.1||b.w<0.1){return culled;}
 let pa=a.xy/a.w*vp*0.5;
 let pb=b.xy/b.w*vp*0.5;
 let d=pb-pa;
 let length2=length(d);
 let dir=select(vec2f(0,1),d/length2,length2>0.0001);
 let normal=vec2f(-dir.y,dir.x);
 let head=corner.y>0.0;
 let baseWidth=max(w.extra.w*0.5,0.5);
 let halfWidth=clamp(drop*0.0005*w.screen.z/a.w,baseWidth,4.0);
 let base=select(pb,pa,head);
 let ndc=(base+normal*corner.x*halfWidth)*2.0/vp;
 let c=select(b,a,head);
 out.position=vec4f(ndc*c.w,c.z,c.w);
 out.uv=vec2f(corner.x,select(0.0,1.0,head));
 let rainFrame=(q.xz-vec2f(w.drift.x,w.drift.z))*6.2831853/size.x;
 let f=0.5+0.25*sin(rainFrame.x+2.0*rainFrame.y+1.3)+0.15*sin(3.0*rainFrame.x-rainFrame.y+4.1)+0.1*sin(-2.0*rainFrame.x+4.0*rainFrame.y+2.2);
 let sheet=smoothstep(0.25,0.85,f);
 let weight=clamp(drop/max(0.1,9.65-10.3*exp(-0.6*drop))*w.look.z,0.25,3.0);
 out.alpha=fade*0.7*weight*mix(1.0,0.25+1.75*sheet,w.look.x)*baseWidth/halfWidth;
 out.sweep=0.0;
 return out;
}
fn disc(r:f32)->f32 {return 1.0-smoothstep(0.4,1.0,r);}
const gauss=array<vec2f,4>(vec2f(0.18343464,0.36268378),vec2f(0.52553241,0.31370665),vec2f(0.79666648,0.22238103),vec2f(0.96028986,0.10122854));
fn flake(uv:vec2f,sweep:f32)->f32 {
 if(sweep<1e-4){return disc(length(uv));}
 let hw=sqrt(max(0.0,1.0-uv.x*uv.x));
 let s0=max(0.0,uv.y-hw);
 let s1=min(sweep,uv.y+hw);
 if(s1<=s0){return 0.0;}
 let m=(s0+s1)*0.5;
 let h=(s1-s0)*0.5;
 var g=0.0;
 for(var k=0;k<4;k++){let n=gauss[k];g+=n.y*(disc(length(vec2f(uv.x,uv.y-m-h*n.x)))+disc(length(vec2f(uv.x,uv.y-m+h*n.x))));}
 return g*h/sweep;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 var a=i.alpha*w.colour.w;
 if(w.params.x>0.5){a*=flake(i.uv,i.sweep);}
 else{a*=max(0.0,1.0-i.uv.x*i.uv.x)*mix(0.15,1.0,clamp(i.uv.y,0.0,1.0));}
 return vec4f(w.colour.rgb*(1.0+w.params.w*6.0),a);
}`;
// `reactive`: the same particles' coverage for TAA's mask, by shape alone (not the faint opacity), so a streak's core
// keeps no history and its fringe a little. Added to the shader only for the mask pipeline.
const reactiveEntry = `
@fragment fn reactive(i:Out)->@location(0) vec4f {
 var a=i.alpha;
 if(w.params.x>0.5){a*=flake(i.uv,i.sweep);}
 else{a*=max(0.0,1.0-i.uv.x*i.uv.x)*mix(0.15,1.0,clamp(i.uv.y,0.0,1.0));}
 return vec4f(min(1.0,a*1.5),0,0,1);
}`;
// The mask keeps the largest coverage of the particles over a pixel.
const maxBlend = { operation: 'max', srcFactor: 'one', dstFactor: 'one' } as const;

const flashShader = `${fullscreen}
@group(0) @binding(0) var<uniform> flash:vec4f;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 // Brighter toward the top of the frame, where the cloud base lights up.
 let sheet=0.7+0.3*(1.0-i.uv.y);
 return vec4f(flash.rgb*sheet,0.0);
}`;

/** The fall speed in m/s of rain with no `rainRate`: 9, a drop of about 4 mm. */
export const RAIN_FALL_DEFAULT = 9;

const rate = (value: number): number => {
  if (typeof value !== 'number' || !(value >= 0) || !Number.isFinite(value))
    throw new RangeError('Rain rate must be a finite number of millimetres per hour, 0 or more; got ' + String(value));
  return Math.max(value, 0.01);
};

/**
 * Median volume diameter in millimetres of the drops in rain of `rainRate` mm/h: half the water falls in drops larger
 * than this. Marshall and Palmer's (1948, "The distribution of raindrops with size", J. Meteor. 5, 165 to 166,
 * doi:10.1175/1520-0469(1948)005<0165:TDORWS>2.0.CO;2) exponential N(D) = 8000 e^(-L D) with L = 4.1 R^(-0.21) per mm
 * has D0 = 3.67 / L = 0.895 R^0.21: 0.34 mm at 0.01 mm/h, 1.6 mm at 17, 2.4 mm at 80. Rates under 0.01 count as 0.01.
 * @throws RangeError for a negative or non-finite rate.
 */
export function rainDropDiameter(rainRate: number): number {
  return (3.67 * rate(rainRate) ** 0.21) / 4.1;
}

/**
 * Terminal fall speed in m/s of a raindrop `diameter` millimetres across at sea level: v = 9.65 - 10.3 e^(-0.6 D), the
 * fit of Atlas, Srivastava and Sekhon (1973, "Doppler radar characteristics of precipitation at vertical incidence",
 * Rev. Geophys. Space Phys. 11(1), 1 to 35, doi:10.1029/RG011i001p00001) to the measurements of Gunn and Kinzer (1949,
 * "The terminal velocity of fall for water droplets in stagnant air", J. Meteor. 6, 243 to 248,
 * doi:10.1175/1520-0469(1949)006<0243:TTVOFF>2.0.CO;2): 6.5 m/s at 2 mm, 9.1 at 5 mm; under 0.1 m/s is taken as 0.1.
 * @throws RangeError for a diameter that is not a finite number above 0.
 */
export function rainFallSpeed(diameter: number): number {
  if (typeof diameter !== 'number' || !(diameter > 0) || !Number.isFinite(diameter))
    throw new RangeError('Raindrop diameter must be a finite number of millimetres above 0; got ' + String(diameter));
  return Math.max(0.1, 9.65 - 10.3 * Math.exp(-0.6 * diameter));
}

/**
 * Raindrops per cubic metre of rain of `rainRate` mm/h: the integral of Marshall and Palmer's (1948) N(D) = 8000 e^(-L D)
 * per m3 per mm over all sizes, N0 / L = 8000 R^0.21 / 4.1: 1,950 per m3 at 1 mm/h, 3,540 at 17, 4,900 at 80 (Marshall and Palmer 1948).
 * @throws RangeError for a negative or non-finite rate.
 */
export function rainDropCount(rainRate: number): number {
  return (8000 * rate(rainRate) ** 0.21) / 4.1;
}

/**
 * The size law the rain draws each drop from ({@link rainDropSample}): Marshall and Palmer's slope `lambda` = 4.1 R^-0.21
 * per mm for `rainRate` R mm/h, the smallest diameter `low` and the share `span` of the exponential between the two
 * ends of `sizes`.
 * @throws RangeError for a negative or non-finite rate.
 */
export function rainDropSizeLaw(
  rainRate: number,
  sizes: readonly [number, number] = [0.5, 6],
): { lambda: number; low: number; span: number } {
  const lambda = 4.1 * rate(rainRate) ** -0.21;
  return { lambda, low: sizes[0], span: 1 - Math.exp(-lambda * (sizes[1] - sizes[0])) };
}

/**
 * The diameter in millimetres of the raindrop drawn by `u` (0 to 1) in rain of `rainRate` mm/h over `sizes` mm: the
 * inverse of Marshall and Palmer's (1948) exponential N(D) = N0 e^(-lambda D) cut to `sizes`. In 17 mm/h rain over
 * [0.5, 6] mm the median drop is 0.81 mm and one drop in thirty is over 2 mm. The shader draws each drop from the same law.
 */
export function rainDropSample(u: number, rainRate: number, sizes: readonly [number, number] = [0.5, 6]): number {
  const { lambda, low, span } = rainDropSizeLaw(rainRate, sizes);
  return low - Math.log(1 - u * span) / lambda;
}

/**
 * The light of a drop `diameter` mm across in its streak, relative to others: a drop lights a pixel for the time it
 * takes to cross it, its diameter over its fall speed (Garg and Nayar 2006, "Photorealistic rendering of rain streaks",
 * ACM TOG 25(3), 996 to 1002, doi:10.1145/1141911.1141985), so a big drop leaves a bright streak and a fast small one a
 * faint one. The shader scales this by the inverse of its mean over the size law and clamps it to 0.25 to 3.
 */
export function rainStreakWeight(diameter: number): number {
  return diameter / rainFallSpeed(diameter);
}

/** Mean of {@link rainStreakWeight} over the drops of `rainRate` mm/h drawn over `sizes` (midpoint rule, 256 steps). */
export function rainStreakMean(rainRate: number, sizes: readonly [number, number] = [0.5, 6]): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += rainStreakWeight(rainDropSample((i + 0.5) / 256, rainRate, sizes));
  return sum / 256;
}

/**
 * The rain-sheet field of {@link WeatherOptions.rainVariation}, 0 to 1, at a point `x`, `z` metres in the rain's own
 * frame (the world less the wind's drift) inside a box `size` metres across: three plane waves whose whole numbers of
 * cycles fit the box, so the field is seamless where the box wraps, smoothed into bands. The shader computes the same.
 */
export function rainSheet(x: number, z: number, size: number): number {
  const t = (2 * Math.PI) / size;
  const f =
    0.5 +
    0.25 * Math.sin(t * (x + 2 * z) + 1.3) +
    0.15 * Math.sin(t * (3 * x - z) + 4.1) +
    0.1 * Math.sin(t * (-2 * x + 4 * z) + 2.2);
  const s = Math.min(1, Math.max(0, (f - 0.25) / 0.6));
  return s * s * (3 - 2 * s);
}

/** Seconds after which the two gust fronts of {@link rainGust} repeat: they turn every 12 and every 4 seconds. */
export const RAIN_GUST_PERIOD = 12;

/**
 * The extra horizontal velocity, as a share of the wind, that the gusts of {@link WeatherOptions.gusts} `amount` give
 * a drop `along` metres downwind at `seconds`, for a wind of `speed` m/s: two fronts, turning every 12 and 4 s, that
 * travel downwind at the wind speed. The drops are moved by the time integral of the same sum, so the streaks point
 * where the drops go. 0 in still air.
 */
export function rainGust(along: number, seconds: number, speed: number, amount: number): number {
  if (speed < 0.01) return 0;
  const w1 = (2 * Math.PI) / 12,
    w2 = (2 * Math.PI) / 4,
    u = Math.max(speed, 0.5);
  return amount * (0.6 * Math.sin((w1 / u) * along - w1 * seconds) + 0.4 * Math.sin((w2 / u) * along - w2 * seconds));
}

/** The fall speed in m/s of rain of `rainRate` mm/h (`rainFallSpeed` of `rainDropDiameter`), or {@link RAIN_FALL_DEFAULT} for undefined. */
export function rainFall(rainRate?: number): number {
  return rainRate === undefined ? RAIN_FALL_DEFAULT : rainFallSpeed(rainDropDiameter(rainRate));
}

/** The angle in degrees from the vertical at which rain falling `fall` m/s in a horizontal `wind` `[x, z]` m/s travels: atan(|wind| / fall). */
export function rainSlant(wind: readonly [number, number], fall: number): number {
  return (Math.atan2(Math.hypot(wind[0], wind[1]), fall) * 180) / Math.PI;
}

/** The amount (0 to 1) that a rain rate stands for: (R / 80)^(1/3), the inverse of `rainRate` in `@margoengine/weather`. */
export function rainIntensity(rainRate: number): number {
  return rate(rainRate) === 0.01 && rainRate === 0 ? 0 : Math.min(1, (rate(rainRate) / 80) ** (1 / 3));
}

const defaults = {
  rain: { particles: 24000, opacity: 0.35, color: [0.62, 0.68, 0.76] as Vec3 },
  snow: { particles: 500000, opacity: 0.8, color: [1, 1, 1] as Vec3 },
};
const flashColor: Vec3 = [0.75, 0.82, 1];
const lightningDefaults = { rate: 6, threshold: 0.6, minDistance: 300, maxDistance: 6000, strength: 0.35, seed: 1 };

const number = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Weather ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

function validate(o: WeatherOptions): void {
  if (
    o.precipitation !== undefined &&
    o.precipitation !== 'rain' &&
    o.precipitation !== 'snow' &&
    o.precipitation !== 'sleet' &&
    o.precipitation !== 'none'
  )
    throw new TypeError('Weather precipitation must be "rain", "snow", "sleet" or "none"; pass one of them');
  if (o.snowShare !== undefined) number(o.snowShare, 'snowShare', 0, 1);
  if (o.intensity !== undefined) number(o.intensity, 'intensity', 0, 1);
  if (o.rainRate !== undefined) number(o.rainRate, 'rainRate', 0, 300);
  if (o.rainFrom !== undefined && (typeof o.rainFrom !== 'object' || typeof o.rainFrom?.rainRateAt !== 'function'))
    throw new TypeError('Weather rainFrom must be an object with rainRateAt(position); pass VolumetricClouds or similar');
  if (o.fadeSeconds !== undefined) number(o.fadeSeconds, 'fadeSeconds', 0, 3600);
  if (o.radius !== undefined) number(o.radius, 'radius', 2, 200);
  if (o.height !== undefined) number(o.height, 'height', 2, 200);
  if (o.particles !== undefined) number(o.particles, 'particles', 0, 2000000);
  if (o.snowfallRate !== undefined) number(o.snowfallRate, 'snowfallRate', 0.01, 30);
  if (o.flakeSizes !== undefined) {
    if (!Array.isArray(o.flakeSizes) || o.flakeSizes.length !== 2)
      throw new TypeError('Weather flakeSizes needs [smallest, largest] in millimetres; pass an array of two numbers');
    number(o.flakeSizes[0], 'flakeSizes[0]', 0.5, 30);
    number(o.flakeSizes[1], 'flakeSizes[1]', 0.5, 30);
    if (o.flakeSizes[0] > o.flakeSizes[1])
      throw new RangeError('Weather flakeSizes smallest must not exceed largest; swap them');
  }
  if (o.brightness !== undefined) number(o.brightness, 'brightness', 0, 1e6);
  if (o.opacity !== undefined) number(o.opacity, 'opacity', 0, 1);
  if (o.exposure !== undefined) number(o.exposure, 'exposure', 0, 1);
  if (o.rainVariation !== undefined) number(o.rainVariation, 'rainVariation', 0, 1);
  if (o.gusts !== undefined) number(o.gusts, 'gusts', 0, 1);
  if (o.dropSizes !== undefined) {
    if (!Array.isArray(o.dropSizes) || o.dropSizes.length !== 2)
      throw new TypeError('Weather dropSizes needs [smallest, largest] in millimetres; pass an array of two numbers');
    number(o.dropSizes[0], 'dropSizes[0]', 0.1, 8);
    number(o.dropSizes[1], 'dropSizes[1]', 0.1, 8);
    if (o.dropSizes[0] > o.dropSizes[1])
      throw new RangeError('Weather dropSizes smallest must not exceed largest; swap them');
  }
  if (o.reactive !== undefined && typeof o.reactive !== 'boolean')
    throw new TypeError('Weather reactive must be true or false; pass a boolean');
  if (o.lens !== undefined && o.lens !== false) {
    if (typeof o.lens !== 'object' || o.lens === null)
      throw new TypeError('Weather lens must be an options object or false; pass {} for the defaults');
    if (o.lens.focalDistance !== undefined) number(o.lens.focalDistance, 'lens.focalDistance', 0.3, 1e6);
    if (o.lens.aperture !== undefined) number(o.lens.aperture, 'lens.aperture', 0.5, 64);
    if (o.lens.filmGauge !== undefined) number(o.lens.filmGauge, 'lens.filmGauge', 1, 100);
  }
  if (o.nearFade !== undefined) {
    if (!Array.isArray(o.nearFade) || o.nearFade.length !== 2)
      throw new TypeError('Weather nearFade needs [start, end] in metres; pass an array of two numbers');
    number(o.nearFade[0], 'nearFade[0]', 0, 1000);
    number(o.nearFade[1], 'nearFade[1]', 0, 1000);
    if (o.nearFade[0] > o.nearFade[1])
      throw new RangeError('Weather nearFade start must not exceed its end; swap them');
  }
  if (o.wind !== undefined) {
    if (!Array.isArray(o.wind) || o.wind.length !== 2)
      throw new TypeError('Weather wind needs [x, z] in metres per second; pass an array of two numbers');
    number(o.wind[0], 'wind[0]', -100, 100);
    number(o.wind[1], 'wind[1]', -100, 100);
  }
  if (o.color !== undefined) {
    finiteVector(o.color, 3, 'Weather color');
    if (o.color.some((v) => v < 0)) throw new RangeError('Weather color must be non-negative linear RGB');
  }
  const l = o.lightning;
  if (l === undefined) return;
  if (typeof l !== 'object' || l === null)
    throw new TypeError('Weather lightning must be an options object; pass {} for the defaults');
  if (l.rate !== undefined) number(l.rate, 'lightning.rate', 0, 600);
  if (l.threshold !== undefined) number(l.threshold, 'lightning.threshold', 0, 1);
  if (l.minDistance !== undefined) number(l.minDistance, 'lightning.minDistance', 0, 1e5);
  if (l.maxDistance !== undefined) number(l.maxDistance, 'lightning.maxDistance', 0, 1e5);
  if ((l.minDistance ?? lightningDefaults.minDistance) > (l.maxDistance ?? lightningDefaults.maxDistance))
    throw new RangeError('Weather lightning minDistance must not exceed maxDistance; swap them');
  if (l.strength !== undefined) number(l.strength, 'lightning.strength', 0, 100);
  if (l.seed !== undefined) number(l.seed, 'lightning.seed', -2147483648, 4294967295);
  if (l.hold !== undefined) number(l.hold, 'lightning.hold', 0, 1);
  if (l.bolt !== undefined) {
    const b = l.bolt as LightningBoltOptions;
    if (typeof b !== 'object' || b === null)
      throw new TypeError('Weather lightning.bolt must be an options object; pass {} for the defaults');
    if (b.scale !== undefined) number(b.scale, 'lightning.bolt.scale', 0, 1000);
    if (b.width !== undefined) number(b.width, 'lightning.bolt.width', 0.01, 100);
    if (b.glow !== undefined) number(b.glow, 'lightning.bolt.glow', 0, 2000);
    if (b.branching !== undefined) number(b.branching, 'lightning.bolt.branching', 0, 0.5);
    if (b.spread !== undefined) number(b.spread, 'lightning.bolt.spread', 5, 85);
    if (b.detail !== undefined) number(b.detail, 'lightning.bolt.detail', 8, 400);
    if (b.fade !== undefined) number(b.fade, 'lightning.bolt.fade', 0.001, 1);
    if (b.top !== undefined) number(b.top, 'lightning.bolt.top', 1, 20000);
  }
  if (l.cloud !== undefined) {
    if (typeof l.cloud !== 'object' || l.cloud === null)
      throw new TypeError('Weather lightning.cloud must be an options object; pass {} for the defaults');
    if (l.cloud.base !== undefined) number(l.cloud.base, 'lightning.cloud.base', 0, 20000);
    if (l.cloud.peak !== undefined) number(l.cloud.peak, 'lightning.cloud.peak', 0, 1e14);
    if (l.cloud.radius !== undefined) number(l.cloud.radius, 'lightning.cloud.radius', 1, 100000);
    if (l.cloud.scale !== undefined) number(l.cloud.scale, 'lightning.cloud.scale', 0, 1000);
  }
  if (l.light !== undefined) {
    if (typeof l.light !== 'object' || l.light === null)
      throw new TypeError('Weather lightning.light must be an options object; pass {} for the defaults');
    if (l.light.peak !== undefined) number(l.light.peak, 'lightning.light.peak', 0, 1e14);
    if (l.light.height !== undefined) number(l.light.height, 'lightning.light.height', 0, 20000);
    if (l.light.scale !== undefined) number(l.light.scale, 'lightning.light.scale', 0, 1000);
    if (l.light.range !== undefined) number(l.light.range, 'lightning.light.range', 1, 1e6);
    if (l.light.line !== undefined && typeof l.light.line !== 'boolean')
      throw new TypeError('Weather lightning.light.line must be true or false');
    if (l.light.segments !== undefined) {
      number(l.light.segments, 'lightning.light.segments', 1, 8);
      if (!Number.isInteger(l.light.segments))
        throw new RangeError('Weather lightning.light.segments must be a whole number from 1 to 8');
    }
    const shadow = l.light.shadow;
    if (shadow !== undefined && typeof shadow !== 'boolean') {
      if (typeof shadow !== 'object' || shadow === null)
        throw new TypeError('Weather lightning.light.shadow must be true, false or {near, far}');
      if (shadow.near !== undefined) number(shadow.near, 'lightning.light.shadow.near', 1e-3, 1e5);
      if (shadow.far !== undefined) number(shadow.far, 'lightning.light.shadow.far', 1e-2, 1e6);
      if ((shadow.near ?? 1) >= (shadow.far ?? 3000))
        throw new RangeError('Weather lightning.light.shadow near must be below far; swap them');
    }
    if (l.light.color !== undefined) {
      finiteVector(l.light.color, 3, 'Weather lightning light color');
      if (l.light.color.some((v) => v < 0) || Math.max(...l.light.color) <= 0)
        throw new RangeError('Weather lightning light color must be non-negative linear RGB with a channel above 0');
    }
  }
  if (l.link !== undefined && typeof l.link !== 'boolean') {
    if (typeof l.link !== 'object' || l.link === null)
      throw new TypeError('Weather lightning.link must be true, false or an options object');
    for (const key of ['clouds', 'fog', 'lights'] as const)
      if (l.link[key] !== undefined && typeof l.link[key] !== 'boolean')
        throw new TypeError(`Weather lightning.link.${key} must be true or false`);
    if (l.link.group !== undefined && (typeof l.link.group !== 'string' || !l.link.group))
      throw new TypeError('Weather lightning.link.group must be a non-empty string');
  }
  if (l.color !== undefined) {
    finiteVector(l.color, 3, 'Weather lightning color');
    if (l.color.some((v) => v < 0)) throw new RangeError('Weather lightning color must be non-negative linear RGB');
  }
}

/**
 * Rain or snow around the camera, with storms. Particles live in a box that follows the camera, are placed by an
 * integer hash and moved by the wind with no per-frame buffer upload, and are depth-tested against the scene. Lightning
 * flashes the frame, reports each strike and, after the distance-based delay, its thunder (`onThunder`, for audio).
 * The weather state (`amount`, `flash`, `wetness`, `snowCover`) is plain numbers, so materials, sky, fog and sound can
 * follow it. Without a GPU engine it still runs: `new Weather(options)` and `onPreUpdate(delta)`. `advanceTime(delta)`
 * moves the same state with no listener call, so `seek` from `@margoengine/cutscene/seek` replays a storm exactly.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when a listener changes the weather it is called from.
 */
export class Weather implements EnginePlugin {
  readonly name: string = 'weather';
  /**
   * Where the listener (the ear and the eye) is: strikes are placed around it. Attached to an engine it follows the
   * engine's camera at each update (until 2026-11-16 the draw pass set it, so a strike's place hung on the last draw).
   */
  readonly listener = new Float32Array(3);
  /**
   * Set by `LightningBolt` (`@margoengine/sky/lightning-bolt`): the bolt's channel, which the stroke's light follows
   * ({@link WeatherLightningLightOptions.line}) and the cloud deck's flash is centred on.
   */
  channelSource?: LightningChannelSource;
  /** Set by `WeatherFX` from `@margoengine/sky/weather-fx`: the cover map under which no rain or snow falls. */
  occlusion?: WeatherOcclusion;
  private coverEntries?: GPUBindGroupEntry[];
  private readonly overlay = new ParticleOverlay();
  // Sleet draws its snow as a second overlay with its own uniform: one uploaded buffer holds one draw's values.
  private readonly snowOverlay = new ParticleOverlay();
  private snowUniform?: GPUBuffer;
  private readonly snowValues = new Float32Array(56);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private flashUniform?: GPUBuffer;
  private flashPipeline?: GPURenderPipeline;
  private flashBind?: GPUBindGroup;
  private flashKey = '';
  // `reactive`: the mask TAA reads (single-sampled), the multisampled target it is resolved from, and one pipeline and
  // bind group per particle draw (rain, and sleet's snow).
  private mask?: GPUTexture;
  private maskSamples?: GPUTexture;
  private maskKey = '';
  private maskDrawn = false;
  private readonly maskDraws = new Map<
    GPUBuffer,
    { code: string; key: string; pipeline: GPURenderPipeline; bind?: GPUBindGroup; extra?: GPUBindGroupEntry[] }
  >();
  private readonly values = new Float32Array(56);
  private readonly flashValues = new Float32Array(4);
  private disposed = false;
  private seconds = 0;
  // A replayed step (advanceTime) calls no onLightning or onThunder listener: the film heard those strikes already.
  private silent = false;
  // How far the wind has carried the particles, metres along world X and Z: the sum of wind times delta over the
  // frames, so a wind that changes (gusts, a WeatherDrive) moves them on from where they are instead of jumping them
  // to wind * time.
  private readonly drift = [0, 0];
  private level = 0;
  // The rain rate this frame: `rainFrom` at the camera, else `rainRate` (step sets it).
  private rateNow: number | undefined;
  private flashLevel = 0;
  private lightLevel = 0;
  private last?: LightningStrike;
  private wet = 0;
  private snow = 0;
  private state = 0x9e3779b9;
  private seeded = NaN;
  private counter = 0;
  private active: Active[] = [];
  private lightningListeners = new Set<(strike: LightningStrike) => void>();
  private thunderListeners = new Set<(strike: LightningStrike) => void>();
  private dispatching = false;
  // The scene plugins the flash is wired into (lightning.link): decks and fogs given the flash, and the light group.
  private readonly linkedClouds = new Set<object>();
  private readonly linkedFogs = new Set<object>();
  private linkedGroup?: LinkedGroup;
  private linkedName = '';
  private linkedOn = false;
  private lineLights: LightningLight[] = [];
  private foundGroups?: LinkedGroups;
  private wantLights = false;
  private deckBottom = LIGHTNING_CLOUD_BASE;
  private deckTop = Infinity;
  private readonly deckScratch: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 };

  constructor(readonly options: WeatherOptions = {}) {
    validate(options);
  }

  static attach(engine: EngineKernel, options: WeatherOptions = {}): Weather {
    const effect = new Weather(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /**
   * This frame's particle coverage, an r8unorm texture of the whole frame, drawn while TAA runs (or with
   * `options.reactive`). TAA reads it by itself; it is here for other readers. Undefined on a frame that drew no mask.
   */
  get reactiveMask(): GPUTexture | undefined {
    return this.maskDrawn ? this.mask : undefined;
  }
  /** Visible precipitation, 0..1: eases toward `options.intensity` over `options.fadeSeconds`. */
  get amount(): number {
    return this.level;
  }
  /** Lightning flash brightness this frame, 0..1 (0 between strikes), before `lightning.strength` scales it. */
  get flash(): number {
    return this.flashLevel;
  }
  /** The strikes whose light has not died away, oldest first; the `LightningBolt` draws them. Do not change them. */
  get liveStrikes(): readonly LiveStrike[] {
    return this.active;
  }
  /** The latest strike, or undefined before the first. */
  get lastStrike(): LightningStrike | undefined {
    return this.last;
  }
  /**
   * The lightning's light in the scene: a point light at the brightest live strike (the last one between strikes),
   * `lightning.light.height` above it, of `lightning.light.peak` candela times the strokes' level (the flash's rise and
   * fall, without the overlay's falloff with distance: the inverse square does that). 0 between flashes. Changed in
   * place at each update, so give the same object to a light list: `lights.setLights([...others,
   * weather.lightningLight])` with `lights` from `Clustered.attach` (`@margoengine/clustered`).
   */
  readonly lightningLight: LightningLight = {
    position: [0, LIGHTNING_LIGHT_HEIGHT, 1000],
    color: [...LIGHTNING_COLOR],
    intensity: 0,
    range: 9000,
    decay: 2,
  };
  /**
   * The lightning's light inside the cloud deck, shaped as `VolumetricClouds` `flash` (`@margoengine/sky/volumetric-clouds`):
   * at the brightest live strike (the last one between strikes), one decay length above `lightning.cloud.base`, of
   * `lightning.cloud.peak` candela (default the channel's share above the base, {@link lightningCloudShare}) times the
   * strokes' level, in the lightning's colour. 0 between flashes. Changed in place at each update, so give it once:
   * `VolumetricClouds.attach(engine, {flash: weather.cloudFlash, ...})`, with `lightning.cloud.base` the deck's `bottom`.
   * Its intensity is in candela, as {@link Weather.lightningLight}: the deck matches the scene's lights when the sky is lit
   * in lux (`lighting.intensity: SUN_ILLUMINANCE`).
   */
  readonly cloudFlash: {
    position: [number, number, number];
    intensity: number;
    color: [number, number, number];
    radius: number;
  } = {
    position: [0, LIGHTNING_CLOUD_BASE + LIGHTNING_LIGHT_HEIGHT, 1000],
    intensity: 0,
    color: [...LIGHTNING_COLOR],
    radius: 200,
  };
  /** How wet surfaces are, 0..1: rises under rain (about 20 s), dries when it stops (about 90 s). Drive roughness with it. */
  get wetness(): number {
    return this.wet;
  }
  /** Snow lying on the ground, 0..1: builds under snow (about 2 minutes) and melts slowly (about 5 minutes). */
  get snowCover(): number {
    return this.snow;
  }
  /** Share of the precipitation that is rain, 0 to 1: 1 for rain, 0 for snow and none, `1 - snowShare` for sleet. */
  get rainShare(): number {
    const kind = this.options.precipitation ?? 'rain';
    return kind === 'rain' ? 1 : kind === 'sleet' ? 1 - (this.options.snowShare ?? 0.5) : 0;
  }
  /** Seconds of weather time so far (the sum of the deltas given to `onPreUpdate` and `advanceTime`). */
  get elapsed(): number {
    return this.seconds;
  }
  /** The same as {@link Weather.elapsed}: the clock `seek` from `@margoengine/cutscene/seek` checks and replays. */
  get time(): number {
    return this.seconds;
  }

  /**
   * Calls `listener` when lightning strikes, at the moment the flash starts. Returns a function that removes it.
   * @throws TypeError when `listener` is not a function.
   */
  onLightning(listener: (strike: LightningStrike) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Weather onLightning needs a function; pass a listener');
    this.lightningListeners.add(listener);
    return () => void this.lightningListeners.delete(listener);
  }

  /**
   * Calls `listener` when a strike's thunder arrives, `thunderDelay` seconds after the flash: play the sound with
   * `loudness` and `rumble`. Returns a function that removes it.
   * @throws TypeError when `listener` is not a function.
   */
  onThunder(listener: (strike: LightningStrike) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Weather onThunder needs a function; pass a listener');
    this.thunderListeners.add(listener);
    return () => void this.thunderListeners.delete(listener);
  }

  /**
   * Strikes now, wherever the options say lightning is or not, and returns the strike.
   * @throws RangeError when a value is out of range.
   */
  strike(options: StrikeOptions = {}): LightningStrike {
    this.idle();
    if (options.distance !== undefined) number(options.distance, 'strike distance', 0, 1e5);
    if (options.azimuth !== undefined) number(options.azimuth, 'strike azimuth', -1e6, 1e6);
    if (options.strength !== undefined) number(options.strength, 'strike strength', 0, 1);
    return this.spawn(options);
  }

  /** Throws unless this weather is alive and not inside one of its own callbacks. */
  private idle(): void {
    if (this.disposed) throw new MargoError('disposed', 'Weather is disposed; create a new Weather');
    if (this.dispatching)
      throw new MargoError('state', 'Weather listener changed the weather during a callback; do it on the next frame');
  }

  private random(): number {
    // mulberry32 (Tommy Ettinger): a small 32-bit generator, plenty for scheduling strikes.
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private spawn(options: StrikeOptions): LightningStrike {
    const l = this.options.lightning,
      min = l?.minDistance ?? lightningDefaults.minDistance,
      max = l?.maxDistance ?? lightningDefaults.maxDistance;
    const distance = options.distance ?? (l ? min + this.random() * (max - min) : 1000),
      azimuth = options.azimuth ?? this.random() * Math.PI * 2,
      reach = Math.max(max, 1),
      strength = options.strength ?? Math.max(0.1, 1 - 0.7 * Math.min(1, distance / reach)),
      strokes = 1 + Math.floor(this.random() * 3.999);
    const offsets = [0],
      amplitudes = [1];
    for (let i = 1; i < strokes; i++) {
      offsets.push(offsets[i - 1] + 0.04 + this.random() * 0.08);
      amplitudes.push(0.4 + this.random() * 0.5);
    }
    const strike: LightningStrike = {
      id: ++this.counter,
      time: this.seconds,
      distance,
      azimuth,
      position: [this.listener[0] + Math.sin(azimuth) * distance, 0, this.listener[2] + Math.cos(azimuth) * distance],
      strength,
      strokes,
      thunderDelay: thunderDelay(distance),
      rumble: Math.min(8, 1 + distance / 700),
      loudness: 1 / (1 + (distance / 1500) ** 2),
    };
    this.active.push({ strike, offsets, amplitudes, age: 0, heard: false });
    this.last = strike;
    this.notify(this.lightningListeners, strike);
    return strike;
  }

  private notify(listeners: Set<(strike: LightningStrike) => void>, strike: LightningStrike): void {
    if (this.silent) return;
    this.dispatching = true;
    let failure: unknown,
      failed = false;
    try {
      for (const listener of [...listeners])
        try {
          listener(strike);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
    } finally {
      this.dispatching = false;
    }
    if (failed) throw failure;
  }

  onPreUpdate(delta: number): void {
    this.step(delta);
  }

  /**
   * Puts the weather's clocks back as a fresh one with the same options has them, so a later `seek` (`resetClocks`
   * from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked there gives
   * (GAP-FILM-RESET): time, wind drift, fade level, wetness and snow cover to 0, no live strike or flash, and the
   * lightning schedule back to its seed, so the same strikes fall at the same moments again. Listeners stay.
   */
  resetTime(): void {
    this.idle();
    this.seconds = 0;
    this.drift[0] = this.drift[1] = 0;
    this.level = this.flashLevel = this.lightLevel = 0;
    this.wet = this.snow = 0;
    this.last = undefined;
    this.state = 0x9e3779b9;
    this.seeded = Number.NaN;
    this.counter = 0;
    this.active = [];
    this.flashValues.fill(0);
    // The scene lights the strikes moved, dark and where a fresh weather has them.
    const light = this.lightningLight,
      cloud = this.cloudFlash;
    light.position.splice(0, 3, 0, LIGHTNING_LIGHT_HEIGHT, 1000);
    light.color.splice(0, 3, ...LIGHTNING_COLOR);
    light.intensity = 0;
    light.range = 9000;
    cloud.position.splice(0, 3, 0, LIGHTNING_CLOUD_BASE + LIGHTNING_LIGHT_HEIGHT, 1000);
    cloud.color.splice(0, 3, ...LIGHTNING_COLOR);
    cloud.intensity = 0;
    cloud.radius = 200;
    this.lineLights.length = 0;
  }
  /**
   * Moves the weather by `delta` seconds as a frame update does (fade, wetness, snow cover, wind drift, the lightning
   * schedule and live strikes) but calls no `onLightning` or `onThunder` listener: `seek` from
   * `@margoengine/cutscene/seek` replays a run's steps with it, so a strike falls where and when it fell in the run.
   */
  advanceTime(delta: number): void {
    this.silent = true;
    try {
      this.step(delta);
    } finally {
      this.silent = false;
    }
  }

  private step(delta: number): void {
    this.idle();
    validate(this.options);
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid weather delta; pass a finite delta of 0 or more seconds.');
    const o = this.options,
      precipitation = o.precipitation ?? 'rain',
      rainRate = (this.rateNow = o.rainFrom
        ? Math.min(300, Math.max(0, o.rainFrom.rainRateAt(this.engine?.camera.position ?? [0, 0, 0]) || 0))
        : o.rainRate),
      target = precipitation === 'none' ? 0 : (o.intensity ?? (rainRate === undefined ? 0.5 : rainIntensity(rainRate))),
      fade = o.fadeSeconds ?? 4;
    this.seconds += delta;
    if (this.engine) this.listener.set(this.engine.camera.position);
    const wind = o.wind ?? [0, 0];
    this.drift[0] += wind[0] * delta;
    this.drift[1] += wind[1] * delta;
    this.level =
      fade === 0
        ? target
        : Math.max(
            0,
            Math.min(
              1,
              this.level + Math.sign(target - this.level) * Math.min(Math.abs(target - this.level), delta / fade),
            ),
          );
    // First-order approach to a target: rain wets, snow settles, both with their own drying and melting, each by its
    // share of the precipitation (sleet does both).
    const approach = (value: number, goal: number, up: number, down: number) =>
        value + (goal - value) * (1 - Math.exp(-delta / (goal > value ? up : down))),
      rain = this.rainShare,
      snow = precipitation === 'none' ? 0 : 1 - rain;
    this.wet = approach(this.wet, rain > 0 ? Math.min(1, this.level * 1.5) * rain : 0, 20, 90);
    this.snow = approach(this.snow, snow > 0 ? this.level * snow : 0, 120, 300);
    this.storm(delta);
    this.advance(delta);
  }

  private storm(delta: number): void {
    const l = this.options.lightning;
    if (!l || delta === 0) return;
    const seed = l.seed ?? lightningDefaults.seed;
    if (this.seeded !== seed) {
      this.state = (seed | 0) ^ 0x9e3779b9;
      this.seeded = seed;
    }
    const threshold = l.threshold ?? lightningDefaults.threshold,
      share = threshold >= 1 ? 0 : Math.max(0, (this.level - threshold) / (1 - threshold)),
      perSecond = ((l.rate ?? lightningDefaults.rate) * share) / 60;
    // A Poisson process: the chance of a strike in this step. A long step (a hidden tab) strikes at most once.
    if (perSecond > 0 && this.random() < 1 - Math.exp(-perSecond * Math.min(delta, 5))) this.spawn({});
  }

  private advance(delta: number): void {
    let flash = 0,
      stroke = 0,
      at = this.last;
    const l = this.options.lightning;
    for (const a of this.active) {
      a.age += delta;
      const level = lightningFlash(a.age, a.offsets, a.amplitudes);
      flash = Math.max(flash, a.strike.strength * level);
      if (level > stroke) {
        stroke = level;
        at = a.strike;
      }
      if (!a.heard && a.age >= a.strike.thunderDelay) {
        a.heard = true;
        this.notify(this.thunderListeners, a.strike);
      }
    }
    this.active = this.active.filter((a) => !a.heard || a.age < a.offsets[a.offsets.length - 1] + 0.6);
    if (l?.hold !== undefined) flash = stroke = l.hold;
    this.flashLevel = flash;
    this.lightLevel = stroke;
    this.linkPlugins();
    this.light(at);
    this.flashValues[3] = 0;
    const strength = l?.strength ?? lightningDefaults.strength,
      color = l?.color ?? flashColor;
    for (let i = 0; i < 3; i++) this.flashValues[i] = color[i] * strength * flash;
    this.linkLights(this.foundGroups, this.wantLights);
  }

  // Wires the flash into the scene's plugins found by name (lightning.link). Cheap when nothing changes: a map scan, and
  // a light list change only while a flash lasts and once when it ends.
  private linkPlugins(): void {
    const l = this.options.lightning,
      k = l?.link,
      on = l !== undefined && k !== false,
      want = (key: 'clouds' | 'fog' | 'lights') => on && (typeof k === 'object' ? k[key] !== false : true),
      plugins = this.engine?.plugins as ReadonlyMap<string, object> | undefined;
    if (!plugins) return;
    const wantClouds = want('clouds'),
      wantFog = want('fog');
    let bottom = Infinity,
      top = Infinity;
    for (const [name, plugin] of plugins) {
      const o = (plugin as { options?: unknown }).options;
      if (typeof o !== 'object' || o === null) continue;
      if (isCloudLayerName(name)) {
        const deck = o as {
          flash?: unknown;
          weather?: { cloud: number };
          type?: 'cumulus' | 'stratus' | 'storm' | 'scud';
          bottom?: number;
          top?: number;
        };
        if (wantClouds && deck.flash === undefined) {
          deck.flash = this.cloudFlash;
          this.linkedClouds.add(deck);
        } else if (!wantClouds && this.linkedClouds.delete(deck)) {
          if (deck.flash === this.cloudFlash) delete deck.flash;
        } else if (this.linkedClouds.has(deck) && deck.flash !== this.cloudFlash) this.linkedClouds.delete(deck);
        // Scud under the deck takes the flash too, but the bolt leaves the deck's base, not the shreds under it.
        if (this.linkedClouds.has(deck) && deck.type !== 'scud') {
          const layer =
              deck.weather || deck.type
                ? cloudLayerFor(deck.weather ?? { cloud: 0.5 }, this.deckScratch, deck.type)
                : undefined,
            b = deck.bottom ?? layer?.bottom ?? LIGHTNING_CLOUD_BASE;
          if (b < bottom) {
            bottom = b;
            top = deck.top ?? layer?.top ?? Infinity;
          }
        }
      } else if (name === 'volumetric-fog') {
        const fog = o as { lightning?: { light?: unknown } };
        if (wantFog && fog.lightning === undefined) {
          fog.lightning = { light: this.lightningLight };
          this.linkedFogs.add(fog);
        } else if (!wantFog && this.linkedFogs.delete(fog)) {
          if (fog.lightning?.light === this.lightningLight) delete fog.lightning;
        } else if (this.linkedFogs.has(fog) && fog.lightning?.light !== this.lightningLight)
          this.linkedFogs.delete(fog);
      }
    }
    this.deckBottom = bottom === Infinity ? LIGHTNING_CLOUD_BASE : bottom;
    this.deckTop = top;
    this.foundGroups = plugins.get('clustered-groups') as LinkedGroups | undefined;
    this.wantLights = want('lights');
  }

  private linkLights(groups: LinkedGroups | undefined, wanted: boolean): void {
    const link = this.options.lightning?.link,
      name = (typeof link === 'object' ? link.group : undefined) ?? 'lightning';
    if (this.linkedGroup && (!wanted || !groups || this.linkedGroup.isDisposed || name !== this.linkedName)) {
      if (!this.linkedGroup.isDisposed) this.linkedGroup.dispose();
      this.linkedGroup = undefined;
      this.linkedOn = false;
    }
    if (!wanted || !groups || groups.isDisposed || groups.clustered.isDisposed) return;
    const light = this.lightningLight,
      list = this.lineLights.length ? this.lineLights : [light],
      main = list.reduce((a, b) => (b.intensity > a.intensity ? b : a), list[0]),
      shadow = this.options.lightning?.light?.shadow,
      far = typeof shadow === 'object' ? (shadow.far ?? 3000) : 3000,
      near = typeof shadow === 'object' ? (shadow.near ?? 1) : 1,
      lit = light.intensity > 0;
    // A shadow map only where the lights have one to spare (a `setLights` with more shadowed lights than slots throws).
    // Along a channel only the brightest of the lights casts one.
    for (const x of list) if (x !== main) delete x.shadow;
    if (lit && shadow !== false) {
      const slots = groups.clustered.shadowSlots ?? 0,
        used = groups.list.filter(
          (x) => !list.includes(x as LightningLight) && x.shadow !== undefined && x.shadow !== false,
        ).length;
      if (slots > used) main.shadow = { near, far: Math.min(far, main.range) };
      else delete main.shadow;
    } else delete main.shadow;
    if (!this.linkedGroup) {
      if (!lit) return;
      this.linkedGroup = groups.group(name);
      this.linkedName = name;
    }
    // The list changes while a flash lasts (the light moves and fades) and once when it ends.
    if (lit) {
      this.linkedGroup.setLights(list);
      this.linkedOn = true;
    } else if (this.linkedOn) {
      this.linkedGroup.setLights([]);
      this.linkedOn = false;
    }
  }

  // Takes the flash out of every plugin it was wired into.
  private unlink(): void {
    for (const deck of this.linkedClouds as Set<{ flash?: unknown }>)
      if (deck.flash === this.cloudFlash) delete deck.flash;
    for (const fog of this.linkedFogs as Set<{ lightning?: { light?: unknown } }>)
      if (fog.lightning?.light === this.lightningLight) delete fog.lightning;
    this.linkedClouds.clear();
    this.linkedFogs.clear();
    if (this.linkedGroup && !this.linkedGroup.isDisposed) this.linkedGroup.dispose();
    this.linkedGroup = undefined;
    this.linkedOn = false;
  }

  // The lights along the bolt's channel (lightning.light.line): the point light's candela shared out by `weight`.
  private alongChannel(
    at: LightningStrike | undefined,
    point: LightningLight,
    o: WeatherLightningLightOptions | undefined,
  ): void {
    const source = this.channelSource;
    if (!at || !source || !(o?.line ?? true)) {
      this.lineLights.length = 0;
      return;
    }
    const points = source.lights(at, o?.segments ?? 3, o?.height ?? LIGHTNING_LIGHT_HEIGHT);
    this.lineLights.length = points.length;
    points.forEach((p, i) => {
      const x = (this.lineLights[i] ??= { position: [0, 0, 0], color: [1, 1, 1], intensity: 0, range: 0, decay: 2 });
      x.position[0] = p.position[0];
      x.position[1] = p.position[1];
      x.position[2] = p.position[2];
      x.color[0] = point.color[0];
      x.color[1] = point.color[1];
      x.color[2] = point.color[2];
      x.intensity = point.intensity * p.weight;
      x.range = point.range;
      x.radius = p.radius;
    });
  }

  private light(at: LightningStrike | undefined): void {
    const o = this.options.lightning?.light,
      light = this.lightningLight,
      color = o?.color ?? LIGHTNING_COLOR,
      top = Math.max(color[0], color[1], color[2]);
    for (let i = 0; i < 3; i++) light.color[i] = color[i] / top;
    if (at) {
      light.position[0] = at.position[0];
      light.position[2] = at.position[2];
    }
    light.position[1] = o?.height ?? LIGHTNING_LIGHT_HEIGHT;
    light.range =
      o?.range ?? 1.5 * Math.max(1000, this.options.lightning?.maxDistance ?? lightningDefaults.maxDistance);
    const luminance = 0.2126 * light.color[0] + 0.7152 * light.color[1] + 0.0722 * light.color[2],
      peak = (o?.peak ?? LIGHTNING_PEAK_CANDELA) * (o?.scale ?? 1);
    light.intensity = (this.lightLevel * peak) / luminance;
    this.alongChannel(at, light, o);
    // Inside the deck: the channel's share above the cloud base, centred one decay length above it (Jordan and Uman).
    const k = this.options.lightning?.cloud,
      base = k?.base ?? this.deckBottom,
      cloud = this.cloudFlash;
    cloud.position[0] = light.position[0];
    cloud.position[1] = Math.min(base + LIGHTNING_LIGHT_HEIGHT, k?.base === undefined ? this.deckTop : Infinity);
    cloud.position[2] = light.position[2];
    cloud.color[0] = light.color[0];
    cloud.color[1] = light.color[1];
    cloud.color[2] = light.color[2];
    cloud.radius = k?.radius ?? 200;
    cloud.intensity = (this.lightLevel * (k?.peak ?? peak * lightningCloudShare(base)) * (k?.scale ?? 1)) / luminance;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Weather requires WebGPU; attach a new Weather to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.flashUniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'weather:precipitation',
      order: 6,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.maskDrawn = false;
        this.drawPrecipitation(c);
      },
    });
    graph.add({
      name: 'weather:flash',
      order: 6.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawFlash(c);
      },
    });
  }

  private drawPrecipitation(c: WeatherPassContext): void {
    const o = this.options,
      kind = o.precipitation ?? 'rain';
    if (kind === 'none' || this.level <= 0.001) return;
    if (kind !== 'sleet') return this.drawKind(c, kind, 1, this.overlay, this.uniform!, this.values);
    // Sleet: rain and snow at once, each with its share of the particles; the snow on its own hash seed.
    const share = o.snowShare ?? 0.5;
    this.drawKind(c, 'rain', 1 - share, this.overlay, this.uniform!, this.values);
    this.snowUniform ??= c.device.createBuffer({
      size: this.snowValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.drawKind(c, 'snow', share, this.snowOverlay, this.snowUniform, this.snowValues, 0x51ed27);
  }

  private drawKind(
    c: WeatherPassContext,
    kind: 'rain' | 'snow',
    share: number,
    overlay: ParticleOverlay,
    uniform: GPUBuffer,
    v: Float32Array,
    salt = 0,
  ): void {
    const o = this.options,
      d = defaults[kind],
      count = Math.ceil((o.particles ?? d.particles) * this.level * share);
    if (count === 0) return;
    const radius = o.radius ?? 25,
      height = o.height ?? 20,
      wind = o.wind ?? [0, 0],
      snow = kind === 'snow',
      rainRate = o.rainFrom ? this.rateNow : o.rainRate,
      fall = snow ? SNOWFLAKE_FALL_COEFFICIENT : rainFall(rainRate),
      color = o.color ?? d.color,
      brightness = o.brightness ?? 1,
      [width, tall] = viewSize(c) as [number, number],
      size = snowflakeSizeLaw(o.snowfallRate ?? 1, o.flakeSizes ?? [2, 10]);
    v.set(c.camera.matrix, 0);
    v.set(c.camera.position, 16);
    // eye.w and lens: the thin lens's scale, focal distance and focus - focal length (snow only, `weatherLens`), and
    // the near fade's two distances, the first no nearer than the near plane.
    const lens = snow ? weatherLens(o.lens, width, tall, c.camera.fov) : { scale: 0, focus: 1, focalLength: 0 },
      [nearIn, nearFull] = o.nearFade ?? [0.4, 2],
      fadeIn = Math.max(nearIn, c.camera.near);
    v[19] = lens.focus - lens.focalLength;
    v[44] = lens.scale;
    v[45] = lens.focus;
    v[46] = fadeIn;
    v[47] = Math.max(nearFull, fadeIn + 1e-3);
    v[20] = radius * 2;
    v[21] = height;
    v[22] = radius * 2;
    v[23] = snow ? size.low : 0;
    // Position = start + drift, wrapped into the box on the CPU in double precision so it stays exact. The wind's drift
    // is the running sum kept by onPreUpdate. Each raindrop and snow flake falls at its own speed, k / 512 m/s
    // (`rainFallSpeed` or `snowflakeFallSpeed` of its size): drift.y is then the fall phase, seconds over
    // 512 heights as an exact 24-bit count, and the shader takes flake k's fall as k times it, wrapped to 24 bits in
    // u32, which stays exact and continuous for every k when the count wraps (KB-SNOW-FALLSPEED1).
    const wrap = (value: number, size: number) => ((value % size) + size) % size;
    v[24] = wrap(this.drift[0], radius * 2);
    v[25] = Math.floor(wrap(this.seconds / (512 * height), 1) * 16777216);
    v[26] = wrap(this.drift[1], radius * 2);
    // Snow sways with sin(phase) and cos(0.8 phase): the phase wraps at 10 pi, a whole turn of both.
    v[27] = (this.seconds * 1.3) % (Math.PI * 10);
    for (let i = 0; i < 3; i++) v[28 + i] = color[i] * brightness;
    v[31] = o.opacity ?? d.opacity;
    // screen: viewport pixels and the focal length in pixels. params: snow flag, the flake sizes' slope per mm of melted
    // diameter (`snowflakeSizeLaw`) or rain streak seconds, the hash seed (as bits) and the lightning lift of the
    // colour. extra: wind, the rain's fall speed or the snow's fall law coefficient (`SNOWFLAKE_FALL_COEFFICIENT`),
    // and the rain streak's width or the snow's share of the size law (`span`);
    // volume.w: the smallest melted diameter drawn, mm.
    // screen.w: the snow's exposure in seconds.
    v[32] = width;
    v[33] = tall;
    v[34] = tall / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    v[35] = snow ? (o.exposure ?? 0) : 0;
    v[36] = +snow;
    v[37] = snow ? size.lambda : 0.035;
    new Uint32Array(v.buffer)[38] = ((this.options.lightning?.seed ?? 1) + salt) >>> 0;
    v[39] = Math.min(1, this.flashLevel);
    v[40] = wind[0];
    v[41] = fall;
    v[42] = wind[1];
    v[43] = snow ? size.span : Math.max(1, (tall / 540) * 1.2);
    // rain: the drops' size law and the scale of their fall; look: sheets, gusts, the inverse mean streak light and
    // the gust clock (see the shader's notes). Snow keeps a harmless law (slope 1) there. Without a rainRate the law is
    // the rain's own rate: its share of the intensity, as its share of the particles, so sleet's rain is the rain drawn
    // alone at that intensity (KB-SKY-SLEETLAW1).
    const drops = o.dropSizes ?? [0.5, 6],
      lawRate = rainRate ?? 80 * ((o.intensity ?? 0.5) * share) ** 3,
      law = rainDropSizeLaw(lawRate, drops);
    v[48] = snow ? 1 : law.lambda;
    v[49] = snow ? 0 : law.span;
    v[50] = snow ? 0 : law.low;
    v[51] = rainRate === undefined ? fall / rainFallSpeed(rainDropDiameter(lawRate)) : 1;
    v[52] = o.rainVariation ?? 0.5;
    v[53] = o.gusts ?? 0.5;
    v[54] = snow ? 1 : 1 / rainStreakMean(lawRate, drops);
    v[55] = this.seconds % RAIN_GUST_PERIOD;
    // The mask is drawn while TAA reads masks, so a scene wires nothing (KB-TAA-PARTICLEMASK1).
    const masked = o.reactive ?? reactiveMaskWanted(c, this),
      cover = this.occlusion;
    if (cover?.buffer && cover.view) {
      const e = this.coverEntries;
      if (!e || (e[0].resource as GPUBufferBinding).buffer !== cover.buffer || e[1].resource !== cover.view)
        this.coverEntries = [
          { binding: 1, resource: { buffer: cover.buffer } },
          { binding: 2, resource: cover.view },
        ];
      const code = cover.shader(shader);
      overlay.draw(c, code, uniform, v as Float32Array<ArrayBuffer>, count, this.coverEntries);
      if (masked) this.drawMask(c, code, uniform, count, this.coverEntries);
    } else {
      overlay.draw(c, shader, uniform, v as Float32Array<ArrayBuffer>, count);
      if (masked) this.drawMask(c, shader, uniform, count);
    }
  }

  /**
   * Draws the particles of the draw just made (its uniform already written) into the reactive mask, at the frame's
   * sample count and against its depth like the particles themselves; the first draw of a frame clears the mask.
   */
  private drawMask(
    c: WeatherPassContext,
    code: string,
    uniform: GPUBuffer,
    count: number,
    extra?: GPUBindGroupEntry[],
  ): void {
    const samples = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil?.format,
      size = c.width + 'x' + c.height + ':' + samples;
    if (this.maskKey !== size) {
      this.mask?.destroy();
      this.maskSamples?.destroy();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.mask = c.device.createTexture({ size: [c.width, c.height], format: 'r8unorm', usage });
      this.maskSamples =
        samples > 1
          ? c.device.createTexture({
              size: [c.width, c.height],
              format: 'r8unorm',
              sampleCount: samples,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : undefined;
      this.maskKey = size;
    }
    const key = samples + ':' + depthFormat;
    let draw = this.maskDraws.get(uniform);
    if (!draw || draw.code !== code || draw.key !== key) {
      const module = c.device.createShaderModule({ code: code + reactiveEntry });
      const pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'reactive',
          targets: [{ format: 'r8unorm', blend: { color: maxBlend, alpha: maxBlend } }],
        },
        multisample: c.descriptor.multisample,
        depthStencil: depthFormat
          ? { format: depthFormat, depthCompare: 'greater-equal', depthWriteEnabled: false }
          : undefined,
      });
      draw = { code, key, pipeline };
      this.maskDraws.set(uniform, draw);
    }
    if (!draw.bind || draw.extra !== extra) {
      draw.bind = c.device.createBindGroup({
        layout: draw.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }, ...(extra ?? [])],
      });
      draw.extra = extra;
    }
    const first = !this.maskDrawn,
      target = this.maskSamples ?? this.mask!;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          resolveTarget: this.maskSamples ? this.mask!.createView() : undefined,
          loadOp: first ? 'clear' : 'load',
          clearValue: [0, 0, 0, 0],
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: depthFormat ? { view: c.depth, depthReadOnly: true, stencilReadOnly: true } : undefined,
    });
    applyView(pass, c);
    pass.setPipeline(draw.pipeline);
    pass.setBindGroup(0, draw.bind);
    pass.draw(6, count);
    pass.end();
    this.maskDrawn = true;
    // TAA reads the mask from the pass context by itself (KB-TAA-PARTICLEMASK1).
    publishReactiveMask(c, this.mask!);
  }

  private drawFlash(c: WeatherPassContext): void {
    if (this.flashLevel <= 0.0005 || !(this.flashValues[0] + this.flashValues[1] + this.flashValues[2] > 0)) return;
    const key = c.format + ':' + c.descriptor.multisample?.count;
    if (this.flashKey !== key) {
      const module = c.device.createShaderModule({ code: flashShader });
      this.flashPipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
      });
      this.flashBind = c.device.createBindGroup({
        layout: this.flashPipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.flashUniform! } }],
      });
      this.flashKey = key;
    }
    c.device.queue.writeBuffer(this.flashUniform!, 0, this.flashValues as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.flashPipeline!);
    pass.setBindGroup(0, this.flashBind!);
    pass.draw(3);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.flashUniform?.destroy();
    this.uniform = this.flashUniform = undefined;
    this.overlay.release();
    this.snowOverlay.release();
    this.snowUniform?.destroy();
    this.snowUniform = this.coverEntries = undefined;
    this.flashPipeline = this.flashBind = undefined;
    this.flashKey = '';
    this.mask?.destroy();
    this.maskSamples?.destroy();
    this.mask = this.maskSamples = undefined;
    this.maskKey = '';
    this.maskDrawn = false;
    this.maskDraws.clear();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unlink();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    this.active = [];
    this.lightningListeners.clear();
    this.thunderListeners.clear();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

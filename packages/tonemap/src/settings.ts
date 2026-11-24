// The look controls of the tonemap package as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings and the row shape is shared/settings.js): the display curve, exposure, contrast, white balance,
// vignette, grain, dither, chromatic aberration and eye adaptation of Tonemap, the wheels, lift, gamma, gain, saturation and
// hue controls of Grade and HueGrade, and the four controls of LocalExposure. Each row names an option, its group, kind,
// default, range, step, unit, what it does and `live`. Tonemap, Grade, HueGrade and LocalExposure keep their options object
// and read it each frame into a uniform, so `applyTonemapSettings` writes the options and the next frame draws them.
// Rows that change which shader program runs (an effect going from 0 to on, the primaries leaving their defaults, the curve
// going to or from a classic one) are `live: false`: that frame compiles. Everything else is free to key every frame.
// Not rows: the tone curves of Grade and the hue curve of HueGrade (lists of points, not sliders), the metering mask of
// auto exposure (a texture), the LUT, and `extensions`, `source` and `inputColorSpace` (set at construction).
import {
  checkSettings,
  choiceSetting,
  colorSetting,
  liveSettings,
  numberSetting,
  sameSettingValue,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';

/** A colour or wheel value: three numbers. */
export type TonemapSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a triple, or a choice. */
export type TonemapSettingValue = number | string | TonemapSettingColor;
/** Values by setting name; a name left out takes its default. */
export type TonemapSettingValues = Readonly<Record<string, TonemapSettingValue>>;
/** The panel a setting sits in. `tonemap`, `vignette` and `autoExposure` write the Tonemap; `grade`, `hue` and `local` their extension. */
export type TonemapSettingGroup = 'tonemap' | 'vignette' | 'autoExposure' | 'grade' | 'hue' | 'local';
/** One control: the shared row shape with the tonemap groups. */
export interface TonemapSetting extends SettingRow {
  readonly group: TonemapSettingGroup;
  readonly default: TonemapSettingValue;
}
/** Anything with the options object the effect keeps and reads each frame. */
export interface TonemapSettingTarget {
  readonly options: object;
}
/** The objects the rows write: each row needs the one its group names (`vignette.*` needs `tonemap`). */
export interface TonemapSettingTargets {
  /** A `Tonemap`: the `tonemap`, `vignette` and `autoExposure` rows. */
  tonemap?: TonemapSettingTarget;
  /** A `Grade` (or a `HueGrade`): the `grade` rows. */
  grade?: TonemapSettingTarget;
  /** A `HueGrade`: the `grade` rows and the `hue` rows. */
  hueGrade?: TonemapSettingTarget;
  /** A `LocalExposure`: the `local` rows. */
  local?: TonemapSettingTarget;
}

const n = (
  name: string,
  group: TonemapSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): TonemapSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as TonemapSetting;
const c = (
  name: string,
  group: TonemapSettingGroup,
  value: TonemapSettingColor,
  min: number,
  max: number,
  about: string,
  live = true,
): TonemapSetting => colorSetting(name, group, value, min, max, about, live) as TonemapSetting;
const pick = (name: string, group: TonemapSettingGroup, choices: string[], about: string, live = true) =>
  choiceSetting(name, group, choices, about, live) as TonemapSetting;
const COMPILES = ' Moving it off or back onto its default changes the display program, so that one frame compiles; key it away from the default before a shot.';
const SHAPES = ' Moving it off its default (or back) turns the shaping program on or off, so that one frame compiles; moving it between other values is free. A CustomCurve replaces the curve and this shaping with it.';
const HUES = ['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'];

/** Every tonemap look control, in panel order. Defaults are the values Tonemap, Grade, HueGrade and LocalExposure use without the option. */
export const TONEMAP_SETTINGS: readonly TonemapSetting[] = [
  pick('tonemap.curve', 'tonemap', ['neutral', 'agx', 'acescg', 'reinhard', 'cineon', 'linear'], "Display curve: 'neutral' is Khronos PBR Neutral (the curve core ends with), 'agx' AgX, 'acescg' the ACES fitted curve; 'reinhard', 'cineon' and 'linear' are the classic curves of ported scenes. Going between the first three is free; to or from a classic one compiles that frame.", false),
  n('tonemap.exposure', 'tonemap', 0, -16, 16, 0.05, 'stops', 'Exposure before the curve, in stops.'),
  n('tonemap.contrast', 'tonemap', 1, 0, 4, 0.01, '', 'Contrast about 18% grey in display-linear light: above 1 deepens the shadows without clipping them, 0 is flat grey.'),
  n('tonemap.whitePoint', 'tonemap', 0, 0, 64, 0.1, '', 'White point: the scene-linear value (after exposure) that lands on exactly 1, as the curve output divided by the curve value there; brighter values clip. 0 is off (the curve keeps its own white); below 0.01 acts as 0.01.' + SHAPES, false),
  n('tonemap.toe', 'tonemap', 1, 0, 3, 0.01, '', 'Slope of the display curve at black: below 1 a softer toe that lifts nothing but eases into the shadows, above 1 a steeper one. The cubic through black and white (monotone over 0 to 3), after the white point.' + SHAPES, false),
  n('tonemap.shoulder', 'tonemap', 1, 0, 3, 0.01, '', 'Slope of the display curve at white: below 1 rolls the highlights off before white, 0 reaches white flat. Same cubic as the toe.' + SHAPES, false),
  n('tonemap.temperature', 'tonemap', 6500, 1667, 25000, 50, 'K', 'White balance as the colour temperature of the scene light: below 6500 cools the picture to cancel warm light (3200 for tungsten), above warms it; 6500 changes nothing.' + COMPILES, false),
  n('tonemap.tint', 'tonemap', 0, -1, 1, 0.01, '', 'White-balance tint: -1 green, 1 magenta.' + COMPILES, false),
  n('tonemap.grain', 'tonemap', 0, 0, 1, 0.01, '', 'Animated film grain, strongest in the mid-tones.' + COMPILES, false),
  n('tonemap.dither', 'tonemap', 0, 0, 1, 0.01, '', 'Output dithering against banding: triangular noise of up to one code value times this, narrowed near black and white. 0 is off, 1 the full amount.' + COMPILES, false),
  n('tonemap.chromaticAberration', 'tonemap', 0, 0, 1, 0.01, '', 'Radial red and blue fringing; 1 shifts the channels by 2% of the view at its edge.' + COMPILES, false),

  n('vignette.amount', 'vignette', 0, 0, 1, 0.01, '', 'Corner darkening (or tinting, by colour and blend).' + COMPILES, false),
  n('vignette.radius', 'vignette', 0.5, 0, 1, 0.01, '', 'Where the vignette starts, as a fraction of the corner distance.'),
  n('vignette.softness', 'vignette', 0.5, 0, 1, 0.01, '', 'Width of the fall-off, as a fraction of the corner distance.'),
  c('vignette.color', 'vignette', [0, 0, 0], 0, 1, 'Linear Rec.709 colour of the vignette: black is the classic darkening.'),
  n('vignette.centerX', 'vignette', 0.5, 0, 1, 0.01, '', 'Centre of the vignette from the left, as a fraction of the view.'),
  n('vignette.centerY', 'vignette', 0.5, 0, 1, 0.01, '', 'Centre of the vignette from the top, as a fraction of the view.'),
  n('vignette.roundness', 'vignette', 0, 0, 1, 0.01, '', '0 stretches the vignette with the view into an ellipse through the corners, 1 makes it a circle.'),
  pick('vignette.blend', 'vignette', ['multiply', 'opaque'], "'multiply' multiplies the picture by the colour as the vignette comes in (black darkens, a tint tints); 'opaque' blends toward the colour itself, like a painted matte."),

  pick('autoExposure.enabled', 'autoExposure', ['off', 'on'], 'Eye adaptation: meters the scene each frame and adapts the exposure toward 18% grey, on top of tonemap.exposure. Turning it on or off changes the display program and makes the metering buffers.', false),
  n('autoExposure.min', 'autoExposure', -4, -16, 16, 0.1, 'stops', 'Lowest exposure the metering may apply; at most autoExposure.max.'),
  n('autoExposure.max', 'autoExposure', 4, -16, 16, 0.1, 'stops', 'Highest exposure the metering may apply.'),
  n('autoExposure.speed', 'autoExposure', 1.5, 0.01, 100, 0.01, '1/s', 'Adaptation speed: higher is quicker (1.5 settles most of the way in about half a second).'),
  n('autoExposure.compensation', 'autoExposure', 0, -8, 8, 0.1, 'stops', 'Extra stops added to the metered exposure: above 0 brightens the look.'),
  pick('autoExposure.method', 'autoExposure', ['mean', 'histogram'], "'mean' is the weighted log-average luminance; 'histogram' averages only the samples between the percentiles, so a small light or a dark corner does not swing the exposure."),
  n('autoExposure.percentileLow', 'autoExposure', 0.1, 0, 1, 0.01, '', 'Share of the darkest samples the histogram drops; below autoExposure.percentileHigh.'),
  n('autoExposure.percentileHigh', 'autoExposure', 0.9, 0, 1, 0.01, '', 'Share of the samples the histogram keeps, darkest first.'),
  pick('autoExposure.metering', 'autoExposure', ['average', 'center', 'spot'], "Where the meter looks: 'average' weighs the whole view, 'center' a Gaussian about the middle, 'spot' only the disc below. (A mask texture is set on the option object, not a row.)"),
  n('autoExposure.spotX', 'autoExposure', 0.5, 0, 1, 0.01, '', 'Centre of the spot from the left, as a fraction of the view.'),
  n('autoExposure.spotY', 'autoExposure', 0.5, 0, 1, 0.01, '', 'Centre of the spot from the top, as a fraction of the view.'),
  n('autoExposure.spotRadius', 'autoExposure', 0.05, 0.001, 1, 0.001, '', 'Radius of the spot as a fraction of the shorter side of the view.'),

  c('grade.shadows', 'grade', [0, 0, 0], -1, 1, 'RGB offset added to the shadows (weight 1 at black, 0 from mid grey up).'),
  c('grade.midtones', 'grade', [0, 0, 0], -1, 1, 'RGB offset added to the midtones.'),
  c('grade.highlights', 'grade', [0, 0, 0], -1, 1, 'RGB offset added to the highlights (weight 0 up to mid grey, 1 at white).'),
  ...HUES.map((hue) => n(`grade.saturation${hue}`, 'grade', 1, 0, 4, 0.01, '', `Saturation multiplier at ${hue.toLowerCase()} hues: 0 greys them, above 1 deepens them.`)),
  c('grade.lift', 'grade', [0, 0, 0], -1, 1, 'Lift per channel: raises (or lowers) the blacks and leaves white where it is.' + COMPILES + ' The lift, gamma, gain and saturation rows share that one program.', false),
  c('grade.gamma', 'grade', [1, 1, 1], 0.1, 10, 'Gamma per channel: above 1 brightens the midtones, below 1 darkens them; black and white stay. Shares the program of grade.lift.', false),
  c('grade.gain', 'grade', [1, 1, 1], 0, 4, 'Gain per channel: scales the whites and leaves black where it is. Shares the program of grade.lift.', false),
  n('grade.saturation', 'grade', 1, 0, 4, 0.01, '', 'Saturation about Rec. 709 luma after lift, gamma and gain: 0 grey, above 1 deeper. Shares the program of grade.lift.', false),

  n('hue.shift', 'hue', 0, -360, 360, 1, 'deg', 'Rotates every hue by this many degrees (needs a HueGrade).'),

  n('local.strength', 'local', 0.5, 0, 1, 0.01, '', 'How far each region moves toward middle grey: 0 is off, 1 flat.'),
  n('local.maxStops', 'local', 3, 0, 8, 0.1, 'stops', 'Largest local change, in stops.'),
  n('local.radius', 'local', 0.02, 0.002, 0.1, 0.001, '', 'Size of a region as a fraction of the view height. A larger radius uses a coarser base, so crossing the block size reallocates its textures.', false),
  n('local.edges', 'local', 1.3, 0.1, 8, 0.1, 'stops', 'Edge stop of the bilateral blur in stops of luminance: smaller keeps more edges.'),
];
/** The rows that can change every frame without a rebuild. */
export const TONEMAP_LIVE_SETTINGS: readonly TonemapSetting[] = liveSettings(TONEMAP_SETTINGS) as TonemapSetting[];
const BY_NAME = settingIndex(TONEMAP_SETTINGS) as Map<string, TonemapSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function tonemapSettingDefaults(): Record<string, TonemapSettingValue> {
  return settingDefaults(TONEMAP_SETTINGS) as Record<string, TonemapSettingValue>;
}
/**
 * Named looks of the display, each only values of {@link TONEMAP_SETTINGS} (a name left out keeps its default): pass one
 * to {@link applyTonemapSettings}, or spread it under your own values.
 */
export const TONEMAP_LOOKS = {
  /** Today's defaults: the neutral curve and nothing else. */
  natural: {},
  /** A filmic grade: AgX, a firmer contrast, a soft vignette, a little grain and a warm highlight. */
  filmic: {
    'tonemap.curve': 'agx',
    'tonemap.contrast': 1.15,
    'tonemap.grain': 0.08,
    'vignette.amount': 0.35,
    'grade.highlights': [0.02, 0.01, -0.02],
    'grade.shadows': [-0.01, 0, 0.02],
  },
  /** A cold bleached look for storms and ash: low saturation, cool balance, hard contrast, a dark vignette. */
  bleach: {
    'tonemap.curve': 'agx',
    'tonemap.contrast': 1.3,
    'tonemap.temperature': 5400,
    'vignette.amount': 0.5,
    'grade.saturation': 0.55,
  },
  /** Smoke and firelight: a warm balance, a lifted dark red, a deep vignette and grain. */
  ember: {
    'tonemap.curve': 'agx',
    'tonemap.temperature': 8200,
    'tonemap.contrast': 1.2,
    'tonemap.grain': 0.1,
    'vignette.amount': 0.55,
    'grade.shadows': [0.02, 0, -0.01],
    'grade.saturation': 1.1,
  },
  /** The animatedFeature family: one grade, saturation up 12 percent, a warm key, dither on, no grain or chromatic aberration. */
  animatedFeature: {
    'tonemap.curve': 'agx',
    'tonemap.temperature': 5800,
    'tonemap.grain': 0,
    'tonemap.dither': 1,
    'tonemap.chromaticAberration': 0,
    'vignette.amount': 0.15,
    'grade.saturation': 1.12,
  },
} as const satisfies Record<string, TonemapSettingValues>;
/** The name of a look in {@link TONEMAP_LOOKS}. */
export type TonemapLookName = keyof typeof TONEMAP_LOOKS;

const KEY: Record<TonemapSettingGroup, keyof TonemapSettingTargets> = {
  tonemap: 'tonemap',
  vignette: 'tonemap',
  autoExposure: 'tonemap',
  grade: 'grade',
  hue: 'hueGrade',
  local: 'local',
};
const target = (targets: TonemapSettingTargets, group: TonemapSettingGroup) =>
  group === 'grade' ? (targets.grade ?? targets.hueGrade) : targets[KEY[group]];
const TONEMAP_OPTION: Record<string, string> = {
  'tonemap.curve': 'curve',
  'tonemap.exposure': 'exposure',
  'tonemap.contrast': 'contrast',
  'tonemap.whitePoint': 'whitePoint',
  'tonemap.toe': 'toe',
  'tonemap.shoulder': 'shoulder',
  'tonemap.temperature': 'temperature',
  'tonemap.tint': 'tint',
  'tonemap.grain': 'grain',
  'tonemap.dither': 'dither',
  'tonemap.chromaticAberration': 'chromaticAberration',
  'vignette.amount': 'vignette',
  'vignette.radius': 'vignetteRadius',
  'vignette.softness': 'vignetteSoftness',
  'vignette.color': 'vignetteColor',
  'vignette.roundness': 'vignetteRoundness',
  'vignette.blend': 'vignetteBlend',
};

/**
 * Writes `values` onto the options of the objects given (a name left out takes its default), so each draws exactly that
 * state from the next frame. `autoExposure.enabled` 'off' removes the option; 'on' writes an object of the other
 * autoExposure rows (an existing object, and its `mask`, is kept and updated in place).
 * @throws TypeError for a name not in {@link TONEMAP_SETTINGS}, or a value moved off its default whose target is not in
 * `targets`; RangeError for a value outside its row's range or kind, `autoExposure.min` above `autoExposure.max`, or
 * `autoExposure.percentileLow` not below `autoExposure.percentileHigh`.
 * @example applyTonemapSettings({ tonemap, grade }, TONEMAP_LOOKS.bleach);
 */
export function applyTonemapSettings(targets: TonemapSettingTargets, values: TonemapSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'tonemap', 'TONEMAP_SETTINGS in @margoengine/tonemap/settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  for (const s of TONEMAP_SETTINGS) {
    if (!(s.name in values) || target(targets, s.group) || sameSettingValue(values[s.name], s.default)) continue;
    throw new TypeError(`Setting ${s.name} needs targets.${s.group === 'hue' ? 'hueGrade' : KEY[s.group]}; pass it to applyTonemapSettings`);
  }
  if ((v('autoExposure.min') as number) > (v('autoExposure.max') as number))
    throw new RangeError('Invalid tonemap setting autoExposure.min; use a value up to autoExposure.max');
  if ((v('autoExposure.percentileLow') as number) >= (v('autoExposure.percentileHigh') as number))
    throw new RangeError('Invalid tonemap setting autoExposure.percentileLow; use a value below autoExposure.percentileHigh');
  const tonemap = targets.tonemap?.options as Record<string, unknown> | undefined;
  if (tonemap) {
    for (const [name, key] of Object.entries(TONEMAP_OPTION)) {
      const value = v(name);
      tonemap[key] = Array.isArray(value) ? [...value] : value;
    }
    tonemap.vignetteCenter = [v('vignette.centerX'), v('vignette.centerY')];
    if (v('autoExposure.enabled') === 'off') delete tonemap.autoExposure;
    else {
      const kept = tonemap.autoExposure;
      const a = (typeof kept === 'object' && kept ? kept : {}) as Record<string, unknown>;
      a.min = v('autoExposure.min');
      a.max = v('autoExposure.max');
      a.speed = v('autoExposure.speed');
      a.compensation = v('autoExposure.compensation');
      a.method = v('autoExposure.method');
      a.percentiles = [v('autoExposure.percentileLow'), v('autoExposure.percentileHigh')];
      // A mask set on the object by hand stays; the rows only choose among the metering modes that need no texture.
      a.metering = v('autoExposure.metering');
      a.spot = { x: v('autoExposure.spotX'), y: v('autoExposure.spotY'), radius: v('autoExposure.spotRadius') };
      tonemap.autoExposure = a;
    }
  }
  for (const holder of [targets.grade, targets.hueGrade]) {
    const grade = holder?.options as Record<string, unknown> | undefined;
    if (!grade) continue;
    for (const key of ['shadows', 'midtones', 'highlights', 'lift', 'gamma', 'gain'])
      grade[key] = [...(v(`grade.${key}`) as TonemapSettingColor)];
    grade.saturation = v('grade.saturation');
    grade.hueSaturation = HUES.map((hue) => v(`grade.saturation${hue}`));
  }
  const hue = targets.hueGrade?.options as Record<string, unknown> | undefined;
  if (hue) hue.hueShift = v('hue.shift');
  const local = targets.local?.options as Record<string, unknown> | undefined;
  if (local) for (const key of ['strength', 'maxStops', 'radius', 'edges']) local[key] = v(`local.${key}`);
}

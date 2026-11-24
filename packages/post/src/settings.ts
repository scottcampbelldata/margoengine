// The look controls of the post package as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings and the row shape is shared/settings.js): each row names an option, its group, kind, default,
// range, step, unit, what it does and `live`. Every effect here keeps its options object and reads it each frame into a
// uniform, so `applyPostSettings` writes the options and the next frame draws them with no pipeline, buffer or texture made:
// keyed over a shot the rows are the film's lens and glow controls. The few that make GPU objects (the bloom's first move off
// the equal-weights radius, the motion blur's tile size, the multi-bounce history of SSGI, the DOF's attach-time options) are `live: false`.
// Named looks in `POST_LOOKS` are only values of these rows. Exposure, white balance, the grade, vignette, grain, dither and
// chromatic aberration are options of Tonemap, so they are rows of `@margoengine/tonemap/settings`.
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

/** A colour value: linear RGB. */
export type PostSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, a choice, or null where `nullable`. */
export type PostSettingValue = number | string | PostSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type PostSettingValues = Readonly<Record<string, PostSettingValue>>;
/** The panel a setting sits in: one per effect. */
export type PostSettingGroup =
  | 'bloom'
  | 'lens'
  | 'lensFlare'
  | 'anamorphic'
  | 'motionBlur'
  | 'dof'
  | 'gtao'
  | 'ssao'
  | 'ssgi'
  | 'ssr'
  | 'contactShadows'
  | 'heatHaze'
  | 'smaa';
/** One control: the shared row shape with the post groups. */
export interface PostSetting extends SettingRow {
  readonly group: PostSettingGroup;
  readonly default: PostSettingValue;
}
/** Anything with the options object an effect keeps and reads each frame (Bloom, Lens, GTAO, DOF and the rest). */
export interface PostSettingTarget {
  readonly options: object;
}
/** The effects the rows write: each row needs the one named by its group (`bloom.*` needs `bloom`). */
export interface PostSettingTargets {
  bloom?: PostSettingTarget;
  lens?: PostSettingTarget;
  lensFlare?: PostSettingTarget;
  anamorphic?: PostSettingTarget;
  motionBlur?: PostSettingTarget;
  /** A `DOF` from `@margoengine/dof`. */
  dof?: PostSettingTarget;
  gtao?: PostSettingTarget;
  ssao?: PostSettingTarget;
  ssgi?: PostSettingTarget;
  ssr?: PostSettingTarget;
  contactShadows?: PostSettingTarget;
  /** A `HeatHaze` from `@margoengine/post/heat-haze`. */
  heatHaze?: PostSettingTarget;
  smaa?: PostSettingTarget;
}

const n = (
  name: string,
  group: PostSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): PostSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as PostSetting;
const nullable = (row: PostSetting, about: string): PostSetting => ({ ...row, default: null, nullable: true, about });
const onOff = (name: string, group: PostSettingGroup, about: string) =>
  choiceSetting(name, group, ['on', 'off'], about) as PostSetting;
const pick = (name: string, group: PostSettingGroup, choices: string[], about: string, live = true) =>
  choiceSetting(name, group, choices, about, live) as PostSetting;
const OFF = 'Off passes the frame through from the next frame; on is the default.';

/** Every post look control, in panel order. Defaults are the values the effects use without the option. */
export const POST_SETTINGS: readonly PostSetting[] = [
  n('bloom.strength', 'bloom', 0.8, 0, 4, 0.01, '', 'Share of the light above the threshold that is spread back as glow. 0 draws no glow.'),
  n('bloom.threshold', 'bloom', 1, 0, 100, 0.05, '', 'Linear brightness (brightest channel) above which a pixel glows.'),
  n('bloom.exposure', 'bloom', 0, -10, 10, 0.1, 'stops', 'Exposure applied to the glow before the display transform.'),
  n('bloom.radius', 'bloom', 0.5, 0, 1, 0.01, '', 'How far the glow spreads: 0 keeps it tight, 1 wide, 0.5 weighs every level of the chain equally. The total glow stays the same. The first move off 0.5 compiles one compute program and makes one buffer (later moves make none), so apply it once before a shot to key it.', false),
  pick('bloom.fireflies', 'bloom', ['temporal', 'karis', 'none'], "How a pixel far brighter than its neighbours glows: 'temporal' damps only a spike that was not there the frame before, 'karis' damps every spike, 'none' damps nothing."),

  onOff('lens.enabled', 'lens', OFF),
  n('lens.distortion', 'lens', 0, -1, 1, 0.01, '', 'Radial distortion: above 0 barrel (the middle bulges, the corners stay put), below 0 pincushion.'),
  n('lens.dirtIntensity', 'lens', 1, 0, 10, 0.01, '', 'Strength of the lens dirt lit by bright light; 0 skips the glow passes.'),
  n('lens.threshold', 'lens', 1, 0, 100, 0.05, '', 'Linear brightness (largest channel) above which light lights the dirt.'),

  onOff('lensFlare.enabled', 'lensFlare', OFF),
  nullable(
    n('lensFlare.intensity', 'lensFlare', 0.1, 0, 10, 0.01, '', ''),
    'Flare strength times the light strength. Null is 0.1 for the built-in flare, 1 when the flare has its own elements.',
  ),
  n('lensFlare.occlusionRadius', 'lensFlare', 12, 1, 64, 1, 'px', 'Radius, a whole number, of the disc of depth samples around the light that decides how much of it is visible.'),
  nullable(
    colorSetting('lensFlare.color', 'lensFlare', [1, 1, 1], 0, 10, '') as PostSetting,
    "Linear RGB tint of the flare. Null is the engine light's radiance for the sun and white for a point light.",
  ),

  onOff('anamorphic.enabled', 'anamorphic', OFF),
  n('anamorphic.threshold', 'anamorphic', 1.5, 0.01, 100, 0.05, '', 'Linear brightness (largest channel) where streaks start, with a soft knee of half of it below.'),
  n('anamorphic.intensity', 'anamorphic', 0.5, 0, 10, 0.01, '', 'Streak strength; 0 draws none.'),
  colorSetting('anamorphic.tint', 'anamorphic', [0.4, 0.6, 1], 0, 1, 'Linear RGB tint of the streaks (the blue of coated anamorphic glass).') as PostSetting,
  n('anamorphic.passes', 'anamorphic', 5, 1, 6, 1, '', 'Spreading passes, a whole number: streaks reach 2 (3^passes - 1) half-resolution texels each side.'),

  onOff('motionBlur.enabled', 'motionBlur', OFF),
  n('motionBlur.shutterAngle', 'motionBlur', 180, 0, 360, 1, 'deg', 'Shutter angle: the share of the frame interval the shutter stays open, angle / 360 (180 is the film standard, half a frame). 0 draws no blur.'),
  n('motionBlur.samples', 'motionBlur', 16, 2, 64, 1, '', 'Samples per pixel along the motion, a whole number.'),
  n('motionBlur.maxBlur', 'motionBlur', 32, 1, 128, 1, 'px', 'Longest blur in pixels, a whole number; also the tile size of the velocity search, so a change reallocates the tiles.', false),

  onOff('dof.enabled', 'dof', OFF),
  n('dof.focalDistance', 'dof', 5, 0.01, 100000, 0.01, 'm', 'Distance of the plane in focus along the viewing axis; it must lie beyond the focal length.'),
  nullable(
    n('dof.focalLength', 'dof', 0.05, 0.001, 10, 0.001, 'm', ''),
    'Focal length in scene units (0.05 is 50 mm in a metre scene). Null is 0.05. Not used while dof.filmGauge is set: the length then follows the camera field of view.',
  ),
  nullable(
    n('dof.filmGauge', 'dof', 36, 1, 100, 0.1, 'mm', ''),
    'Sensor size along the side dof.sensorFit names: 36 full frame, 23.6 APS-C, 17.3 Micro Four Thirds. Set, the focal length follows the camera field of view as a real lens would. Null uses dof.focalLength.',
  ),
  pick('dof.sensorFit', 'dof', ['auto', 'horizontal', 'vertical'], 'The side dof.filmGauge spans: auto is the longer side of the view.'),
  n('dof.aperture', 'dof', 2.8, 0.1, 64, 0.1, 'f/', 'Lens f-number: a smaller number blurs more.'),
  n('dof.maxRadius', 'dof', 16, 1, 32, 1, 'px', 'Largest blur disk radius in pixels, a whole number.'),
  pick('dof.temporal', 'dof', ['off', 'on'], 'Half-resolution bokeh whose taps turn every frame for TAA to average. Read when the DOF attaches, so apply it before attaching.', false),

  onOff('gtao.enabled', 'gtao', OFF),
  n('gtao.radius', 'gtao', 0.5, 0.01, 100, 0.01, 'm', 'Occlusion radius in scene units; occluders fade out from 60% of it.'),
  n('gtao.slices', 'gtao', 2, 1, 4, 1, '', 'Slice directions per pixel, a whole number. The 4 x 4 tile rotates them, so the blur averages 16 times as many.'),
  n('gtao.steps', 'gtao', 6, 1, 16, 1, '', 'Depth samples per side of each slice, a whole number.'),
  n('gtao.skyRadius', 'gtao', 0, 0, 1000, 0.1, 'm', 'Sky occlusion reach: above 0 the ambient sky light also darkens by the share of the sky each surface cannot see within this distance (streets, valleys, under eaves); an open surface reads 1. 0 is off.'),
  n('gtao.skySteps', 'gtao', 16, 1, 32, 1, '', 'Depth samples per side of each slice for the sky search, a whole number, denser near the pixel.'),

  onOff('ssao.enabled', 'ssao', OFF),
  n('ssao.radius', 'ssao', 0.5, 0.01, 100, 0.01, 'm', 'Sampling hemisphere radius in scene units.'),
  n('ssao.bias', 'ssao', 0.025, 0, 100, 0.005, 'm', 'Depth bias against self-occlusion; at most ssao.radius.'),
  n('ssao.samples', 'ssao', 32, 1, 32, 1, '', 'Kernel points per pixel, a whole number.'),

  onOff('ssgi.enabled', 'ssgi', OFF),
  n('ssgi.rays', 'ssgi', 4, 1, 16, 1, '', 'Rays per pixel, a whole number. The 4 x 4 tile spreads 16 times as many directions, which the blur averages.'),
  n('ssgi.maxDistance', 'ssgi', 10, 0.1, 1000, 0.1, 'm', 'Longest ray in scene units; hits fade out over the last 20%.'),
  n('ssgi.thickness', 'ssgi', 0.5, 0.01, 100, 0.01, 'm', 'Scene units a ray may pass behind the depth buffer and still count as a hit.'),
  n('ssgi.steps', 'ssgi', 32, 1, 256, 1, '', 'Hierarchical-depth march iterations per ray, a whole number.'),
  n('ssgi.intensity', 'ssgi', 1, 0, 4, 0.01, '', 'Scale of the change: 1 replaces the ambient light where rays hit with the light they hit.'),
  pick('ssgi.multiBounce', 'ssgi', ['off', 'on'], 'More than one bounce, accumulated over frames. Turning it on or off allocates or frees the history.', false),

  onOff('ssr.enabled', 'ssr', OFF),
  n('ssr.maxRoughness', 'ssr', 0.6, 0.01, 1, 0.01, '', 'Surfaces rougher than this (perceptual) get no screen-space reflection; it fades out from half of it.'),
  n('ssr.thickness', 'ssr', 0.5, 0.01, 100, 0.01, 'm', 'Scene units a ray may pass behind the depth buffer and still count as a hit.'),
  n('ssr.maxDistance', 'ssr', 100, 0.1, 10000, 0.1, 'm', 'Longest reflection ray in scene units; hits fade out over the last 20%.'),
  n('ssr.steps', 'ssr', 64, 1, 256, 1, '', 'Hierarchical-depth march iterations per pixel, a whole number.'),
  pick('ssr.stochastic', 'ssr', ['off', 'on'], 'Rough reflections traced as one sampled ray per pixel per frame and averaged over frames. Turning it on or off allocates or frees the history.', false),

  onOff('contactShadows.enabled', 'contactShadows', OFF),
  n('contactShadows.distance', 'contactShadows', 0.4, 0.01, 100, 0.01, 'm', 'How far each ray reaches toward the light.'),
  n('contactShadows.thickness', 'contactShadows', 0.2, 0.01, 100, 0.01, 'm', 'How thick a surface counts as; larger joins gaps and can shade behind thin objects.'),
  n('contactShadows.strength', 'contactShadows', 0.7, 0, 1, 0.01, '', 'Share of the light a contact removes.'),
  n('contactShadows.steps', 'contactShadows', 16, 1, 64, 1, '', 'March steps per pixel, a whole number.'),

  onOff('heatHaze.enabled', 'heatHaze', OFF),
  n('heatHaze.strength', 'heatHaze', 1, 0, 100, 0.1, '', 'The bend of the light by the hot plumes as a multiple of the physical (Gladstone-Dale refraction of air at the plume temperatures): 1 is real hot air, about a pixel at a telephoto field of view; 0 draws none.'),
  n('heatHaze.turbulence', 'heatHaze', 0.4, 0, 1, 0.01, '', 'Root-mean-square temperature fluctuation of the eddies over the mean rise (0.4 measured on plume axes); 0 leaves only the steady bend of the mean plume.'),
  n('heatHaze.ambient', 'heatHaze', 293.15, 200, 340, 0.5, 'K', 'Temperature of the air around the plumes: colder air makes the hot plume bend light more.'),
  n('heatHaze.steps', 'heatHaze', 24, 4, 64, 1, '', 'Least march steps through each plume, a whole number; where the plume is narrow along a ray it takes two a half-width, up to 4 times as many.'),

  onOff('smaa.enabled', 'smaa', OFF),
  pick('smaa.quality', 'smaa', ['high', 'low', 'medium', 'ultra'], 'Preset of the edge threshold, search steps and corner rounding: low 0.15 and 4, medium 0.1 and 8, high 0.1 and 16, ultra 0.05 and 32.'),
  pick('smaa.edgeDetection', 'smaa', ['luma', 'color'], 'Compare the luma of the display-encoded colour, or the largest channel difference.'),
  nullable(n('smaa.threshold', 'smaa', 0.1, 0.01, 0.5, 0.01, '', ''), 'Smallest contrast between neighbours that counts as an edge. Null is the preset of smaa.quality.'),
  nullable(n('smaa.maxSearchSteps', 'smaa', 16, 1, 32, 1, '', ''), 'Search steps along an edge in each direction, a whole number. Null is the preset of smaa.quality.'),
  nullable(n('smaa.cornerRounding', 'smaa', 0.25, 0, 1, 0.01, '', ''), 'Share of the blending kept where an edge meets a real corner: 0 keeps corners sharp, 1 rounds them. Null is the preset of smaa.quality.'),
];
/** The rows that can change every frame without a rebuild. */
export const POST_LIVE_SETTINGS: readonly PostSetting[] = liveSettings(POST_SETTINGS) as PostSetting[];
const BY_NAME = settingIndex(POST_SETTINGS) as Map<string, PostSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function postSettingDefaults(): Record<string, PostSettingValue> {
  return settingDefaults(POST_SETTINGS) as Record<string, PostSettingValue>;
}
/**
 * Named looks of the lens and glow, each only values of {@link POST_SETTINGS} (a name left out keeps its default): pass one
 * to {@link applyPostSettings}, or spread it under your own values. They set looks of the effects you attached; they do not
 * attach any.
 */
export const POST_LOOKS = {
  /** Today's defaults: the effects as they draw with no options. */
  natural: {},
  /** A feature-film lens: a 180 degree shutter, a shallow f/2 focus, a tight soft glow, faint dirt and streaks. */
  cinematic: {
    'bloom.strength': 0.5,
    'bloom.threshold': 1.2,
    'bloom.radius': 0.6,
    'motionBlur.shutterAngle': 180,
    'dof.aperture': 2,
    'lens.dirtIntensity': 0.3,
    'anamorphic.intensity': 0.25,
  },
  /** A soft dreamlike glow: a wide strong bloom from low light, heavy dirt, long streaks, f/1.4. */
  dream: {
    'bloom.strength': 1.6,
    'bloom.threshold': 0.7,
    'bloom.radius': 0.9,
    'lens.dirtIntensity': 2,
    'anamorphic.intensity': 1.2,
    'anamorphic.threshold': 1,
    'dof.aperture': 1.4,
  },
  /**
   * The animatedFeature family: a gentle bloom, a 180 degree shutter, a soft focus at f/2.8, no lens dirt or distortion,
   * GTAO and SSGI on, and sky occlusion over 8 m (the large soft darkening of sky light in streets and under eaves).
   */
  animatedFeature: {
    'bloom.strength': 0.4,
    'bloom.threshold': 1,
    'bloom.radius': 0.6,
    'motionBlur.shutterAngle': 180,
    'dof.aperture': 2.8,
    'lens.dirtIntensity': 0,
    'lens.distortion': 0,
    'gtao.enabled': 'on',
    'gtao.skyRadius': 8,
    'ssgi.enabled': 'on',
  },
  /** A handheld documentary: a 90 degree shutter, a deep focus at f/8, little glow and no dirt or streaks. */
  documentary: {
    'bloom.strength': 0.2,
    'motionBlur.shutterAngle': 90,
    'dof.aperture': 8,
    'lens.dirtIntensity': 0,
    'anamorphic.intensity': 0,
  },
  /** Night lights: a low threshold so lamps glow wide, dirt lit by them, a long blue streak and a 270 degree shutter. */
  nightGlow: {
    'bloom.strength': 1.2,
    'bloom.threshold': 0.5,
    'bloom.radius': 0.75,
    'lens.dirtIntensity': 1.5,
    'lens.threshold': 0.5,
    'anamorphic.intensity': 0.8,
    'anamorphic.threshold': 0.8,
    'motionBlur.shutterAngle': 270,
  },
} as const satisfies Record<string, PostSettingValues>;
/** The name of a look in {@link POST_LOOKS}. */
export type PostLookName = keyof typeof POST_LOOKS;

// Rows that must be whole numbers, and rows written as booleans.
const WHOLE = new Set([
  'anamorphic.passes',
  'motionBlur.samples',
  'motionBlur.maxBlur',
  'dof.maxRadius',
  'gtao.slices',
  'gtao.steps',
  'gtao.skySteps',
  'ssao.samples',
  'ssgi.rays',
  'ssgi.steps',
  'ssr.steps',
  'contactShadows.steps',
  'heatHaze.steps',
  'smaa.maxSearchSteps',
  'lensFlare.occlusionRadius',
]);
const BOOLEAN = new Set(['dof.temporal', 'ssgi.multiBounce', 'ssr.stochastic']);

/**
 * Writes `values` onto the options of the effects given (a name left out takes its default), so each draws exactly that
 * state from the next frame. A null row removes the option so the effect uses its own default (a flare's built-in
 * intensity, a SMAA preset value). The effects read their options each frame; the `live: false` rows are read when the
 * effect rebuilds (see their `about`).
 * @throws TypeError for a name not in {@link POST_SETTINGS}, or a value moved off its default whose effect is not in
 * `targets`; RangeError for a value outside its row's range or kind, a whole-number row given a fraction, an
 * `ssao.bias` above `ssao.radius`, or a `dof.focalDistance` not beyond the focal length.
 * @example applyPostSettings({ bloom, dof }, POST_LOOKS.cinematic);
 */
export function applyPostSettings(targets: PostSettingTargets, values: PostSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'post', 'POST_SETTINGS in @margoengine/post/settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  for (const s of POST_SETTINGS) {
    if (!(s.name in values)) continue;
    const key = s.group as keyof PostSettingTargets;
    if (!targets[key] && !sameSettingValue(values[s.name], s.default))
      throw new TypeError(`Setting ${s.name} needs targets.${key}; pass it to applyPostSettings`);
    if (WHOLE.has(s.name) && values[s.name] !== null && !Number.isInteger(values[s.name]))
      throw new RangeError(`Invalid post setting ${s.name}; use a whole number from ${s.min} to ${s.max}`);
  }
  if ((v('ssao.bias') as number) > (v('ssao.radius') as number))
    throw new RangeError('Invalid post setting ssao.bias; use a value from 0 up to ssao.radius');
  if (
    v('dof.filmGauge') === null &&
    (v('dof.focalDistance') as number) <= ((v('dof.focalLength') as number | null) ?? 0.05)
  )
    throw new RangeError('Invalid post setting dof.focalDistance; use a distance beyond dof.focalLength');
  for (const s of POST_SETTINGS) {
    const target = targets[s.group as keyof PostSettingTargets];
    if (!target) continue;
    const o = target.options as Record<string, unknown>,
      value = v(s.name),
      key = s.name.slice(s.group.length + 1);
    if (key === 'enabled') {
      if (value === 'off') o.enabled = false;
      else delete o.enabled;
    } else if (s.name === 'motionBlur.shutterAngle') o.shutter = (value as number) / 360;
    else if (value === null) delete o[key];
    else if (BOOLEAN.has(s.name)) o[key] = value === 'on';
    else o[key] = Array.isArray(value) ? [...value] : value;
  }
}

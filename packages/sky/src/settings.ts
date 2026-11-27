// Every sky control as one machine-readable table, for sliders, panels and tools: each row names an option path, its
// group, kind, default, range, step, unit and what it does. `applySkySettings` writes a set of values onto a `Sky`, and
// onto a `Tonemap` and its `Grade` when given; the named looks in `SKY_LOOKS` are only values of these rows, so a look
// is a starting point every slider can move on from.
//
// The panels follow the industry tools' own, read as public documentation (no code): the Unreal Engine SkyAtmosphere,
// Exponential Height Fog and post-process colour grading settings, and the Unity HDRP Physically Based Sky and
// Gradient Sky volume overrides. The physics behind the air rows is cited in look.ts.
import {
  checkSettings,
  choiceSetting,
  colorSetting,
  copySettingValue,
  followsWeather,
  heldFromWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  sameSettingValue,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { sunDirectionFromAngles, type Sky, type SkyGradientStop } from './base.js';

/** A colour value: linear RGB. */
export type SkySettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, a choice, gradient stops, or null where `nullable`. */
export type SkySettingValue = number | SkySettingColor | string | readonly SkyGradientStop[] | null;
/** Values by setting name; a name left out takes its default. */
export type SkySettingValues = Readonly<Record<string, SkySettingValue>>;
/** The panel a setting sits in. */
export type SkySettingGroup =
  | 'time'
  | 'sun'
  | 'air'
  | 'clouds'
  | 'volumetric'
  | 'hurricane'
  | 'tornado'
  | 'lightning'
  | 'fog'
  | 'tint'
  | 'gradient'
  | 'disc'
  | 'glow'
  | 'exposure'
  | 'grade';
/**
 * One control: the shared row shape (`@margoengine/sky/settings` is its model) with the sky's groups, plus `live`: true
 * when it can change every frame without creating a pipeline, buffer or texture, so it can be keyed over a shot.
 * Only `model` is not live (a new model compiles the sky, fog, reflection and lighting shaders again). A live row costs
 * one compile the first time it leaves its default, and again on the way back, for these: any `look.*` or
 * `atmosphere.*` row (the air block), `groundAlbedo` (the multiple-scattering passes), and the `tonemap.temperature`,
 * `tonemap.tint`, `tonemap.contrast`, `grade.saturation`, `grade.lift`, `grade.gamma` and `grade.gain` rows (their
 * colour programs). Between two values away from the default they make no pipeline, buffer or texture, so a shot keys
 * them over a range that stays off the default.
 */
export interface SkySetting extends SettingRow {
  /**
   * The option it writes: a `Sky` option path (`hours`, `atmosphere.rayleigh`, `look.zenithColor`, `clouds.coverage`,
   * `fog.density`), `sun.mode`, `sun.azimuth` or `sun.elevation` (written as `sunDirection`), or `tonemap.*` and
   * `grade.*` for the `Tonemap` and `Grade` given to {@link applySkySettings}, or `volumetric.*` for the
   * `VolumetricClouds` (`@margoengine/sky/volumetric-clouds`) given as its `clouds` target, `hurricane.*` for its
   * `hurricane` option (written while `volumetric.type` is `'hurricane'`), `tornado.*` for the options of the `Tornado`
   * (`@margoengine/sky/tornado`, or a `TornadoCloud`'s) given as its `tornado` target, or `lightning.*` for the
   * `lightning` option of the `Weather` (`@margoengine/sky/weather`) given as its `weather` target.
   */
  readonly name: string;
  /** The panel it sits in. */
  readonly group: SkySettingGroup;
  /** The value with which the target draws exactly as it does without the option. */
  readonly default: SkySettingValue;
}
const n = (
  name: string,
  group: SkySettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): SkySetting => numberSetting(name, group, value, min, max, step, unit, about) as SkySetting;
const c = (
  name: string,
  group: SkySettingGroup,
  value: SkySettingColor,
  min: number,
  max: number,
  about: string,
): SkySetting => colorSetting(name, group, value, min, max, about) as SkySetting;
const choice = (
  name: string,
  group: SkySettingGroup,
  choices: readonly string[],
  about: string,
  live = true,
): SkySetting => choiceSetting(name, group, choices, about, live) as SkySetting;
// A row the weather's master slider drives while it is null (the shared rule).
const weatherRow = (row: SkySetting, weather: string): SkySetting => followsWeather(row, weather) as SkySetting;
// The wind vector each clouds options object was last given by the wind rows, so null rows take back only their own.
const writtenWind = new WeakMap<object, readonly [number, number]>();
// A row with no default value of its own: null leaves the option unset, so the storm takes it from maxWindRadius.
const derived = (row: SkySetting): SkySetting => ({ ...row, default: null, nullable: true }) as SkySetting;
// The hurricane objects these rows made, so a type other than 'hurricane' takes back only its own.
const writtenStorm = new WeakSet<object>();
/** Every sky control, in panel order. Defaults are the values the sky, `Tonemap` and `Grade` use without the option. */
export const SKY_SETTINGS: readonly SkySetting[] = [
  n('hours', 'time', 12, 0, 24, 0.01, 'h', "Clock: 12 is noon, 6 sunrise, 18 sunset (under sun.mode 'clock')."),
  n('timeScale', 'time', 1 / 3600, -24, 24, 1 / 3600, 'h/s', 'Clock hours per real second; 0 holds the clock.'),
  choice('sun.mode', 'sun', ['clock', 'angles'], "'clock' places the sun by hours; 'angles' by azimuth and elevation."),
  n('sun.azimuth', 'sun', 90, 0, 360, 1, 'degrees', "Compass angle of the sun under 'angles': 0 is +Z, 90 is +X."),
  n('sun.elevation', 'sun', 30, -90, 90, 0.1, 'degrees', "Height of the sun above the horizon under 'angles'."),
  n(
    'atmosphere.sunIntensity',
    'sun',
    1,
    0,
    100,
    0.01,
    '',
    'Sun strength above the air: the day sky, the disc and the engine light.',
  ),
  c(
    'atmosphere.sunColor',
    'sun',
    [1, 1, 1],
    0,
    4,
    'Sun colour above the air: tints the day sky, the disc and the engine light.',
  ),
  c(
    'atmosphere.scatteredLight',
    'sun',
    [0, 0, 0],
    0,
    4,
    'Light a low haze layer (smoke, ash, spray) scatters down, a share of the zenith sun: lights the day sky evenly.',
  ),
  c(
    'atmosphere.layerTransmittance',
    'sun',
    [1, 1, 1],
    0,
    1,
    'Direct share a low haze layer lets through straight up: the night sky, moon and clouds are seen through it.',
  ),
  n(
    'atmosphere.fireSight',
    'sun',
    0,
    0,
    1e6,
    1,
    'm',
    'How far across a low ray sees the haze layer the fires light, through the smoke: 0 sets no limit.',
  ),
  choice(
    'model',
    'air',
    ['preetham', 'bruneton'],
    "Day model: 'preetham' a fit, 'bruneton' scattering whose colour follows the air.",
    false,
  ),
  n('turbidity', 'air', 2, 1, 10, 0.1, '', 'Haze: 2 is a clear day, 10 a hazy one.'),
  n(
    'atmosphere.rayleigh',
    'air',
    1,
    0,
    20,
    0.01,
    '',
    "Rayleigh scattering, a multiple of Earth's: the blue of a clear sky.",
  ),
  c(
    'atmosphere.rayleighColor',
    'air',
    [0.005802 / 0.0331, 0.013558 / 0.0331, 1],
    0,
    4,
    'What the air scatters: [0.3, 1, 0.2] is a green sky (bruneton).',
  ),
  n('atmosphere.mie', 'air', 1, 0, 50, 0.01, '', 'Haze scattering, a multiple of what turbidity gives.'),
  c('atmosphere.mieColor', 'air', [1, 1, 1], 0, 1, 'The share of each channel the haze scatters; it absorbs the rest.'),
  n('atmosphere.mieAnisotropy', 'air', 0.8, -0.95, 0.95, 0.01, '', 'How tight the glow round the sun is.'),
  n(
    'atmosphere.ozone',
    'air',
    0,
    0,
    20,
    0.01,
    '',
    "Ozone absorption, a multiple of Earth's layer: a deeper twilight blue.",
  ),
  n('groundAlbedo', 'air', 0, 0, 1, 0.01, '', 'Ground reflectance under bruneton: 0.8 snow, 0.35 sand.'),
  n(
    'clouds.coverage',
    'clouds',
    0,
    0,
    1,
    0.01,
    '',
    'Share of the sky under the cloud sheet; 0 is no sheet (the option removed).',
  ),
  n('clouds.height', 'clouds', 1500, 100, 10000, 10, 'm', 'Height of the cloud sheet.'),
  n('clouds.speed', 'clouds', 8, -100, 100, 0.5, 'm/s', 'Wind: how fast the sheet drifts.'),
  n(
    'clouds.depth',
    'clouds',
    20,
    1,
    200,
    0.5,
    '',
    'Optical depth of the overcast deck the sheet closes into past 80 % cover: higher is a darker, heavier overcast.',
  ),
  n('look.cloudDensity', 'clouds', 1, 0, 4, 0.01, '', 'Cloud thickness: 0 clear, above 1 heavier.'),
  c('look.cloudColor', 'clouds', [1, 1, 1], 0, 4, 'Cloud colour, a multiplier.'),
  // The volumetric layer (VolumetricClouds, given as the `clouds` target). Coverage, base, tops and density follow the
  // weather's `cloud` (the drive writes `options.weather`, which picks fair cumulus, stratus or storm) while null.
  weatherRow(
    n(
      'volumetric.coverage',
      'volumetric',
      0.5,
      0,
      1,
      0.01,
      '',
      'Share of the sky the cloud layer covers; null follows the weather.',
    ),
    'cloud',
  ),
  weatherRow(
    n(
      'volumetric.bottom',
      'volumetric',
      1500,
      100,
      20000,
      10,
      'm',
      'Cloud base above the ground; null follows the weather.',
    ),
    'cloud',
  ),
  weatherRow(
    n(
      'volumetric.top',
      'volumetric',
      4000,
      101,
      20000,
      10,
      'm',
      'Cloud tops, above the base; null follows the weather.',
    ),
    'cloud',
  ),
  weatherRow(
    n(
      'volumetric.density',
      'volumetric',
      0.04,
      0.001,
      0.2,
      0.001,
      '1/m',
      'Extinction inside the densest cloud (cumulus 0.02 to 0.1); null follows the weather.',
    ),
    'cloud',
  ),
  choice(
    'volumetric.type',
    'volumetric',
    ['weather', 'cumulus', 'stratus', 'storm', 'hurricane'],
    "The cloud type: 'weather' lets the weather pick (fair cumulus, stratus or storm); a name forces that type's base, tops and density; 'hurricane' draws the storm of the hurricane rows (eye, eyewall, bands), 500 to 15,000 m.",
  ),
  weatherRow(
    n(
      'volumetric.windSpeed',
      'volumetric',
      10,
      0,
      100,
      0.5,
      'm/s',
      'How fast the clouds drift along the wind; null follows the weather (the drive writes the wind at the cloud height). Without either, the layer drifts at 10 m/s.',
    ),
    'wind',
  ),
  weatherRow(
    n(
      'volumetric.windDirection',
      'volumetric',
      0,
      0,
      360,
      1,
      'degrees',
      'Compass direction the clouds drift toward: 0 is +Z, 90 is +X. Null follows the weather.',
    ),
    'windDirection',
  ),
  n(
    'volumetric.steps',
    'volumetric',
    64,
    8,
    256,
    1,
    '',
    'March steps per view ray, rounded to whole: more is finer and slower.',
  ),
  n('volumetric.lightSteps', 'volumetric', 6, 1, 16, 1, '', 'Steps toward the sun from each sample, rounded to whole.'),
  n(
    'volumetric.erosion',
    'volumetric',
    1,
    0,
    2,
    0.01,
    '',
    'Amount of fine erosion on the cloud edges: 0 leaves clean rounded outlines, 2 doubles the ragged detail.',
  ),
  n(
    'volumetric.stepCap',
    'volumetric',
    150,
    10,
    10000,
    10,
    'm',
    'Longest march step near the camera; steps grow with distance.',
  ),
  n('volumetric.scale', 'volumetric', 14000, 1000, 200000, 100, 'm', 'Width of one repeat of the cloud shapes.'),
  n(
    'volumetric.evolution',
    'volumetric',
    3,
    0,
    50,
    0.1,
    'm/s',
    'How fast the shapes rise through themselves, so they change as they drift.',
  ),
  n('volumetric.maxDistance', 'volumetric', 80000, 1000, 400000, 1000, 'm', 'Furthest cloud marched.'),
  n(
    'volumetric.sunIntensity',
    'volumetric',
    0.55,
    0,
    20,
    0.05,
    '',
    "The sun's irradiance on the clouds over 4 pi, in the sky units.",
  ),
  n(
    'volumetric.groundAlbedo',
    'volumetric',
    0.2,
    0,
    1,
    0.01,
    '',
    'Ground albedo under the clouds: it lights the cloud base from below (snow 0.8).',
  ),
  choice(
    'volumetric.temporal',
    'volumetric',
    ['auto', 'on', 'off'],
    "A new march start each frame for TAA to average: 'auto' when the scene has TAA.",
  ),
  choice(
    'volumetric.dimLight',
    'volumetric',
    ['on', 'off'],
    "'on' dims the sky's sun and moon light under the deck (cloudDeckTransmittance); 'off' when cloud shadows shade.",
  ),
  // The hurricane (the clouds' `hurricane` option, while `volumetric.type` is 'hurricane'): every row live, a uniform.
  // None follows the weather: the storm makes the weather (WeatherRegions `storms`), not the other way round.
  n('hurricane.centerX', 'hurricane', 0, -1000000, 1000000, 1000, 'm', 'Storm centre along X at time 0.'),
  n('hurricane.centerZ', 'hurricane', 0, -1000000, 1000000, 1000, 'm', 'Storm centre along Z at time 0.'),
  n('hurricane.speed', 'hurricane', 0, 0, 30, 0.5, 'm/s', 'How fast the storm moves.'),
  n(
    'hurricane.heading',
    'hurricane',
    0,
    0,
    360,
    1,
    'degrees',
    'Compass direction the storm moves toward: 0 is +Z, 90 is +X.',
  ),
  n(
    'hurricane.pressureDrop',
    'hurricane',
    60,
    5,
    150,
    1,
    'hPa',
    'Central pressure below 1010 hPa: the wind (Holland 1980).',
  ),
  n('hurricane.maxWindRadius', 'hurricane', 30000, 5000, 200000, 500, 'm', 'Radius of maximum wind.'),
  n('hurricane.holland', 'hurricane', 1.5, 1, 2.5, 0.01, '', "Holland's B: higher is a sharper wind peak."),
  n('hurricane.latitude', 'hurricane', 20, 1, 60, 1, 'degrees', 'Distance from the equator: the Coriolis term.'),
  choice(
    'hurricane.hemisphere',
    'hurricane',
    ['north', 'south'],
    'North turns anticlockwise seen from above, south clockwise.',
  ),
  n(
    'hurricane.surfaceFactor',
    'hurricane',
    0.9,
    0.5,
    1,
    0.01,
    '',
    'Surface wind over the wind above the boundary layer.',
  ),
  n('hurricane.inflow', 'hurricane', 22, 0, 45, 1, 'degrees', 'How far the surface wind turns in toward the centre.'),
  n('hurricane.gustFactor', 'hurricane', 1.23, 1, 2, 0.01, '', 'Gust over the mean wind in the open storm.'),
  derived(
    n(
      'hurricane.eyeRadius',
      'hurricane',
      21000,
      1000,
      100000,
      500,
      'm',
      'Radius of the clear eye at the cloud base; null is 0.7 of maxWindRadius.',
    ),
  ),
  n('hurricane.eyeSlope', 'hurricane', 1.2, 0, 4, 0.05, '', 'Radius the eye gains per metre up: the stadium.'),
  n('hurricane.eyewallWidth', 'hurricane', 18000, 2000, 60000, 500, 'm', 'Width of the eyewall.'),
  n('hurricane.eyeCloud', 'hurricane', 0.25, 0, 1, 0.01, '', 'Low cloud on the floor of the eye.'),
  n('hurricane.outerEyewall', 'hurricane', 0, 0, 400000, 1000, 'm', 'Radius of a concentric outer eyewall; 0 none.'),
  n('hurricane.outerEyewallStrength', 'hurricane', 0.8, 0, 1, 0.01, '', 'Cloud and wind of the outer eyewall.'),
  n('hurricane.moat', 'hurricane', 0.1, 0, 1, 0.01, '', 'Cloud in the moat between the eyewall and the bands.'),
  n('hurricane.bands', 'hurricane', 3, 0, 8, 1, '', 'Number of spiral rain bands, rounded to whole.'),
  n('hurricane.bandPitch', 'hurricane', 15, 5, 40, 0.5, 'degrees', 'Angle a band crosses a circle round the centre.'),
  n('hurricane.bandWidth', 'hurricane', 14000, 2000, 80000, 500, 'm', 'Width of a band.'),
  derived(
    n(
      'hurricane.bandStart',
      'hurricane',
      75000,
      5000,
      500000,
      1000,
      'm',
      'Radius where the bands start; null is 2.5 times maxWindRadius.',
    ),
  ),
  n('hurricane.bandTop', 'hurricane', 0.6, 0.2, 1, 0.01, '', 'Top of the bands as a share of the layer.'),
  n('hurricane.bandRotation', 'hurricane', 0, 0, 360, 1, 'degrees', 'Turn of the band pattern.'),
  n(
    'hurricane.bandDrift',
    'hurricane',
    0,
    -0.01,
    0.01,
    0.0001,
    'rad/s',
    'Turn rate of the band pattern; 0 holds it still.',
  ),
  n(
    'hurricane.principalBand',
    'hurricane',
    0.5,
    0,
    1,
    0.01,
    '',
    'How much the first band is wider and reaches in to the eyewall.',
  ),
  n('hurricane.extent', 'hurricane', 350000, 20000, 1000000, 5000, 'm', 'Outer radius of the storm cloud.'),
  n('hurricane.shield', 'hurricane', 0.3, 0, 1, 0.01, '', 'Low and middle cloud between the bands.'),
  n('hurricane.canopy', 'hurricane', 0.6, 0, 1, 0.01, '', 'Cirrus canopy over the core near the tops.'),
  n('hurricane.rainMax', 'hurricane', 50, 0, 300, 1, 'mm/h', 'Peak rain rate in the eyewall.'),
  n(
    'hurricane.rainExtent',
    'hurricane',
    150000,
    10000,
    1000000,
    5000,
    'm',
    'Distance the rain falls off by 1/e outside the eyewall.',
  ),
  n(
    'hurricane.flowPeriod',
    'hurricane',
    900,
    30,
    7200,
    10,
    's',
    'Seconds between the cross-faded phases of the turning cloud.',
  ),
  n('hurricane.swirl', 'hurricane', 1, 0, 4, 0.01, '', 'Cloud turn over the wind; 0 holds the cloud still.'),
  // The tornado (`@margoengine/sky/tornado`, the `tornado` target): every row live, read each frame. None follows the
  // weather: the tornado makes the weather (WeatherRegions `storms`). The derived rows' null leaves the tornado's own rule.
  n(
    'tornado.centerX',
    'tornado',
    0,
    -1000000,
    1000000,
    10,
    'm',
    'Where the tornado stands along X at time 0 (no path).',
  ),
  n(
    'tornado.centerZ',
    'tornado',
    0,
    -1000000,
    1000000,
    10,
    'm',
    'Where the tornado stands along Z at time 0 (no path).',
  ),
  n('tornado.speed', 'tornado', 0, 0, 40, 0.5, 'm/s', 'How fast the tornado moves over the ground.'),
  n('tornado.heading', 'tornado', 0, 0, 360, 1, 'degrees', 'Compass direction it moves toward: 0 is +Z, 90 is +X.'),
  choice(
    'tornado.profile',
    'tornado',
    ['burgers-rott', 'rankine'],
    "The vortex: 'burgers-rott' (Burgers 1948, Rott 1958) or 'rankine' with the decay.",
  ),
  n(
    'tornado.pressureDrop',
    'tornado',
    80,
    1,
    150,
    1,
    'hPa',
    'Central pressure deficit: the wind and how far down the funnel reaches.',
  ),
  n('tornado.coreRadius', 'tornado', 150, 10, 2000, 5, 'm', 'Radius of maximum wind: small is a rope, large a wedge.'),
  n('tornado.decay', 'tornado', 0.6, 0.5, 1, 0.01, '', "How fast the 'rankine' wind falls outside the core, r^-decay."),
  n('tornado.cloudBase', 'tornado', 1000, 200, 3000, 10, 'm', 'Height of the supercell base.'),
  n('tornado.wallCloudDrop', 'tornado', 400, 0, 1500, 10, 'm', 'How far the wall cloud hangs below the base.'),
  n('tornado.wallCloudRadius', 'tornado', 1500, 200, 8000, 50, 'm', 'Radius of the wall cloud.'),
  n(
    'tornado.mesocycloneRadius',
    'tornado',
    3000,
    1000,
    10000,
    100,
    'm',
    'Radius of the turning base round the wall cloud.',
  ),
  n(
    'tornado.mesocycloneWind',
    'tornado',
    25,
    0,
    60,
    0.5,
    'm/s',
    "Wind of the mesocyclone at its radius: the base's turn.",
  ),
  choice(
    'tornado.rotation',
    'tornado',
    ['cyclonic', 'anticyclonic'],
    'Cyclonic turns anticlockwise seen from above, anticyclonic clockwise.',
  ),
  n('tornado.tiltX', 'tornado', 0, -3000, 3000, 10, 'm', "The funnel's foot along X from under its top."),
  n('tornado.tiltZ', 'tornado', 0, -3000, 3000, 10, 'm', "The funnel's foot along Z from under its top."),
  n('tornado.meander', 'tornado', 0, 0, 600, 5, 'm', "Sideways weave along the funnel's height (a rope's contortion)."),
  n('tornado.debrisWind', 'tornado', 35, 10, 80, 0.5, 'm/s', 'Surface wind that lofts debris.'),
  derived(
    n(
      'tornado.debrisHeight',
      'tornado',
      350,
      0,
      1000,
      5,
      'm',
      'Height of the debris cloud; null is 2 core radii plus 50 m.',
    ),
  ),
  n('tornado.debrisDensity', 'tornado', 0.6, 0, 1, 0.01, '', 'Opacity of the debris cloud.'),
  c('tornado.debrisColor', 'tornado', [0.34, 0.27, 0.2], 0, 1, 'Colour of the debris: soil, dust and plant matter.'),
  n('tornado.funnelDensity', 'tornado', 0.05, 0.002, 1, 0.001, '1/m', 'Extinction of the funnel cloud.'),
  n('tornado.wallCloudDensity', 'tornado', 0.01, 0.0005, 0.2, 0.0005, '1/m', 'Extinction of the wall cloud and base.'),
  n('tornado.inflow', 'tornado', 40, 0, 80, 1, 'degrees', 'How far the surface wind turns in toward the core.'),
  derived(
    n('tornado.updraft', 'tornado', 38, 0, 120, 0.5, 'm/s', 'Updraft in the core; null is 0.6 of the peak wind.'),
  ),
  n('tornado.gustFactor', 'tornado', 1.3, 1, 2, 0.01, '', '3 second gust over the mean wind.'),
  n('tornado.rainMax', 'tornado', 60, 0, 300, 1, 'mm/h', "Peak rain of the rear flank's curtain."),
  derived(
    n(
      'tornado.touchdown',
      'tornado',
      0,
      0,
      7200,
      1,
      's',
      'Film seconds the tornado starts to form; null is formed from the start.',
    ),
  ),
  derived(n('tornado.liftoff', 'tornado', 600, 0, 7200, 1, 's', 'Film seconds it starts to die; null never.')),
  n(
    'tornado.spinUp',
    'tornado',
    60,
    1,
    900,
    1,
    's',
    'Seconds it takes to spin up and down: the funnel lowers as it does.',
  ),
  n('tornado.turbulence', 'tornado', 0.5, 0, 1, 0.01, '', "Raggedness of the funnel's and the debris cloud's edges."),
  n(
    'tornado.flowPeriod',
    'tornado',
    20,
    2,
    600,
    1,
    's',
    'Seconds between the cross-faded phases of the turning cloud.',
  ),
  // Lightning: the `lightning` option of the Weather (its defaults are the package's own; a default leaves the option
  // unset). rate and threshold follow the weather's lightning activity (the drive writes them) until a value is given;
  // the deck's base follows the deck.
  weatherRow(
    n(
      'lightning.rate',
      'lightning',
      6,
      0,
      600,
      0.1,
      'strikes/min',
      'Strikes a minute in a full storm; null follows the weather (12 times its lightning activity). Without a drive an unset rate is 6.',
    ),
    'lightning',
  ),
  weatherRow(
    n(
      'lightning.threshold',
      'lightning',
      0.6,
      0,
      1,
      0.01,
      '',
      'Rain intensity below which no lightning strikes; null follows the weather (0: the weather sets the rate). Without a drive an unset threshold is 0.6.',
    ),
    'lightning',
  ),
  n('lightning.minDistance', 'lightning', 300, 0, 100000, 10, 'm', 'Nearest strike from the camera.'),
  n('lightning.maxDistance', 'lightning', 6000, 0, 100000, 10, 'm', 'Farthest strike from the camera.'),
  n(
    'lightning.strength',
    'lightning',
    0.35,
    0,
    100,
    0.01,
    '',
    'Brightest the whole-frame flash gets (linear light added to the frame); 0 turns the overlay off.',
  ),
  c('lightning.color', 'lightning', [0.75, 0.82, 1], 0, 4, 'Colour of the whole-frame flash.'),
  n(
    'lightning.light.scale',
    'lightning',
    1,
    0,
    1000,
    0.01,
    '',
    "Multiplies the stroke's light on the ground and the scene (1 is the measured 1.43e7 candela); the deck's flash follows it.",
  ),
  n(
    'lightning.light.height',
    'lightning',
    700,
    0,
    20000,
    10,
    'm',
    "Height of the stroke's light above the strike point.",
  ),
  c(
    'lightning.light.color',
    'lightning',
    [0.3623, 0.4973, 1],
    0.01,
    1,
    "Colour of the stroke's light: a 30,000 K channel.",
  ),
  choice(
    'lightning.light.shadow',
    'lightning',
    ['auto', 'on', 'off'],
    "The stroke's light casts shadows: 'auto' when the lights have a free shadow map, 'on' always asks (needs ClusteredOptions.shadows), 'off' none.",
  ),
  choice(
    'lightning.light.line',
    'lightning',
    ['auto', 'on', 'off'],
    "The stroke's light follows the bolt's channel as lights along it: 'auto' while a LightningBolt is attached, 'on' always (one point light where there is no channel), 'off' one point light 700 m up.",
  ),
  n(
    'lightning.light.segments',
    'lightning',
    3,
    1,
    8,
    1,
    '',
    'Lights along the channel when the light follows it; a whole number.',
  ),
  n(
    'lightning.bolt.scale',
    'lightning',
    1,
    0,
    1000,
    0.01,
    '',
    'Brightness of the drawn bolt (LightningBolt); 0 draws no bolt.',
  ),
  n(
    'lightning.bolt.width',
    'lightning',
    1.5,
    0.01,
    100,
    0.01,
    'm',
    "Width of the bolt's hot core (never under one pixel on screen).",
  ),
  n(
    'lightning.bolt.glow',
    'lightning',
    80,
    0,
    2000,
    1,
    'm',
    'Width of the glow around the channel; 0 draws the core alone.',
  ),
  n(
    'lightning.bolt.fade',
    'lightning',
    0.03,
    0.001,
    1,
    0.001,
    's',
    "Time for the hot core to fall to 1/e after a return stroke; the glow keeps the flash's 70 ms.",
  ),
  n('lightning.bolt.branching', 'lightning', 0.06, 0, 0.5, 0.005, '', 'Chance each channel point forks a branch.'),
  n(
    'lightning.bolt.spread',
    'lightning',
    50,
    5,
    85,
    1,
    'degrees',
    'Half angle of the cone each growth step is drawn in: how crooked the channel is.',
  ),
  n(
    'lightning.bolt.detail',
    'lightning',
    80,
    8,
    400,
    1,
    '',
    'Growth steps down the main channel: how fine its kinks are; a whole number.',
  ),
  n(
    'lightning.bolt.top',
    'lightning',
    1500,
    1,
    20000,
    10,
    'm',
    "Height of the channel's top above the strike; default the cloud base.",
  ),
  n('lightning.cloud.scale', 'lightning', 1, 0, 1000, 0.01, '', 'Multiplies the flash inside the cloud deck.'),
  weatherRow(
    n(
      'lightning.cloud.base',
      'lightning',
      1500,
      0,
      20000,
      10,
      'm',
      "Height of the cloud base above the strike: where the stroke's light enters the deck; null takes the deck's own.",
    ),
    'cloud',
  ),
  n('lightning.cloud.radius', 'lightning', 200, 1, 100000, 10, 'm', "Size of the flash's core inside the deck."),
  choice(
    'lightning.link.clouds',
    'lightning',
    ['on', 'off'],
    "'on' lights every cloud deck without its own flash from inside.",
  ),
  choice('lightning.link.fog', 'lightning', ['on', 'off'], "'on' lights the fog under the deck."),
  choice(
    'lightning.link.lights',
    'lightning',
    ['on', 'off'],
    "'on' lists the stroke's light in the scene's light groups, so the ground and the scene flash.",
  ),
  weatherRow(
    n(
      'lightning.hold',
      'lightning',
      0,
      0,
      1,
      0.01,
      '',
      'Holds the flash at this brightness, 0 to 1 (for a still); null lets the strikes drive it.',
    ),
    'lightning',
  ),
  n(
    'lightning.seed',
    'lightning',
    1,
    0,
    4294967295,
    1,
    '',
    'Seed of the strike generator: the same seed and times give the same storm.',
  ),
  n('fog.density', 'fog', 0.01, 0, 1, 0.0005, '1/m', 'Fog density, while the sky has fog (it needs a depth texture).'),
  n('fog.start', 'fog', 40, 0, 10000, 1, 'm', 'Distance from the camera where fog starts.'),
  n('fog.height', 'fog', 0, 0, 1, 0.001, '', 'Extra fog below y = 0, as a fraction: height fog.'),
  n('fog.scaleHeight', 'fog', 0, 0, 10000, 10, 'm', 'Height over which the haze thins by e above fog.base, integrated along each ray (0: the same at every height).'),
  n('fog.base', 'fog', 0, -1000, 10000, 1, 'm', 'World height where the haze has fog.density (with fog.scaleHeight).'),
  c(
    'fog.lightDecay',
    'fog',
    [0, 0, 0],
    0,
    2,
    "How fast the haze's light falls with depth below the eye, per unit optical depth (0: rays below the horizon keep the fog colour).",
  ),
  choice('fog.falloff', 'fog', ['exp2', 'exp'], "How fog thickens with distance: 'exp2' softer near the camera."),
  {
    ...c('fog.color', 'fog', [1, 1, 1], 0, 4, "Fixed fog colour; null takes the sky's colour in the view direction."),
    default: null,
    nullable: true,
  },
  c('look.zenithColor', 'tint', [0.25, 0.45, 1], 0, 1, 'Tint toward the zenith, at the same brightness.'),
  n('look.zenithStrength', 'tint', 0, 0, 1, 0.01, '', 'How far the zenith takes its tint.'),
  c('look.horizonColor', 'tint', [1, 0.8, 0.6], 0, 1, 'Tint at the horizon, at the same brightness.'),
  n('look.horizonStrength', 'tint', 0, 0, 1, 0.01, '', 'How far the horizon takes its tint.'),
  c('look.groundColor', 'tint', [0.3, 0.25, 0.2], 0, 1, 'Tint below the horizon, at the same brightness.'),
  n('look.groundStrength', 'tint', 0, 0, 1, 0.01, '', 'How far the ground takes its tint.'),
  {
    name: 'look.gradient',
    group: 'gradient',
    kind: 'gradient',
    default: [
      { elevation: -90, color: [0.3, 0.27, 0.24] },
      { elevation: 0, color: [0.85, 0.85, 0.9] },
      { elevation: 90, color: [0.25, 0.45, 0.9] },
    ],
    min: -90,
    max: 90,
    unit: 'degrees',
    about: '2 to 8 stops {elevation, color} at rising elevations, colours linear RGB 0 to 1.',
    live: true,
  },
  n('look.gradientStrength', 'gradient', 0, 0, 1, 0.01, '', 'How far the gradient replaces the sky.'),
  n('look.gradientIntensity', 'gradient', 1, 0, 1000, 0.01, '', 'Brightness of a gradient colour of 1, in sky units.'),
  n('look.sunDiscSize', 'disc', 1, 0.1, 20, 0.01, '', "The drawn sun disc's radius, a multiple of 0.014 rad."),
  c('look.sunDiscColor', 'disc', [1, 1, 1], 0, 4, 'Sun disc colour.'),
  n(
    'look.sunDiscSoftness',
    'disc',
    0,
    0,
    1,
    0.01,
    '',
    "Softness of the sun disc's edge: 0 is a sharp edge, 1 spreads it over the whole radius.",
  ),
  n('look.sunDiscIntensity', 'disc', 1, 0, 100, 0.01, '', 'Sun disc strength.'),
  c('look.glowColor', 'glow', [1, 0.45, 0.15], 0, 1, 'Colour of the horizon glow.'),
  n('look.glowStrength', 'glow', 0, 0, 100, 0.01, '', 'Light added along the horizon; 0 none.'),
  n('look.glowWidth', 'glow', 8, 0.5, 90, 0.5, 'degrees', 'Height of the glow band.'),
  n(
    'look.glowSunward',
    'glow',
    0.5,
    0,
    1,
    0.01,
    '',
    "0 rings the whole horizon, 1 gathers the glow on the sun's side.",
  ),
  n('exposure', 'exposure', 0, -16, 16, 0.1, 'stops', 'Brightness of the sky: its backdrop, haze and the light its map gives surfaces.'),
  n('tonemap.exposure', 'exposure', 0, -16, 16, 0.1, 'stops', 'Brightness of the whole frame (Tonemap).'),
  n(
    'tonemap.temperature',
    'grade',
    6500,
    1667,
    25000,
    50,
    'K',
    "White balance: the colour temperature of the scene's light.",
  ),
  n('tonemap.tint', 'grade', 0, -1, 1, 0.01, '', 'White balance tint: -1 green, 1 magenta.'),
  n('tonemap.contrast', 'grade', 1, 0, 4, 0.01, '', 'Contrast about 18% grey.'),
  n('grade.saturation', 'grade', 1, 0, 4, 0.01, '', 'Saturation: 0 grey, above 1 richer (Grade).'),
  c('grade.lift', 'grade', [0, 0, 0], -1, 1, 'Lift per channel: raises or lowers the blacks (Grade).'),
  c('grade.gamma', 'grade', [1, 1, 1], 0.1, 10, 'Gamma per channel: above 1 brightens the midtones (Grade).'),
  c('grade.gain', 'grade', [1, 1, 1], 0, 4, 'Gain per channel: scales the whites (Grade).'),
];
/** The rows that can change every frame (everything but `model`), for keying over a shot. */
// The fog option's keys the table writes: one per fog row.
const FOG_KEYS = SKY_SETTINGS.filter((s) => s.name.startsWith('fog.')).map((s) => s.name.slice(4));
export const SKY_LIVE_SETTINGS: readonly SkySetting[] = liveSettings(SKY_SETTINGS) as SkySetting[];
const BY_NAME = settingIndex(SKY_SETTINGS) as Map<string, SkySetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function skySettingDefaults(): Record<string, SkySettingValue> {
  return settingDefaults(SKY_SETTINGS) as Record<string, SkySettingValue>;
}
// The sun by angles, the clock held and the scattering model: the start of every look.
const held = { 'sun.mode': 'angles', timeScale: 0, model: 'bruneton' } as const;
/**
 * Named looks, each only values of {@link SKY_SETTINGS} (a name left out keeps its default), for any scene: pass one to
 * {@link applySkySettings}, or spread it under your own values. Each draws with the `bruneton` model, so the sky's `Sky`
 * needs that entry (the full `Sky` from `@margoengine/sky` has it); each but `natural` and the `animatedFeature` family
 * also holds the clock and places the sun by angles.
 */
export const SKY_LOOKS = {
  /** Today's defaults: every row at its default, as the sky draws with no settings. */
  natural: {},
  /** A clear day, the sun high: deep blue overhead, a pale haze at the horizon. */
  clearNoon: { ...held, 'sun.elevation': 65 },
  /** A full grey sheet and a white haze. */
  overcast: {
    ...held,
    'sun.elevation': 40,
    turbidity: 5,
    'atmosphere.mie': 4,
    'clouds.coverage': 1,
    'look.cloudDensity': 3,
    'look.cloudColor': [0.62, 0.64, 0.68],
    exposure: -0.3,
  },
  /** A low sun in the east, reddened by the air, a warm glow on its side. */
  sunrise: {
    ...held,
    'sun.azimuth': 90,
    'sun.elevation': 2,
    turbidity: 3,
    'look.glowStrength': 0.4,
    'look.glowSunward': 1,
    'look.glowColor': [1, 0.55, 0.3],
  },
  /** A low sun in the west, deeper reds in a hazier air. */
  sunset: {
    ...held,
    'sun.azimuth': 270,
    'sun.elevation': 1,
    turbidity: 4,
    'atmosphere.mie': 2,
    'look.glowStrength': 0.8,
    'look.glowSunward': 1,
    'look.glowColor': [1, 0.35, 0.1],
  },
  /** The sun just below the horizon: ozone's deep blue, the backdrop lifted to show it. */
  dusk: { ...held, 'sun.azimuth': 270, 'sun.elevation': -4, 'atmosphere.ozone': 1, exposure: 3 },
  /** Dark heavy cloud, a dimmed sun and a grey air. */
  storm: {
    ...held,
    'sun.elevation': 25,
    turbidity: 6,
    'atmosphere.mie': 8,
    'atmosphere.sunIntensity': 0.5,
    'atmosphere.mieColor': [0.75, 0.8, 0.78],
    'clouds.coverage': 1,
    'look.cloudDensity': 3.5,
    'look.cloudColor': [0.4, 0.42, 0.45],
    exposure: -0.5,
  },
  /** A thick bright haze that whitens the sky and softens the sun. */
  haze: { ...held, 'sun.elevation': 35, turbidity: 8, 'atmosphere.mie': 6, 'atmosphere.mieAnisotropy': 0.7 },
  /** An air that scatters green under a large pale sun. */
  greenSky: {
    ...held,
    'sun.elevation': 30,
    'atmosphere.rayleighColor': [0.3, 1, 0.2],
    'look.sunDiscSize': 2,
    'look.sunDiscColor': [1, 0.95, 0.75],
  },
  /** A sulphur-yellow air. */
  yellowSky: { ...held, 'sun.elevation': 35, 'atmosphere.rayleighColor': [1, 0.8, 0.15], 'atmosphere.mie': 3 },
  /**
   * An air that scatters red, with reddish dust that eats blue. Such air passes green and blue, so the horizon is
   * tinted back to red.
   */
  redSky: {
    ...held,
    'sun.elevation': 25,
    'atmosphere.rayleighColor': [1, 0.3, 0.15],
    'atmosphere.mie': 4,
    'atmosphere.mieColor': [1, 0.55, 0.3],
    'look.horizonColor': [1, 0.35, 0.2],
    'look.horizonStrength': 0.7,
  },
  /**
   * A low sun in a violet air, a pink horizon and a purple zenith. The air passes green, so the sun is given magenta
   * light above it to keep the glow round it pink.
   */
  purpleSky: {
    ...held,
    'sun.azimuth': 270,
    'sun.elevation': 3,
    'atmosphere.rayleighColor': [0.7, 0.3, 1],
    'atmosphere.sunColor': [1, 0.55, 1],
    'look.horizonColor': [1, 0.4, 0.8],
    'look.horizonStrength': 0.6,
    'look.glowStrength': 0.6,
    'look.glowColor': [1, 0.3, 0.6],
    'look.zenithColor': [0.5, 0.2, 1],
    'look.zenithStrength': 0.5,
  },
  /**
   * The animatedFeature family: a fuller zenith, a warm horizon tint, a larger sun disc, rounder cloud shapes (a wider
   * repeat, more march steps), a warm key and a little more colour. A family is a picture style for any hour, so it
   * holds no clock and no sun: the scene's time of day stays (KB-SCENES-NIGHTSUN1).
   */
  animatedFeature: {
    model: 'bruneton',
    'look.zenithStrength': 0.35,
    'look.horizonStrength': 0.3,
    'look.sunDiscSize': 2.2,
    'look.sunDiscSoftness': 0.6,
    'look.cloudDensity': 1.2,
    'volumetric.steps': 96,
    'volumetric.lightSteps': 8,
    'volumetric.erosion': 0.45,
    'volumetric.scale': 22000,
    'tonemap.temperature': 5800,
    'grade.saturation': 1.12,
  },
} as const satisfies Record<string, SkySettingValues>;
/** The name of a look in {@link SKY_LOOKS}. */
export type SkyLookName = keyof typeof SKY_LOOKS;
/** What {@link applySkySettings} writes to: the sky, and optionally a Tonemap and a Grade (only their options). */
export interface SkySettingTargets {
  readonly sky: Sky;
  /** A `VolumetricClouds` for the `volumetric.*` rows (only its options are written); without it they write nothing. */
  readonly clouds?: { readonly options: object };
  /** A `Weather` (`@margoengine/sky/weather`) for the `lightning.*` rows (only its options are written); without it they write nothing. */
  readonly weather?: { readonly options: object };
  readonly tonemap?: { readonly options: object };
  readonly grade?: { readonly options: object };
  /** A `Tornado` (`@margoengine/sky/tornado`) or a `TornadoCloud` for the `tornado.*` rows; without it they write nothing. */
  readonly tornado?: { readonly options: object } | { readonly tornado: { readonly options: object } };
}
// The `tornado.*` rows onto a Tornado's options. A value at its default (or null) leaves its key unset; the centre
// and motion rows write `center` and `velocity` (a `path` the tornado has stays in charge).
function applyTornado(target: Record<string, unknown>, value: (name: string) => SkySettingValue): void {
  for (const s of SKY_SETTINGS) {
    if (s.group !== 'tornado') continue;
    const key = s.name.slice(8),
      v = value(s.name);
    if (
      key === 'centerX' ||
      key === 'centerZ' ||
      key === 'speed' ||
      key === 'heading' ||
      key === 'tiltX' ||
      key === 'tiltZ'
    )
      continue;
    if (v === null || sameSettingValue(v, s.default)) delete target[key];
    else target[key] = v;
  }
  const pair = (a: string, b: string, k: string) => {
    const x = value(a) as number,
      z = value(b) as number;
    if (x === 0 && z === 0) delete target[k];
    else target[k] = [x, z];
  };
  pair('tornado.centerX', 'tornado.centerZ', 'center');
  pair('tornado.tiltX', 'tornado.tiltZ', 'tilt');
  const speed = value('tornado.speed') as number,
    heading = ((value('tornado.heading') as number) * Math.PI) / 180;
  if (speed === 0) delete target.velocity;
  else target.velocity = [Math.sin(heading) * speed, Math.cos(heading) * speed];
}
// The `lightning.*` rows onto a Weather's `lightning` option. A value at its default (or null) leaves its key unset, so the
// Weather uses its own default (and the weather drive its own numbers); a row left null hands back a key it had held.
const LIGHTNING_CHOICES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'lightning.light.shadow': { auto: undefined, on: true, off: false },
  'lightning.link.clouds': { on: undefined, off: false },
  'lightning.link.fog': { on: undefined, off: false },
  'lightning.link.lights': { on: undefined, off: false },
  'lightning.light.line': { auto: undefined, on: true, off: false },
};
function applyLightning(options: object, value: (name: string) => SkySettingValue): void {
  const o = options as { lightning?: Record<string, unknown> };
  for (const s of SKY_SETTINGS) {
    if (s.group !== 'lightning') continue;
    const path = s.name.slice(10).split('.'),
      v = value(s.name),
      choices = LIGHTNING_CHOICES[s.name],
      out: unknown = choices
        ? choices[v as string]
        : v === null || sameSettingValue(v, s.default)
          ? undefined
          : s.name === 'lightning.light.segments'
            ? Math.round(v as number)
            : copySettingValue(v),
      key = path[path.length - 1];
    let parent = o.lightning as Record<string, unknown> | undefined;
    if (out !== undefined) {
      parent = o.lightning ??= {};
      for (const step of path.slice(0, -1)) parent = (parent[step] ??= {}) as Record<string, unknown>;
      parent[key] = out;
    } else {
      for (const step of path.slice(0, -1)) parent = parent?.[step] as Record<string, unknown> | undefined;
      // A weather row left null keeps what the drive wrote; only a value this table set (held) is taken back.
      if (parent && (!s.weather || heldFromWeather(parent, key))) delete parent[key];
    }
    if (parent && s.weather) holdFromWeather(parent, key, out !== undefined);
  }
}
// The `hurricane.*` rows onto the clouds' `hurricane` option while `volumetric.type` is 'hurricane': into the options
// of a `Hurricane` given there, else into an object of these rows' own. A value at its default leaves its key unset.
const HURRICANE_DEGREES = new Set(['bandRotation']);
function applyHurricane(c: Record<string, unknown>, value: (name: string) => SkySettingValue): void {
  const now = c.hurricane as Record<string, unknown> | undefined;
  if (value('volumetric.type') !== 'hurricane') {
    if (now && writtenStorm.has(now)) delete c.hurricane;
    return;
  }
  const given = now && typeof now === 'object' && 'options' in now && typeof now.weatherAt === 'function',
    target = (given ? now.options : now && writtenStorm.has(now) ? now : {}) as Record<string, unknown>;
  if (!given && target !== now) {
    writtenStorm.add(target);
    c.hurricane = target;
  }
  const heading = ((value('hurricane.heading') as number) * Math.PI) / 180,
    speed = value('hurricane.speed') as number,
    south = value('hurricane.hemisphere') === 'south';
  for (const s of SKY_SETTINGS) {
    if (s.group !== 'hurricane') continue;
    const key = s.name.slice(10),
      v = value(s.name);
    if (key === 'centerX' || key === 'centerZ' || key === 'speed' || key === 'heading' || key === 'hemisphere')
      continue;
    if (key === 'latitude') {
      if (v === s.default && !south) delete target.latitude;
      else target.latitude = south ? -(v as number) : v;
    } else if (v === null || sameSettingValue(v, s.default)) delete target[key];
    else if (key === 'bands') target[key] = Math.round(v as number);
    else if (HURRICANE_DEGREES.has(key)) target[key] = ((v as number) * Math.PI) / 180;
    else target[key] = v;
  }
  const cx = value('hurricane.centerX') as number,
    cz = value('hurricane.centerZ') as number;
  if (cx === 0 && cz === 0) delete target.center;
  else target.center = [cx, cz];
  if (speed === 0) delete target.velocity;
  else target.velocity = [Math.sin(heading) * speed, Math.cos(heading) * speed];
}
/**
 * Writes `values` onto the targets (a name left out takes its default), so the sky shows exactly that state. A sky
 * value at its default leaves its option unset, and with every `look` and `atmosphere` value at its default those
 * options are removed, so the sky draws as one that never had them. `clouds.coverage` 0 removes the cloud sheet.
 * `fog.*` applies only while the sky has `fog` (which carries the scene depth); `tonemap.*` and `grade.*` only to the
 * targets given, which take every value. The clock is part of the state: each call sets it to `hours` (12 when left
 * out), so a panel that lets the clock run should read `sky.options.hours` back into its values first.
 * @throws TypeError for a name not in {@link SKY_SETTINGS}; RangeError for a value outside its row's range or kind.
 * @example applySkySettings({ sky }, SKY_LOOKS.sunset);
 */
export function applySkySettings(targets: SkySettingTargets, values: SkySettingValues = {}): void {
  checkSettings(BY_NAME, values, 'sky', 'SKY_SETTINGS in @margoengine/sky/settings');
  const o = targets.sky.options as Record<string, unknown>,
    value = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default),
    parts: Record<string, Record<string, unknown>> = {
      atmosphere: {},
      look: {},
      clouds: {},
      fog: {},
      tonemap: {},
      grade: {},
      volumetric: {},
    };
  for (const s of SKY_SETTINGS) {
    const v = value(s.name),
      dot = s.name.indexOf('.'),
      head = dot < 0 ? '' : s.name.slice(0, dot);
    if (head === 'sun' || head === 'lightning' || head === 'hurricane' || head === 'tornado') continue;
    if (head === 'volumetric') {
      // Null (the weather's) or the default leaves the option unset, so the layer draws as one never given it.
      if (v !== null && !sameSettingValue(v, s.default)) parts.volumetric[s.name.slice(dot + 1)] = v;
      continue;
    }
    // Tonemap and Grade take every value; the sky's parts only what moved.
    if (head) {
      if (head === 'tonemap' || head === 'grade' || !sameSettingValue(v, s.default))
        parts[head][s.name.slice(dot + 1)] = copySettingValue(v);
    } else if (sameSettingValue(v, s.default)) delete o[s.name];
    else o[s.name] = copySettingValue(v);
  }
  for (const key of ['atmosphere', 'look'])
    if (Object.keys(parts[key]).length) o[key] = parts[key];
    else delete o[key];
  if (value('clouds.coverage') === 0) delete o.clouds;
  else o.clouds = parts.clouds;
  const fog = o.fog as Record<string, unknown> | undefined;
  // Every fog row's key, not a list kept by hand: until 2026-11-27 only five were, so the scaleHeight and base rows never
  // reached the fog (KB-SKY-FOGROWS1).
  if (fog)
    for (const key of FOG_KEYS)
      if (key in parts.fog) fog[key] = parts.fog[key];
      else delete fog[key];
  if (value('sun.mode') === 'angles')
    o.sunDirection = [...sunDirectionFromAngles(value('sun.azimuth') as number, value('sun.elevation') as number)];
  else delete o.sunDirection;
  if (targets.weather) applyLightning(targets.weather.options, value);
  if (targets.tonemap) Object.assign(targets.tonemap.options, parts.tonemap);
  if (targets.grade) Object.assign(targets.grade.options, parts.grade);
  if (targets.clouds) applyHurricane(targets.clouds.options as Record<string, unknown>, value);
  if (targets.tornado) {
    const t = targets.tornado as { options?: object; tornado?: { options: object } };
    applyTornado((t.tornado?.options ?? t.options) as Record<string, unknown>, value);
  }
  if (targets.clouds) {
    const c = targets.clouds.options as Record<string, unknown>,
      v = parts.volumetric;
    let held0: readonly [number, number] | undefined;
    for (const s of SKY_SETTINGS)
      if (s.group === 'volumetric') {
        const key = s.name.slice(11);
        if (!(key in v)) {
          delete c[key];
          // Both wind rows null: a wind these rows wrote is taken back; one set any other way (the drive's) stays.
          if (
            (key === 'windSpeed' || key === 'windDirection') &&
            !('windSpeed' in v) &&
            !('windDirection' in v) &&
            c.wind === writtenWind.get(c)
          )
            delete c.wind;
        } else if (key === 'temporal') c[key] = v[key] === 'auto' ? 'auto' : v[key] === 'on';
        else if (key === 'dimLight') c[key] = v[key] === 'on';
        // The wind rows write one vector: a part left null keeps the other's held value (default wind [10, 3]).
        else if (key === 'windSpeed' || key === 'windDirection') {
          const speed = v.windSpeed as number | undefined,
            angle = v.windDirection as number | undefined,
            held = (held0 ??= (c.wind as readonly [number, number] | undefined) ?? [10, 3]),
            k = speed ?? Math.hypot(held[0], held[1]),
            a = angle === undefined ? Math.atan2(held[0], held[1]) : (angle * Math.PI) / 180;
          const wind: [number, number] = [Math.sin(a) * k, Math.cos(a) * k];
          c.wind = wind;
          writtenWind.set(c, wind);
        }
        // Step counts are whole: a value keyed between two counts takes the nearer.
        else if (key === 'steps' || key === 'lightSteps') c[key] = Math.round(v[key] as number);
        else c[key] = v[key];
      }
  }
}

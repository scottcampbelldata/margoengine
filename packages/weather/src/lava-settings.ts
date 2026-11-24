// The slider rows of lava on the shared shape (`packages/shared/settings.js`): `LAVA_SETTINGS` for `LavaFlow`. The wind
// rows follow the weather (null), a value overrides it until set back to null. Every row is live: the path, the crust,
// the fountain, the bombs and the glow are functions of the film time and the options, read anew each frame (a changed
// rheology or supply row re-solves the path on the next read, about a millisecond per thousand steps).
import { checkSettings, followsWeather, holdFromWeather, liveSettings, numberSetting, settingDefaults, settingIndex } from '../../shared/settings.js';
import type { SnowSetting, SnowSettingTarget, SnowSettingValue, SnowSettingValues } from './snow-settings.js';

const n = (name: string, group: string, value: number, min: number, max: number, step: number, unit: string, about: string) =>
  numberSetting(name, group, value, min, max, step, unit, about, true) as SnowSetting;
const follows = (row: SnowSetting, weather: string) => followsWeather(row, weather) as SnowSetting;

/** Every `LavaFlow` control, in panel order. */
export const LAVA_SETTINGS: readonly SnowSetting[] = [
  follows(n('wind', 'weather', 0, 0, 60, 0.1, 'm/s', 'Wind at 10 m carrying the clots and bombs and cooling the surface; null follows the weather.'), 'wind'),
  follows(n('windDirection', 'weather', 0, -360, 360, 1, 'degrees', 'Direction the wind blows toward: 0 is +Z, 90 is +X; null follows the weather.'), 'windDirection'),
  n('start', 'timing', 0, 0, 86400, 0.1, 's', 'Film second the vent opens.'),
  n('rise', 'timing', 60, 1, 86400, 1, 's', 'Seconds to reach the full supply.'),
  n('duration', 'timing', 3600, 0, 10000000, 1, 's', 'Seconds at the full supply.'),
  n('wane', 'timing', 300, 1, 86400, 1, 's', 'Seconds the supply takes to stop.'),
  n('effusionRate', 'flow', 20, 0.1, 10000, 0.1, 'm^3/s', 'Lava supplied at the full rate.'),
  n('width', 'flow', 12, 0.5, 2000, 0.5, 'm', 'Channel width.'),
  n('stopGraetz', 'flow', 300, 10, 3000, 1, '', 'Graetz number at which a cooling-limited flow stops (Pinkerton and Wilson 1994).'),
  n('step', 'flow', 5, 0.5, 500, 0.5, 'm', 'Length of a step of the path down the ground.'),
  n('maxLength', 'flow', 40000, 10, 200000, 10, 'm', 'Longest path.'),
  n('wander', 'flow', 0.2, 0, 20, 0.01, 'm', 'Jitter of the ground under the path, so the flow is not locked to a grid (Favalli et al. 2005).'),
  n('temperature', 'lava', 1423, 1000, 1600, 1, 'K', 'Lava temperature at the vent (1,423 K is 1,150 C).'),
  n('crustTemperature', 'lava', 1343, 900, 1500, 1, 'K', "Temperature of the crust's base (Hon et al. 1994: 1,070 C)."),
  n('solidus', 'lava', 1253, 800, 1500, 1, 'K', 'Below it the lava has given up its latent heat.'),
  n('density', 'lava', 2600, 500, 3200, 10, 'kg/m^3', 'Lava density.'),
  n('heatCapacity', 'lava', 1150, 500, 2000, 10, 'J/(kg K)', 'Specific heat.'),
  n('conductivity', 'lava', 1.5, 0.1, 5, 0.05, 'W/(m K)', 'Thermal conductivity.'),
  n('latentHeat', 'lava', 350000, 0, 1000000, 1000, 'J/kg', 'Latent heat of crystallisation.'),
  n('crystallisation', 'lava', 0.003, 0, 0.02, 0.0001, '1/K', 'Crystals grown per kelvin of cooling in the channel.'),
  n('emissivity', 'lava', 0.95, 0.5, 1, 0.01, '', 'Surface emissivity.'),
  n('viscosity', 'rheology', 300, 1, 1e9, 1, 'Pa s', 'Viscosity at the vent.'),
  n('viscosityRise', 'rheology', 0.04, 0, 0.2, 0.001, '1/K', 'Viscosity rise per kelvin of cooling (Dragoni 1989).'),
  n('yieldStrength', 'rheology', 0.01, 0, 10000, 0.01, 'Pa', 'Yield strength scale: tau = tau_0 (exp(c dT) - 1) (Dragoni 1989).'),
  n('yieldRise', 'rheology', 0.08, 0, 0.2, 0.001, '1/K', 'Yield strength rise per kelvin of cooling.'),
  n('crackTime', 'crust', 60, 1, 3600, 1, 's', 'Seconds a fresh surface takes to close its crust over to the crack share.'),
  n('crackShare', 'crust', 0.05, 0, 1, 0.01, '', 'Share of the surface left as hot cracks under a closed, moving crust (Crisp and Baloga 1990).'),
  n('crackSpeed', 'crust', 0.16, 0, 2, 0.01, 'per m/s', 'How fast lava breaks its crust open: the crust covers 0.9 exp(-crackSpeed u) (Harris and Rowland 2001).'),
  n('hotOffset', 'crust', 120, 0, 300, 1, 'K', 'How far the hottest exposed lava is below the core (Harris and Rowland 2001: 0 to 140).'),
  n('baseTemperature', 'crust', 973, 300, 1400, 1, 'K', 'Temperature under the basal crust, where the flow meets the ground.'),
  n('baseCrust', 'crust', 0.1, 0.01, 0.5, 0.01, '', 'Basal crust as a share of the sheet: thinner conducts more heat to the ground.'),
  n('groundConductivity', 'crust', 1, 0.1, 5, 0.05, 'W/(m K)', 'Ground conductivity: how fast the ground takes the heat of a stopped flow.'),
  n('leveeMax', 'flow', 0.35, 0, 1, 0.01, '', "Highest levee over the sheet, as a share of its thickness; levees rise to Hulme's (1974) yield height as the crust cools."),
  n('branchShare', 'flow', 0.7, 0, 1, 0.01, '', 'How steep a second way down must be, as a share of the steepest, to split the flow past a divide; 1 never splits.'),
  n('maxBranches', 'flow', 8, 0, 64, 1, '', 'Most splits of one flow; 0 keeps a single channel.'),
  n('joinDistance', 'flow', 1, 0, 4, 0.05, '', 'How close two arms come before they run together, a share of their half-widths summed; 0 never rejoins.'),
  n('breakoutHeight', 'flow', 0, 0, 20, 0.1, 'm', 'Inflation at which a stalled, still-fed front breaks out through a levee as a new arm; 0 never.'),
  n('roofStrength', 'flow', 1000000, 10000, 10000000, 10000, 'Pa', "Tensile strength of a tube's roof: with breakouts on, a blocked tube bursts where the backed-up lava first beats a roof's weight and strength."),
  n('tubeSlope', 'flow', 4, 0, 30, 0.1, 'degrees', 'Steepest slope a steady channel roofs over into a lava tube; 0 for no tubes.'),
  n('tubeTime', 'flow', 86400, 60, 10000000, 60, 's', 'Seconds of steady feed before a channel roofs over; inside, the lava cools by conduction only.'),
  n('skylightSpacing', 'flow', 200, 0, 100000, 1, 'm', 'Mean spacing of skylights in a roofed tube, holes showing the stream until it drains; 0 for none.'),
  n('maxRunOns', 'flow', 16, 0, 64, 1, '', 'Most times a cooled front is fed on by the tube roofed behind it; 0 stops it where the open channel stops.'),
  n('maxWidth', 'flow', 1000, 0.5, 20000, 0.5, 'm', 'Widest the sheet spreads as it slows on flats; set it to the width for one width.'),
  n('airTemperature', 'crust', 288, 220, 330, 0.1, 'K', 'Air temperature.'),
  n('fountainHeight', 'fountain', 40, 0, 1000, 1, 'm', 'Fountain height over the vent at the full supply; 0 for none.'),
  n('clotRate', 'fountain', 80, 0, 2000, 1, 'per s', 'Clots thrown by the fountain per second.'),
  n('clotSize', 'fountain', 0.08, 0.005, 2, 0.005, 'm', 'Median clot diameter.'),
  n('fountainSpread', 'fountain', 8, 0, 45, 0.5, 'degrees', "Half angle of the fountain's spread from the vertical."),
  n('bombRate', 'bombs', 2, 0, 120, 0.1, 'per min', 'Bursts of bombs per minute; 0 for none.'),
  n('bombsPerBurst', 'bombs', 12, 1, 200, 1, '', 'Bombs thrown by each burst.'),
  n('bombSpeed', 'bombs', 80, 1, 600, 1, 'm/s', 'Median launch speed.'),
  n('bombSize', 'bombs', 0.4, 0.02, 5, 0.01, 'm', 'Median bomb diameter.'),
  n('bombSpread', 'bombs', 30, 0, 80, 0.5, 'degrees', "Half angle of the bombs' spread from the vertical."),
  n('bombDensity', 'bombs', 2500, 500, 3000, 10, 'kg/m^3', 'Bomb density.'),
  n('drag', 'bombs', 0.8, 0, 2, 0.01, '', 'Drag coefficient of clots and bombs (Mastin 2001).'),
  n('bombLife', 'bombs', 600, 0, 100000, 1, 's', 'Seconds a landed bomb lies cooling before it is dropped from the draw.'),
  n('glow', 'glow', 1, 0, 100, 0.01, '', 'Multiplies the glow and the lights (1 is physical luminance over the engine sun 1).'),
  n('maxLights', 'glow', 8, 0, 64, 1, '', 'Most glow lights.'),
  n('lightRange', 'glow', 400, 1, 100000, 1, 'm', 'Range of each glow light.'),
  n('timeScale', 'timing', 1, 0, 100, 0.01, '', 'Film seconds per real second.'),
];

/** The `LavaFlow` rows that may change every frame (all of them). */
export const LAVA_LIVE_SETTINGS: readonly SnowSetting[] = liveSettings(LAVA_SETTINGS) as SnowSetting[];
const BY_NAME = settingIndex(LAVA_SETTINGS) as Map<string, SnowSetting>;

/** Every `LavaFlow` setting at its default, as a fresh object to edit. */
export function lavaSettingDefaults(): Record<string, SnowSettingValue> {
  return settingDefaults(LAVA_SETTINGS) as Record<string, SnowSettingValue>;
}

/** Named lava looks, values of {@link LAVA_SETTINGS}: pass one to {@link applyLavaSettings}. */
export const LAVA_LOOKS = {
  /** Every weather row null: the weather's wind carries the clots and bombs. */
  weather: {},
  /** A Hawaiian channel flow under a tall fountain (Kilauea 1959 and 2018 style), no bombs. */
  hawaiian: { effusionRate: 100, fountainHeight: 300, clotRate: 400, bombRate: 0, viscosity: 100 },
  /** An Etna-style flow, cooler and stiffer, under Strombolian bursts. */
  strombolian: { effusionRate: 5, temperature: 1353, viscosity: 3000, fountainHeight: 0, bombRate: 12, bombSpeed: 60, width: 6 },
  /** A slow, thick a'a flow with no fountain or bombs. */
  aa: { effusionRate: 10, temperature: 1373, viscosity: 20000, yieldStrength: 1, fountainHeight: 0, bombRate: 0, width: 30 },
  /** A Vulcanian blast throwing big blocks fast. */
  vulcanian: { effusionRate: 0.1, fountainHeight: 0, bombRate: 1, bombsPerBurst: 60, bombSpeed: 200, bombSize: 1, bombSpread: 45 },
  /** Night glow: lights at twice their physical strength. */
  night: { glow: 2, maxLights: 12 },
} as const satisfies Record<string, SnowSettingValues>;

/**
 * Writes `values` onto a `LavaFlow` (a name left out takes its default). A null wind row follows the flow's `weather`;
 * a value overrides it.
 * @throws TypeError for a name not in {@link LAVA_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyLavaSettings(lava, LAVA_LOOKS.hawaiian);
 */
export function applyLavaSettings(target: SnowSettingTarget, values: SnowSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'lava', 'LAVA_SETTINGS in @margoengine/weather/lava-settings');
  const o = target.options as Record<string, unknown>;
  for (const row of BY_NAME.values()) {
    const v = row.name in values ? values[row.name]! : (row.default as SnowSettingValue);
    if (row.nullable) holdFromWeather(o, row.name, v !== null);
    if (v === null) delete o[row.name];
    else o[row.name] = v;
  }
}

/** The values a `LavaFlow` shows now, as a panel's starting state (unset options at their defaults). */
export function lavaSettingValues(target: SnowSettingTarget): Record<string, SnowSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = lavaSettingDefaults();
  for (const name of Object.keys(v)) if (typeof o[name] === 'number') v[name] = o[name] as number;
  return v;
}

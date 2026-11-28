import { exp, ln } from '@margoengine/math/pinned';
import { iceError } from './errors.js';

const ICE_POINT = 273.15;
const STEAM_POINT = 373.15;
const ICE_DENSITY = 917;
const FUSION = 333500;
const WATER_HEAT_CAPACITY = 4180;
const VAPORIZATION = 2257000;
const WATER_VAPOUR_GAS_CONSTANT = 461.5;

interface BoundaryOptions {
  /** Area exchanging prescribed heat with other solvers in m². Defaults to 1, or the attachment area for an icicle. */
  readonly area?: number;
  /** Outer thermal boundary temperature in K. Defaults to 268.15. */
  readonly temperature?: number;
}

/** A column of lake, river or sea ice with an optional insulating snow layer. */
export interface IceSheetOptions extends BoundaryOptions {
  readonly kind: 'sheet';
  /** Starting ice thickness in metres. Defaults to 0. */
  readonly thickness?: number;
  /** Practical salinity of the underlying water. Defaults to 0 for fresh water. */
  readonly salinity?: number;
  /** Ice thermal conductivity in W/(m K). Defaults to 2.03 for near-freezing pure ice. */
  readonly conductivity?: number;
  /** Snow thickness in metres. Defaults to 0. */
  readonly snowThickness?: number;
  /** Snow thermal conductivity in W/(m K). Defaults to 0.31. */
  readonly snowConductivity?: number;
  /** Warm-side sensible heat transfer in W/(m² K). Defaults to 10. */
  readonly surfaceHeatTransfer?: number;
  /** Ocean or river heat delivered to the base of the ice in W/m². Defaults to 0. */
  readonly waterHeatFlux?: number;
}

/** A porous frost layer exchanging vapour with a film of ambient air. */
export interface IceFrostOptions extends BoundaryOptions {
  readonly kind: 'frost';
  /** Starting frost thickness in metres. Defaults to 0. */
  readonly thickness?: number;
  /** Bulk frost density in kg/m³. Defaults to 100. */
  readonly density?: number;
  /** Ambient water-vapour partial pressure in Pa. Defaults to 400. */
  readonly vapourPressure?: number;
  /** Ambient air temperature for the ideal-gas density in K. Defaults to 273.15. */
  readonly airTemperature?: number;
  /** Mass transfer coefficient in m/s. Defaults to 0.002. */
  readonly massTransfer?: number;
  /** Heat transfer coefficient in W/(m² K) for thaw. Defaults to 10. */
  readonly heatTransfer?: number;
}

/** A dripping, axisymmetric icicle with independent film and wet-tip heat transfer. */
export interface IceIcicleOptions extends BoundaryOptions {
  readonly kind: 'icicle';
  /** Radius of the wetted attachment and the initial ice in metres. Defaults to 0.005. */
  readonly radius?: number;
  /** Starting length in metres. Defaults to 0. */
  readonly length?: number;
  /** Zero-degree water supplied to the film in kg/s. Defaults to 0.00001. */
  readonly waterSupply?: number;
  /** Heat transfer coefficient at the sides in W/(m² K). Defaults to 10. */
  readonly sideHeatTransfer?: number;
  /** Heat transfer coefficient at the tip in W/(m² K). Defaults to 10. */
  readonly tipHeatTransfer?: number;
}

/** A single thermodynamic element, indexed in the order supplied to IceSolver. */
export type IceSiteOptions = IceSheetOptions | IceFrostOptions | IceIcicleOptions;

export const CONFIG_WORDS = 8;
export const GEOMETRY_WORDS = 2;
export const CHANGE_WORDS = 5;
export const ICE_THERMAL_INPUT_WORDS = 9;
export const ICE_THERMAL_OUTPUT_WORDS = 4;
export const DEFAULT_SURFACE_TRANSFER = 10;
const SHEET = 0;
const FROST = 1;
const ICICLE = 2;

function number(value: number, name: string, minimum = 0, inclusive = true): number {
  if (!Number.isFinite(value) || (inclusive ? value < minimum : value <= minimum))
    throw iceError(
      `Invalid ice ${name}. Please pass a finite value ${inclusive ? 'at least' : 'greater than'} ${minimum}.`,
    );
  return value;
}

/** Freezing temperature of freshwater or ordinary seawater at the surface in K (UNESCO 1983). */
export function iceFreezingTemperature(salinity = 0): number {
  const s = number(salinity, 'practical salinity');
  if (s > 40) throw iceError('Ice salinity exceeds the EOS-80 range. Please use a practical salinity at most 40.');
  return ICE_POINT + s * (-0.0575 + 0.001710523 * Math.sqrt(s) - 0.0002154996 * s);
}

function vapourPressure(temperature: number): number {
  return exp(9.550426 - 5723.265 / temperature + 3.53068 * ln(temperature) - 0.00728332 * temperature);
}

/** Equilibrium vapour pressure above ice in Pa (Murphy and Koop 2005, Eq. 7, 110 to 273.15 K). */
export function iceVapourPressure(temperature: number): number {
  if (!(temperature > 110 && temperature <= ICE_POINT))
    throw iceError(
      'Vapour pressure above ice is outside the fit. Please pass a temperature above 110 K through 273.15 K.',
    );
  return vapourPressure(temperature);
}

export function prepareSite(options: IceSiteOptions): {
  config: readonly number[];
  geometry: readonly number[];
  surfaceTransfer?: number;
} {
  const temperature = number(options.temperature ?? 268.15, 'temperature', 0, false);
  if (options.kind === 'sheet') {
    const area = number(options.area ?? 1, 'area', 0, false);
    const thickness = number(options.thickness ?? 0, 'thickness');
    const freezing = iceFreezingTemperature(options.salinity);
    const conductivity = number(options.conductivity ?? 2.03, 'conductivity', 0, false);
    const snow = number(options.snowThickness ?? 0, 'snow thickness');
    const snowConductivity = number(options.snowConductivity ?? 0.31, 'snow conductivity', 0, false);
    const insulation = number((conductivity / snowConductivity) * snow, 'effective snow thickness');
    const waterHeat = number(options.waterHeatFlux ?? 0, 'water heat flux', -Infinity);
    return {
      config: [SHEET, area, temperature, ICE_DENSITY, freezing, conductivity, insulation, waterHeat],
      geometry: [thickness, 0],
      surfaceTransfer:
        options.surfaceHeatTransfer === undefined
          ? undefined
          : number(options.surfaceHeatTransfer, 'surface heat transfer coefficient'),
    };
  }
  if (options.kind === 'frost') {
    const area = number(options.area ?? 1, 'area', 0, false);
    const thickness = number(options.thickness ?? 0, 'thickness');
    const density = number(options.density ?? 100, 'frost density', 0, false);
    const vapour = number(options.vapourPressure ?? 400, 'vapour pressure');
    const air = number(options.airTemperature ?? ICE_POINT, 'air temperature', 0, false);
    const massTransfer = number(options.massTransfer ?? 0.002, 'mass transfer coefficient');
    const heatTransfer = number(options.heatTransfer ?? 10, 'heat transfer coefficient');
    if (temperature <= 110) iceVapourPressure(temperature);
    return {
      config: [FROST, area, temperature, density, vapour, air, massTransfer, heatTransfer],
      geometry: [thickness, 0],
    };
  }
  if (options.kind !== 'icicle') throw iceError('Unknown ice site kind. Please use sheet, frost or icicle.');
  const radius = number(options.radius ?? 0.005, 'icicle radius', 0, false);
  const length = number(options.length ?? 0, 'icicle length');
  const area = number(options.area ?? Math.PI * radius * radius, 'area', 0, false);
  const supply = number(options.waterSupply ?? 0.00001, 'icicle water supply');
  const side = number(options.sideHeatTransfer ?? 10, 'side heat transfer coefficient');
  const tip = number(options.tipHeatTransfer ?? 10, 'tip heat transfer coefficient');
  return {
    config: [ICICLE, area, temperature, ICE_DENSITY, radius, supply, side, tip],
    geometry: [radius, length],
  };
}

function rotationArea(radius: number): number {
  return Math.PI * radius * radius;
}

/** Changes the volume of a snow-insulated slab by integrating its conductance exactly. */
function stefan(thickness: number, insulation: number, drive: number): number {
  if (drive <= -thickness * (thickness + 2 * insulation)) return 0;
  const depth = thickness + insulation;
  const next = Math.sqrt(Math.max(insulation * insulation, depth * depth + drive));
  // Difference of squares avoids rounding away small changes under a thick insulating layer.
  return Math.max(0, thickness + drive / (depth + next));
}

/** Stages the site-specific boundary update and quantities needed by the common phase budget. */
export function stageIceSite(
  config: Float64Array,
  geometry: Float64Array,
  row: number,
  temperature: number | undefined,
  vapour: number | undefined,
  heatFlux: number,
  dt: number,
  surfaceTransfer: number,
  phase: Float64Array,
  next: Float64Array,
): void {
  const base = row * CONFIG_WORDS;
  const mode = config[base]!;
  const area = config[base + 1]!;
  const boundary = temperature ?? config[base + 2]!;
  const density = config[base + 3]!;
  const a = config[base + 4]!;
  const b = config[base + 5]!;
  const c = config[base + 6]!;
  const d = config[base + 7]!;
  let thickness = geometry[row * GEOMETRY_WORDS]!;
  let length = geometry[row * GEOMETRY_WORDS + 1]!;
  let meltwater = 0;
  let freezing = ICE_POINT;
  let drainage = 0;
  if (mode === SHEET) {
    freezing = a;
    if (boundary < freezing) {
      thickness = stefan(thickness, c, (2 * b * (freezing - boundary) * dt) / (density * FUSION));
    } else if (boundary > freezing) {
      // Surface is at its freezing point during ablation. Water heat and external heat have separate budgets.
      meltwater = Math.min(thickness * area * density, (surfaceTransfer * (boundary - freezing) * area * dt) / FUSION);
      thickness = Math.max(0, thickness - meltwater / (area * density));
    }
    if (d < 0) thickness -= (d * dt) / (density * FUSION);
  } else if (mode === FROST && boundary <= ICE_POINT) {
    const airDensity = (vapour ?? a) / (WATER_VAPOUR_GAS_CONSTANT * b);
    const surfaceDensity = iceVapourPressure(boundary) / (WATER_VAPOUR_GAS_CONSTANT * boundary);
    thickness = Math.max(0, thickness + ((airDensity - surfaceDensity) * c * dt) / density);
  } else if (mode === ICICLE) {
    const supply = b * dt;
    const spread = 2 * Math.PI * thickness * length;
    const tip = rotationArea(thickness);
    const deficit = (ICE_POINT - boundary) * dt;
    if (deficit > 0) {
      const sideMass = Math.min(supply, (c * spread * deficit) / FUSION);
      const tipMass = Math.min(supply - sideMass, (d * tip * deficit) / FUSION);
      if (sideMass > 0) thickness = Math.sqrt(thickness * thickness + sideMass / (Math.PI * length * density));
      length += tipMass / (rotationArea(thickness) * density);
      drainage = supply - (sideMass + tipMass);
    } else {
      const iceMass = tip * length * density;
      const sideMelt = Math.min(iceMass, (c * spread * -deficit) / FUSION);
      const tipMelt = Math.min(iceMass - sideMelt, (d * tip * -deficit) / FUSION);
      meltwater = sideMelt + tipMelt;
      if (meltwater >= iceMass) {
        length = 0;
        thickness = a;
      } else {
        if (sideMelt > 0) thickness *= Math.sqrt(1 - sideMelt / iceMass);
        if (tipMelt > 0) length -= tipMelt / (rotationArea(thickness) * density);
      }
      drainage = supply;
    }
  } else if (mode === FROST) {
    meltwater = Math.min(thickness * area * density, (d * area * (boundary - ICE_POINT) * dt) / FUSION);
    thickness = Math.max(0, thickness - meltwater / (area * density));
  }

  const section = mode === ICICLE ? rotationArea(thickness) : area;
  const massPerMetre = section * density;
  const extent = mode === ICICLE ? length : thickness;
  const at = row * ICE_THERMAL_INPUT_WORDS;
  phase[at] = area;
  phase[at + 1] = massPerMetre;
  phase[at + 2] = massPerMetre * extent;
  phase[at + 3] = extent;
  phase[at + 4] = mode === SHEET ? Math.max(0, d) : 0;
  phase[at + 5] = heatFlux;
  phase[at + 6] = meltwater;
  phase[at + 7] = freezing;
  phase[at + 8] = drainage;
  const offset = row * CHANGE_WORDS;
  next[offset] = thickness;
  next[offset + 1] = length;
}

/** Applies the common boundary energy partition when there is no native kernel. */
export function settleIceEnergy(phase: Float64Array, row: number, dt: number, result: Float64Array): void {
  const base = row * ICE_THERMAL_INPUT_WORDS;
  const area = phase[base]!;
  const massPerMetre = phase[base + 1]!;
  const solidMass = phase[base + 2]!;
  const extent = phase[base + 3]!;
  const basalHeat = phase[base + 4]!;
  const heatFlux = phase[base + 5]!;
  const meltwater = phase[base + 6]!;
  const freezing = phase[base + 7]!;
  const drainage = phase[base + 8]!;
  const basalMelt = Math.min(solidMass, (basalHeat * area * dt) / FUSION);
  const offered = heatFlux * area * dt;
  if (!Number.isFinite(offered))
    throw iceError('Ice boundary energy exceeds numeric range. Reduce the heat flux or initial dimensions.');
  const melted = Math.min(Math.max(0, solidMass - basalMelt), offered / FUSION);
  const remaining = Math.max(0, offered - melted * FUSION);
  const liquid = meltwater + (basalMelt + melted);
  const heatToBoil = liquid * WATER_HEAT_CAPACITY * (STEAM_POINT - freezing);
  const steam = Math.min(liquid, Math.max(0, remaining - heatToBoil) / VAPORIZATION);
  const used = Math.min(offered, melted * FUSION + Math.min(remaining, heatToBoil) + steam * VAPORIZATION);
  const removed = melted + basalMelt;
  const after = removed > 0 ? Math.max(0, solidMass - removed) / massPerMetre : extent;
  const at = row * ICE_THERMAL_OUTPUT_WORDS;
  result[at] = after;
  result[at + 1] = (liquid - steam + drainage) / dt;
  result[at + 2] = steam / dt;
  result[at + 3] = used / dt;
}

/** Combines the accepted phase budget with its staged geometry. */
export function finishIceSite(config: Float64Array, row: number, result: Float64Array, next: Float64Array): void {
  const base = row * CONFIG_WORDS;
  const offset = row * CHANGE_WORDS;
  const resultOffset = row * ICE_THERMAL_OUTPUT_WORDS;
  const extent = result[resultOffset]!;
  if (config[base] === ICICLE) {
    next[offset + 1] = extent;
    if (extent === 0) next[offset] = config[base + 4]!;
  } else {
    next[offset] = extent;
  }
  next[offset + 2] = result[resultOffset + 1]!;
  next[offset + 3] = result[resultOffset + 2]!;
  next[offset + 4] = result[resultOffset + 3]!;
}

import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
import { backedFilm, type Rgb } from './ageing/optics.js';
import {
  AGEING_YEAR,
  type AgeingMetal,
  advanceAtmospheric,
  advanceFouling,
  type AtmosphericExposure,
  bounded,
  carbonateSpeed,
  corrosionRate,
  defaultMarineCurrent,
  immersionSpeed,
  METAL,
  oneMinusExp,
  unit,
  woodRates,
} from './ageing/processes.js';
import { regionWords } from './world/memory.js';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from './world/solver.js';

export { type WeatheringFilm, weatheringFilm } from './ageing/optics.js';
export { AGEING_YEAR, type AgeingMetal, atmosphericMetalLoss, type AtmosphericExposure } from './ageing/processes.js';

const F64 = Float64Array.BYTES_PER_ELEMENT;
const DAY = 86400;
const HISTORY_WORDS = 5;
const LAYOUT = 1;
const ZERO_CELL = [0, 0, 0] as const;
const DEFAULT_CURRENT = defaultMarineCurrent();
const COPPER_CARBONATE_RATIO = (0.221116 * 8960) / (2 * 0.063546 * 4000);

/** Layout-1 exposure row: K, RH, SO₂, chloride, submerged fraction, rain m/s, pH, A/m², dry recession m/s, larvae. */
export const AGEING_EXPOSURE_WORDS = 10;
/** Layout-1 state row: remaining m, loss m, coating m, inner coating m, rot activation, fouled fraction, exposure seconds. */
export const AGEING_STATE_WORDS = 7;

export type AgeingMaterial = AgeingMetal | 'wood' | 'limestone';

/** Climate and surface loading for one patch, held over each world step. */
export interface AgeingExposure extends AtmosphericExposure {
  /** Fraction of local exposure time immersed in water. Default 0. */
  readonly submerged?: number;
  /** Incident water-equivalent rainfall in m/s. Default 0.8 m/model year. */
  readonly rainfall?: number;
  /** Incident rain pH. Default 5.6. */
  readonly rainPh?: number;
  /** Corrosion current density in A/m² during immersion. Default coastal steel equivalent of 60 µm/model year. */
  readonly corrosionCurrent?: number;
  /** Separately estimated loss of limestone from dry deposition, in m/s. Default 0. */
  readonly dryRecession?: number;
  /** Relative availability of settling larvae, 0..1. Default 1. */
  readonly larvalSupply?: number;
}

/** Occupancy rates for one aggregate group of marine encrusting organisms. */
export interface FoulingRates {
  /** Recruitment per day on vacant submerged surface at full larval supply. Default 0.01. */
  readonly settlement?: number;
  /** Loss per day from occupied immersed surface. Default 0.002. */
  readonly wetRemoval?: number;
  /** Loss per day from occupied exposed surface. Default 0.05. */
  readonly dryRemoval?: number;
}

export interface AgeingPatch {
  /** Substrate. Wood uses the untreated pine sapwood fit. */
  readonly material: AgeingMaterial;
  /** Initial thickness of the patch in metres. Defaults to 0.01 for metal and 0.05 for wood or limestone. */
  readonly thickness?: number;
  /** Previously consumed thickness in metres. Default 0. That history initially counts as atmospheric attack for metal. */
  readonly initialLoss?: number;
  /** Starting wood decay activation, 0..1. Default 0. */
  readonly initialRotActivity?: number;
  /** Starting fouling coverage, 0..1. Default 0. */
  readonly initialCover?: number;
  /** Local exposure duration divided by the simulated elapsed duration. Default 1. */
  readonly exposureMultiplier?: number;
  /** Fixed climate overrides when the solver has no exposure field. */
  readonly exposure?: AgeingExposure;
  /** Optional fouling rate overrides. Immersion enables recruitment on every substrate by default. */
  readonly fouling?: FoulingRates;
  /** Copper's saturating inner layer scale, measured as consumed substrate metres. Default 8 µm. */
  readonly copperInnerScale?: number;
  /** Fraction of new corrosion product retained on the patch. Default 1. */
  readonly coatingRetention?: number;
}

export interface MaterialAgeingParams {
  /** Material patches in field row order. */
  readonly patches: readonly AgeingPatch[];
  /** Exposure used as the default for every fixed-climate patch. */
  readonly exposure?: AgeingExposure;
  /** Environmental seconds per world second. Default 1. Set {@link AGEING_YEAR} for one model year per world second. */
  readonly timeScale?: number;
}

export interface MaterialAgeingOptions {
  /** World solver ID and port prefix. Default 'ageing'. */
  readonly id?: string;
  /** Read the versioned exposure field from another solver. Default false. */
  readonly readExposure?: boolean;
}

export interface AgeingState {
  readonly remainingThickness: number;
  readonly consumedThickness: number;
  readonly coatingThickness: number;
  readonly innerCoatingThickness: number;
  readonly rotActivity: number;
  readonly fouledFraction: number;
  readonly exposureSeconds: number;
}

/** Linear base color and metallic-roughness values for a material's set() method. */
export interface AgeingAppearance {
  readonly color: Rgb;
  readonly roughness: number;
  readonly metalness: number;
}

type Climate = ReturnType<typeof packExposure>;

interface Patch {
  readonly material: AgeingMaterial;
  readonly thickness: number;
  readonly multiplier: number;
  readonly retention: number;
  readonly innerScale: number;
  readonly settlement: number;
  readonly wetRemoval: number;
  readonly dryRemoval: number;
  readonly climate: Climate;
  readonly initial: readonly number[];
  readonly transition: number;
}

interface Data {
  readonly host: SolverHost;
  readonly timeScale: number;
  readonly patches: readonly Patch[];
  readonly history: Region;
  readonly surface: Region;
}

const PALETTE = {
  steel: { base: [0.51, 0.54, 0.56], product: [0.37, 0.095, 0.028], roughness: 0.23, weathered: 0.79 },
  copper: { base: [0.94, 0.57, 0.4], product: [0.068, 0.43, 0.29], roughness: 0.28, weathered: 0.73 },
  wood: { base: [0.41, 0.23, 0.11], product: [0.12, 0.061, 0.025], roughness: 0.57, weathered: 0.89 },
  limestone: { base: [0.68, 0.62, 0.51], product: [0.47, 0.42, 0.33], roughness: 0.68, weathered: 0.9 },
} as const;

const CUPRITE = [0.51, 0.14, 0.067] as const;
const FOULING = [0.15, 0.24, 0.05] as const;

function descriptor(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, quantity, unit, kind: 'scalarSeries', centring: 'cell' });
}

function metal(material: AgeingMaterial): material is AgeingMetal {
  return material === 'steel' || material === 'copper';
}

function packExposure(exposure: AgeingExposure) {
  return [
    bounded(exposure.temperature ?? 293.15, 173.15, 373.15, 'temperature in K'),
    bounded(exposure.relativeHumidity ?? 0.7, 0, 1, 'relative humidity'),
    bounded(exposure.sulphurDioxide ?? 4, 0, 1e6, 'sulphur dioxide deposition'),
    bounded(exposure.chloride ?? 3, 0, 1e6, 'chloride deposition'),
    bounded(exposure.submerged ?? 0, 0, 1, 'immersed fraction'),
    bounded(exposure.rainfall ?? 0.8 / AGEING_YEAR, 0, 1, 'rain rate in m/s'),
    bounded(exposure.rainPh ?? 5.6, 0, 14, 'rain pH'),
    bounded(exposure.corrosionCurrent ?? DEFAULT_CURRENT, 0, 1e6, 'corrosion current density'),
    bounded(exposure.dryRecession ?? 0, 0, 1, 'dry carbonate recession'),
    bounded(exposure.larvalSupply ?? 1, 0, 1, 'larval supply'),
  ] as const;
}

/** Write one exposure row in the units and order of {@link AGEING_EXPOSURE_WORDS}. */
export function writeAgeingExposure(out: Float64Array, exposure: AgeingExposure, row = 0): void {
  if (!Number.isSafeInteger(row) || row < 0 || (row + 1) * AGEING_EXPOSURE_WORDS > out.length)
    throw new MargoError('state', 'Use an exposure row that fits in the supplied Float64Array.');
  out.set(packExposure(exposure), row * AGEING_EXPOSURE_WORDS);
}

function readExposure(values: Float64Array, offset: number): Climate {
  return packExposure({
    temperature: values[offset]!,
    relativeHumidity: values[offset + 1]!,
    sulphurDioxide: values[offset + 2]!,
    chloride: values[offset + 3]!,
    submerged: values[offset + 4]!,
    rainfall: values[offset + 5]!,
    rainPh: values[offset + 6]!,
    corrosionCurrent: values[offset + 7]!,
    dryRecession: values[offset + 8]!,
    larvalSupply: values[offset + 9]!,
  });
}

function prepare(patch: AgeingPatch, exposure: AgeingExposure): Patch {
  const material = patch.material;
  if (!Object.hasOwn(PALETTE, material))
    throw new MargoError('state', 'Choose steel, copper, wood, or limestone as the material substrate.');
  const isMetal = metal(material);
  const thickness = bounded(patch.thickness ?? (isMetal ? 0.01 : 0.05), 1e-9, 1e6, 'initial thickness');
  const loss = bounded(patch.initialLoss ?? 0, 0, thickness, 'initial consumed thickness');
  return {
    material,
    thickness,
    multiplier: bounded(patch.exposureMultiplier ?? 1, 0, 1e6, 'exposure multiplier'),
    retention: bounded(patch.coatingRetention ?? 1, 0, 1, 'product retention fraction'),
    innerScale: bounded(patch.copperInnerScale ?? 8e-6, 1e-12, 1, 'copper inner scale in metres'),
    settlement: bounded(patch.fouling?.settlement ?? 0.01, 0, 1e6, 'fouling settlement rate') / DAY,
    wetRemoval: bounded(patch.fouling?.wetRemoval ?? 0.002, 0, 1e6, 'wet fouling removal rate') / DAY,
    dryRemoval: bounded(patch.fouling?.dryRemoval ?? 0.05, 0, 1e6, 'dry fouling removal rate') / DAY,
    climate: packExposure({ ...exposure, ...patch.exposure }),
    initial: [
      isMetal ? loss : 0,
      loss,
      bounded(patch.initialCover ?? 0, 0, 1, 'initial fouling fraction'),
      bounded(patch.initialRotActivity ?? 0, 0, 1, 'initial wood decay activity'),
      0,
    ],
    transition: isMetal ? pow(20, METAL[material].exponent) : 0,
  };
}

function updatePatch(patch: Patch, climate: Climate, state: Float64Array, at: number, seconds: number): void {
  const [temperature, humidity, sulphur, chloride, wet, rain, pH, current, dry, larvae] = climate;
  const material = patch.material;
  const tC = temperature - 273.15;
  const rh = 100 * humidity;
  let loss = state[at + 1]!;
  if (metal(material) && loss < patch.thickness) {
    const prior = state[at]!;
    const annual = wet < 1 ? corrosionRate(material, tC, rh, sulphur, chloride) : 0;
    const next = advanceAtmospheric(
      prior,
      annual,
      METAL[material].exponent,
      patch.transition,
      ((1 - wet) * seconds) / AGEING_YEAR,
    );
    loss += next - prior + immersionSpeed(material, current) * (wet * seconds);
    state[at] = Math.min(patch.thickness, next);
  } else if (material === 'wood') {
    const [activation, decay] = woodRates(tC, rh);
    const hours = (seconds * (1 - wet)) / 3600;
    const active = state[at + 3]!;
    const wait = activation > 0 ? (1 - active) / activation : Infinity;
    loss += patch.thickness * decay * Math.max(0, hours - wait);
    state[at + 3] = unit(active + hours * activation);
  } else if (material === 'limestone') {
    loss += carbonateSpeed(rain, pH, dry) * (1 - wet) * seconds;
  }
  state[at + 1] = Math.min(patch.thickness, loss);
  const recruit = wet * larvae * patch.settlement;
  const remove = wet * patch.wetRemoval + (1 - wet) * patch.dryRemoval;
  state[at + 2] = advanceFouling(state[at + 2]!, recruit, remove, seconds);
  state[at + 4] += seconds;
}

function publish(patch: Patch, state: Float64Array, at: number, out: Float64Array, row: number): void {
  const offset = row * AGEING_STATE_WORDS;
  const lost = state[at + 1]!;
  const material = patch.material;
  const innerConsumed = material === 'copper' ? patch.innerScale * oneMinusExp(lost / patch.innerScale) : lost;
  const inner = metal(material) ? innerConsumed * METAL[material].oxideRatio * patch.retention : 0;
  const outer =
    material === 'copper' ? Math.max(0, lost - innerConsumed) * COPPER_CARBONATE_RATIO * patch.retention : 0;
  out[offset] = patch.thickness - lost;
  out[offset + 1] = lost;
  out[offset + 2] = inner + outer;
  out[offset + 3] = inner;
  out[offset + 4] = state[at + 3]!;
  out[offset + 5] = state[at + 2]!;
  out[offset + 6] = state[at + 4]!;
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function appearance(patch: Patch, state: AgeingState): AgeingAppearance {
  const { material } = patch;
  const { base, product, roughness, weathered } = PALETTE[material];
  const over = state.fouledFraction;
  const coating = state.coatingThickness;
  const share = metal(material)
    ? oneMinusExp(1e5 * coating)
    : oneMinusExp(state.consumedThickness / (0.1 * patch.thickness));
  const color = base.map((value, i) => {
    const pigment = product[i]!;
    let baseColor = mix(value, pigment, share);
    if (material === 'steel') baseColor = backedFilm(value, pigment, 1e5, coating);
    if (material === 'copper') {
      const inner = backedFilm(value, CUPRITE[i]!, 1e5, state.innerCoatingThickness);
      baseColor = backedFilm(inner, pigment, 1e5, Math.max(0, coating - state.innerCoatingThickness));
    }
    return unit(mix(baseColor, FOULING[i]!, over));
  }) as [number, number, number];
  return {
    color,
    roughness: mix(mix(roughness, weathered, share), 0.95, over),
    metalness: metal(material) ? (1 - share) * (1 - over) : 0,
  };
}

/** Slow material evolution on the deterministic physics world clock. */
export class MaterialAgeingSolver implements Solver<MaterialAgeingParams> {
  readonly id: string;
  /** One broadcast or one per-patch exposure row, see {@link AGEING_EXPOSURE_WORDS}. */
  readonly exposureField: FieldDescriptor;
  /** Layout-1 f64 state rows, see {@link AGEING_STATE_WORDS}. */
  readonly stateField: FieldDescriptor;
  readonly #readExposure: boolean;
  #data?: Data;

  constructor({ id = 'ageing', readExposure = false }: MaterialAgeingOptions = {}) {
    if (!id) throw new MargoError('state', 'Use a nonempty material ageing solver ID.');
    this.id = id;
    this.#readExposure = readExposure;
    this.exposureField = descriptor(
      `${id}.exposure`,
      'materialExposure',
      'K, 1, mg/(m² day), mg/(m² day), 1, m/s, pH, A/m², m/s, 1',
    );
    this.stateField = descriptor(`${id}.state`, 'materialAgeing', 'm, m, m, m, 1, 1, s');
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.stateField, access: 'write' },
        ...(this.#readExposure ? [{ field: this.exposureField, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, { patches, exposure = {}, timeScale = 1 }: MaterialAgeingParams): void {
    if (this.#data) throw new MargoError('attached', 'Create a new MaterialAgeingSolver for the next world.');
    if (!patches?.length) throw new MargoError('state', 'Add at least one material ageing patch.');
    const models = patches.map((patch) => prepare(patch, exposure));
    const scale = bounded(timeScale, 0, 1e18, 'time scale');
    const history = host.allocate('ageing-depth-and-exposure', models.length * HISTORY_WORDS * F64, 'f64', LAYOUT);
    const surface = host.allocate('ageing-surface', models.length * AGEING_STATE_WORDS * F64, 'f64', LAYOUT);
    const state = regionWords(host.memory, history) as Float64Array;
    const out = regionWords(host.memory, surface) as Float64Array;
    for (const [i, patch] of models.entries()) {
      const at = i * HISTORY_WORDS;
      state.set(patch.initial, at);
      publish(patch, state, at, out, i);
    }
    this.#data = { host, timeScale: scale, patches: models, history, surface };
  }

  step(context: StepContext, dt: number): void {
    const data = this.#live();
    const { patches, host } = data;
    const input = context.inputs.get(this.exposureField.name);
    let climates: readonly Climate[] | undefined;
    if (input) {
      const bytes = AGEING_EXPOSURE_WORDS * F64;
      const { region } = input;
      if (
        region.layout !== LAYOUT ||
        region.type !== 'f64' ||
        (region.byteLength !== bytes && region.byteLength !== bytes * patches.length)
      )
        throw new MargoError('state', 'Use one layout-1 f64 exposure row or one row for every ageing patch.');
      const rows = regionWords(host.memory, region) as Float64Array;
      climates = Array.from({ length: rows.length / AGEING_EXPOSURE_WORDS }, (_, i) =>
        readExposure(rows, i * AGEING_EXPOSURE_WORDS),
      );
    }
    const state = regionWords(host.memory, data.history) as Float64Array;
    const out = regionWords(host.memory, data.surface) as Float64Array;
    for (const [i, patch] of patches.entries()) {
      const climate = climates?.[climates.length === 1 ? 0 : i] ?? patch.climate;
      const at = i * HISTORY_WORDS;
      updatePatch(patch, climate, state, at, data.timeScale * dt * patch.multiplier);
      publish(patch, state, at, out, i);
    }
  }

  /** Copy one patch's current state. */
  read(index: number): AgeingState {
    const data = this.#live();
    this.#checkPatch(index, data.patches.length);
    const words = regionWords(data.host.memory, data.surface) as Float64Array;
    const at = index * AGEING_STATE_WORDS;
    return {
      remainingThickness: words[at]!,
      consumedThickness: words[at + 1]!,
      coatingThickness: words[at + 2]!,
      innerCoatingThickness: words[at + 3]!,
      rotActivity: words[at + 4]!,
      fouledFraction: words[at + 5]!,
      exposureSeconds: words[at + 6]!,
    };
  }

  /** Read PBR values from the material's layered reflectance and fractional surface coverage. */
  appearance(index: number): AgeingAppearance {
    const state = this.read(index);
    const patch = this.#live().patches[index]!;
    return appearance(patch, state);
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.stateField.name, region: this.#live().surface, tick, cell: ZERO_CELL }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const { history, surface } = this.#live();
    return [history, surface];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #checkPatch(index: number, count: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
      throw new MargoError('state', `Choose a material ageing patch from index 0 through ${count - 1}.`);
  }

  #live(): Data {
    if (!this.#data) throw new MargoError('state', 'Add the material ageing solver to a PhysicsWorld first.');
    return this.#data;
  }
}

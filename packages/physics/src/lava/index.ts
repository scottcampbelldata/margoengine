import { MargoError } from '@margoengine/math/errors';
import type { BedSample } from '@margoengine/math/fields';
import { ln } from '@margoengine/math/pinned';
import { BED_FIELD, BED_LAYOUT, type BedShape, bedSurface, bedVertexCount } from '../earth/bed.js';
import {
  ICE_FIELD_LAYOUT,
  ICE_HEAT_ABSORPTION_FIELD,
  ICE_HEAT_FIELD,
  ICE_MELTWATER_FIELD,
  ICE_STEAM_FIELD,
} from '../ice/index.js';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { bindLavaKernel, loadLavaBuilds, type LavaBuilds, type LavaKernel } from './kernel.js';

/** X-fast cell records backed by f64. */
export const LAVA_LAYOUT = 1;
/** Depth, bulk temperature, skin temperature, crust depth, X and Z discharge, surface altitude and areal enthalpy. */
export const LAVA_WORDS = 8;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const ICE_FEEDBACK = [ICE_HEAT_ABSORPTION_FIELD, ICE_MELTWATER_FIELD, ICE_STEAM_FIELD] as const;
type Pair = readonly [number, number];
type Grid = number | ArrayLike<number>;

/** Selects registry edges before constructing the PhysicsWorld. */
export interface LavaLoadOptions {
  /** Solver ID and field prefix. Defaults to 'lava'. */
  readonly id?: string;
  /** Geometry of a live TerrainBed. Defaults to the initial fixed bed. */
  readonly terrain?: BedShape;
  /** Adds bidirectional ICE-05 heat, meltwater and steam ports. Defaults to false. */
  readonly exchangeIce?: boolean;
  readonly signal?: AbortSignal;
}

/** Constant discharge of a natural volcanic vent, over a world-time interval. */
export interface LavaVent {
  /** X and Z cell indices. */
  readonly cell: Pair;
  /** Volumetric supply in m³/s. */
  readonly flow: number;
  /** Melt temperature in kelvin. Defaults to liquidus + 20 K. */
  readonly temperature?: number;
  /** Starts at this many simulation seconds. Defaults to zero. */
  readonly start?: number;
  /** Stops at this many simulation seconds. Defaults to continuous supply. */
  readonly end?: number;
}

/** ICE-05 contact geometry. Match the associated IceSolver site's area and field order. */
export interface LavaIceContact {
  /** X and Z cell indices. Each contact occupies a distinct lava cell. */
  readonly cell: Pair;
  /** Area in m². Defaults to spacing squared. */
  readonly area?: number;
  /** Contact reference temperature in kelvin. Defaults to 273.15 K. */
  readonly temperature?: number;
}

/** A depth-averaged lava sheet on a square-cell patch with closed lateral boundaries. */
export interface LavaOptions {
  readonly cells: Pair;
  /** Cell spacing in metres. */
  readonly spacing: number;
  /** Lower XZ corner in metres. Defaults to [0, 0]. */
  readonly origin?: Pair;
  /** Grid's reference world cell. Defaults to [0, 0, 0]. */
  readonly originCell?: Cell;
  /** Size of an origin cell in metres. Defaults to 4096. */
  readonly originCellSize?: number;
  /** Absolute ground elevation in metres in the reference cell. */
  readonly bed: Grid;
  /** Initial lava depth in metres. Defaults to zero. */
  readonly depth?: Grid;
  /** Initial bulk temperature in kelvin. Defaults to liquidus + 20 K. */
  readonly temperature?: Grid;
  /** Initial depth-integrated horizontal discharge in m²/s. Defaults to zero. */
  readonly dischargeX?: Grid;
  readonly dischargeZ?: Grid;
  /** Natural vents. Defaults to no source. Each cell has at most one vent. */
  readonly vents?: readonly LavaVent[];
  /** Ice contacts in the order of the bound ICE-05 sites. Defaults to none. */
  readonly ice?: readonly LavaIceContact[];
  /** Lava density in kg/m³. Defaults to 2600. */
  readonly density?: number;
  /** Lava specific heat in J/(kg K). Defaults to 1225. */
  readonly heatCapacity?: number;
  /** Crystallisation latent heat in J/kg. Defaults to 350000. */
  readonly latentHeat?: number;
  /** Solidus in kelvin. Defaults to 1253 K. */
  readonly solidus?: number;
  /** Liquidus in kelvin. Defaults to 1423 K. */
  readonly liquidus?: number;
  /** Plastic viscosity at the liquidus in Pa s. Defaults to 300. */
  readonly viscosity?: number;
  /** Exponential viscosity increase per kelvin of cooling below liquidus. Defaults to 0.04. */
  readonly viscosityRise?: number;
  /** Yield strength in Pa at the liquidus. Defaults to 0.01. */
  readonly yieldStrength?: number;
  /** Exponential yield strength increase per kelvin below liquidus. Defaults to 0.08. */
  readonly yieldRise?: number;
  /** Air temperature in kelvin. Defaults to 288.15 K. */
  readonly airTemperature?: number;
  /** Ground temperature in kelvin. Defaults to airTemperature. */
  readonly groundTemperature?: number;
  /** Thermal emissivity. Defaults to 0.95. */
  readonly emissivity?: number;
  /** Air convection coefficient in W/(m² K). Defaults to 20. */
  readonly convection?: number;
  /** Thermal conductivity in W/(m K). Defaults to 2. Zero insulates the flow. */
  readonly conductivity?: number;
  /** Thermal boundary-layer depth in metres. Defaults to 0.02. */
  readonly skinDepth?: number;
  /** Reference marine water surface in metres. Omit for a wholly terrestrial patch. */
  readonly seaLevel?: number;
  /** Water-side heat transfer coefficient in W/(m² K). Defaults to 250. */
  readonly waterHeatTransfer?: number;
  /** Water temperature in kelvin. Defaults to 283.15 K. */
  readonly waterTemperature?: number;
}

/** One lava cell in SI units. */
export interface LavaSample {
  readonly depth: number;
  readonly temperature: number;
  readonly surfaceTemperature: number;
  readonly crustDepth: number;
  readonly discharge: Pair;
  readonly surfaceElevation: number;
  /** Energy per horizontal area in J/m², including crystallisation latent heat. */
  readonly enthalpy: number;
}

/** Closed-patch volume and heat, plus explicit feedback and shoreline exchange. */
export interface LavaBudget {
  readonly initialVolume: number;
  readonly storedVolume: number;
  readonly suppliedVolume: number;
  readonly initialEnthalpy: number;
  readonly storedEnthalpy: number;
  readonly suppliedEnthalpy: number;
  /** Signed net heat given to air, ground and water in joules. */
  readonly environmentalHeat: number;
  /** Water-side share of environmentalHeat in joules. */
  readonly waterHeat: number;
  /** Joules accepted by the attached ice sites. */
  readonly iceHeat: number;
  /** Kilograms drained and vaporised by the attached ice sites. */
  readonly meltwater: number;
  readonly steam: number;
  /** Net change in occupied submerged volume in cubic metres. */
  readonly displacedWater: number;
}

interface IceSite {
  readonly cell: number;
  readonly area: number;
  readonly temperature: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: LavaKernel;
  readonly nx: number;
  readonly nz: number;
  readonly count: number;
  readonly origin: Pair;
  readonly cell: Cell;
  readonly spacing: number;
  readonly cellSize: number;
  readonly sites: readonly IceSite[];
  readonly lava: Region;
  readonly working: Region;
  readonly trial: Region;
  readonly bed: Region;
  readonly nextBed: Region;
  readonly model: Region;
  readonly vents: Region;
  readonly samples: Region;
  readonly deposits: Region;
  readonly sources: Region;
  readonly submerged: Region;
  readonly icePower: Region;
  readonly heatRequest: Region;
  readonly budget: Region;
  readonly nextBudget: Region;
  readonly regions: readonly Region[];
}

function scalar(label: string, value: number, lower = -Infinity, upper = Infinity): number {
  if (!Number.isFinite(value) || value < lower || value > upper)
    throw new RangeError(`Invalid lava ${label}. Use a finite SI value within its documented range.`);
  return value;
}

function positive(label: string, value: number): number {
  if (scalar(label, value) <= 0) throw new RangeError(`Invalid lava ${label}. Use a positive SI value.`);
  return value;
}

function integer(label: string, value: number, lower: number, upper = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < lower || value > upper)
    throw new RangeError(`Invalid lava ${label}. Use an integer within the grid or world-cell range.`);
  return value;
}

function mapped(value: Grid, count: number, label: string, lower = -Infinity): Float64Array {
  if (typeof value === 'number') return new Float64Array(count).fill(scalar(label, value, lower));
  if (value.length !== count) throw new RangeError(`Invalid lava ${label} layout. Use one number per cell, X fastest.`);
  return Float64Array.from(value, (v) => scalar(label, v, lower));
}

function cellIndex(nx: number, nz: number, x: number, z: number): number {
  return integer('X index', x, 0, nx - 1) + nx * integer('Z index', z, 0, nz - 1);
}

function words(state: State, region: Region): Float64Array {
  return new Float64Array(state.host.memory.buffer, region.byteOffset, region.byteLength / F64);
}

function descriptor(name: string, quantity: string, unit: string, kind: FieldDescriptor['kind']): FieldDescriptor {
  return Object.freeze({ name, quantity, unit, kind, centring: 'cell' });
}

function enthalpy(temperature: number, cp: number, latent: number, solidus: number, liquidus: number): number {
  return cp * temperature + latent * Math.max(0, Math.min(1, (temperature - solidus) / (liquidus - solidus)));
}

/** Natural lava advance, cooling, crystallisation and transport through live terrain and world ports. */
export class LavaSolver implements Solver<LavaOptions> {
  readonly lavaField: FieldDescriptor;
  /** Ground plus solid crust altitude in metres, one f64 per cell. */
  readonly depositField: FieldDescriptor;
  /** SeaSource layout-1 rows with the signed change in occupied submerged volume. */
  readonly seaSourceField: FieldDescriptor;
  private readonly terrain?: BedShape;
  private readonly fields: readonly FieldUse[];
  private state?: State;

  private constructor(
    private readonly builds: LavaBuilds,
    private readonly id: string,
    terrain: BedShape | undefined,
    private readonly exchangeIce: boolean,
  ) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim())
      throw new RangeError('Invalid lava solver ID. Use a nonempty name without outer whitespace.');
    if (terrain) {
      bedVertexCount(terrain);
      this.terrain = { ...terrain, centre: [terrain.centre[0], terrain.centre[1]] };
    }
    this.lavaField = descriptor(`${id}.state`, 'lavaFlowState', 'SI', 'uniformGrid');
    this.depositField = descriptor(`${id}.depositElevation`, 'elevation', 'm', 'uniformGrid');
    this.seaSourceField = descriptor(`${id}.seaSource`, 'seaSource', 'SI', 'scalarSeries');
    this.fields = [
      ...[this.lavaField, this.depositField, this.seaSourceField].map((field) => ({ field, access: 'write' as const })),
      ...(terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ...(exchangeIce
        ? [
            { field: ICE_HEAT_FIELD, access: 'write' as const },
            ...ICE_FEEDBACK.map((field) => ({ field, access: 'read' as const })),
          ]
        : []),
    ];
  }

  /** Loads the optional SIMD kernels. */
  static async load({ id = 'lava', terrain, exchangeIce = false, signal }: LavaLoadOptions = {}): Promise<LavaSolver> {
    return new LavaSolver(await loadLavaBuilds(signal), id, terrain, exchangeIce);
  }

  describe() {
    return { id: this.id, fields: this.fields, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, options: LavaOptions): void {
    if (this.state)
      throw new MargoError('state', 'LavaSolver is already attached. Load a new solver for a second world.');
    const nx = integer('X cell count', options.cells[0], 1);
    const nz = integer('Z cell count', options.cells[1], 1);
    const count = integer('cell count', nx * nz, 1);
    const spacing = positive('spacing', options.spacing);
    const volumeArea = positive('cell area', spacing * spacing);
    const [x, z] = options.origin ?? [0, 0];
    const origin: Pair = [scalar('X origin', x), scalar('Z origin', z)];
    scalar('X far edge', x + nx * spacing);
    scalar('Z far edge', z + nz * spacing);
    const [cx, cy, cz] = options.originCell ?? [0, 0, 0];
    const cell: Cell = [cx, cy, cz];
    for (const v of cell) integer('world cell', v, -2147483648, 2147483647);
    const cellSize = positive('origin cell size', options.originCellSize ?? 4096);

    const density = positive('density', options.density ?? 2600);
    const cp = positive('heat capacity', options.heatCapacity ?? 1225);
    const latent = scalar('latent heat', options.latentHeat ?? 350000, 0);
    const solidus = positive('solidus', options.solidus ?? 1253);
    const liquidus = positive('liquidus', options.liquidus ?? 1423);
    if (liquidus <= solidus) throw new RangeError('Invalid lava phase transition. Set liquidus above solidus.');
    positive('effective heat capacity', cp + latent / (liquidus - solidus));
    const viscosity = positive('viscosity', options.viscosity ?? 300);
    const viscosityRise = scalar('viscosity rise', options.viscosityRise ?? 0.04, 0);
    const yieldStrength = scalar('yield strength', options.yieldStrength ?? 0.01, 0);
    const yieldRise = scalar('yield rise', options.yieldRise ?? 0.08, 0);
    // The exponential only acts below the liquidus and while a cell is mobile.
    const viscLog = viscosityRise * (liquidus - solidus);
    const yieldLog = yieldRise * (liquidus - solidus);
    if (
      viscLog > 700 ||
      viscLog + ln(viscosity) > 700 ||
      (yieldStrength > 0 && (yieldLog > 700 || yieldLog + ln(yieldStrength) > 700))
    )
      throw new RangeError(
        'Lava rheology is outside the finite range. Reduce the temperature sensitivity or reference resistance.',
      );
    const air = positive('air temperature', options.airTemperature ?? 288.15);
    const ground = positive('ground temperature', options.groundTemperature ?? air);
    const emissivity = scalar('emissivity', options.emissivity ?? 0.95, 0, 1);
    const convection = scalar('convection', options.convection ?? 20, 0);
    const conductivity = scalar('conductivity', options.conductivity ?? 2, 0);
    const skin = positive('skin depth', options.skinDepth ?? 0.02);
    const waterHeat = scalar('water heat transfer', options.waterHeatTransfer ?? 250, 0);
    const sea = options.seaLevel === undefined ? -Infinity : scalar('sea level', options.seaLevel);
    const waterTemperature = positive('water temperature', options.waterTemperature ?? 283.15);
    const gravity = scalar('downward gravity', -host.gravity[1], 0);
    const params = [
      gravity,
      spacing,
      density,
      cp,
      latent,
      solidus,
      liquidus,
      viscosity,
      viscosityRise,
      yieldStrength,
      yieldRise,
      air,
      ground,
      emissivity,
      convection,
      conductivity,
      skin,
      waterHeat,
      sea,
      waterTemperature,
    ];
    const bedInitial = mapped(options.bed, count, 'bed');
    const depth = mapped(options.depth ?? 0, count, 'depth', 0);
    const temperature = mapped(options.temperature ?? liquidus + 20, count, 'temperature', Number.MIN_VALUE);
    const qx = mapped(options.dischargeX ?? 0, count, 'X discharge');
    const qz = mapped(options.dischargeZ ?? 0, count, 'Z discharge');
    const ventRows = new Float64Array(4 * count);
    const ventCells = new Set<number>();
    for (const vent of options.vents ?? []) {
      const at = cellIndex(nx, nz, vent.cell[0], vent.cell[1]);
      if (ventCells.has(at))
        throw new RangeError('Two lava vents share one cell. Use distinct source cells or sum the discharge.');
      ventCells.add(at);
      const start = scalar('vent start', vent.start ?? 0, 0);
      const end = vent.end === undefined ? Infinity : scalar('vent end', vent.end, start);
      const hot = scalar('vent temperature', vent.temperature ?? liquidus + 20, solidus);
      ventRows.set(
        [
          positive('vent discharge', vent.flow) / volumeArea,
          scalar('vent specific enthalpy', enthalpy(hot, cp, latent, solidus, liquidus), 0),
          start,
          end,
        ],
        4 * at,
      );
    }

    const iceCells = new Set<number>();
    const sites = (options.ice ?? []).map((site): IceSite => {
      const at = cellIndex(nx, nz, site.cell[0], site.cell[1]);
      if (iceCells.has(at))
        throw new RangeError('Two ice contacts share one lava cell. Use a separate cell for each ICE-05 site.');
      iceCells.add(at);
      return {
        cell: at,
        area: positive('ice contact area', site.area ?? volumeArea),
        temperature: positive('ice contact temperature', site.temperature ?? 273.15),
      };
    });
    if (this.exchangeIce !== (sites.length !== 0))
      throw new RangeError(
        'Invalid lava ice coupling. Supply one ice contact per site and enable exchangeIce together.',
      );

    const allocate = (name: string, length: number, layout = LAVA_LAYOUT) =>
      host.allocate(name, F64 * length, 'f64', layout);
    const kernel = bindLavaKernel(host, this.builds);
    const lava = allocate('lava-state', 4 * count);
    const working = allocate('lava-working', 4 * count);
    const trial = allocate('lava-trial', 4 * count);
    const bed = allocate('lava-bed', count, BED_LAYOUT);
    const nextBed = allocate('lava-next-bed', count, BED_LAYOUT);
    const model = allocate('lava-properties', params.length);
    const vents = allocate('lava-vents', ventRows.length);
    const samples = allocate('lava-grid', LAVA_WORDS * count);
    const deposits = allocate('lava-deposits', count, BED_LAYOUT);
    const sources = allocate('lava-marine-displacement', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT);
    const submerged = allocate('lava-submerged', count);
    const icePower = allocate('lava-ice-cooling', count);
    const heatRequest = allocate('lava-ice-heat-flux', Math.max(sites.length, 1), ICE_FIELD_LAYOUT);
    const budget = allocate('lava-budget', 12);
    const nextBudget = allocate('lava-next-budget', 12);

    const s: State = {
      host,
      kernel,
      nx,
      nz,
      count,
      origin,
      cell,
      spacing,
      cellSize,
      sites,
      lava,
      working,
      trial,
      bed,
      nextBed,
      model,
      vents,
      samples,
      deposits,
      sources,
      submerged,
      icePower,
      heatRequest,
      budget,
      nextBudget,
      regions: [lava, bed, model, vents, samples, deposits, sources, submerged, heatRequest, budget],
    };
    this.state = s;
    words(s, model).set(params);
    words(s, bed).set(bedInitial);
    words(s, vents).set(ventRows);
    const columns = words(s, lava);
    for (let i = 0; i < count; i++) {
      const h = depth[i]!;
      const hot = temperature[i]!;
      const mobile = h > 0 && hot > solidus;
      columns.set(
        [
          h,
          mobile ? qx[i]! : 0,
          mobile ? qz[i]! : 0,
          scalar('initial enthalpy', h * enthalpy(hot, cp, latent, solidus, liquidus), 0),
        ],
        4 * i,
      );
    }
    this.publish(s, 1);
    const b = words(s, budget);
    b[8] = b[6]!;
    b[9] = b[7]!;
  }

  private live(): State {
    if (!this.state)
      throw new MargoError('state', 'LavaSolver is unattached. Add it to a PhysicsWorld and initialise it.');
    return this.state;
  }

  private prepareBed(s: State, context: StepContext): void {
    const out = words(s, s.nextBed);
    out.set(words(s, s.bed));
    if (!this.terrain) return;
    const port = context.inputs.get(BED_FIELD.name);
    if (!port || port.region.layout !== BED_LAYOUT || port.region.type !== 'f32')
      throw new RangeError('Invalid lava terrain layout. Use the matching TerrainBed geometry.');
    const values = regionWords(s.host.memory, port.region);
    if (values.length !== bedVertexCount(this.terrain))
      throw new RangeError('Invalid lava terrain extent. Use the registered TerrainBed geometry.');
    const bed = bedSurface(this.terrain, values, port.cell);
    const point: BedSample = { elevation: 0, normal: [0, 1, 0] };
    const dx = (s.cell[0] - port.cell[0]) * s.cellSize;
    const dy = (s.cell[1] - port.cell[1]) * s.cellSize;
    const dz = (s.cell[2] - port.cell[2]) * s.cellSize;
    for (let z = 0; z < s.nz; z++) {
      for (let x = 0; x < s.nx; x++) {
        bed.sample(s.origin[0] + (x + 0.5) * s.spacing + dx, s.origin[1] + (z + 0.5) * s.spacing + dz, point);
        out[x + s.nx * z] = scalar('live bed elevation', point.elevation - dy);
      }
    }
  }

  private receiveIce(s: State, context: StepContext, dt: number): void {
    const power = words(s, s.icePower);
    power.fill(0);
    if (!this.exchangeIce) return;
    const input = ICE_FEEDBACK.map((field) => {
      const r = context.inputs.get(field.name)?.region;
      if (!r || r.layout !== ICE_FIELD_LAYOUT || r.type !== 'f64' || r.byteLength !== F64 * s.sites.length)
        throw new RangeError(`Invalid lava ice feedback ${field.name}. Use one layout-1 f64 per ICE-05 site.`);
      return regionWords(s.host.memory, r);
    });
    const want = words(s, s.heatRequest);
    const b = words(s, s.nextBudget);
    for (const [i, site] of s.sites.entries()) {
      const absorbed = scalar('absorbed ice power', input[0]![i]!, 0);
      const offered = want[i]! * site.area;
      // Allow only the roundoff of reversing ICE-05's area and time conversion.
      if (absorbed - offered > 16 * Number.EPSILON * Math.max(absorbed, offered))
        throw new RangeError(
          'Ice accepted more heat than lava offered. Use matching contact areas and staggered exchange.',
        );
      power[site.cell] = absorbed;
      b[10]! += scalar('ice meltwater rate', input[1]![i]!, 0) * dt;
      b[11]! += scalar('ice steam rate', input[2]![i]!, 0) * dt;
    }
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    words(s, s.working).set(words(s, s.lava));
    words(s, s.nextBudget).set(words(s, s.budget));
    this.prepareBed(s, context);
    this.receiveIce(s, context, dt);
    const result = s.kernel.lava_step(
      s.working.byteOffset,
      s.trial.byteOffset,
      s.nextBed.byteOffset,
      s.vents.byteOffset,
      s.model.byteOffset,
      s.nx,
      s.nz,
      s.icePower.byteOffset,
      s.nextBudget.byteOffset,
      dt,
      context.tick * dt,
    );
    if (result !== 0)
      throw new RangeError(
        'Lava update exceeded its heat or flux bounds. Use finite physical grid, coupling and source scales.',
      );
    words(s, s.lava).set(words(s, s.working));
    words(s, s.bed).set(words(s, s.nextBed));
    words(s, s.budget).set(words(s, s.nextBudget));
    this.publish(s, 0, dt);
  }

  private publish(s: State, initial: number, dt = 1 / 60): void {
    s.kernel.lava_publish(
      s.lava.byteOffset,
      s.bed.byteOffset,
      s.model.byteOffset,
      s.samples.byteOffset,
      s.deposits.byteOffset,
      s.sources.byteOffset,
      s.submerged.byteOffset,
      s.nx,
      s.nz,
      s.origin[0],
      s.origin[1],
      s.budget.byteOffset,
      initial,
    );
    const values = words(s, s.samples);
    const props = words(s, s.model);
    const out = words(s, s.heatRequest);
    for (const [i, site] of s.sites.entries()) {
      const at = site.cell * LAVA_WORDS;
      const potential = (props[15]! / (props[16]! + values[at + 3]!)) * (values[at + 1]! - site.temperature);
      const energy = values[at + 7]! * s.spacing * s.spacing;
      const protectedHeat = values[at]! * props[2]! * props[3]! * site.temperature * s.spacing * s.spacing;
      out[i] = Math.max(0, Math.min(potential, (energy - protectedHeat) / (dt * site.area)));
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    const ports = [
      { field: this.lavaField.name, region: s.samples, tick, cell: s.cell },
      { field: this.depositField.name, region: s.deposits, tick, cell: s.cell },
      { field: this.seaSourceField.name, region: s.sources, tick, cell: s.cell },
    ];
    if (this.exchangeIce) ports.push({ field: ICE_HEAT_FIELD.name, region: s.heatRequest, tick, cell: s.cell });
    return ports;
  }

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }
  extraState(): readonly Region[] {
    return [];
  }

  /** Read the last published cell. */
  sample(x: number, z: number): LavaSample {
    const s = this.live();
    const at = LAVA_WORDS * cellIndex(s.nx, s.nz, x, z);
    const w = words(s, s.samples);
    return {
      depth: w[at]!,
      temperature: w[at + 1]!,
      surfaceTemperature: w[at + 2]!,
      crustDepth: w[at + 3]!,
      discharge: [w[at + 4]!, w[at + 5]!],
      surfaceElevation: w[at + 6]!,
      enthalpy: w[at + 7]!,
    };
  }

  /** Read all volume and energy balance terms after the last step. */
  get budget(): LavaBudget {
    const s = this.live();
    const w = words(s, s.budget);
    return {
      suppliedVolume: w[0]!,
      suppliedEnthalpy: w[1]!,
      environmentalHeat: w[2]!,
      iceHeat: w[3]!,
      waterHeat: w[4]!,
      displacedWater: w[5]!,
      storedVolume: w[6]!,
      storedEnthalpy: w[7]!,
      initialVolume: w[8]!,
      initialEnthalpy: w[9]!,
      meltwater: w[10]!,
      steam: w[11]!,
    };
  }
}

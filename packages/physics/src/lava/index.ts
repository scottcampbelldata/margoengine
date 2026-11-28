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
import { DYNAMIC_BASE, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
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
  /** Inertial shallow-layer transport (default) or a strongly viscous terminal Bingham sheet. */
  readonly transport?: 'inertial' | 'terminal';
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
  /** Thermal conductivity in W/(m K). Defaults to 2. Zero removes conduction and exposes the bulk surface. */
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

/** Layout-1 surface data in the renderer's local metres, borrowed for the current draw. */
export interface LavaSurfaceFrame {
  /** Arena holding the accepted lava cell records. */
  readonly memory: WebAssembly.Memory;
  /** Address, length, layout and element type of the accepted cell region. */
  readonly region: Readonly<Pick<Region, 'byteOffset' | 'byteLength' | 'type' | 'layout'>>;
  /** X and Z grid sizes, with X fastest. */
  readonly cells: Pair;
  /** Grid spacing in metres. */
  readonly spacing: number;
  /** Lower XZ corner in the solver cell. */
  readonly origin: Pair;
  /** Metres translating the solver cell into the renderer's cell. */
  readonly offset: readonly [number, number, number];
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
  readonly terminal: boolean;
  readonly nx: number;
  readonly nz: number;
  readonly count: number;
  readonly origin: Pair;
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
  readonly nextSamples: Region;
  readonly nextDeposits: Region;
  readonly nextSources: Region;
  readonly nextSubmerged: Region;
  readonly icePower: Region;
  readonly heatRequest: Region;
  readonly nextHeatRequest: Region;
  readonly budget: Region;
  readonly nextBudget: Region;
  readonly regions: readonly Region[];
}

function scalar(label: string, value: number, lower = -Infinity, upper = Infinity): number {
  if (!Number.isFinite(value) || value < lower || value > upper)
    throw new MargoError('state', `Invalid lava ${label}. Use a finite SI value within its documented range.`);
  return value;
}

function positive(label: string, value: number): number {
  if (scalar(label, value) <= 0) throw new MargoError('state', `Invalid lava ${label}. Use a positive SI value.`);
  return value;
}

function integer(label: string, value: number, lower: number, upper = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < lower || value > upper)
    throw new MargoError('state', `Invalid lava ${label}. Use an integer within the grid or world-cell range.`);
  return value;
}

function mapped(value: Grid, count: number, label: string, lower = -Infinity): Float64Array {
  if (typeof value === 'number') return new Float64Array(count).fill(scalar(label, value, lower));
  if (value?.length !== count)
    throw new MargoError('state', `Invalid lava ${label} layout. Use one number per cell, X fastest.`);
  return Float64Array.from(value, (v) => scalar(label, v, lower));
}

function axisExtent(label: string, origin: number, count: number, spacing: number): void {
  const far = scalar(`${label} far edge`, origin + count * spacing);
  const firstCentre = origin + 0.5 * spacing;
  const lastCentre = origin + (count - 0.5) * spacing;
  if (!(firstCentre > origin && lastCentre < far))
    throw new MargoError(
      'state',
      'Lava cell centres exceed coordinate resolution. Use a nearby origin or wider cells.',
    );
}

function terrainCount(shape: BedShape): number {
  try {
    return bedVertexCount(shape);
  } catch (cause) {
    throw Object.assign(
      new MargoError('state', 'Invalid lava terrain geometry. Use finite TerrainBed extents and cell counts.'),
      { cause },
    );
  }
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
      throw new MargoError('state', 'Invalid lava solver ID. Use a nonempty name without outer whitespace.');
    if (terrain) {
      terrainCount(terrain);
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
    if (options?.cells?.length !== 2)
      throw new MargoError('state', 'Invalid lava grid. Use positive whole X and Z cell counts.');
    const nx = integer('X cell count', options.cells[0], 1);
    const nz = integer('Z cell count', options.cells[1], 1);
    const count = integer('cell count', nx * nz, 1);
    const authoredVents = options.vents ?? [];
    const contacts = options.ice ?? [];
    if (!Array.isArray(authoredVents) || !Array.isArray(contacts))
      throw new MargoError('state', 'Invalid lava vents or ice contacts. Use arrays of cell records.');
    const fieldWords = LAVA_WORDS + 1 + WAKE_SOURCE_WORDS;
    const wordsPerCell = 3 * 4 + 2 + 4 + 2 * (fieldWords + 1) + 1 + 2 * fieldWords;
    const requested = F64 * (wordsPerCell * count + 4 * Math.min(count, Math.max(contacts.length, 1)) + 44);
    if (requested + DYNAMIC_BASE + STACK_BYTES >= MAX_MEMORY_PAGES * 65536)
      throw new MargoError('state', 'Lava grid exceeds wasm32 arena capacity. Use fewer cells.');
    const spacing = positive('spacing', options.spacing);
    const transport = options.transport === undefined ? 'inertial' : options.transport;
    if (transport !== 'inertial' && transport !== 'terminal')
      throw new MargoError('state', 'Use inertial or terminal lava transport.');
    const terminal = transport === 'terminal';
    const volumeArea = positive('cell area', spacing * spacing);
    const lower = options.origin ?? [0, 0];
    if (lower.length !== 2) throw new MargoError('state', 'Invalid lava origin. Use two local X and Z coordinates.');
    const origin: Pair = [scalar('X origin', lower[0]), scalar('Z origin', lower[1])];
    axisExtent('X', origin[0], nx, spacing);
    axisExtent('Z', origin[1], nz, spacing);
    if (options.originCell !== undefined) {
      const cell = options.originCell;
      if (cell?.length !== 3 || !host.cell.every((value, axis) => value === cell[axis]))
        throw new MargoError('state', 'Invalid lava origin cell. Use the same cell as world.add.');
    }
    const cellSize = positive('origin cell size', options.originCellSize ?? 4096);

    const density = positive('density', options.density ?? 2600);
    positive('density times cell area', density * volumeArea);
    const cp = positive('heat capacity', options.heatCapacity ?? 1225);
    const latent = scalar('latent heat', options.latentHeat ?? 350000, 0);
    const solidus = positive('solidus', options.solidus ?? 1253);
    const liquidus = positive('liquidus', options.liquidus ?? 1423);
    if (liquidus <= solidus)
      throw new MargoError('state', 'Invalid lava phase transition. Set liquidus above solidus.');
    positive('effective heat capacity', cp + latent / (liquidus - solidus));
    positive('liquidus enthalpy', cp * liquidus + latent);
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
      throw new MargoError(
        'state',
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
    for (const vent of authoredVents) {
      if (vent?.cell?.length !== 2) throw new MargoError('state', 'Invalid lava vent cell. Use an X and Z cell pair.');
      const at = cellIndex(nx, nz, vent.cell[0], vent.cell[1]);
      if (ventCells.has(at))
        throw new MargoError('state', 'Two lava vents share one cell. Use distinct source cells or sum the discharge.');
      ventCells.add(at);
      const start = scalar('vent start', vent.start ?? 0, 0);
      const end = vent.end === undefined ? Infinity : scalar('vent end', vent.end, start);
      const hot = scalar('vent temperature', vent.temperature ?? liquidus + 20, solidus);
      ventRows.set(
        [
          positive('vent discharge per cell area', positive('vent discharge', vent.flow) / volumeArea),
          scalar('vent specific enthalpy', enthalpy(hot, cp, latent, solidus, liquidus), 0),
          start,
          end,
        ],
        4 * at,
      );
    }

    const iceCells = new Set<number>();
    const sites = contacts.map((site): IceSite => {
      if (site?.cell?.length !== 2)
        throw new MargoError('state', 'Invalid lava ice contact cell. Use an X and Z cell pair.');
      const at = cellIndex(nx, nz, site.cell[0], site.cell[1]);
      if (iceCells.has(at))
        throw new MargoError(
          'state',
          'Two ice contacts share one lava cell. Use a separate cell for each ICE-05 site.',
        );
      iceCells.add(at);
      return {
        cell: at,
        area: positive('ice contact area', site.area ?? volumeArea),
        temperature: positive('ice contact temperature', site.temperature ?? 273.15),
      };
    });
    if (this.exchangeIce !== (sites.length !== 0))
      throw new MargoError(
        'state',
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
    const nextSamples = allocate('lava-candidate-grid', LAVA_WORDS * count);
    const nextDeposits = allocate('lava-candidate-deposits', count, BED_LAYOUT);
    const nextSources = allocate('lava-candidate-displacement', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT);
    const nextSubmerged = allocate('lava-candidate-submerged', count);
    const icePower = allocate('lava-ice-cooling', count);
    const heatRequest = allocate('lava-ice-heat-flux', Math.max(sites.length, 1), ICE_FIELD_LAYOUT);
    const nextHeatRequest = allocate('lava-candidate-ice-heat-flux', Math.max(sites.length, 1), ICE_FIELD_LAYOUT);
    const budget = allocate('lava-budget', 12);
    const nextBudget = allocate('lava-next-budget', 12);

    const s: State = {
      host,
      kernel,
      terminal,
      nx,
      nz,
      count,
      origin,
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
      nextSamples,
      nextDeposits,
      nextSources,
      nextSubmerged,
      icePower,
      heatRequest,
      nextHeatRequest,
      budget,
      nextBudget,
      regions: [lava, bed, model, vents, samples, deposits, sources, submerged, heatRequest, budget],
    };
    words(s, model).set(params);
    words(s, nextBed).set(bedInitial);
    words(s, vents).set(ventRows);
    const columns = words(s, working);
    for (let i = 0; i < count; i++) {
      const h = depth[i]!;
      const hot = temperature[i]!;
      const mobile = h > 0 && hot > solidus;
      if (mobile && (qx[i] !== 0 || qz[i] !== 0)) {
        if (terminal)
          throw new MargoError('state', 'Omit initial discharge for terminal flow or use inertial transport.');
        const meltDepth = positive('initial mobile depth', h * Math.min(1, (hot - solidus) / (liquidus - solidus)));
        scalar('initial mobile velocity', Math.hypot(qx[i]!, qz[i]!) / meltDepth, 0);
      }
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
    this.preparePublication(s, 1, 1 / 60);
    const b = words(s, nextBudget);
    b[8] = b[6]!;
    b[9] = b[7]!;
    this.accept(s);
    this.state = s;
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
      throw new MargoError('state', 'Invalid lava terrain layout. Use the matching TerrainBed geometry.');
    const values = regionWords(s.host.memory, port.region);
    if (values.length !== terrainCount(this.terrain))
      throw new MargoError('state', 'Invalid lava terrain extent. Use the registered TerrainBed geometry.');
    const bed = bedSurface(this.terrain, values, port.cell);
    const point: BedSample = { elevation: 0, normal: [0, 1, 0] };
    const delta = (axis: number) =>
      scalar('terrain cell offset', (context.cell[axis]! - port.cell[axis]!) * s.cellSize);
    const dx = delta(0);
    const dy = delta(1);
    const dz = delta(2);
    axisExtent('shifted terrain X', s.origin[0] + dx, s.nx, s.spacing);
    axisExtent('shifted terrain Z', s.origin[1] + dz, s.nz, s.spacing);
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
        throw new MargoError('state', `Invalid lava ice feedback ${field.name}. Use one layout-1 f64 per ICE-05 site.`);
      return regionWords(s.host.memory, r);
    });
    const want = words(s, s.heatRequest);
    const b = words(s, s.nextBudget);
    for (const [i, site] of s.sites.entries()) {
      const absorbed = scalar('absorbed ice power', input[0]![i]!, 0);
      const offered = scalar('offered ice power', want[i]! * site.area, 0);
      // Allow only the roundoff of reversing ICE-05's area and time conversion.
      if (absorbed - offered > 16 * Number.EPSILON * Math.max(absorbed, offered))
        throw new MargoError(
          'state',
          'Ice accepted more heat than lava offered. Use matching contact areas and staggered exchange.',
        );
      power[site.cell] = absorbed;
      b[10] = scalar('accumulated ice meltwater', b[10]! + scalar('ice meltwater rate', input[1]![i]!, 0) * dt, 0);
      b[11] = scalar('accumulated ice steam', b[11]! + scalar('ice steam rate', input[2]![i]!, 0) * dt, 0);
    }
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const interval = positive('step duration', dt);
    const start = scalar('step start time', context.tick * interval, 0);
    if (!(scalar('step end time', start + interval, 0) > start))
      throw new MargoError('state', 'Lava tick time exceeds numeric resolution. Use a nearer simulation time.');
    words(s, s.working).set(words(s, s.lava));
    words(s, s.nextBudget).set(words(s, s.budget));
    this.prepareBed(s, context);
    this.receiveIce(s, context, interval);
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
      interval,
      start,
      s.terminal ? 1 : 0,
    );
    if (result === 3)
      throw new MargoError(
        'state',
        'Lava tick exceeds 4096 explicit microsteps. Use a coarser grid or reduce forcing.',
      );
    if (result !== 0)
      throw new MargoError(
        'state',
        'Lava update exceeded its heat or flux bounds. Use finite physical grid, coupling and source scales.',
      );
    this.preparePublication(s, 0, interval);
    this.accept(s);
  }

  private preparePublication(s: State, initial: number, dt: number): void {
    words(s, s.nextSubmerged).set(words(s, s.submerged));
    const status = s.kernel.lava_publish(
      s.working.byteOffset,
      s.nextBed.byteOffset,
      s.model.byteOffset,
      s.nextSamples.byteOffset,
      s.nextDeposits.byteOffset,
      s.nextSources.byteOffset,
      s.nextSubmerged.byteOffset,
      s.nx,
      s.nz,
      s.origin[0],
      s.origin[1],
      s.nextBudget.byteOffset,
      initial,
    );
    if (status !== 0)
      throw new MargoError(
        'state',
        'Lava publication exceeds finite surface, source or budget range. Use compatible grid, bed and forcing scales.',
      );
    const values = words(s, s.nextSamples);
    const props = words(s, s.model);
    const out = words(s, s.nextHeatRequest);
    for (const [i, site] of s.sites.entries()) {
      const at = site.cell * LAVA_WORDS;
      const potential = (props[15]! / (props[16]! + values[at + 3]!)) * (values[at + 1]! - site.temperature);
      const energy = values[at + 7]! * s.spacing * s.spacing;
      const protectedHeat = values[at]! * props[2]! * props[3]! * site.temperature * s.spacing * s.spacing;
      const limit = (energy - protectedHeat) / (dt * site.area);
      if (!(Number.isFinite(potential) && Number.isFinite(limit) && Number.isFinite(dt * site.area)))
        throw new MargoError(
          'state',
          'Lava ice heat request exceeds numeric range. Use compatible temperatures, contact area and grid scale.',
        );
      out[i] = Math.max(0, Math.min(potential, limit));
    }
  }

  private accept(s: State): void {
    words(s, s.lava).set(words(s, s.working));
    words(s, s.bed).set(words(s, s.nextBed));
    words(s, s.budget).set(words(s, s.nextBudget));
    words(s, s.samples).set(words(s, s.nextSamples));
    words(s, s.deposits).set(words(s, s.nextDeposits));
    words(s, s.sources).set(words(s, s.nextSources));
    words(s, s.submerged).set(words(s, s.nextSubmerged));
    words(s, s.heatRequest).set(words(s, s.nextHeatRequest));
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    const cell = s.host.cell;
    const ports = [
      { field: this.lavaField.name, region: s.samples, tick, cell },
      { field: this.depositField.name, region: s.deposits, tick, cell },
      { field: this.seaSourceField.name, region: s.sources, tick, cell },
    ];
    if (this.exchangeIce) ports.push({ field: ICE_HEAT_FIELD.name, region: s.heatRequest, tick, cell });
    return ports;
  }

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }
  extraState(): readonly Region[] {
    return [];
  }

  /** Borrow accepted surface records for a renderer. Defaults to the solver's current origin cell. */
  surfaceSource(renderCell?: Cell): LavaSurfaceFrame {
    const s = this.live();
    const source = s.host.cell;
    const target = renderCell ?? source;
    if (
      target.length !== 3 ||
      !Number.isSafeInteger(target[0]) ||
      !Number.isSafeInteger(target[1]) ||
      !Number.isSafeInteger(target[2])
    )
      throw new MargoError('state', 'Give the lava renderer three whole origin cell coordinates.');
    const translation = (axis: number) => {
      const cells = source[axis]! - target[axis]!;
      const offset = cells * s.cellSize;
      if (!Number.isSafeInteger(cells) || !Number.isFinite(Math.fround(offset)))
        throw new MargoError('state', 'Lava surface translation exceeds render precision. Use a nearer origin cell.');
      return offset;
    };
    return {
      memory: s.host.memory,
      region: s.samples,
      cells: [s.nx, s.nz],
      spacing: s.spacing,
      origin: [s.origin[0], s.origin[1]],
      offset: [translation(0), translation(1), translation(2)],
    };
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

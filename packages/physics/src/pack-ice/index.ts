import type { FlowField, FlowSample, Wind } from '@margoengine/math/fields';
import { exp } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { packIceError } from './errors.js';
import {
  bindPackIceKernel,
  loadPackIceBuilds,
  type PackIceBuilds,
  type PackIceKernel,
  type PackIceWorkCounts,
} from './kernel.js';

export type { PackIceWorkCounts, PackIceWorkerWork } from './kernel.js';

/** Layout of the pack-ice fields. */
export const PACK_ICE_LAYOUT = 1;
/** Floe row, f64: x, z, vx, vz, yaw, spin, radius, level thickness, total, rafted and ridged volumes. */
export const PACK_ICE_WORDS = 11;
/** Optional flow row, f64: vx, vz and density, per floe. */
export const PACK_ICE_FLOW_WORDS = 3;
const F64 = 8;
const FLOW_WORDS = 6;
const VESSEL_WORDS = 15;
const GRID_WORDS = 4;
const RIGID_LAYOUT = 2;

type Pair = readonly [number, number];

/** A floating disk in SI units in the solver's XZ world cell. */
export interface PackIceFloe {
  readonly position: Pair;
  readonly radius: number;
  readonly thickness: number;
  /** Defaults to still. */
  readonly velocity?: Pair;
  /** Yaw in radians. Defaults to zero. */
  readonly heading?: number;
  /** Angular velocity around +Y in rad/s. Defaults to zero. */
  readonly spin?: number;
}

/** A horizontal waterline capsule centred on a rigid body, with length along its local +Z. */
export interface PackIceVessel {
  readonly bodyRow: number;
  readonly length: number;
  readonly beam: number;
  /** Elevation of the contact profile above the body origin. Defaults to zero. */
  readonly waterlineOffset?: number;
  /** Vertical range below the contact profile. Defaults to 1 m. */
  readonly draft?: number;
  /** Vertical range above the contact profile. Defaults to 1 m. */
  readonly freeboard?: number;
}

/** Options that declare the solver's fields before it joins a world. */
export interface PackIceLoadOptions {
  readonly id?: string;
  /** Read rigid pose and contribute rigid impulses. Defaults to false. */
  readonly rigid?: boolean;
  /** Registry field supplying air velocity and density in layout-1 f64 rows. */
  readonly windField?: FieldDescriptor;
  /** Registry field supplying water velocity and density in layout-1 f64 rows. */
  readonly currentField?: FieldDescriptor;
  readonly signal?: AbortSignal;
  /** Native participants including the caller. Use 1 (default), 2 or 4 with shared memory. */
  readonly threads?: number;
}

/** Material properties for the upper thickness of simple rafting. */
export interface RaftingMaterial {
  /** Flexural Young modulus, Pa. Defaults to 1 GPa. */
  readonly youngModulus?: number;
  /** Flexural tensile strength, Pa. Defaults to 350 kPa. */
  readonly tensileStrength?: number;
  /** Defaults to 0.3. */
  readonly poissonRatio?: number;
  /** Water density. Defaults to 1025 kg/m³. */
  readonly waterDensity?: number;
  /** Downward gravity magnitude. Defaults to 9.81 m/s². */
  readonly gravity?: number;
}

/** Initial floes, fluids and material properties. The solver takes gravity from the world. */
export interface PackIceOptions extends Omit<RaftingMaterial, 'gravity'> {
  readonly floes: readonly PackIceFloe[];
  /** Shared pure wind. Defaults to calm air. Mutually exclusive with windField. */
  readonly wind?: Wind;
  /** Shared pure water current. Defaults to still water. Mutually exclusive with currentField. */
  readonly current?: FlowField;
  /** Horizontal ship contact profiles. Requires load({ rigid: true }). Defaults to none. */
  readonly vessels?: readonly PackIceVessel[];
  /** Contributor row count. Defaults to highest vessel row plus one. Match other impulse contributors. */
  readonly rigidCapacity?: number;
  /** PhysicsWorld origin-cell size. Defaults to 4096 m. */
  readonly cellSize?: number;
  /** Sea level in the origin cell and height of flow sampling. Defaults to zero. */
  readonly seaLevel?: number;
  /** Ice density. Defaults to 917 kg/m³. */
  readonly iceDensity?: number;
  /** Calm-air density. Defaults to 1.23 kg/m³. */
  readonly airDensity?: number;
  /** Dimensionless quadratic drag on horizontal ice. Defaults to 0.0017. */
  readonly airSkinDrag?: number;
  /** Dimensionless quadratic drag on ice freeboard. Defaults to 0.0017. */
  readonly airEdgeDrag?: number;
  /** Linear water skin-drag coefficient, m/s. Defaults to 0.0013. */
  readonly waterSkinDrag?: number;
  /** Linear water form-drag coefficient, m/s. Defaults to 0.0013. */
  readonly waterEdgeDrag?: number;
  /** Normal restitution. Defaults to 0.15. */
  readonly restitution?: number;
  /** Coulomb friction coefficient. Defaults to 0.3. */
  readonly friction?: number;
  /** Smallest resolved residual floe radius. Defaults to 0.05 m. */
  readonly residualRadius?: number;
  /** Allow dissipated contact work to form rafts and ridges. Defaults to true. */
  readonly icebreaking?: boolean;
}

/** Present state of one floe. Rafted and ridged ice remain part of the total. */
export interface PackIceSample extends Required<PackIceFloe> {
  readonly volume: number;
  readonly raftedVolume: number;
  readonly ridgedVolume: number;
  readonly equivalentThickness: number;
}

function checked(label: string, value: number, low = -Infinity, high = Infinity): number {
  if (!(Number.isFinite(value) && value >= low && value <= high))
    throw packIceError(`Invalid pack-ice ${label}. Use a finite value from ${low} to ${high}.`);
  return value;
}

function positive(label: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0))
    throw packIceError(`Invalid pack-ice ${label}. Use a positive finite value.`);
  return value;
}

function integer(label: string, value: number): number {
  if (!(Number.isSafeInteger(value) && value >= 0))
    throw packIceError(`Invalid pack-ice ${label}. Use a nonnegative safe integer.`);
  return value;
}

function pair(label: string, value: Pair): Pair {
  if (value?.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]))
    throw packIceError(`Invalid pack-ice ${label}. Use two finite values for X and Z.`);
  return value;
}

/** Vella and Wettlaufer (2008), equation 12, for two identical elastic floating plates. */
export function criticalRaftingThickness(material: RaftingMaterial = {}): number {
  const e = positive('Young modulus', material.youngModulus ?? 1e9);
  const strength = positive('tensile strength', material.tensileStrength ?? 350_000);
  const poisson = checked('Poisson ratio', material.poissonRatio ?? 0.3, -1, 0.5);
  const rho = positive('water density', material.waterDensity ?? 1025);
  const g = positive('downward gravity', material.gravity ?? 9.81);
  return positive(
    'critical rafting thickness',
    ((8 / 3) * exp(Math.PI / 2) * (1 - poisson * poisson) * (strength / e) * strength) / (rho * g),
  );
}

interface LiveVessel {
  readonly body: number;
  readonly length: number;
  readonly beam: number;
  readonly offset: number;
  readonly draft: number;
  readonly freeboard: number;
}

interface State {
  readonly memory: WebAssembly.Memory;
  readonly host: SolverHost;
  readonly positions: Float64Array;
  readonly stagedForcing: Float64Array;
  readonly kernel: PackIceKernel;
  readonly count: number;
  readonly vessels: readonly LiveVessel[];
  readonly wind?: Wind;
  readonly current?: FlowField;
  readonly cellSize: number;
  readonly level: number;
  readonly airDensity: number;
  readonly waterDensity: number;
  readonly settings: Region;
  readonly floes: Region;
  readonly nextFloes: Region;
  readonly forcing: Region;
  readonly grid: Region;
  readonly gridCapacity: number;
  readonly links: Region;
  readonly rigid: Region;
  readonly impulses: Region;
  readonly nextImpulses: Region;
  readonly metrics: Region;
  readonly nextMetrics: Region;
  readonly regions: readonly Region[];
}

function inputWords(memory: WebAssembly.Memory, port: Port) {
  const bank = port.region.memory ?? memory;
  try {
    return regionWords(bank, port.region);
  } catch (cause) {
    throw packIceError(
      'The pack-ice input region is outside its bank or misaligned. Publish a valid region with the memory that owns it.',
      'state',
      cause,
    );
  }
}

function flowRows(
  memory: WebAssembly.Memory,
  field: FieldDescriptor,
  context: StepContext,
  count: number,
): Float64Array | undefined {
  const port = context.inputs.get(field.name);
  if (!port) return undefined;
  const region = port.region;
  if (
    region.type !== 'f64' ||
    region.layout !== PACK_ICE_LAYOUT ||
    region.byteLength !== count * PACK_ICE_FLOW_WORDS * F64
  )
    throw packIceError(`Invalid pack-ice ${field.name} port. Use vx, vz and density in layout-1 f64 rows.`);
  return inputWords(memory, port) as Float64Array;
}

function sampleFlow(
  field: FlowField,
  scratch: FlowSample,
  cell: Cell,
  cellSize: number,
  x: number,
  y: number,
  z: number,
  time: number,
): FlowSample {
  let flow: FlowSample;
  try {
    flow = field.sample(
      x + (cell[0] - field.cell[0]) * cellSize,
      y + (cell[1] - field.cell[1]) * cellSize,
      z + (cell[2] - field.cell[2]) * cellSize,
      time,
      scratch,
    );
  } catch (cause) {
    throw packIceError(
      'The pack-ice flow sample failed. Supply a field covering the requested coordinates and time.',
      'failed',
      cause,
    );
  }
  if (!flow?.velocity || flow.velocity.length !== 3)
    throw packIceError(
      'The pack-ice flow returned no valid velocity. Supply three velocity components and a positive density.',
    );
  return flow;
}

function validFlow(field: FlowField): boolean {
  return field.cell?.length === 3 && field.cell.every(Number.isSafeInteger) && typeof field.sample === 'function';
}

function checkedVessels(vessels: readonly PackIceVessel[]): LiveVessel[] {
  const rows = new Set<number>();
  return vessels.map((vessel) => {
    const body = integer('rigid body row', vessel.bodyRow);
    if (rows.has(body)) throw packIceError('Repeated pack-ice body row. Use one waterline capsule per vessel.');
    rows.add(body);
    const length = positive('vessel length', vessel.length);
    const beam = positive('vessel beam', vessel.beam);
    if (beam > length) throw packIceError('Invalid pack-ice vessel beam. Use a beam no greater than the length.');
    return {
      body,
      length,
      beam,
      offset: checked('vessel waterline offset', vessel.waterlineOffset ?? 0),
      draft: positive('vessel draft', vessel.draft ?? 1),
      freeboard: positive('vessel freeboard', vessel.freeboard ?? 1),
    };
  });
}

/** Deterministic discrete-element floes, rafting, ridging and ship contact. */
export class PackIceSolver implements Solver<PackIceOptions> {
  /** Pose, footprint and conserved material of each floe, in layout 1. */
  readonly floeField: FieldDescriptor;
  private readonly uses: readonly FieldUse[];
  private readonly airSample: FlowSample = { velocity: [0, 0, 0], temperature: 0, density: 0 };
  private readonly waterSample: FlowSample = { velocity: [0, 0, 0], temperature: 0, density: 0 };
  private state?: State;
  private stepping = false;
  private disposed = false;
  private nativeWork?: PackIceWorkCounts;

  private constructor(
    private readonly builds: PackIceBuilds,
    private readonly id: string,
    private readonly rigid: boolean,
    private readonly windField?: FieldDescriptor,
    private readonly currentField?: FieldDescriptor,
  ) {
    this.floeField = Object.freeze({
      name: `${id}.floes`,
      kind: 'bodySet',
      quantity: 'packIceState',
      unit: 'm, m/s, rad, rad/s, m³',
      centring: 'particle',
    });
    this.uses = [
      { field: this.floeField, access: 'write' },
      ...(windField ? [{ field: windField, access: 'read' as const }] : []),
      ...(currentField ? [{ field: currentField, access: 'read' as const }] : []),
      ...(rigid
        ? [
            { field: BODIES_FIELD, access: 'read' as const },
            { field: BODY_IMPULSES_FIELD, access: 'accumulate' as const },
          ]
        : []),
    ];
  }

  /** Load the SIMD Wasm on demand. */
  static async load(options: PackIceLoadOptions = {}): Promise<PackIceSolver> {
    const { id = 'pack-ice', rigid = false, windField, currentField, signal, threads = 1 } = options;
    if (!(typeof id === 'string' && id.trim().length > 0))
      throw packIceError('Pack-ice solver ID is empty. Provide a nonempty ID.');
    if (windField && windField.name === currentField?.name)
      throw packIceError('Repeated pack-ice flow field. Use distinct air and water names.');
    return new PackIceSolver(await loadPackIceBuilds(signal, threads), id, rigid, windField, currentField);
  }

  /** Release native helpers after the world finishes using this solver. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.builds[Symbol.dispose]();
  }

  describe() {
    return { id: this.id, fields: this.uses, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, options: PackIceOptions): void {
    if (this.disposed) throw packIceError('The pack-ice solver was disposed. Load a new instance.', 'disposed');
    if (this.state)
      throw packIceError('Pack-ice solver is already initialized. Load another solver for the new world.');
    try {
      this.initialize(host, options);
    } catch (cause) {
      if (this.builds.pool) this[Symbol.dispose]();
      throw cause;
    }
  }

  private initialize(host: SolverHost, options: PackIceOptions): void {
    if (!Array.isArray(options?.floes) || options.floes.length === 0)
      throw packIceError('Pack-ice needs at least one floe. Pass an array of initial disks in floes.');
    const count = options.floes.length;
    if (options.wind && (options.wind.medium !== 'air' || this.windField || !validFlow(options.wind)))
      throw packIceError('Invalid pack-ice wind. Use one air Wind or one wind port.');
    if (options.current && (options.current.medium !== 'water' || this.currentField || !validFlow(options.current)))
      throw packIceError('Invalid pack-ice current. Use one water FlowField or one current port.');
    const vessels = checkedVessels(options.vessels ?? []);
    if (this.rigid !== vessels.length > 0)
      throw packIceError('Pack-ice vessels require rigid coupling. Pass vessel profiles and load with rigid true.');
    const bodyCount = vessels.reduce((last, vessel) => Math.max(last, vessel.body + 1), 0);
    const capacity = integer('rigid capacity', options.rigidCapacity ?? bodyCount);
    if (capacity < bodyCount)
      throw packIceError('Invalid pack-ice rigid capacity. Use a capacity that covers every requested hull row.');
    const cellSize = positive('origin cell size', options.cellSize ?? 4096);
    const level = checked('sea level', options.seaLevel ?? 0);
    const iceDensity = positive('ice density', options.iceDensity ?? 917);
    const waterDensity = positive('water density', options.waterDensity ?? 1025);
    if (iceDensity >= waterDensity)
      throw packIceError('Pack-ice needs floating ice. Use ice density lower than the water density.');
    const airDensity = positive('air density', options.airDensity ?? 1.23);
    const gravity = positive('downward gravity', -host.gravity[1]);
    const tensileStrength = positive('tensile strength', options.tensileStrength ?? 350_000);
    const constants = [
      iceDensity,
      waterDensity,
      gravity,
      checked('air skin drag', options.airSkinDrag ?? 0.0017, 0),
      checked('air edge drag', options.airEdgeDrag ?? 0.0017, 0),
      checked('water skin drag', options.waterSkinDrag ?? 0.0013, 0),
      checked('water edge drag', options.waterEdgeDrag ?? 0.0013, 0),
      checked('restitution', options.restitution ?? 0.15, 0, 1),
      checked('friction', options.friction ?? 0.3, 0),
      criticalRaftingThickness({ ...options, waterDensity, gravity }),
      positive('residual radius', options.residualRadius ?? 0.05),
      tensileStrength,
      options.icebreaking === false ? 0 : 1,
    ];
    let widest = 0;
    const seed = new Float64Array(count * PACK_ICE_WORDS);
    for (const [i, floe] of options.floes.entries()) {
      const radius = positive('floe radius', floe.radius);
      const thickness = positive('floe thickness', floe.thickness);
      const volume = positive('floe volume', Math.PI * radius * radius * thickness);
      positive('floe mass', iceDensity * volume);
      widest = Math.max(widest, radius);
      seed.set(
        [
          ...pair('position', floe.position),
          ...pair('velocity', floe.velocity ?? [0, 0]),
          checked('yaw', floe.heading ?? 0),
          checked('spin', floe.spin ?? 0),
          radius,
          thickness,
          volume,
          0,
          0,
        ],
        i * PACK_ICE_WORDS,
      );
    }
    constants.push(positive('grid width', 2 * widest));
    const floats = (name: string, words: number) =>
      host.allocate(name, Math.max(words, 1) * F64, 'f64', PACK_ICE_LAYOUT);
    const ints = (name: string, words: number) => host.allocate(name, words * 4, 'u32', PACK_ICE_LAYOUT);
    let gridCapacity = 2;
    while (gridCapacity < 2 * count) gridCapacity *= 2;
    const settings = floats('constants', constants.length);
    const floes = floats('floes', count * PACK_ICE_WORDS);
    const nextFloes = floats('working-floes', count * PACK_ICE_WORDS);
    const forcing = floats('forcing', count * FLOW_WORDS);
    const grid = ints('cell-table', gridCapacity * GRID_WORDS);
    const links = ints('cell-links', count);
    const rigid = floats('vessels', vessels.length * VESSEL_WORDS);
    const impulses = floats('rigid-impulses', capacity * IMPULSE_WORDS);
    const nextImpulses = floats('working-rigid-impulses', capacity * IMPULSE_WORDS);
    const metrics = ints('metrics', 2);
    const nextMetrics = ints('working-metrics', 2);
    const kernel = bindPackIceKernel(host, this.builds);
    const memory = host.memory;
    (regionWords(memory, settings) as Float64Array).set(constants);
    (regionWords(memory, floes) as Float64Array).set(seed);
    this.state = {
      memory,
      host,
      positions: new Float64Array(options.wind || options.current ? 2 * count : 0),
      stagedForcing: new Float64Array(FLOW_WORDS * count),
      kernel,
      count,
      vessels,
      wind: options.wind,
      current: options.current,
      cellSize,
      level,
      airDensity,
      waterDensity,
      settings,
      floes,
      nextFloes,
      forcing,
      grid,
      gridCapacity,
      links,
      rigid,
      impulses,
      nextImpulses,
      metrics,
      nextMetrics,
      regions: this.rigid ? [settings, floes, metrics, impulses] : [settings, floes, metrics],
    };
  }

  private live(): State {
    if (!this.state) throw packIceError('Pack-ice solver is not initialized. Add the solver to a PhysicsWorld.');
    return this.state;
  }

  private fluids(s: State, context: StepContext, dt: number): void {
    const { memory, count, cellSize, wind, current, positions, stagedForcing: forcing } = s;
    // Collect the input words before a callback may grow or replace a backing buffer.
    {
      const records = regionWords(memory, s.floes);
      const air = this.windField && flowRows(memory, this.windField, context, count);
      const water = this.currentField && flowRows(memory, this.currentField, context, count);
      for (let i = 0; i < count; i++) {
        const j = i * PACK_ICE_WORDS;
        const k = i * FLOW_WORDS;
        const row = i * PACK_ICE_FLOW_WORDS;
        if (wind || current) {
          positions[2 * i] = records[j]!;
          positions[2 * i + 1] = records[j + 1]!;
        }
        forcing[k] = checked('air velocity X', air?.[row] ?? 0);
        forcing[k + 1] = checked('air velocity Z', air?.[row + 1] ?? 0);
        forcing[k + 2] = positive('sampled air density', air?.[row + 2] ?? s.airDensity);
        forcing[k + 3] = checked('current X', water?.[row] ?? 0);
        forcing[k + 4] = checked('current Z', water?.[row + 1] ?? 0);
        forcing[k + 5] = positive('sampled water density', water?.[row + 2] ?? s.waterDensity);
      }
    }
    const time = context.tick * dt;
    for (let i = 0; (wind || current) && i < count; i++) {
      const x = positions[2 * i]!;
      const z = positions[2 * i + 1]!;
      const k = i * FLOW_WORDS;
      if (wind) {
        const air = sampleFlow(wind, this.airSample, context.cell, cellSize, x, s.level, z, time);
        forcing[k] = checked('air velocity X', air.velocity[0]);
        forcing[k + 1] = checked('air velocity Z', air.velocity[2]);
        forcing[k + 2] = positive('sampled air density', air.density);
      }
      if (current) {
        const water = sampleFlow(current, this.waterSample, context.cell, cellSize, x, s.level, z, time);
        forcing[k + 3] = checked('current X', water.velocity[0]);
        forcing[k + 4] = checked('current Z', water.velocity[2]);
        forcing[k + 5] = positive('sampled water density', water.density);
      }
    }
    (regionWords(memory, s.forcing) as Float64Array).set(forcing);
  }

  private vesselStates(s: State, context: StepContext): void {
    if (!this.rigid) return;
    const port = context.inputs.get(BODIES_FIELD.name);
    const table = regionWords(s.memory, s.rigid) as Float64Array;
    table.fill(0);
    if (!port) return;
    const body = port.region;
    if (body.type !== 'f32' || body.layout !== RIGID_LAYOUT || body.byteLength % (BODY_WORDS * 4) !== 0)
      throw packIceError('Invalid pack-ice rigid pose port. Use the layout-2 bodies port.');
    const values = inputWords(s.memory, port);
    const dx = (port.cell[0] - context.cell[0]) * s.cellSize;
    const dy = (port.cell[1] - context.cell[1]) * s.cellSize;
    const dz = (port.cell[2] - context.cell[2]) * s.cellSize;
    for (const [i, vessel] of s.vessels.entries()) {
      const p = vessel.body * BODY_WORDS;
      if (p + BODY_WORDS > values.length)
        throw packIceError('Invalid pack-ice vessel row. Use a body row within the rigid pose capacity.');
      const y = values[p + 1]! + dy + vessel.offset;
      const [qx, qy, qz, qw] = [values[p + 3]!, values[p + 4]!, values[p + 5]!, values[p + 6]!];
      const fx = 2 * (qx * qz + qw * qy);
      const fz = 1 - 2 * (qx * qx + qy * qy);
      const length = Math.sqrt(fx * fx + fz * fz);
      if (
        (qx === 0 && qy === 0 && qz === 0 && qw === 0) ||
        length === 0 ||
        s.level < y - vessel.draft ||
        s.level > y + vessel.freeboard
      )
        continue;
      table.set(
        [
          values[p]! + dx,
          values[p + 2]! + dz,
          fx / length,
          fz / length,
          values[p + 7]! + dx,
          values[p + 9]! + dz,
          values[p + 10]!,
          values[p + 12]!,
          values[p + 14]!,
          values[p + 16]!,
          values[p + 20]!,
          (vessel.length - vessel.beam) * 0.5,
          vessel.beam * 0.5,
          vessel.body,
          1,
        ],
        i * VESSEL_WORDS,
      );
    }
  }

  step(context: StepContext, dt: number): void {
    if (this.disposed) throw packIceError('The pack-ice solver was disposed. Load a new instance.', 'disposed');
    positive('step duration', dt);
    if (this.stepping)
      throw packIceError(
        'The pack-ice flow callback re-entered this solver. Sample a separate field during the callback.',
      );
    this.stepping = true;
    try {
      this.advance(context, dt);
    } finally {
      this.stepping = false;
    }
  }

  private advance(context: StepContext, dt: number): void {
    const s = this.live();
    this.fluids(s, context, dt);
    this.vesselStates(s, context);
    const { memory } = s;
    const floes = regionWords(memory, s.floes) as Float64Array;
    const next = regionWords(memory, s.nextFloes) as Float64Array;
    const impulses = regionWords(memory, s.nextImpulses) as Float64Array;
    next.set(floes);
    impulses.fill(0);
    const error = s.kernel.pack_ice_step(
      s.nextFloes.byteOffset,
      s.forcing.byteOffset,
      s.count,
      s.rigid.byteOffset,
      s.vessels.length,
      s.settings.byteOffset,
      s.grid.byteOffset,
      s.gridCapacity,
      s.links.byteOffset,
      s.nextImpulses.byteOffset,
      s.nextMetrics.byteOffset,
      dt,
    );
    if (error)
      throw packIceError('Pack-ice step exceeds numeric range. Use smaller initial velocities and finite floe scales.');
    floes.set(next);
    (regionWords(memory, s.impulses) as Float64Array).set(impulses);
    (regionWords(memory, s.metrics) as Uint32Array).set(regionWords(memory, s.nextMetrics));
    this.nativeWork = s.kernel.workCounts();
  }

  /** Copies native work counts from the last accepted step, including counts for every helper. */
  readNativeWork(): PackIceWorkCounts | undefined {
    const work = this.nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    const cell = s.host.cell;
    const out: Port[] = [{ field: this.floeField.name, region: s.floes, tick, cell }];
    if (this.rigid) out.push({ field: BODY_IMPULSES_FIELD.name, region: s.impulses, tick, cell });
    return out;
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Number of floe rows, fixed for this instance. */
  get count(): number {
    return this.live().count;
  }

  /** Read present floe pose, footprint and material. */
  sample(index: number): PackIceSample {
    const s = this.live();
    if (!(integer('floe index', index) < s.count))
      throw packIceError('Invalid pack-ice floe index. Use a row below count.');
    const record = regionWords(s.memory, s.floes);
    const i = index * PACK_ICE_WORDS;
    const radius = record[i + 6]!;
    const volume = record[i + 8]!;
    return {
      position: [record[i]!, record[i + 1]!],
      velocity: [record[i + 2]!, record[i + 3]!],
      heading: record[i + 4]!,
      spin: record[i + 5]!,
      radius,
      thickness: record[i + 7]!,
      volume,
      raftedVolume: record[i + 9]!,
      ridgedVolume: record[i + 10]!,
      equivalentThickness: volume / (Math.PI * radius * radius),
    };
  }

  /** Impulse applied to a body on the latest pack step, including a fixed body. */
  vesselImpulse(bodyRow: number): { readonly linear: Pair; readonly yaw: number } {
    const s = this.live();
    const i = integer('rigid body row', bodyRow) * IMPULSE_WORDS;
    const data = regionWords(s.memory, s.impulses);
    if (!this.rigid || i + IMPULSE_WORDS > data.length)
      throw packIceError('Pack-ice impulse row is missing. Use a row inside the configured rigid capacity.');
    return { linear: [data[i]!, data[i + 2]!], yaw: data[i + 4]! };
  }

  /** Deterministic work counts for the latest step. */
  get work(): { readonly substeps: number; readonly pairs: number } {
    const s = this.live();
    const data = regionWords(s.memory, s.metrics);
    return { substeps: data[0]!, pairs: data[1]! };
  }
}

import type { Vec3 } from '@margoengine/math';
import type { FlowSample } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import {
  FORCING_WORDS,
  SURFACE_WATER_FIELD,
  SURFACE_WATER_FORCING_FIELD,
  SURFACE_WATER_LAYOUT,
} from '../hydro/index.js';
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
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { vortexError } from './errors.js';
import {
  bindVortexWaterKernel,
  loadVortexWaterBuilds,
  type VortexWaterBuilds,
  type VortexWaterKernel,
  type VortexWaterWorkCounts,
} from './kernel.js';
import { requireVortexCell, StormVortex, stormWaterDrag } from './model.js';

export type { VortexWaterProfile, VortexWaterWorkerWork, VortexWaterWorkCounts } from './kernel.js';

export {
  StormVortex,
  stormWaterDrag,
  type HurricaneVortexProfile,
  type StormVortexOptions,
  type VortexKind,
} from './model.js';

/** Layout 1 uses f64 probe and load rows. Probe rows are [vx, vy, vz, rho, temperature, pressure]. */
export const VORTEX_LAYOUT = 1;
const PROBE_WORDS = 6;
const LOAD_WORDS = 8;
const ZERO_LEVER: Vec3 = [0, 0, 0];

/** Presented area, lever and optional structural load limit for a rigid row. */
export interface VortexBody {
  /** Stable index in the RigidSolver body table. */
  body: number;
  /** Projected area normal to the incident wind, m². */
  area: number;
  /** Drag coefficient. Default 1. */
  drag?: number;
  /** World-axis lever from the centre of mass to the pressure centre, metres. Default zero. */
  lever?: Vec3;
  /** Load threshold in N. Omit for a body with no failure limit. */
  forceLimit?: number;
}

/** Location and geometry of the live shallow-water coupling. Coordinates are in the water port's cell. */
export interface VortexWaterGrid {
  width: number;
  depth: number;
  /** Horizontal spacing in metres, [dx, dz]. */
  spacing: readonly [number, number];
  /** First water-cell centre in metres, [x, z]. */
  origin: readonly [number, number];
  /** Reference water-surface elevation in metres. Default 0. Wind uses its 10 m level. */
  level?: number;
  /** Water density, kg/m³. Default 1025. */
  density?: number;
  /** Allow another contributor to supply wind stress. Default true, add wind stress here. */
  windStress?: boolean;
}

/** Positive wind force limit flags are retained when the load is above the configured threshold. */
export interface VortexLoadReading {
  readonly force: Vec3;
  readonly torque: Vec3;
  readonly utilization: number;
  readonly failed: boolean;
}

/** Prescribed vortex and optional coupling geometry. */
export interface VortexParams {
  /** The same wind field can drive plants, particles, and the visual storm. */
  vortex: StormVortex;
  /** Probe coordinates in the solver cell. Default one probe at [0,10,0]. */
  probes?: readonly Vec3[];
  /** Matches the world for conversions between distinct origin cells (default 4096 m). */
  cellSize?: number;
  /** Configure when rigid bodies were enabled on the solver. */
  rigid?: { capacity: number; bodies: readonly VortexBody[] };
  /** Configure when the water port was enabled on the solver. */
  water?: VortexWaterGrid;
}

type RigidTarget = { row: number; area: number; drag: number; lever: Vec3; limit: number };
type Water = {
  width: number;
  depth: number;
  dx: number;
  dz: number;
  x: number;
  z: number;
  y: number;
  density: number;
  wind: boolean;
};

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw vortexError(`Vortex ${label} must be finite. Pass an SI value.`);
  return value;
}
function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0)) throw vortexError(`Vortex ${label} must be positive. Pass a value above zero.`);
  return value;
}
function extent(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw vortexError(`Invalid vortex ${label}. Pass a positive whole count.`);
  return value;
}
function vector(value: Vec3, label: string): Vec3 {
  if (value?.length !== 3) throw vortexError(`Vortex ${label} requires xyz coordinates. Pass a three-element vector.`);
  return [finite(value[0], label), finite(value[1], label), finite(value[2], label)];
}

/** Active vortex connections and the optional clock scale for the coupled solvers. */
export interface VortexForcingOptions {
  /** Read the rigid body table and accumulate wind loads. Defaults to false. */
  rigid?: boolean;
  /** Read shallow water and accumulate pressure and stress forces. Defaults to false. */
  water?: boolean;
  /** Simulated seconds per world second. Defaults to one and must match connected solvers. */
  timeScale?: number;
}

/** Adds an optional native water sampler to the ordinary forcing options. */
export interface VortexForcingLoadOptions extends VortexForcingOptions {
  /** Registry solver ID. Defaults to 'vortex'. */
  id?: string;
  /** Native participants including the caller. Use 1 (default), 2 or 4. */
  threads?: 1 | 2 | 4;
  /** Cancels native loading with the signal's reason. */
  signal?: AbortSignal;
}

/** World-clock vortex readers, rigid wind loads and conservative shallow-water momentum sources. */
export class VortexForcing implements Solver<VortexParams> {
  readonly probeField: FieldDescriptor;
  /** [Fx,Fy,Fz,Tx,Ty,Tz,utilization,failed], one row per configured body. */
  readonly loadField: FieldDescriptor;
  private host!: SolverHost;
  private vortex!: StormVortex;
  private readonly timeScale: number;
  private waterBuilds?: VortexWaterBuilds;
  private waterKernel?: VortexWaterKernel;
  private nativeWork?: VortexWaterWorkCounts;
  private disposed = false;
  private running = false;
  private probeTrial!: Float64Array;
  private loadTrial!: Float64Array;
  private bodyTrial?: Float64Array;
  private waterTrial?: Float64Array;
  private probes: readonly Vec3[] = [];
  private targets: readonly RigidTarget[] = [];
  private water?: Water;
  private probeRegion!: Region;
  private loadRegion!: Region;
  private bodiesOut?: Region;
  private waterOut?: Region;
  private cellSize = 4096;
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  constructor(
    readonly id = 'vortex',
    private readonly options: VortexForcingOptions = {},
  ) {
    if (!options || typeof id !== 'string' || id.trim().length === 0)
      throw vortexError('Use a nonempty vortex ID and a valid options object.');
    this.timeScale = positive(options.timeScale ?? 1, 'time scale');
    this.probeField = {
      name: `${id}:weather`,
      kind: 'particleSet',
      centring: 'particle',
      quantity: 'air velocity, density, temperature, pressure',
      unit: 'm/s, kg/m^3, K, Pa',
    };
    this.loadField = {
      name: `${id}:load`,
      kind: 'bodySet',
      centring: 'particle',
      quantity: 'force, torque, limit utilization and failure',
      unit: 'N, N m, 1',
    };
  }

  /** Loads the optional batched water forcing. The ordinary constructor uses the scalar sampler. */
  static async load(options: VortexForcingLoadOptions = {}): Promise<VortexForcing> {
    if (!options) throw vortexError('Pass vortex load options as an object or omit them.');
    const forcing = new VortexForcing(options.id, options);
    if (!options.water && (options.threads ?? 1) !== 1)
      throw vortexError('Enable water forcing before requesting native helper threads.');
    options.signal?.throwIfAborted();
    if (options.water) forcing.waterBuilds = await loadVortexWaterBuilds(options.signal, options.threads);
    return forcing;
  }

  /** Releases native helpers after the world stops using them. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    if (this.running) throw vortexError('Dispose a vortex between world steps.');
    this.disposed = true;
    this.waterBuilds?.[Symbol.dispose]();
  }

  describe() {
    const fields: FieldUse[] = [
      { field: this.probeField, access: 'write' },
      { field: this.loadField, access: 'write' },
    ];
    if (this.options.rigid)
      fields.push({ field: BODIES_FIELD, access: 'read' }, { field: BODY_FORCES_FIELD, access: 'accumulate' });
    if (this.options.water)
      fields.push(
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      );
    return { id: this.id, rate: 0 as const, stableRate: () => 0 as const, timeScale: () => this.timeScale, fields };
  }

  init(host: SolverHost, params: VortexParams): void {
    if (this.disposed) throw vortexError('Load a new vortex after disposing the solver.', 'disposed');
    if (this.host && this.waterBuilds?.pool)
      throw vortexError('Load a separate threaded vortex for each world.', 'attached');
    if (this.running) throw vortexError('Attach a vortex between world steps.');
    try {
      this.initialize(host, params);
    } catch (cause) {
      if (this.waterBuilds?.pool) this[Symbol.dispose]();
      throw cause;
    }
  }

  private initialize(host: SolverHost, params: VortexParams): void {
    if (!(params?.vortex instanceof StormVortex))
      throw vortexError('Vortex forcing needs a StormVortex instance. Supply it in vortex.');
    this.host = host;
    this.vortex = params.vortex;
    this.cellSize = positive(params.cellSize ?? 4096, 'origin cell size');
    const probes = params.probes ?? [[0, 10, 0]];
    if (!Array.isArray(probes)) throw vortexError('Supply an array of three-component vortex probes.');
    this.probes = probes.map((v) => vector(v, 'probe'));
    if (this.options.rigid) {
      const rigid = params.rigid;
      if (!rigid || !Array.isArray(rigid.bodies))
        throw vortexError('Vortex rigid coupling lacks body rows. You must supply rigid capacity and bodies.');
      const capacity = extent(rigid.capacity, 'body capacity'),
        used = new Set<number>();
      this.targets = rigid.bodies.map((row) => {
        if (!row || !Number.isSafeInteger(row.body) || row.body < 0 || row.body >= capacity || used.has(row.body))
          throw vortexError(
            'Vortex body rows must be distinct and within capacity. Match the RigidSolver row numbers.',
          );
        used.add(row.body);
        return {
          row: row.body,
          area: positive(row.area, 'projected area'),
          drag: positive(row.drag ?? 1, 'body drag coefficient'),
          lever: vector(row.lever ?? ZERO_LEVER, 'pressure lever'),
          limit: row.forceLimit === undefined ? Infinity : positive(row.forceLimit, 'force limit'),
        };
      });
      this.bodiesOut = this.output('body-forces', capacity * FORCE_WORDS);
      this.bodyTrial = new Float64Array(this.bodiesOut.byteLength / 8);
    }
    if (this.options.water) {
      const water = params.water;
      if (!water || water.spacing?.length !== 2 || water.origin?.length !== 2)
        throw vortexError(
          'Vortex water coupling lacks a grid. Supply dimensions, spacing and origin of the shallow water.',
        );
      const width = extent(water.width, 'water width'),
        depth = extent(water.depth, 'water depth');
      this.water = {
        width,
        depth,
        dx: positive(water.spacing[0], 'water spacing x'),
        dz: positive(water.spacing[1], 'water spacing z'),
        x: finite(water.origin[0], 'water origin x'),
        z: finite(water.origin[1], 'water origin z'),
        y: finite(water.level ?? 0, 'water elevation'),
        density: positive(water.density ?? 1025, 'water density'),
        wind: water.windStress ?? true,
      };
      this.waterOut = this.output('water-forces', width * depth * FORCING_WORDS);
      this.waterTrial = new Float64Array(this.waterOut.byteLength / 8);
      if (this.waterBuilds) this.waterKernel = bindVortexWaterKernel(host, this.waterBuilds, width * depth);
    }
    this.probeRegion = this.output('samples', this.probes.length * PROBE_WORDS);
    this.loadRegion = this.output('loads', this.targets.length * LOAD_WORDS);
    this.probeTrial = new Float64Array(this.probeRegion.byteLength / 8);
    this.loadTrial = new Float64Array(this.loadRegion.byteLength / 8);
    this.nativeWork = undefined;
  }

  private output(name: string, words: number): Region {
    try {
      return this.host.allocate('vortex-' + name, words * 8, 'f64', VORTEX_LAYOUT);
    } catch (cause) {
      throw vortexError('Reduce body capacity or grid dimensions to fit vortex arena memory.', 'state', cause);
    }
  }

  private words(region: Region): Float64Array {
    return regionWords(region.memory ?? this.host.memory, region) as Float64Array;
  }

  private offset(cell: Cell): Vec3 {
    const { cell: base } = this.vortex,
      size = this.cellSize;
    requireVortexCell(cell);
    requireVortexCell(base);
    return vector([(cell[0] - base[0]) * size, (cell[1] - base[1]) * size, (cell[2] - base[2]) * size], 'cell offset');
  }

  private windAt(x: number, y: number, z: number, time: number): FlowSample {
    const air = this.vortex.sample(x, y, z, time, this.sample);
    if (
      air?.velocity?.length !== 3 ||
      !Number.isFinite(air.velocity[0]) ||
      !Number.isFinite(air.velocity[1]) ||
      !Number.isFinite(air.velocity[2]) ||
      !(air.density >= 0 && Number.isFinite(air.density)) ||
      !(air.temperature > 0 && Number.isFinite(air.temperature))
    )
      throw vortexError('Return finite wind, nonnegative density and positive temperature from the vortex sampler.');
    return air;
  }

  private publishProbes(time: number, cell: Cell): void {
    const output = this.probeTrial,
      [ox, oy, oz] = this.offset(cell);
    for (let i = 0; i < this.probes.length; i++) {
      const [x, y, z] = this.probes[i]!,
        at = i * PROBE_WORDS;
      const wind = this.windAt(x + ox, y + oy, z + oz, time);
      output[at] = wind.velocity[0];
      output[at + 1] = wind.velocity[1];
      output[at + 2] = wind.velocity[2];
      output[at + 3] = wind.density;
      output[at + 4] = wind.temperature;
      output[at + 5] = this.vortex.pressureAt(x + ox, z + oz, time);
    }
  }

  private applyBodies(time: number, dt: number, input?: Port): void {
    const output = this.bodyTrial,
      loads = this.loadTrial;
    if (!output) return;
    output.fill(0);
    if (!input) return;
    const { region, cell } = input;
    if (
      region.type !== 'f32' ||
      region.layout !== 2 ||
      region.byteLength / (BODY_WORDS * 4) !== output.length / FORCE_WORDS
    )
      throw vortexError(
        'Vortex rigid field layout or capacity differs. You must attach the matching RigidSolver body table.',
      );
    this.inputWords(region);
    const [ox, oy, oz] = this.offset(cell);
    for (let i = 0; i < this.targets.length; i++) {
      const item = this.targets[i]!;
      const at = item.row * BODY_WORDS;
      const li = i * LOAD_WORDS;
      const [rx, ry, rz] = item.lever;
      const [px, py, pz, vx, vy, vz, ax, ay, az, inverseMass] = this.inputWords(region).subarray(at + 7, at + 17);
      const invMass = finite(inverseMass!, 'inverse body mass');
      const air = this.windAt(px! + rx + ox, py! + ry + oy, pz! + rz + oz, time);
      const u = air.velocity[0] - (vx! + ay! * rz - az! * ry);
      const v = air.velocity[1] - (vy! + az! * rx - ax! * rz);
      const w = air.velocity[2] - (vz! + ax! * ry - ay! * rx);
      const raw = 0.5 * air.density * item.drag * item.area * hypot(u, v, w);
      // Average the exact one-axis quadratic drag step with fixed wind, preventing an explicit overshoot.
      const factor = raw / (1 + dt * Math.max(0, invMass) * raw);
      const fx = factor * u,
        fy = factor * v,
        fz = factor * w;
      const tx = ry * fz - rz * fy,
        ty = rz * fx - rx * fz,
        tz = rx * fy - ry * fx;
      const utilization = item.limit === Infinity ? 0 : (raw * hypot(u, v, w)) / item.limit;
      loads[li] = fx;
      loads[li + 1] = fy;
      loads[li + 2] = fz;
      loads[li + 3] = tx;
      loads[li + 4] = ty;
      loads[li + 5] = tz;
      loads[li + 6] = utilization;
      loads[li + 7] = Math.max(loads[li + 7]!, Number(utilization >= 1));
      if (invMass > 0) {
        const target = item.row * FORCE_WORDS;
        output[target] = fx;
        output[target + 1] = fy;
        output[target + 2] = fz;
        output[target + 3] = tx;
        output[target + 4] = ty;
        output[target + 5] = tz;
      }
    }
  }

  private inputWords(region: Region): Float32Array {
    try {
      return regionWords(region.memory ?? this.host.memory, region) as Float32Array;
    } catch (cause) {
      throw vortexError('Publish aligned vortex input in the memory that owns it.', 'state', cause);
    }
  }

  private applyWater(time: number, input?: Port): boolean {
    const output = this.waterTrial;
    if (!output || !this.water) return false;
    output.fill(0);
    if (!input) return false;
    const { region, cell } = input,
      grid = this.water;
    if (
      region.type !== 'f32' ||
      region.layout !== SURFACE_WATER_LAYOUT ||
      region.byteLength !== grid.width * grid.depth * 3 * 4
    )
      throw vortexError(
        'Vortex water grid differs from its surface field. You must match the ShallowWaterSolver geometry.',
      );
    const water = this.inputWords(region);
    for (let at = 0; at < water.length; at += 3) {
      if (!Number.isFinite(water[at]) || water[at]! < 0)
        throw vortexError('Supply a finite nonnegative depth at every vortex water cell.');
    }
    const [ox, oy, oz] = this.offset(cell);
    const { dx, dz, density } = grid;
    const builtIn =
      Object.getPrototypeOf(this.vortex) === StormVortex.prototype &&
      this.vortex.sample === StormVortex.prototype.sample &&
      this.vortex.pressureDeficit === StormVortex.prototype.pressureDeficit;
    if (this.waterKernel && builtIn) {
      this.waterKernel.apply(
        water,
        this.vortex.waterProfile(),
        {
          width: grid.width,
          depth: grid.depth,
          dx,
          dz,
          originX: grid.x,
          originZ: grid.z,
          offsetX: ox,
          offsetZ: oz,
          sampleY: grid.y + 10 + oy,
          density,
          time,
          windStress: grid.wind,
        },
        output,
      );
      return true;
    }
    const waterRows = builtIn ? water : water.slice();
    for (let j = 0; j < grid.depth; j++)
      for (let i = 0; i < grid.width; i++) {
        const k = j * grid.width + i,
          h = waterRows[3 * k]!,
          at = k * FORCING_WORDS;
        if (h <= 0) continue;
        const x = grid.x + i * dx + ox,
          z = grid.z + j * dz + oz;
        const dpx = this.vortex.pressureDeficit(x + dx / 2, z, time) - this.vortex.pressureDeficit(x - dx / 2, z, time);
        const dpz = this.vortex.pressureDeficit(x, z + dz / 2, time) - this.vortex.pressureDeficit(x, z - dz / 2, time);
        let fx = (h * dpx) / dx,
          fz = (h * dpz) / dz;
        if (grid.wind) {
          const air = this.windAt(x, grid.y + 10 + oy, z, time);
          const u = air.velocity[0],
            v = air.velocity[2],
            speed = hypot(u, v);
          const stress = air.density * stormWaterDrag(speed) * speed;
          fx += stress * u;
          fz += stress * v;
        }
        output[at] = fx / density;
        output[at + 1] = fz / density;
      }
    return false;
  }

  step(context: StepContext, dt: number): void {
    if (!this.probeRegion) throw vortexError('Add the vortex to a PhysicsWorld before stepping.');
    if (this.disposed) throw vortexError('Load a new vortex after disposing the solver.', 'disposed');
    if (this.running) throw vortexError('Call the vortex between steps. Keep flow sampling read-only.');
    requireVortexCell(context.cell);
    if (!Number.isFinite(dt) || dt < 0) throw vortexError('Use a finite nonnegative vortex world step in seconds.');
    this.running = true;
    try {
      const time = finite((context.tick + 1) * dt * this.timeScale, 'sample time');
      this.loadTrial.set(this.words(this.loadRegion));
      this.publishProbes(time, context.cell);
      this.applyBodies(time, dt, context.inputs.get(BODIES_FIELD.name));
      const native = this.applyWater(time, context.inputs.get(SURFACE_WATER_FIELD.name));
      this.commit();
      this.nativeWork = native ? this.waterKernel?.workCounts() : undefined;
    } finally {
      this.running = false;
    }
  }

  private commit(): void {
    const rows: Array<readonly [Region, Float64Array]> = [
      [this.probeRegion, this.probeTrial],
      [this.loadRegion, this.loadTrial],
    ];
    if (this.bodiesOut && this.bodyTrial) rows.push([this.bodiesOut, this.bodyTrial]);
    if (this.waterOut && this.waterTrial) rows.push([this.waterOut, this.waterTrial]);
    for (const [, source] of rows) {
      if (!source.every(Number.isFinite))
        throw vortexError(
          'Vortex trial exceeds numeric range. Use smaller local coordinates, loads or time scale.',
          'failed',
        );
    }
    for (const [target, source] of rows) this.words(target).set(source);
  }

  /** Copies row and SIMD work for the most recent accepted native water step. */
  readNativeWork(): VortexWaterWorkCounts | undefined {
    const work = this.nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  exportPorts(tick: number): readonly Port[] {
    const cell = this.host.cell;
    const ports = [
      { field: this.probeField.name, region: this.probeRegion, tick, cell },
      { field: this.loadField.name, region: this.loadRegion, tick, cell },
    ];
    if (this.bodiesOut) ports.push({ field: BODY_FORCES_FIELD.name, region: this.bodiesOut, tick, cell });
    if (this.waterOut) ports.push({ field: SURFACE_WATER_FORCING_FIELD.name, region: this.waterOut, tick, cell });
    return ports;
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const state = [this.probeRegion, this.loadRegion];
    if (this.bodiesOut) state.push(this.bodiesOut);
    if (this.waterOut) state.push(this.waterOut);
    return state;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Last sampled wind and pressure at a configured probe. */
  weather(index = 0): FlowSample & { pressure: number } {
    if (!Number.isInteger(index) || index < 0 || index >= this.probes.length)
      throw vortexError('Vortex probe index is outside the list. Pass a configured probe index.');
    const at = index * PROBE_WORDS,
      q = this.words(this.probeRegion);
    return {
      velocity: [q[at]!, q[at + 1]!, q[at + 2]!],
      density: q[at + 3]!,
      temperature: q[at + 4]!,
      pressure: q[at + 5]!,
    };
  }

  /** Last force, moment and retained limit crossing for a configured body. */
  load(index = 0): VortexLoadReading {
    if (!Number.isInteger(index) || index < 0 || index >= this.targets.length)
      throw vortexError('Vortex load index is outside the list. Pass a configured body index.');
    const at = index * LOAD_WORDS,
      q = this.words(this.loadRegion);
    return {
      force: [q[at]!, q[at + 1]!, q[at + 2]!],
      torque: [q[at + 3]!, q[at + 4]!, q[at + 5]!],
      utilization: q[at + 6]!,
      failed: q[at + 7]! !== 0,
    };
  }
}

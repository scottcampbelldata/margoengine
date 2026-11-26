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
import { StormVortex, stormWaterDrag } from './model.js';

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
const ZERO: Cell = [0, 0, 0];
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
  if (!Number.isFinite(value)) throw new RangeError(`Vortex ${label} must be finite. Pass an SI value.`);
  return value;
}
function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0)) throw new RangeError(`Vortex ${label} must be positive. Pass a value above zero.`);
  return value;
}
function extent(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`Invalid vortex ${label}. Pass a positive whole count.`);
  return value;
}
function vector(value: Vec3, label: string): Vec3 {
  if (value.length !== 3)
    throw new RangeError(`Vortex ${label} requires xyz coordinates. Pass a three-element vector.`);
  return [finite(value[0], label), finite(value[1], label), finite(value[2], label)];
}

/** World-clock vortex readers, rigid wind loads and conservative shallow-water momentum sources. */
export class VortexForcing implements Solver<VortexParams> {
  readonly probeField: FieldDescriptor;
  /** [Fx,Fy,Fz,Tx,Ty,Tz,utilization,failed], one row per configured body. */
  readonly loadField: FieldDescriptor;
  private host!: SolverHost;
  private vortex!: StormVortex;
  private cell: Cell = ZERO;
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
    private readonly options: { rigid?: boolean; water?: boolean } = {},
  ) {
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
    return { id: this.id, rate: 0 as const, stableRate: () => 0 as const, fields };
  }

  init(host: SolverHost, params: VortexParams): void {
    this.host = host;
    if (!(params?.vortex instanceof StormVortex))
      throw new TypeError('Vortex forcing needs a StormVortex instance. Supply it in vortex.');
    this.vortex = params.vortex;
    this.cellSize = positive(params.cellSize ?? 4096, 'origin cell size');
    this.probes = (params.probes ?? [[0, 10, 0]]).map((v) => vector(v, 'probe'));
    if (this.options.rigid) {
      const rigid = params.rigid;
      if (!rigid) throw new RangeError('Vortex rigid coupling lacks body rows. Supply rigid capacity and bodies.');
      const capacity = extent(rigid.capacity, 'body capacity'),
        used = new Set<number>();
      this.targets = rigid.bodies.map((row) => {
        if (!Number.isSafeInteger(row.body) || row.body < 0 || row.body >= capacity || used.has(row.body))
          throw new RangeError(
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
      this.bodiesOut = host.allocate('vortex-body-forces', capacity * FORCE_WORDS * 8, 'f64', VORTEX_LAYOUT);
    }
    if (this.options.water) {
      const water = params.water;
      if (!water) throw new RangeError('Vortex water coupling lacks a grid. Supply the shallow-water grid.');
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
      this.waterOut = host.allocate('vortex-water-forces', width * depth * FORCING_WORDS * 8, 'f64', VORTEX_LAYOUT);
    }
    this.probeRegion = host.allocate('vortex-samples', this.probes.length * PROBE_WORDS * 8, 'f64', VORTEX_LAYOUT);
    this.loadRegion = host.allocate('vortex-loads', this.targets.length * LOAD_WORDS * 8, 'f64', VORTEX_LAYOUT);
  }

  private words(region: Region): Float64Array {
    return regionWords(region.memory ?? this.host.memory, region) as Float64Array;
  }

  private offset(cell: Cell): Vec3 {
    const { cell: base } = this.vortex,
      size = this.cellSize;
    return [(cell[0] - base[0]) * size, (cell[1] - base[1]) * size, (cell[2] - base[2]) * size];
  }

  private publishProbes(time: number): void {
    const output = this.words(this.probeRegion),
      [ox, oy, oz] = this.offset(this.cell);
    for (let i = 0; i < this.probes.length; i++) {
      const [x, y, z] = this.probes[i]!,
        at = i * PROBE_WORDS;
      const wind = this.vortex.sample(x + ox, y + oy, z + oz, time, this.sample);
      output[at] = wind.velocity[0];
      output[at + 1] = wind.velocity[1];
      output[at + 2] = wind.velocity[2];
      output[at + 3] = wind.density;
      output[at + 4] = wind.temperature;
      output[at + 5] = this.vortex.pressureAt(x + ox, z + oz, time);
    }
  }

  private applyBodies(time: number, dt: number, input?: Port): void {
    if (!this.bodiesOut) return;
    const output = this.words(this.bodiesOut),
      loads = this.words(this.loadRegion);
    output.fill(0);
    if (!input) return;
    const { region, cell } = input;
    if (
      region.type !== 'f32' ||
      region.layout !== 2 ||
      region.byteLength / (BODY_WORDS * 4) !== output.length / FORCE_WORDS
    )
      throw new RangeError(
        'Vortex rigid field layout or capacity differs. Attach the matching RigidSolver body table.',
      );
    const bodies = regionWords(region.memory ?? this.host.memory, region) as Float32Array;
    const [ox, oy, oz] = this.offset(cell);
    for (let i = 0; i < this.targets.length; i++) {
      const item = this.targets[i]!,
        at = item.row * BODY_WORDS,
        li = i * LOAD_WORDS;
      const [rx, ry, rz] = item.lever;
      const air = this.vortex.sample(
        bodies[at + 7]! + rx + ox,
        bodies[at + 8]! + ry + oy,
        bodies[at + 9]! + rz + oz,
        time,
        this.sample,
      );
      const u = air.velocity[0] - (bodies[at + 10]! + bodies[at + 14]! * rz - bodies[at + 15]! * ry);
      const v = air.velocity[1] - (bodies[at + 11]! + bodies[at + 15]! * rx - bodies[at + 13]! * rz);
      const w = air.velocity[2] - (bodies[at + 12]! + bodies[at + 13]! * ry - bodies[at + 14]! * rx);
      const raw = 0.5 * air.density * item.drag * item.area * hypot(u, v, w);
      const invMass = bodies[at + 16]!;
      // Average the exact one-axis quadratic drag step with fixed wind, preventing an explicit overshoot.
      const factor = raw / (1 + dt * Math.max(0, invMass) * raw);
      const fx = factor * u,
        fy = factor * v,
        fz = factor * w;
      const tx = ry * fz - rz * fy,
        ty = rz * fx - rx * fz,
        tz = rx * fy - ry * fx;
      const utilization = (raw * hypot(u, v, w)) / item.limit;
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

  private applyWater(time: number, input?: Port): void {
    if (!this.waterOut || !this.water) return;
    const output = this.words(this.waterOut);
    output.fill(0);
    if (!input) return;
    const { region, cell } = input,
      grid = this.water;
    if (
      region.type !== 'f32' ||
      region.layout !== SURFACE_WATER_LAYOUT ||
      region.byteLength !== grid.width * grid.depth * 3 * 4
    )
      throw new RangeError('Vortex water grid differs from its surface field. Match the ShallowWaterSolver geometry.');
    const water = regionWords(region.memory ?? this.host.memory, region) as Float32Array;
    const [ox, oy, oz] = this.offset(cell);
    const { dx, dz, density } = grid;
    for (let j = 0; j < grid.depth; j++)
      for (let i = 0; i < grid.width; i++) {
        const k = j * grid.width + i,
          h = water[3 * k]!,
          at = k * FORCING_WORDS;
        if (h <= 0) continue;
        const x = grid.x + i * dx + ox,
          z = grid.z + j * dz + oz;
        const dpx = this.vortex.pressureDeficit(x + dx / 2, z, time) - this.vortex.pressureDeficit(x - dx / 2, z, time);
        const dpz = this.vortex.pressureDeficit(x, z + dz / 2, time) - this.vortex.pressureDeficit(x, z - dz / 2, time);
        let fx = (h * dpx) / dx,
          fz = (h * dpz) / dz;
        if (grid.wind) {
          const air = this.vortex.sample(x, grid.y + 10 + oy, z, time, this.sample);
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
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const time = (context.tick + 1) * dt;
    this.publishProbes(time);
    this.applyBodies(time, dt, context.inputs.get(BODIES_FIELD.name));
    this.applyWater(time, context.inputs.get(SURFACE_WATER_FIELD.name));
  }

  exportPorts(tick: number): readonly Port[] {
    const ports = [
      { field: this.probeField.name, region: this.probeRegion, tick, cell: this.cell },
      { field: this.loadField.name, region: this.loadRegion, tick, cell: this.cell },
    ];
    if (this.bodiesOut) ports.push({ field: BODY_FORCES_FIELD.name, region: this.bodiesOut, tick, cell: this.cell });
    if (this.waterOut)
      ports.push({ field: SURFACE_WATER_FORCING_FIELD.name, region: this.waterOut, tick, cell: this.cell });
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
      throw new RangeError('Vortex probe index is outside the list. Pass a configured probe index.');
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
      throw new RangeError('Vortex load index is outside the list. Pass a configured body index.');
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

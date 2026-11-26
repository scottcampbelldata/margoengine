// Rivers, floods and dam breaks (HYDRO-01 of docs/physics-solvers.md): conservative shallow water on the terrain bed, a
// framework solver. Water runs over a `Bed`: the world's `TerrainBed` (`terrain.bed`, the `BedSurface` over the elevations it
// publishes, read in place every step) or a bed of its own, wets and dries the ground as it goes, loses speed to Manning's bed friction, and
// takes in rivers' inflows, rain and the wind's stress; its sides are walls, open water, a set level (a lake),
// the open sea at a level that lets waves leave, or periodic pairs; and the surf's waves drive it through `surfaceWaterForcing`.
//
// The scheme is the kernel of shallow.ts (Chen and Noelle's hydrostatic reconstruction, HLL with Kurganov and Petrova's
// speeds, WENO-Z or minmod, the semi-implicit Manning friction of Chertock et al.) with two-stage SSP Runge-Kutta (Shu and
// Osher 1988, U1 = U + dt L(U), U' = (U + U1 + dt L(U1)) / 2), in substeps that keep the Courant number at most `courant`,
// as many as each tick needs, each found from the state, so the run is the same bits however it is stepped.
//
// The bed of a cell is the mean of the bed over it on the kernel's two triangles, (z00 + 2 z10 + 2 z01 + z11) / 6 with the
// diagonal's two vertices counted twice (`bedVertexAreas`), so the water's volume is measured on the same surface colliders
// and slides use.
//
// Fields. It owns `surfaceWater`: per cell, depth h (m) and the discharges hu and hv (m^2/s), f32, x fastest.
//
// State: h, hu and hv per cell in f64, and the ledger of water that came in and went out (inflow, rain, the sides).
import type { Bed, FlowField, FlowSample, Precipitation, Wind } from '@margoengine/math/fields';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { type BedShape, bedVertexCount } from '../earth/bed.js';
import { regionWords } from '../world/memory.js';
import {
  type Cell,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { DRY, manning, type ShallowGrid, type ShallowSide, shallowRates, velocityOf } from './shallow.js';

export { DRY, manning, type ShallowGrid, type ShallowSide, shallowRates, velocityOf } from './shallow.js';

/** The registry field of the water on the ground: per cell h (m), hu and hv (m^2/s), owned by {@link ShallowWaterSolver}. */
export const SURFACE_WATER_FIELD: FieldDescriptor = {
  name: 'surfaceWater',
  kind: 'uniformGrid',
  quantity: 'waterDepthAndDischarge',
  unit: 'm, m^2/s',
  centring: 'cell',
};
/** The layout of the solver's regions: per cell (x fastest), h, hu, hv. */
export const SURFACE_WATER_LAYOUT = 1;
/**
 * The registry field the water takes waves' forcing from, owned by {@link ShallowWaterSolver}: per cell, the force of the
 * waves' radiation stress over the water's density (m^2/s^2 along x and z: the momentum per area per second it adds), the
 * waves' Stokes drift (m/s along x and z: the water's momentum is Lagrangian, its bed friction acts on what is left of it),
 * and the waves' rms orbital velocity at the bed (m/s: it stirs the bed friction). Contributors (the surf zone) add; the
 * registry sums them by contributor, then cell.
 */
export const SURFACE_WATER_FORCING_FIELD: FieldDescriptor = {
  name: 'surfaceWaterForcing',
  kind: 'uniformGrid',
  quantity: 'waveForcing',
  unit: 'm^2/s^2, m/s',
  centring: 'cell',
};
/** f64 words of a cell's record in `surfaceWaterForcing`: force x, z over density, Stokes drift x, z, rms orbital velocity. */
export const FORCING_WORDS = 5;
/** Fresh water's density, kg/m^3. */
export const WATER_DENSITY = 1000;
/** Manning's n of a natural channel, clean and straight (Chow 1959, table 5-6), s/m^(1/3): the default roughness. */
export const DEFAULT_ROUGHNESS = 0.03;

/** An inflow: `discharge` m^3/s (or a function of time) into the cell at `position` [x, z] m. */
export interface ShallowInflow {
  readonly position: readonly [number, number];
  readonly discharge: number | ((time: number) => number);
}

/** Points where runoff from an upstream drainage solver enters the shallow-water grid. */
export interface ShallowRunoffInput {
  /** Layout-1 f64 outlet discharges, in m³/s, such as a RainfallRunoff outletField. */
  readonly field: FieldDescriptor;
  /** Map each selected index in the upstream outlet grid to [x, z] metres on the shallow-water bed. */
  readonly outlets: ReadonlyArray<{ readonly sourceCell: number; readonly position: readonly [number, number] }>;
}

/**
 * A building standing on the ground: the box from `min` to `max` [x, z] m raises the bed of every cell whose centre is in it
 * by `height` m (the building-block method of Schubert and Sanders 2012), so water flows round it, and over it only when
 * deeper than it is tall.
 */
export interface ShallowBuilding {
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  readonly height: number;
}

/** What a {@link ShallowWaterSolver} is made from. */
export interface ShallowWaterParams {
  /**
   * The ground: the world's terrain (`terrain.bed` of a `TerrainBed` added before it, so erosion, slides and craters change
   * the flood) or a bed of its own (`bedSurface` of `@margoengine/physics/earth`), read every step. The water's cells are
   * the bed's.
   */
  readonly bed: Bed;
  /** The water's surface at the start, m: a height or a function of (x, z); cells whose bed is above it start dry. */
  readonly level?: number | ((x: number, z: number) => number);
  /** Or the water's depth at the start, m, a number or a function of (x, z) (default none: dry). */
  readonly depth?: number | ((x: number, z: number) => number);
  /** The water's velocity at the start, [u, v] m/s along x and z as a function of (x, z) (default still). */
  readonly velocity?: (x: number, z: number) => readonly [number, number];
  /** Manning's n, s/m^(1/3), a number or a function of (x, z) (default 0.03, a natural channel; 0 for none). */
  readonly roughness?: number | ((x: number, z: number) => number);
  /**
   * The four sides, each 'wall' (default), 'open', `{level}` (a lake or sea held at a level, m, or a function of time: long waves
   * reflect from it), `{sea}` (the open sea at a level, which lets waves from inside leave), or 'periodic' (with its opposite).
   */
  readonly sides?: {
    readonly minX?: ShallowSide;
    readonly maxX?: ShallowSide;
    readonly minZ?: ShallowSide;
    readonly maxZ?: ShallowSide;
  };
  /** Buildings and walls standing in the water's way (default none). */
  readonly buildings?: readonly ShallowBuilding[];
  /** Rivers and pipes pouring in. */
  readonly inflows?: readonly ShallowInflow[];
  /** Rain falling on the water and the ground, sampled at each cell's bed (default none). */
  readonly rain?: Precipitation;
  /** The wind 10 m above the water, which drags it with the stress rho_a C_D |U| U (default none). */
  readonly wind?: Wind;
  /** The water's density, kg/m^3 (default 1000). */
  readonly density?: number;
  /** The largest Courant number of a substep (default 0.4; at most 0.5, where the scheme keeps depths positive). */
  readonly courant?: number;
  /** Its rate level (default 0, the world's base rate). */
  readonly rate?: RateLevel;
}

const ORIGIN: Cell = [0, 0, 0];
const AIR_DENSITY = 1.225;
/** The ledger's words: water that came in by the inflows, by rain, and that left over the sides (negative: came in). */
const LEDGER = 3;

/** A sample of the water: its depth, surface and depth-averaged velocity. */
export interface WaterSample {
  depth: number;
  surface: number;
  velocity: [number, number];
}

/** Conservative shallow water on the ground, a framework solver (`Solver`). */
export class ShallowWaterSolver implements Solver<ShallowWaterParams> {
  private readonly id: string;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private bedShape!: BedShape;
  private ground!: Bed;
  /** Each cell's raise by the buildings on it, m. */
  private blocks!: Float64Array;
  private grid!: ShallowGrid & { bed: Float64Array; sides: [ShallowSide, ShallowSide, ShallowSide, ShallowSide] };
  private nx = 0;
  private nz = 0;
  private x0 = 0;
  private z0 = 0;
  private g = 0;
  private roughness!: Float64Array;
  private inflows: { cell: number; discharge: number | ((time: number) => number) }[] = [];
  private runoff?: ShallowRunoffInput;
  private runoffCells: ReadonlyArray<{ readonly sourceCell: number; readonly cell: number }> = [];
  private rain: Precipitation | undefined;
  private wind: Wind | undefined;
  private density = WATER_DENSITY;
  private courant = 0.4;
  private level: RateLevel = 0;
  private state!: Region;
  private ledger!: Region;
  private published!: Region;
  private readonly flowSample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @param id The solver's id (default `'water'`).
   * @param runoff Optional drainage outlets supplied through a registry field.
   */
  constructor(id = 'water', runoff?: ShallowRunoffInput) {
    this.id = id;
    if (runoff) {
      if (runoff.field.unit !== 'm^3/s')
        throw new RangeError('Shallow-water runoff is a discharge; bind an outlet field in m^3/s.');
      const seen = new Set<number>();
      const outlets = runoff.outlets.map(({ sourceCell, position }) => {
        if (!Number.isSafeInteger(sourceCell) || sourceCell < 0 || seen.has(sourceCell))
          throw new RangeError('Invalid shallow-water runoff outlet; use a unique nonnegative source cell index.');
        seen.add(sourceCell);
        return { sourceCell, position: [position[0], position[1]] as const };
      });
      this.runoff = { field: { ...runoff.field }, outlets };
    }
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: SURFACE_WATER_FIELD, access: 'write' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'write' },
        ...(this.runoff ? [{ field: this.runoff.field, access: 'read' as const }] : []),
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  init(host: SolverHost, params: ShallowWaterParams): void {
    const { bed } = params ?? ({} as ShallowWaterParams);
    if (!bed || typeof bed !== 'object' || typeof bed.sample !== 'function' || !bed.elevations)
      throw new TypeError(
        "Shallow water runs over a bed: pass {bed}, the terrain's (terrain.bed of a TerrainBed) or one of its own (bedSurface).",
      );
    const shape: BedShape = {
      columns: bed.columns,
      rows: bed.rows,
      width: bed.width,
      depth: bed.depth,
      centre: bed.centre ?? [0, 0],
    };
    bedVertexCount(shape);
    this.bedShape = shape;
    this.ground = bed;
    this.host = host;
    this.g = gravityMagnitude(host.gravity);
    const nx = shape.columns,
      nz = shape.rows,
      dx = shape.width / nx,
      dz = shape.depth / nz,
      count = nx * nz;
    this.nx = nx;
    this.nz = nz;
    this.x0 = shape.centre[0] - shape.width / 2;
    this.z0 = shape.centre[1] - shape.depth / 2;
    const sides = params.sides ?? {},
      side = (s: ShallowSide | undefined, name: string): ShallowSide => {
        if (s === undefined || s === 'wall' || s === 'open' || s === 'periodic') return s ?? 'wall';
        if (typeof s === 'object' && s !== null) {
          const v = 'sea' in s ? s.sea : (s as { level: unknown }).level;
          if (typeof v === 'function' || Number.isFinite(v)) return s;
        }
        throw new RangeError(
          `Side ${name} is 'wall', 'open', 'periodic', {level} or {sea} with a level in metres or a function of time; got ${String(s)}.`,
        );
      };
    for (const [a, b] of [
      ['minX', 'maxX'],
      ['minZ', 'maxZ'],
    ] as const)
      if ((sides[a] === 'periodic') !== (sides[b] === 'periodic'))
        throw new RangeError(
          `Sides ${a} and ${b} are periodic together or not at all; make both 'periodic', or neither.`,
        );
    this.grid = {
      nx,
      nz,
      dx,
      dz,
      bed: new Float64Array(count),
      sides: [side(sides.minX, 'minX'), side(sides.maxX, 'maxX'), side(sides.minZ, 'minZ'), side(sides.maxZ, 'maxZ')],
      g: this.g,
      x0: this.x0,
      z0: this.z0,
    };
    const { courant = 0.4, density = WATER_DENSITY, rate = 0 } = params;
    if (!(courant > 0 && courant <= 0.5))
      throw new RangeError(
        `A Courant number lies in (0, 0.5], where the scheme keeps depths positive (got ${courant}); pass one.`,
      );
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError(
        `Water's density is a finite number of kg/m^3 above 0 (got ${density}); pass one, or leave it unset for 1000.`,
      );
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${rate}); pass one.`);
    this.courant = courant;
    this.density = density;
    this.level = rate as RateLevel;
    this.rain = params.rain;
    this.wind = params.wind;
    this.blocks = new Float64Array(count);
    for (const building of params.buildings ?? []) {
      const { min, max, height } = building ?? ({} as ShallowBuilding);
      if (
        !(
          min?.length === 2 &&
          max?.length === 2 &&
          [...min, ...max].every(Number.isFinite) &&
          min[0] < max[0] &&
          min[1] < max[1]
        )
      )
        throw new RangeError(
          'A building is a box {min: [x, z], max: [x, z], height} with min below max on both axes; pass one.',
        );
      if (!(height > 0 && Number.isFinite(height)))
        throw new RangeError(`A building's height is a finite number of metres above 0 (got ${height}); pass one.`);
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const [x, z] = this.centreOf(i, j);
          if (x >= min[0] && x <= max[0] && z >= min[1] && z <= max[1]) this.blocks[i + nx * j]! += height;
        }
    }
    // The bed at the start (read again every step).
    this.cellBeds(bed.elevations);
    this.roughness = new Float64Array(count);
    const roughness = params.roughness ?? 0.03;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const [x, z] = this.centreOf(i, j),
          n = typeof roughness === 'function' ? roughness(x, z) : roughness;
        if (!(n >= 0 && Number.isFinite(n)))
          throw new RangeError(`Manning's n is 0 or more, in s/m^(1/3) (got ${n} at ${x}, ${z}); pass one.`);
        this.roughness[i + nx * j] = n;
      }
    for (const inflow of params.inflows ?? []) {
      const cell = this.inflowCell(inflow.position);
      if (typeof inflow.discharge !== 'function' && !Number.isFinite(inflow.discharge))
        throw new RangeError(
          `An inflow's discharge is m^3/s or a function of time (got ${inflow.discharge}); pass one.`,
        );
      this.inflows.push({ cell, discharge: inflow.discharge });
    }
    this.runoffCells =
      this.runoff?.outlets.map(({ sourceCell, position }) => ({
        sourceCell,
        cell: this.inflowCell(position),
      })) ?? [];
    this.state = host.allocate('state', count * 3 * 8, 'f64', SURFACE_WATER_LAYOUT);
    this.ledger = host.allocate('ledger', LEDGER * 8, 'f64', SURFACE_WATER_LAYOUT);
    this.published = host.allocate('published', count * 3 * 4, 'f32', SURFACE_WATER_LAYOUT);
    // The start: a level or a depth, and a velocity, at each cell centre.
    this.fill(params);
    this.publish();
  }

  private inflowCell(position: readonly [number, number]): number {
    const [x, z] = position ?? [Number.NaN, Number.NaN];
    const { dx, dz } = this.grid;
    const i = Math.floor((x - this.x0) / dx);
    const j = Math.floor((z - this.z0) / dz);
    if (!(i >= 0 && i < this.nx && j >= 0 && j < this.nz))
      throw new RangeError(`An inflow at (${x}, ${z}) lies off the water's grid; put it on the bed.`);
    return i + this.nx * j;
  }

  /** Fills the water at the start from `params` over the cells' beds. */
  private fill(params: ShallowWaterParams): void {
    const { level, depth, velocity } = params,
      s = this.words(),
      { nx, nz } = this;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = i + nx * j,
          [x, z] = this.centreOf(i, j),
          b = this.grid.bed[k]!,
          top = level === undefined ? undefined : typeof level === 'function' ? level(x, z) : level,
          deep = depth === undefined ? 0 : typeof depth === 'function' ? depth(x, z) : depth;
        let h = top === undefined ? deep : Math.max(0, top - b);
        if (!Number.isFinite(h) || h < 0)
          throw new RangeError(`The water at (${x}, ${z}) starts ${h} m deep; pass a level or depth in finite metres.`);
        if (h <= DRY) h = 0;
        const [u, v] = velocity && h > 0 ? velocity(x, z) : [0, 0];
        s[3 * k] = h;
        s[3 * k + 1] = h * u;
        s[3 * k + 2] = h * v;
      }
  }

  private centreOf(i: number, j: number): [number, number] {
    return [this.x0 + (i + 0.5) * this.grid.dx, this.z0 + (j + 0.5) * this.grid.dz];
  }

  /** Each cell's bed, the mean over its two triangles, from vertex elevations in the bed's layout. */
  private cellBeds(elevations: ArrayLike<number>): void {
    const { nx, nz } = this,
      stride = nz + 1,
      bed = this.grid.bed;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const a = elevations[j + stride * i]!,
          b = elevations[j + 1 + stride * i]!,
          d = elevations[j + stride * (i + 1)]!,
          e = elevations[j + 1 + stride * (i + 1)]!;
        bed[i + nx * j] = (a + e + 2 * (b + d)) / 6 + this.blocks[i + nx * j]!;
      }
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.state) as Float64Array;
  }

  private ledgerWords(): Float64Array {
    return regionWords(this.host.memory, this.ledger) as Float64Array;
  }

  step(context: StepContext, dt: number): void {
    const port = this.runoff && context.inputs.get(this.runoff.field.name);
    let runoff: Float64Array | undefined;
    if (port) {
      if (port.region.layout !== 1 || port.region.type !== 'f64')
        throw new RangeError('Invalid shallow-water runoff layout; publish scalar layout-1 f64 discharges.');
      runoff = regionWords(this.host.memory, port.region) as Float64Array;
      for (const { sourceCell } of this.runoffCells) {
        const rate = runoff[sourceCell]!;
        if (!(rate >= 0 && Number.isFinite(rate)))
          throw new RangeError(
            'Invalid shallow-water outlet discharge; publish a finite nonnegative rate for each mapped source.',
          );
      }
    }
    this.cell = context.cell;
    this.cellBeds(this.ground.elevations);
    const t0 = context.tick / rateOf(context.level);
    let t = 0;
    while (t < dt) {
      const sub = Math.min(dt - t, this.substep());
      this.advance(t0 + t, sub, runoff);
      t += sub;
    }
    this.publish();
  }

  /** The longest substep the Courant bound allows over the wet cells. */
  private substep(): number {
    const s = this.words(),
      { nx, nz } = this,
      { dx, dz, g } = this.grid;
    let fastest = 0;
    for (let k = 0; k < nx * nz; k++) {
      const h = s[3 * k]!;
      if (h <= DRY) continue;
      const c = Math.sqrt(g * h),
        u = Math.abs(velocityOf(h, s[3 * k + 1]!)) + c,
        v = Math.abs(velocityOf(h, s[3 * k + 2]!)) + c,
        rate = u / dx + v / dz;
      if (rate > fastest) fastest = rate;
    }
    return fastest > 0 ? this.courant / fastest : Number.POSITIVE_INFINITY;
  }

  /** One substep of `dt` from time `t`: SSP Runge-Kutta 2, friction and the sources. */
  private advance(t: number, dt: number, runoff?: Float64Array): void {
    const s = this.words(),
      n = this.nx * this.nz,
      h = new Float64Array(n),
      hu = new Float64Array(n),
      hv = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      h[k] = s[3 * k]!;
      hu[k] = s[3 * k + 1]!;
      hv[k] = s[3 * k + 2]!;
    }
    const r0 = this.rates(h, hu, hv, t, runoff),
      h1 = new Float64Array(n),
      hu1 = new Float64Array(n),
      hv1 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      h1[k] = h[k]! + dt * r0.h[k]!;
      hu1[k] = hu[k]! + dt * r0.hu[k]!;
      hv1[k] = hv[k]! + dt * r0.hv[k]!;
    }
    this.settle(h1, hu1, hv1, dt);
    const r1 = this.rates(h1, hu1, hv1, t + dt, runoff),
      ledger = this.ledgerWords();
    for (let k = 0; k < n; k++) {
      h[k] = 0.5 * (h[k]! + h1[k]! + dt * r1.h[k]!);
      hu[k] = 0.5 * (hu[k]! + hu1[k]! + dt * r1.hu[k]!);
      hv[k] = 0.5 * (hv[k]! + hv1[k]! + dt * r1.hv[k]!);
    }
    this.settle(h, hu, hv, dt / 2);
    // The ledger: the step's in and out, as the two stages weigh them.
    ledger[0]! += 0.5 * dt * (r0.inflow + r1.inflow);
    ledger[1]! += 0.5 * dt * (r0.rain + r1.rain);
    ledger[2]! += 0.5 * dt * (r0.out + r1.out);
    for (let k = 0; k < n; k++) {
      s[3 * k] = h[k]!;
      s[3 * k + 1] = hu[k]!;
      s[3 * k + 2] = hv[k]!;
    }
  }

  /** dU/dt and the volumes per second the inflows and rain add and the sides take, at time `t`. */
  private rates(
    h: Float64Array,
    hu: Float64Array,
    hv: Float64Array,
    t: number,
    runoff?: Float64Array,
  ): { h: Float64Array; hu: Float64Array; hv: Float64Array; inflow: number; rain: number; out: number } {
    const n = h.length,
      rh = new Float64Array(n),
      rhu = new Float64Array(n),
      rhv = new Float64Array(n),
      out = shallowRates(this.grid, h, hu, hv, t, rh, rhu, rhv),
      area = this.grid.dx * this.grid.dz;
    let inflow = 0,
      rain = 0;
    for (const { cell, discharge } of this.inflows) {
      const q = typeof discharge === 'function' ? discharge(t) : discharge;
      if (!Number.isFinite(q)) throw new RangeError(`An inflow's discharge at ${t} s is ${q}; return m^3/s.`);
      rh[cell]! += q / area;
      inflow += q;
    }
    const forcing = this.forcing;
    if (forcing)
      for (let k = 0; k < n; k++)
        if (h[k]! > DRY) {
          rhu[k]! += forcing[FORCING_WORDS * k]!;
          rhv[k]! += forcing[FORCING_WORDS * k + 1]!;
        }
    if (runoff)
      for (const { cell, sourceCell } of this.runoffCells) {
        const q = runoff[sourceCell]!;
        rh[cell]! += q / area;
        inflow += q;
      }
    if (this.rain || this.wind) {
      const { nx, nz } = this;
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const k = i + nx * j,
            [x, z] = this.centreOf(i, j),
            b = this.grid.bed[k]!;
          if (this.rain) {
            const r = this.rain.sample(x, b, z, t).rain.rate / 3.6e6;
            rh[k]! += r;
            rain += r * area;
          }
          if (this.wind && h[k]! > DRY) {
            const air = this.wind.sample(x, b + h[k]! + 10, z, t, this.flowSample),
              u = air.velocity[0],
              w = air.velocity[2],
              speed = Math.sqrt(u * u + w * w),
              // Garratt (1977): C_D = (0.75 + 0.067 U10) 1e-3.
              cd = (0.75 + 0.067 * speed) * 1e-3,
              k2 = ((air.density || AIR_DENSITY) * cd * speed) / this.density;
            rhu[k]! += k2 * u;
            rhv[k]! += k2 * w;
          }
        }
    }
    return { h: rh, hu: rhu, hv: rhv, inflow, rain, out };
  }

  /**
   * Manning's friction over `dt` and the dry cells' momentum. With waves the momentum is Lagrangian: the friction acts on the
   * Eulerian part, h (u - u_S), stirred by the waves' orbital velocity, and the Stokes drift is carried on.
   */
  private settle(h: Float64Array, hu: Float64Array, hv: Float64Array, dt: number): void {
    const out = new Float64Array(2),
      g = this.grid.g,
      forcing = this.forcing;
    for (let k = 0; k < h.length; k++) {
      // The scheme keeps depths at or above 0 under the Courant bound; what rounding leaves below it is no water.
      if (h[k]! < 0) h[k] = 0;
      if (forcing && h[k]! > DRY) {
        const at = FORCING_WORDS * k,
          dx = h[k]! * forcing[at + 2]!,
          dz = h[k]! * forcing[at + 3]!;
        manning(g, this.roughness[k]!, h[k]!, hu[k]! - dx, hv[k]! - dz, dt, out, forcing[at + 4]!);
        hu[k] = out[0]! + dx;
        hv[k] = out[1]! + dz;
        continue;
      }
      manning(g, this.roughness[k]!, h[k]!, hu[k]!, hv[k]!, dt, out);
      hu[k] = out[0]!;
      hv[k] = out[1]!;
    }
  }

  /** Writes the state rounded once to f32 into the published region. */
  private publish(): void {
    const s = this.words(),
      p = regionWords(this.host.memory, this.published) as Float32Array;
    p.set(s);
  }

  /** The waves' forcing contributors summed into `surfaceWaterForcing` this tick, or none. */
  private forcing: Float64Array | undefined;

  importPorts(_tick: number): void {
    const sum = this.host.port(SURFACE_WATER_FORCING_FIELD.name);
    if (!sum) {
      this.forcing = undefined;
      return;
    }
    const words = regionWords(this.host.memory, sum.region) as Float64Array,
      n = this.nx * this.nz;
    if (words.length !== n * FORCING_WORDS)
      throw new RangeError(
        `Contributions to "surfaceWaterForcing" have ${words.length} values; this water has ${n} cells of ${FORCING_WORDS}, so make each on the water's own grid.`,
      );
    if (!this.forcing) this.forcing = new Float64Array(n * FORCING_WORDS);
    this.forcing.set(words);
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: SURFACE_WATER_FIELD.name, region: this.published, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.state, this.ledger];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The water at (x, z) m: depth, surface and depth-averaged velocity of the cell it is in (dry: depth 0). */
  sample(x: number, z: number, out: WaterSample = { depth: 0, surface: 0, velocity: [0, 0] }): WaterSample {
    const { nx, nz } = this,
      i = Math.min(nx - 1, Math.max(0, Math.floor((x - this.x0) / this.grid.dx))),
      j = Math.min(nz - 1, Math.max(0, Math.floor((z - this.z0) / this.grid.dz))),
      k = i + nx * j,
      s = this.words(),
      h = s[3 * k]!;
    out.depth = h;
    out.surface = this.grid.bed[k]! + h;
    out.velocity[0] = velocityOf(h, s[3 * k + 1]!);
    out.velocity[1] = velocityOf(h, s[3 * k + 2]!);
    return out;
  }

  /** The grid the water lies on: the bed's cells (columns along x, rows along z), its size and its centre. */
  get shape(): BedShape {
    if (!this.host)
      throw new RangeError('This shallow water is not in a world yet; add it with world.add(water, {bed}) first.');
    return this.bedShape;
  }

  /** The water's volume, m^3. */
  volume(): number {
    const s = this.words();
    let v = 0;
    for (let k = 0; k < this.nx * this.nz; k++) v += s[3 * k]!;
    return v * this.grid.dx * this.grid.dz;
  }

  /** The water that came in by the inflows and by rain and that left over the sides since the start, m^3. */
  get budget(): { inflow: number; rain: number; out: number } {
    const l = this.ledgerWords();
    return { inflow: l[0]!, rain: l[1]!, out: l[2]! };
  }

  /** The water as a flow field: depth-averaged velocity below its surface, still air above (for tracers and bodies). */
  get flow(): FlowField {
    return {
      medium: 'water',
      cell: this.cell,
      sample: (x, y, z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        const w = this.sample(x, z);
        const under = w.depth > DRY && y <= w.surface;
        out.velocity[0] = under ? w.velocity[0] : 0;
        out.velocity[1] = 0;
        out.velocity[2] = under ? w.velocity[1] : 0;
        out.density = under ? this.density : 0;
        out.temperature = 288.15;
        return out;
      },
    };
  }
}

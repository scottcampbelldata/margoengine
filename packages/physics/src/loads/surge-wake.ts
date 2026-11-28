import { RealFft2 } from '@margoengine/math/fft';
import { hypot } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import {
  ProjectedWakeSource,
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_CELLS,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  type WakeSourceGrid,
  wakeDepths,
} from '../sea/submerged-wake.js';
import { WAKE_HEIGHT_FIELD, WAKE_LAYOUT, type WakeParams } from '../sea/wake.js';
import { hullSections } from '../seakeeping/strips.js';
import { type SubmergedWakeNode, submergedWakeNodes } from '../seakeeping/submerged-wake.js';
import type { HullMesh } from '../seakeeping/wetted.js';
import { regionWords } from '../world/memory.js';
import type {
  ElementType,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_MOBILITY_WORDS,
  BODY_WORDS,
  IMPULSE_WORDS,
} from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';
import type { FiniteQuayWake } from './finite-quay-wake.js';
import { equivalentEllipsoid } from './shapes.js';

/** A reference hull and the constant-depth dispersive grid it shares with one WakeSolver. */
export interface SurgeWakeOptions {
  /** The dynamic rigid row to guide along one horizontal world axis. */
  readonly row: number;
  /** The closed, outward-wound hull in body coordinates, with local X longitudinal and Y upward. */
  readonly mesh: HullMesh;
  /** Body-local Y of the still-water surface. Place the body at its negative world Y. */
  readonly waterline: number;
  /** One to eight depth bands from zero to the reference draft, in metres below still water. */
  readonly depths: readonly number[];
  /** Still-water depth in metres. Infinity gives deep water. */
  readonly depth: number;
  /** Density in kg/m³, default 1025. */
  readonly density?: number;
  /** Grid dimensions, X even and each dimension a product of 2, 3 and 5. */
  readonly cells: readonly [number, number];
  /** Grid spacing in metres. */
  readonly cellSize: number;
  /** Grid centre [x, z] in the shared origin cell, default [0, 0]. */
  readonly centre?: readonly [number, number];
  /** World translation axis, default 'x'. Lock both other translations and all rotations. */
  readonly axis?: 'x' | 'z';
  /** Hull stations along local X, default 24. */
  readonly stations?: number;
  /** Lower bound for source radius in metres, default one grid cell. */
  readonly minimumRadius?: number;
  /** Resolve the finite wake receiving `submergedSource`. Add that wake before the coupling. Default periodic. */
  readonly finiteReceiver?: () => FiniteQuayWake;
}

// Rigid publication is f32. Allow rounding of its unit quaternion and of the position of the reference plane.
const POSE_ROUNDOFF = 8 * 5.960464477539063e-8;

function fftLength(n: number): boolean {
  if (!Number.isInteger(n) || n < 4 || n > 4096) return false;
  for (const factor of [2, 3, 5]) while (n % factor === 0) n /= factor;
  return n === 1;
}

/**
 * Reciprocal wave work for a hull free to surge along one axis in calm water. Use an ambient-only sea for the
 * hull's other hydrodynamic loads. Create the receiving WakeSolver with `submergedSource` and `wakeParams()`,
 * leaving its other source field unconnected. In a 60 Hz staggered group run hull, coupling, wake, rigid in order.
 * Use a constant draft, no other surge load or motion constraint, and keep the source hull inside the grid.
 */
export class SurgeWakeCoupling implements Solver<undefined> {
  /** Layout-1 projected hull displacement for the receiving WakeSolver. */
  readonly submergedSource: SubmergedWakeSource;
  private readonly row: number;
  private readonly axis: 0 | 2;
  private readonly waterline: number;
  private readonly depth: number;
  private readonly density: number;
  private readonly centre: readonly [number, number];
  private readonly grid: WakeSourceGrid;
  private readonly nodes: readonly SubmergedWakeNode[];
  private readonly periodic?: {
    fft: RealFft2;
    projected: ProjectedWakeSource;
    spectrum: Float64Array;
    profile: Float64Array;
  };
  private readonly finiteReceiver?: () => FiniteQuayWake;
  private finite?: FiniteQuayWake;
  private readonly staged: Float64Array;
  private host!: SolverHost;
  private cellWork = 0;
  private capacity = 0;
  private sources!: Region;
  private impulses!: Region;

  constructor(
    options: SurgeWakeOptions,
    readonly id = 'surgeWake',
  ) {
    if (!options) throw invalidLoad('Pass the reference hull, body row, depth bands and dispersive grid.');
    const {
      row,
      mesh,
      waterline,
      depths,
      depth,
      density = 1025,
      cells,
      cellSize,
      centre = [0, 0],
      axis = 'x',
      stations = 24,
      minimumRadius = cellSize,
      finiteReceiver,
    } = options;
    if (!Number.isSafeInteger(row) || row < 0 || !Number.isFinite(waterline) || (axis !== 'x' && axis !== 'z'))
      throw invalidLoad('Pass a nonnegative rigid row, a finite local waterline and the X or Z guide axis.');
    if (finiteReceiver !== undefined && typeof finiteReceiver !== 'function')
      throw invalidLoad('Pass finiteReceiver as a function returning the attached FiniteQuayWake.');
    if (
      cells?.length !== 2 ||
      (finiteReceiver
        ? cells.some((count) => !Number.isSafeInteger(count) || count < 1) || cells[0] * cells[1] > 0x1fffffff
        : !cells.every(fftLength) || cells[0] % 2 !== 0 || cells[0] * cells[1] > SUBMERGED_WAKE_MAX_CELLS) ||
      !(cellSize > 0) ||
      cells.some((count) => !Number.isFinite(count * cellSize)) ||
      centre?.length !== 2 ||
      !centre.every(Number.isFinite)
    )
      throw invalidLoad(
        finiteReceiver
          ? 'Use positive finite wake dimensions, centre and metre spacing.'
          : 'Use a centred FFT grid of up to 1,048,576 cells, even in X, with finite positive metre spacing.',
      );
    if (
      !(depth > 0) ||
      (finiteReceiver && !Number.isFinite(depth)) ||
      !(density > 0 && Number.isFinite(density)) ||
      !(minimumRadius >= 0 && Number.isFinite(minimumRadius))
    )
      throw invalidLoad('Use positive depth and density, and a finite nonnegative minimum source radius.');
    const bands = wakeDepths(depths);
    if (
      bands.at(-1)! > depth ||
      !Number.isSafeInteger(stations) ||
      stations < 2 ||
      4 * (stations + 1) * (bands.length - 1) > SUBMERGED_WAKE_MAX_ROWS
    )
      throw invalidLoad('Use at least two stations, at most 16,384 possible source rows, and bands above the bed.');
    equivalentEllipsoid(mesh);
    const sections = hullSections(mesh, waterline, stations);
    const nodes = submergedWakeNodes(mesh, waterline, sections, bands, minimumRadius);
    if (nodes.length === 0)
      throw invalidLoad('The reference hull has no submerged surge profile. Use a wetted closed hull and its draft.');
    const [nx, nz] = cells;
    this.row = row;
    this.axis = axis === 'x' ? 0 : 2;
    this.waterline = waterline;
    this.depth = depth;
    this.density = density;
    this.centre = [...centre];
    this.nodes = nodes;
    this.grid = { nx, nz, dx: cellSize, x0: centre[0] - 0.5 * nx * cellSize, z0: centre[1] - 0.5 * nz * cellSize };
    this.finiteReceiver = finiteReceiver;
    if (!finiteReceiver)
      this.periodic = {
        fft: new RealFft2(nx, nz),
        projected: new ProjectedWakeSource(this.grid, bands, depth),
        spectrum: new Float64Array(2 * (nx / 2 + 1) * nz),
        profile: new Float64Array(nx * nz),
      };
    this.staged = new Float64Array(nodes.length * SUBMERGED_WAKE_WORDS);
    this.submergedSource = Object.freeze({
      depths: bands,
      field: Object.freeze({
        name: `${id}.submerged`,
        kind: 'surfaceSampleSet',
        quantity: SUBMERGED_WAKE_QUANTITY,
        unit: 'SI',
        centring: 'particle',
      }),
    });
  }

  /** The receiving WakeSolver's matching grid and density. Periodic waves are evolved without a sponge. */
  wakeParams({ initial, waterBelow }: Pick<WakeParams, 'initial' | 'waterBelow'> = {}): WakeParams {
    if (this.finiteReceiver)
      throw invalidLoad('Set the finite wake’s cells, origin, density and layer depths when adding it.');
    const { nx, nz, dx } = this.grid;
    return {
      cells: [nx, nz],
      cellSize: dx,
      centre: [...this.centre],
      depth: this.depth,
      density: this.density,
      sponge: 0,
      initial,
      waterBelow,
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_MOBILITY_FIELD, access: 'read' },
        { field: this.receiver()?.heightField ?? WAKE_HEIGHT_FIELD, access: 'read' },
        { field: this.submergedSource.field, access: 'write' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost): void {
    const [gx, gy, gz] = host.gravity;
    const cellWork = -gy * this.density * this.grid.dx * this.grid.dx;
    if (gx !== 0 || gz !== 0 || !(gy < 0 && cellWork > 0 && Number.isFinite(cellWork)))
      throw invalidLoad('Use gravity straight down along Y for the guided hull and wake.');
    const capacity = host.bodyRows();
    if (this.row >= capacity) throw invalidLoad('Add the RigidSolver first and select a live rigid body row.');
    const finite = this.receiver();
    if (finite) {
      finite.validateSurgeSource(this.submergedSource, this.depth, host.memory);
      const { cells, cellSize, origin } = finite.grid,
        { nx, nz, dx, x0, z0 } = this.grid;
      if (
        cells[0] !== nx ||
        cells[1] !== nz ||
        cellSize !== dx ||
        origin[0] !== x0 ||
        origin[1] !== z0 ||
        finite.density !== this.density
      )
        throw invalidLoad('Use the same XZ grid and density for guided surge and its finite wake.');
    }
    this.finite = finite;
    this.host = host;
    this.capacity = capacity;
    this.cellWork = cellWork;
    this.sources = host.allocate(`${this.id}:sources`, this.staged.byteLength, 'f64', SUBMERGED_WAKE_LAYOUT);
    this.impulses = host.allocate(`${this.id}:impulses`, capacity * IMPULSE_WORDS * 8, 'f64', 1);
  }

  step(context: StepContext, dt: number): void {
    if (context.level !== 0 || dt !== 1 / 60)
      throw invalidLoad('Step the guided hull, surge coupling, wake and rigid at 60 Hz.');
    const bodies = this.read(context, BODIES_FIELD, 'f32', 2, this.capacity * BODY_WORDS * 4) as Float32Array;
    const mobility = this.read(
      context,
      BODY_MOBILITY_FIELD,
      'f32',
      1,
      this.capacity * BODY_MOBILITY_WORDS * 4,
    ) as Float32Array;
    const eta = this.read(
      context,
      this.finite?.heightField ?? WAKE_HEIGHT_FIELD,
      'f64',
      WAKE_LAYOUT,
      8 * this.grid.nx * this.grid.nz,
    ) as Float64Array;
    const at = this.row * BODY_WORDS,
      m = this.row * BODY_MOBILITY_WORDS;
    const inverseMass = mobility[m + this.axis]!;
    const speed = bodies[at + 10 + this.axis]!;
    const response = mobility.subarray(m, m + BODY_MOBILITY_WORDS);
    if (
      bodies[at + 23] !== 1 ||
      !(inverseMass > 0 && Number.isFinite(inverseMass)) ||
      !Number.isFinite(speed) ||
      response.some((value, index) => index !== this.axis && value !== 0) ||
      bodies[at + 11] !== 0 ||
      bodies[at + 12 - this.axis] !== 0 ||
      bodies.subarray(at + 13, at + 16).some((value) => value !== 0)
    )
      throw invalidLoad(
        'Use a live dynamic hull with only its guide translation unlocked and no velocity on the locked axes.',
      );
    this.stageProfile(bodies, at);
    let { head, stiffness } = this.finite ? this.finite.surgeProfile(this.staged, eta, dt) : this.periodicProfile(eta);
    head *= this.cellWork;
    stiffness *= this.cellWork;
    // J = b ds, with ds = dt (u + inverseMass impulse/2). Its source work is
    // rho g dx² <eta + J/2, J>. Apply the opposite midpoint impulse to the rigid row.
    const impulse = (-dt * (head + 0.5 * dt * stiffness * speed)) / (1 + 0.25 * dt * dt * inverseMass * stiffness);
    const ds = dt * (speed + 0.5 * inverseMass * impulse);
    if (!(Number.isFinite(impulse) && Number.isFinite(ds)))
      throw invalidLoad('Use finite wave heights and a finite guided hull speed.');
    for (let i = 4; i < this.staged.length; i += SUBMERGED_WAKE_WORDS) {
      this.staged[i]! *= ds;
      if (!Number.isFinite(this.staged[i]))
        throw invalidLoad('Use finite hull dimensions and a finite guided displacement.');
    }
    (regionWords(this.host.memory, this.sources) as Float64Array).set(this.staged);
    (regionWords(this.host.memory, this.impulses) as Float64Array)[this.row * IMPULSE_WORDS + this.axis] = impulse;
  }

  exportPorts(tick: number): readonly Port[] {
    const cell = this.host.cell;
    return [
      { field: this.submergedSource.field.name, region: this.sources, tick, cell },
      { field: BODY_IMPULSES_FIELD.name, region: this.impulses, tick, cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.sources, this.impulses];
  }

  extraState(): readonly Region[] {
    return [];
  }

  private receiver(): FiniteQuayWake | undefined {
    const finite = this.finiteReceiver?.();
    if (this.finiteReceiver && !finite)
      throw invalidLoad('Create the finite wake before adding its guided surge coupling.');
    return finite;
  }

  private periodicProfile(eta: Float64Array): { head: number; stiffness: number } {
    const { fft, projected, spectrum, profile } = this.periodic!;
    spectrum.fill(0);
    projected.add(this.staged, fft, spectrum);
    fft.inverse(spectrum, profile);
    let head = 0,
      stiffness = 0;
    for (let i = 0; i < eta.length; i++) {
      const b = profile[i]!;
      head += b * eta[i]!;
      stiffness += b * b;
    }
    return { head, stiffness };
  }

  private read(context: StepContext, field: FieldDescriptor, type: ElementType, layout: number, bytes: number) {
    const port = context.inputs.get(field.name);
    if (
      !port ||
      port.tick !== context.tick - 1 ||
      port.region.type !== type ||
      port.region.layout !== layout ||
      port.region.byteLength !== bytes ||
      context.cell.some((value, i) => value !== port.cell[i])
    )
      throw invalidLoad(
        `Read the prior-tick ${field.name} layout ${layout} in the same cell. Couple surge, wake and rigid at 60 Hz.`,
      );
    return regionWords(port.region.memory ?? this.host.memory, port.region);
  }

  private stageProfile(bodies: Float32Array, at: number): void {
    const x = bodies[at]!,
      y = bodies[at + 1]!,
      z = bodies[at + 2]!;
    const quaternion = bodies.subarray(at + 3, at + 7);
    const forward = rotateByQuaternion([1, 0, 0], quaternion);
    const up = rotateByQuaternion([0, 1, 0], quaternion);
    const heading = forward[this.axis]!;
    if (
      ![x, y, z, ...quaternion].every(Number.isFinite) ||
      Math.abs(quaternion.reduce((sum, value) => sum + value * value, 0) - 1) > POSE_ROUNDOFF ||
      hypot(up[0], up[1] - 1, up[2]) > POSE_ROUNDOFF ||
      hypot(forward[2 - this.axis], forward[1], 0) > POSE_ROUNDOFF ||
      Math.abs(y + this.waterline) > POSE_ROUNDOFF * Math.max(1, Math.abs(y), Math.abs(this.waterline))
    )
      throw invalidLoad('Keep the hull upright at its reference waterline, with its local X aligned to the guide.');
    const sign = Math.sign(heading);
    const { nx, nz, dx, x0, z0 } = this.grid;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      const sx = x + sign * (this.axis === 0 ? node.x : -node.z);
      const sz = z + sign * (this.axis === 0 ? node.z : node.x);
      const ix = Math.floor((sx - x0) / dx - 0.5);
      const iz = Math.floor((sz - z0) / dx - 0.5);
      const reach = Math.ceil(Math.max(1, node.radius / dx)) - 1;
      if (ix - reach < 0 || iz - reach < 0 || ix + reach + 1 >= nx || iz + reach + 1 >= nz)
        throw invalidLoad('Keep the whole projected hull source inside the wake grid, or enlarge the grid.');
      const a = i * SUBMERGED_WAKE_WORDS;
      this.staged[a] = sx;
      this.staged[a + 1] = sz;
      this.staged[a + 2] = node.radius;
      this.staged[a + 3] = node.band;
      this.staged[a + 4] = sign * node.area;
    }
  }
}

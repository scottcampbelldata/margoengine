import { MargoError } from '@margoengine/math/errors';
import type { BedSample } from '@margoengine/math/fields';
import { BED_FIELD, BED_LAYOUT, type BedShape, bedSurface, bedVertexCount } from '../earth/bed.js';
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
import {
  bindViscoplasticKernel,
  loadViscoplasticBuilds,
  type ViscoplasticBuilds,
  type ViscoplasticKernel,
} from './kernel.js';

/** Binary version of the public viscoplastic fields. */
export const VISCOPLASTIC_LAYOUT = 1;
/** f64 point row: XYZ, velocity XYZ, volume, pressure, shear stress, plastic shear and presence. */
export const VISCOPLASTIC_WORDS = 11;
/** f64 inlet row: XYZ, injected velocity XYZ and flow rate in m³/s. */
export const VISCOPLASTIC_INLET_WORDS = 7;
const NATIVE_WORDS = 27;
const ORIGIN: Cell = [0, 0, 0];

type Vector = readonly [number, number, number];
type Matrix = readonly [Vector, Vector, Vector];
type Walls = readonly [boolean, boolean, boolean, boolean, boolean, boolean];

/** A material point in the local world cell. */
export interface ViscoplasticPoint {
  readonly position: Vector;
  /** Velocity in m/s. Defaults to zero. */
  readonly velocity?: Vector;
  /** Uncompressed sample volume in m³. */
  readonly volume: number;
  /** Optional initial affine velocity gradient in s⁻¹, row-major. Defaults to zero. */
  readonly velocityGradient?: Matrix;
}

/** Finite strain and rheology in SI units. */
export interface ViscoplasticMaterial {
  /** Rest density in kg/m³. Defaults to 1600. */
  readonly density?: number;
  /** Bulk modulus in Pa. Defaults to 200,000. */
  readonly bulkModulus?: number;
  /** Shear modulus in Pa. Defaults to 2,000. */
  readonly shearModulus?: number;
  /** Shear-stress threshold in Pa, measured in simple shear. Defaults to 25. */
  readonly yieldStress?: number;
  /** Herschel–Bulkley consistency in Pa sⁿ. Defaults to 20. Zero gives instantaneous plastic return. */
  readonly consistency?: number;
  /** Herschel–Bulkley exponent. Defaults to 1 (Bingham). */
  readonly exponent?: number;
  /** Newtonian solvent viscosity in Pa s, solved implicitly on occupied cells. Defaults to zero. */
  readonly solventViscosity?: number;
}

export interface ViscoplasticLoadOptions {
  /** Solver ID and field prefix. Defaults to 'viscoplastic'. */
  readonly id?: string;
  /** Optional geometry of a registered TerrainBed. Defaults to no terrain. */
  readonly terrain?: BedShape;
  /** Inlet descriptor for layout-1 f64 flow-rate rows. */
  readonly inlet?: FieldDescriptor;
  readonly signal?: AbortSignal;
}

export interface ViscoplasticOptions extends ViscoplasticMaterial {
  /** Eulerian grid size in cells. */
  readonly cells: Vector;
  /** Eulerian grid spacing in metres. */
  readonly spacing: number;
  /** Minimum corner in the solver's cell. Defaults to [0, 0, 0]. */
  readonly origin?: Vector;
  /** Size of a PhysicsWorld origin cell in metres. Defaults to 4096. */
  readonly originCellSize?: number;
  /** Initial material points. Defaults to empty when an inlet is used. */
  readonly points?: readonly ViscoplasticPoint[];
  /** Stable point capacity. Defaults to the initial point count. Set it for an inlet. */
  readonly capacity?: number;
  /** Closed faces, in low/high X, low/high Y, low/high Z order. Defaults to a closed box. */
  readonly walls?: Walls;
  /** Coulomb coefficient on closed faces and terrain. Defaults to 0.25. */
  readonly friction?: number;
}

/** Current point, with world-cell coordinates and Cauchy stress components in SI units. */
export interface ViscoplasticSample {
  readonly position: Vector;
  readonly velocity: Vector;
  readonly volume: number;
  readonly pressure: number;
  readonly shearStress: number;
  readonly plasticShear: number;
  readonly present: boolean;
}

/** Cumulative reference-volume budget and current material volume. */
export interface ViscoplasticBudget {
  readonly initialReferenceVolume: number;
  readonly injectedReferenceVolume: number;
  readonly escapedReferenceVolume: number;
  readonly escapedVolume: number;
  readonly storedReferenceVolume: number;
  readonly storedVolume: number;
  readonly activePoints: number;
  readonly substeps: number;
  readonly occupiedNodes: number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: ViscoplasticKernel;
  readonly count: number;
  readonly cells: Vector;
  readonly spacing: number;
  readonly cellSize: number;
  readonly origin: Vector;
  readonly extent: Vector;
  readonly points: Region;
  readonly candidate: Region;
  readonly model: Region;
  readonly output: Region;
  readonly nextOutput: Region;
  readonly nodes: Region;
  readonly active: Region;
  readonly diffusion?: Region;
  readonly terrain?: Region;
  readonly stats: Region;
  readonly counters: Region;
  readonly regions: readonly Region[];
}

function finite(label: string, n: number, min = -Infinity): number {
  if (!(Number.isFinite(n) && n >= min))
    throw new RangeError(`Invalid viscoplastic ${label}. Use a finite value at least ${min}.`);
  return n;
}

function positive(label: string, n: number): number {
  if (!(Number.isFinite(n) && n > 0))
    throw new RangeError(`Invalid viscoplastic ${label}. Use a positive finite value.`);
  return n;
}

function integer(label: string, n: number, min = 1): number {
  if (!(Number.isSafeInteger(n) && n >= min))
    throw new RangeError(`Invalid viscoplastic ${label}. Use a whole number at least ${min}.`);
  return n;
}

function vector(label: string, values: Vector): Vector {
  if (values?.length !== 3 || !values.every(Number.isFinite))
    throw new RangeError(`Invalid viscoplastic ${label}. Use three finite values.`);
  return [values[0], values[1], values[2]];
}

function words(s: State, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function shift(values: Vector, from: Cell, to: Cell, size: number): Vector {
  return [
    values[0] + (from[0] - to[0]) * size,
    values[1] + (from[1] - to[1]) * size,
    values[2] + (from[2] - to[2]) * size,
  ];
}

function inside(s: State, point: Vector): void {
  if (point.some((p, i) => p < s.origin[i]! || p > s.extent[i]!))
    throw new RangeError('Viscoplastic point is outside the grid. Use a point within the box.');
}

function setPoint(
  state: State,
  grain: Float64Array,
  output: Float64Array | undefined,
  i: number,
  p: ViscoplasticPoint,
): number {
  const position = vector('position', p.position);
  const velocity = vector('velocity', p.velocity ?? ORIGIN);
  const volume = positive('point volume', p.volume);
  inside(state, position);
  const gradient = p.velocityGradient;
  if (gradient && gradient.length !== 3)
    throw new RangeError('Invalid viscoplastic affine gradient. Use three rows of three values.');
  const affine = gradient
    ? [
        ...vector('gradient x row', gradient[0]),
        ...vector('gradient y row', gradient[1]),
        ...vector('gradient z row', gradient[2]),
      ]
    : Array(9).fill(0);
  grain.set([...position, ...velocity, volume, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, ...affine, 0], i * NATIVE_WORDS);
  output?.set([...position, ...velocity, volume, 0, 0, 0, 1], i * VISCOPLASTIC_WORDS);
  return volume;
}

/** A three-dimensional material-point solver with finite-strain Bingham and Herschel–Bulkley flow. */
export class ViscoplasticSolver implements Solver<ViscoplasticOptions> {
  /** World-cell positions, stress, volume and velocity for each allocated material point. */
  readonly pointField: FieldDescriptor;
  private readonly fields: readonly FieldUse[];
  private readonly bedShape?: BedShape;
  private state?: State;

  private constructor(
    private readonly builds: ViscoplasticBuilds,
    private readonly id: string,
    private readonly inlet?: FieldDescriptor,
    terrain?: BedShape,
  ) {
    this.pointField = Object.freeze({
      name: `${id}.points`,
      kind: 'particleSet',
      quantity: 'viscoplasticPoints',
      unit: 'SI',
      centring: 'particle',
    });
    if (terrain) {
      bedVertexCount(terrain);
      this.bedShape = { ...terrain, centre: [terrain.centre[0], terrain.centre[1]] };
    }
    this.fields = [
      { field: this.pointField, access: 'write' },
      ...(terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ...(inlet ? [{ field: inlet, access: 'read' as const }] : []),
    ];
  }

  /** Load only the optional native kernels. */
  static async load(options: ViscoplasticLoadOptions = {}): Promise<ViscoplasticSolver> {
    return new ViscoplasticSolver(
      await loadViscoplasticBuilds(options.signal),
      options.id ?? 'viscoplastic',
      options.inlet,
      options.terrain,
    );
  }

  describe() {
    return { id: this.id, fields: this.fields, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, options: ViscoplasticOptions): void {
    if (this.state)
      throw new MargoError('state', 'ViscoplasticSolver already belongs to a world. Load another solver.');
    const cells: Vector = [
      integer('X cells', options.cells[0]),
      integer('Y cells', options.cells[1]),
      integer('Z cells', options.cells[2]),
    ];
    const spacing = positive('cell spacing', options.spacing);
    const cellSize = positive('origin cell size', options.originCellSize ?? 4096);
    const origin = vector('grid origin', options.origin ?? ORIGIN);
    const extent: Vector = [
      finite('grid X end', origin[0] + cells[0] * spacing),
      finite('grid Y end', origin[1] + cells[1] * spacing),
      finite('grid Z end', origin[2] + cells[2] * spacing),
    ];
    if (extent.some((coord, axis) => coord <= origin[axis]!))
      throw new RangeError('Invalid viscoplastic grid precision. Use a local origin and larger cells.');
    const seeded = options.points ?? [];
    const count = integer('point capacity', options.capacity ?? seeded.length);
    if (count < seeded.length || (!seeded.length && !this.inlet))
      throw new RangeError('Invalid viscoplastic point capacity. Use a nonempty point set or a reserved inlet.');
    const walls = options.walls ?? [true, true, true, true, true, true];
    if (walls.length !== 6 || walls.some((wall) => typeof wall !== 'boolean'))
      throw new RangeError('Invalid viscoplastic boundary. Use six booleans in low/high XYZ order.');
    const mask = walls.reduce((out, wall, i) => out | (wall ? 1 << i : 0), 0);
    const density = positive('rest density', options.density ?? 1600);
    const solvent = finite('solvent viscosity', options.solventViscosity ?? 0, 0);
    const material = [
      density,
      positive('bulk modulus', options.bulkModulus ?? 200_000),
      positive('shear modulus', options.shearModulus ?? 2000),
      finite('yield stress', options.yieldStress ?? 25, 0),
      finite('flow consistency', options.consistency ?? 20, 0),
      positive('flow exponent', options.exponent ?? 1),
      solvent,
      finite('friction', options.friction ?? 0.25, 0),
      mask,
      spacing,
      ...origin,
      ...host.gravity,
    ];
    const nodeCount = integer('grid node count', (cells[0] + 3) * (cells[1] + 3) * (cells[2] + 3));
    const floats = (name: string, values: number) =>
      host.allocate(name, integer('region bytes', values * 8), 'f64', VISCOPLASTIC_LAYOUT);
    const points = floats('material', count * NATIVE_WORDS);
    const candidate = floats('working-material', count * NATIVE_WORDS);
    const model = floats('constitutive-model', material.length);
    const output = floats('point-records', count * VISCOPLASTIC_WORDS);
    const nextOutput = floats('working-records', count * VISCOPLASTIC_WORDS);
    const nodes = floats('grid', nodeCount * 4);
    const active = host.allocate(
      'active-grid-nodes',
      integer('occupied grid bytes', nodeCount * 4),
      'u32',
      VISCOPLASTIC_LAYOUT,
    );
    const diffusion = solvent > 0 ? floats('implicit-solvent', nodeCount * 10) : undefined;
    const terrain = this.bedShape ? floats('bed-samples', 4 * (cells[0] + 3) * (cells[2] + 3)) : undefined;
    const stats = floats('working-budget', 7);
    const counters = floats('volume-budget', 9);
    const kernel = bindViscoplasticKernel(host, this.builds);
    const s: State = {
      host,
      kernel,
      count,
      cells,
      spacing,
      cellSize,
      origin,
      extent,
      points,
      candidate,
      model,
      output,
      nextOutput,
      nodes,
      active,
      diffusion,
      terrain,
      stats,
      counters,
      regions: [points, model, output, counters],
    };
    words(s, model).set(material);
    const records = words(s, output);
    const grain = words(s, points);
    let initial = 0;
    for (const [i, point] of seeded.entries()) initial += setPoint(s, grain, records, i, point);
    positive('total seed mass or reserved density', initial > 0 ? initial * density : density);
    words(s, counters).set([initial, 0, 0, 0, initial, initial, seeded.length, 0, 0]);
    this.state = s;
  }

  private live(): State {
    if (!this.state) throw new MargoError('state', 'ViscoplasticSolver is not initialized. Add it to a PhysicsWorld.');
    return this.state;
  }

  private bed(s: State, context: StepContext): number {
    const port = this.bedShape && s.terrain && context.inputs.get(BED_FIELD.name);
    if (!(port && this.bedShape && s.terrain)) return 0;
    const r = port.region;
    if (r.type !== 'f32' || r.layout !== BED_LAYOUT || r.byteLength !== bedVertexCount(this.bedShape) * 4)
      throw new RangeError(
        'Invalid viscoplastic bed layout. Use the registered TerrainBed matching the declared shape.',
      );
    const bed = bedSurface(this.bedShape, regionWords(s.host.memory, r), port.cell);
    const offset = shift(ORIGIN, context.cell, port.cell, s.cellSize);
    const sampled: BedSample = { elevation: 0, normal: [0, 1, 0] };
    const rows = s.cells[2] + 3;
    const columns = s.cells[0] + 3;
    const out = words(s, s.terrain);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const x = s.origin[0] + (i - 1) * s.spacing + offset[0];
        const z = s.origin[2] + (j - 1) * s.spacing + offset[2];
        bed.sample(x, z, sampled);
        const at = 4 * (i + j * columns);
        out[at] = sampled.elevation - offset[1];
        out[at + 1] = sampled.normal[0];
        out[at + 2] = sampled.normal[1];
        out[at + 3] = sampled.normal[2];
      }
    }
    return s.terrain.byteOffset;
  }

  private inject(s: State, context: StepContext, candidate: Float64Array, dt: number): number {
    const port = this.inlet && context.inputs.get(this.inlet.name);
    if (!port) return 0;
    const r = port.region;
    if (r.type !== 'f64' || r.layout !== VISCOPLASTIC_LAYOUT || r.byteLength % (8 * VISCOPLASTIC_INLET_WORDS) !== 0)
      throw new RangeError('Invalid viscoplastic inlet. Use layout-1 f64 XYZ, velocity and cubic metres per second.');
    const rows = regionWords(s.host.memory, r);
    let dst = 0;
    let added = 0;
    for (let i = 0; i < rows.length; i += VISCOPLASTIC_INLET_WORDS) {
      const rate = finite('inlet flow rate', rows[i + 6]!, 0);
      if (rate === 0) continue;
      while (dst < s.count && candidate[dst * NATIVE_WORDS + 6] !== 0) dst++;
      if (dst === s.count)
        throw new RangeError('Viscoplastic inlet reached its point capacity. Set a larger capacity or open an outlet.');
      const position = shift([rows[i]!, rows[i + 1]!, rows[i + 2]!], port.cell, context.cell, s.cellSize);
      added += setPoint(s, candidate, undefined, dst, {
        position,
        velocity: [rows[i + 3]!, rows[i + 4]!, rows[i + 5]!],
        volume: rate * dt,
      });
      dst++;
    }
    return added;
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const current = words(s, s.points);
    const candidate = words(s, s.candidate);
    candidate.set(current);
    const bed = this.bed(s, context);
    const inlet = this.inject(s, context, candidate, dt);
    const status = s.kernel.viscoplastic_step(
      s.candidate.byteOffset,
      s.count,
      ...s.cells,
      s.nodes.byteOffset,
      s.active.byteOffset,
      s.diffusion?.byteOffset ?? 0,
      bed,
      s.model.byteOffset,
      s.nextOutput.byteOffset,
      s.stats.byteOffset,
      dt,
    );
    if (status === 2)
      throw new RangeError(
        'Viscoplastic deformation lost its positive Jacobian. Use a finer grid or reduce the inlet velocity.',
      );
    if (status === 3)
      throw new RangeError('Viscoplastic solvent solve did not converge. Use compatible material and grid scales.');
    if (status !== 0)
      throw new RangeError(
        'Viscoplastic state exceeds numeric range. Use finite material, velocity and volume scales.',
      );
    current.set(candidate);
    words(s, s.output).set(words(s, s.nextOutput));
    const delta = words(s, s.stats);
    const counters = words(s, s.counters);
    counters[1]! += inlet;
    counters[2]! += delta[3]!;
    counters[3]! += delta[2]!;
    counters[4] = delta[0]!;
    counters[5] = delta[1]!;
    counters[6] = delta[6]!;
    counters[7] = delta[4]!;
    counters[8] = delta[5]!;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.pointField.name, region: this.live().output, tick, cell: ORIGIN }];
  }

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Number of allocated point rows. Check each sample's presence before drawing it. */
  get capacity(): number {
    return this.live().count;
  }

  /** Read one material point. Its slot is reused after the material leaves an open face. */
  sample(index: number): ViscoplasticSample {
    const s = this.live();
    if (!(integer('row', index, 0) < s.count))
      throw new RangeError('Viscoplastic point row is outside the allocation. Use a row below capacity.');
    const a = words(s, s.output);
    const i = index * VISCOPLASTIC_WORDS;
    return {
      position: [a[i]!, a[i + 1]!, a[i + 2]!],
      velocity: [a[i + 3]!, a[i + 4]!, a[i + 5]!],
      volume: a[i + 6]!,
      pressure: a[i + 7]!,
      shearStress: a[i + 8]!,
      plasticShear: a[i + 9]!,
      present: a[i + 10] === 1,
    };
  }

  /** Reference volume is proportional to exact mass. Current volume also includes elastic compression. */
  get budget(): ViscoplasticBudget {
    const s = this.live();
    const a = words(s, s.counters);
    return {
      initialReferenceVolume: a[0]!,
      injectedReferenceVolume: a[1]!,
      escapedReferenceVolume: a[2]!,
      escapedVolume: a[3]!,
      storedReferenceVolume: a[4]!,
      storedVolume: a[5]!,
      activePoints: a[6]!,
      substeps: a[7]!,
      occupiedNodes: a[8]!,
    };
  }
}

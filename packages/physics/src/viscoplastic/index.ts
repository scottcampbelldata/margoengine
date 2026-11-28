import { MargoError } from '@margoengine/math/errors';
import type { BedSample } from '@margoengine/math/fields';
import { BED_FIELD, BED_LAYOUT, type BedShape, bedSurface, bedVertexCount } from '../earth/bed.js';
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
const PARTICLE_STRIDE = 6;

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

/** Compact accepted positions and velocities for ParticleLiquid or another particle renderer. */
export interface ViscoplasticParticleSource {
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly count: number;
  readonly stride: 6;
  readonly velocityOffset: 3;
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
  particles?: Float32Array;
}

function finite(label: string, n: number, min = -Infinity): number {
  if (!(Number.isFinite(n) && n >= min))
    throw new MargoError('state', `Invalid viscoplastic ${label}. Use a finite SI value within its documented range.`);
  return n;
}

function positive(label: string, n: number): number {
  if (!(Number.isFinite(n) && n > 0))
    throw new MargoError('state', `Invalid viscoplastic ${label}. Use a positive finite value.`);
  return n;
}

function integer(label: string, n: number, min = 1): number {
  if (!(Number.isSafeInteger(n) && n >= min))
    throw new MargoError('state', `Invalid viscoplastic ${label}. Use a whole number at least ${min}.`);
  return n;
}

function vector(label: string, values: Vector): Vector {
  if (values?.length !== 3 || ![values[0], values[1], values[2]].every(Number.isFinite))
    throw new MargoError('state', `Invalid viscoplastic ${label}. Use three finite values.`);
  return [values[0], values[1], values[2]];
}

function words(s: State, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function shift(values: Vector, from: Cell, to: Cell, size: number): Vector {
  return vector('origin-cell transform', [
    values[0] + (from[0] - to[0]) * size,
    values[1] + (from[1] - to[1]) * size,
    values[2] + (from[2] - to[2]) * size,
  ]);
}

function inside(s: State, point: Vector): void {
  if (point.some((p, i) => p < s.origin[i]! || p > s.extent[i]!))
    throw new MargoError('state', 'Viscoplastic point is outside the grid. Use a point within the box.');
}

function setPoint(
  state: State,
  grain: Float64Array,
  output: Float64Array | undefined,
  i: number,
  p: ViscoplasticPoint,
  density: number,
): number {
  if (!p || typeof p !== 'object')
    throw new MargoError('state', 'Invalid viscoplastic point. Give each point a position and volume.');
  const position = vector('position', p.position);
  const velocity = vector('velocity', p.velocity ?? ORIGIN);
  const volume = positive('point volume', p.volume);
  positive('point mass', volume * density);
  inside(state, position);
  const gradient = p.velocityGradient;
  if (gradient !== undefined && gradient?.length !== 3)
    throw new MargoError('state', 'Invalid viscoplastic affine gradient. Use three rows of three values.');
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
    if (typeof id !== 'string' || !id.trim() || id !== id.trim())
      throw new MargoError('state', 'Invalid viscoplastic solver ID. Use a nonempty name without outer whitespace.');
    this.pointField = Object.freeze({
      name: `${id}.points`,
      kind: 'particleSet',
      quantity: 'viscoplasticPoints',
      unit: 'SI',
      centring: 'particle',
    });
    if (terrain) {
      try {
        bedVertexCount(terrain);
      } catch (cause) {
        throw Object.assign(new MargoError('state', 'Invalid viscoplastic terrain. Use a valid TerrainBed shape.'), {
          cause,
        });
      }
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
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid viscoplastic load options. Pass an options object or omit it.');
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
    if (options?.cells?.length !== 3)
      throw new MargoError('state', 'Invalid viscoplastic grid. Use three positive whole cell counts.');
    const cells: Vector = [
      integer('X cells', options.cells[0]),
      integer('Y cells', options.cells[1]),
      integer('Z cells', options.cells[2]),
    ];
    const spacing = positive('cell spacing', options.spacing);
    positive('squared cell spacing', spacing * spacing);
    const cellSize = positive('origin cell size', options.originCellSize ?? 4096);
    const origin = vector('grid origin', options.origin ?? ORIGIN);
    const extent: Vector = [
      finite('grid X end', origin[0] + cells[0] * spacing),
      finite('grid Y end', origin[1] + cells[1] * spacing),
      finite('grid Z end', origin[2] + cells[2] * spacing),
    ];
    if (
      extent.some((max, axis) => {
        const min = origin[axis]!;
        const near = min - spacing;
        const far = max + spacing;
        return !(near < min && max > min && far > max && Number.isFinite(near) && Number.isFinite(far));
      })
    )
      throw new MargoError('state', 'Invalid viscoplastic grid precision. Use a local origin and larger cells.');
    const seeded = options.points ?? [];
    if (!Array.isArray(seeded))
      throw new MargoError('state', 'Invalid viscoplastic points. Use an array of position and volume records.');
    const count = integer('point capacity', options.capacity ?? seeded.length);
    if (count < seeded.length || (!seeded.length && !this.inlet))
      throw new MargoError(
        'state',
        'Invalid viscoplastic point capacity. Use a nonempty point set or a reserved inlet.',
      );
    const walls = options.walls ?? [true, true, true, true, true, true];
    if (!Array.isArray(walls) || walls.length !== 6 || !Array.from(walls).every((wall) => typeof wall === 'boolean'))
      throw new MargoError('state', 'Invalid viscoplastic boundary. Use six booleans in low/high XYZ order.');
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
    const terrainWords = this.bedShape ? 4 * (cells[0] + 3) * (cells[2] + 3) : 0;
    const wordsPerPoint = 2 * (NATIVE_WORDS + VISCOPLASTIC_WORDS);
    const nodeBytes = 4 + 8 * (solvent > 0 ? 14 : 4);
    const requiredBytes = 8 * (wordsPerPoint * count + terrainWords + material.length + 16) + nodeBytes * nodeCount;
    if (requiredBytes + DYNAMIC_BASE + STACK_BYTES >= MAX_MEMORY_PAGES * 65536)
      throw new MargoError('state', 'Viscoplastic grid exceeds wasm32 arena capacity. Use fewer cells or points.');
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
    const terrain = terrainWords ? floats('bed-samples', terrainWords) : undefined;
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
    for (const [i, point] of seeded.entries())
      initial = finite('total seed volume', initial + setPoint(s, grain, records, i, point, density));
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
      throw new MargoError(
        'state',
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
        const x = finite('sampled terrain X', s.origin[0] + (i - 1) * s.spacing + offset[0]);
        const z = finite('sampled terrain Z', s.origin[2] + (j - 1) * s.spacing + offset[2]);
        bed.sample(x, z, sampled);
        const at = 4 * (i + j * columns);
        out[at] = finite('sampled terrain elevation', sampled.elevation - offset[1]);
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
      throw new MargoError(
        'state',
        'Invalid viscoplastic inlet. Use layout-1 f64 XYZ, velocity and cubic metres per second.',
      );
    const rows = regionWords(s.host.memory, r);
    const density = words(s, s.model)[0]!;
    let dst = 0;
    let added = 0;
    for (let i = 0; i < rows.length; i += VISCOPLASTIC_INLET_WORDS) {
      const rate = finite('inlet flow rate', rows[i + 6]!, 0);
      if (rate === 0) continue;
      while (dst < s.count && candidate[dst * NATIVE_WORDS + 6] !== 0) dst++;
      if (dst === s.count)
        throw new MargoError(
          'state',
          'Viscoplastic inlet reached its point capacity. Set a larger capacity or open an outlet.',
        );
      const position = shift([rows[i]!, rows[i + 1]!, rows[i + 2]!], port.cell, context.cell, s.cellSize);
      const volume = setPoint(
        s,
        candidate,
        undefined,
        dst,
        {
          position,
          velocity: [rows[i + 3]!, rows[i + 4]!, rows[i + 5]!],
          volume: rate * dt,
        },
        density,
      );
      added = finite('injected tick volume', added + volume, 0);
      dst++;
    }
    return added;
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const interval = positive('step duration', dt);
    const current = words(s, s.points);
    const candidate = words(s, s.candidate);
    candidate.set(current);
    const bed = this.bed(s, context);
    const inlet = this.inject(s, context, candidate, interval);
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
      interval,
    );
    if (status === 2)
      throw new MargoError(
        'state',
        'Viscoplastic deformation lost its positive Jacobian. Use a finer grid or reduce the inlet velocity.',
      );
    if (status === 3)
      throw new MargoError(
        'state',
        'Viscoplastic solvent solve did not converge. Use compatible material and grid scales.',
      );
    if (status === 4)
      throw new MargoError(
        'state',
        'Viscoplastic tick exceeds 4096 explicit microsteps. Increase cell spacing or reduce stiffness or speed.',
      );
    if (status !== 0)
      throw new MargoError(
        'state',
        'Viscoplastic state exceeds numeric range. Use finite material, velocity and volume scales.',
      );
    const delta = words(s, s.stats);
    const counters = words(s, s.counters);
    const injected = finite('cumulative injected reference volume', counters[1]! + inlet, 0);
    const escapedReference = finite('cumulative escaped reference volume', counters[2]! + delta[3]!, 0);
    const escaped = finite('cumulative escaped volume', counters[3]! + delta[2]!, 0);
    current.set(candidate);
    words(s, s.output).set(words(s, s.nextOutput));
    counters[1] = injected;
    counters[2] = escapedReference;
    counters[3] = escaped;
    counters[4] = delta[0]!;
    counters[5] = delta[1]!;
    counters[6] = delta[6]!;
    counters[7] = delta[4]!;
    counters[8] = delta[5]!;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const { host, output } = this.live();
    return [{ field: this.pointField.name, region: output, tick, cell: host.cell }];
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

  /** Pack the accepted points in render-cell metres, borrowing the provided array or reusing internal storage. */
  particleSource(out?: Float32Array, renderCell?: Cell): ViscoplasticParticleSource {
    const s = this.live();
    const count = words(s, s.counters)[6]!;
    const required = PARTICLE_STRIDE * count;
    if (out !== undefined && (!(out instanceof Float32Array) || out.length < required))
      throw new MargoError('state', 'Give the viscoplastic renderer a Float32Array with six words per active point.');
    if (out?.buffer === s.host.memory.buffer)
      throw new MargoError('state', 'Give the viscoplastic renderer a destination outside the physics arena.');
    if (renderCell !== undefined && !vector('render cell', renderCell).every(Number.isSafeInteger))
      throw new MargoError('state', 'Invalid viscoplastic render cell. Use three whole world-cell coordinates.');
    const offset = shift(ORIGIN, s.host.cell, renderCell ?? s.host.cell, s.cellSize);
    if (
      count > 0 &&
      offset.some((value, i) => {
        const near = s.origin[i]! + value;
        const far = s.extent[i]! + value;
        return !(
          Number.isFinite(Math.fround(near)) &&
          Number.isFinite(Math.fround(far)) &&
          Math.fround(near) < Math.fround(near + s.spacing) &&
          Math.fround(far - s.spacing) < Math.fround(far)
        );
      })
    )
      throw new MargoError('state', 'Viscoplastic particles lack float32 cell resolution. Use a nearer render cell.');
    if (!out) {
      if (!s.particles || s.particles.length < required) {
        const doubled = 2 * (s.particles?.length ?? 0);
        s.particles = new Float32Array(Math.min(PARTICLE_STRIDE * s.count, Math.max(required, doubled)));
      }
      out = s.particles;
    }
    const rows = words(s, s.output);
    let destination = 0;
    for (let row = 0; row < rows.length && destination < required; row += VISCOPLASTIC_WORDS) {
      if (rows[row + 10] !== 1) continue;
      for (let axis = 0; axis < 3; axis++) {
        const velocity = Math.fround(rows[row + 3 + axis]!);
        if (!Number.isFinite(velocity))
          throw new MargoError('state', 'Viscoplastic velocity exceeds float32. Use physical inlet and grid scales.');
        out[destination + axis] = rows[row + axis]! + offset[axis]!;
        out[destination + 3 + axis] = velocity;
      }
      destination += PARTICLE_STRIDE;
    }
    return { positions: out, velocities: out, count, stride: PARTICLE_STRIDE, velocityOffset: 3 };
  }

  /** Read one material point. Its slot is reused after the material leaves an open face. */
  sample(index: number): ViscoplasticSample {
    const s = this.live();
    if (!(integer('row', index, 0) < s.count))
      throw new MargoError('state', 'Viscoplastic point row is outside the allocation. Use a row below capacity.');
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

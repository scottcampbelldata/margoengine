// The terrain bed of the physics framework (docs/physics-framework.md, section 4, "terrain bed"; PA-37): one grid of
// elevations that erosion, slides and craters change and that colliders, water and hooves read, as a registry field.
//
// - `TerrainBed` is the solver that owns the field `bed`. It keeps the elevations in f64 (a metre of bed eroded in a
//   century is a few nanometres a frame, which an f32 elevation of a few hundred metres would round away), adds what other
//   solvers accumulate into the field `bedChange` (metres of elevation, summed by contributor id then vertex by the
//   registry), keeps the bed above its bedrock and records the volume the bedrock refused, and publishes the elevations
//   rounded once to f32.
// - `BedSurface` samples a bed: the elevation and normal at a point, on the triangles the physics kernel cuts the grid into,
//   so a ray, a contact and a sample all see one surface.
// - `BedChange` is what a contributor holds: a region of per-vertex changes and its port.
// - `bedVertexAreas` and `bedVolume` give the volume a change moves, exactly for that triangulation, so a contributor that
//   removes a volume here and puts the same volume there conserves mass to rounding.
import type { Bed, BedGrid, BedSample } from '@margoengine/math/fields';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';

/** The registry field of the bed: vertex elevations, m, owned by {@link TerrainBed}. */
export const BED_FIELD: FieldDescriptor = {
  name: 'bed',
  kind: 'heightfield',
  quantity: 'bedElevation',
  unit: 'm',
  centring: 'vertex',
};

/**
 * The registry field every bed writer adds to: the change of each vertex's elevation this tick, m (positive deposits,
 * negative erodes). Contributors add; the registry sums them by contributor id, then vertex; {@link TerrainBed} applies them.
 */
export const BED_CHANGE_FIELD: FieldDescriptor = {
  name: 'bedChange',
  kind: 'heightfield',
  quantity: 'height',
  unit: 'm',
  centring: 'vertex',
};

/** The layout of a bed's regions; a reader that knows another version refuses the port. */
export const BED_LAYOUT = 1;

/** A bed's grid without its cell: where it lies and how fine it is (see `BedGrid` in `@margoengine/math/fields`). */
export type BedShape = Omit<BedGrid, 'cell'>;

const ORIGIN: Cell = [0, 0, 0];

/**
 * The number of vertices of a grid, `(columns + 1) * (rows + 1)`.
 * @throws RangeError for a grid that is not whole cells above zero, or a size that is not finite and above zero.
 */
export function bedVertexCount(shape: BedShape): number {
  const { columns, rows, width, depth, centre } = shape;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1)
    throw new RangeError(
      `A bed has whole numbers of cells from 1 up along x and z (got ${columns} by ${rows}); pass both.`,
    );
  if (!(width > 0) || !(depth > 0) || !Number.isFinite(width) || !Number.isFinite(depth))
    throw new RangeError(
      `A bed's width and depth are finite sizes above zero in metres (got ${width} by ${depth}); pass both in metres.`,
    );
  if (!centre || centre.length !== 2 || !centre.every(Number.isFinite))
    throw new RangeError('A bed centre is [x, z], two finite metres from its cell origin; pass [0, 0] for the middle.');
  const count = (columns + 1) * (rows + 1);
  if (!Number.isSafeInteger(count))
    throw new RangeError(
      `A bed of ${columns} by ${rows} cells has more vertices than a whole number can count; use fewer cells.`,
    );
  return count;
}

/**
 * The area each vertex stands for, m^2, so that `sum(elevation * area)` is exactly the volume under the triangulated
 * surface (the integral of the piecewise-linear bed above the datum). A triangle's integral is its area times the mean of
 * its three heights; each cell's four vertices lie on its two triangles once (the two off the diagonal) or twice (the two on
 * it), so a vertex's area is `width * depth / (6 * columns * rows)` times the number of triangles it touches.
 */
export function bedVertexAreas(shape: BedShape): Float64Array {
  const count = bedVertexCount(shape),
    { columns, rows, width, depth } = shape,
    sixth = ((width / columns) * (depth / rows)) / 6,
    out = new Float64Array(count);
  for (let c = 0; c < columns; c++)
    for (let r = 0; r < rows; r++) {
      const at = (row: number, column: number): number => row + (rows + 1) * column;
      // First triangle (r, c), (r + 1, c), (r, c + 1); second (r + 1, c + 1), (r, c + 1), (r + 1, c): the diagonal joins
      // (r + 1, c) and (r, c + 1).
      out[at(r, c)]! += sixth;
      out[at(r + 1, c + 1)]! += sixth;
      out[at(r + 1, c)]! += 2 * sixth;
      out[at(r, c + 1)]! += 2 * sixth;
    }
  return out;
}

/** The volume between the bed and the datum height `datum`, m^3: `sum((elevation - datum) * area)`, below it counting negative. */
export function bedVolume(shape: BedShape, elevations: ArrayLike<number>, datum = 0): number {
  const area = bedVertexAreas(shape);
  if (elevations.length !== area.length)
    throw new RangeError(
      `This bed has ${area.length} vertices and got ${elevations.length} elevations; pass one each.`,
    );
  let volume = 0;
  for (let i = 0; i < area.length; i++) volume += (elevations[i]! - datum) * area[i]!;
  return volume;
}

/** A bed sampled on the kernel's triangles. */
class BedSurface implements Bed {
  readonly cell: Cell;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly depth: number;
  readonly centre: readonly [number, number];
  private readonly source: () => ArrayLike<number>;

  constructor(shape: BedShape, cell: Cell, source: () => ArrayLike<number>) {
    bedVertexCount(shape);
    this.cell = cell;
    this.columns = shape.columns;
    this.rows = shape.rows;
    this.width = shape.width;
    this.depth = shape.depth;
    this.centre = [shape.centre[0], shape.centre[1]];
    this.source = source;
  }

  get elevations(): ArrayLike<number> {
    return this.source();
  }

  sample(x: number, z: number, out: BedSample = { elevation: 0, normal: [0, 1, 0] }): BedSample {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new RangeError(`A bed is sampled at finite metres (got ${x}, ${z}); pass a point.`);
    const { columns, rows, width, depth, centre } = this,
      h = this.source(),
      // Grid coordinates, clamped onto the grid so the bed continues at its border's elevation.
      u = Math.min(columns, Math.max(0, ((x - centre[0]) / width + 0.5) * columns)),
      v = Math.min(rows, Math.max(0, ((z - centre[1]) / depth + 0.5) * rows)),
      c = Math.min(columns - 1, Math.floor(u)),
      r = Math.min(rows - 1, Math.floor(v)),
      s = u - c,
      t = v - r,
      stride = rows + 1,
      a = h[r + stride * c]!,
      b = h[r + 1 + stride * c]!,
      d = h[r + stride * (c + 1)]!,
      e = h[r + 1 + stride * (c + 1)]!,
      dx = width / columns,
      dz = depth / rows;
    let slopeX: number, slopeZ: number;
    if (s + t <= 1) {
      // The triangle (r, c), (r + 1, c), (r, c + 1).
      out.elevation = a + s * (d - a) + t * (b - a);
      slopeX = (d - a) / dx;
      slopeZ = (b - a) / dz;
    } else {
      // The triangle (r + 1, c + 1), (r + 1, c), (r, c + 1).
      out.elevation = e + (1 - s) * (b - e) + (1 - t) * (d - e);
      slopeX = (e - b) / dx;
      slopeZ = (e - d) / dz;
    }
    const length = Math.sqrt(slopeX * slopeX + 1 + slopeZ * slopeZ);
    out.normal[0] = -slopeX / length;
    out.normal[1] = 1 / length;
    out.normal[2] = -slopeZ / length;
    return out;
  }
}

/**
 * A bed over plain elevations (a `Float32Array` or an array), for a reader that holds them itself.
 * @throws RangeError for a grid that is not valid, or elevations that are not one per vertex.
 */
export function bedSurface(shape: BedShape, elevations: ArrayLike<number>, cell: Cell = ORIGIN): Bed {
  const count = bedVertexCount(shape);
  if (elevations.length !== count)
    throw new RangeError(
      `A bed of ${shape.columns} by ${shape.rows} cells has ${count} vertices; got ${elevations.length} elevations, so pass one each.`,
    );
  return new BedSurface(shape, cell, () => elevations);
}

/**
 * A bed over a port of the field `bed` in the world's memory, read in place. It takes a fresh view when the memory has grown,
 * so it stays valid for the life of the world, and `cell` is the port's.
 * @throws RangeError for a port that is not f32 or not one elevation per vertex, or a layout this module does not know.
 */
export function bedFromPort(memory: WebAssembly.Memory, port: Port, shape: BedShape): Bed {
  const count = bedVertexCount(shape);
  if (port.field !== BED_FIELD.name)
    throw new RangeError(`Port "${port.field}" is not the bed; pass the port of field "bed".`);
  if (port.region.layout !== BED_LAYOUT)
    throw new RangeError(
      `The bed port has layout ${port.region.layout}; this reader knows layout ${BED_LAYOUT}, so update the reader or the bed to the same version.`,
    );
  if (port.region.type !== 'f32' || port.region.byteLength !== count * 4)
    throw new RangeError(
      `The bed port holds ${port.region.byteLength} bytes of ${port.region.type}; a ${shape.columns} by ${shape.rows} bed is ${count} f32 elevations, so pass the shape the bed was made with.`,
    );
  let buffer: ArrayBufferLike | undefined, view: ArrayLike<number> | undefined;
  const region = port.region;
  return new BedSurface(shape, port.cell, () => {
    if (memory.buffer !== buffer) {
      buffer = memory.buffer;
      view = regionWords(memory, region);
    }
    return view!;
  });
}

/** What {@link TerrainBed} is made from. */
export interface TerrainBedParams extends BedShape {
  /** The solver's id in the world (default `'bed'`); contributors and readers name the field, not the id. */
  readonly id?: string;
  /**
   * The starting elevations, m: one per vertex in the grid's layout, or a function of (x, z) m from the cell's origin
   * (evaluated once per vertex, in f64).
   */
  readonly elevations: ArrayLike<number> | ((x: number, z: number) => number);
  /**
   * The bedrock, m: the lowest the bed may go at each vertex, one per vertex or a function of (x, z). What a change would
   * cut below it is refused and counted in {@link TerrainBed.refusedVolume}. Default none: the bed has no floor.
   */
  readonly bedrock?: ArrayLike<number> | ((x: number, z: number) => number);
}

const LEDGER = 3;

/**
 * The solver that owns the terrain bed. Each tick it adds what others accumulated into `bedChange` to the elevations, keeps
 * them above the bedrock, and publishes them as the field `bed`. It steps at the base rate; erosion, slides and craters add
 * to it, and colliders, water and hooves read it.
 */
export class TerrainBed implements Solver<TerrainBedParams> {
  private readonly id: string;
  private shape!: BedShape;
  private host!: SolverHost;
  private area!: Float64Array;
  private count = 0;
  private cell: Cell = ORIGIN;
  private elevation!: Region;
  private bedrock!: Region;
  private pending!: Region;
  private start!: Region;
  private ledger!: Region;
  private startLedger!: Region;
  private heights!: Region;

  /** @param id The solver's id (default `'bed'`). */
  constructor(id = 'bed') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BED_FIELD, access: 'write' },
        { field: BED_CHANGE_FIELD, access: 'write' },
      ],
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
    };
  }

  init(host: SolverHost, params: TerrainBedParams): void {
    const { columns, rows, width, depth } = params,
      centre = params.centre ?? [0, 0],
      shape: BedShape = { columns, rows, width, depth, centre },
      count = bedVertexCount(shape);
    this.shape = shape;
    this.host = host;
    this.count = count;
    this.area = bedVertexAreas(shape);
    const evaluate = (
      source: ArrayLike<number> | ((x: number, z: number) => number),
      into: Float64Array,
      what: string,
    ): void => {
      if (typeof source !== 'function' && source.length !== count)
        throw new RangeError(
          `A ${columns} by ${rows} bed has ${count} vertices; ${what} has ${source.length} values, one each is needed.`,
        );
      for (let c = 0; c <= columns; c++)
        for (let r = 0; r <= rows; r++) {
          const i = r + (rows + 1) * c,
            value =
              typeof source === 'function'
                ? source(centre[0] - width / 2 + (width * c) / columns, centre[1] - depth / 2 + (depth * r) / rows)
                : source[i]!;
          if (!Number.isFinite(value)) throw new RangeError(`${what} at vertex ${i} is ${value}; pass finite metres.`);
          into[i] = value;
        }
    };
    const start = new Float64Array(count);
    evaluate(params.elevations, start, 'the elevations');
    const floor = new Float64Array(count).fill(Number.NEGATIVE_INFINITY);
    if (params.bedrock !== undefined) evaluate(params.bedrock, floor, 'the bedrock');
    for (let i = 0; i < count; i++)
      if (start[i]! < floor[i]!)
        throw new RangeError(
          `The bed starts below its bedrock at vertex ${i} (${start[i]} m against ${floor[i]} m); lower the bedrock.`,
        );
    this.elevation = host.allocate('elevation', count * 8, 'f64', BED_LAYOUT);
    this.bedrock = host.allocate('bedrock', count * 8, 'f64', BED_LAYOUT);
    this.pending = host.allocate('pending', count * 8, 'f64', BED_LAYOUT);
    this.start = host.allocate('start', count * 8, 'f64', BED_LAYOUT);
    this.ledger = host.allocate('ledger', LEDGER * 8, 'f64', BED_LAYOUT);
    this.startLedger = host.allocate('startLedger', LEDGER * 8, 'f64', BED_LAYOUT);
    this.heights = host.allocate('heights', count * 4, 'f32', BED_LAYOUT);
    this.words(this.elevation).set(start);
    this.words(this.bedrock).set(floor);
    this.words(this.heights).set(start);
  }

  step(context: StepContext, _dt: number): void {
    this.cell = context.cell;
    this.words(this.start).set(this.words(this.elevation));
    this.words(this.startLedger).set(this.words(this.ledger));
    this.apply();
  }

  iterate(context: StepContext, _dt: number): void {
    this.cell = context.cell;
    this.rollback();
    this.apply();
  }

  rollback(): void {
    const start = this.words(this.start);
    this.words(this.elevation).set(start);
    this.words(this.ledger).set(this.words(this.startLedger));
    // The published elevations go back too: `apply` writes only the vertices it changes, so a vertex the first try changed
    // and the second leaves alone would keep the first try's elevation.
    (regionWords(this.host.memory, this.heights) as Float32Array).set(start);
  }

  importPorts(_tick: number): void {
    const sum = this.host.port(BED_CHANGE_FIELD.name),
      pending = this.words(this.pending);
    if (!sum) {
      pending.fill(0);
      return;
    }
    const added = regionWords(this.host.memory, sum.region);
    if (added.length !== this.count)
      throw new RangeError(
        `Contributions to "bedChange" have ${added.length} values; this bed has ${this.count} vertices, so make each BedChange on the bed's own grid.`,
      );
    for (let i = 0; i < this.count; i++) {
      if (!Number.isFinite(added[i]!))
        throw new RangeError(`A contribution to "bedChange" is ${added[i]} at vertex ${i}; contribute finite metres.`);
      pending[i] = added[i]!;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BED_FIELD.name, region: this.heights, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return [this.elevation, this.bedrock, this.ledger, this.heights];
  }

  extraState(): readonly Region[] {
    return [this.pending, this.start, this.startLedger];
  }

  /** The grid this bed lies on, in the cell the world steps it in. */
  get grid(): BedGrid {
    return { ...this.shape, cell: this.cell };
  }

  /** The bed as readers see it: the published elevations, read in place. */
  get bed(): Bed {
    return bedFromPort(
      this.host.memory,
      { field: BED_FIELD.name, region: this.heights, tick: 0, cell: this.cell },
      this.shape,
    );
  }

  /** The elevations in f64, m, a copy. */
  elevations(): Float64Array {
    return this.words(this.elevation).slice();
  }

  /** The volume between the bed and the height `datum`, m^3. */
  volume(datum = 0): number {
    return bedVolume(this.shape, this.words(this.elevation), datum);
  }

  /** The volume of change contributors asked for so far, m^3 (deposits positive, erosion negative), refusals included. */
  requestedVolume(): number {
    return this.words(this.ledger)[0]!;
  }

  /**
   * The volume the bedrock refused so far, m^3: what contributors tried to cut below it. The volume is conserved as
   * `volume() - startVolume = requestedVolume() + refusedVolume()`.
   */
  refusedVolume(): number {
    return this.words(this.ledger)[1]!;
  }

  /** How many steps changed at least one elevation. */
  revisions(): number {
    return this.words(this.ledger)[2]!;
  }

  private apply(): void {
    const e = this.words(this.elevation),
      p = this.words(this.pending),
      floor = this.words(this.bedrock),
      out = regionWords(this.host.memory, this.heights) as Float32Array,
      ledger = this.words(this.ledger);
    let requested = 0,
      refused = 0,
      changed = false;
    for (let i = 0; i < this.count; i++) {
      const delta = p[i]!;
      if (delta === 0) continue;
      requested += delta * this.area[i]!;
      let next = e[i]! + delta;
      if (next < floor[i]!) {
        refused += (floor[i]! - next) * this.area[i]!;
        next = floor[i]!;
      }
      if (next !== e[i]!) {
        e[i] = next;
        out[i] = next;
        changed = true;
      }
    }
    ledger[0]! += requested;
    ledger[1]! += refused;
    if (changed) ledger[2]! += 1;
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }
}

/**
 * What a bed writer (erosion, a slide, a crater) holds: a region of per-vertex elevation changes, m, that it fills during
 * its step and exports as its contribution to `bedChange`. The registry adds each export into the contributor's running total,
 * so a writer that exports every step clears the changes after it, or calls {@link BedChange.take}.
 */
export class BedChange {
  private readonly memory: WebAssembly.Memory;
  private readonly region: Region;
  /** The vertex areas of the bed, m^2 (see {@link bedVertexAreas}), for a writer that moves a volume. */
  readonly area: Float64Array;

  /**
   * @param host Where the writer allocates (its `init`'s host).
   * @param shape The bed's grid; the writer must contribute the same grid the bed owner was made from.
   * @param name The region's name in the writer (default `'bedChange'`).
   */
  constructor(host: SolverHost, shape: BedShape, name = 'bedChange') {
    const count = bedVertexCount(shape);
    this.memory = host.memory;
    this.region = host.allocate(name, count * 8, 'f64', BED_LAYOUT);
    this.area = bedVertexAreas(shape);
  }

  /** The changes, m, one per vertex, as a view over the world's memory: take it afresh after any allocation. */
  get deltas(): Float64Array {
    return regionWords(this.memory, this.region) as Float64Array;
  }

  /** The region, to list among the writer's state regions. */
  get state(): Region {
    return this.region;
  }

  /** The port to return from the writer's `exportPorts`, valid at `tick`. */
  port(tick: number, cell: Cell = ORIGIN): Port {
    return { field: BED_CHANGE_FIELD.name, region: this.region, tick, cell };
  }

  /** Clears the changes: call after the port has been returned for the tick. */
  clear(): void {
    this.deltas.fill(0);
  }
}

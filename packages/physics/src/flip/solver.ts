// A grid-particle liquid (FLUID-03) as a solver of the physics framework (docs/physics-framework.md, sections 4 and 5): water
// that splashes, overturns and pours, in a box of cells. APIC particles carry it (transfer.ts) and a MAC grid with a free
// surface keeps it incompressible (grid.ts); each world step runs as many substeps as keep every particle within a cell a
// substep. Its particles and its pressure are world state (snapshot, restore and hash), so a seek replays it.
//
// Checked against the dam break of J. C. Martin and W. J. Moyce, "An experimental study of the collapse of liquid columns
// on a rigid horizontal plane", Phil. Trans. R. Soc. A 244, 312-324, 1952 (their table 2, n^2 = 2: the front's position
// against time), and against still water's hydrostatic pressure.
import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
import {
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
import { regionWords } from '../world/memory.js';
import { cell, type GridShape, LIQUID, project, SOLID } from './grid.js';
import { extrapolate, PARTICLE_WORDS, sampleVelocity, surface, toGrid, toParticles, wallFaces } from './transfer.js';

type V3 = [number, number, number];

/** A solid box inside the liquid's box, [x, y, z] m from the box's lowest corner. */
export interface LiquidSolid {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** What a {@link FlipSolver} is made from. */
export interface FlipParams {
  /** Cells along x, y (up) and z (default [64, 32, 32]). */
  readonly cells?: readonly [number, number, number];
  /** Cell size, m (default 0.1). */
  readonly cellSize?: number;
  /** The box's lowest corner, m from the world's cell (default [0, 0, 0]). */
  readonly origin?: readonly [number, number, number];
  /** Where the water starts: (x, y, z) m from the box's corner, true inside it. Eight particles a cell. */
  readonly initial?: (x: number, y: number, z: number) => boolean;
  /** Solid boxes the water flows round (a deck, a wall, a block). */
  readonly solids?: readonly LiquidSolid[];
  /** The liquid's density, kg/m^3 (default 1000; sea water 1025). */
  readonly density?: number;
  /** Particles it may hold (default eight a cell of the box). */
  readonly capacity?: number;
  /** Its rate level (default 0). */
  readonly rate?: RateLevel;
  /** The most substeps a world step may take (default 64): a faster liquid is refused rather than slowed. */
  readonly maxSubsteps?: number;
  /**
   * The box's sides open to the air (default none: closed walls): water that crosses one leaves the liquid, and
   * `seaSources()` hands its volume to the sea below (a WakeSolver's `sources`). '-x', '+x', '-y', '+y', '-z', '+z'.
   */
  readonly open?: readonly ('-x' | '+x' | '-y' | '+y' | '-z' | '+z')[];
  /**
   * The sea the box sits in (a `SpectralSea` of `@margoengine/physics/sea`, in the solver's cell): with no `initial`
   * the box starts as the sea at time 0, its water below the surface moving as the sea's does; its four sides take
   * the sea's own velocity, and a band of `blend` cells inside them is held to the sea's motion and level (the hybrid of
   * N. Chentanez, M. Muller and T.-Y. Kim, SCA 2014), so waves run in and out and the water inside is free to steepen,
   * overturn and break.
   */
  readonly sea?: LiquidSea;
  /** Cells of the band held to the sea (default 6). */
  readonly blend?: number;
  /**
   * The side of the square tiles its sea sources cover, m (default eight cells): about the wake's cell size or more. Only
   * for a solver made with `seaSource`.
   */
  readonly seaTile?: number;
  /**
   * Foam it lays where it closes over air, a plunging crest's cavity (a FoamSolver of `@margoengine/physics/foam`, or
   * anything with `addFoam`): a white patch over the cavity, as the foam solver's own active breakers are (default none).
   */
  readonly foam?: LiquidFoam;
}

/** Something that takes foam over a box: a FoamSolver of `@margoengine/physics/foam`. */
export interface LiquidFoam {
  addFoam(min: readonly [number, number], max: readonly [number, number], whiteness?: number): void;
}

/** Air the liquid took in this step, as a BubbleSolver of `@margoengine/physics/bubbles` takes it in its `sources`. */
export interface LiquidAeration {
  /** The middle of the air the liquid closed over, m from the world's cell. */
  readonly position: readonly [number, number, number];
  /** Its spread across and down, m. */
  readonly width: number;
  readonly depth: number;
  /** The air, m^3/s over the step. */
  readonly rate: number;
}

/** Options fixed when a {@link FlipSolver} is made, because they shape the fields it declares. */
export interface FlipOptions {
  /**
   * Publish the water it gives the sea as a field, `${id}.seaSource`: layout-1 f64 rows of x, z, radius, pressure and
   * volume, as a WakeSolver made with that field reads them (default false). The rows carry the water that leaves over
   * the open sides and, for a box in a `sea`, what crosses its sides held to the sea and what its band's refill removes
   * or adds to hold the sea's level, so a wave made inside the box runs out across the wake and box and wake together
   * keep their water. The solver then steps at the world's base rate, as the wake does.
   */
  readonly seaSource?: boolean;
}

/** f64 words of a sea source row (x, z, radius, pressure, volume), and the rows' layout, as a WakeSolver reads them. */
const SEA_SOURCE_WORDS = 5;
const SEA_SOURCE_LAYOUT = 1;

/** The sea a liquid's box sits in: its surface and the water's velocity below it, on the world clock. */
export interface LiquidSea {
  elevation(x: number, z: number, t: number): number;
  readonly water: {
    sample(
      x: number,
      y: number,
      z: number,
      t: number,
      out?: { velocity: [number, number, number]; density: number; temperature: number },
    ): { velocity: [number, number, number] };
  };
}

const SIDES = ['-x', '+x', '-y', '+y', '-z', '+z'] as const;

/** The layout version of its regions. */
const FLIP_LAYOUT = 1;

/** The grid-particle liquid. `id` is `'liquid'` unless a world holds more. */
export class FlipSolver implements Solver<FlipParams> {
  protected host: SolverHost | null = null;
  protected level: RateLevel = 0;
  protected grid: GridShape = { nx: 1, ny: 1, nz: 1, h: 1 };
  protected origin: V3 = [0, 0, 0];
  protected density = 1000;
  protected capacity = 0;
  protected maxSubsteps = 64;
  protected gravity: V3 = [0, -9.81, 0];
  protected particleRegion: Region | null = null;
  protected countRegion: Region | null = null;
  protected pressureRegion: Region | null = null;
  protected solid = new Uint8Array(0);
  /** The faces inside the solids (wallFaces), or undefined with no solid. */
  protected wallMask: Uint8Array[] | undefined = undefined;
  protected kind = new Uint8Array(0);
  protected phi = new Float64Array(0);
  protected vel: Float64Array[] = [];
  protected mass: Float64Array[] = [];
  protected open: boolean[] = [false, false, false, false, false, false];
  /** The water that left over the open sides this step: [x, z, volume] each, world, m and m^3. */
  protected sinks: number[] = [];
  /**
   * The water the box gave the sea through its sides held to the sea this step, [x, z, volume] each (world, m and m^3;
   * negative where the band took water from the sea): what crossed those sides and what the band's refill removed or
   * added to hold the sea's level. With the open sides' `sinks`, the box's whole exchange with the sea.
   */
  protected given: number[] = [];
  protected sea: LiquidSea | null = null;
  protected blend = 6;
  /** The time of the substep being taken, s on the world clock. */
  protected time = 0;
  private readonly flow = { velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0 };
  private lastSubsteps = 0;
  private lastIterations = 0;
  /** The field its sea sources go out on, with `seaSource`. */
  readonly seaSourceField: FieldDescriptor | undefined;
  private seaRegion: Region | null = null;
  /** The air the liquid has closed over: its volume and middle, m^3 and m from the box's corner (state). */
  private airRegion: Region | null = null;
  private newAir: LiquidAeration | null = null;
  private foam: LiquidFoam | null = null;
  private seaTile = 0;
  private seaTiles: [number, number] = [0, 0];

  /**
   * @param id The solver's id, default 'liquid'.
   * @param options What shapes its fields: `seaSource` publishes the water it gives the sea.
   */
  constructor(
    readonly id = 'liquid',
    options: FlipOptions = {},
  ) {
    this.seaSourceField = options.seaSource
      ? Object.freeze({
          name: `${id}.seaSource`,
          kind: 'scalarSeries',
          centring: 'cell',
          quantity: 'seaSource',
          unit: 'SI',
        } satisfies FieldDescriptor)
      : undefined;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: this.seaSourceField ? [{ field: this.seaSourceField, access: 'write' }] : [],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  /**
   * @throws RangeError for cells, a cell size, density, capacity, rate or substep limit out of range, or a solid box
   * outside the liquid's box, each naming the fix; TypeError for an `initial` that is not a function.
   */
  init(host: SolverHost, params: FlipParams = {}): void {
    const {
      cells = [64, 32, 32],
      cellSize = 0.1,
      origin = [0, 0, 0],
      initial,
      solids = [],
      density = 1000,
      rate = 0,
      maxSubsteps = 64,
      open = [],
      sea,
      blend = 6,
      seaTile = 8 * (params.cellSize ?? 0.1),
      foam,
    } = params;
    if (foam !== undefined && typeof foam?.addFoam !== 'function')
      throw new TypeError(
        'A liquid lays foam with a FoamSolver (anything with addFoam(min, max, whiteness)); pass one or none.',
      );
    this.foam = foam ?? null;
    if (sea !== undefined && (typeof sea?.elevation !== 'function' || typeof sea?.water?.sample !== 'function'))
      throw new TypeError(
        'A liquid sits in a sea with elevation(x, z, t) and water.sample(x, y, z, t); pass a SpectralSea or none.',
      );
    if (!(Number.isInteger(blend) && blend >= 1 && blend <= 64))
      throw new RangeError(`A liquid's band held to the sea is 1 to 64 whole cells (got ${blend}); pass one.`);
    this.sea = sea ?? null;
    this.blend = blend;
    if (!(Array.isArray(open) && open.every((side) => (SIDES as readonly string[]).includes(side))))
      throw new RangeError(`A liquid's open sides are some of ${SIDES.join(', ')}; pass a list of them.`);
    this.open = SIDES.map((side) => open.includes(side));
    if (!(cells.length === 3 && cells.every((n) => Number.isInteger(n) && n >= 1 && n <= 1024)))
      throw new RangeError(`A liquid's box has 1 to 1024 whole cells along x, y and z (got ${cells}); pass three.`);
    if (!(cellSize > 0 && Number.isFinite(cellSize)))
      throw new RangeError(`A liquid's cell size is a finite number of metres above 0 (got ${cellSize}); pass one.`);
    if (!(density > 0 && Number.isFinite(density)))
      throw new RangeError(`A liquid's density is a finite number of kg/m^3 above 0 (got ${density}); pass one.`);
    if (!(origin.length === 3 && origin.every(Number.isFinite)))
      throw new RangeError("A liquid's origin is three finite numbers; pass [x, y, z].");
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`A liquid's rate level is 0 to 7 (got ${rate}); pass one.`);
    if (!(Number.isInteger(maxSubsteps) && maxSubsteps >= 1 && maxSubsteps <= 4096))
      throw new RangeError(
        `A liquid takes 1 to 4096 substeps a step at most (got ${maxSubsteps}); pass a whole number.`,
      );
    if (initial !== undefined && typeof initial !== 'function')
      throw new TypeError('A liquid starts from initial(x, y, z) => true inside the water; pass a function or none.');
    const [nx, ny, nz] = cells,
      n = nx * ny * nz,
      capacity = params.capacity ?? 8 * n;
    if (!(Number.isInteger(capacity) && capacity >= 1))
      throw new RangeError(
        `A liquid's capacity is a whole number of particles of 1 or more (got ${capacity}); pass one.`,
      );
    this.host = host;
    this.grid = { nx, ny, nz, h: cellSize };
    this.origin = [origin[0], origin[1], origin[2]];
    this.density = density;
    this.capacity = capacity;
    this.level = rate as RateLevel;
    this.maxSubsteps = maxSubsteps;
    this.gravity = [host.gravity[0], host.gravity[1], host.gravity[2]];
    this.solid = new Uint8Array(n);
    for (const box of solids) {
      const ok =
        box?.min?.length === 3 &&
        box?.max?.length === 3 &&
        [0, 1, 2].every(
          (a) => box.min[a]! < box.max[a]! && box.min[a]! >= 0 && box.max[a]! <= cells[a]! * cellSize + 1e-9,
        );
      if (!ok)
        throw new RangeError(
          "A solid box goes from min to max inside the liquid's box ([0, 0, 0] to its size), min below max; pass one.",
        );
      // Every cell whose centre is inside the box.
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const x = (i + 0.5) * cellSize,
              y = (j + 0.5) * cellSize,
              z = (k + 0.5) * cellSize;
            if (
              x > box.min[0] &&
              x < box.max[0] &&
              y > box.min[1] &&
              y < box.max[1] &&
              z > box.min[2] &&
              z < box.max[2]
            )
              this.solid[cell(this.grid, i, j, k)] = 1;
          }
    }
    this.wallMask = solids.length > 0 ? wallFaces(this.grid, this.solid) : undefined;
    this.kind = new Uint8Array(n);
    this.phi = new Float64Array(n);
    this.vel = [
      new Float64Array((nx + 1) * ny * nz),
      new Float64Array(nx * (ny + 1) * nz),
      new Float64Array(nx * ny * (nz + 1)),
    ];
    this.mass = this.vel.map((a) => new Float64Array(a.length));
    this.particleRegion = host.allocate(`${this.id}:particles`, capacity * PARTICLE_WORDS * 8, 'f64', FLIP_LAYOUT);
    this.countRegion = host.allocate(`${this.id}:count`, 8, 'f64', FLIP_LAYOUT);
    this.airRegion = host.allocate(`${this.id}:air`, 4 * 8, 'f64', FLIP_LAYOUT);
    this.pressureRegion = host.allocate(`${this.id}:pressure`, n * 8, 'f64', FLIP_LAYOUT);
    if (this.seaSourceField) {
      if (rate !== 0)
        throw new RangeError(
          `A liquid that gives the sea its water steps at the world's base rate, as the wake does (got rate ${rate}); pass rate 0.`,
        );
      if (!(seaTile >= cellSize && Number.isFinite(seaTile)))
        throw new RangeError(
          `A liquid's sea tiles are at least a cell across (got ${seaTile} m for ${cellSize} m cells); pass one.`,
        );
      this.seaTile = seaTile;
      this.seaTiles = [Math.ceil((nx * cellSize) / seaTile - 1e-9), Math.ceil((nz * cellSize) / seaTile - 1e-9)];
      this.seaRegion = host.allocate(
        `${this.id}:seaSource`,
        this.seaTiles[0] * this.seaTiles[1] * SEA_SOURCE_WORDS * 8,
        'f64',
        SEA_SOURCE_LAYOUT,
      );
    }
    if (initial) this.seed(initial);
    else if (this.sea) this.seedSea(0);
  }

  protected words(region: Region | null): Float64Array {
    if (!this.host || !region)
      throw new MargoError(
        'state',
        'FlipSolver is not in a world yet; add it with world.add(solver, {cells, cellSize}).',
      );
    return regionWords(this.host.memory, region) as Float64Array;
  }

  /** The particles now (PARTICLE_WORDS each: position from the box's corner, velocity, affine vectors) and how many. */
  protected state(): { p: Float64Array; count: number } {
    return { p: this.words(this.particleRegion), count: this.words(this.countRegion)[0]! };
  }

  /** Eight particles in each cell where `inside` holds at their octant centres (transfer.ts says why not jittered). */
  private seed(inside: (x: number, y: number, z: number) => boolean): void {
    const { nx, ny, nz, h } = this.grid,
      p = this.words(this.particleRegion),
      countWords = this.words(this.countRegion);
    let count = countWords[0]!;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          if (this.solid[cell(this.grid, i, j, k)]) continue;
          for (let o = 0; o < 8; o++) {
            const x = (i + 0.25 + 0.5 * (o & 1)) * h,
              y = (j + 0.25 + 0.5 * ((o >> 1) & 1)) * h,
              z = (k + 0.25 + 0.5 * ((o >> 2) & 1)) * h;
            if (!inside(x, y, z)) continue;
            if (count >= this.capacity)
              throw new RangeError(
                `The liquid holds at most ${this.capacity} particles and its start needs more; raise capacity.`,
              );
            const at = count * PARTICLE_WORDS;
            p.fill(0, at, at + PARTICLE_WORDS);
            p[at] = x;
            p[at + 1] = y;
            p[at + 2] = z;
            count++;
          }
        }
    countWords[0] = count;
  }

  step(context: StepContext, dt: number): void {
    this.sinks = [];
    this.given = [];
    this.beforeStep(context, dt);
    const { p, count } = this.state();
    // Substeps of at most one cell for the fastest particle, as many as the step needs.
    let fastest = 0;
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        s = p[o + 3]! * p[o + 3]! + p[o + 4]! * p[o + 4]! + p[o + 5]! * p[o + 5]!;
      if (s > fastest) fastest = s;
    }
    // Gravity adds up to g dt over the step; take it into the bound.
    const [gx, gy, gz] = this.gravity,
      g = Math.sqrt(gx * gx + gy * gy + gz * gz),
      bound = Math.sqrt(fastest) + g * dt,
      substeps = Math.max(1, Math.ceil((bound * dt) / this.grid.h));
    if (substeps > this.maxSubsteps)
      throw new MargoError(
        'state',
        `The liquid moves ${bound.toFixed(2)} m/s, ${substeps} substeps of a ${this.grid.h} m cell this step (at most ${this.maxSubsteps}); raise maxSubsteps or the solver's rate.`,
      );
    const start = context.tick / rateOf(context.level);
    if (this.sea) this.refill(start);
    for (let s = 0; s < substeps; s++) {
      this.time = start + (s * dt) / substeps;
      this.substep(dt / substeps);
    }
    this.lastSubsteps = substeps;
    this.afterStep(context, dt);
    if (this.seaRegion) this.writeSeaSources();
    // The air taken in is gathered over the world's base step (one or more of this solver's), so a reader at the base
    // rate takes all of it once.
    this.trapAir(context.tick % (rateOf(context.level) / rateOf(0)) === 0, 1 / rateOf(0));
  }

  /**
   * The step's sea sources, one row a tile of `seaTile` over the box's footprint (a tile with nothing to give is all zeros,
   * which the wake skips): the water the box gave the sea in that tile, over its open sides and through its sides held to
   * the sea, less what its band took from the sea. Box and sea together keep their water: a wave made inside the box
   * piles water into the band, whose refill hands it to the wake there, and the wake carries it away as its own wave.
   */
  private writeSeaSources(): void {
    const words = this.words(this.seaRegion),
      { nx, nz, h } = this.grid,
      tile = this.seaTile,
      [tx, tz] = this.seaTiles,
      volume = new Float64Array(tx * tz),
      tileOf = (x: number, z: number): number => {
        const a = Math.min(tx - 1, Math.max(0, Math.floor((x - this.origin[0]) / tile))),
          b = Math.min(tz - 1, Math.max(0, Math.floor((z - this.origin[2]) / tile)));
        return a + tx * b;
      };
    for (const list of [this.sinks, this.given])
      for (let k = 0; k < list.length; k += 3) volume[tileOf(list[k]!, list[k + 1]!)]! += list[k + 2]!;
    words.fill(0);
    for (let b = 0; b < tz; b++)
      for (let a = 0; a < tx; a++) {
        const v = volume[a + tx * b]!;
        if (v === 0) continue;
        const at = (a + tx * b) * SEA_SOURCE_WORDS;
        // The tile's centre (the last tile along a side may be cut short by the box).
        words[at] = this.origin[0] + (a * tile + Math.min((a + 1) * tile, nx * h)) / 2;
        words[at + 1] = this.origin[2] + (b * tile + Math.min((b + 1) * tile, nz * h)) / 2;
        words[at + 2] = tile;
        words[at + 4] = v;
      }
  }

  /** Before a step's substeps (a riding box reads its body and the inflow here). */
  protected beforeStep(_context: StepContext, _dt: number): void {}
  /** After them (a riding box holds its body with the deck's load here). */
  protected afterStep(_context: StepContext, _dt: number): void {}
  /**
   * The acceleration the liquid feels at (x, y, z) m from the box's corner moving at `v`, into `out`: gravity, in a
   * fixed box. A box riding a body adds its frame's.
   */
  protected acceleration(_x: number, _y: number, _z: number, _v: V3, out: V3): V3 {
    out[0] = this.gravity[0];
    out[1] = this.gravity[1];
    out[2] = this.gravity[2];
    return out;
  }
  /** Whether the frame's acceleration depends on place and velocity (it does for a riding box). */
  protected varying(): boolean {
    return false;
  }

  private substep(dt: number): void {
    const g = this.grid,
      { h } = g,
      p = this.words(this.particleRegion),
      count = this.words(this.countRegion)[0]!,
      pressure = this.words(this.pressureRegion);
    this.correctDensity(dt);
    toGrid(g, p, count, this.vel, this.mass, this.wallMask);
    // The band takes the sea's velocity before gravity, as every face does, so the pressure solve that follows takes
    // gravity out of the band and the interior alike. Held after gravity, the band lost part of its g dt, the solve made
    // a pressure hydrostatic inside but not in the band, and its horizontal gradient stirred still water at the band's
    // edge (0.15 m/s within half a second, in a calm sea).
    if (this.sea) this.holdToSea(dt);
    this.accelerate(dt);
    for (let c = 0; c < this.kind.length; c++) this.kind[c] = this.solid[c] ? SOLID : 0;
    surface(g, p, count, h, 0.5 * h, this.kind, this.phi);
    this.lastIterations = project(
      g,
      this.kind,
      this.phi,
      this.vel[0]!,
      this.vel[1]!,
      this.vel[2]!,
      dt,
      this.density,
      pressure,
      this.open,
      this.sea ? [true, true, false, false, g.nz > 1, g.nz > 1] : undefined,
    );
    extrapolate(g, this.kind, this.vel, 2, this.mass);
    toParticles(g, p, count, this.vel, this.wallMask);
    const mid: V3 = [0, 0, 0],
      lo = 1e-6 * h,
      top: V3 = [g.nx * h - lo, g.ny * h - lo, g.nz * h - lo],
      volume = (h * h * h) / 8;
    let kept = 0;
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        x = p[o]!,
        y = p[o + 1]!,
        z = p[o + 2]!;
      sampleVelocity(g, this.vel, x, y, z, mid, this.wallMask);
      sampleVelocity(
        g,
        this.vel,
        x + 0.5 * dt * mid[0],
        y + 0.5 * dt * mid[1],
        z + 0.5 * dt * mid[2],
        mid,
        this.wallMask,
      );
      const to: V3 = [x + dt * mid[0], y + dt * mid[1], z + dt * mid[2]];
      // Over an open side it leaves the liquid; at a wall it stops there.
      let gone = false;
      for (let a = 0; a < 3; a++) {
        if (to[a]! < lo) {
          if (this.open[2 * a] || (this.sea && (a === 0 || (a === 2 && g.nz > 1)))) gone = true;
          else to[a] = lo;
        } else if (to[a]! > top[a]!) {
          if (this.open[2 * a + 1] || (this.sea && (a === 0 || (a === 2 && g.nz > 1)))) gone = true;
          else to[a] = top[a]!;
        }
      }
      if (gone) {
        // Water over an open side goes to the sea below; water through a side held to the sea is the sea's again.
        const w = this.toWorld(to[0], to[1], to[2]);
        if (!this.sea || to[1] < lo || to[1] > top[1]) this.sinks.push(w[0], w[2], volume);
        else this.given.push(w[0], w[2], volume);
        continue;
      }
      // A particle carried into a solid comes out at the solid's nearest face.
      const out = this.outOfSolid(to, x, y, z);
      const d = kept * PARTICLE_WORDS;
      if (d !== o) p.copyWithin(d, o, o + PARTICLE_WORDS);
      if (out) {
        p[d] = to[0];
        p[d + 1] = to[1];
        p[d + 2] = to[2];
      }
      kept++;
    }
    if (kept !== count) {
      p.fill(0, kept * PARTICLE_WORDS, count * PARTICLE_WORDS);
      this.words(this.countRegion)[0] = kept;
    }
    void LIQUID;
  }

  /**
   * The implicit density projection of T. Kugelstadt, A. Longva, N. Thuerey and J. Bender ("Implicit density projection
   * for volume conserving liquids", IEEE TVCG 27(4), 2021, Algorithm 1 and eqs. 10 to 12), after the particles moved:
   * the particles' density on the grid (trilinear, eight particles a cell at rest), held at 1 or more beside the air
   * (the surface's particle deficiency) and to 0.5 to 1.5 (one cell's correction a step at most); a second solve of the
   * pressure equation with that deviation as its source; and the particles moved by its gradient, their velocities
   * left alone. Without it particles cluster where the flow converges and at the walls they are held against, and the
   * liquid they stand for loses volume (water on a deck lost two fifths of its cells in six seconds).
   */
  private correctDensity(dt: number): void {
    const g = this.grid,
      { nx, ny, nz, h } = g,
      p = this.words(this.particleRegion),
      count = this.words(this.countRegion)[0]!;
    if (count === 0) return;
    for (let c = 0; c < this.kind.length; c++) this.kind[c] = this.solid[c] ? SOLID : 0;
    surface(g, p, count, h, 0.5 * h, this.kind, this.phi);
    // Particles per cell at rest: eight. The density over the rest density, trilinear at the cell centres, starting from
    // the walls' share (the solids and the closed sides sampled as water at rest, the paper's cure for the particle
    // deficiency at walls).
    const ratio = this.wallDensity().slice();
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        gx = p[o]! / h - 0.5,
        gy = p[o + 1]! / h - 0.5,
        // One cell deep, every particle is wholly in that layer.
        gz = nz > 1 ? p[o + 2]! / h - 0.5 : 0,
        i0 = Math.floor(gx),
        j0 = Math.floor(gy),
        k0 = Math.floor(gz),
        fx = gx - i0,
        fy = gy - j0,
        fz = gz - k0;
      for (let dk = 0; dk < 2; dk++) {
        const k = k0 + dk;
        if (k < 0 || k >= nz) continue;
        const wz = nz > 1 ? (dk ? fz : 1 - fz) : dk ? 0 : 1;
        for (let dj = 0; dj < 2; dj++) {
          const j = j0 + dj;
          if (j < 0 || j >= ny) continue;
          const wy = dj ? fy : 1 - fy;
          for (let di = 0; di < 2; di++) {
            const i = i0 + di;
            if (i < 0 || i >= nx) continue;
            ratio[cell(g, i, j, k)]! += ((di ? fx : 1 - fx) * wy * wz) / 8;
          }
        }
      }
    }
    // Next to air the kernels reach cells no particle fills: no less than the rest density there.
    const source = new Float64Array(nx * ny * nz);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k);
          if (this.kind[c] !== LIQUID) continue;
          let r = ratio[c]!;
          const air = (ii: number, jj: number, kk: number) =>
            ii >= 0 &&
            jj >= 0 &&
            kk >= 0 &&
            ii < nx &&
            jj < ny &&
            kk < nz &&
            this.kind[cell(g, ii, jj, kk)] !== LIQUID &&
            !this.solid[cell(g, ii, jj, kk)];
          if (
            air(i - 1, j, k) ||
            air(i + 1, j, k) ||
            air(i, j - 1, k) ||
            air(i, j + 1, k) ||
            (nz > 1 && (air(i, j, k - 1) || air(i, j, k + 1)))
          )
            r = Math.max(r, 1);
          r = Math.min(1.5, Math.max(0.5, r));
          // The displacement's divergence is the density's excess: dense water spreads, thin water draws in.
          source[c] = (r - 1) / dt;
        }
    for (const a of this.vel) a.fill(0);
    // In a sea, the band's water is the sea's, its density held by the refill: the correction leaves it alone, the band a
    // wall to it (no particle moved across its inner edge). Moving particles out of the band's full cells into the
    // interior, which the refill then topped up again, pumped the sea into the box: 7 mm of water in 2 s under a 3 cm
    // wave, and the waves inside ran a fifth of a radian ahead of the sea.
    let kinds = this.kind;
    if (this.sea) {
      kinds = this.kind.slice();
      for (let k = 0; k < nz; k++)
        for (let i = 0; i < nx; i++)
          if (this.sideDistance(i, k) < this.blend) for (let j = 0; j < ny; j++) kinds[cell(g, i, j, k)] = SOLID;
    }
    project(
      g,
      kinds,
      this.phi,
      this.vel[0]!,
      this.vel[1]!,
      this.vel[2]!,
      dt,
      this.density,
      new Float64Array(nx * ny * nz),
      this.open,
      // The sea's sides hold their faces (here at rest), so the correction moves no water through them.
      this.sea ? [true, true, false, false, nz > 1, nz > 1] : undefined,
      1e-6,
      400,
      source,
    );
    // The displacement reads inside the walls as beside them, so particles slip along a solid as along the box's sides.
    extrapolate(g, this.kind, this.vel, 1, undefined, true);
    const d: V3 = [0, 0, 0],
      lo = 1e-6 * h,
      top: V3 = [nx * h - lo, ny * h - lo, nz * h - lo];
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS;
      if (this.sea && this.sideDistance(Math.floor(p[o]! / h), Math.floor(p[o + 2]! / h)) < this.blend) continue;
      sampleVelocity(g, this.vel, p[o]!, p[o + 1]!, p[o + 2]!, d, this.wallMask);
      const to: V3 = [p[o]! + d[0] * dt, p[o + 1]! + d[1] * dt, p[o + 2]! + d[2] * dt];
      for (let a = 0; a < 3; a++) to[a] = Math.min(Math.max(to[a]!, lo), top[a]!);
      if (!this.outOfSolid(to, p[o]!, p[o + 1]!, p[o + 2]!)) continue;
      p[o] = to[0];
      p[o + 1] = to[1];
      p[o + 2] = to[2];
    }
  }

  /**
   * Moves a point `to` (m from the box's corner) that lies in a solid cell out to a face of the solid it is in, just
   * outside, keeping its other coordinates. The nearest point of a box's surface from inside lies along an axis, so it
   * walks each axis to the first cell that is not solid (and inside the box) and takes the nearest of those faces that
   * (fx, fy, fz), where the particle was, lies outside of: a particle comes back out the side it went in, never through a thin
   * solid. Returns false, leaving the point, only for a point walled in on every side, which the step then leaves where
   * it was.
   */
  protected outOfSolid(to: V3, fx: number, fy: number, fz: number): boolean {
    const g = this.grid,
      { nx, ny, nz, h } = g,
      ci = Math.floor(to[0] / h),
      cj = Math.floor(to[1] / h),
      ck = Math.floor(to[2] / h);
    if (!this.solid[cell(g, ci, cj, ck)]) return true;
    const size = [nx, ny, nz],
      from = [fx, fy, fz],
      lo = 1e-6 * h;
    let best = Infinity,
      axis = -1,
      face = 0,
      bestAny = Infinity,
      axisAny = -1,
      faceAny = 0;
    for (let a = 0; a < 3; a++)
      for (const dir of [-1, 1]) {
        const c = [ci, cj, ck];
        while (c[a]! >= 0 && c[a]! < size[a]! && this.solid[cell(g, c[0]!, c[1]!, c[2]!)]) c[a]! += dir;
        if (c[a]! < 0 || c[a]! >= size[a]!) continue;
        // The face between the last solid cell and the free cell c, and a point a hair into c.
        const plane = dir > 0 ? c[a]! * h : (c[a]! + 1) * h,
          f = plane + dir * lo,
          dist = Math.abs(f - to[a]!);
        if (dist < bestAny) [bestAny, axisAny, faceAny] = [dist, a, f];
        if ((dir > 0 ? from[a]! >= plane : from[a]! <= plane) && dist < best) [best, axis, face] = [dist, a, f];
      }
    if (axis < 0) [axis, face] = [axisAny, faceAny];
    if (axis < 0) return false;
    to[axis] = face;
    return true;
  }

  private walls: Float64Array | null = null;
  /**
   * The share of each cell centre's density that the walls give, as if every solid cell and a layer of cells beyond each
   * closed side held eight particles at their octants' centres, at rest. Made once (the walls do not move in the box).
   */
  private wallDensity(): Float64Array {
    if (this.walls) return this.walls;
    const g = this.grid,
      { nx, ny, nz } = g,
      out = new Float64Array(nx * ny * nz),
      flat = nz === 1;
    // Every cell of the grid grown by one on each side: a wall if solid, or beyond a closed side.
    for (let k = flat ? 0 : -1; k <= (flat ? 0 : nz); k++)
      for (let j = -1; j <= ny; j++)
        for (let i = -1; i <= nx; i++) {
          const inside = i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz;
          if (inside ? !this.solid[cell(g, i, j, k)] : this.isOpen(i, j, k)) continue;
          for (let o = 0; o < 8; o++) {
            // The virtual particle's place in cells, less a half: the trilinear weights onto the cell centres.
            const gx = i + 0.25 + 0.5 * (o & 1) - 0.5,
              gy = j + 0.25 + 0.5 * ((o >> 1) & 1) - 0.5,
              gz = flat ? 0 : k + 0.25 + 0.5 * ((o >> 2) & 1) - 0.5,
              i0 = Math.floor(gx),
              j0 = Math.floor(gy),
              k0 = Math.floor(gz),
              fx = gx - i0,
              fy = gy - j0,
              fz = gz - k0;
            for (let dk = 0; dk < 2; dk++) {
              const kk = k0 + dk;
              if (kk < 0 || kk >= nz) continue;
              const wz = flat ? (dk ? 0 : 1) : dk ? fz : 1 - fz;
              for (let dj = 0; dj < 2; dj++) {
                const jj = j0 + dj;
                if (jj < 0 || jj >= ny) continue;
                const wy = dj ? fy : 1 - fy;
                for (let di = 0; di < 2; di++) {
                  const ii = i0 + di;
                  if (ii < 0 || ii >= nx) continue;
                  const c = cell(g, ii, jj, kk);
                  if (!this.solid[c]) out[c]! += ((di ? fx : 1 - fx) * wy * wz) / 8;
                }
              }
            }
          }
        }
    this.walls = out;
    return out;
  }

  /** Whether the cell (i, j, k), outside the grid, is beyond an open side (air) rather than a wall. */
  private isOpen(i: number, j: number, k: number): boolean {
    const { nx, ny, nz } = this.grid;
    return (
      (i < 0 && this.open[0]!) ||
      (i >= nx && this.open[1]!) ||
      (j < 0 && this.open[2]!) ||
      (j >= ny && this.open[3]!) ||
      (k < 0 && this.open[4]!) ||
      (k >= nz && this.open[5]!)
    );
  }

  /** Adds the acceleration the liquid feels to every face it reaches, over `dt`. */
  private accelerate(dt: number): void {
    const g = this.grid,
      { h } = g,
      acc: V3 = [0, 0, 0];
    if (!this.varying()) {
      this.acceleration(0, 0, 0, acc, acc);
      for (let a = 0; a < 3; a++) {
        const ga = acc[a]!;
        if (ga === 0) continue;
        const va = this.vel[a]!,
          ma = this.mass[a]!;
        for (let f = 0; f < va.length; f++) if (ma[f]! > 0) va[f]! += ga * dt;
      }
      return;
    }
    // Each face's own: its place and the velocity there (the other components interpolated from the faces as they stood).
    const before = this.vel.map((a) => a.slice()),
      v: V3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const [mx, my, mz] = a === 0 ? [g.nx + 1, g.ny, g.nz] : a === 1 ? [g.nx, g.ny + 1, g.nz] : [g.nx, g.ny, g.nz + 1],
        va = this.vel[a]!,
        ma = this.mass[a]!;
      for (let k = 0; k < mz; k++)
        for (let j = 0; j < my; j++)
          for (let i = 0; i < mx; i++) {
            const f = i + mx * (j + my * k);
            if (!(ma[f]! > 0)) continue;
            const x = (i + (a === 0 ? 0 : 0.5)) * h,
              y = (j + (a === 1 ? 0 : 0.5)) * h,
              z = (k + (a === 2 ? 0 : 0.5)) * h;
            sampleVelocity(g, before, x, y, z, v, this.wallMask);
            this.acceleration(x, y, z, v, acc);
            va[f]! += acc[a]! * dt;
          }
    }
  }

  /** The box as the sea is at time `t`: eight particles a cell below its surface, moving as its water does. */
  private seedSea(t: number): void {
    const sea = this.sea!;
    this.seed((x, y, z) => {
      const w = this.toWorld(x, y, z);
      return w[1] < sea.elevation(w[0], w[2], t);
    });
    const { p, count } = this.state();
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        w = this.toWorld(p[o]!, p[o + 1]!, p[o + 2]!),
        v = sea.water.sample(w[0], w[1], w[2], t, this.flow).velocity;
      p[o + 3] = v[0];
      p[o + 4] = v[1];
      p[o + 5] = v[2];
    }
  }

  /** How far a cell (i, k) is from the box's nearest side along x or z, in cells (0 at the side). */
  private sideDistance(i: number, k: number): number {
    const { nx, nz } = this.grid;
    return Math.min(i, nx - 1 - i, nz > 1 ? Math.min(k, nz - 1 - k) : Infinity);
  }

  /**
   * The band at the step's start holds the sea's water: each cell keeps eight particles times its share under the sea's
   * surface, giving up its highest when it holds more and taking new ones, moving as the sea does, at its free octants'
   * centres (lowest first) when it holds fewer. Topping up only the cells that held no particle at all, as the band did
   * first, let water drain out at the sides: a cell a wave or the density projection left two particles short kept the
   * shortfall, and the box's sea level fell step after step.
   */
  private refill(t: number): void {
    const sea = this.sea!,
      g = this.grid,
      { nx, ny, nz, h } = g,
      p = this.words(this.particleRegion),
      countWords = this.words(this.countRegion),
      // How many particles each band cell holds as the sea: eight times its share under the sea's surface (read at the
      // column's centre); -1 off the band.
      target = new Int8Array(nx * ny * nz).fill(-1),
      held = new Map<number, number[]>();
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        if (this.sideDistance(i, k) >= this.blend) continue;
        const w = this.toWorld((i + 0.5) * h, 0, (k + 0.5) * h),
          e = sea.elevation(w[0], w[2], t) - this.origin[1];
        for (let j = 0; j < ny; j++) {
          const c = cell(g, i, j, k);
          if (!this.solid[c]) target[c] = Math.round(8 * Math.min(1, Math.max(0, e / h - j)));
        }
      }
    let count = countWords[0]!;
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        c = cell(g, Math.floor(p[o]! / h), Math.floor(p[o + 1]! / h), Math.floor(p[o + 2]! / h));
      if (target[c]! < 0) continue;
      const list = held.get(c);
      if (list) list.push(q);
      else held.set(c, [q]);
    }
    // A cell holding more than the sea's share gives up its highest particles.
    const gone = new Uint8Array(count);
    for (const [c, list] of held) {
      const extra = list.length - target[c]!;
      if (extra <= 0) continue;
      list.sort((a, b) => p[b * PARTICLE_WORDS + 1]! - p[a * PARTICLE_WORDS + 1]! || a - b);
      for (let n = 0; n < extra; n++) {
        const o = list[n]! * PARTICLE_WORDS,
          w = this.toWorld(p[o]!, p[o + 1]!, p[o + 2]!);
        gone[list[n]!] = 1;
        this.given.push(w[0], w[2], (h * h * h) / 8);
      }
      held.set(c, list.slice(extra));
    }
    let kept = 0;
    const moved = new Int32Array(count);
    for (let q = 0; q < count; q++) {
      moved[q] = kept;
      if (gone[q]) continue;
      if (kept !== q) p.copyWithin(kept * PARTICLE_WORDS, q * PARTICLE_WORDS, (q + 1) * PARTICLE_WORDS);
      kept++;
    }
    p.fill(0, kept * PARTICLE_WORDS, count * PARTICLE_WORDS);
    count = kept;
    // A cell holding fewer takes new ones moving as the sea's water, at its free octants' centres, lowest first.
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k),
            want = target[c]!,
            list = held.get(c) ?? [];
          if (want <= list.length) continue;
          let taken = 0;
          for (const q of list) {
            const o = moved[q]! * PARTICLE_WORDS,
              octant =
                (p[o]! / h - i >= 0.5 ? 1 : 0) |
                (p[o + 1]! / h - j >= 0.5 ? 2 : 0) |
                (p[o + 2]! / h - k >= 0.5 ? 4 : 0);
            taken |= 1 << octant;
          }
          let have = list.length;
          for (const o of [0, 1, 4, 5, 2, 3, 6, 7]) {
            if (have >= want) break;
            if (taken & (1 << o)) continue;
            const x = (i + 0.25 + 0.5 * (o & 1)) * h,
              y = (j + 0.25 + 0.5 * ((o >> 1) & 1)) * h,
              z = (k + 0.25 + 0.5 * ((o >> 2) & 1)) * h,
              w = this.toWorld(x, y, z);
            if (count >= this.capacity)
              throw new MargoError(
                'state',
                `The liquid holds at most ${this.capacity} particles and the sea brings more; raise capacity.`,
              );
            const v = sea.water.sample(w[0], w[1], w[2], t, this.flow).velocity,
              at = count * PARTICLE_WORDS;
            p.fill(0, at, at + PARTICLE_WORDS);
            p.set([x, y, z, v[0], v[1], v[2]], at);
            this.given.push(w[0], w[2], (-h * h * h) / 8);
            count++;
            have++;
          }
        }
    countWords[0] = count;
  }

  /**
   * Holds the band to the sea over a substep: its faces under the sea's surface relax to the sea's velocity by
   * b = (1 - d / blend)^2, d the face's distance from the side in cells (1 at the side, which takes the sea's velocity
   * outright, 0 at the band's inner edge); faces above the surface are left to the liquid.
   */
  private holdToSea(dt: number): void {
    const sea = this.sea!,
      g = this.grid,
      { h } = g,
      t = this.time;
    for (let a = 0; a < 3; a++) {
      const [mx, my, mz] = a === 0 ? [g.nx + 1, g.ny, g.nz] : a === 1 ? [g.nx, g.ny + 1, g.nz] : [g.nx, g.ny, g.nz + 1],
        va = this.vel[a]!;
      for (let k = 0; k < mz; k++)
        for (let i = 0; i < mx; i++) {
          // Distance from the nearest x or z side, in cells, for this face's place.
          const fx = i + (a === 0 ? 0 : 0.5),
            fz = k + (a === 2 ? 0 : 0.5),
            d = Math.min(fx, g.nx - fx, g.nz > 1 ? Math.min(fz, g.nz - fz) : Infinity);
          if (d >= this.blend) continue;
          const e = 1 - d / this.blend,
            b = e * e;
          for (let j = 0; j < my; j++) {
            const x = fx * h,
              y = (j + (a === 1 ? 0 : 0.5)) * h,
              z = fz * h,
              w = this.toWorld(x, y, z);
            const f = i + mx * (j + my * k);
            if (!(w[1] < sea.elevation(w[0], w[2], t))) {
              if (d === 0) va[f] = 0;
              continue;
            }
            const v = sea.water.sample(w[0], w[1], w[2], t, this.flow).velocity[a]!;
            va[f] = d === 0 ? v : (1 - b) * va[f]! + b * v;
          }
        }
    }
  }

  /** A point m from the box's corner, m from the world's cell. */
  protected toWorld(x: number, y: number, z: number): V3 {
    return [x + this.origin[0], y + this.origin[1], z + this.origin[2]];
  }

  /**
   * The water that left over the open sides in the last step, for a WakeSolver's `sources`: one source a cell it
   * left from, its volume going into the sea. `sources: (t) => liquid.seaSources()`.
   */
  seaSources(): { x: number; z: number; radius: number; pressure: number; volume: number }[] {
    const h = this.grid.h,
      cells = new Map<string, { x: number; z: number; volume: number }>();
    for (let k = 0; k < this.sinks.length; k += 3) {
      const x = this.sinks[k]!,
        z = this.sinks[k + 1]!,
        key = `${Math.floor(x / h)},${Math.floor(z / h)}`,
        at = cells.get(key);
      if (at) at.volume += this.sinks[k + 2]!;
      else
        cells.set(key, {
          x: (Math.floor(x / h) + 0.5) * h,
          z: (Math.floor(z / h) + 0.5) * h,
          volume: this.sinks[k + 2]!,
        });
    }
    return [...cells.values()].map((c) => ({ x: c.x, z: c.z, radius: 2 * h, pressure: 0, volume: c.volume }));
  }

  /** How many particles the liquid holds. */
  get count(): number {
    return this.words(this.countRegion)[0]!;
  }

  /** The particles' positions, m from the world's cell (x, y, z each), for drawing. Writes into `out` when given. */
  positions(out?: Float32Array): Float32Array {
    const { p, count } = this.state(),
      a = out && out.length >= 3 * count ? out : new Float32Array(3 * count);
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS;
      const w = this.toWorld(p[o]!, p[o + 1]!, p[o + 2]!);
      a[3 * q] = w[0];
      a[3 * q + 1] = w[1];
      a[3 * q + 2] = w[2];
    }
    return a;
  }

  /** The liquid's velocity at (x, y, z) m from the world's cell, from the last substep's grid. */
  velocityAt(x: number, y: number, z: number, out: V3 = [0, 0, 0]): V3 {
    return sampleVelocity(
      this.grid,
      this.vel,
      x - this.origin[0],
      y - this.origin[1],
      z - this.origin[2],
      out,
      this.wallMask,
    );
  }

  /** The pressure (Pa above the air's) in the cell holding (x, y, z) m from the world's cell; 0 in air or outside. */
  pressureAt(x: number, y: number, z: number): number {
    const { nx, ny, nz, h } = this.grid,
      i = Math.floor((x - this.origin[0]) / h),
      j = Math.floor((y - this.origin[1]) / h),
      k = Math.floor((z - this.origin[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    const c = cell(this.grid, i, j, k);
    return this.kind[c] === LIQUID ? this.words(this.pressureRegion)[c]! : 0;
  }

  /** What the last step took: its substeps and the last projection's conjugate-gradient iterations. */
  get stats(): { substeps: number; iterations: number } {
    return { substeps: this.lastSubsteps, iterations: this.lastIterations };
  }

  exportPorts(tick: number): readonly Port[] {
    return this.seaRegion && this.seaSourceField
      ? [{ field: this.seaSourceField.name, region: this.seaRegion, tick, cell: [0, 0, 0] }]
      : [];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.countRegion, this.particleRegion, this.pressureRegion, this.airRegion].filter(
      (r): r is Region => r !== null,
    );
  }

  /**
   * The air the liquid has closed over: its cells that are not liquid and that the open air cannot reach (from the box's
   * top and its other sides, through cells that are not liquid or solid), measured by the water missing from them and
   * the cells round them. More than they have held since there were none is air newly taken in, the
   * cavity a plunging jet closes when it lands, which breaks up into bubbles (G. B. Deane and M. D. Stokes, Nature 418,
   * 839-844, 2002); it is this step's aeration, at the cavity's middle.
   */
  private trapAir(first: boolean, baseDt: number): void {
    const g = this.grid,
      { nx, ny, nz, h } = g,
      n = nx * ny * nz,
      open = new Uint8Array(n),
      stack: number[] = [],
      free = (c: number) => this.kind[c] !== LIQUID && this.kind[c] !== SOLID;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const edge = i === 0 || i === nx - 1 || j === ny - 1 || (nz > 1 && (k === 0 || k === nz - 1));
          const c = cell(g, i, j, k);
          if (edge && free(c)) {
            open[c] = 1;
            stack.push(c);
          }
        }
    while (stack.length > 0) {
      const c = stack.pop()!,
        i = c % nx,
        j = Math.floor(c / nx) % ny,
        k = Math.floor(c / (nx * ny));
      for (const [di, dj, dk] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const) {
        const ii = i + di,
          jj = j + dj,
          kk = k + dk;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const o = cell(g, ii, jj, kk);
        if (open[o] || !free(o)) continue;
        open[o] = 1;
        stack.push(o);
      }
    }
    // The cavity's air: over its cells and the ring of cells round them, the cells' volume less the water their
    // particles stand for (an eighth of a cell each), so the air is counted where the particles are missing rather than
    // where phi, a fraction of a cell inside the water, puts the surface.
    const { p, count } = this.state(),
      held = new Uint8Array(n),
      near = new Uint8Array(n);
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        c = cell(
          g,
          Math.min(nx - 1, Math.floor(p[o]! / h)),
          Math.min(ny - 1, Math.floor(p[o + 1]! / h)),
          Math.min(nz - 1, Math.floor(p[o + 2]! / h)),
        );
      if (held[c]! < 255) held[c]!++;
    }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k);
          if (open[c] || !free(c)) continue;
          for (let dk = nz > 1 ? -1 : 0; dk <= (nz > 1 ? 1 : 0); dk++)
            for (let dj = -1; dj <= 1; dj++)
              for (let di = -1; di <= 1; di++) {
                const ii = i + di,
                  jj = j + dj,
                  kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                const o = cell(g, ii, jj, kk);
                if (!open[o] && this.kind[o] !== SOLID) near[o] = 1;
              }
        }
    let volume = 0,
      sx = 0,
      sy = 0,
      sz = 0,
      lo: V3 = [Infinity, Infinity, Infinity],
      hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(g, i, j, k);
          if (!near[c]) continue;
          const v = (Math.max(0, 8 - held[c]!) * h * h * h) / 8;
          if (v === 0) continue;
          const x = (i + 0.5) * h,
            y = (j + 0.5) * h,
            z = (k + 0.5) * h;
          volume += v;
          sx += v * x;
          sy += v * y;
          sz += v * z;
          lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
          hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
        }
    const cells = volume > 0 ? 1 : 0;
    const air = this.words(this.airRegion),
      taken = volume - air[0]!;
    if (first) this.newAir = null;
    if (cells > 0 && taken > 0) {
      const w = this.toWorld(sx / volume, sy / volume, sz / volume),
        was = this.newAir,
        width = Math.max(h, hi[0] - lo[0] + h, hi[2] - lo[2] + h),
        depth = Math.max(h, hi[1] - lo[1] + h, pow(volume, 1 / 3)),
        rate = taken / baseDt;
      // Air taken in over earlier steps of this base step joins it, at the middle of the two weighted by their air.
      this.newAir = was
        ? {
            position: [0, 1, 2].map((a) => (was.position[a]! * was.rate + w[a]! * rate) / (was.rate + rate)) as V3,
            width: Math.max(was.width, width),
            depth: Math.max(was.depth, depth),
            rate: was.rate + rate,
          }
        : { position: w, width, depth, rate };
      // The surface over the cavity whitens, as the foam solver's active breakers do.
      this.foam?.addFoam(
        [this.origin[0] + lo[0] - h / 2, this.origin[2] + lo[2] - h / 2],
        [this.origin[0] + hi[0] + h / 2, this.origin[2] + hi[2] + h / 2],
        1,
      );
    }
    // The air held: the most the cavities have held since there were none. A cavity's walls falling in spread its missing
    // water over more cells and a fraction more of it reads as air, which is not air taken in.
    air[0] = cells > 0 ? Math.max(air[0]!, volume) : 0;
    air[1] = cells > 0 ? sx / volume : 0;
    air[2] = cells > 0 ? sy / volume : 0;
    air[3] = cells > 0 ? sz / volume : 0;
  }

  /**
   * The air the liquid closed over in the world's last base step (60 Hz; one or more of this solver's steps), as a source
   * for a BubbleSolver of `@margoengine/physics/bubbles` stepping at the base rate (`sources: () => liquid.aeration()`):
   * the cavity a plunging jet traps, which breaks up into bubbles. Empty when no new air was taken in. Air carried down under a cell's size (by drops, or a jet's rim) is not seen.
   */
  aeration(): LiquidAeration[] {
    return this.newAir ? [this.newAir] : [];
  }

  /**
   * The water in the air now, spray, drops and sheets thinner than the grid resolves: x, y, z (m from the world's cell)
   * and velocity (m/s) of each particle in a cell that is not liquid or in a liquid cell with no liquid beside it (a drop
   * of a cell or less), six numbers a particle. Each is an eighth of a cell of water.
   */
  spray(): Float64Array {
    const { p, count } = this.state(),
      g = this.grid,
      { nx, ny, nz, h } = g,
      out: number[] = [],
      // A liquid cell with no liquid beside it is a drop, a cell of water on its own.
      lone = (c: number): boolean => {
        const i = c % nx,
          j = Math.floor(c / nx) % ny,
          k = Math.floor(c / (nx * ny)),
          liquid = (ii: number, jj: number, kk: number) =>
            ii >= 0 && jj >= 0 && kk >= 0 && ii < nx && jj < ny && kk < nz && this.kind[cell(g, ii, jj, kk)] === LIQUID;
        return !(
          liquid(i - 1, j, k) ||
          liquid(i + 1, j, k) ||
          liquid(i, j - 1, k) ||
          liquid(i, j + 1, k) ||
          liquid(i, j, k - 1) ||
          liquid(i, j, k + 1)
        );
      };
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        c = cell(
          g,
          Math.min(nx - 1, Math.floor(p[o]! / h)),
          Math.min(ny - 1, Math.floor(p[o + 1]! / h)),
          Math.min(nz - 1, Math.floor(p[o + 2]! / h)),
        );
      if (this.kind[c] === SOLID || (this.kind[c] === LIQUID && !lone(c))) continue;
      const w = this.toWorld(p[o]!, p[o + 1]!, p[o + 2]!);
      out.push(w[0], w[1], w[2], p[o + 3]!, p[o + 4]!, p[o + 5]!);
    }
    return Float64Array.from(out);
  }

  extraState(): readonly Region[] {
    return [];
  }
}

void rateOf;

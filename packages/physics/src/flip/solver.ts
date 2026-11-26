// A grid-particle liquid (FLUID-03) as a solver of the physics framework (docs/physics-framework.md, sections 4 and 5): water
// that splashes, overturns and pours, in a box of cells. APIC particles carry it (transfer.ts) and a MAC grid with a free
// surface keeps it incompressible (grid.ts); each world step runs as many substeps as keep every particle within a cell a
// substep. Its particles and its pressure are world state (snapshot, restore and hash), so a seek replays it.
//
// Checked against the dam break of J. C. Martin and W. J. Moyce, "An experimental study of the collapse of liquid columns
// on a rigid horizontal plane", Phil. Trans. R. Soc. A 244, 312-324, 1952 (their table 2, n^2 = 2: the front's position
// against time), and against still water's hydrostatic pressure.
import { MargoError } from '@margoengine/math/errors';
import {
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
}

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
  protected sea: LiquidSea | null = null;
  protected blend = 6;
  /** The time of the substep being taken, s on the world clock. */
  protected time = 0;
  private readonly flow = { velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0 };
  private lastSubsteps = 0;
  private lastIterations = 0;

  constructor(readonly id = 'liquid') {}

  describe(): SolverDescription {
    return { id: this.id, fields: [], rate: this.level, stableRate: () => this.level };
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
    } = params;
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
    this.pressureRegion = host.allocate(`${this.id}:pressure`, n * 8, 'f64', FLIP_LAYOUT);
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
    this.accelerate(dt);
    if (this.sea) this.holdToSea(dt);
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
        if (!this.sea || to[1] < lo || to[1] > top[1]) {
          const w = this.toWorld(to[0], to[1], to[2]);
          this.sinks.push(w[0], w[2], volume);
        }
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
    project(
      g,
      this.kind,
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
   * The band at the step's start: its cells under the sea's surface that hold no particle take eight, moving as the sea
   * does; its particles above the sea's surface go, so the band's water stands at the sea's level.
   */
  private refill(t: number): void {
    const sea = this.sea!,
      { nx, ny, nz, h } = this.grid,
      p = this.words(this.particleRegion),
      countWords = this.words(this.countRegion),
      held = new Uint8Array(nx * ny * nz);
    let count = countWords[0]!,
      kept = 0;
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        i = Math.floor(p[o]! / h),
        j = Math.floor(p[o + 1]! / h),
        k = Math.floor(p[o + 2]! / h),
        w = this.toWorld(p[o]!, p[o + 1]!, p[o + 2]!);
      if (this.sideDistance(i, k) < this.blend && w[1] > sea.elevation(w[0], w[2], t)) continue;
      held[cell(this.grid, i, j, k)] = 1;
      if (kept !== q) p.copyWithin(kept * PARTICLE_WORDS, o, o + PARTICLE_WORDS);
      kept++;
    }
    p.fill(0, kept * PARTICLE_WORDS, count * PARTICLE_WORDS);
    count = kept;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          if (this.sideDistance(i, k) >= this.blend) continue;
          const c = cell(this.grid, i, j, k);
          if (held[c] || this.solid[c]) continue;
          for (let o = 0; o < 8; o++) {
            const x = (i + 0.25 + 0.5 * (o & 1)) * h,
              y = (j + 0.25 + 0.5 * ((o >> 1) & 1)) * h,
              z = (k + 0.25 + 0.5 * ((o >> 2) & 1)) * h,
              w = this.toWorld(x, y, z);
            if (!(w[1] < sea.elevation(w[0], w[2], t))) continue;
            if (count >= this.capacity)
              throw new MargoError(
                'state',
                `The liquid holds at most ${this.capacity} particles and the sea brings more; raise capacity.`,
              );
            const v = sea.water.sample(w[0], w[1], w[2], t, this.flow).velocity,
              at = count * PARTICLE_WORDS;
            p.fill(0, at, at + PARTICLE_WORDS);
            p.set([x, y, z, v[0], v[1], v[2]], at);
            count++;
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
      t = this.time + dt;
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

  exportPorts(_tick: number): readonly Port[] {
    return [];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.countRegion, this.particleRegion, this.pressureRegion].filter((r): r is Region => r !== null);
  }

  extraState(): readonly Region[] {
    return [];
  }
}

void rateOf;

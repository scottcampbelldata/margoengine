// Green water on a hull's deck (FLUID-03): a grid-particle liquid in a box that rides with a rigid body. The box's cells
// are fixed in the body's frame, so the water feels the frame's acceleration besides gravity, per unit mass
// R^T (g - a_c) - alpha x r - w x (w x r) - 2 w x v (r from the centre of mass, w and alpha the body's spin and its rate,
// a_c its centre's acceleration, all in the body's axes), the d'Alembert, centrifugal, Euler and Coriolis terms of a
// rotating frame (H. Goldstein, C. Poole and J. Safko, Classical Mechanics, 3rd ed., 2002, section 4.10). The sea comes in
// where it overtops the bulwarks, from the hull solver's `deckInflow` port; water that crosses an open side goes back to
// the sea (`seaSources()`); and the deck's load, the water's pressure on the box's walls and solids, holds the body
// through `bodyForces`. It claims its hull in `deckClaims`, so the hull solver leaves its own deck load out: one owner
// of the on-deck load a hull.
import { MargoError } from '@margoengine/math/errors';
import type { SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { rateOf } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { DECK_CLAIMS_FIELD, DECK_INFLOW_FIELD, DECK_INFLOW_WORDS } from '../world/deck.js';
import { regionWords } from '../world/memory.js';
import type { Port, Region } from '../world/solver.js';
import { cell, LIQUID, SOLID } from './grid.js';
import { FlipSolver, type FlipParams } from './solver.js';
import { PARTICLE_WORDS } from './transfer.js';

type V3 = [number, number, number];
type Q = readonly [number, number, number, number];

/** What a {@link DeckWaterSolver} is made from: a liquid's box, and the body it rides. */
export interface DeckWaterParams extends Omit<FlipParams, 'origin'> {
  /** The hull's kernel body row. */
  readonly row: number;
  /** The box's lowest corner in the body's frame, m (default [0, 0, 0]). */
  readonly offset?: readonly [number, number, number];
  /** Body rows the `bodyForces` and `deckClaims` ports cover (default one past the row). */
  readonly capacity?: number;
  /** Particles it may hold (default eight a cell). */
  readonly particles?: number;
}

/** Options of a {@link DeckWaterSolver}, fixed when it is made. */
export interface DeckWaterOptions {
  /** Take the sea's inflow from the `deckInflow` port (default true); false for a deck that only holds its own water. */
  readonly inflow?: boolean;
}

/** f64 words of the frame's memory: a flag, the centre's velocity and the spin at the last step. */
const FRAME_WORDS = 7;
const DECK_LAYOUT = 1;

/** Green water on a hull's deck, riding its body. `id` is `'deckWater'` unless a world holds more. */
export class DeckWaterSolver extends FlipSolver {
  private row = 0;
  private bodyCapacity = 0;
  private offset: V3 = [0, 0, 0];
  private readonly inflow: boolean;
  private frame: Region | null = null;
  private forcesRegion: Region | null = null;
  private claimsRegion: Region | null = null;
  private inflowCarry: Region | null = null;
  // The body this step, body axes: rotation, centre (body frame), spin, its rate, the frame's acceleration's uniform part.
  private q: Q = [0, 0, 0, 1];
  private position: V3 = [0, 0, 0];
  private centre: V3 = [0, 0, 0];
  private spin: V3 = [0, 0, 0];
  private spinRate: V3 = [0, 0, 0];
  private uniform: V3 = [0, -9.81, 0];

  constructor(id = 'deckWater', options: DeckWaterOptions = {}) {
    super(id);
    this.inflow = options.inflow ?? true;
  }

  override describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
        { field: DECK_CLAIMS_FIELD, access: 'write' },
        ...(this.inflow ? [{ field: DECK_INFLOW_FIELD, access: 'read' as const }] : []),
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  /** @throws RangeError for a body row, offset or capacity out of range, and what FlipSolver refuses. */
  override init(host: SolverHost, params: DeckWaterParams): void {
    const { row, offset = [0, 0, 0], capacity, particles, ...liquid } = params ?? ({} as DeckWaterParams);
    if (!(Number.isInteger(row) && row >= 0))
      throw new RangeError(
        `Deck water rides a kernel body row (got ${row}); pass the hull's row, a whole number of 0 or more.`,
      );
    if (!(offset.length === 3 && offset.every(Number.isFinite)))
      throw new RangeError("Deck water's offset is three finite numbers in the body's frame; pass [x, y, z].");
    const rows = capacity ?? row + 1;
    if (!(Number.isInteger(rows) && rows > row))
      throw new RangeError(`Deck water's capacity of ${rows} body rows misses row ${row}; set it above the row.`);
    super.init(host, { ...liquid, ...(particles !== undefined ? { capacity: particles } : {}) });
    this.row = row;
    this.bodyCapacity = rows;
    this.offset = [offset[0], offset[1], offset[2]];
    this.frame = host.allocate(`${this.id}:frame`, FRAME_WORDS * 8, 'f64', DECK_LAYOUT);
    this.forcesRegion = host.allocate(`${this.id}:forces`, rows * FORCE_WORDS * 8, 'f64', DECK_LAYOUT);
    this.claimsRegion = host.allocate(`${this.id}:claims`, rows * 8, 'f64', DECK_LAYOUT);
    // The inflow's volume not yet made into particles, m^3, and the particles it has made (for their places).
    this.inflowCarry = host.allocate(`${this.id}:inflow`, 2 * 8, 'f64', DECK_LAYOUT);
    (regionWords(host.memory, this.claimsRegion) as Float64Array)[row] = 1;
  }

  /** A point m from the box's corner, m from the world's cell, by the body's pose this step. */
  protected override toWorld(x: number, y: number, z: number): V3 {
    const r = rotate(this.q, [x + this.offset[0], y + this.offset[1], z + this.offset[2]]);
    return [r[0] + this.position[0], r[1] + this.position[1], r[2] + this.position[2]];
  }

  protected override varying(): boolean {
    return true;
  }

  protected override acceleration(x: number, y: number, z: number, v: V3, out: V3): V3 {
    // r from the centre of mass, body axes; - alpha x r - w x (w x r) - 2 w x v, plus the uniform part.
    const r: V3 = [
        x + this.offset[0] - this.centre[0],
        y + this.offset[1] - this.centre[1],
        z + this.offset[2] - this.centre[2],
      ],
      w = this.spin,
      al = this.spinRate,
      wr = cross(w, r),
      wwr = cross(w, wr),
      ar = cross(al, r),
      wv = cross(w, v);
    for (let a = 0; a < 3; a++) out[a] = this.uniform[a]! - ar[a]! - wwr[a]! - 2 * wv[a]!;
    return out;
  }

  protected override beforeStep(context: StepContext, dt: number): void {
    const host = this.host!,
      port = context.inputs.get(BODIES_FIELD.name);
    if (!port)
      throw new MargoError('state', 'Deck water reads its hull from the bodies port; add a RigidSolver to the world.');
    const memory = port.region.memory ?? host.memory,
      rows = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      at = this.row * BODY_WORDS;
    // A row holds a body (moving or fixed) when its rotation is a unit quaternion; an empty row's is all zeros.
    const qn = rows[at + 3]! ** 2 + rows[at + 4]! ** 2 + rows[at + 5]! ** 2 + rows[at + 6]! ** 2;
    if (at + BODY_WORDS > rows.length || !(qn > 0.5))
      throw new MargoError('state', `Deck water's hull row ${this.row} holds no body; add the hull before stepping.`);
    this.q = [rows[at + 3]!, rows[at + 4]!, rows[at + 5]!, rows[at + 6]!];
    this.position = [rows[at]!, rows[at + 1]!, rows[at + 2]!];
    const inverse: Q = [-this.q[0], -this.q[1], -this.q[2], this.q[3]],
      com: V3 = [rows[at + 7]!, rows[at + 8]!, rows[at + 9]!],
      v: V3 = [rows[at + 10]!, rows[at + 11]!, rows[at + 12]!],
      w: V3 = [rows[at + 13]!, rows[at + 14]!, rows[at + 15]!],
      frame = regionWords(host.memory, this.frame!) as Float64Array;
    this.centre = rotate(inverse, [com[0] - this.position[0], com[1] - this.position[1], com[2] - this.position[2]]);
    // The centre's acceleration and the spin's rate, from the last step (none at the first).
    const had = frame[0] === 1,
      ac: V3 = had ? [(v[0] - frame[1]!) / dt, (v[1] - frame[2]!) / dt, (v[2] - frame[3]!) / dt] : [0, 0, 0],
      dw: V3 = had ? [(w[0] - frame[4]!) / dt, (w[1] - frame[5]!) / dt, (w[2] - frame[6]!) / dt] : [0, 0, 0];
    frame.set([1, v[0], v[1], v[2], w[0], w[1], w[2]]);
    this.spin = rotate(inverse, w);
    this.spinRate = rotate(inverse, dw);
    this.uniform = rotate(inverse, [this.gravity[0] - ac[0], this.gravity[1] - ac[1], this.gravity[2] - ac[2]]);
    (regionWords(host.memory, this.claimsRegion!) as Float64Array)[this.row] = 1;
    if (this.inflow) this.takeInflow(context, dt);
  }

  /** The sea coming over the bulwarks: particles along each segment of this hull, as much volume as its flux brings. */
  private takeInflow(context: StepContext, dt: number): void {
    const port = context.inputs.get(DECK_INFLOW_FIELD.name);
    if (!port) return;
    const memory = port.region.memory ?? this.host!.memory,
      rec = new Float64Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 8),
      records = Math.min(rec[0]! | 0, Math.floor((rec.length - 1) / DECK_INFLOW_WORDS)),
      carry = regionWords(this.host!.memory, this.inflowCarry!) as Float64Array,
      { h, nx, ny, nz } = this.grid,
      volume = (h * h * h) / 8,
      p = this.words(this.particleRegion),
      countWords = this.words(this.countRegion);
    let count = countWords[0]!;
    for (let r = 0; r < records; r++) {
      const o = 1 + r * DECK_INFLOW_WORDS;
      if (rec[o] !== this.row) continue;
      const a: V3 = [rec[o + 1]! - this.offset[0], rec[o + 2]! - this.offset[1], rec[o + 3]! - this.offset[2]],
        b: V3 = [rec[o + 4]! - this.offset[0], rec[o + 5]! - this.offset[1], rec[o + 6]! - this.offset[2]],
        n: V3 = [rec[o + 7]!, rec[o + 8]!, rec[o + 9]!],
        depth = rec[o + 10]!,
        u: V3 = [rec[o + 11]!, rec[o + 12]!, rec[o + 13]!],
        flux = rec[o + 14]!;
      if (!(flux > 0 && depth > 0)) continue;
      carry[0]! += flux * dt;
      while (carry[0]! >= volume) {
        if (count >= this.capacity)
          throw new MargoError('state', `Deck water holds at most ${this.capacity} particles; raise its particles.`);
        // An R2 sequence (Roberts' low-discrepancy plastic-number sequence) by the particles made so far: along the
        // segment and up through the inflow's height, half a cell in from the bulwark.
        const k = carry[1]!,
          s = (0.5 + k * 0.7548776662466927) % 1,
          t = (0.5 + k * 0.5698402909980532) % 1,
          x = a[0] + s * (b[0] - a[0]) + 0.5 * h * n[0],
          y = a[1] + s * (b[1] - a[1]) + 0.5 * h * n[1] + t * depth,
          z = a[2] + s * (b[2] - a[2]) + 0.5 * h * n[2];
        carry[0]! -= volume;
        carry[1] = k + 1;
        if (!(x > 0 && y > 0 && z > 0 && x < nx * h && y < ny * h && z < nz * h)) continue;
        if (this.solid[cell(this.grid, Math.floor(x / h), Math.floor(y / h), Math.floor(z / h))]) continue;
        const at = count * PARTICLE_WORDS;
        p.fill(0, at, at + PARTICLE_WORDS);
        p[at] = x;
        p[at + 1] = y;
        p[at + 2] = z;
        p[at + 3] = u[0];
        p[at + 4] = u[1];
        p[at + 5] = u[2];
        count++;
      }
    }
    countWords[0] = count;
  }

  /** The deck's load: the water's pressure on every wall and solid face next to it, on the body through `bodyForces`. */
  protected override afterStep(): void {
    const out = regionWords(this.host!.memory, this.forcesRegion!) as Float64Array,
      { nx, ny, nz, h } = this.grid,
      pressure = this.words(this.pressureRegion),
      force: V3 = [0, 0, 0],
      torque: V3 = [0, 0, 0],
      area = h * h;
    out.fill(0);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = cell(this.grid, i, j, k);
          if (this.kind[c] !== LIQUID) continue;
          const pc = pressure[c]!;
          if (pc === 0) continue;
          for (const [di, dj, dk, side] of [
            [-1, 0, 0, 0],
            [1, 0, 0, 1],
            [0, -1, 0, 2],
            [0, 1, 0, 3],
            [0, 0, -1, 4],
            [0, 0, 1, 5],
          ] as const) {
            const ii = i + di,
              jj = j + dj,
              kk = k + dk,
              outside = ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz;
            if (outside ? this.open[side] : this.kind[cell(this.grid, ii, jj, kk)] !== SOLID) continue;
            // The wall's face half a cell out, pushed outward (from the water into the wall) by its pressure there: the
            // centre's, carried half a cell by the frame's acceleration (grad p = rho a for water at rest in the frame).
            const fx = (i + 0.5 + 0.5 * di) * h,
              fy = (j + 0.5 + 0.5 * dj) * h,
              fz = (k + 0.5 + 0.5 * dk) * h,
              acc = this.acceleration(fx, fy, fz, [0, 0, 0], [0, 0, 0]),
              pf = Math.max(0, pc + this.density * (acc[0] * di + acc[1] * dj + acc[2] * dk) * 0.5 * h),
              f: V3 = [pf * area * di, pf * area * dj, pf * area * dk],
              r: V3 = [
                fx + this.offset[0] - this.centre[0],
                fy + this.offset[1] - this.centre[1],
                fz + this.offset[2] - this.centre[2],
              ],
              t = cross(r, f);
            for (let a = 0; a < 3; a++) {
              force[a]! += f[a]!;
              torque[a]! += t[a]!;
            }
          }
        }
    const fw = rotate(this.q, force),
      tw = rotate(this.q, torque),
      w = this.row * FORCE_WORDS;
    out[w] = fw[0];
    out[w + 1] = fw[1];
    out[w + 2] = fw[2];
    out[w + 3] = tw[0];
    out[w + 4] = tw[1];
    out[w + 5] = tw[2];
  }

  override exportPorts(tick: number): readonly Port[] {
    return [
      { field: BODY_FORCES_FIELD.name, region: this.forcesRegion!, tick, cell: [0, 0, 0] as [number, number, number] },
      { field: DECK_CLAIMS_FIELD.name, region: this.claimsRegion!, tick, cell: [0, 0, 0] as [number, number, number] },
    ];
  }

  override stateRegions(): readonly Region[] {
    return [...super.stateRegions(), this.frame, this.inflowCarry].filter((r): r is Region => r !== null);
  }
}

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function rotate(q: Q, v: readonly number[]): V3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

void rateOf;

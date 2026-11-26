// Green water on a hull's deck (FLUID-03): a grid-particle liquid in a box that rides with a rigid body. The box's cells
// are fixed in the body's frame, so the water feels the frame's acceleration besides gravity, per unit mass
// R^T (g - a_c) - alpha x r - w x (w x r) - 2 w x v (r from the centre of mass, w and alpha the body's spin and its rate,
// a_c its centre's acceleration, from the last step), the d'Alembert, Euler, centrifugal and Coriolis terms of a rotating
// frame (H. Goldstein, C. Poole and J. Safko, Classical Mechanics, 3rd ed., 2002, section 4.10). Fed back to the hull as
// it is, that load diverges when the water outweighs the hull (the added-mass instability of P. Causin, J.-F. Gerbeau and
// F. Nobile, Comput. Methods Appl. Mech. Eng. 194, 2005). So the water rides with the hull as added mass, in the hull
// solver's solve: the load held is M (M + A)^-1 (F + A a_last + W + O) - W - O, A the water as a rigid body about the
// centre, F its pressure on the deck, A a_last the rigid share of the last step's acceleration that F already holds, and
// O every other load on the hull (contacts, joints, locks), seen in what moved it at the last step. The sea comes in
// where it overtops the bulwarks, from the hull solver's `deckInflow` port; water that crosses an open side goes back to
// the sea (`seaSources()`); and the deck's load, the water's pressure on the box's walls and solids, holds the body
// through `bodyForces`. It claims its hull in `deckClaims`, so the hull solver leaves its own deck load out: one owner
// of the on-deck load a hull.
import { MargoError } from '@margoengine/math/errors';
import type { SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { rateOf } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
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
  /**
   * Body rows the `bodyForces` and `deckClaims` ports cover: the world's (`PhysicsWorld.bodyRows`, the rigid world's
   * capacity), which it reads; given, it must be the same.
   */
  readonly capacity?: number;
  /** Particles it may hold (default eight a cell). */
  readonly particles?: number;
}

/** Options of a {@link DeckWaterSolver}, fixed when it is made. */
export interface DeckWaterOptions {
  /** Take the sea's inflow from the `deckInflow` port (default true); false for a deck that only holds its own water. */
  readonly inflow?: boolean;
}

const DECK_LAYOUT = 1;
/** Cells inward from a bulwark the sea's inflow may enter. */
const INFLOW_LAYERS = 4;

/** Green water on a hull's deck, riding its body. `id` is `'deckWater'` unless a world holds more. */
export class DeckWaterSolver extends FlipSolver {
  private row = 0;
  private bodyCapacity = 0;
  private offset: V3 = [0, 0, 0];
  private readonly inflow: boolean;
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
  /** The hull's last acceleration, world axes: the centre's (3) and the spin's rate (3). */
  private lastAcceleration = [0, 0, 0, 0, 0, 0];
  private hadLast = false;
  private frame: Region | null = null;
  /** The hull's mass and its world inertia this step (Infinity and zeros for a hull that does not move). */
  private hullMass = Infinity;
  private hullInertia: Float64Array = new Float64Array(9);

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
    const rows = bodyRowsOf(host, 'Deck water', [row], capacity);
    super.init(host, { ...liquid, ...(particles !== undefined ? { capacity: particles } : {}) });
    this.row = row;
    this.bodyCapacity = rows;
    this.offset = [offset[0], offset[1], offset[2]];
    this.forcesRegion = host.allocate(`${this.id}:forces`, rows * FORCE_WORDS * 8, 'f64', DECK_LAYOUT);
    this.claimsRegion = host.allocate(`${this.id}:claims`, rows * 8, 'f64', DECK_LAYOUT);
    // The inflow's volume not yet made into particles, m^3, and the particles it has made (for their places).
    this.inflowCarry = host.allocate(`${this.id}:inflow`, 2 * 8, 'f64', DECK_LAYOUT);
    // The hull's velocity and spin at the last step, for its acceleration: a flag, then six words; then the load held
    // over that step (six words), for the loads the solve does not see.
    this.frame = host.allocate(`${this.id}:frame`, 13 * 8, 'f64', DECK_LAYOUT);
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
      wr = cross(w, r),
      wwr = cross(w, wr),
      ar = cross(this.spinRate, r),
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
    const qx = rows[at + 3]!,
      qy = rows[at + 4]!,
      qz = rows[at + 5]!,
      qw = rows[at + 6]!,
      qn = qx * qx + qy * qy + qz * qz + qw * qw;
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
    this.hadLast = had;
    frame.set([1, v[0], v[1], v[2], w[0], w[1], w[2]]);
    this.lastAcceleration = [ac[0], ac[1], ac[2], dw[0], dw[1], dw[2]];
    this.spin = rotate(inverse, w);
    this.spinRate = rotate(inverse, dw);
    this.uniform = rotate(inverse, [this.gravity[0] - ac[0], this.gravity[1] - ac[1], this.gravity[2] - ac[2]]);
    const inverseMass = rows[at + 16]!;
    this.hullMass = inverseMass > 0 ? 1 / inverseMass : Infinity;
    this.hullInertia = invertSymmetric([
      rows[at + 17]!,
      rows[at + 18]!,
      rows[at + 19]!,
      rows[at + 20]!,
      rows[at + 21]!,
      rows[at + 22]!,
    ]);
    (regionWords(host.memory, this.claimsRegion!) as Float64Array)[this.row] = 1;
    if (this.inflow) this.takeInflow(context, dt);
  }

  /**
   * The sea coming over the bulwarks: particles along each segment of this hull, as much volume as its flux brings. Each
   * particle is an eighth of a cell of water, so each goes into a cell with room for it (fewer than eight): the first
   * of the cells inward from the bulwark, up to INFLOW_LAYERS deep, at its place along the segment and up through the
   * inflow's height. Packing them into full cells made a liquid of half the volume they stood for, whose load was half
   * their weight (KB-FLIP-DECKLOAD2). Volume that finds no room waits, at most two steps of the flux: a deck full by the
   * bulwark takes no more.
   */
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
    // How many particles each cell holds now.
    const held = new Uint8Array(nx * ny * nz);
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        c = cell(this.grid, Math.floor(p[o]! / h), Math.floor(p[o + 1]! / h), Math.floor(p[o + 2]! / h));
      if (held[c]! < 255) held[c]!++;
    }
    let flux = 0;
    for (let r = 0; r < records; r++) {
      const o = 1 + r * DECK_INFLOW_WORDS;
      if (rec[o] !== this.row) continue;
      const a: V3 = [rec[o + 1]! - this.offset[0], rec[o + 2]! - this.offset[1], rec[o + 3]! - this.offset[2]],
        b: V3 = [rec[o + 4]! - this.offset[0], rec[o + 5]! - this.offset[1], rec[o + 6]! - this.offset[2]],
        n: V3 = [rec[o + 7]!, rec[o + 8]!, rec[o + 9]!],
        depth = rec[o + 10]!,
        u: V3 = [rec[o + 11]!, rec[o + 12]!, rec[o + 13]!],
        q = rec[o + 14]!;
      if (!(q > 0 && depth > 0)) continue;
      flux += q;
      carry[0]! += q * dt;
      let misses = 0;
      while (carry[0]! >= volume && misses < 8) {
        if (count >= this.capacity)
          throw new MargoError('state', `Deck water holds at most ${this.capacity} particles; raise its particles.`);
        // An R2 sequence (Roberts' low-discrepancy plastic-number sequence) by the particles tried so far: along the
        // segment and up through the inflow's height.
        const k = carry[1]!,
          s = (0.5 + k * 0.7548776662466927) % 1,
          t = (0.5 + k * 0.5698402909980532) % 1;
        carry[1] = k + 1;
        let placed = false;
        for (let layer = 0; layer < INFLOW_LAYERS && !placed; layer++) {
          const inward = (layer + 0.5) * h,
            x = a[0] + s * (b[0] - a[0]) + inward * n[0],
            y = a[1] + s * (b[1] - a[1]) + inward * n[1] + t * depth,
            z = a[2] + s * (b[2] - a[2]) + inward * n[2];
          if (!(x > 0 && y > 0 && z > 0 && x < nx * h && y < ny * h && z < nz * h)) continue;
          const c = cell(this.grid, Math.floor(x / h), Math.floor(y / h), Math.floor(z / h));
          if (this.solid[c] || held[c]! >= 8) continue;
          held[c]!++;
          const at = count * PARTICLE_WORDS;
          p.fill(0, at, at + PARTICLE_WORDS);
          p[at] = x;
          p[at + 1] = y;
          p[at + 2] = z;
          p[at + 3] = u[0];
          p[at + 4] = u[1];
          p[at + 5] = u[2];
          count++;
          carry[0]! -= volume;
          placed = true;
        }
        misses = placed ? 0 : misses + 1;
      }
    }
    // Volume with no room waits, two steps of the flux at most.
    carry[0] = Math.min(carry[0]!, 2 * flux * dt);
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
      w = this.row * FORCE_WORDS,
      held = this.carried([...fw, ...tw]);
    for (let k = 0; k < 6; k++) out[w + k] = held[k]!;
  }

  /**
   * The load held over the step so the hull moves as if it carried its deck water rigidly: M (M + A)^-1 (F + W) - W in
   * world axes, A the water's mass m, its first moment m c about the hull's centre and its inertia about it, M the hull's
   * mass and inertia, W its weight. A hull that does not move takes F as it is.
   */
  private carried(f: number[]): number[] {
    if (!(this.hullMass < Infinity)) return f;
    const { p, count } = this.state(),
      h = this.grid.h,
      m = this.density * ((h * h * h) / 8),
      a = new Float64Array(36);
    let total = 0;
    const first: V3 = [0, 0, 0],
      inertia = new Float64Array(9);
    for (let q = 0; q < count; q++) {
      const o = q * PARTICLE_WORDS,
        r = rotate(this.q, [
          p[o]! + this.offset[0] - this.centre[0],
          p[o + 1]! + this.offset[1] - this.centre[1],
          p[o + 2]! + this.offset[2] - this.centre[2],
        ]),
        r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
      total += m;
      for (let i = 0; i < 3; i++) {
        first[i]! += m * r[i]!;
        for (let j = 0; j < 3; j++) inertia[3 * i + j]! += m * ((i === j ? r2 : 0) - r[i]! * r[j]!);
      }
    }
    // A = [[m I, -[m c]x], [[m c]x, I_c]]: a rigid body's mass matrix about a point not its centre.
    const [cx, cy, cz] = first,
      skew = [0, -cz, cy, cz, 0, -cx, -cy, cx, 0];
    for (let i = 0; i < 3; i++) {
      a[i * 6 + i] = total;
      for (let j = 0; j < 3; j++) {
        a[i * 6 + j + 3] = -skew[3 * i + j]!;
        a[(i + 3) * 6 + j] = skew[3 * i + j]!;
        a[(i + 3) * 6 + j + 3] = inertia[3 * i + j]!;
      }
    }
    const M = this.hullMass,
      g = this.gravity,
      weight = [M * g[0], M * g[1], M * g[2], 0, 0, 0],
      system = new Float64Array(36),
      rhs = new Float64Array(6);
    for (let i = 0; i < 3; i++) {
      system[i * 6 + i] = M + a[i * 6 + i]!;
      for (let j = 0; j < 3; j++) system[(i + 3) * 6 + j + 3] = this.hullInertia[3 * i + j]! + a[(i + 3) * 6 + j + 3]!;
    }
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++)
        if (!((i < 3 && j < 3 && i === j) || (i >= 3 && j >= 3))) system[i * 6 + j] = a[i * 6 + j]!;
    // Every other load on the hull (contacts, joints, locks, other solvers' forces), from the last step: what moved it,
    // M a_last, less the load this solver held and its weight; the hull solver takes them the same way. Without it the
    // solve took the hull as free, so a hull held still let its water's weight go into a fall that never happened.
    const frame = regionWords(this.host!.memory, this.frame!) as Float64Array,
      seen = [0, 0, 0, 0, 0, 0];
    if (this.hadLast)
      for (let i = 0; i < 3; i++) {
        seen[i] = M * this.lastAcceleration[i]! - frame[7 + i]! - weight[i]!;
        let t = 0;
        for (let j = 0; j < 3; j++) t += this.hullInertia[3 * i + j]! * this.lastAcceleration[3 + j]!;
        seen[i + 3] = t - frame[10 + i]!;
      }
    // The pressure F holds the water's reaction to the last step's acceleration; its rigid share A a_last goes back in, so
    // the solve carries it implicitly.
    for (let i = 0; i < 6; i++) {
      let back = 0;
      for (let j = 0; j < 6; j++) back += a[i * 6 + j]! * this.lastAcceleration[j]!;
      rhs[i] = f[i]! + back + weight[i]! + seen[i]!;
    }
    const acc = solve6(system, rhs),
      out = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = M * acc[i]! - weight[i]! - seen[i]!;
      let t = 0;
      for (let j = 0; j < 3; j++) t += this.hullInertia[3 * i + j]! * acc[j + 3]!;
      out[i + 3] = t - seen[i + 3]!;
    }
    for (let i = 0; i < 6; i++) frame[7 + i] = out[i]!;
    return out;
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

/** The inverse of a symmetric 3 by 3 matrix given as xx, xy, xz, yy, yz, zz, row-major (zeros where it is singular). */
function invertSymmetric(e: readonly number[]): Float64Array {
  const [a, b, c, d, f, g] = e as [number, number, number, number, number, number],
    A = d * g - f * f,
    B = c * f - b * g,
    C = b * f - c * d,
    det = a * A + b * B + c * C,
    out = new Float64Array(9);
  if (!(det !== 0 && Number.isFinite(det))) return out;
  const k = 1 / det;
  out.set([
    A * k,
    B * k,
    C * k,
    B * k,
    (a * g - c * c) * k,
    (b * c - a * f) * k,
    C * k,
    (b * c - a * f) * k,
    (a * d - b * b) * k,
  ]);
  return out;
}

/** Solves the 6 by 6 system (row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
function solve6(matrix: Float64Array, rhs: Float64Array): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice(),
    n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(a[row * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = row;
    if (a[pivot * n + col] === 0) continue;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k]!, a[col * n + k]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    for (let row = col + 1; row < n; row++) {
      const f = a[row * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k]! -= f * a[col * n + k]!;
      b[row]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k++) sum -= a[row * n + k]! * x[k]!;
    x[row] = a[row * n + row]! !== 0 ? sum / a[row * n + row]! : 0;
  }
  return x;
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

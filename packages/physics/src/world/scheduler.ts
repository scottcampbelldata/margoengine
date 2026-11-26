// The coupling scheduler of a physics world (docs/physics-framework.md, section 5): the schemes a coupling group exchanges
// data by within a tick, the check of a coupling's settings including the added-mass test, and the acceleration of a
// strongly coupled group's fixed-point iteration. The world runs the schemes; this file holds what they are and their maths.
//
// Accelerating the fixed-point iteration of a strongly coupled group (docs/physics-framework.md, section 5, "iterated"):
// a group re-runs its coupling tick a fixed number of times, and between runs the interface values are moved toward the
// fixed point by Aitken's dynamic relaxation or by Anderson acceleration. Every loop has a fixed count and every sum runs
// in index order, so the result is the same bits on every machine.
//
// Aitken: x_{k+1} = x_k + w_k r_{k+1}, r_{k+1} = g(x_k) - x_k, w_k = -w_{k-1} (r_k . (r_{k+1} - r_k)) / |r_{k+1} - r_k|^2
// (Kuttler and Wall 2008, as given by Langer and Yang 2013, eqs. 52-53).
// Anderson AA(m): x_{k+1} = g(x_k) - dG gamma, gamma = argmin |f_k - dF gamma|_2 over the last m_k = min(m, k) differences
// of the residuals f and of g (Walker and Ni 2011, the unconstrained least-squares form, solved by QR).
import { MargoError } from '@margoengine/math/errors';

/** Aitken's dynamic relaxation of one interface vector. */
export class Aitken {
  /** The relaxation the first iteration of each tick starts from, 0 to 1. */
  readonly start: number;
  private omega: number;
  private readonly last: Float64Array;
  private has = false;

  /**
   * @param length The interface's number of values.
   * @param start The first relaxation of each tick (default 0.5).
   * @throws RangeError for a length that is not whole and positive or a start outside (0, 1].
   */
  constructor(length: number, start = 0.5) {
    if (!Number.isSafeInteger(length) || length < 1)
      throw new RangeError(
        `An interface has a whole number of values above 0 (got ${length}); pass the interface's value count as a positive integer.`,
      );
    if (!(start > 0 && start <= 1))
      throw new RangeError(
        `Aitken's first relaxation lies in (0, 1] (got ${start}); pass a relaxation such as 0.5, or leave it out for the default.`,
      );
    this.start = start;
    this.omega = start;
    this.last = new Float64Array(length);
  }

  /** The relaxation the last call used. */
  get relaxation(): number {
    return this.omega;
  }

  /** Starts a new coupling tick: the first iteration relaxes by `start`. */
  reset(): void {
    this.has = false;
    this.omega = this.start;
  }

  /**
   * The next interface value from the current one `x` and what the group made of it, `gx`: writes x + w (gx - x) into `out`
   * (which may be `x`).
   */
  next(x: ArrayLike<number>, gx: ArrayLike<number>, out: Float64Array | number[]): void {
    const n = this.last.length;
    if (x.length !== n || gx.length !== n)
      throw new RangeError(
        `Aitken was made for ${n} values and was given ${x.length} and ${gx.length}; pass the iterate and its update with the interface's ${n} values each.`,
      );
    if (this.has) {
      let dot = 0,
        norm = 0;
      for (let i = 0; i < n; i++) {
        const r = gx[i]! - x[i]!,
          d = r - this.last[i]!;
        dot += this.last[i]! * d;
        norm += d * d;
      }
      // A residual that did not change gives no new slope: keep the relaxation.
      if (norm > 0) this.omega = (-this.omega * dot) / norm;
    }
    for (let i = 0; i < n; i++) {
      const r = gx[i]! - x[i]!;
      this.last[i] = r;
      out[i] = x[i]! + this.omega * r;
    }
    this.has = true;
  }
}

/** Anderson acceleration AA(m) of one interface vector. */
export class Anderson {
  /** The most differences kept. */
  readonly depth: number;
  private readonly n: number;
  private readonly dF: Float64Array[];
  private readonly dG: Float64Array[];
  private readonly lastF: Float64Array;
  private readonly lastG: Float64Array;
  private count = 0;
  private has = false;
  private readonly q: Float64Array[];
  private readonly r: Float64Array;
  private readonly gamma: Float64Array;

  /**
   * @param length The interface's number of values.
   * @param depth m, the most differences kept (default 5, 1 to 32).
   */
  constructor(length: number, depth = 5) {
    if (!Number.isSafeInteger(length) || length < 1)
      throw new RangeError(
        `An interface has a whole number of values above 0 (got ${length}); pass the interface's value count as a positive integer.`,
      );
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 32)
      throw new RangeError(
        `Anderson's depth is a whole number from 1 to 32 (got ${depth}); pass a depth such as 5, or leave it out for the default.`,
      );
    this.depth = depth;
    this.n = length;
    const columns = () => Array.from({ length: depth }, () => new Float64Array(length));
    this.dF = columns();
    this.dG = columns();
    this.q = columns();
    this.lastF = new Float64Array(length);
    this.lastG = new Float64Array(length);
    this.r = new Float64Array(depth * depth);
    this.gamma = new Float64Array(depth);
  }

  /** Starts a new coupling tick: the history is cleared. */
  reset(): void {
    this.count = 0;
    this.has = false;
  }

  /** The next interface value from `x` and `gx`, into `out` (which may be `x`). */
  next(x: ArrayLike<number>, gx: ArrayLike<number>, out: Float64Array | number[]): void {
    const n = this.n,
      m = this.depth;
    if (x.length !== n || gx.length !== n)
      throw new RangeError(
        `Anderson was made for ${n} values and was given ${x.length} and ${gx.length}; pass the iterate and its update with the interface's ${n} values each.`,
      );
    if (this.has) {
      // Shift the oldest difference out when the history is full, so columns stay oldest to newest.
      if (this.count === m) {
        const f0 = this.dF[0]!,
          g0 = this.dG[0]!;
        for (let j = 1; j < m; j++) {
          this.dF[j - 1] = this.dF[j]!;
          this.dG[j - 1] = this.dG[j]!;
        }
        this.dF[m - 1] = f0;
        this.dG[m - 1] = g0;
        this.count--;
      }
      const df = this.dF[this.count]!,
        dg = this.dG[this.count]!;
      for (let i = 0; i < n; i++) {
        df[i] = gx[i]! - x[i]! - this.lastF[i]!;
        dg[i] = gx[i]! - this.lastG[i]!;
      }
      this.count++;
    }
    for (let i = 0; i < n; i++) {
      this.lastF[i] = gx[i]! - x[i]!;
      this.lastG[i] = gx[i]!;
    }
    this.has = true;
    const k = this.solve();
    for (let i = 0; i < n; i++) {
      let correction = 0;
      for (let j = 0; j < k; j++) correction += this.dG[j]![i]! * this.gamma[j]!;
      out[i] = gx[i]! - correction;
    }
  }

  /**
   * gamma = argmin |f - dF gamma| by modified Gram-Schmidt QR of dF, columns oldest to newest. A column that is a
   * combination of the earlier ones (its orthogonal part under 1e-12 of its length) gets no weight. Returns the columns used.
   */
  private solve(): number {
    const n = this.n,
      k = this.count,
      { q, r, gamma } = this;
    gamma.fill(0);
    const kept: number[] = [];
    for (let j = 0; j < k; j++) {
      const v = q[j]!,
        src = this.dF[j]!;
      let length0 = 0;
      for (let i = 0; i < n; i++) {
        v[i] = src[i]!;
        length0 += v[i]! * v[i]!;
      }
      for (const p of kept) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += q[p]![i]! * v[i]!;
        r[p * this.depth + j] = dot;
        for (let i = 0; i < n; i++) v[i]! -= dot * q[p]![i]!;
      }
      let length = 0;
      for (let i = 0; i < n; i++) length += v[i]! * v[i]!;
      if (!(length > 1e-24 * length0) || length === 0) continue;
      const norm = Math.sqrt(length);
      r[j * this.depth + j] = norm;
      for (let i = 0; i < n; i++) v[i]! /= norm;
      kept.push(j);
    }
    // gamma = R^-1 Q^T f, back substitution over the kept columns.
    for (let a = kept.length - 1; a >= 0; a--) {
      const j = kept[a]!;
      let value = 0;
      for (let i = 0; i < n; i++) value += q[j]![i]! * this.lastF[i]!;
      for (let b = a + 1; b < kept.length; b++) value -= r[j * this.depth + kept[b]!]! * gamma[kept[b]!]!;
      gamma[j] = value / r[j * this.depth + j]!;
    }
    return k;
  }
}

/**
 * Whether plain staggering is stable for a body of mass `bodyMass` in a fluid that adds `addedMass` (the added-mass
 * coefficient times the fluid's density times the displaced volume: 0.5 rho V for a sphere). A staggered exchange multiplies
 * the interface error by -addedMass / bodyMass each tick whatever the step (Causin, Gerbeau and Nobile 2005), so it diverges
 * once the added mass reaches the body's. With `margin` (default 2) the body must be that many times heavier than its added
 * mass for staggering, so an error at least halves each tick; otherwise the pair needs the implicit or iterated scheme.
 * @throws RangeError for masses that are not finite and positive, or a margin under 1.
 */
export function staggeringStable(bodyMass: number, addedMass: number, margin = 2): boolean {
  if (!(bodyMass > 0 && Number.isFinite(bodyMass)) || !(addedMass >= 0 && Number.isFinite(addedMass)))
    throw new RangeError(
      `Masses are finite, the body's above 0 (got ${bodyMass} and ${addedMass}); pass the body's mass in kg and the fluid's added mass in kg.`,
    );
  if (!(margin >= 1 && Number.isFinite(margin)))
    throw new RangeError(
      `The margin is 1 or more (got ${margin}); pass a finite margin of at least 1, or leave it out for the default.`,
    );
  return bodyMass > margin * addedMass;
}

/**
 * How a coupling group exchanges data within a tick (docs/physics-framework.md, section 5):
 * - `staggered`: each member steps in coupling order and publishes at once, the next reading it (Felippa, Park and Farhat
 *   2001); the default;
 * - `strang`: two members, the first stepping two half steps around the second's whole one, A(dt/2) B(dt) A(dt/2) (Strang
 *   1968), so the first runs one rate level above the second;
 * - `predicted`: every member steps on the others' values extrapolated linearly to its step's end, then all publish
 *   (Farhat, van der Zee and Geuzaine 2006);
 * - `implicitPressure`: the members that own bodies step first, the member that adds to their fields solves with them, and
 *   the bodies take its impulses in the same tick (Batty, Bertails and Bridson 2007; Robinson-Mosher et al. 2011);
 * - `iterated`: the group re-runs its tick a fixed number of times on accelerated interface values (Aitken or Anderson)
 *   until the exchange agrees (Degroote, Bathe and Vierendeels 2009; Walker and Ni 2011).
 */
export type CouplingScheme = 'staggered' | 'strang' | 'predicted' | 'implicitPressure' | 'iterated';

/** Settings of a coupling; each has a default. */
export interface CouplingOptions {
  /** Runs of each tick for `iterated` (default 4, 2 to 64): a fixed count, the same on every machine. */
  iterations?: number;
  /** The acceleration between runs for `iterated` (default 'anderson'). */
  accelerator?: 'aitken' | 'anderson';
  /** Differences Anderson keeps (default 5, 1 to 32). */
  depth?: number;
  /** Aitken's first relaxation of each tick (default 0.5). */
  relaxation?: number;
  /**
   * The lightest body's mass and the added mass of the fluid it displaces, kg: given, the coupling is checked with
   * {@link staggeringStable}, and a scheme that exchanges once a tick is refused where it would diverge.
   */
  bodyMass?: number;
  addedMass?: number;
  /** How many times heavier than its added mass a body must be for a once-a-tick exchange (default 2). */
  margin?: number;
}

const SCHEMES: ReadonlySet<CouplingScheme> = new Set([
  'staggered',
  'strang',
  'predicted',
  'implicitPressure',
  'iterated',
]);

/** A coupling's settings checked and filled in. */
export interface Coupling {
  readonly ids: readonly string[];
  readonly scheme: CouplingScheme;
  readonly iterations: number;
  readonly accelerator: 'aitken' | 'anderson';
  readonly depth: number;
  readonly relaxation: number;
}

/**
 * Checks a coupling's settings and fills in the defaults.
 * @throws RangeError for an unknown scheme, a repeated id, a setting out of range, or `strang` without exactly two ids;
 * MargoError `state` for a scheme that exchanges once a tick between a body and a fluid whose added mass makes it diverge.
 */
export function coupling(ids: readonly string[], scheme: CouplingScheme, options: CouplingOptions = {}): Coupling {
  if (!SCHEMES.has(scheme))
    throw new RangeError(`Coupling scheme "${scheme}" is not one of ${[...SCHEMES].join(', ')}.`);
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => typeof id === 'string')
  )
    throw new RangeError('A coupling names its solvers once each, by id; pass a list of distinct ids.');
  if (scheme === 'strang' && ids.length !== 2)
    throw new RangeError(
      `Strang splitting couples two solvers (got ${ids.length}); pass [half-stepped, whole-stepped].`,
    );
  const {
    iterations = 4,
    accelerator = 'anderson',
    depth = 5,
    relaxation = 0.5,
    bodyMass,
    addedMass,
    margin = 2,
  } = options;
  if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 64)
    throw new RangeError(
      `An iterated coupling runs a tick 2 to 64 times (got ${iterations}); pass iterations between 2 and 64.`,
    );
  if (accelerator !== 'aitken' && accelerator !== 'anderson')
    throw new RangeError(
      `The accelerator is 'aitken' or 'anderson' (got ${accelerator}); pass one of those two, or leave it out for the default.`,
    );
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 32)
    throw new RangeError(
      `Anderson's depth is a whole number from 1 to 32 (got ${depth}); pass a depth such as 5, or leave it out for the default.`,
    );
  if (!(relaxation > 0 && relaxation <= 1))
    throw new RangeError(
      `Aitken's first relaxation lies in (0, 1] (got ${relaxation}); pass a relaxation such as 0.5, or leave it out for the default.`,
    );
  if ((bodyMass === undefined) !== (addedMass === undefined))
    throw new RangeError('Give the body mass and the added mass together, or neither.');
  if (
    bodyMass !== undefined &&
    scheme !== 'iterated' &&
    scheme !== 'implicitPressure' &&
    !staggeringStable(bodyMass, addedMass!, margin)
  )
    throw new MargoError(
      'state',
      `A body of ${bodyMass} kg with ${addedMass} kg of added mass makes a once-a-tick exchange ("${scheme}") diverge; couple it 'iterated' or 'implicitPressure'.`,
    );
  return { ids: [...ids], scheme, iterations, accelerator, depth, relaxation };
}

// Sails and flags in the wind (AERO-02 of docs/physics-solvers.md): the aerodynamic load on a cloth from a vortex lattice
// on its own grid, solved again every step from where the particles are, so a sail's camber and twist decide its lift and the
// thrust goes into the boat through whatever holds the sail.
//
// The vortex-lattice method (docs: J. Katz and A. Plotkin, "Low-Speed Aerodynamics", 2001, chapter 12, not read here; the
// formulation as restated by the article "Vortex lattice method" in Wikipedia, read 2026-11-25, and by M. Klein and others,
// "Direct Wing Design and Inverse Airfoil Identification with the Nonlinear Weissinger Method", arXiv:1501.04983, 2015, read
// in full, eqs. 1-4): each grid cell is a panel carrying a horseshoe vortex, its bound segment on the quarter-chord line, its
// legs along the chord to the trailing edge and from there downstream along the apparent wind to infinity; the circulations
// make the air's velocity normal to the sail vanish at every panel's three-quarter-chord point (a dense linear system,
// solved by Gaussian elimination with partial pivoting in a fixed order); each bound segment takes the Kutta-Joukowski force
// rho Gamma (V x l) from the local air V. A straight segment's induced velocity is Biot-Savart's closed form (Klein et al.,
// eq. 2) and a leg to infinity its limit (eq. 3). Where the air meets a panel more steeply than `stall`, the flow there has
// separated and the panel takes the flat plate's normal force C_N90 sin(a) q A instead (as `WindForce` does, AERO-01). Each
// panel's force is shared by its four corner particles.
//
// Accepted differences: quasi-steady (the wake leaves the trailing edge straight along the apparent wind every step, with no
// memory of earlier steps), attached flow is potential flow (no viscous drag beyond the flat-plate law of stalled panels),
// and the sail is one surface (no thickness, no mast in front of it).
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { hypot, sin } from '@margoengine/math/pinned';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import type { SoftBody } from './soft.js';

/** Settings of a {@link SailForce}. */
export interface SailOptions {
  /** The wind: a velocity in m/s, a function of the point and the time, or a flow field (its density too). */
  wind: Vec3 | ((point: Vec3, time: number) => Vec3) | FlowField;
  /** The cloth's grid, `nu` by `nv` particles as `SoftBodyDesc.cloth` makes it (particle (i, j) is index i nv + j). */
  grid: readonly [number, number];
  /** Which grid direction runs from the leading edge (luff) to the trailing edge (leech): 'u' (default) or 'v'. */
  chord?: 'u' | 'v';
  /** Air density, kg/m^3 (default the flow field's, or 1.225). */
  density?: number;
  /** The angle, radians, past which the air meeting a panel has separated (default 0.35, 20 degrees). */
  stall?: number;
  /** The normal-force coefficient of a separated panel square to the air (default 1.17, a flat plate). */
  drag?: number;
}

/** The vortex-lattice load on a cloth sail or flag, applied every step. */
export class SailForce implements PhysicsAttachment {
  /** The total aerodynamic force on the sail in the last step, N. */
  readonly force: [number, number, number] = [0, 0, 0];
  /** The circulation of each panel in the last step, m^2/s, panel (c, s) at c + chords * s along chord then span. */
  circulation: Float64Array = new Float64Array(0);
  private released = false;
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @throws RangeError for a grid that is not the body's particles or smaller than 2 by 2, or bad settings. */
  constructor(
    private readonly physics: Physics,
    private readonly sail: SoftBody,
    private readonly options: SailOptions,
  ) {
    const [nu, nv] = options.grid;
    if (!(Number.isInteger(nu) && Number.isInteger(nv) && nu >= 2 && nv >= 2) || nu * nv !== sail.numParticles())
      throw new RangeError(
        `A sail's grid must be nu by nv particles, each 2 or more, nu nv = ${sail.numParticles()} (got ${nu} by ${nv}).`,
      );
    const { stall = 0.35, drag = 1.17, density, chord = 'u', wind } = options;
    if (!(stall > 0 && stall <= HALF_PI))
      throw new RangeError(
        `A stall angle lies in (0, pi/2] radians (got ${stall}); pass one in that range, or leave it unset for 0.35.`,
      );
    if (!(drag >= 0 && Number.isFinite(drag)))
      throw new RangeError(
        `A drag coefficient is 0 or more (got ${drag}); pass a finite number, or leave it unset for 1.17.`,
      );
    if (density !== undefined && !(density > 0 && Number.isFinite(density)))
      throw new RangeError(
        `Air density is a finite number of kg/m^3 above 0 (got ${density}); pass one, or leave it unset for the flow field's density or 1.225.`,
      );
    if (chord !== 'u' && chord !== 'v')
      throw new RangeError(`A sail's chord runs along 'u' or 'v' (got ${chord}); pass one of the two.`);
    if (!(typeof wind === 'function' || (typeof wind === 'object' && wind !== null && 'sample' in wind)))
      checkVec(wind, 'Wind');
    physics.attach(this);
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    const { grid, chord = 'u', stall = 0.35, drag = 1.17 } = this.options,
      [nu, nv] = grid,
      chords = chord === 'u' ? nu : nv,
      spans = chord === 'u' ? nv : nu,
      index = (c: number, s: number) => (chord === 'u' ? c * nv + s : s * nv + c),
      positions = this.sail.particlePositions(),
      velocities = this.sail.particleVelocities(),
      at = (c: number, s: number): Vec3 => {
        const k = 3 * index(c, s);
        return [positions[k]!, positions[k + 1]!, positions[k + 2]!];
      },
      velocityAt = (c: number, s: number): Vec3 => {
        const k = 3 * index(c, s);
        return [velocities[k]!, velocities[k + 1]!, velocities[k + 2]!];
      },
      time = this.physics.stepCount * this.physics.fixedTimestep,
      nc = chords - 1,
      ns = spans - 1,
      n = nc * ns;
    // Panels: bound segment ends, collocation point, normal, area, the air relative to the panel there, and density.
    const boundA: Vec3[] = [],
      boundB: Vec3[] = [],
      colloc: Vec3[] = [],
      normal: Vec3[] = [],
      area: number[] = [],
      relative: Vec3[] = [],
      rho: number[] = [];
    for (let s = 0; s < ns; s++)
      for (let c = 0; c < nc; c++) {
        const p00 = at(c, s),
          p10 = at(c + 1, s),
          p01 = at(c, s + 1),
          p11 = at(c + 1, s + 1),
          lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
          ],
          a = lerp(p00, p10, 0.25),
          b = lerp(p01, p11, 0.25),
          q0 = lerp(p00, p10, 0.75),
          q1 = lerp(p01, p11, 0.75),
          point: Vec3 = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2],
          d1 = sub(p11, p00),
          d2 = sub(p01, p10),
          cross = crossOf(d1, d2),
          length = hypot(cross[0], cross[1], cross[2]),
          v = scale(
            add(add(velocityAt(c, s), velocityAt(c + 1, s)), add(velocityAt(c, s + 1), velocityAt(c + 1, s + 1))),
            0.25,
          ),
          [air, density] = this.air(point, time);
        boundA.push(a);
        boundB.push(b);
        colloc.push(point);
        normal.push(length > 0 ? scale(cross, 1 / length) : [0, 0, 0]);
        area.push(length / 2);
        relative.push(sub(air, v));
        rho.push(density);
      }
    // The wake leaves along the mean apparent wind.
    let mean: Vec3 = [0, 0, 0];
    for (const r of relative) mean = add(mean, r);
    const meanSpeed = hypot(mean[0], mean[1], mean[2]);
    this.force[0] = this.force[1] = this.force[2] = 0;
    if (!(meanSpeed > 1e-9)) {
      this.circulation = new Float64Array(n);
      return;
    }
    const wake = scale(mean, 1 / meanSpeed),
      trailing = (s: number) => at(chords - 1, s),
      // The horseshoe of panel m in its segments, unit circulation: from far down the wake to the trailing edge, along the
      // chord to the bound segment, across it, back along the chord and down the wake.
      horseshoe = (m: number, point: Vec3): Vec3 => {
        const s = (m - (m % nc)) / nc,
          tA = trailing(s),
          tB = trailing(s + 1);
        let u = semiInfinite(tA, wake, point, -1);
        u = add(u, segment(tA, boundA[m]!, point));
        u = add(u, segment(boundA[m]!, boundB[m]!, point));
        u = add(u, segment(boundB[m]!, tB, point));
        return add(u, semiInfinite(tB, wake, point, 1));
      };
    // a_km Gamma_m = -V_k . n_k
    const matrix = new Float64Array(n * n),
      rhs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      for (let m = 0; m < n; m++) matrix[k * n + m] = dot(horseshoe(m, colloc[k]!), normal[k]!);
      rhs[k] = -dot(relative[k]!, normal[k]!);
    }
    const gamma = solve(matrix, rhs, n);
    this.circulation = gamma;
    for (let m = 0; m < n; m++) {
      const v = relative[m]!,
        speed = hypot(v[0], v[1], v[2]);
      if (!(speed > 1e-9)) continue;
      const nm = normal[m]!,
        vn = dot(v, nm),
        sinA = (vn < 0 ? -vn : vn) / speed;
      let f: Vec3;
      if (sinA > sin(stall)) {
        // Separated: the flat plate's normal force, pushed downwind across the panel.
        f = scale(nm, 0.5 * rho[m]! * area[m]! * drag * speed * vn);
      } else {
        // Attached: Kutta-Joukowski on the bound segment, with the air there and every vortex's induced velocity.
        const mid = scale(add(boundA[m]!, boundB[m]!), 0.5);
        let induced: Vec3 = [0, 0, 0];
        for (let j = 0; j < n; j++) induced = add(induced, scale(horseshoe(j, mid), gamma[j]!));
        const local = add(v, induced),
          l = sub(boundB[m]!, boundA[m]!);
        f = scale(crossOf(local, l), rho[m]! * gamma[m]!);
      }
      this.force[0] += f[0];
      this.force[1] += f[1];
      this.force[2] += f[2];
      const s = (m - (m % nc)) / nc,
        c = m - s * nc,
        share = scale(f, dt / 4);
      for (const [cc, ss] of [
        [c, s],
        [c + 1, s],
        [c, s + 1],
        [c + 1, s + 1],
      ] as const)
        this.sail.applyParticleImpulse(index(cc, ss), share);
    }
  }

  /** The air at `point` and its density. */
  private air(point: Vec3, time: number): [Vec3, number] {
    const { wind, density } = this.options;
    if (typeof wind === 'function') return [wind(point, time), density ?? 1.225];
    if ('sample' in (wind as object)) {
      const s = (wind as FlowField).sample(point[0], point[1], point[2], time, this.sample);
      return [[s.velocity[0], s.velocity[1], s.velocity[2]], density ?? s.density];
    }
    return [wind as Vec3, density ?? 1.225];
  }

  /** Stops the load. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossOf = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const HALF_PI = 1.5707963267948966;
const FOUR_PI = 12.566370614359172;

/** A core: closer to a segment's line than this share of its length, the point takes no velocity from it. */
const CORE = 1e-6;

/**
 * The velocity a straight vortex segment from r0 to r1 of unit circulation induces at m (Biot-Savart's closed form;
 * Klein et al. 2015, eq. 2): (r1 - r0) . ((r1 - m)/|r1 - m| - (r0 - m)/|r0 - m|) (r0 - m) x (r1 - r0) / (4 pi |(r0 - m) x (r1 - r0)|^2).
 */
function segment(r0: Vec3, r1: Vec3, m: Vec3): Vec3 {
  const d = sub(r1, r0),
    a = sub(r0, m),
    b = sub(r1, m),
    c = crossOf(a, d),
    cc = dot(c, c),
    dd = dot(d, d);
  if (!(cc > CORE * CORE * dd * dd)) return [0, 0, 0];
  const la = hypot(a[0], a[1], a[2]),
    lb = hypot(b[0], b[1], b[2]),
    k = (dot(d, b) / lb - dot(d, a) / la) / (FOUR_PI * cc);
  return scale(c, k);
}

/**
 * The velocity of a straight vortex leg of unit circulation from `start` to infinity along the unit `direction` at m (the
 * limit of the closed form, Klein et al. 2015, eq. 3), `sense` -1 for the leg that comes in from infinity.
 */
function semiInfinite(start: Vec3, direction: Vec3, m: Vec3, sense: number): Vec3 {
  const a = sub(start, m),
    c = crossOf(a, direction),
    cc = dot(c, c);
  if (!(cc > CORE * CORE)) return [0, 0, 0];
  const la = hypot(a[0], a[1], a[2]),
    k = (sense * (1 - dot(direction, a) / la)) / (FOUR_PI * cc);
  return scale(c, k);
}

/** Solves `matrix` x = `rhs` (n by n, row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
function solve(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col,
      best = a[col * n + col]! < 0 ? -a[col * n + col]! : a[col * n + col]!;
    for (let row = col + 1; row < n; row++) {
      const v = a[row * n + col]! < 0 ? -a[row * n + col]! : a[row * n + col]!;
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (!(best > 0)) continue;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k]!;
        a[col * n + k] = a[pivot * n + k]!;
        a[pivot * n + k] = t;
      }
      const t = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = t;
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
    let s = b[row]!;
    for (let k = row + 1; k < n; k++) s -= a[row * n + k]! * x[k]!;
    x[row] = a[row * n + row]! !== 0 ? s / a[row * n + row]! : 0;
  }
  return x;
}

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
import { add, flatPlate, latticeLoads, scale, sub } from './lattice.js';
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
    // The air relative to each panel at its three-quarter-chord point, and its density there.
    const relative: Vec3[] = [],
      rho: number[] = [];
    for (let s = 0; s < ns; s++)
      for (let c = 0; c < nc; c++) {
        const p00 = at(c, s),
          p10 = at(c + 1, s),
          p01 = at(c, s + 1),
          p11 = at(c + 1, s + 1),
          mid = (k: number) => (p00[k]! + 0.75 * (p10[k]! - p00[k]!) + p01[k]! + 0.75 * (p11[k]! - p01[k]!)) / 2,
          point: Vec3 = [mid(0), mid(1), mid(2)],
          v = scale(
            add(add(velocityAt(c, s), velocityAt(c + 1, s)), add(velocityAt(c, s + 1), velocityAt(c + 1, s + 1))),
            0.25,
          ),
          [air, density] = this.air(point, time);
        relative.push(sub(air, v));
        rho.push(density);
      }
    const loads = latticeLoads({ nc, ns, corner: at, relative, density: rho }, stall, flatPlate(drag));
    this.circulation = loads.circulation;
    this.force[0] = this.force[1] = this.force[2] = 0;
    for (let m = 0; m < n; m++) {
      const f = loads.forces[m]!;
      if (f[0] === 0 && f[1] === 0 && f[2] === 0) continue;
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

const HALF_PI = 1.5707963267948966;

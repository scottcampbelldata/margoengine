// Sails and flags in the wind (AERO-02 of docs/physics-solvers.md): the aerodynamic load on a cloth from a vortex lattice
// on its own grid, solved again every step from where the particles are, so a sail's camber and twist decide its lift and the
// thrust goes into the boat through whatever holds the sail.
//
// Maximilian Ranneberg, "Direct Wing Design and Inverse Airfoil Identification with the Nonlinear Weissinger Method"
// (2015), §§2.1–2.2, https://arxiv.org/abs/1501.04983. Each grid cell is a panel carrying a horseshoe vortex,
// its bound segment on the quarter-chord line, its
// legs along the chord to the trailing edge and from there downstream along the apparent wind to infinity; the circulations
// make the air's velocity normal to the sail vanish at every panel's three-quarter-chord point (a dense linear system,
// solved by Gaussian elimination with partial pivoting in a fixed order); each bound segment takes the Kutta-Joukowski force
// rho Gamma (V x l) from the local air V. Equation 2 gives the straight segment’s induced velocity and the following
// derivation gives the semi-infinite leg. Where the air meets a panel more steeply than `stall`, the flow there has
// separated and the panel takes the flat plate's normal force C_N90 sin(a) q A instead (as `WindForce` does, AERO-01). Each
// panel's force is shared by its four corner particles.
//
// Accepted differences: quasi-steady (the wake leaves the trailing edge straight along the apparent wind every step, with no
// memory of earlier steps), attached flow is potential flow (no viscous drag beyond the flat-plate law of stalled panels),
// and the sail is one surface (no thickness, no mast in front of it).
import { MargoError } from '@margoengine/math/errors';
import type { FlowCell, FlowField, FlowSample } from '@margoengine/math/fields';
import type { WindForceFrame } from './fields.js';
import type { WingLatticeKernel, WingLatticeWorkCounts, WingLatticeWorkerWork } from './flight/lattice-kernel.js';
import { add, flatPlate, latticeLoads, scale, sub } from './lattice.js';
import type { Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import type { SoftBody } from './soft.js';

/** Settings of a {@link SailForce}. */
export interface SailOptions {
  /** The wind: a velocity in m/s, a function of the point and the time, or a flow field (its density too). */
  wind: Vec3 | ((point: Vec3, time: number) => Vec3) | FlowField;
  /** Origin of the cloth's positions when sampling a field. Omit for air and cloth in cell [0, 0, 0]. */
  frame?: WindForceFrame;
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
  /** @internal The native attachment writes fixed accepted output words into rigid snapshots. */
  takeState?: () => Float64Array;
  /** @internal Restores those words for the same native attachment. */
  restoreState?: (words: Float64Array) => void;
  private released = false;
  private native?: WingLatticeKernel;
  private threads = 0;
  private work?: WingLatticeWorkCounts;
  private readonly panels: number;
  private readonly grid: readonly [number, number];
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

  /** @throws MargoError (state) for invalid cloth, grid, air or settings. */
  constructor(
    private readonly physics: Physics,
    private readonly sail: SoftBody,
    private readonly options: SailOptions,
  ) {
    const grid = options?.grid;
    const [nu, nv] = grid ?? [];
    if (!sail.valid) throw sailError('Create a live sail with SoftBodies.create before attaching its air load.');
    if (
      grid?.length !== 2 ||
      !Number.isInteger(nu) ||
      !Number.isInteger(nv) ||
      nu < 2 ||
      nv < 2 ||
      nu * nv !== sail.numParticles()
    )
      throw sailError(
        "Pass the cloth's nu by nv grid, each side at least two and nu × nv equal to its particle count.",
      );
    this.grid = [nu, nv];
    this.panels = (nu - 1) * (nv - 1);
    if (this.panels * this.panels * Float64Array.BYTES_PER_ELEMENT > 0x7fff_ffff)
      throw sailError('Use fewer chordwise or spanwise panels to fit the dense influence matrix.');
    this.checkOptions();
    physics.attach(this);
    // Supply this cloth’s air loads once while the sail is attached.
    sail.airLoads++;
  }

  /** Loads the optional shared vortex lattice before attaching. Threads include the caller and default to one. */
  static async attachNative(
    physics: Physics,
    sail: SoftBody,
    options: SailOptions & { threads?: 1 | 2 | 4; signal?: AbortSignal },
  ): Promise<SailForce> {
    const { threads = 1, signal } = options;
    if (threads !== 1 && threads !== 2 && threads !== 4) throw sailError('Use 1, 2 or 4 native sail participants.');
    signal?.throwIfAborted();
    const { loadWingLattice } = await import('./flight/lattice-kernel.js');
    const native = await loadWingLattice({ threads, signal });
    try {
      signal?.throwIfAborted();
      const load = new SailForce(physics, sail, options);
      load.native = native;
      load.threads = threads;
      load.takeState = load.captureLoad.bind(load);
      load.restoreState = load.restoreLoad.bind(load);
      return load;
    } catch (error) {
      native.close();
      throw error;
    }
  }

  /** Work done by the optional native kernel for the last accepted load. */
  readNativeWork(): WingLatticeWorkCounts | undefined {
    return this.work;
  }

  private checkOptions(): Vec3 {
    const { stall = 0.35, drag = 1.17, density, chord = 'u', wind } = this.options;
    if (!(stall > 0 && stall <= HALF_PI))
      throw sailError('Pass a stall angle in (0, π/2] radians, or omit it for 0.35.');
    if (!(drag >= 0 && Number.isFinite(drag)))
      throw sailError('Pass finite, nonnegative separated drag, or omit it for 1.17.');
    if (density !== undefined) checkDensity(density);
    if (chord !== 'u' && chord !== 'v') throw sailError("Set the chord to 'u' or 'v'.");
    if (isFlow(wind)) {
      if (wind.medium !== 'air') throw sailError('Pass an air flow field as the sail wind.');
      return flowShift(wind, this.options.frame);
    }
    if (typeof wind !== 'function') checkVector(wind);
    return ZERO;
  }

  /** @internal */
  beforeStep(dt: number): void {
    if (this.released) return;
    if (!(dt > 0 && Number.isFinite(dt))) throw sailError('Step the sail with a finite positive duration.');
    if (!this.sail.valid || this.sail.numParticles() !== this.grid[0] * this.grid[1])
      throw sailError('Remove the sail load and attach a new one with the live cloth grid.');
    const shift = this.checkOptions();
    const { chord = 'u', stall = 0.35, drag = 1.17 } = this.options,
      [nu, nv] = this.grid,
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
    if (!positions.every(Number.isFinite) || !velocities.every(Number.isFinite))
      throw sailError('Restore finite cloth positions and velocities before stepping the sail.');
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
          [air, density] = this.air(add(point, shift), time),
          apparent = sub(air, v);
        checkVector(apparent);
        relative.push(apparent);
        rho.push(density);
      }
    this.native?.resetWork();
    const loads = latticeLoads(
      { nc, ns, corner: at, relative, density: rho },
      stall,
      flatPlate(drag),
      true,
      this.native,
    );
    if (!loads.circulation.every(Number.isFinite) || !loads.slopes?.every(Number.isFinite))
      throw sailError('Use smaller sail geometry or lower wind speed so circulation and damping stay finite.');
    // The load leans on the cloth's own speed through the air (each panel's slope), so given whole at the start of a step it
    // is an explicit damping, which a light sail (a few hundred grams a square metre) outruns within a step: the sail flew
    // apart. Each corner takes its panels' loads damped implicitly instead: its velocity change dv = dt (F - K m dv) / m
    // solved for dv, K its panels' slopes, each shared four ways, over its mass, so its impulse is F dt / (1 + K dt)
    // (backward Euler on the aerodynamic damping, the closed form the cloth's own drag takes: soft.ts). The slopes are
    // summed for the motion in which a panel's corners move together, the most damped; a quicker motion is damped no less.
    // A pinned corner does not move, so its load leans on no speed of its own.
    const slopes = loads.slopes!,
      masses = this.sail.masses,
      gain = new Float64Array(chords * spans),
      impulse: Vec3[] = Array.from({ length: chords * spans }, () => [0, 0, 0] as Vec3);
    for (let m = 0; m < n; m++) {
      const f = loads.forces[m]!;
      if (f[0] === 0 && f[1] === 0 && f[2] === 0) continue;
      const s = (m - (m % nc)) / nc,
        c = m - s * nc;
      for (const [cc, ss] of [
        [c, s],
        [c + 1, s],
        [c, s + 1],
        [c + 1, s + 1],
      ] as const) {
        const k = cc * spans + ss;
        gain[k]! += slopes[m]! / 4;
        impulse[k] = add(impulse[k]!, scale(f, dt / 4));
      }
    }
    const acceptedForce: [number, number, number] = [0, 0, 0];
    for (let cc = 0; cc < chords; cc++)
      for (let ss = 0; ss < spans; ss++) {
        const k = cc * spans + ss,
          particle = index(cc, ss),
          mass = masses[particle]!,
          free = !this.sail.isParticlePinned(particle),
          slope = gain[k]!;
        if (free && (!(mass > 0 && Number.isFinite(mass)) || !Number.isFinite(slope)))
          throw sailError('Use positive finite cloth masses and reduce wind or density so the damping stays finite.');
        const given = free ? scale(impulse[k]!, 1 / (1 + (slope / mass) * dt)) : impulse[k]!;
        if (
          !given.every(Number.isFinite) ||
          (free && given.some((v, axis) => !Number.isFinite(Math.fround(velocities[3 * particle + axis]! + v / mass))))
        )
          throw sailError(
            'Use a smaller time step or wind speed so every sail impulse fits the cloth velocity columns.',
          );
        impulse[k] = given;
        if (given[0] === 0 && given[1] === 0 && given[2] === 0) continue;
        acceptedForce[0] += given[0] / dt;
        acceptedForce[1] += given[1] / dt;
        acceptedForce[2] += given[2] / dt;
      }
    if (!acceptedForce.every(Number.isFinite))
      throw sailError('Use lower wind or density so the total sail load stays finite.');
    const work = this.native?.workCounts();
    // Nothing reaches cloth or published diagnostics before all panels and impulses have passed.
    for (let cc = 0; cc < chords; cc++)
      for (let ss = 0; ss < spans; ss++) {
        const given = impulse[cc * spans + ss]!;
        if (given[0] !== 0 || given[1] !== 0 || given[2] !== 0) this.sail.applyParticleImpulse(index(cc, ss), given);
      }
    [this.force[0], this.force[1], this.force[2]] = acceptedForce;
    this.circulation = loads.circulation;
    this.work = work;
  }

  /** The air at the converted point and its density. */
  private air(point: Vec3, time: number): [Vec3, number] {
    const { wind, density } = this.options;
    checkVector(point);
    let air: unknown;
    let rho = density ?? 1.225;
    if (typeof wind === 'function') air = wind(point, time);
    else if (isFlow(wind)) {
      const s = wind.sample(point[0], point[1], point[2], time, this.sample);
      air = s?.velocity;
      rho = density ?? s?.density;
    } else air = wind;
    checkVector(air);
    checkDensity(rho);
    return [air, rho];
  }

  private captureLoad(): Float64Array {
    const words = new Float64Array(this.stateWords());
    words.set(this.force, 1);
    if (this.circulation.length === this.panels) {
      words[0] = 1;
      words.set(this.circulation, 4);
    }
    const work = this.work;
    if (work) {
      const start = 4 + this.panels;
      words[start] = work.solves;
      words.set(workValues(work), start + 1);
      work.workers.forEach((part, i) => words.set(workValues(part), start + 1 + (i + 1) * WORK_WORDS));
    }
    return words;
  }

  private restoreLoad(words: Float64Array): void {
    if (
      !(words instanceof Float64Array) ||
      words.length !== this.stateWords() ||
      (words[0] !== 0 && words[0] !== 1) ||
      !words.every(Number.isFinite)
    )
      throw sailError('Restore the accepted load saved by this sail on its original grid and participant count.');
    const start = 4 + this.panels;
    if (!words.subarray(start).every((value) => Number.isSafeInteger(value) && value >= 0))
      throw sailError('Restore the original nonnegative work counts from the sail snapshot.');
    const work =
      this.threads && words[0]
        ? {
            ...readWork(words, start + 1),
            threads: this.threads,
            solves: words[start]!,
            workers: Array.from({ length: this.threads }, (_, i) => readWork(words, start + 1 + (i + 1) * WORK_WORDS)),
          }
        : undefined;
    const circulation = words[0] ? words.slice(4, start) : new Float64Array(0);
    this.force[0] = words[1]!;
    this.force[1] = words[2]!;
    this.force[2] = words[3]!;
    this.circulation = circulation;
    this.work = work;
  }

  private stateWords(): number {
    return 4 + this.panels + (this.threads ? 1 + (this.threads + 1) * WORK_WORDS : 0);
  }

  /** Stops the load. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.sail.airLoads--;
    this.native?.close();
    this.physics.detach(this);
  }

  /** Removes it, as `remove()` does, so `using` releases it at the end of its scope. */
  [Symbol.dispose](): void {
    this.remove();
  }

  /** @internal */
  dispose(): void {
    if (!this.released) {
      this.sail.airLoads--;
      this.native?.close();
    }
    this.released = true;
  }
}

const HALF_PI = 1.5707963267948966;
const ZERO: FlowCell = [0, 0, 0];
const WORK_FIELDS = [
  'matrixInteractions',
  'matrixPairs',
  'wakeInteractions',
  'wakePairs',
  'eliminationUpdates',
  'eliminationPairs',
] as const satisfies readonly (keyof WingLatticeWorkerWork)[];
const WORK_WORDS = WORK_FIELDS.length;

function sailError(fix: string): MargoError {
  return new MargoError('state', 'Invalid sail load. ' + fix + ' See https://margoengine.com/errors#physics-sail');
}

function isFlow(wind: SailOptions['wind']): wind is FlowField {
  return typeof wind === 'object' && wind !== null && 'sample' in wind && typeof wind.sample === 'function';
}

function checkVector(value: unknown): asserts value is Vec3 {
  const vector = value as ArrayLike<number> | null;
  if (
    (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) ||
    vector?.length !== 3 ||
    !Number.isFinite(vector[0]) ||
    !Number.isFinite(vector[1]) ||
    !Number.isFinite(vector[2])
  )
    throw sailError('Return three finite velocity or position components and keep field coordinates in range.');
}

function checkDensity(value: number): void {
  if (!(value > 0 && Number.isFinite(value))) throw sailError('Pass or sample a finite positive air density in kg/m³.');
}

function checkCell(cell: FlowCell | undefined): asserts cell is FlowCell {
  if (
    !cell ||
    cell.length !== 3 ||
    !Number.isSafeInteger(cell[0]) ||
    !Number.isSafeInteger(cell[1]) ||
    !Number.isSafeInteger(cell[2])
  )
    throw sailError('Pass three signed whole-number coordinates for the sail and air cells.');
}

function flowShift(flow: FlowField, frame?: WindForceFrame): Vec3 {
  const cell = frame ? frame.cell : ZERO;
  const wind = flow.cell;
  checkCell(cell);
  checkCell(wind);
  const size = frame ? frame.cellSize : 1;
  if ((!frame && (wind[0] !== 0 || wind[1] !== 0 || wind[2] !== 0)) || !(size > 0 && Number.isFinite(size)))
    throw sailError('Pass a signed cloth frame and a finite positive cell size for air from a different cell.');
  const shift: Vec3 = [(cell[0] - wind[0]) * size, (cell[1] - wind[1]) * size, (cell[2] - wind[2]) * size];
  checkVector(shift);
  return shift;
}

function workValues(work: WingLatticeWorkerWork): number[] {
  return WORK_FIELDS.map((field) => work[field]);
}

function readWork(words: Float64Array, at: number): WingLatticeWorkerWork {
  return {
    matrixInteractions: words[at]!,
    matrixPairs: words[at + 1]!,
    wakeInteractions: words[at + 2]!,
    wakePairs: words[at + 3]!,
    eliminationUpdates: words[at + 4]!,
    eliminationPairs: words[at + 5]!,
  };
}

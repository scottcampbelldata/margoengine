// The local free surface a hull disturbs (SEA-04 of docs/physics-solvers.md): bow waves, the Kelvin wake and the waves
// any pressure or displaced volume on the water makes, on a grid around the ship, with the dispersion of real water waves.
//
// Written from J. Tessendorf, "Simulating Ocean Water" (course notes, 1999-2004), read pages 3-4 to 3-15: the linearised
// potential flow of the surface (eqs. 11 to 21) with the pressure kept in the linearised Bernoulli equation (eq. 14),
// d phi / dt = -g h - p / rho, and the vertical velocity of the surface as an operator on the surface potential (eqs.
// 19 and 21), sqrt(-grad^2) in deep water and its finite-depth form with tanh (eqs. 51 and 52, the iWave section). iWave
// steps h by a finite difference in time with that operator as a convolution kernel (eq. 50); here the operator is applied
// where it is exact, in Fourier space, where it multiplies each mode by K = k tanh(k D), and each mode is advanced exactly
// over a step: with omega^2 = g K (eq. 32) and the pressure held over the step, the pair (h, phi) of a mode turns about the
// level -p / (rho g) the pressure holds it at,
//   h'  <- h' cos(omega dt) + (K / omega) phi sin(omega dt),   phi <- phi cos(omega dt) - (g / omega) h' sin(omega dt),
// with h' = h + p / (rho g). The step is exact for any dt, so every wavelength on the grid moves at its own phase speed
// and the wake's shape (the Kelvin wedge of half-angle asin(1/3) behind a moving pressure in deep water, transverse
// waves 2 pi U^2 / g long) comes from the dispersion alone. A border of `sponge` cells damps what reaches the edge, so the
// grid's periodic transform does not bring it back on the other side.
//
// Determinism: the transforms are the shared FFT (@margoengine/math/fft, pinned twiddles, a fixed order), the per-mode
// factors come from pinned cos, sin and exp, and the rest is + - * / and sqrt, so a step gives the same bits everywhere.
import type { SeaSource } from '@margoengine/math/fields';
import { RealFft2 } from '@margoengine/math/fft';
import { cos, exp, hypot, sin } from '@margoengine/math/pinned';
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
import { rateOf } from '../world/solver.js';
import { regionWords } from '../world/memory.js';

const PI = 3.141592653589793;
const ORIGIN: Cell = [0, 0, 0];

/** The wake's surface height, published at each step for whatever draws or reads it. */
export const WAKE_HEIGHT_FIELD: FieldDescriptor = {
  name: 'wakeHeight',
  kind: 'heightfield',
  quantity: 'height',
  unit: 'm',
  centring: 'cell',
};
/** The layout version of a wake's regions: x fastest, then z, f64. */
export const WAKE_LAYOUT = 1;

/** What a {@link WakeSolver} is made from. */
export interface WakeParams {
  /** Cells along x and z (default [256, 256]): x even, each a product of 2, 3 and 5 (the FFT's lengths). */
  cells?: readonly [number, number];
  /** Cell width, m (default 1). */
  cellSize?: number;
  /** The grid's centre, m from the world's cell (default [0, 0]). */
  centre?: readonly [number, number];
  /** Still-water depth, m (default Infinity: deep water). */
  depth?: number;
  /** Density of the water, kg/m^3 (default 1025, sea water). */
  density?: number;
  /** Cells of the absorbing border on every side (default 16). */
  sponge?: number;
  /** The rate level it steps at (default 0, 60 Hz; each step is exact, so the rate only sets how often sources move). */
  rate?: RateLevel;
  /**
   * What presses on the water at time `t` s: each source a pressure patch (a hull's weight over its waterplane) and the
   * volume it pushes in over the step, as {@link SeaSource} (default none).
   */
  sources?: (t: number) => readonly SeaSource[];
  /** The surface it starts from: height (m) and surface potential (m^2/s) at each cell centre (default still water). */
  initial?: (x: number, z: number) => readonly [number, number];
}

/** What {@link WakeSolver.sample} gives at a point. */
export interface WakeSample {
  /** Height of the wake's surface over the still level, m. */
  height: number;
  /** Its slope along x and z. */
  slope: [number, number];
  /** Velocity of the water at the surface, m/s: horizontal from the potential's gradient, vertical the surface's rise. */
  velocity: [number, number, number];
}

/**
 * The local free surface a hull disturbs, as a framework solver: `world.add(new WakeSolver(), {cells, cellSize, sources})`.
 * Its height and potential are its state (snapshot, restore and hash with the world); `sample(x, z)` reads it, and a
 * {@link SpectralSea} adds it to the sea through its `patches`.
 */
export class WakeSolver implements Solver<WakeParams> {
  private readonly id: string;
  private host!: SolverHost;
  private cell: Cell = ORIGIN;
  private nx = 0;
  private nz = 0;
  private dx = 1;
  private x0 = 0;
  private z0 = 0;
  private g = 9.81;
  private rho = 1025;
  private level: RateLevel = 0;
  private sources?: (t: number) => readonly SeaSource[];
  private fft!: RealFft2;
  private height!: Region;
  private potential!: Region;
  private previous!: Region;
  // Per mode of the half spectrum: K, and cos(omega dt), sin(omega dt) / omega, omega sin(omega dt) for the step's dt.
  private kk!: Float64Array;
  private c!: Float64Array;
  private sOver!: Float64Array;
  private sTimes!: Float64Array;
  private stepDt = 0;
  private damp!: Float64Array;
  private press!: Float64Array;
  private spectra!: [Float64Array, Float64Array, Float64Array];

  /** @param id The solver's id (default `'wake'`). */
  constructor(id = 'wake') {
    this.id = id;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [{ field: WAKE_HEIGHT_FIELD, access: 'write' }],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  /**
   * @throws RangeError for cells that are not an even x and lengths of factors 2, 3 and 5 (4 to 4096 each), a cell size,
   * density or depth that is not above 0, a sponge that leaves no water, or a rate level outside 0 to 7.
   */
  init(host: SolverHost, params: WakeParams = {}): void {
    const {
      cells = [256, 256],
      cellSize = 1,
      centre = [0, 0],
      depth = Infinity,
      density = 1025,
      sponge = 16,
      rate = 0,
      sources,
      initial,
    } = params;
    if (!(cells.length === 2 && cells.every((n) => Number.isInteger(n) && n >= 4 && n <= 4096)))
      throw new RangeError(`A wake grid has 4 to 4096 whole cells along x and z (got ${cells}); pass two.`);
    for (const [name, value] of [
      ['cell size', cellSize],
      ['density', density],
      ['depth', depth],
    ] as const)
      if (!(value > 0)) throw new RangeError(`A wake's ${name} is above 0 (got ${value}); pass one.`);
    if (!(Number.isFinite(cellSize) && Number.isFinite(density)))
      throw new RangeError('A wake needs a finite cell size and density; pass them.');
    if (!(centre.length === 2 && centre.every(Number.isFinite)))
      throw new RangeError('A wake grid needs a finite centre [x, z]; pass one.');
    if (!(Number.isInteger(sponge) && sponge >= 0 && 2 * sponge < Math.min(cells[0], cells[1])))
      throw new RangeError(`A wake's sponge is a whole number of cells under half the grid (got ${sponge}); pass one.`);
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new RangeError(`A wake's rate level is 0 to 7 (got ${rate}); pass one.`);
    if (sources !== undefined && typeof sources !== 'function')
      throw new TypeError('A wake takes its sources as a function of time, (t) => SeaSource[]; pass one.');
    this.fft = new RealFft2(cells[0], cells[1]);
    [this.nx, this.nz] = cells;
    this.host = host;
    this.dx = cellSize;
    this.x0 = centre[0] - (this.nx * cellSize) / 2;
    this.z0 = centre[1] - (this.nz * cellSize) / 2;
    this.rho = density;
    this.level = rate as RateLevel;
    this.sources = sources;
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    if (!(this.g > 0)) throw new RangeError('A wake needs gravity; give the world a gravity above 0.');
    const n = this.nx * this.nz,
      half = this.nx / 2 + 1;
    this.height = host.allocate(`${this.id}:height`, n * 8, 'f64', WAKE_LAYOUT);
    this.potential = host.allocate(`${this.id}:potential`, n * 8, 'f64', WAKE_LAYOUT);
    this.previous = host.allocate(`${this.id}:previous`, n * 8, 'f64', WAKE_LAYOUT);
    // K = k tanh(k D) for every mode of the half spectrum (deep water: k).
    this.kk = new Float64Array(half * this.nz);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < half; i++) {
        const kx = (2 * PI * i) / (this.nx * cellSize),
          kz = (2 * PI * (j < this.nz / 2 ? j : j - this.nz)) / (this.nz * cellSize),
          k = Math.sqrt(kx * kx + kz * kz),
          e = k * depth > 20 || !(depth < Infinity) ? 0 : exp(-2 * k * depth);
        this.kk[i + half * j] = (k * (1 - e)) / (1 + e);
      }
    this.c = new Float64Array(half * this.nz);
    this.sOver = new Float64Array(half * this.nz);
    this.sTimes = new Float64Array(half * this.nz);
    // The border's damping a second: a smooth ramp, 0 inside, rising to 3 s^-1 at the edge.
    this.damp = new Float64Array(n);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const edge = Math.min(i, j, this.nx - 1 - i, this.nz - 1 - j),
          r = sponge > 0 && edge < sponge ? (sponge - edge) / sponge : 0;
        this.damp[i + this.nx * j] = 3 * r * r;
      }
    if (initial !== undefined) {
      if (typeof initial !== 'function')
        throw new TypeError('A wake starts from initial(x, z) => [height, potential]; pass a function or none.');
      const h = regionWords(host.memory, this.height) as Float64Array,
        phi = regionWords(host.memory, this.potential) as Float64Array;
      for (let j = 0; j < this.nz; j++)
        for (let i = 0; i < this.nx; i++) {
          const [a, b] = initial(this.x0 + (i + 0.5) * cellSize, this.z0 + (j + 0.5) * cellSize);
          if (!(Number.isFinite(a) && Number.isFinite(b)))
            throw new RangeError("A wake's initial height and potential are finite numbers; pass them.");
          h[i + this.nx * j] = a;
          phi[i + this.nx * j] = b;
        }
    }
    this.press = new Float64Array(n);
    const size = 2 * half * this.nz;
    this.spectra = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
  }

  /** The per-mode factors of a step of `dt` s, made once for each new dt. */
  private factors(dt: number): void {
    if (dt === this.stepDt) return;
    for (let m = 0; m < this.kk.length; m++) {
      const omega = Math.sqrt(this.g * this.kk[m]!),
        phase = omega * dt;
      this.c[m] = cos(phase);
      this.sOver[m] = omega > 0 ? sin(phase) / omega : dt;
      this.sTimes[m] = omega * sin(phase);
    }
    this.stepDt = dt;
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    const memory = this.host.memory,
      h = regionWords(memory, this.height) as Float64Array,
      phi = regionWords(memory, this.potential) as Float64Array,
      previous = regionWords(memory, this.previous) as Float64Array,
      { nx, nz, press } = this,
      t = (context.tick + 0.5) / rateOf(context.level);
    previous.set(h);
    press.fill(0);
    // Sources at the step's middle: each a raised-cosine patch of its pressure, and its volume spread over the same patch.
    for (const source of this.sources?.(t) ?? []) this.stamp(source, h);
    this.factors(dt);
    const [H, P, F] = this.spectra,
      fft = this.fft,
      K = this.kk,
      g = this.g,
      level = 1 / (this.rho * g);
    fft.forward(h, H);
    fft.forward(phi, F);
    fft.forward(press, P);
    for (let m = 0; m < K.length; m++) {
      const re = 2 * m,
        im = re + 1;
      if (m === 0) {
        // The mean level and potential: no wave; the water's volume is the sources', kept as they put it.
        F[re] = F[im] = 0;
        continue;
      }
      const c = this.c[m]!,
        so = this.sOver[m]!,
        st = this.sTimes[m]!,
        k = K[m]!;
      for (const part of [re, im]) {
        const rest = -P[part]! * level,
          lift = H[part]! - rest,
          pot = F[part]!;
        // (g / omega) sin(omega dt) is omega sin(omega dt) / K, since omega^2 = g K.
        H[part] = rest + lift * c + k * pot * so;
        F[part] = pot * c - (lift * st) / k;
      }
    }
    fft.inverse(H, h);
    fft.inverse(F, phi);
    for (let i = 0; i < nx * nz; i++) {
      const keep = this.damp[i]! > 0 ? exp(-this.damp[i]! * dt) : 1;
      h[i]! *= keep;
      phi[i]! *= keep;
    }
  }

  /** Adds one source to the step's pressure grid and its volume to the height, as a raised cosine of its radius. */
  private stamp(source: SeaSource, h: Float64Array): void {
    const { x, z, radius, pressure, volume } = source;
    if (
      !(Number.isFinite(x) && Number.isFinite(z) && radius > 0 && Number.isFinite(pressure) && Number.isFinite(volume))
    )
      throw new RangeError('A sea source has a finite place, a radius above 0, and a finite pressure and volume.');
    const { nx, nz, dx, x0, z0, press } = this,
      i0 = Math.max(0, Math.floor((x - radius - x0) / dx)),
      i1 = Math.min(nx - 1, Math.ceil((x + radius - x0) / dx)),
      j0 = Math.max(0, Math.floor((z - radius - z0) / dx)),
      j1 = Math.min(nz - 1, Math.ceil((z + radius - z0) / dx));
    let weight = 0;
    for (let pass = 0; pass < 2; pass++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * dx - x,
            pz = z0 + (j + 0.5) * dx - z,
            r = Math.sqrt(px * px + pz * pz);
          if (r >= radius) continue;
          const b = 0.5 * (1 + cos((PI * r) / radius));
          if (pass === 0) weight += b * dx * dx;
          else {
            press[i + nx * j]! += pressure * b;
            if (volume && weight > 0) h[i + nx * j]! += (volume * b) / weight;
          }
        }
  }

  /**
   * The wake at (x, z) m from the world's cell: its height, slope and surface velocity, by bilinear reading of the grid
   * (0 outside it). Writes into `out` when given and returns it.
   */
  sample(x: number, z: number, out?: WakeSample): WakeSample {
    const s = out ?? { height: 0, slope: [0, 0], velocity: [0, 0, 0] },
      memory = this.host.memory,
      h = regionWords(memory, this.height) as Float64Array,
      phi = regionWords(memory, this.potential) as Float64Array,
      previous = regionWords(memory, this.previous) as Float64Array,
      { nx, nz, dx } = this,
      u = (x - this.x0) / dx - 0.5,
      v = (z - this.z0) / dx - 0.5;
    s.height = s.slope[0] = s.slope[1] = s.velocity[0] = s.velocity[1] = s.velocity[2] = 0;
    if (!(u >= 1 && v >= 1 && u < nx - 2 && v < nz - 2)) return s;
    const i = Math.floor(u),
      j = Math.floor(v),
      fu = u - i,
      fv = v - j,
      at = (field: Float64Array, a: number, b: number) => field[a + nx * b]!,
      lerp = (field: Float64Array, a: number, b: number) =>
        (1 - fu) * (1 - fv) * at(field, a, b) +
        fu * (1 - fv) * at(field, a + 1, b) +
        (1 - fu) * fv * at(field, a, b + 1) +
        fu * fv * at(field, a + 1, b + 1),
      ddx = (field: Float64Array, a: number, b: number) => (at(field, a + 1, b) - at(field, a - 1, b)) / (2 * dx),
      ddz = (field: Float64Array, a: number, b: number) => (at(field, a, b + 1) - at(field, a, b - 1)) / (2 * dx),
      blend = (f: (a: number, b: number) => number) =>
        (1 - fu) * (1 - fv) * f(i, j) +
        fu * (1 - fv) * f(i + 1, j) +
        (1 - fu) * fv * f(i, j + 1) +
        fu * fv * f(i + 1, j + 1);
    s.height = lerp(h, i, j);
    s.slope[0] = blend((a, b) => ddx(h, a, b));
    s.slope[1] = blend((a, b) => ddz(h, a, b));
    s.velocity[0] = blend((a, b) => ddx(phi, a, b));
    s.velocity[2] = blend((a, b) => ddz(phi, a, b));
    s.velocity[1] = this.stepDt > 0 ? (s.height - lerp(previous, i, j)) / this.stepDt : 0;
    return s;
  }

  /** The grid: cells, cell size and its first corner, m. */
  get grid(): { cells: [number, number]; cellSize: number; origin: [number, number] } {
    return { cells: [this.nx, this.nz], cellSize: this.dx, origin: [this.x0, this.z0] };
  }

  /** The height grid as it stands, a view over the world's memory (x fastest, then z). */
  heights(): Float64Array {
    return regionWords(this.host.memory, this.height) as Float64Array;
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: WAKE_HEIGHT_FIELD.name, region: this.height, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.height, this.potential];
  }

  extraState(): readonly Region[] {
    return [this.previous];
  }
}

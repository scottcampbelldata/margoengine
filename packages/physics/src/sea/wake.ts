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
import {
  ProjectedWakeSource,
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_CELLS,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  type WakeSourceGrid,
  wakeDepths,
  wakePatch,
} from './submerged-wake.js';
import { MargoError } from '@margoengine/math/errors';
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
import {
  WAKE_BREAKING_FIELD,
  WAKE_BREAKING_HEADER_WORDS,
  WAKE_BREAKING_LAYOUT,
  WAKE_BREAKING_WORDS,
  writeWakeBreaking,
} from './wake-breaking.js';
import { bindWakeFft, loadWakeFft, type WakeFft } from './wake-fft.js';
import { WakeModeStep } from './wake-modes.js';
import {
  bindWakeModes,
  loadWakeModes,
  type WakeModeBuilds,
  type WakeNativeModes,
  type WakeNativeWorkCounts,
} from './wake-native-modes.js';

export type { WakeNativeWorkerWork, WakeNativeWorkCounts } from './wake-native-modes.js';

const PI = 3.141592653589793;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const MAX_PINNED_PHASE = 1_048_576;

function wakeFailure(fix: string): MargoError {
  return new MargoError('state', 'Invalid wake step. ' + fix + ' See https://margoengine.com/errors#physics-wake');
}

type WakeTrial = {
  height: Float64Array;
  potential: Float64Array;
  velocity?: Float64Array;
  breaking?: Float64Array;
};

function wakeFftLength(length: number): boolean {
  if (!Number.isInteger(length) || length < 4 || length > 4096) return false;
  for (const radix of [2, 3, 5]) while (length % radix === 0) length /= radix;
  return length === 1;
}

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
/** Layout-1 f64 SeaSource rows are x, z, radius, pressure and volume. */
export const WAKE_SOURCE_WORDS = 5;
/** Binary version of a SeaSource registry field. */
export const WAKE_SOURCE_LAYOUT = 1;

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
  /** Uniform horizontal current [x, z], m/s (default [0, 0]). The sample reports the wave's velocity perturbation. */
  current?: readonly [number, number];
  /** Surface tension, N/m (default 0). For clean room-temperature fresh water use about 0.073 N/m. */
  surfaceTension?: number;
  /** Kinematic viscosity, m²/s (default 0). Applies leading-order surface wave decay, without bottom friction. */
  kinematicViscosity?: number;
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
  /**
   * Keep the water's velocity below the surface for {@link WakeSolver.velocityAt} (default false): at each step the
   * potential's gradient at a few depths (the still level, then half a cell doubling to half the grid or the bottom),
   * each mode decaying as cosh(k (D - d)) / cosh(k D), e^(-k d) in deep water. Costs a transform and three inverse
   * transforms a depth each step; a liquid box held to the sea reads it at its sides.
   */
  waterBelow?: boolean;
}

/** Opt-in wake crest publication for local foam and spray readers. */
export interface WakeBreakingOptions {
  /** Descriptor with wakeBreakingCrest quantity. Defaults to WAKE_BREAKING_FIELD. */
  readonly field?: FieldDescriptor;
  /** Number of published crest rows. Default 4096 or the number of grid cells if smaller. */
  readonly capacity?: number;
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
  private modeBuilds?: WakeModeBuilds;
  private nativeModes?: WakeNativeModes;
  private disposed = false;
  private host!: SolverHost;
  private nx = 0;
  private nz = 0;
  private dx = 1;
  private x0 = 0;
  private z0 = 0;
  private g = 9.81;
  private rho = 1025;
  private level: RateLevel = 0;
  private sources?: (t: number) => readonly SeaSource[];
  private readonly sourceField?: FieldDescriptor;
  private readonly submergedSource?: SubmergedWakeSource;
  private projected?: ProjectedWakeSource;
  private fft!: WakeFft;
  private fftModule?: WebAssembly.Module;
  /** Optional descriptor consumed by a FoamSolver or another local crest reader. */
  readonly breakingField?: FieldDescriptor;
  private readonly breakingCapacity?: number;
  private breaking?: Region;
  private current: readonly [number, number] = [0, 0];
  private height!: Region;
  private potential!: Region;
  private previous!: Region;
  // Per mode of the half spectrum: K, and cos(omega dt), sin(omega dt) / omega, omega sin(omega dt) for the step's dt.
  private kk!: Float64Array;
  private c!: Float64Array;
  private sOver!: Float64Array;
  private sTimes!: Float64Array;
  private stepDt = 0;
  private publishedDt = 0;
  private projectedRows = 0;
  private projectedBands = 0;
  private trial!: WakeTrial;
  private modeStep?: WakeModeStep;
  private surfaceRise?: Region;
  private damp!: Float64Array;
  private press!: Float64Array;
  private patchGrid!: WakeSourceGrid;
  private depth = Infinity;
  /** The depths of the water's velocity layers, m below the still level, and their region (u, v, w per layer). */
  private belowDepths: number[] = [];
  private below?: Region;
  private spectra!: readonly [Float64Array, Float64Array, Float64Array];

  /**
   * @param id The solver's id, default 'wake'.
   * @param sourceField Optional layout-1 f64 SeaSource rows from a 60 Hz solver in the same world cell.
   * @param submergedSource Optional projected advancing-volume source with shared depth bands.
   * @param breaking Pass an options object to publish diagnostic breaking crests.
   */
  constructor(
    id = 'wake',
    sourceField?: FieldDescriptor,
    submergedSource?: SubmergedWakeSource,
    breaking?: WakeBreakingOptions,
  ) {
    if (sourceField && (sourceField.quantity !== 'seaSource' || sourceField.unit !== 'SI'))
      throw new MargoError('state', 'Invalid wake source descriptor. Use a seaSource field in SI units.');
    this.id = id;
    if (breaking) {
      const { field = WAKE_BREAKING_FIELD, capacity } = breaking;
      if (
        field?.quantity !== WAKE_BREAKING_FIELD.quantity ||
        field.kind !== WAKE_BREAKING_FIELD.kind ||
        field.unit !== 'SI' ||
        (capacity !== undefined && !(Number.isSafeInteger(capacity) && capacity > 0))
      )
        throw new MargoError('state', 'Use a wake breaking crest field in SI and a positive whole row capacity.');
      this.breakingField = Object.freeze({ ...field });
      this.breakingCapacity = capacity;
    }
    this.sourceField = sourceField ? Object.freeze({ ...sourceField }) : undefined;
    if (submergedSource) {
      const { field, depths } = submergedSource;
      if (field?.quantity !== SUBMERGED_WAKE_QUANTITY || field.unit !== 'SI' || field.name === sourceField?.name)
        throw new MargoError(
          'state',
          'Pass a distinct submerged wake source descriptor in SI units, such as HullSolver.submergedWakeSource.',
        );
      this.submergedSource = { field: Object.freeze({ ...field }), depths: wakeDepths(depths) };
    }
  }

  /** Loads the optional Rust/Wasm FFT and modal advance. Native participants include the caller and default to one. */
  static async load(
    options: {
      readonly id?: string;
      readonly sourceField?: FieldDescriptor;
      readonly submergedSource?: SubmergedWakeSource;
      readonly breaking?: WakeBreakingOptions;
      readonly signal?: AbortSignal;
      readonly threads?: 1 | 2 | 4;
    } = {},
  ): Promise<WakeSolver> {
    const { id, sourceField, submergedSource, breaking, signal, threads = 1 } = options;
    const wake = new WakeSolver(id, sourceField, submergedSource, breaking);
    wake.fftModule = await loadWakeFft(signal);
    wake.modeBuilds = await loadWakeModes(wake.fftModule, threads, signal);
    return wake;
  }

  /** Releases the optional modal helpers after stopping the world. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.nativeModes) this.nativeModes.close();
    else this.modeBuilds?.[Symbol.dispose]();
  }

  /** Native mode work for the last accepted step. */
  readNativeWork(): WakeNativeWorkCounts | undefined {
    return this.nativeModes?.workCounts();
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: WAKE_HEIGHT_FIELD, access: 'write' },
        ...(this.breakingField ? [{ field: this.breakingField, access: 'write' as const }] : []),
        ...(this.sourceField ? [{ field: this.sourceField, access: 'read' as const }] : []),
        ...(this.submergedSource ? [{ field: this.submergedSource.field, access: 'read' as const }] : []),
      ],
      rate: this.level,
      stableRate: () => this.level,
    };
  }

  /**
   * @throws MargoError (state) for invalid grid, water, rate or source parameters, with the correction in the message.
   */
  init(host: SolverHost, params: WakeParams = {}): void {
    if (this.disposed) throw wakeFailure('Load a new wake after disposing its native plan.');
    if (this.host) throw wakeFailure('Create a separate wake before attaching another world.');
    const {
      cells = [256, 256],
      cellSize = 1,
      centre = [0, 0],
      depth = Infinity,
      current = [0, 0],
      surfaceTension = 0,
      kinematicViscosity = 0,
      density = 1025,
      sponge = 16,
      rate = 0,
      sources,
      initial,
      waterBelow = false,
    } = params;
    if (!(cells?.length === 2 && wakeFftLength(cells[0]) && wakeFftLength(cells[1]) && cells[0] % 2 === 0))
      throw new MargoError(
        'state',
        'Pass wake cells [nx, nz] from 4 to 4096 with only factors 2, 3 and 5 and an even nx.',
      );
    for (const [name, value] of [
      ['cell size', cellSize],
      ['density', density],
      ['depth', depth],
    ] as const)
      if (!(value > 0)) throw new MargoError('state', `A wake's ${name} is above 0 (got ${value}); pass one.`);
    if (!(Number.isFinite(cellSize) && Number.isFinite(density)))
      throw new MargoError('state', 'A wake needs a finite cell size and density; pass them.');
    if (!(current?.length === 2 && Number.isFinite(current[0]) && Number.isFinite(current[1])))
      throw new MargoError('state', 'Pass a finite wake current [x, z] in m/s, or omit it for still water.');
    if (!(surfaceTension >= 0 && Number.isFinite(surfaceTension)))
      throw new MargoError('state', 'Set wake surfaceTension to a finite non-negative value in N/m.');
    if (!(kinematicViscosity >= 0 && Number.isFinite(kinematicViscosity)))
      throw new MargoError('state', 'Set wake kinematicViscosity to a finite non-negative value in m²/s.');
    if (!(centre?.length === 2 && Number.isFinite(centre[0]) && Number.isFinite(centre[1])))
      throw new MargoError('state', 'A wake grid needs a finite centre [x, z]; pass one.');
    if (!(Number.isInteger(sponge) && sponge >= 0 && 2 * sponge < Math.min(cells[0], cells[1])))
      throw new MargoError(
        'state',
        `A wake's sponge is a whole number of cells under half the grid (got ${sponge}); pass one.`,
      );
    if (!(Number.isInteger(rate) && rate >= 0 && rate <= 7))
      throw new MargoError('state', `A wake's rate level is 0 to 7 (got ${rate}); pass one.`);
    if ((this.sourceField || this.submergedSource) && rate !== 0)
      throw new MargoError(
        'state',
        'Wake field sources use the world base rate. Set the wake and its publisher to 60 Hz.',
      );
    if (sources !== undefined && typeof sources !== 'function')
      throw new MargoError('state', 'A wake takes its sources as a function of time, (t) => SeaSource[]; pass one.');
    if (initial !== undefined && typeof initial !== 'function')
      throw new MargoError('state', 'Pass a function initial(x, z) => [height, potential] or omit it for still water.');
    if (this.submergedSource && cells[0] * cells[1] > SUBMERGED_WAKE_MAX_CELLS)
      throw new MargoError('state', 'A projected wake supports up to 1,048,576 cells; reduce the grid dimensions.');
    const fftInstance = this.fftModule ? new WebAssembly.Instance(this.fftModule) : undefined;
    this.fft = this.fftModule
      ? bindWakeFft(this.fftModule, cells[0], cells[1], fftInstance)
      : new RealFft2(cells[0], cells[1]);
    [this.nx, this.nz] = cells;
    this.host = host;
    this.current = [current[0], current[1]];
    this.dx = cellSize;
    this.x0 = centre[0] - (this.nx * cellSize) / 2;
    this.z0 = centre[1] - (this.nz * cellSize) / 2;
    if (
      !Number.isFinite(this.x0 + this.nx * cellSize) ||
      !Number.isFinite(this.z0 + this.nz * cellSize) ||
      !(cellSize * cellSize > 0 && Number.isFinite(cellSize * cellSize))
    )
      throw wakeFailure('Use a finite grid extent and a representable positive cell area.');
    this.patchGrid = { nx: this.nx, nz: this.nz, dx: cellSize, x0: this.x0, z0: this.z0 };
    this.rho = density;
    this.level = rate as RateLevel;
    this.sources = sources;
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    if (!(this.g > 0 && Number.isFinite(this.g))) throw wakeFailure('Give the world finite gravity above zero.');
    const n = this.nx * this.nz,
      half = this.nx / 2 + 1;
    this.height = host.allocate(`${this.id}:height`, n * 8, 'f64', WAKE_LAYOUT);
    this.potential = host.allocate(`${this.id}:potential`, n * 8, 'f64', WAKE_LAYOUT);
    this.previous = host.allocate(`${this.id}:previous`, n * 8, 'f64', WAKE_LAYOUT);
    if (this.breakingField) {
      const capacity = Math.min(n, this.breakingCapacity ?? 4096);
      const words = WAKE_BREAKING_HEADER_WORDS + capacity * WAKE_BREAKING_WORDS;
      this.breaking = host.allocate(this.breakingField.name, words * 8, 'f64', WAKE_BREAKING_LAYOUT);
      (regionWords(host.memory, this.breaking) as Float64Array)[2] = this.dx;
    }
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
    if (current[0] || current[1] || surfaceTension || kinematicViscosity) {
      this.modeStep = new WakeModeStep(
        this.kk,
        cells,
        cellSize,
        this.g,
        density,
        surfaceTension,
        kinematicViscosity,
        current,
      );
      if (!waterBelow) this.surfaceRise = host.allocate(`${this.id}:rise`, n * 8, 'f64', WAKE_LAYOUT);
    } else {
      this.c = new Float64Array(half * this.nz);
      this.sOver = new Float64Array(half * this.nz);
      this.sTimes = new Float64Array(half * this.nz);
    }
    // The border's damping a second: a smooth ramp, 0 inside, rising to 3 s^-1 at the edge.
    this.damp = new Float64Array(n);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const edge = Math.min(i, j, this.nx - 1 - i, this.nz - 1 - j),
          r = sponge > 0 && edge < sponge ? (sponge - edge) / sponge : 0;
        this.damp[i + this.nx * j] = 3 * r * r;
      }
    if (initial) {
      const h = regionWords(host.memory, this.height) as Float64Array,
        phi = regionWords(host.memory, this.potential) as Float64Array;
      for (let j = 0; j < this.nz; j++)
        for (let i = 0; i < this.nx; i++) {
          const row = initial(this.x0 + (i + 0.5) * cellSize, this.z0 + (j + 0.5) * cellSize);
          if (!(row?.length === 2 && Number.isFinite(row[0]) && Number.isFinite(row[1])))
            throw new MargoError('state', "A wake's initial height and potential are finite numbers; pass them.");
          h[i + this.nx * j] = row[0];
          phi[i + this.nx * j] = row[1];
        }
      // The first sample and a restore of the same initial wake have zero finite-difference rise.
      (regionWords(host.memory, this.previous) as Float64Array).set(h);
    }
    this.press = new Float64Array(n);
    const size = 2 * half * this.nz;
    this.nativeModes =
      this.modeBuilds && bindWakeModes(this.modeBuilds, half * this.nz, Boolean(this.modeStep), fftInstance);
    this.spectra = this.nativeModes?.spectra ?? [
      new Float64Array(size),
      new Float64Array(size),
      new Float64Array(size),
    ];
    if (this.modeStep) this.factors(1 / rateOf(this.level));
    this.depth = depth;
    this.projected = this.submergedSource
      ? new ProjectedWakeSource(this.patchGrid, this.submergedSource.depths, depth)
      : undefined;
    if (waterBelow) {
      const deepest = Math.min(depth, 0.5 * Math.min(this.nx, this.nz) * cellSize);
      this.belowDepths = [0];
      for (let d = cellSize / 2; d < deepest; d *= 2) this.belowDepths.push(d);
      if (depth < Infinity) this.belowDepths.push(depth);
      this.below = host.allocate(`${this.id}:below`, this.belowDepths.length * 3 * n * 8, 'f64', WAKE_LAYOUT);
    }
    const velocity = this.below ?? this.surfaceRise;
    this.trial = {
      height: new Float64Array(n),
      potential: new Float64Array(n),
      velocity: velocity && new Float64Array(velocity.byteLength / F64),
      breaking: this.breaking && new Float64Array(this.breaking.byteLength / F64),
    };
    if (velocity) {
      const field = regionWords(host.memory, velocity) as Float64Array;
      this.updateWaterVelocity(regionWords(host.memory, this.potential) as Float64Array, field);
      if (!field.every(Number.isFinite))
        throw wakeFailure('Use smaller initial potentials and a resolved grid so velocities stay finite.');
    }
  }

  /** Retain the potential's vertical velocity for the configured wave model or its full depth layers. */
  private updateWaterVelocity(phi: Float64Array, out: Float64Array): void {
    if (this.below) {
      this.layers(phi, out);
      return;
    }
    const spectrum = this.spectra[0];
    this.fft.forward(phi, spectrum);
    for (let m = 0; m < this.kk.length; m++) {
      spectrum[2 * m]! *= this.kk[m]!;
      spectrum[2 * m + 1]! *= this.kk[m]!;
    }
    this.fft.inverse(spectrum, out);
  }

  /**
   * The water's velocity at each layer depth from the surface potential: each mode of phi times i kx (and i kz) for the
   * horizontal velocity and k sinh(k (D - d)) / cosh(k D) for the vertical, all times its decay cosh(k (D - d)) / cosh(k D)
   * (Tessendorf's eq. 18 with no flow through the bottom; e^(-k d) and k e^(-k d) in deep water), transformed back.
   */
  private layers(phi: Float64Array, out: Float64Array): void {
    const { nx, nz, dx, fft } = this,
      n = nx * nz,
      half = nx / 2 + 1,
      [F, A] = this.spectra,
      deep = !(this.depth < Infinity);
    fft.forward(phi, F);
    const field = new Float64Array(n);
    this.belowDepths.forEach((d, layer) => {
      for (let c = 0; c < 3; c++) {
        for (let j = 0; j < nz; j++)
          for (let i = 0; i < half; i++) {
            const m = i + half * j,
              kx = (2 * PI * i) / (nx * dx),
              kz = (2 * PI * (j < nz / 2 ? j : j - nz)) / (nz * dx),
              k = Math.sqrt(kx * kx + kz * kz);
            // cosh(k (D - d)) / cosh(k D) and sinh(k (D - d)) / cosh(k D), from decaying exponentials only.
            let ch = exp(-k * d),
              sh = ch;
            if (!deep) {
              const back = exp(-k * (2 * this.depth - d)),
                bottom = 1 + exp(-2 * k * this.depth);
              ch = (ch + back) / bottom;
              sh = (sh - back) / bottom;
            }
            const re = F[2 * m]!,
              im = F[2 * m + 1]!;
            if (c === 2) {
              A[2 * m] = k * sh * re;
              A[2 * m + 1] = k * sh * im;
            } else {
              const kk = c === 0 ? kx : kz;
              A[2 * m] = -kk * ch * im;
              A[2 * m + 1] = kk * ch * re;
            }
          }
        fft.inverse(A, field);
        // u, w (vertical), v (along z) stored as x, y, z.
        out.set(field, (layer * 3 + (c === 2 ? 1 : c === 0 ? 0 : 2)) * n);
      }
    });
  }

  /**
   * The wake's water velocity at (x, y, z) m from the world's cell, into `out`: the potential's gradient at depth -y below
   * the still level, read bilinearly across the grid and linearly between the depths it keeps (above the still level, as
   * there: linear theory has no water above it). 0 outside the grid, as {@link WakeSolver.sample}. Needs `waterBelow`.
   * @throws MargoError (state) for a wake made without `waterBelow`.
   */
  velocityAt(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    if (!this.below)
      throw new MargoError(
        'state',
        "A wake gives the water's velocity below its surface when made with waterBelow: true; pass it.",
      );
    out[0] = out[1] = out[2] = 0;
    const { nx, nz, dx } = this,
      u = (x - this.x0) / dx - 0.5,
      v = (z - this.z0) / dx - 0.5;
    if (!(u >= 1 && v >= 1 && u < nx - 2 && v < nz - 2)) return out;
    const depths = this.belowDepths,
      d = Math.min(Math.max(-y, 0), depths[depths.length - 1]!);
    let layer = 0;
    while (layer + 2 < depths.length && depths[layer + 1]! < d) layer++;
    const d0 = depths[layer]!,
      d1 = depths[Math.min(layer + 1, depths.length - 1)]!,
      f = d1 > d0 ? (d - d0) / (d1 - d0) : 0,
      words = regionWords(this.host.memory, this.below) as Float64Array,
      n = nx * nz,
      i = Math.floor(u),
      j = Math.floor(v),
      fu = u - i,
      fv = v - j,
      k = i + nx * j;
    for (let c = 0; c < 3; c++) {
      let value = 0;
      for (const [l, wl] of [
        [layer, 1 - f],
        [Math.min(layer + 1, depths.length - 1), f],
      ] as const) {
        if (wl === 0) continue;
        const at = (l * 3 + c) * n + k;
        value +=
          wl *
          ((1 - fu) * (1 - fv) * words[at]! +
            fu * (1 - fv) * words[at + 1]! +
            (1 - fu) * fv * words[at + nx]! +
            fu * fv * words[at + nx + 1]!);
      }
      out[c] = value;
    }
    return out;
  }

  /** The per-mode factors of a step of `dt` s, made once for each new dt. */
  private factors(dt: number): void {
    if (dt === this.stepDt) return;
    // A refused update can have written a prefix of coefficients. Rebuild the next trial even at the old duration.
    this.stepDt = 0;
    if (this.modeStep) {
      this.modeStep.prepare(dt, this.nativeModes);
      this.stepDt = dt;
      return;
    }
    for (let m = 0; m < this.kk.length; m++) {
      const omega = Math.sqrt(this.g * this.kk[m]!),
        phase = omega * dt;
      if (m > 0 && !(omega > 0 && Number.isFinite(omega) && phase < MAX_PINNED_PHASE))
        throw wakeFailure('Use a finer time step or a resolved gravity and depth for each nonzero wake mode.');
      this.c[m] = cos(phase);
      this.sOver[m] = omega > 0 ? sin(phase) / omega : dt;
      this.sTimes[m] = omega * sin(phase);
    }
    this.nativeModes?.prepareGravity(this.kk, this.c, this.sOver, this.sTimes, 1 / (this.rho * this.g));
    this.stepDt = dt;
  }

  step(context: StepContext, dt: number): void {
    if (this.disposed || !this.host) throw wakeFailure('Add a live wake to the world before stepping it.');
    if (!(dt > 0 && Number.isFinite(dt))) throw wakeFailure('Pass a finite positive wake duration.');
    const { memory } = this.host;
    const { height: h, potential: phi, velocity, breaking } = this.trial;
    const { nx, nz, press } = this;
    const t = (context.tick + 0.5) / rateOf(context.level);
    if (!Number.isFinite(t)) throw wakeFailure('Supply a finite tick on the wake world clock.');
    h.set(regionWords(memory, this.height));
    phi.set(regionWords(memory, this.potential));
    this.factors(dt);
    press.fill(0);
    // Stamp only into trial arrays. A rejected port or callback has no visible prefix.
    const sources = this.sources?.(t);
    if (sources !== undefined && !Array.isArray(sources))
      throw wakeFailure('Return an array of SeaSource rows from the wake source function.');
    for (const source of sources ?? []) this.stamp(source, h);
    const sourcePort = this.sourceField && context.inputs.get(this.sourceField.name);
    if (sourcePort) this.stampField(sourcePort, context.cell, h);
    if (!h.every(Number.isFinite) || !press.every(Number.isFinite))
      throw wakeFailure('Reduce incoming wake volume or pressure so overlapping sources stay finite.');
    const [H, P, F] = this.spectra;
    const fft = this.fft;
    fft.forward(h, H);
    const submergedPort = this.submergedSource && context.inputs.get(this.submergedSource.field.name);
    if (submergedPort) this.stampSubmerged(submergedPort, context.cell, H);
    fft.forward(phi, F);
    fft.forward(press, P);
    if (this.nativeModes) this.nativeModes.advance();
    else if (this.modeStep) this.modeStep.advance(H, F, P);
    else this.advanceGravityModes(H, F, P);
    fft.inverse(H, h);
    fft.inverse(F, phi);
    for (let i = 0; i < nx * nz; i++) {
      const keep = this.damp[i]! > 0 ? exp(-this.damp[i]! * dt) : 1;
      h[i]! *= keep;
      phi[i]! *= keep;
    }
    if (!h.every(Number.isFinite) || !phi.every(Number.isFinite))
      throw wakeFailure('Reduce wake forcing so the height and potential stay finite through the transform.');
    if (velocity) {
      this.updateWaterVelocity(phi, velocity);
      if (!velocity.every(Number.isFinite))
        throw wakeFailure('Reduce wake forcing or resolve the grid so water velocity stays finite.');
    }
    // Reopen the arena views after callbacks. An input may have grown the owning memory.
    const acceptedHeight = regionWords(memory, this.height) as Float64Array;
    if (breaking) {
      writeWakeBreaking(breaking, this.grid, acceptedHeight, h, phi, dt, this.current, press, this.damp);
      if (!breaking.every(Number.isFinite))
        throw wakeFailure('Use a resolved wake grid and smaller forcing to keep the breaking field finite.');
    }
    (regionWords(memory, this.previous) as Float64Array).set(acceptedHeight);
    acceptedHeight.set(h);
    (regionWords(memory, this.potential) as Float64Array).set(phi);
    if (velocity) (regionWords(memory, (this.below ?? this.surfaceRise)!) as Float64Array).set(velocity);
    if (breaking) (regionWords(memory, this.breaking!) as Float64Array).set(breaking);
    this.publishedDt = dt;
    this.projectedRows = submergedPort ? this.projected!.rows : 0;
    this.projectedBands = submergedPort ? this.projected!.bands : 0;
    this.nativeModes?.accept();
  }

  private advanceGravityModes(H: Float64Array, F: Float64Array, P: Float64Array): void {
    const K = this.kk;
    const level = 1 / (this.rho * this.g);
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
  }

  private sourceRows(port: Port, cell: Cell, field: string, layout: number, stride: number, max: number): Float64Array {
    const { region } = port;
    const memory = region?.memory ?? this.host.memory;
    const rowBytes = stride * F64;
    if (
      port.field !== field ||
      region?.type !== 'f64' ||
      region.layout !== layout ||
      !Number.isSafeInteger(region.byteOffset) ||
      region.byteOffset < 0 ||
      region.byteOffset % F64 ||
      !Number.isSafeInteger(region.byteLength) ||
      region.byteLength < 0 ||
      region.byteLength % rowBytes ||
      region.byteLength / rowBytes > max ||
      !(memory instanceof WebAssembly.Memory) ||
      region.byteOffset + region.byteLength > memory.buffer.byteLength
    )
      throw wakeFailure('Publish aligned layout-1 f64 wake source rows in their owning memory.');
    if (!port.cell || port.cell.length !== 3 || cell.some((coordinate, i) => coordinate !== port.cell[i]))
      throw wakeFailure('Place the wake and source in the same signed world cell.');
    return regionWords(memory, region) as Float64Array;
  }

  private stampField(port: Port, cell: Cell, height: Float64Array): void {
    const words = this.sourceRows(port, cell, this.sourceField!.name, WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS, Infinity);
    for (let at = 0; at < words.length; at += WAKE_SOURCE_WORDS) {
      const x = words[at]!;
      const z = words[at + 1]!;
      const radius = words[at + 2]!;
      const pressure = words[at + 3]!;
      const volume = words[at + 4]!;
      if (pressure !== 0 || volume !== 0) this.stamp({ x, z, radius, pressure, volume }, height);
    }
  }

  /** Adds one source to the step's pressure grid and its volume to the height, as a raised cosine of its radius. */
  private stamp(source: SeaSource, h: Float64Array): void {
    if (!source) throw wakeFailure('Supply a SeaSource row with position, radius, pressure and volume.');
    const { x, z, radius, pressure, volume } = source;
    if (
      !(
        Number.isFinite(x) &&
        Number.isFinite(z) &&
        Number.isFinite(radius) &&
        radius > 0 &&
        Number.isFinite(pressure) &&
        Number.isFinite(volume)
      )
    )
      throw new MargoError(
        'state',
        'Invalid sea source. Use a finite place, a finite positive radius, and finite pressure and volume.',
      );
    wakePatch(this.patchGrid, x, z, radius, volume, h, pressure, this.press);
  }

  private stampSubmerged(port: Port, cell: Cell, heightSpectrum: Float64Array): void {
    const rows = this.sourceRows(
      port,
      cell,
      this.submergedSource!.field.name,
      SUBMERGED_WAKE_LAYOUT,
      SUBMERGED_WAKE_WORDS,
      SUBMERGED_WAKE_MAX_ROWS,
    );
    this.projected!.add(rows, this.fft, heightSpectrum);
  }

  /** Per-step transforms for the current configuration and last active submerged bands. */
  fftWork(): { backend: 'typescript' | 'wasm-simd'; forward: number; inverse: number; transferBytes: number } {
    const layers = this.belowDepths.length;
    const velocity = layers > 0 || this.surfaceRise !== undefined;
    const forward = 3 + Number(velocity) + this.projectedBands;
    const inverse = 2 + (layers > 0 ? 3 * layers : Number(velocity));
    const bytes = 8 * (this.nx + this.nx + 2) * this.nz;
    return {
      backend: this.fftModule ? 'wasm-simd' : 'typescript',
      forward,
      inverse,
      transferBytes: this.fftModule ? bytes * (forward + inverse) : 0,
    };
  }

  /** Nonzero projected rows and additional forward FFTs in the last executed step. */
  submergedSourceWork(): { readonly rows: number; readonly transforms: number } {
    return { rows: this.projectedRows, transforms: this.projectedBands };
  }

  /**
   * The wake at (x, z) m from the world's cell: its height, slope and surface velocity, by bilinear reading of the grid
   * (0 outside it). Writes into `out` when given and returns it.
   */
  sample(x: number, z: number, out?: WakeSample): WakeSample {
    if (!this.host) throw wakeFailure('Add the wake to a world before sampling its surface.');
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
      ddx = (field: Float64Array, a: number, b: number) => (at(field, a + 1, b) - at(field, a - 1, b)) / (2 * dx),
      ddz = (field: Float64Array, a: number, b: number) => (at(field, a, b + 1) - at(field, a, b - 1)) / (2 * dx),
      blend = (f: (a: number, b: number) => number) =>
        (1 - fu) * (1 - fv) * f(i, j) +
        fu * (1 - fv) * f(i + 1, j) +
        (1 - fu) * fv * f(i, j + 1) +
        fu * fv * f(i + 1, j + 1);
    s.height = this.heightAt(h, x, z);
    // The slope is the central difference of this same reading one cell either side (each 0 within a cell and a half of
    // the edge), the slope Water draws (`@margoengine/water/wake`), so the normal a hull floats on is the one it shows.
    s.slope[0] = (this.heightAt(h, x + dx, z) - this.heightAt(h, x - dx, z)) / (2 * dx);
    s.slope[1] = (this.heightAt(h, x, z + dx) - this.heightAt(h, x, z - dx)) / (2 * dx);
    s.velocity[0] = blend((a, b) => ddx(phi, a, b));
    s.velocity[2] = blend((a, b) => ddz(phi, a, b));
    if (this.surfaceRise) {
      s.velocity[1] = this.heightAt(regionWords(memory, this.surfaceRise) as Float64Array, x, z);
    } else if (this.modeStep && this.below) {
      const layers = regionWords(memory, this.below) as Float64Array;
      s.velocity[1] = this.heightAt(layers.subarray(nx * nz), x, z);
    } else {
      s.velocity[1] = this.publishedDt > 0 ? (s.height - this.heightAt(previous, x, z)) / this.publishedDt : 0;
    }
    return s;
  }

  /** A grid field read bilinearly at (x, z), 0 within a cell and a half of the edge, as `sample` reads it. */
  private heightAt(h: Float64Array, x: number, z: number): number {
    const { nx, nz, dx } = this,
      u = (x - this.x0) / dx - 0.5,
      v = (z - this.z0) / dx - 0.5;
    if (!(u >= 1 && v >= 1 && u < nx - 2 && v < nz - 2)) return 0;
    const i = Math.floor(u),
      j = Math.floor(v),
      fu = u - i,
      fv = v - j,
      k = i + nx * j;
    return (
      (1 - fu) * (1 - fv) * h[k]! + fu * (1 - fv) * h[k + 1]! + (1 - fu) * fv * h[k + nx]! + fu * fv * h[k + nx + 1]!
    );
  }

  /** The grid: cells, cell size and its first corner, m. */
  get grid(): { cells: [number, number]; cellSize: number; origin: [number, number] } {
    return { cells: [this.nx, this.nz], cellSize: this.dx, origin: [this.x0, this.z0] };
  }

  /** The height grid as it stands, a view over the world's memory (x fastest, then z). */
  heights(): Float64Array {
    if (!this.host) throw wakeFailure('Add the wake to a world before reading its height grid.');
    return regionWords(this.host.memory, this.height) as Float64Array;
  }

  exportPorts(tick: number): readonly Port[] {
    const cell = this.host.cell;
    return [
      { field: WAKE_HEIGHT_FIELD.name, region: this.height, tick, cell },
      ...(this.breaking ? [{ field: this.breakingField!.name, region: this.breaking, tick, cell }] : []),
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.height, this.potential];
  }

  extraState(): readonly Region[] {
    const velocity = this.below ?? this.surfaceRise;
    return [this.previous, ...(velocity ? [velocity] : []), ...(this.breaking ? [this.breaking] : [])];
  }
}

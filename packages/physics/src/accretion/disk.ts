import { MargoError } from '@margoengine/math/errors';
import {
  canShareMemory,
  isRateLevel,
  isShared,
  regionWords,
  type FieldDescriptor,
  type FieldUse,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  BASE_RATE,
  MAX_MEMORY_PAGES,
  STACK_BYTES,
} from '../world/index.js';

const BYTES = Float64Array.BYTES_PER_ELEMENT;
const LAYOUT = 1;
const G = 6.6743e-11;
const STEFAN_BOLTZMANN = 5.670374419e-8;

/** A thin Newtonian disk around a central object. Each adjacent pair of edges bounds one annulus. */
export interface AccretionDiskParams {
  /** Mass of the central object, in kilograms. */
  readonly centralMass: number;
  /** Strictly increasing ring edges in metres, from the inner boundary outwards. */
  readonly edges: ArrayLike<number>;
  /** Surface density in kg/m², either uniform or one value per ring. Default zero. */
  readonly initialDensity?: number | ArrayLike<number>;
  /** Kinematic viscosity in m²/s, uniform or per ring. Zero freezes viscous transport. */
  readonly viscosity: number | ArrayLike<number>;
  /** Inner boundary. Default 'zero-torque', which accretes matter. */
  readonly innerBoundary?: 'zero-torque' | 'sealed';
  /** Outer boundary. Default 'sealed'. 'zero-torque' allows outflow. */
  readonly outerBoundary?: 'zero-torque' | 'sealed';
  /** Constant additional mass added to the outermost cell in kg/s. Default zero. */
  readonly feed?: number;
}

/** Optional world integration and cancellation of native asset loading. */
export interface AccretionDiskOptions {
  /** Unique solver id. Default 'accretionDisk'. */
  readonly id?: string;
  /** Preferred dyadic world rate level, default 0 (60 Hz). */
  readonly rate?: RateLevel;
  /** An optional layout-1 f64 scalar external feed in kg/s. It is added to the steady feed. */
  readonly feedField?: FieldDescriptor;
  /** Cancels loading the native modules. */
  readonly signal?: AbortSignal;
}

/**
 * One ring of an accretion disk: radius in metres, surface density in kg/m², angular velocity in rad/s, one-face
 * heating in W/m², effective temperature in K, orbital phase in radians and inward mass flow in kg/s.
 */
export interface AccretionRing {
  /** Cell-centre radius, in metres. */
  readonly radius: number;
  /** Surface density, in kg/m². */
  readonly density: number;
  /** Angular velocity in rad/s. */
  readonly angularVelocity: number;
  /** Emission into one face, in W/m², if local dissipation is radiated. */
  readonly heating: number;
  /** Blackbody effective temperature, in K, from the one-face flux. */
  readonly effectiveTemperature: number;
  /** Orbital phase in radians, wrapped to one revolution. */
  readonly phase: number;
  /** Inward mass flow across the ring's inner face, in kg/s. */
  readonly inwardFlow: number;
}

/**
 * Mass and energy accounting of an accretion disk: initial, supplied, accreted, escaped and remaining mass, and
 * the luminosity over both faces in W.
 */
export interface AccretionDiskBudget {
  readonly initialMass: number;
  readonly suppliedMass: number;
  readonly accretedMass: number;
  readonly escapedMass: number;
  readonly remainingMass: number;
  /** Luminosity integrated over both faces, in W. */
  readonly luminosity: number;
}

interface Kernel extends WebAssembly.Exports {
  readonly __stack_pointer: WebAssembly.Global;
  readonly accretion_step: (
    n: number,
    config: number,
    scratch: number,
    mass: number,
    density: number,
    heat: number,
    phase: number,
    flux: number,
    budget: number,
    dt: number,
    feed: number,
  ) => void;
}

interface DiskState {
  readonly host: SolverHost;
  readonly native: Kernel;
  readonly radii: Float64Array;
  readonly config: Region;
  readonly scratch: Region;
  readonly mass: Region;
  readonly density: Region;
  readonly heat: Region;
  readonly phase: Region;
  readonly flux: Region;
  readonly budget: Region;
  readonly initial: number;
  readonly feed: number;
  readonly massLimit: number;
}

function nonnegative(x: number, attribute: string): number {
  if (!(x >= 0 && Number.isFinite(x))) throw new RangeError(`Use a finite, nonnegative ${attribute} for the disk.`);
  return x;
}

function sample(value: number | ArrayLike<number>, i: number, n: number, attribute: string): number {
  if (typeof value !== 'number' && value.length !== n) throw new RangeError(`Pass one ${attribute} per annulus.`);
  return nonnegative(typeof value === 'number' ? value : value[i]!, attribute);
}

function boundary(value: AccretionDiskParams['innerBoundary']): boolean {
  if (value !== 'zero-torque' && value !== 'sealed') throw new RangeError('Use a sealed or zero-torque disk boundary.');
  return value === 'zero-torque';
}

function conductance(left: number, right: number): number {
  // 3π / (sqrt(right) - sqrt(left)), rationalized for thin cells.
  return 3 * Math.PI * ((Math.sqrt(right) + Math.sqrt(left)) / (right - left));
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'scalarSeries', quantity, unit, centring: 'cell' };
}

function words(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
    url.search = '';
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Accretion kernel HTTP ${response.status}. Use the Wasm asset shipped with this entry.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

function advance(s: DiskState, dt: number, feed: number): void {
  const available = words(s.host, s.budget);
  if (available[0]! + s.initial + dt * feed > s.massLimit)
    throw new RangeError(
      'The disk mass or feed exceeds the numeric range for this mesh. Reduce the mass or supply rate.',
    );
  s.native.accretion_step(
    s.radii.length,
    s.config.byteOffset,
    s.scratch.byteOffset,
    s.mass.byteOffset,
    s.density.byteOffset,
    s.heat.byteOffset,
    s.phase.byteOffset,
    s.flux.byteOffset,
    s.budget.byteOffset,
    dt,
    feed,
  );
}

/** Conservative finite-volume viscosity, Keplerian phase and local heating for a thin disk. */
export class AccretionDiskSolver implements Solver<AccretionDiskParams> {
  /** Layout-1 f64 surface mass density in kg/m², one element per ring. */
  readonly densityField: FieldDescriptor;
  /** Layout-1 f64 radiated flux into one face in W/m², one element per ring. */
  readonly heatingField: FieldDescriptor;
  /** Layout-1 f64 orbital phase in radians, one element per ring. */
  readonly phaseField: FieldDescriptor;
  #state?: DiskState;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    readonly id: string,
    private readonly rate: RateLevel,
    private readonly feedField?: FieldDescriptor,
  ) {
    if (!id || !isRateLevel(rate))
      throw new RangeError('Use a nonempty disk id and a world rate level from 0 through 7.');
    this.densityField = field(`${id}:density`, 'diskSurfaceMassDensity', 'kg/m²');
    this.heatingField = field(`${id}:heating`, 'diskRadiatedFlux', 'W/m²');
    this.phaseField = field(`${id}:phase`, 'diskOrbitalPhase', 'rad');
  }

  /** Loads the feature-local modules for supported world memory modes. */
  static async load({
    id = 'accretionDisk',
    rate = 0,
    feedField,
    signal,
  }: AccretionDiskOptions = {}): Promise<AccretionDiskSolver> {
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './accretion-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './accretion-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new AccretionDiskSolver(plain, shared, id, rate, feedField);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [this.densityField, this.heatingField, this.phaseField].map((field) => ({
      field,
      access: 'write',
    }));
    if (this.feedField) fields.push({ field: this.feedField, access: 'read' });
    return { id: this.id, fields, rate: this.rate, stableRate: () => this.rate };
  }

  init(host: SolverHost, params: AccretionDiskParams): void {
    if (this.#state) throw new MargoError('state', 'A disk can join one world. Load a new solver for a second world.');
    const { centralMass, edges, viscosity, initialDensity = 0, feed = 0 } = params;
    const n = edges.length - 1;
    if (!(Number.isSafeInteger(n) && n > 0 && (12 * n + 7) * BYTES < 65536 * MAX_MEMORY_PAGES))
      throw new RangeError('Use at least two ordered disk edges and a mesh that fits in Wasm memory.');
    if (!(centralMass > 0 && Number.isFinite(centralMass)))
      throw new RangeError('Pass a positive finite central mass in kilograms.');
    nonnegative(feed, 'feed');
    const configValues = new Float64Array(5 * n + 1);
    const masses = new Float64Array(n);
    const radii = new Float64Array(n);
    let total = 0;
    let scale = 1;
    for (let i = 0; i < n; i++) {
      const left = edges[i]!,
        right = edges[i + 1]!;
      if (!(left > 0 && right > left && Number.isFinite(right)))
        throw new RangeError('Use positive disk edges in strictly increasing order.');
      const radius = left + (right - left) * 0.5;
      const area = Math.PI * (right - left) * (right + left);
      const nu = sample(viscosity, i, n, 'kinematic viscosity');
      const omega = Math.sqrt((G * centralMass) / radius) / radius;
      const heat = (9 / 8) * (nu * omega) * omega;
      const inverse = 1 / area;
      const weight = nu * inverse * Math.sqrt(radius);
      radii[i] = radius;
      configValues[i] = weight;
      configValues[n + i] = inverse;
      configValues[2 * n + i] = omega;
      configValues[3 * n + i] = heat;
      masses[i] = area * sample(initialDensity, i, n, 'initial density');
      total += masses[i]!;
      if (!(inverse > 0 && Number.isFinite(omega + heat + weight + inverse + total)))
        throw new RangeError('The radius, density or viscosity exceeds the numeric range. Use smaller input values.');
      scale = Math.max(scale, heat, inverse, heat * inverse);
    }
    const face = 4 * n;
    configValues[face] = boundary(params.innerBoundary ?? 'zero-torque') ? conductance(edges[0]!, radii[0]!) : 0;
    for (let i = 1; i < n; i++) configValues[face + i] = conductance(radii[i - 1]!, radii[i]!);
    configValues[face + n] = boundary(params.outerBoundary ?? 'sealed') ? conductance(radii[n - 1]!, edges[n]!) : 0;
    for (let i = 0; i < n; i++) {
      const left = configValues[face + i]!,
        right = configValues[face + i + 1]!;
      const weight = configValues[i]!;
      const rank = (left + right) * weight;
      if (!Number.isFinite(rank + (left + right) / BASE_RATE))
        throw new RangeError('Adjacent disk edges are too close for their viscosity. Use a resolvable radial spacing.');
      scale = Math.max(scale, rank);
    }
    const massLimit = Number.MAX_VALUE / 16 / scale;
    if (!(total + feed / BASE_RATE <= massLimit))
      throw new RangeError('Reduce the initial disk mass or feed to fit the numeric range.');
    const built = isShared(host.memory) ? this.shared : this.plain;
    if (!built) throw new MargoError('unsupported', 'Use plain world memory if shared accretion Wasm is unavailable.');
    const native = new WebAssembly.Instance(built, { env: { memory: host.memory } }).exports as Kernel;
    const reserve = (name: string, count: number) => host.allocate(`accretion-${name}`, count * BYTES, 'f64', LAYOUT);
    const stack = host.allocate('accretion-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    native.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const state: DiskState = {
      host,
      native,
      radii,
      config: reserve('geometry', configValues.length),
      scratch: reserve('scratch', 2 * n),
      mass: reserve('mass', n),
      density: reserve('density', n),
      heat: reserve('heating', n),
      phase: reserve('phase', n),
      flux: reserve('face-flow', n + 1),
      budget: reserve('budget', 5),
      initial: total,
      feed,
      massLimit,
    };
    words(host, state.config).set(configValues);
    words(host, state.mass).set(masses);
    advance(state, 0, feed);
    this.#state = state;
  }

  step(context: StepContext, dt: number): void {
    const s = this.#live();
    let supply = s.feed;
    const input = this.feedField && context.inputs.get(this.feedField.name);
    if (input) {
      const r = input.region;
      if (r.layout !== LAYOUT || r.type !== 'f64' || r.byteLength !== BYTES)
        throw new RangeError('Use one layout-1 f64 outer supply rate in kg/s.');
      supply += nonnegative(words(s.host, r)[0]!, 'supplied mass rate');
    }
    advance(s, dt, nonnegative(supply, 'total supply rate'));
  }

  get ringCount(): number {
    return this.#live().radii.length;
  }

  /** Reads the live state of one annulus. */
  ring(index: number): AccretionRing {
    const s = this.#live();
    const n = s.radii.length;
    if (!Number.isInteger(index) || index < 0 || index >= n) throw new RangeError('Choose a valid disk ring index.');
    const heating = words(s.host, s.heat)[index]!;
    return {
      radius: s.radii[index]!,
      density: words(s.host, s.density)[index]!,
      angularVelocity: words(s.host, s.config)[2 * n + index]!,
      heating,
      effectiveTemperature: Math.sqrt(Math.sqrt(heating / STEFAN_BOLTZMANN)),
      phase: words(s.host, s.phase)[index]!,
      inwardFlow: words(s.host, s.flux)[index]!,
    };
  }

  budget(): AccretionDiskBudget {
    const s = this.#live();
    const values = words(s.host, s.budget);
    return {
      initialMass: s.initial,
      suppliedMass: values[0]!,
      accretedMass: values[1]!,
      escapedMass: values[2]!,
      remainingMass: values[3]!,
      luminosity: values[4]!,
    };
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.#live();
    return [
      { field: this.densityField.name, region: s.density, tick, cell: [0, 0, 0] },
      { field: this.heatingField.name, region: s.heat, tick, cell: [0, 0, 0] },
      { field: this.phaseField.name, region: s.phase, tick, cell: [0, 0, 0] },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const s = this.#live();
    return [s.mass, s.density, s.heat, s.phase, s.flux, s.budget];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #live(): DiskState {
    if (!this.#state)
      throw new MargoError('state', 'Add the accretion disk to a PhysicsWorld before reading its state.');
    return this.#state;
  }
}

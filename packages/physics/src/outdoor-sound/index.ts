import type { Vec3 } from '@margoengine/math';
import type { Bed, BedSample, FlowSample, Wind } from '@margoengine/math/fields';
import { cos, exp, hypot, ln } from '@margoengine/math/pinned';
import { MAX_MEMORY_PAGES, regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { soundError } from './errors.js';
import type { OutdoorSoundKernel, OutdoorSoundWorkCounts } from './kernel.js';
import { OUTDOOR_SOUND_BANDS, outdoorAirAbsorption, outdoorDiffractionLoss } from './model.js';

export type { OutdoorSoundWorkCounts, OutdoorSoundWorkerWork } from './kernel.js';
export { OUTDOOR_SOUND_BANDS, aviationNWave, outdoorAirAbsorption, outdoorDiffractionLoss } from './model.js';

/** Positions in metres, relative to the solver cell. Pose callbacks read world time in seconds. */
export interface OutdoorSoundLink {
  source: Vec3 | ((seconds: number) => Vec3);
  listener: Vec3 | ((seconds: number) => Vec3);
}

/** Settings for a world-stepped outdoor sound path. */
export interface OutdoorSoundParams {
  links: readonly OutdoorSoundLink[];
  /** Atmospheric wind, temperature and density. Default still, isothermal air at 293.15 K. */
  air?: Wind;
  /** Space outside the terrain view is assumed to be clear. Default no terrain. */
  bed?: Bed;
  /** Metres between origin cells. Pass the world's size when using a custom value. Default 4096. */
  cellSize?: number;
  /** Relative humidity, 0 to 1. Default 0.5. */
  humidity?: number;
  /** Pressure in Pa when no air field supplies density and temperature. Default 101325. */
  pressure?: number;
  /** Height in metres of a locally horizontal reflecting plane; default sampled at midpoint if a bed is set. */
  groundY?: number;
  /** Ground pressure reflection factor. Default 1 for a supplied ground; 0 disables interference. */
  groundReflection?: number;
  /** Reference distance for spherical spreading, metres. Default 1. */
  referenceDistance?: number;
  /** Integration intervals for wind, temperature and absorption. Terrain may request finer sampling. Default 24. */
  intervals?: number;
}

/** Solved path to a listener, ready for a per-source audio delay and equalizer. */
export interface OutdoorSoundReading {
  readonly delaySeconds: number;
  readonly distance: number;
  readonly blocked: boolean;
  readonly midpointY: number;
  /** Signed gain in dB at the eight centres of `OUTDOOR_SOUND_BANDS`. */
  readonly gainDb: Float64Array;
  /** Integrated atmospheric absorption in dB at the same centres. */
  readonly airLossDb: Float64Array;
  /** Estimated single-edge diffraction loss in dB at the same centres. */
  readonly diffractionDb: Float64Array;
}

/** First layout: [time, distance, blocked, midpoint Y, eight gains, eight air losses, eight diffraction losses]. */
export const OUTDOOR_SOUND_LAYOUT = 1;

const BANDS = OUTDOOR_SOUND_BANDS.length;
const HEADER = 4;
const STRIDE = HEADER + BANDS * 3;
const STANDARD_T = 293.15;
const GAS_R = 287.05;
const GAMMA_R = 1.4 * GAS_R;
const DB = 20 / ln(10);
const ZERO = [0, 0, 0] as const;
const TRACE_WORDS = 4;
const INTEGRATED_WORDS = 2 + BANDS;
const PLAN_WORDS = 5;
const MAX_TRACE_BYTES = MAX_MEMORY_PAGES * 65_536;

function derived(value: number, label: string): number {
  if (!Number.isFinite(value))
    throw soundError(
      'failed',
      'Outdoor sound ' + label + ' is unrepresentable. Reduce the path extent or use local cells.',
    );
  return value;
}

function lengthOf(x: number, y: number, z = 0): number {
  const ordinary = hypot(x, y, z);
  if (ordinary > 0 && Number.isFinite(ordinary)) return ordinary;
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (scale === 0) return 0;
  return derived(scale * hypot(x / scale, y / scale, z / scale), 'distance');
}

function midpoint(a: number, b: number): number {
  const sum = a + b;
  return Number.isFinite(sum) ? sum * 0.5 : a * 0.5 + b * 0.5;
}

function checkedOffset(own: number, remote: number, cellSize: number): number {
  if (!Number.isSafeInteger(remote))
    throw soundError('unsupported', 'A bed or air cell is invalid. Supply three signed integer coordinates.');
  return derived((own - remote) * cellSize, 'cell offset');
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value))
    throw soundError('unsupported', `Outdoor sound ${label} must be finite; pass a finite SI value.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0))
    throw soundError('unsupported', `Outdoor sound ${label} must be above zero; pass a positive SI value.`);
  return value;
}

function unitInterval(value: number, label: string): number {
  if (!(value >= 0 && value <= 1))
    throw soundError('unsupported', `Outdoor sound ${label} must be in 0..1; pass a fraction.`);
  return value;
}

/** Geometric acoustics with a locally linear effective sound speed, a coherent image source and one terrain edge. */
export class OutdoorSound implements Solver<OutdoorSoundParams> {
  readonly field: FieldDescriptor;
  private host!: SolverHost;
  private region!: Region;
  private cell: Cell = ZERO;
  private params!: OutdoorSoundParams;
  private readonly scratch: FlowSample = { velocity: [0, 0, 0], temperature: STANDARD_T, density: 1.2 };
  private readonly bedScratch: BedSample = { elevation: 0, normal: [0, 1, 0] };
  private readonly a: [number, number, number] = [0, 0, 0];
  private readonly b: [number, number, number] = [0, 0, 0];
  private readonly edge: [number, number, number] = [0, 0, 0];
  private readonly absorption = new Float64Array(BANDS);
  private readonly airOffset = [0, 0, 0];
  private readonly bedOffset = [0, 0, 0];
  private size = 4096;
  private humidity = 0.5;
  private pressure = 101325;
  private sampledTemperature = STANDARD_T;
  private sampledPressure = 101325;
  private sampledWind = 0;
  private reflection = 1;
  private reference = 1;
  private intervals = 24;
  private slotsPerLink = 0;
  private samples = new Float64Array(0);
  private firstCounts = new Uint32Array(0);
  private totalCounts = new Uint32Array(0);
  private plan = new Float64Array(0);
  private integrated = new Float64Array(0);
  private candidate = new Float64Array(0);
  private kernel: OutdoorSoundKernel | null = null;
  private acceptedWork: OutdoorSoundWorkCounts | undefined;

  /**
   * Loads the optional native octave integrator. One participant is the default. Two or four require Node
   * or a cross-origin-isolated browser worker. Pass a signal to cancel loading.
   */
  static async load({
    id,
    threads,
    signal,
  }: {
    readonly id?: string;
    readonly threads?: number;
    readonly signal?: AbortSignal;
  } = {}): Promise<OutdoorSound> {
    const { loadOutdoorKernel } = await import('./kernel.js');
    const solver = new OutdoorSound(id);
    solver.kernel = await loadOutdoorKernel({ threads, signal });
    return solver;
  }

  /** Actual native integration work for the last accepted tick. Undefined before the first native tick. */
  workCounts(): OutdoorSoundWorkCounts | undefined {
    return this.acceptedWork;
  }

  /** Releases this instance's native helper workers. */
  dispose(): void {
    this.kernel?.close();
    this.kernel = null;
  }

  constructor(readonly id = 'outdoorSound') {
    this.field = {
      name: `${id}:paths`,
      kind: 'particleSet',
      quantity: 'travel time, length, path clearance and octave responses',
      unit: 's, m, dB',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return { id: this.id, rate: 0, stableRate: () => 0, fields: [{ field: this.field, access: 'write' }] };
  }

  init(host: SolverHost, params: OutdoorSoundParams): void {
    if (!Array.isArray(params?.links) || params.links.length === 0)
      throw soundError('unsupported', 'Outdoor sound needs at least one link; supply a source and listener.');
    if (params.groundY !== undefined) finite(params.groundY, 'ground height');
    if (params.air !== undefined && typeof params.air?.sample !== 'function')
      throw soundError('unsupported', 'Outdoor sound air needs a wind sampler. Pass a Wind field or omit air.');
    if (params.bed !== undefined) {
      const bed = params.bed;
      if (
        !bed ||
        typeof bed.sample !== 'function' ||
        !Number.isFinite(bed.centre?.[0]) ||
        !Number.isFinite(bed.centre?.[1]) ||
        !(bed.width > 0 && Number.isFinite(bed.width) && bed.depth > 0 && Number.isFinite(bed.depth)) ||
        !(Number.isSafeInteger(bed.columns) && bed.columns > 0 && Number.isSafeInteger(bed.rows) && bed.rows > 0)
      )
        throw soundError(
          'unsupported',
          'Outdoor sound cannot scan this terrain. Pass a bed with positive finite extents and whole grid dimensions.',
        );
    }
    this.humidity = unitInterval(params.humidity ?? 0.5, 'humidity');
    this.reflection = unitInterval(params.groundReflection ?? 1, 'ground reflection');
    this.pressure = positive(params.pressure ?? 101325, 'pressure');
    this.size = positive(params.cellSize ?? 4096, 'cell size');
    this.reference = positive(params.referenceDistance ?? 1, 'reference distance');
    this.intervals = params.intervals ?? 24;
    if (!Number.isSafeInteger(this.intervals) || this.intervals < 2)
      throw soundError('unsupported', 'Outdoor sound needs at least two integration intervals; pass a whole number.');
    const count = params.links.length;
    this.slotsPerLink = 2 * this.intervals;
    const traceWords = count * this.slotsPerLink * TRACE_WORDS;
    if (!Number.isSafeInteger(traceWords) || traceWords * Float64Array.BYTES_PER_ELEMENT > MAX_TRACE_BYTES)
      throw soundError(
        'unsupported',
        'Outdoor trace samples exceed addressable scratch. Use fewer links or integration intervals.',
      );
    for (const link of params.links) {
      if (!link || typeof link !== 'object')
        throw soundError('unsupported', 'Outdoor sound link settings are invalid. Pass a source and a listener.');
      const { source, listener } = link;
      if (typeof source !== 'function') this.coordinates(source, 0, this.a);
      if (typeof listener !== 'function') this.coordinates(listener, 0, this.b);
    }
    this.params = {
      ...params,
      links: params.links.map((link) => ({
        source: typeof link.source === 'function' ? link.source : [...link.source],
        listener: typeof link.listener === 'function' ? link.listener : [...link.listener],
      })),
    };
    try {
      this.samples = new Float64Array(traceWords);
      this.plan = new Float64Array(count * PLAN_WORDS);
      this.firstCounts = new Uint32Array(count);
      this.totalCounts = new Uint32Array(count);
      this.integrated = new Float64Array(count * INTEGRATED_WORDS);
      this.candidate = new Float64Array(count * STRIDE);
    } catch (cause) {
      throw Object.assign(
        soundError('failed', 'Outdoor trace scratch could not be allocated. Reduce links or intervals.'),
        { cause },
      );
    }
    this.region = host.allocate('outdoor-paths', count * STRIDE * 8, 'f64', OUTDOOR_SOUND_LAYOUT);
    this.host = host;
    this.cell = host.cell;
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.region) as Float64Array;
  }

  private coordinates(pose: OutdoorSoundLink['source'], t: number, into: [number, number, number]): void {
    const value = typeof pose === 'function' ? pose(t) : pose;
    if (value?.length !== 3)
      throw soundError('unsupported', 'Outdoor sound positions need three coordinates; pass an xyz vector.');
    for (let axis = 0; axis < 3; axis++) into[axis] = finite(value[axis]!, 'position');
  }

  private ground(x: number, z: number): number | undefined {
    const { bed, groundY } = this.params;
    if (!bed) return groundY;
    const bx = x + this.bedOffset[0]!,
      bz = z + this.bedOffset[2]!;
    derived(bx, 'terrain sample x');
    derived(bz, 'terrain sample z');
    if (Math.abs(bx - bed.centre[0]) > bed.width / 2 || Math.abs(bz - bed.centre[1]) > bed.depth / 2) return groundY;
    const sample = bed.sample(bx, bz, this.bedScratch);
    return derived(sample?.elevation - this.bedOffset[1]!, 'terrain elevation');
  }

  private sample(x: number, y: number, z: number, t: number, dx: number, dy: number, dz: number): number {
    const { air } = this.params;
    const value = air?.sample(
      derived(x + this.airOffset[0]!, 'wind sample x'),
      derived(y + this.airOffset[1]!, 'wind sample y'),
      derived(z + this.airOffset[2]!, 'wind sample z'),
      t,
      this.scratch,
    );
    if (air && (!value || value.velocity?.length !== 3 || !value.velocity.every(Number.isFinite)))
      throw soundError(
        'unsupported',
        'The wind returned an invalid acoustic sample. Return three finite velocity components.',
      );
    this.sampledTemperature = value ? positive(value.temperature, 'air temperature') : STANDARD_T;
    this.sampledPressure = value
      ? positive(positive(value.density, 'air density') * GAS_R * this.sampledTemperature, 'air pressure')
      : this.pressure;
    this.sampledWind = value ? value.velocity[0] * dx + value.velocity[1] * dy + value.velocity[2] * dz : 0;
    const speed = Math.sqrt(GAMMA_R * this.sampledTemperature) + this.sampledWind;
    if (!(speed > 0 && Number.isFinite(speed)))
      throw soundError(
        'failed',
        'Effective sound speed must be finite and positive. Reduce opposing wind or correct the air temperature.',
      );
    return speed;
  }

  private stageTrace(from: Vec3, to: Vec3, bow: number, time: number, at: number): number {
    const dx = to[0] - from[0],
      dy = to[1] - from[1],
      dz = to[2] - from[2];
    for (let i = 0; i < this.intervals; i++) {
      const t = (i + 0.5) / this.intervals;
      const rise = dy + bow * (1 - 2 * t);
      const segment = lengthOf(dx, rise, dz);
      if (segment === 0) continue;
      const speed = this.sample(
        from[0] + dx * t,
        from[1] + dy * t + bow * t * (1 - t),
        from[2] + dz * t,
        time,
        dx / segment,
        rise / segment,
        dz / segment,
      );
      this.samples[at++] = segment / this.intervals;
      this.samples[at++] = speed;
      this.samples[at++] = this.sampledTemperature;
      this.samples[at++] = this.sampledPressure;
    }
    return at;
  }

  private integrateScalar(): Float64Array {
    const out = this.integrated;
    out.fill(0);
    let cachedTemperature = NaN;
    let cachedPressure = NaN;
    for (let row = 0; row < this.totalCounts.length; row++) {
      const at = row * INTEGRATED_WORDS;
      const start = row * this.slotsPerLink * TRACE_WORDS;
      const firstEnd = this.firstCounts[row]!;
      const total = this.totalCounts[row]!;
      let length = 0;
      let delay = 0;
      for (let i = 0; i < total; i++) {
        if (i === firstEnd) {
          out[at] = length;
          out[at + 1] = delay;
          length = 0;
          delay = 0;
        }
        const sample = start + i * TRACE_WORDS;
        const distance = this.samples[sample]!;
        const speed = this.samples[sample + 1]!;
        const temperature = this.samples[sample + 2]!;
        const pressure = this.samples[sample + 3]!;
        if (temperature !== cachedTemperature || pressure !== cachedPressure) {
          for (let band = 0; band < BANDS; band++)
            this.absorption[band] = outdoorAirAbsorption(
              OUTDOOR_SOUND_BANDS[band]!,
              temperature,
              this.humidity,
              pressure,
            );
          cachedTemperature = temperature;
          cachedPressure = pressure;
        }
        for (let band = 0; band < BANDS; band++) out[at + 2 + band]! += distance * this.absorption[band]!;
        delay += distance / speed;
        length += distance;
      }
      out[at]! += length;
      out[at + 1]! += delay;
    }
    return out;
  }

  private terrainClearance(a: Vec3, b: Vec3, bow: number, horizontal: number): number {
    const { bed, groundY } = this.params;
    if (!bed) return -Infinity;
    const spacing = Math.min(bed.width / bed.columns, bed.depth / bed.rows) * 0.5;
    const scans = Math.max(this.intervals, Math.ceil(horizontal / spacing));
    if (!Number.isSafeInteger(scans))
      throw soundError(
        'failed',
        'Terrain scan indices are unrepresentable. Use a coarser bed or a shorter local path.',
      );
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    let first = 1,
      last = scans - 1;
    // Skip samples outside a finite bed when the rest of the path is clear. The original sample lattice stays fixed.
    if (groundY === undefined) {
      const deltas = [dx, dz];
      const sides = [bed.width, bed.depth];
      for (let axis = 0; axis < 2; axis++) {
        const worldAxis = 2 * axis;
        const centre = bed.centre[axis]!;
        const half = sides[axis]! * 0.5;
        const local = derived(a[worldAxis]! + this.bedOffset[worldAxis]! - centre, 'bed-relative start');
        const delta = deltas[axis]!;
        if (delta === 0) {
          if (Math.abs(local) > half) return -Infinity;
          continue;
        }
        const enter = (-half - local) / delta,
          exit = (half - local) / delta;
        first = Math.max(first, Math.floor(Math.min(enter, exit) * scans));
        last = Math.min(last, Math.ceil(Math.max(enter, exit) * scans));
      }
    }
    let clearance = -Infinity;
    for (let i = first; i <= last; i++) {
      const t = i / scans;
      const x = a[0] + t * dx,
        z = a[2] + t * dz;
      const y = this.ground(x, z);
      if (y === undefined) continue;
      const height = derived((y - (a[1] + t * dy + bow * t * (1 - t))) / Math.sqrt(t * (1 - t)), 'Fresnel clearance');
      if (height > clearance) {
        clearance = height;
        this.edge[0] = x;
        this.edge[1] = y;
        this.edge[2] = z;
      }
    }
    return clearance;
  }

  private planLinks(cell: Cell, time: number): void {
    const { air, bed, groundY, links } = this.params;
    for (let axis = 0; axis < 3; axis++) {
      this.airOffset[axis] = air ? checkedOffset(cell[axis]!, (air.cell ?? ZERO)[axis]!, this.size) : 0;
      this.bedOffset[axis] = bed ? checkedOffset(cell[axis]!, (bed.cell ?? ZERO)[axis]!, this.size) : 0;
    }
    for (let row = 0; row < links.length; row++) {
      const { source, listener } = links[row]!;
      const a = this.a,
        b = this.b;
      this.coordinates(source, time, a);
      this.coordinates(listener, time, b);
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        dz = b[2] - a[2];
      const horizontal = lengthOf(dx, dz);
      const chord = lengthOf(dx, dy, dz);
      const mx = midpoint(a[0], b[0]),
        my = midpoint(a[1], b[1]),
        mz = midpoint(a[2], b[2]);
      const ux = horizontal > 0 ? dx / horizontal : 0,
        uz = horizontal > 0 ? dz / horizontal : 0;
      const speed = this.sample(mx, my, mz, time, ux, 0, uz);
      let gradient = 0;
      if (air && horizontal > 0) {
        this.sample(mx, my + 0.5, mz, time, ux, 0, uz);
        const upperTemperature = this.sampledTemperature,
          upperWind = this.sampledWind;
        this.sample(mx, my - 0.5, mz, time, ux, 0, uz);
        const lowerTemperature = this.sampledTemperature;
        gradient =
          (GAMMA_R * (upperTemperature - lowerTemperature)) /
            (Math.sqrt(GAMMA_R * upperTemperature) + Math.sqrt(GAMMA_R * lowerTemperature)) +
          (upperWind - this.sampledWind);
      }
      // Paraxial ray equation y'' = -c'/c, with both endpoints fixed.
      const bow = derived((gradient * horizontal * horizontal) / (2 * speed), 'refraction bow');
      const clearance = this.terrainClearance(a, b, bow, horizontal);
      const blocked = clearance > 0;
      const sampleStart = row * this.slotsPerLink * TRACE_WORDS;
      const firstEnd = blocked
        ? this.stageTrace(a, this.edge, 0, time, sampleStart)
        : this.stageTrace(a, b, bow, time, sampleStart);
      const finalEnd = blocked ? this.stageTrace(this.edge, b, 0, time, firstEnd) : firstEnd;
      this.firstCounts[row] = (firstEnd - sampleStart) / TRACE_WORDS;
      this.totalCounts[row] = (finalEnd - sampleStart) / TRACE_WORDS;
      const ground = groundY ?? this.ground(mx, mz);
      const extraLength =
        !blocked && ground !== undefined && a[1] >= ground && b[1] >= ground && chord > 0
          ? this.reflectionLength(a, b, ground, chord, horizontal)
          : -1;
      this.plan.set([speed, clearance, derived(my + bow * 0.25, 'ray midpoint'), chord, extraLength], row * PLAN_WORDS);
    }
  }

  private reflectionLength(a: Vec3, b: Vec3, ground: number, chord: number, horizontal: number): number {
    if (this.reflection === 0) return -1;
    const heightA = a[1] - ground,
      heightB = b[1] - ground;
    const height = derived(heightA + heightB, 'image height');
    if (this.params.bed) {
      const fraction = height > 0 ? heightA / height : 0.5;
      const bounce: Vec3 = [a[0] + fraction * (b[0] - a[0]), ground, a[2] + fraction * (b[2] - a[2])];
      // A clear direct ray does not guarantee either leg of the specular path is clear.
      if (
        this.terrainClearance(a, bounce, 0, horizontal * fraction) > 0 ||
        this.terrainClearance(bounce, b, 0, horizontal * (1 - fraction)) > 0
      )
        return -1;
    }
    const reflected = lengthOf(b[0] - a[0], height, b[2] - a[2]);
    // Rationalize the path difference to retain small delays at long ranges.
    const numerator = 4 * heightA * heightB,
      denominator = reflected + chord;
    if (Number.isFinite(numerator) && Number.isFinite(denominator)) return numerator / denominator;
    return derived((4 * ((heightA / reflected) * heightB)) / (1 + chord / reflected), 'reflected path difference');
  }

  private finishLinks(results: Float64Array): void {
    const words = this.candidate;
    for (let row = 0; row < this.totalCounts.length; row++) {
      const out = row * STRIDE,
        plan = row * PLAN_WORDS,
        offset = row * INTEGRATED_WORDS;
      const speed = this.plan[plan]!,
        clearance = this.plan[plan + 1]!;
      const chord = this.plan[plan + 3]!,
        extraLength = this.plan[plan + 4]!;
      const distance = derived(results[offset]!, 'integrated length');
      const ratio = this.reference / Math.max(distance, this.reference);
      const baseGain = DB * (ratio > 0 ? ln(ratio) : ln(this.reference) - ln(distance));
      words[out] = derived(results[offset + 1]!, 'travel time');
      words[out + 1] = distance;
      words[out + 2] = Number(clearance > 0);
      words[out + 3] = this.plan[plan + 2]!;
      for (let band = 0; band < BANDS; band++) {
        const frequency = OUTDOOR_SOUND_BANDS[band]!;
        const airLoss = derived(results[offset + 2 + band]!, 'integrated air loss');
        const diffraction =
          chord > 0 && Number.isFinite(clearance)
            ? outdoorDiffractionLoss(clearance * Math.sqrt((2 * frequency) / (chord * speed)))
            : 0;
        let imageGain = 0;
        if (extraLength >= 0 && distance > 0 && this.reflection > 0) {
          const image =
            this.reflection * (distance / (distance + extraLength)) * exp((-airLoss * extraLength) / (distance * DB));
          const phase = derived((2 * Math.PI * frequency * extraLength) / speed, 'reflected phase');
          const difference = 1 - image;
          const power = difference * difference + 2 * image * (1 + cos(phase));
          // Around an exact notch, the half-angle avoids losing the residual to rounding in cos(phase).
          const half = power === 0 ? cos(phase * 0.5) : 0;
          imageGain = (DB / 2) * ln(power || 4 * image * half * half);
        }
        words[out + HEADER + band] = derived(baseGain + imageGain - airLoss - diffraction, 'path gain');
        words[out + HEADER + BANDS + band] = airLoss;
        words[out + HEADER + BANDS * 2 + band] = diffraction;
      }
    }
  }

  step(context: StepContext, dt: number): void {
    this.planLinks(context.cell, (context.tick + 1) * dt);
    const kernel = this.kernel;
    const results = kernel
      ? kernel.integrate(this.samples, this.firstCounts, this.totalCounts, this.slotsPerLink, this.humidity)
      : this.integrateScalar();
    this.finishLinks(results);
    this.words().set(this.candidate);
    this.cell = context.cell;
    this.acceptedWork = kernel?.workCounts();
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.field.name, region: this.region, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.region];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Copies one link's delay and spectral response from the arena. */
  read(index = 0): OutdoorSoundReading {
    if (!this.host)
      throw soundError(
        'state',
        'Outdoor sound is not in a world. Add the solver with source and listener links first.',
      );
    if (!Number.isInteger(index) || index < 0 || index >= this.params.links.length)
      throw soundError('unsupported', 'Outdoor sound link does not exist; pass a configured link index.');
    const words = this.words(),
      at = index * STRIDE,
      bands = at + HEADER;
    return {
      delaySeconds: words[at]!,
      distance: words[at + 1]!,
      blocked: words[at + 2] !== 0,
      midpointY: words[at + 3]!,
      gainDb: words.slice(bands, bands + BANDS),
      airLossDb: words.slice(bands + BANDS, bands + BANDS * 2),
      diffractionDb: words.slice(bands + BANDS * 2, bands + BANDS * 3),
    };
  }
}

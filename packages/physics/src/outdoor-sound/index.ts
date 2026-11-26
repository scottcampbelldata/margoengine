import type { Vec3 } from '@margoengine/math';
import type { Bed, BedSample, FlowSample, Wind } from '@margoengine/math/fields';
import { cos, exp, hypot, ln } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
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
import { OUTDOOR_SOUND_BANDS, outdoorAirAbsorption, outdoorDiffractionLoss } from './model.js';

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

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Outdoor sound ${label} must be finite; pass a finite SI value.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!(finite(value, label) > 0))
    throw new RangeError(`Outdoor sound ${label} must be above zero; pass a positive SI value.`);
  return value;
}

function unitInterval(value: number, label: string): number {
  if (!(value >= 0 && value <= 1)) throw new RangeError(`Outdoor sound ${label} must be in 0..1; pass a fraction.`);
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
  private readonly loss = new Float64Array(BANDS);
  private readonly absorption = new Float64Array(BANDS);
  private readonly airOffset = [0, 0, 0];
  private readonly bedOffset = [0, 0, 0];
  private size = 4096;
  private humidity = 0.5;
  private pressure = 101325;
  private sampledTemperature = STANDARD_T;
  private sampledPressure = 101325;
  private sampledWind = 0;
  private absorptionTemperature = NaN;
  private absorptionPressure = NaN;
  private reflection = 1;
  private reference = 1;
  private intervals = 24;

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
    if (!params?.links.length)
      throw new RangeError('Outdoor sound needs at least one link; supply a source and listener.');
    if (params.groundY !== undefined) finite(params.groundY, 'ground height');
    this.humidity = unitInterval(params.humidity ?? 0.5, 'humidity');
    this.reflection = unitInterval(params.groundReflection ?? 1, 'ground reflection');
    this.pressure = positive(params.pressure ?? 101325, 'pressure');
    this.size = positive(params.cellSize ?? 4096, 'cell size');
    this.reference = positive(params.referenceDistance ?? 1, 'reference distance');
    this.intervals = params.intervals ?? 24;
    if (!Number.isInteger(this.intervals) || this.intervals < 2)
      throw new RangeError('Outdoor sound needs at least two integration intervals; pass a whole number.');
    for (const { source, listener } of params.links) {
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
    this.host = host;
    this.region = host.allocate('outdoor-paths', params.links.length * STRIDE * 8, 'f64', OUTDOOR_SOUND_LAYOUT);
  }

  private words(): Float64Array {
    return regionWords(this.host.memory, this.region) as Float64Array;
  }

  private coordinates(pose: OutdoorSoundLink['source'], t: number, into: [number, number, number]): void {
    const value = typeof pose === 'function' ? pose(t) : pose;
    if (value.length !== 3) throw new RangeError('Outdoor sound positions need three coordinates; pass an xyz vector.');
    for (let axis = 0; axis < 3; axis++) into[axis] = finite(value[axis]!, 'position');
  }

  private ground(x: number, z: number): number | undefined {
    const { bed, groundY } = this.params;
    if (!bed) return groundY;
    const bx = x + this.bedOffset[0]!,
      bz = z + this.bedOffset[2]!;
    if (Math.abs(bx - bed.centre[0]) > bed.width / 2 || Math.abs(bz - bed.centre[1]) > bed.depth / 2) return groundY;
    return bed.sample(bx, bz, this.bedScratch).elevation - this.bedOffset[1]!;
  }

  private sample(x: number, y: number, z: number, t: number, dx: number, dy: number, dz: number): number {
    const { air } = this.params;
    const value = air?.sample(x + this.airOffset[0]!, y + this.airOffset[1]!, z + this.airOffset[2]!, t, this.scratch);
    this.sampledTemperature = value ? positive(value.temperature, 'air temperature') : STANDARD_T;
    this.sampledPressure = value ? value.density * GAS_R * this.sampledTemperature : this.pressure;
    this.sampledWind = value ? value.velocity[0] * dx + value.velocity[1] * dy + value.velocity[2] * dz : 0;
    const speed = Math.sqrt(GAMMA_R * this.sampledTemperature) + this.sampledWind;
    return positive(speed, 'effective sound speed');
  }

  private trace(from: Vec3, to: Vec3, bow: number, time: number): [length: number, delay: number] {
    const dx = to[0] - from[0],
      dy = to[1] - from[1],
      dz = to[2] - from[2];
    let delay = 0,
      length = 0;
    for (let i = 0; i < this.intervals; i++) {
      const s = (i + 0.5) / this.intervals;
      const rise = dy + bow * (1 - 2 * s);
      const segment = hypot(dx, rise, dz);
      if (segment === 0) continue;
      const distance = segment / this.intervals;
      const speed = this.sample(
        from[0] + dx * s,
        from[1] + dy * s + bow * s * (1 - s),
        from[2] + dz * s,
        time,
        dx / segment,
        rise / segment,
        dz / segment,
      );
      if (this.sampledTemperature !== this.absorptionTemperature || this.sampledPressure !== this.absorptionPressure) {
        for (let band = 0; band < BANDS; band++) {
          this.absorption[band] = outdoorAirAbsorption(
            OUTDOOR_SOUND_BANDS[band]!,
            this.sampledTemperature,
            this.humidity,
            this.sampledPressure,
          );
        }
        this.absorptionTemperature = this.sampledTemperature;
        this.absorptionPressure = this.sampledPressure;
      }
      for (let band = 0; band < BANDS; band++) this.loss[band]! += distance * this.absorption[band]!;
      delay += distance / speed;
      length += distance;
    }
    return [length, delay];
  }

  private solveLinks(time: number): void {
    const words = this.words();
    const { bed, air, groundY, links } = this.params;
    for (let axis = 0; axis < 3; axis++) {
      this.airOffset[axis] = (this.cell[axis]! - (air?.cell ?? ZERO)[axis]!) * this.size;
      this.bedOffset[axis] = (this.cell[axis]! - (bed?.cell ?? ZERO)[axis]!) * this.size;
    }
    for (let row = 0; row < links.length; row++) {
      const { source, listener } = links[row]!,
        a = this.a,
        b = this.b;
      this.coordinates(source, time, a);
      this.coordinates(listener, time, b);
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        dz = b[2] - a[2];
      const horizontal = hypot(dx, dz),
        mx = (a[0] + b[0]) * 0.5,
        my = (a[1] + b[1]) * 0.5,
        mz = (a[2] + b[2]) * 0.5;
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
      const bow = (gradient * horizontal * horizontal) / (2 * speed);
      const spacing = bed ? Math.min(bed.width / bed.columns, bed.depth / bed.rows) * 0.5 : Infinity;
      const scans = Math.max(this.intervals, Math.ceil(horizontal / spacing));
      let clearance = -Infinity;
      if (bed) {
        for (let i = 1; i < scans; i++) {
          const s = i / scans,
            x = a[0] + s * dx,
            z = a[2] + s * dz;
          const y = this.ground(x, z);
          if (y === undefined) continue;
          const scaledHeight = (y - (a[1] + s * dy + bow * s * (1 - s))) / Math.sqrt(s * (1 - s));
          if (scaledHeight > clearance) {
            clearance = scaledHeight;
            this.edge[0] = x;
            this.edge[1] = y;
            this.edge[2] = z;
          }
        }
      }
      this.loss.fill(0);
      const blocked = clearance > 0;
      let distance: number, travel: number;
      if (blocked) {
        const first = this.trace(a, this.edge, 0, time),
          second = this.trace(this.edge, b, 0, time);
        distance = first[0] + second[0];
        travel = first[1] + second[1];
      } else {
        [distance, travel] = this.trace(a, b, bow, time);
      }
      const at = STRIDE * row,
        chord = hypot(dx, dy, dz);
      const baseGain = DB * ln(Math.min(1, this.reference / Math.max(distance, this.reference)));
      const ground = groundY ?? this.ground(mx, mz);
      let reflectedDistance: number | undefined;
      let extraLength = 0;
      if (!blocked && ground !== undefined && a[1] >= ground && b[1] >= ground && distance > 0) {
        const heightA = a[1] - ground,
          heightB = b[1] - ground;
        reflectedDistance = hypot(dx, heightA + heightB, dz);
        // Rationalize the path difference to retain small delays at long ranges.
        extraLength = (4 * heightA * heightB) / (reflectedDistance + chord);
      }
      words[at] = travel;
      words[at + 1] = distance;
      words[at + 2] = Number(blocked);
      words[at + 3] = my + bow * 0.25;
      for (let band = 0; band < BANDS; band++) {
        const frequency = OUTDOOR_SOUND_BANDS[band]!,
          airLoss = this.loss[band]!;
        const diffraction =
          chord > 0 && Number.isFinite(clearance)
            ? outdoorDiffractionLoss(clearance * Math.sqrt((2 * frequency) / (chord * speed)))
            : 0;
        let imageGain = 0;
        if (reflectedDistance !== undefined && this.reflection > 0) {
          const image =
            this.reflection * (distance / (distance + extraLength)) * exp((-airLoss * extraLength) / (distance * DB));
          const phase = (2 * Math.PI * frequency * extraLength) / speed;
          imageGain = (DB / 2) * ln((1 - image) * (1 - image) + 2 * image * (1 + cos(phase)));
        }
        words[at + HEADER + band] = baseGain + imageGain - airLoss - diffraction;
        words[at + HEADER + BANDS + band] = airLoss;
        words[at + HEADER + BANDS * 2 + band] = diffraction;
      }
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    this.solveLinks((context.tick + 1) * dt);
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
    if (!Number.isInteger(index) || index < 0 || index >= this.params.links.length)
      throw new RangeError('Outdoor sound link does not exist; pass a configured link index.');
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

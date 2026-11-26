import { sin } from '@margoengine/math/pinned';
import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import {
  CAR_WORDS,
  DISTANCE,
  HEIGHT,
  PITCH,
  ROOF_LATERAL,
  ROOF_REACTION,
  ROLL,
  SPEED,
  SWAY,
  SWAY_SPEED,
  type Car,
} from './car.js';
import { railNumber } from './contact.js';
import type { WireKernel } from './kernel.js';
import type { RailRoute } from './track.js';

export interface PantographSpec {
  readonly car: number;
  readonly roofOffset?: number;
  readonly restHeight?: number;
  readonly mass?: number;
  readonly uplift?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  readonly contactStiffness?: number;
  readonly headHalfWidth?: number;
  readonly shoeFriction?: number;
  readonly energized?: boolean;
  readonly visualGap?: number;
  readonly visualArcTime?: number;
}

export interface RailWireSpec {
  readonly track: RailRoute;
  readonly spanLength?: number;
  readonly nodesPerSpan?: number;
  readonly supportHeight?: number;
  readonly stagger?: number;
  readonly tension?: number;
  readonly density?: number;
  readonly damping?: number;
  readonly pantographs: readonly PantographSpec[];
}

export interface RailWireReading {
  readonly height: number;
  readonly lateralOffset: number;
  readonly verticalSpeed: number;
}

export interface PantographReading {
  readonly arclength: number;
  readonly headHeight: number;
  readonly contactForce: number;
  readonly gap: number;
  readonly inContact: boolean;
  readonly arc: boolean;
}

interface Collector extends Required<PantographSpec> {}
type RailWire = {
  readonly host: SolverHost;
  readonly region: Region;
  readonly loading: Region;
  readonly kernel: WireKernel;
  readonly track: RailRoute;
  readonly pantographs: readonly Collector[];
  readonly spanLength: number;
  readonly intervals: number;
  readonly supportHeight: number;
  readonly stagger: number;
  readonly spacing: number;
  readonly nodes: number;
  readonly inverseMass: number;
  readonly c2: number;
  readonly damping: number;
  readonly sag: number;
  readonly frequency: number;
};
export type Wire = RailWire;

const WORD_BYTES = Float64Array.BYTES_PER_ELEMENT;
const COLLECTOR_WORDS = 7;
const pos = (n: number, what: string) => railNumber(n, what, Number.MIN_VALUE);

function collectorOf(spec: PantographSpec, cars: readonly Car[], track: RailRoute): Collector {
  if (!Number.isSafeInteger(spec.car) || cars[spec.car]?.track !== track)
    throw new MargoError('state', 'Choose a pantograph car on the same surveyed route as its wire.');
  return {
    car: spec.car,
    roofOffset: railNumber(spec.roofOffset ?? 0, 'pantograph roof position'),
    restHeight: pos(spec.restHeight ?? 4.1, 'pantograph head height above carbody centre'),
    uplift: railNumber(spec.uplift ?? 95, 'pantograph uplift', 0),
    mass: pos(spec.mass ?? 8, 'pantograph head mass'),
    stiffness: pos(spec.stiffness ?? 2300, 'pantograph stiffness'),
    damping: railNumber(spec.damping ?? 55, 'pantograph damping', 0),
    contactStiffness: pos(spec.contactStiffness ?? 26000, 'pantograph contact stiffness'),
    headHalfWidth: pos(spec.headHalfWidth ?? 0.5, 'pantograph shoe half width'),
    shoeFriction: railNumber(spec.shoeFriction ?? 0.15, 'pantograph shoe friction', 0, 1),
    energized: spec.energized ?? false,
    visualGap: railNumber(spec.visualGap ?? 0.012, 'visual spark separation threshold', 0),
    visualArcTime: railNumber(spec.visualArcTime ?? 1 / 60, 'visual arc pulse duration seconds', 0),
  };
}

export function makeWire(host: SolverHost, spec: RailWireSpec, cars: readonly Car[], kernel: WireKernel): Wire {
  const length = pos(spec.spanLength ?? 32, 'wire span length');
  const spans = Math.ceil(spec.track.length / length); // float division: number of fixed anchor intervals
  const intervals = railNumber(spec.nodesPerSpan ?? 12, 'wire subdivisions per span', 2);
  if (!Number.isSafeInteger(intervals))
    throw new MargoError('state', 'Choose a whole number of wire subdivisions per span.');
  const nodes = spans * intervals + 1;
  const spacing = length / intervals; // float division: wire spacing
  const tension = pos(spec.tension ?? 12500, 'wire tension');
  const density = pos(spec.density ?? 1.05, 'wire mass per metre');
  const damping = railNumber(spec.damping ?? 1, 'wire damping', 0);
  const pantographs = spec.pantographs.map((p) => collectorOf(p, cars, spec.track));
  if (new Set(pantographs.map((collector) => collector.car)).size !== pantographs.length)
    throw new MargoError('state', 'Use one pantograph head per rail car.');
  const inverseMass = 1 / (density * spacing); // float division: mass per wire node
  const c2 = tension / (density * spacing * spacing); // float division: tensioned-string finite difference
  const frequency = pantographs.reduce(
    (max, p) => Math.max(max, Math.sqrt((p.stiffness + p.contactStiffness) / p.mass), p.damping / p.mass), // float division: collector natural frequency and damping
    Math.max(2 * Math.sqrt(c2), damping),
  );
  const region = host.allocate('wire', (nodes * 4 + COLLECTOR_WORDS * pantographs.length) * WORD_BYTES, 'f64', 1);
  const loading = host.allocate('wire-forces', nodes * 2 * WORD_BYTES, 'f64', 1);
  const words = regionWords(host.memory, region) as Float64Array;
  for (let i = 0; i < pantographs.length; i++) words[nodes * 4 + COLLECTOR_WORDS * i] = pantographs[i]!.restHeight;
  return {
    host,
    kernel,
    track: spec.track,
    region,
    loading,
    pantographs,
    intervals,
    spacing,
    nodes,
    inverseMass,
    c2,
    damping,
    frequency,
    spanLength: length,
    sag: (-density * host.gravity[1] * length * length) / (8 * tension), // float division: parabolic static string sag
    supportHeight: pos(spec.supportHeight ?? 5.1, 'wire support height above track'),
    stagger: railNumber(spec.stagger ?? 0.1, 'alternating lateral wire stagger', 0),
  };
}

function locate(wire: Wire, arclength: number) {
  const coordinate = Math.max(0, Math.min(wire.nodes - 1, arclength / wire.spacing)); // float division: mesh coordinate
  const left = Math.min(wire.nodes - 2, Math.floor(coordinate));
  return { left, fraction: coordinate - left };
}

function readAt(wire: Wire, words: Float64Array, arclength: number, left: number, fraction: number): RailWireReading {
  const distance = Math.max(0, arclength);
  const span = Math.floor(distance / wire.spanLength); // float division: containing span
  const within = distance / wire.spanLength - span; // float division: fractional station in a span
  const stagger = (span % 2 ? -1 : 1) * wire.stagger * (1 - 2 * within);
  const lerpWord = (n: number) => words[n]! + fraction * (words[n + 2]! - words[n]!);
  return {
    height:
      wire.track.sample(arclength).centre[1] +
      wire.supportHeight -
      4 * wire.sag * within * (1 - within) +
      lerpWord(2 * left + 1),
    lateralOffset: stagger + lerpWord(2 * left),
    verticalSpeed: lerpWord(2 * wire.nodes + 2 * left + 1),
  };
}

export function readWire(wire: Wire, arclength: number): RailWireReading {
  railNumber(arclength, 'wire station', 0, wire.track.length);
  const { left, fraction } = locate(wire, arclength);
  return readAt(wire, regionWords(wire.host.memory, wire.region) as Float64Array, arclength, left, fraction);
}

export function readPantograph(wire: Wire, index: number): PantographReading {
  if (!Number.isSafeInteger(index) || !wire.pantographs[index])
    throw new MargoError('state', 'Choose a configured rail pantograph index.');
  const a = wire.nodes * 4 + COLLECTOR_WORDS * index;
  const w = regionWords(wire.host.memory, wire.region) as Float64Array;
  return {
    arclength: w[a + 2]!,
    headHeight: w[a + 3]!,
    contactForce: w[a + 4]!,
    gap: w[a + 5]!,
    inContact: w[a + 4]! > 0,
    arc: w[a + 6]! > 0,
  };
}

export function stepWire(wire: Wire, cars: readonly Car[], carsRegion: Region, dt: number): void {
  const words = regionWords(wire.host.memory, wire.region) as Float64Array;
  const loading = regionWords(wire.host.memory, wire.loading) as Float64Array;
  const carsState = regionWords(wire.host.memory, carsRegion) as Float64Array;
  loading.fill(0);
  for (let i = 0; i < wire.pantographs.length; i++) {
    const p = wire.pantographs[i]!;
    const car = cars[p.car]!;
    const row = carsState.subarray(p.car * CAR_WORDS, (p.car + 1) * CAR_WORDS);
    const a = 4 * wire.nodes + i * COLLECTOR_WORDS;
    const arclength = row[DISTANCE]! + p.roofOffset;
    const track = car.track.sample(arclength);
    const { left, fraction } = locate(wire, arclength);
    const where = readAt(wire, words, arclength, left, fraction);
    const centre = car.track.sample(row[DISTANCE]!);
    const y0 =
      centre.centre[1] +
      (car.centreHeight + row[HEIGHT]!) * centre.up[1] +
      row[SWAY]! * centre.right[1] +
      p.roofOffset * sin(row[PITCH]!);
    const height = y0 + words[a]!;
    const gap = where.height - height;
    const offset = where.lateralOffset - row[SWAY]! + words[a]! * sin(row[ROLL]!);
    const inReach = track.supported && Math.abs(offset) <= p.headHalfWidth;
    const previous = words[a + 4]! > 0;
    const force = inReach && gap < 0 ? -p.contactStiffness * gap : 0;
    const spring = p.uplift + p.stiffness * (p.restHeight - words[a]!) - p.damping * words[a + 1]!;
    words[a + 1] = words[a + 1]! + dt * ((spring - force) / p.mass + wire.host.gravity[1]); // float division: head acceleration
    words[a] = words[a]! + dt * words[a + 1]!;
    words[a + 2] = arclength;
    words[a + 3] = height;
    words[a + 4] = force;
    words[a + 5] = gap;
    const breaksContact = p.energized && previous && force === 0 && inReach && gap <= p.visualGap;
    words[a + 6] = breaksContact ? p.visualArcTime : Math.max(0, words[a + 6]! - dt);
    row[ROOF_REACTION] = -spring;
    row[ROOF_LATERAL] = 0;
    if (force) {
      // Small lateral wire traction in the shoe plane follows its relative lateral velocity.
      const span = Math.floor(arclength / wire.spanLength); // float division: alternating support alignment
      const slope = ((span % 2 ? 1 : -1) * 2 * wire.stagger) / wire.spanLength; // float division: wire stagger slope
      const v = words[2 * wire.nodes + 2 * left]! + slope * row[SPEED]! - row[SWAY_SPEED]!;
      const across = -Math.sign(v) * Math.min(p.shoeFriction * force, Math.abs(v) / (dt * wire.inverseMass)); // float division: friction impulse bound
      row[ROOF_LATERAL] = -across;
      loading[2 * left] = loading[2 * left]! + (1 - fraction) * across;
      loading[2 * left + 2] = loading[2 * left + 2]! + fraction * across;
      loading[2 * left + 1] = loading[2 * left + 1]! + (1 - fraction) * force;
      loading[2 * left + 3] = loading[2 * left + 3]! + fraction * force;
    }
  }
  wire.kernel.rail_wire_step(
    wire.region.byteOffset,
    wire.region.byteOffset + 2 * wire.nodes * WORD_BYTES,
    wire.loading.byteOffset,
    wire.nodes,
    wire.intervals,
    wire.c2,
    wire.inverseMass,
    wire.damping,
    dt,
  );
}

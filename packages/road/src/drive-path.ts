import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { Spline } from '@margoengine/splines';
import { sampleRoadFrame } from './frame.js';

/** Roads and vehicle anchors use Y-up coordinates in metres. */
export type DrivePoint = readonly [x: number, y: number, z: number];

/** Sampled centreline of one driving lane. Bank uses the `bankedRoad` sign convention. */
export interface RoadDrivePath {
  readonly points: readonly DrivePoint[];
  readonly banks?: readonly number[];
  /** Connect the final point to the first. Default false. */
  readonly closed?: boolean;
}

/** Tessellation and lane position applied to the same spline that built the road. */
export interface RoadDrivePathOptions {
  /** Maximum arc metres between stations. Default 1. */
  readonly spacing?: number;
  /** Distance left of the centreline, metres. Default 0. */
  readonly offset?: number;
  /** The same bank angle or normalized-distance bank stations passed to bankedRoad. Default 0. */
  readonly bank?: number | readonly number[];
}

export function numberIn(value: number, name: string, min: number, max = Number.MAX_VALUE): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new MargoError('state', `Choose road driver ${name} between ${min} and ${max}.`);
  return value;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Build a lane from the road spline, including the lateral and vertical offsets of its bank. */
export function roadDrivePath(curve: Spline, options: RoadDrivePathOptions = {}): RoadDrivePath {
  const spacing = numberIn(options.spacing ?? 1, 'spacing', Number.MIN_VALUE);
  const length = numberIn(curve.length, 'spline length', Number.MIN_VALUE);
  const offset = numberIn(options.offset ?? 0, 'lane offset', -Number.MAX_VALUE);
  const source = options.bank ?? 0;
  const banks = typeof source === 'number' ? [source, source] : [...source];
  if (banks.length < 2 || (curve.closed && banks[0] !== banks.at(-1)))
    throw new MargoError('state', 'Provide at least two bank samples and repeat the initial bank on a closed spline.');
  banks.forEach((angle) => numberIn(angle, 'bank angle', -Math.PI / 4, Math.PI / 4));
  const segments = Math.max(curve.closed ? 3 : 1, Math.ceil(length / spacing)); // float division: physical sampling interval
  if (!Number.isSafeInteger(segments) || segments * 8 >= 0x1_0000_0000)
    throw new MargoError('state', 'Increase road driver spacing so the route fits the addressable memory.');
  const points: DrivePoint[] = [];
  const angles: number[] = [];
  const p = new Float64Array(3),
    before = new Float64Array(3),
    after = new Float64Array(3);
  const epsilon = (length / segments) * 0.01; // float division: same tangent scale as road geometry
  const count = curve.closed ? segments : segments + 1;
  for (let i = 0; i < count; i++) {
    const progress = i / segments; // float division: normalized road station
    sampleRoadFrame(curve, length * progress, epsilon, p, before, after);
    const dx = after[0]! - before[0]!,
      dy = after[1]! - before[1]!,
      dz = after[2]! - before[2]!;
    const flat = hypot(dx, dz);
    const span = hypot(dx, dy, dz);
    if (!(flat > 0)) throw new MargoError('state', 'Use a road spline whose tangent has a horizontal component.');
    const t = progress * (banks.length - 1);
    const j = Math.min(banks.length - 2, Math.floor(t));
    const angle = lerp(banks[j]!, banks[j + 1]!, t - j);
    // Bank rotates the lateral offset about the complete graded tangent, as bankedRoad does.
    const lx = dz / flat,
      lz = -dx / flat; // float division: horizontal left
    const alongBank = (offset * sin(angle)) / span; // float division: normalized 3-D tangent
    const left = offset * cos(angle);
    points.push([
      p[0]! + left * lx + dy * lz * alongBank,
      p[1]! + flat * alongBank,
      p[2]! + left * lz - dy * lx * alongBank,
    ]);
    angles.push(angle);
  }
  return { points, banks: angles, closed: curve.closed };
}

interface Station {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly bank: number;
  readonly curvature: number;
  readonly progress: number;
}

export interface SampledRoute {
  readonly stations: readonly Station[];
  readonly loop: boolean;
  readonly length: number;
}

function curvature(a: DrivePoint, b: DrivePoint, c: DrivePoint): number {
  const x = b[0] - a[0],
    z = b[2] - a[2],
    dx = c[0] - b[0],
    dz = c[2] - b[2];
  const side = hypot(x, z) * hypot(dx, dz) * hypot(c[0] - a[0], c[2] - a[2]);
  return side > 0 ? (2 * (z * dx - x * dz)) / side : 0; // float division: signed circumcircle curvature
}

export function sampleRoute(source: RoadDrivePath): SampledRoute {
  const { points, banks, closed = false } = source;
  if (points.length < (closed ? 3 : 2) || (banks && banks.length !== points.length))
    throw new MargoError(
      'state',
      'Give the road driver at least two distinct points, or three for a loop, and one bank angle per point.',
    );
  const n = points.length;
  const stations: Station[] = [];
  let progress = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    if (p.length !== 3 || !p.every(Number.isFinite))
      throw new MargoError('state', 'Choose finite XYZ coordinates for every lane station.');
    if (i > 0) {
      const q = points[i - 1]!;
      progress += numberIn(hypot(p[0] - q[0], p[2] - q[2]), 'horizontal station spacing', Number.MIN_VALUE);
    }
    // One-sided endpoints use the curvature of their nearest complete triple.
    const mid = closed ? i : Math.max(1, Math.min(n - 2, i));
    const bend = n < 3 ? 0 : curvature(points[(mid + n - 1) % n]!, points[mid]!, points[(mid + 1) % n]!);
    stations.push({
      x: p[0],
      y: p[1],
      z: p[2],
      bank: numberIn(banks?.[i] ?? 0, 'bank', -Math.PI / 4, Math.PI / 4),
      curvature: bend,
      progress,
    });
  }
  if (closed) {
    const a = stations[n - 1]!,
      first = stations[0]!;
    progress += numberIn(hypot(first.x - a.x, first.z - a.z), 'closing station spacing', Number.MIN_VALUE);
    stations.push({ ...first, progress });
  }
  return { stations, loop: closed, length: progress };
}

interface Projection {
  readonly segment: number;
  readonly t: number;
  readonly distance2: number;
  readonly progress: number;
}

function project(route: SampledRoute, segment: number, x: number, z: number): Projection {
  const a = route.stations[segment]!,
    b = route.stations[segment + 1]!;
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz))); // float division: segment projection
  const ex = x - lerp(a.x, b.x, t),
    ez = z - lerp(a.z, b.z, t);
  return { segment, t, distance2: ex * ex + ez * ez, progress: lerp(a.progress, b.progress, t) };
}

export function nearest(route: SampledRoute, x: number, z: number, previous: number): Projection {
  const n = route.stations.length - 1;
  let best = project(route, previous < 0 ? 0 : previous, x, z);
  if (previous < 0) {
    for (let i = 1; i < n; i++) {
      const next = project(route, i, x, z);
      if (next.distance2 < best.distance2) best = next;
    }
  } else {
    // The previous segment disambiguates loops and junction crossings. Usually only its two neighbours are examined.
    for (let i = 0; i < n; i++) {
      const left = best.segment > 0 ? best.segment - 1 : route.loop ? n - 1 : 0;
      const right = best.segment + 1 < n ? best.segment + 1 : route.loop ? 0 : n - 1;
      const a = project(route, left, x, z),
        b = project(route, right, x, z);
      if (a.distance2 >= best.distance2 && b.distance2 >= best.distance2) break;
      best = a.distance2 <= b.distance2 ? a : b;
    }
  }
  return best;
}

/** The first forward intersection of Coulter's look-ahead circle with the lane. */
export function lookAhead(route: SampledRoute, from: Projection, x: number, z: number, distance: number): DrivePoint {
  const n = route.stations.length - 1;
  const requested = distance * distance;
  const radius2 = from.distance2 >= requested ? from.distance2 + requested : requested;
  let latest: DrivePoint = [x, 0, z];
  for (let i = 0, segment = from.segment; i < n; i++, segment = (segment + 1) % n) {
    const a = route.stations[segment]!,
      b = route.stations[segment + 1]!;
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const ax = a.x - x,
      az = a.z - z,
      bx = b.x - x,
      bz = b.z - z;
    latest = [b.x, b.y, b.z];
    if (bx * bx + bz * bz >= radius2) {
      const A = dx * dx + dz * dz;
      const B = ax * dx + az * dz;
      const C = ax * ax + az * az - radius2;
      const root = (-B + Math.sqrt(Math.max(0, B * B - A * C))) / A; // float division: outward circle intersection
      const t = Math.max(i === 0 ? from.t : 0, Math.min(1, root));
      return [lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)];
    }
    if (!route.loop && segment + 1 === n) break;
  }
  return latest;
}

/** Maximal steady speed in a banked curve through the normal-load and friction balance. */
export function roadCornerSpeed(curve: number, bank: number, grip: number, gravity = 9.81): number {
  numberIn(curve, 'curvature', -Number.MAX_VALUE);
  numberIn(bank, 'bank angle', -Math.PI / 4, Math.PI / 4);
  numberIn(grip, 'grip', 0);
  numberIn(gravity, 'gravity', 0);
  if (curve === 0) return Infinity;
  // A positive `bankedRoad` angle raises +left. A positive bend turns +left, so that bank is adverse.
  const inward = -Math.sign(curve) * bank;
  const s = sin(inward),
    c = cos(inward);
  const numerator = s + grip * c;
  if (numerator <= 0) return 0;
  const denominator = c - grip * s;
  return denominator <= 0 ? Infinity : Math.sqrt((gravity * (numerator / denominator)) / Math.abs(curve)); // float division: grip-limited speed
}

export function plannedSpeed(
  route: SampledRoute,
  from: Projection,
  maximum: number,
  brake: number,
  grip: number,
  gravity: number,
): number {
  const n = route.stations.length - 1;
  const first = route.stations[from.segment]!,
    next = route.stations[from.segment + 1]!;
  const local = roadCornerSpeed(
    lerp(first.curvature, next.curvature, from.t),
    lerp(first.bank, next.bank, from.t),
    grip,
    gravity,
  );
  let bound = Math.min(maximum, local);
  bound *= bound;
  let lap = 0;
  let index = from.segment + 1;
  for (let i = 0; i < n; i++) {
    const station = route.stations[index]!;
    const brakingWork = 2 * brake * (station.progress + lap - from.progress);
    if (brakingWork >= bound) break;
    const stop = index === n && !route.loop;
    const speed = stop ? 0 : roadCornerSpeed(station.curvature, station.bank, grip, gravity);
    bound = Math.min(bound, speed * speed + brakingWork);
    if (stop) break;
    if (index === n) {
      lap += route.length;
      index = 1;
    } else index++;
  }
  return Math.sqrt(bound);
}

import { cross, dot, normalize, scale, sub } from '@margoengine/math/vec3';
import { dragIntegrals } from '../airborne/environment.js';

type V3 = readonly [number, number, number];

/** An absorbing plane with the same UV frame and extents as the receiving thin film. */
export interface ThinFilmDropReceiver {
  /** Lower UV corner of the free surface in metres from the origin cell. */
  readonly origin: readonly [number, number, number];
  /** Width and height along U and V, in metres. */
  readonly size: readonly [number, number];
  /** First tangent. Defaults to +X. */
  readonly u?: readonly [number, number, number];
  /** Second tangent, with U × V pointing into the incoming air. Defaults to −Z. */
  readonly v?: readonly [number, number, number];
  /** Origin cell of the plane. Defaults to [0, 0, 0]. */
  readonly cell?: readonly [number, number, number];
}

/** An impact row, f64: u, v, footprint radius, water volume, inward normal speed. Zero volume marks an unused row. */
export const FILM_IMPACT_WORDS = 5;
export type Impact = readonly [u: number, v: number, radius: number, volume: number, inwardSpeed: number];

interface PreparedReceiver {
  readonly origin: V3;
  readonly size: readonly [number, number];
  readonly u: V3;
  readonly v: V3;
  readonly n: V3;
  readonly cell: V3;
}

function vector(value: V3): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function prepareReceiver(opts: ThinFilmDropReceiver): PreparedReceiver {
  if (!opts || typeof opts !== 'object')
    throw new TypeError('Invalid drop receiver. Pass an object with its origin and UV dimensions.');
  const rawU = opts.u ?? [1, 0, 0];
  const rawV = opts.v ?? [0, 0, -1];
  const cell = opts.cell ?? [0, 0, 0];
  if (
    !vector(opts.origin) ||
    !vector(rawU) ||
    !vector(rawV) ||
    !Array.isArray(cell) ||
    cell.length !== 3 ||
    !cell.every(Number.isSafeInteger) ||
    !Array.isArray(opts.size) ||
    opts.size.length !== 2 ||
    !opts.size.every((d) => Number.isFinite(d) && d > 0)
  )
    throw new RangeError(
      'Invalid drop receiver. Use a finite plane, positive UV dimensions and one integer origin cell.',
    );
  const u = normalize(rawU);
  const v = normalize(sub(rawV, scale(u, dot(rawV, u))));
  const n = cross(u, v);
  if (!(dot(n, n) > 0)) throw new RangeError('Drop receiver tangents have no area. Use two nonparallel directions.');
  return {
    origin: [...opts.origin],
    size: [opts.size[0]!, opts.size[1]!],
    u,
    v,
    n,
    cell: [cell[0]!, cell[1]!, cell[2]!],
  };
}

// For a frozen drag coefficient, normal velocity is monotone and has at most one zero.
// Bracket the approaching part before finding the first contact of the spherical drop.
function firstContact(h: number, v: number, wind: number, g: number, rate: number, dt: number): number | undefined {
  const relative = v - wind;
  const speed = (t: number) => {
    const [decay, velocityTime] = dragIntegrals(rate, t);
    return wind + decay * relative + g * velocityTime;
  };
  const height = (t: number) => {
    const [, velocityTime, positionTime] = dragIntegrals(rate, t);
    return h + wind * t + relative * velocityTime + g * positionTime;
  };
  const end = speed(dt);
  if (v >= 0 && end >= 0) return undefined;
  let from = 0;
  let to = dt;
  if (v < 0 !== end < 0) {
    const fallingFirst = v < 0;
    let lo = 0;
    let hi = dt;
    for (let i = 0; i < 48; i++) {
      const t = (lo + hi) * 0.5;
      if (speed(t) < 0 === fallingFirst) lo = t;
      else hi = t;
    }
    if (fallingFirst) to = hi;
    else from = hi;
  }
  if (height(from) < 0 || height(to) > 0) return undefined;
  for (let i = 0; i < 48; i++) {
    const t = (from + to) * 0.5;
    if (height(t) > 0) from = t;
    else to = t;
  }
  return to;
}

export function receiverImpact(
  receiver: PreparedReceiver,
  drop: Float64Array,
  at: number,
  dt: number,
  gravity: V3,
  wind: V3,
  buoyancy: number,
  rate: number,
  cell: V3,
  cellSize: number,
): Impact | undefined {
  const { n, u, v, size } = receiver;
  const x = drop[at]! - receiver.origin[0] + (cell[0] - receiver.cell[0]) * cellSize;
  const y = drop[at + 1]! - receiver.origin[1] + (cell[1] - receiver.cell[1]) * cellSize;
  const z = drop[at + 2]! - receiver.origin[2] + (cell[2] - receiver.cell[2]) * cellSize;
  const vx = drop[at + 3]!;
  const vy = drop[at + 4]!;
  const vz = drop[at + 5]!;
  const radius = 0.5 * drop[at + 7]!;
  const normalVelocity = n[0] * vx + n[1] * vy + n[2] * vz;
  const normalWind = dot(n, wind);
  const normalGravity = dot(n, gravity) * buoyancy;
  const h = n[0] * x + n[1] * y + n[2] * z - radius;
  const time = firstContact(h, normalVelocity, normalWind, normalGravity, rate, dt);
  if (time === undefined) return undefined;
  const [decay, velocityTime, positionTime] = dragIntegrals(rate, time);
  const gx = x + wind[0] * time + (vx - wind[0]) * velocityTime + buoyancy * gravity[0] * positionTime;
  const gy = y + wind[1] * time + (vy - wind[1]) * velocityTime + buoyancy * gravity[1] * positionTime;
  const gz = z + wind[2] * time + (vz - wind[2]) * velocityTime + buoyancy * gravity[2] * positionTime;
  const atU = u[0] * gx + u[1] * gy + u[2] * gz;
  const atV = v[0] * gx + v[1] * gy + v[2] * gz;
  const inward = -(normalWind + decay * (normalVelocity - normalWind) + normalGravity * velocityTime);
  if (!(atU >= 0 && atU <= size[0] && atV >= 0 && atV <= size[1] && inward > 0)) return undefined;
  return [atU, atV, radius, drop[at + 6]!, inward];
}

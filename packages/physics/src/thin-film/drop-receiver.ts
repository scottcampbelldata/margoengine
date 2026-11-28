import { filmError } from './errors.js';
import { hypot } from '@margoengine/math/pinned';
import { conjugateQuaternion, normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { add, cross, dot, scale, sub } from '@margoengine/math/vec3';
import { dragIntegrals } from '../airborne/environment.js';
import { regionWords } from '../world/memory.js';
import type { Port } from '../world/solver.js';
import { BODY_WORDS } from '../world/solvers/rigid.js';
import { prepareTurn, type ReceiverTurn } from './drop-turn.js';

type V3 = readonly [number, number, number];
type Rotation = readonly [number, number, number, number];
const STILL: V3 = [0, 0, 0];
/** An absorbing plane with the same UV frame and extents as the receiving thin film. */
export interface ThinFilmDropReceiver {
  /** Lower UV corner in metres, local to bodyRow when mounted or relative to the origin cell. */
  readonly origin: readonly [number, number, number];
  /** Width and height along U and V, in metres. */
  readonly size: readonly [number, number];
  /** First tangent. Defaults to +X. */
  readonly u?: readonly [number, number, number];
  /** Second tangent, with U × V pointing into the incoming air. Defaults to −Z. */
  readonly v?: readonly [number, number, number];
  /** Origin cell of the plane. Defaults to [0, 0, 0]. */
  readonly cell?: readonly [number, number, number];
  /** Rigid body carrying the plane. Use the flight's rigid option. */
  readonly bodyRow?: number;
  /** Follow the mount's orientation and publish layout-2 impacts. Defaults to false. */
  readonly followRotation?: boolean;
  /** Include the rectangle's wet edges and corners in the sphere sweep. Requires followRotation. Defaults to false. */
  readonly captureEdges?: boolean;
}

/** An impact row, f64: u, v, footprint radius, water volume, inward normal speed. Zero volume marks an unused row. */
export const FILM_IMPACT_WORDS = 5;
/** Layout 2 adds the world normal and the contact lever arm from the body centre, both XYZ in world axes. */
export const FILM_SWEPT_IMPACT_WORDS = 11;
/** Layout version 2 of the film impact records, which add the world normal and the contact lever arm. */
export const FILM_SWEPT_IMPACT_LAYOUT = 2;
export type Impact = readonly [u: number, v: number, radius: number, volume: number, inwardSpeed: number];

interface PreparedReceiver {
  readonly origin: V3;
  readonly size: readonly [number, number];
  readonly u: V3;
  readonly v: V3;
  readonly n: V3;
  readonly cell: V3;
  readonly bodyRow?: number;
  readonly followsRotation: boolean;
  readonly capturesEdges: boolean;
}

export interface ReceiverSweep {
  readonly plane: PreparedReceiver;
  readonly velocity: V3;
  readonly turn?: ReceiverTurn;
}

function vector(value: V3): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function unit(value: V3): V3 {
  const length = hypot(...value);
  return length > 0 ? scale(value, 1 / length) : [0, 0, 0];
}

export function prepareReceiver(opts: ThinFilmDropReceiver): PreparedReceiver {
  if (!opts || typeof opts !== 'object')
    throw filmError('unsupported', 'Invalid drop receiver. Pass an object with its origin and UV dimensions.');
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
    throw filmError(
      'unsupported',
      'Invalid drop receiver. Use a finite plane, positive UV dimensions and one integer origin cell.',
    );
  const u = unit(rawU);
  const v = unit(sub(rawV, scale(u, dot(rawV, u))));
  const n = cross(u, v);
  if (!(dot(n, n) > 0))
    throw filmError('unsupported', 'Drop receiver tangents have no area. Use two nonparallel directions.');
  const bodyRow = opts.bodyRow;
  if (bodyRow !== undefined && (!Number.isSafeInteger(bodyRow) || bodyRow < 0 || opts.cell !== undefined))
    throw filmError(
      'unsupported',
      'Invalid mounted drop receiver. Use a live body row and omit the plane origin cell.',
    );
  if (opts.followRotation && bodyRow === undefined)
    throw filmError('unsupported', 'Rotating drop receiver has no mount. You must supply the receiving film body row.');
  if (opts.captureEdges && !opts.followRotation)
    throw filmError(
      'unsupported',
      'Wet edge capture needs a swept contact frame. Enable followRotation on the receiver.',
    );
  return {
    origin: [...opts.origin],
    size: [opts.size[0]!, opts.size[1]!],
    u,
    v,
    n,
    cell: [cell[0]!, cell[1]!, cell[2]!],
    bodyRow,
    followsRotation: opts.followRotation ?? false,
    capturesEdges: opts.captureEdges ?? false,
  };
}

export function receiverPose(memory: WebAssembly.Memory, port: Port | undefined, receiver: PreparedReceiver): number[] {
  const row = receiver.bodyRow!;
  const region = port?.region;
  if (!port || region?.layout !== 2 || region.type !== 'f32' || region.byteLength < (row + 1) * BODY_WORDS * 4)
    throw filmError(
      'unsupported',
      'Missing mounted-drop pose. Add the layout-2 RigidSolver with a valid body row first.',
    );
  const at = row * BODY_WORDS;
  const values = regionWords(memory, region);
  const pose = Array.from(values.subarray(at, at + 7));
  const centre = receiver.followsRotation ? Array.from(values.subarray(at + 7, at + 10)) : [];
  if (!pose.every(Number.isFinite) || pose.slice(3).every((x) => x === 0) || !centre.every(Number.isFinite))
    throw filmError('unsupported', 'Mounted drop receiver has no live body pose. Use a live body row.');
  return [...pose, ...port.cell, port.tick, ...centre];
}

function rotation(pose: ArrayLike<number>): Rotation {
  return normalizeQuaternion([pose[3]!, pose[4]!, pose[5]!, pose[6]!]);
}

export function sweepReceiver(
  plane: PreparedReceiver,
  before: ArrayLike<number>,
  after: ArrayLike<number>,
  dt: number,
  cellSize: number,
): ReceiverSweep {
  if (after[10]! <= before[10]!)
    throw filmError(
      'unsupported',
      'Mounted-drop pose did not advance. Step the rigid solver before its staggered flight.',
    );
  const q = rotation(before);
  const endRotation = rotation(after);
  const cell: V3 = [after[7]!, after[8]!, after[9]!];
  const shift: V3 = [
    (before[7]! - cell[0]) * cellSize,
    (before[8]! - cell[1]) * cellSize,
    (before[9]! - cell[2]) * cellSize,
  ];
  const start = add([before[0]!, before[1]!, before[2]!], shift);
  if (plane.followsRotation) {
    const centre = add([before[11]!, before[12]!, before[13]!], shift);
    const velocity = scale(sub([after[11]!, after[12]!, after[13]!], centre), 1 / dt);
    const centreToOrigin = rotateByQuaternion(sub(start, centre), conjugateQuaternion(q));
    return {
      plane: { ...plane, cell, origin: add(plane.origin, centreToOrigin) },
      velocity,
      turn: prepareTurn(q, endRotation, centre, velocity, dt),
    };
  }
  const sign =
    q[0] * endRotation[0] + q[1] * endRotation[1] + q[2] * endRotation[2] + q[3] * endRotation[3] < 0 ? -1 : 1;
  const rotationQuantum = 8 / 16_777_216; // Rigid poses are stored as f32 components.
  if (q.some((x, k) => Math.abs(x - sign * endRotation[k]!) > rotationQuantum))
    throw filmError(
      'unsupported',
      'Mounted drop receiver rotated during translation. Enable followRotation for its swept pose.',
    );
  return {
    plane: {
      ...plane,
      origin: add(start, rotateByQuaternion(plane.origin, q)),
      u: rotateByQuaternion(plane.u, q),
      v: rotateByQuaternion(plane.v, q),
      n: rotateByQuaternion(plane.n, q),
      cell,
    },
    velocity: scale(sub([after[0]!, after[1]!, after[2]!], start), 1 / dt),
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
  sweepVelocity: V3 = STILL,
  elapsed = 0,
): Impact | undefined {
  const { n, u, v, size } = receiver;
  const x = drop[at]! - receiver.origin[0] + (cell[0] - receiver.cell[0]) * cellSize - sweepVelocity[0] * elapsed;
  const y = drop[at + 1]! - receiver.origin[1] + (cell[1] - receiver.cell[1]) * cellSize - sweepVelocity[1] * elapsed;
  const z = drop[at + 2]! - receiver.origin[2] + (cell[2] - receiver.cell[2]) * cellSize - sweepVelocity[2] * elapsed;
  const vx = drop[at + 3]! - sweepVelocity[0];
  const vy = drop[at + 4]! - sweepVelocity[1];
  const vz = drop[at + 5]! - sweepVelocity[2];
  const relativeWind = sub(wind, sweepVelocity);
  const radius = 0.5 * drop[at + 7]!;
  const normalVelocity = n[0] * vx + n[1] * vy + n[2] * vz;
  const normalWind = dot(n, relativeWind);
  const normalGravity = dot(n, gravity) * buoyancy;
  const h = n[0] * x + n[1] * y + n[2] * z - radius;
  const time = firstContact(h, normalVelocity, normalWind, normalGravity, rate, dt);
  if (time === undefined) return undefined;
  const [decay, velocityTime, positionTime] = dragIntegrals(rate, time);
  const gx = x + relativeWind[0] * time + (vx - relativeWind[0]) * velocityTime + buoyancy * gravity[0] * positionTime;
  const gy = y + relativeWind[1] * time + (vy - relativeWind[1]) * velocityTime + buoyancy * gravity[1] * positionTime;
  const gz = z + relativeWind[2] * time + (vz - relativeWind[2]) * velocityTime + buoyancy * gravity[2] * positionTime;
  const atU = u[0] * gx + u[1] * gy + u[2] * gz;
  const atV = v[0] * gx + v[1] * gy + v[2] * gz;
  const inward = -(normalWind + decay * (normalVelocity - normalWind) + normalGravity * velocityTime);
  if (!(atU >= 0 && atU <= size[0] && atV >= 0 && atV <= size[1] && inward > 0)) return undefined;
  return [atU, atV, radius, drop[at + 6]!, inward];
}

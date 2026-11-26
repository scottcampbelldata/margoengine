import { hypot } from '@margoengine/math/pinned';
import { conjugateQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import { add, cross, dot, scale, sub } from '@margoengine/math/vec3';
import { dragIntegrals } from '../airborne/environment.js';

type Vec3 = readonly [number, number, number];
type Orientation = readonly [number, number, number, number];

export interface ReceiverTurn {
  readonly centre: Vec3;
  readonly velocity: Vec3;
  readonly start: Orientation;
  readonly difference: Orientation;
  readonly rateVector: Vec3;
  readonly speedBound: number;
  readonly accelerationBound: number;
  readonly step: number;
}

interface LocalPlane {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
  readonly cell: Vec3;
  readonly size: readonly [number, number];
}

interface Clearance {
  readonly time: number;
  readonly height: number;
  readonly speed: number;
  readonly normal: Vec3;
  readonly relative: Vec3;
  readonly orientation: Orientation;
}

/** The shortest normalized chord between unit endpoint quaternions. */
export function prepareTurn(
  before: Orientation,
  after: Orientation,
  centre: Vec3,
  velocity: Vec3,
  step: number,
): ReceiverTurn {
  const scalar = before[0] * after[0] + before[1] * after[1] + before[2] * after[2] + before[3] * after[3];
  const sign = scalar < 0 ? -1 : 1;
  const difference: Orientation = [
    sign * after[0] - before[0],
    sign * after[1] - before[1],
    sign * after[2] - before[2],
    sign * after[3] - before[3],
  ];
  const [x, y, z] = multiplyQuaternions(difference, conjugateQuaternion(before));
  const rateVector: Vec3 = [(2 * x) / step, (2 * y) / step, (2 * z) / step];
  const agreement = Math.min(1, Math.abs(scalar));
  const minNormSquared = (1 + agreement) / 2;
  const speedBound = hypot(...rateVector) / minNormSquared;
  const accelerationBound = (2 * speedBound * (1 - agreement)) / (minNormSquared * step);
  return { centre, velocity, start: before, difference, rateVector, speedBound, accelerationBound, step };
}

function approach(
  read: (time: number) => Clearance,
  interval: number,
  curvatureBound: number,
  distance: number,
  accept: (hit: Clearance) => readonly number[] | undefined,
): readonly number[] | undefined {
  const distanceRoundoff = 16 * Number.EPSILON * distance;
  const timeRoundoff = 16 * Number.EPSILON * interval;
  const tangentSpeed = Math.sqrt(2 * curvatureBound * distanceRoundoff);
  function visit(left: Clearance, right: Clearance): readonly number[] | undefined {
    const span = right.time - left.time;
    // A function with bounded second derivative stays within M Δt²/8 of its secant.
    const deviation = (curvatureBound * span * span) / 8 + distanceRoundoff;
    if (Math.min(left.height, right.height) > deviation || Math.max(left.height, right.height) < -deviation) return;
    const middle = read((left.time + right.time) / 2);
    const speedVariation = (curvatureBound * span) / 2;
    if (middle.speed - speedVariation >= -tangentSpeed) return;
    if (middle.speed + speedVariation < 0 || span <= timeRoundoff) {
      if (left.height < 0 || right.height > 0) return;
      while (right.time - left.time > timeRoundoff) {
        const midpoint = read((left.time + right.time) / 2);
        if (midpoint.height > 0) left = midpoint;
        else right = midpoint;
      }
      return right.speed < -tangentSpeed ? accept(right) : undefined;
    }
    return visit(left, middle) ?? visit(middle, right);
  }
  return visit(read(0), read(interval));
}

/** Capture the swing using an interval bound on the actual frozen-drag trajectory. */
export function turningImpact(
  plane: LocalPlane,
  turn: ReceiverTurn,
  drop: Float64Array,
  at: number,
  interval: number,
  gravity: Vec3,
  wind: Vec3,
  buoyancy: number,
  drag: number,
  cell: Vec3,
  cellSize: number,
  elapsed: number,
): readonly number[] | undefined {
  const position: Vec3 = [
    drop[at]! + (cell[0] - plane.cell[0]) * cellSize - turn.centre[0] - elapsed * turn.velocity[0],
    drop[at + 1]! + (cell[1] - plane.cell[1]) * cellSize - turn.centre[1] - elapsed * turn.velocity[1],
    drop[at + 2]! + (cell[2] - plane.cell[2]) * cellSize - turn.centre[2] - elapsed * turn.velocity[2],
  ];
  const velocity = sub([drop[at + 3]!, drop[at + 4]!, drop[at + 5]!], turn.velocity);
  const air = sub(wind, turn.velocity);
  const initialSlip = sub(velocity, air);
  const effectiveGravity = scale(gravity, buoyancy);
  const acceleration = sub(effectiveGravity, scale(initialSlip, drag));
  const radius = 0.5 * drop[at + 7]!;
  const offset = dot(plane.n, plane.origin) + radius;
  const atEndVelocity = add(velocity, scale(acceleration, dragIntegrals(drag, interval)[1]));
  // Frozen drag sets V(t) = V(0) + A(0) * I1(t), so its speed is bounded by the endpoint norms.
  const velocityBound = Math.max(hypot(...velocity), hypot(...atEndVelocity));
  const displacement = hypot(...position) + interval * velocityBound;
  const receiverReach = hypot(...plane.origin) + hypot(...plane.size) + radius;
  if (hypot(...position) > receiverReach + interval * velocityBound) return;
  const spin = turn.speedBound;
  const initialNormal = rotateByQuaternion(plane.n, turn.start);
  const axisMagnitude = hypot(...turn.rateVector);
  const axis = axisMagnitude === 0 ? initialNormal : scale(turn.rateVector, 1 / axisMagnitude);
  const normalSwing = hypot(...cross(axis, initialNormal));
  const normalSpeed = spin * normalSwing;
  const normalAcceleration = (turn.accelerationBound + spin * spin) * normalSwing;
  const lateralSpeed = Math.max(hypot(...cross(axis, velocity)), hypot(...cross(axis, atEndVelocity)));
  const lateralDisplacement = hypot(...cross(axis, position)) + interval * lateralSpeed;
  const accelerationBound =
    Math.abs(dot(initialNormal, acceleration)) +
    Math.min(2 * normalSwing, normalSpeed * turn.step) * hypot(...cross(axis, acceleration));
  const curvatureBound = accelerationBound + 2 * normalSpeed * lateralSpeed + normalAcceleration * lateralDisplacement;
  if (!Number.isFinite(curvatureBound + displacement))
    throw new RangeError('The turning film sweep exceeds numeric range. Use finite scales and relative speeds.');
  function read(time: number): Clearance {
    const phase = (elapsed + time) / turn.step;
    const { start, difference } = turn;
    const a = start[0] + phase * difference[0];
    const b = start[1] + phase * difference[1];
    const c = start[2] + phase * difference[2];
    const d = start[3] + phase * difference[3];
    const normSquared = a * a + b * b + c * c + d * d;
    const invLength = 1 / Math.sqrt(normSquared);
    const orientation: Orientation = [a * invLength, b * invLength, c * invLength, d * invLength];
    const normal = rotateByQuaternion(plane.n, orientation);
    const omega = scale(turn.rateVector, 1 / normSquared);
    const [, i1, i2] = dragIntegrals(drag, time);
    const relative = add(add(position, scale(velocity, time)), scale(acceleration, i2));
    const speed = dot(normal, sub(add(velocity, scale(acceleration, i1)), cross(omega, relative)));
    return { time, height: dot(normal, relative) - offset, speed, normal, relative, orientation };
  }
  return approach(read, interval, curvatureBound, displacement + Math.abs(offset), (hit) => {
    const lever = sub(hit.relative, scale(hit.normal, radius));
    const local = sub(rotateByQuaternion(lever, conjugateQuaternion(hit.orientation)), plane.origin);
    const u = dot(plane.u, local);
    const v = dot(plane.v, local);
    if (u < 0 || u > plane.size[0] || v < 0 || v > plane.size[1]) return undefined;
    return [u, v, radius, drop[at + 6]!, -hit.speed, ...hit.normal, ...lever];
  });
}

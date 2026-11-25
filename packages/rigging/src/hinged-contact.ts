import type { CCDHingeLimit, CCDSolver } from '@margoengine/animator/ccd';
import type { Vec3 } from '@margoengine/math';
import {
  axisAngleToQuaternion,
  conjugateQuaternion,
  multiplyQuaternions,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { add, cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';

type Quat = readonly [number, number, number, number];

function bendFrame(along: Vec3, axis: Vec3): Quat {
  return rotationToQuaternion([...along, ...cross(axis, along), ...axis]);
}

/** Solves the last two links in the selected bend plane, then distributes the requested turn. */
export function poseHingedContact(solver: CCDSolver, target: Vec3, goal: Quat, pole: Vec3, limit: CCDHingeLimit): void {
  const end = solver.joints - 1,
    hinge = end - 1,
    start = end - 2;
  const position = (i: number): Vec3 => [
      solver.positions[i * 3],
      solver.positions[i * 3 + 1],
      solver.positions[i * 3 + 2],
    ],
    rotation = (i: number) => solver.worldRotations.slice(i * 4, i * 4 + 4),
    neutral = (i: number) => solver.rest.subarray(i * 4, i * 4 + 4),
    offset = (i: number) => normalize(solver.offsets.subarray(i * 3, i * 3 + 3));
  const upper = offset(hinge),
    forearm = offset(end),
    hingeAxis = normalize(limit.axis),
    axis = rotateByQuaternion(hingeAxis, neutral(hinge)),
    lower = rotateByQuaternion(forearm, neutral(hinge));
  if (
    Math.abs(dot(axis, upper)) > 1e-5 ||
    Math.abs(dot(axis, lower)) > 1e-5 ||
    (limit.twist && dot(normalize(limit.twist.axis), forearm) < 0.99999)
  )
    throw new RangeError(
      'Hinged contact needs a bend axis perpendicular to both links and forearm roll along the last link',
    );
  const bind = Math.atan2(dot(axis, cross(upper, lower)), dot(upper, lower)),
    min = Math.max(1e-5, bind + (limit.min ?? -Math.PI)),
    max = Math.min(Math.PI - 1e-5, bind + (limit.max ?? Math.PI));
  if (max < min) throw new RangeError('Hinged contact needs a flexion range that intersects the positive bend branch');

  solver.projectRotations();
  solver.update();
  const shoulder = position(start),
    elbow = position(hinge),
    wrist = position(end),
    a = length(sub(elbow, shoulder)),
    b = length(sub(wrist, elbow)),
    delta = sub(target, shoulder),
    distance = length(delta),
    aimed = distance < 1e-8 ? normalize(sub(wrist, shoulder)) : scale(delta, 1 / distance);
  if (a < 1e-8 || b < 1e-8) throw new RangeError('Hinged contact needs two links with nonzero lengths');
  const poleDirection = normalize(sub(pole, shoulder)),
    side = cross(poleDirection, aimed);
  if (length(side) < 1e-6)
    throw new RangeError('Choose a hinged contact pole off the shoulder-to-target line to define a bend plane');
  const reach = (angle: number) => Math.sqrt(Math.max(0, a * a + b * b + 2 * a * b * Math.cos(angle)));
  const clampedDistance = Math.max(reach(max), Math.min(reach(min), distance));
  const hingeWorld = normalize(side),
    circleAlong = (a * a - b * b + clampedDistance * clampedDistance) / (2 * clampedDistance),
    circleRadius = Math.sqrt(Math.max(0, a * a - circleAlong * circleAlong)),
    upperWorld = normalize(add(scale(aimed, circleAlong), scale(cross(aimed, hingeWorld), circleRadius))),
    cosine = (clampedDistance * clampedDistance - a * a - b * b) / (2 * a * b),
    bend = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const shoulderWorld = multiplyQuaternions(
      bendFrame(upperWorld, hingeWorld),
      conjugateQuaternion(bendFrame(upper, axis)),
    ),
    parent = start === 0 ? solver.parentRotation : rotation(start - 1),
    flex = multiplyQuaternions(neutral(hinge), axisAngleToQuaternion(hingeAxis, bend - bind)),
    lowerFlexWorld = multiplyQuaternions(shoulderWorld, flex);
  let roll = 0;
  if (limit.twist) {
    const desired = multiplyQuaternions(
      conjugateQuaternion(lowerFlexWorld),
      multiplyQuaternions(goal, conjugateQuaternion(neutral(end))),
    );
    const axial = 2 * Math.atan2(dot(desired.slice(0, 3), forearm), desired[3]);
    const signed = Math.atan2(Math.sin(axial), Math.cos(axial));
    roll = Math.max(limit.twist.range[0], Math.min(limit.twist.range[1], signed));
  }
  const forearmLocal = multiplyQuaternions(flex, axisAngleToQuaternion(forearm, roll)),
    forearmWorld = multiplyQuaternions(shoulderWorld, forearmLocal);
  solver.rotations.set(multiplyQuaternions(conjugateQuaternion(parent), shoulderWorld), start * 4);
  solver.rotations.set(forearmLocal, hinge * 4);
  solver.rotations.set(multiplyQuaternions(conjugateQuaternion(forearmWorld), goal), end * 4);
  solver.projectRotations();
  solver.update();
}

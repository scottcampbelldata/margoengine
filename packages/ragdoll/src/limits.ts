// What a ragdoll's motors may ask of a joint: swing and twist of a bone from its rest pose, and the nearest rotation inside its
// cone. Shared by the motors (powered.ts) and the balance controller (balance.ts), so every motor target stops at the limits.
import { conjugateQuaternion, multiplyQuaternions } from '@margoengine/math/quat';
import type { RagdollJoint, RagdollPart } from './ragdoll.js';

const TWO_PI = Math.PI * 2;

/** The swing and twist of the unit quaternion `d` about the unit `axis`: `d` is swing * twist. */
export function swingTwist(d: ArrayLike<number>, axis: ArrayLike<number>): { swing: number[]; twist: number } {
  const dot = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2],
    length = Math.hypot(dot, d[3]);
  if (length < 1e-9) return { swing: [d[0], d[1], d[2], d[3]], twist: 0 };
  const twist = [(axis[0] * dot) / length, (axis[1] * dot) / length, (axis[2] * dot) / length, d[3] / length];
  let angle = 2 * Math.atan2(dot, d[3]);
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle < -Math.PI) angle += TWO_PI;
  return { swing: multiplyQuaternions([d[0], d[1], d[2], d[3]], conjugateQuaternion(twist)), twist: angle };
}
export const aboutAxis = (axis: ArrayLike<number>, angle: number): number[] => {
  const sin = Math.sin(angle / 2);
  return [axis[0] * sin, axis[1] * sin, axis[2] * sin, Math.cos(angle / 2)];
};

/**
 * The rotation a joint can reach nearest `rotation` (a bone relative to its parent), inside its limits, so a motor
 * never pulls against the limit it would have to pass. `part.spec` must be a cone or free joint.
 */
export function insideLimits(part: RagdollPart, rotation: number[]): number[] {
  const spec = part.spec as Extract<RagdollJoint, { type: 'cone' | 'free' }>;
  if (spec.type === 'free') return rotation;
  const rest = part.rest,
    d = multiplyQuaternions(conjugateQuaternion(rest), rotation);
  if (d[3] < 0) for (let k = 0; k < 4; k++) d[k] = -d[k];
  const { swing, twist } = swingTwist(d, part.axis),
    [min, max] = spec.twist!,
    limit = spec.swing!,
    sin = Math.hypot(swing[0], swing[1], swing[2]),
    angle = 2 * Math.atan2(sin, Math.abs(swing[3]));
  const held = Math.min(max, Math.max(min, twist));
  if (angle <= limit && held === twist) return rotation;
  const sign = swing[3] < 0 ? -1 : 1,
    kept =
      angle > limit && sin > 1e-9
        ? aboutAxis([(swing[0] / sin) * sign, (swing[1] / sin) * sign, (swing[2] / sin) * sign], limit)
        : swing;
  return multiplyQuaternions(rest, multiplyQuaternions(kept, aboutAxis(part.axis, held)));
}

import { CCDSolver } from '@margoengine/animator/ccd';
import type { Vec3 } from '@margoengine/math';
import {
  conjugateQuaternion,
  interpolateQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import { add, cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import { FINGERS, type HandRig, type MeasuredHand } from './hands.js';

/**
 * Fit digits around the palm's cylinder. Fingers use its forward sector and the opposing thumb uses the
 * wrist side. The approach pose opens clear of the bar before the digits close.
 */
export function fitBarGrip(
  rig: HandRig,
  hand: MeasuredHand,
  forward: Vec3,
  normal: Vec3,
  anchor: Vec3,
  diameter: number,
  open: Map<number, number[]>,
  rotations: Map<number, number[]>,
): void {
  const wrist = hand.world(hand.hand),
    across = normalize(cross(forward, normal));
  if (length(across) < 0.99) return;
  const tangent = cross(normal, across),
    positionIn = (joint: number, parent: number) =>
      rotateByQuaternion(
        sub(frame(joint).position, frame(parent).position),
        conjugateQuaternion(frame(parent).rotation),
      ),
    frame = (i: number) => hand.world(i);
  const index = hand.fingers.index?.bones[0];
  if (index === undefined) return;
  const indexOffset = dot(
    rotateByQuaternion(sub(frame(index).position, wrist.position), conjugateQuaternion(wrist.rotation)),
    across,
  );
  const radius = diameter / 2,
    center = add(anchor, scale(normal, radius));
  for (const name of FINGERS) {
    const finger = hand.fingers[name];
    if (!finger || finger.curl.some((axis) => length(axis) < 0.9)) continue;
    const [base, middle, distal] = finger.bones;
    if (rig.parents[base] !== hand.hand || rig.parents[middle] !== base || rig.parents[distal] !== middle) continue;
    const thumb = name === 'thumb';
    const tipJoint = rig.parents.findIndex((parent) => parent === distal),
      tipDirection =
        tipJoint < 0
          ? rotateByQuaternion(
              sub(frame(distal).position, frame(middle).position),
              conjugateQuaternion(frame(distal).rotation),
            )
          : positionIn(tipJoint, distal),
      tip = scale(normalize(tipDirection), finger.lengths[2]);
    const segments = [positionIn(base, hand.hand), positionIn(middle, base), positionIn(distal, middle)];
    if (length(tip) < 1e-6 || segments.slice(1).some((offset) => length(offset) < 1e-6)) continue;
    const solver = new CCDSolver(segments, tip),
      pad = finger.lengths[1] * (thumb ? 0.23 : 0.28),
      seed = new Float64Array(12),
      resting = new Float64Array(12);
    for (const [k, bone] of finger.bones.entries()) {
      const neutral = normalizeQuaternion(hand.rest.get(bone) ?? [0, 0, 0, 1]);
      solver.rest.set(neutral, k * 4);
      seed.set(rotations.get(bone) ?? neutral, k * 4);
      resting.set(open.get(bone) ?? neutral, k * 4);
    }
    solver.setLimit(
      0,
      thumb
        ? { type: 'cone', axis: normalize(segments[1]), angle: 1.12, twist: [-0.58, 0.58] }
        : { type: 'hinge', axis: finger.curl[0], min: -0.08, max: 1.56 },
    );
    solver.setLimit(1, { type: 'hinge', axis: finger.curl[1], min: -0.15, max: thumb ? 1.16 : 1.97 });
    solver.setLimit(2, { type: 'hinge', axis: finger.curl[2], min: -0.15, max: 1.37 });
    solver.tolerance = Math.max(0.00005, pad * 0.018);
    solver.iterations = 28;

    const projected = (at: number) => {
      const delta = sub(solver.positions.subarray(at, at + 3), center);
      return [dot(delta, tangent), dot(delta, normal)];
    };
    const penetration = () => {
      let depth = 0;
      for (let k = 0; k < 3; k++) {
        const a = projected(k * 3),
          b = projected((k + 1) * 3),
          x = b[0] - a[0],
          y = b[1] - a[1],
          denominator = x * x + y * y;
        const t = denominator > 0 ? Math.max(0, Math.min(1, -(a[0] * x + a[1] * y) / denominator)) : 0;
        depth = Math.max(depth, radius + pad - Math.hypot(a[0] + x * t, a[1] + y * t));
      }
      return depth;
    };
    const baseOffset = dot(segments[0], across),
      along = thumb ? indexOffset * 0.7 + baseOffset * 0.3 : baseOffset,
      axial = scale(across, along - dot(center, across)),
      baseTarget = add(center, axial);
    const aim = (theta: number, extra: number, initial: Float64Array) => {
      const radial = add(scale(tangent, Math.sin(theta) * (thumb ? -1 : 1)), scale(normal, -Math.cos(theta)));
      solver.rotations.set(initial);
      solver.solve(add(baseTarget, scale(radial, radius + pad + extra)));
      return solver.rotations.slice();
    };
    const score = (approach: Float64Array, angles: Float64Array) => {
      let deepest = 0;
      for (const closure of [0, 0.16, 0.32, 0.49, 0.66, 0.83, 1]) {
        for (const k of [0, 4, 8])
          solver.rotations.set(
            interpolateQuaternions(approach.subarray(k, k + 4), angles.subarray(k, k + 4), closure, 0.9995),
            k,
          );
        solver.update();
        deepest = Math.max(deepest, penetration());
      }
      const end = projected(9);
      return Math.abs(Math.hypot(...end) - radius - pad) + 16 * deepest + Math.max(0, thumb ? end[0] : -end[0]);
    };
    let best = seed,
      bestOpen = resting,
      bestCost = score(resting, seed);
    for (const theta of thumb ? [0.4, 0.68, 0.95, 1.22, 1.48] : [0.74, 1.06, 1.42, 1.78, 2.14, 2.52, 2.88]) {
      const pose = aim(theta, 0, seed);
      const cost = score(resting, pose);
      if (cost + 1e-6 < bestCost) {
        bestCost = cost;
        best = pose;
        bestOpen = resting;
      }
      // If the unprepared hand crosses the rung, open from the selected grip sector, away from the bar.
      if (cost > 0.003)
        for (const turn of [0, -0.35, 0.35]) {
          for (const extra of [0.007, 0.013, 0.022]) {
            const approach = aim(theta + turn, extra, pose);
            const fullCost = score(approach, pose) + 0.001;
            if (fullCost + 1e-6 < bestCost) {
              bestCost = fullCost;
              best = pose;
              bestOpen = approach;
            }
          }
        }
    }
    for (const [k, bone] of finger.bones.entries()) {
      rotations.set(bone, Array.from(best.subarray(k * 4, k * 4 + 4)));
      open.set(bone, Array.from(bestOpen.subarray(k * 4, k * 4 + 4)));
    }
  }
}

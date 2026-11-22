// sweepRobot: is a robot's whole motion clear, not just its two ends. It is conservative advancement (B. Mirtich, "Impulse-
// based dynamic simulation of rigid body systems", PhD thesis, UC Berkeley, 1996), with the per-link motion bound used to
// check robot paths by F. Schwarzer, M. Saha and J.-C. Latombe, "Exact collision checking of robot paths", WAFR 2002:
// if a shape stands `gap` from a static collider and no point of the shape moves faster than `speed`, the two cannot
// touch for `gap / speed` of the path's time, so the check may step that far and look again. No step can jump a wall,
// however thin. Written clean room from those publications. The same check for chains and hulls is sweepChain and
// sweepHull in @margoengine/kinematics-constraints/swept.
import type { ConstraintVolume } from '@margoengine/kinematics-constraints';
import type { SweepOptions, SweepResult } from '@margoengine/kinematics-constraints/swept';
import { advance, sweepSettings as settings } from '../../shared/swept-advance.js';
import type { Robot } from './robot.js';

export type { SweepOptions, SweepResult };

/** Settings of {@link sweepRobot}. */
export interface RobotSweepOptions extends SweepOptions {
  /** Also check the robot's shapes against each other (see `Robot.selfCollisionPairs`). Default false. */
  selfCollision?: boolean;
}

/**
 * Checks a robot's whole motion on the straight path in joint space from `from` to `to`, the path any joint-space
 * interpolation plays. A collider that stands between the ends is found, however fast the motion: the check never
 * steps past a contact. Colliders hold still during the check.
 *
 * @example
 * ```ts
 * import { CapsuleVolume } from '@margoengine/kinematics-constraints';
 * import { Robot, sweepRobot } from '@margoengine/robot-planning';
 *
 * const arm = new Robot({
 *   joints: [{ lower: -3, upper: 3 }],
 *   shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
 * });
 * const wall = new CapsuleVolume({ start: [0.7, 0.7, -1], end: [0.7, 0.7, 1], radius: 0.01 });
 * const hit = sweepRobot(arm, [0], [2], [wall]); // both ends are clear; the motion is not
 * if (!hit.clear) console.log('stop at', hit.time);
 * ```
 */
export function sweepRobot(
  robot: Robot,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  colliders: readonly ConstraintVolume[],
  options?: RobotSweepOptions,
): SweepResult {
  const { minClearance, tolerance, maxSteps } = settings(options),
    speed = robot.motionBounds(from, to),
    q = new Float64Array(robot.dof),
    self = options?.selfCollision === true;
  return advance(
    {
      count: robot.shapeCount,
      speed,
      place(t) {
        for (let i = 0; i < q.length; i++) q[i] = from[i] + (to[i] - from[i]) * t;
        robot.place(q);
      },
      gap: (shape, volume) => robot.shapeGap(shape, volume),
      pairs: self ? robot.selfCollisionPairs : undefined,
      pairGap: (a, b) => robot.pairGap(a, b),
    },
    colliders,
    minClearance,
    tolerance,
    maxSteps,
  );
}

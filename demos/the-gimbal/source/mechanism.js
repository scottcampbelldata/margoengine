// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { gimbalPose as solve } from '@margoengine/machinery/mechanisms';

const length = Math.hypot(.83,.38,-.40);
export const mountAxis = Object.freeze([.83/length,.38/length,-.40/length]);
export const roomAxis = Object.freeze([0,0,1]);

/** The mount tilted `degrees`; the rings hold the rotor on the room's +z unless `locked`. */
export function gimbalPose(degrees,locked) {
  const pose = solve(degrees*Math.PI/180, {mountAxis, target:roomAxis, locked});
  return {...pose, deviation: pose.deviation*180/Math.PI};
}

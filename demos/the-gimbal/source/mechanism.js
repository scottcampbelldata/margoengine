// This demo's mechanism: its dimensions and its motion from a stepped @margoengine/physics world
// (@margoengine/machinery/rigs), checked every step against @margoengine/machinery/mechanisms.
import { gimbalRig, keyedRig, openRig } from '@margoengine/machinery/rigs';

const length = Math.hypot(.83,.38,-.40);
export const mountAxis = Object.freeze([.83/length,.38/length,-.40/length]);
export const roomAxis = Object.freeze([0,0,1]);

/** Builds the gimbal on the solver, remade whenever its pivots are locked or freed; `signal` disposes it. */
export const openGimbal = (signal) => openRig(keyedRig, (locked, angle) => gimbalRig({mountAxis, target:roomAxis, locked, angle}), {signal});

/** The mount tilted `degrees` on the solver; the rings hold the rotor on the room's +z unless `locked`. */
export function gimbalPose(gimbal,degrees,locked) {
  const pose = gimbal.drive(degrees*Math.PI/180, locked, false);
  return {...pose, deviation: pose.deviation*180/Math.PI};
}

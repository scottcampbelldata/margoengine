// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { differentialPose, differentialSpeeds } from '@margoengine/machinery/mechanisms';

export const carrierRpm = 60;
export const sideTeeth = 20;
export const pinionTeeth = 14;
const halfTrack = .77;
const tightestRadius = 2.25;

/** Wheel and spider speeds in rpm with the steering at `steering` percent of full lock. */
export function speeds(steering) {
  const {left,right,spider} = differentialSpeeds(carrierRpm, {halfTrack, curvature: steering / (100 * tightestRadius), sideTeeth, pinionTeeth});
  return {left, right, spider};
}
export function gearPose(carrier, sideOffset) {
  // The even tooth counts give every opposed contact the same assembly phase: half a tooth puts a crest in a gap.
  const pose = differentialPose(carrier, sideOffset, {side: sideTeeth, pinion: pinionTeeth, phase: Math.PI});
  return {carrier: pose.carrier, left: pose.left, right: pose.right, pinions: pose.pinion};
}

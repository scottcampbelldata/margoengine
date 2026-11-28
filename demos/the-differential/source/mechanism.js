// This demo's mechanism: its dimensions, its speeds from @margoengine/machinery/mechanisms and its motion from a stepped
// @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the closed form.
import { differentialSpeeds } from '@margoengine/machinery/mechanisms';
import { differentialRig, openRig } from '@margoengine/machinery/rigs';

export const carrierRpm = 60;
export const sideTeeth = 20;
export const pinionTeeth = 14;
const halfTrack = .77;
const tightestRadius = 2.25;

const curvature = (steering) => steering / (100 * tightestRadius);

/** Wheel and spider speeds in rpm with the steering at `steering` percent of full lock. */
export function speeds(steering) {
  const {left,right,spider} = differentialSpeeds(carrierRpm, {halfTrack, curvature: curvature(steering), sideTeeth, pinionTeeth});
  return {left, right, spider};
}

/** Builds the differential on the solver, the road under the left wheel turning at the steering's speed; `signal` disposes it. */
export const openGears = (steering, signal) => openRig(differentialRig, {sideTeeth, pinionTeeth, split: halfTrack * curvature(steering), signal});

/** Sets the steering the road now follows. */
export const steer = (gears, steering) => gears.setSplit(halfTrack * curvature(steering));

/** Turns the carrier to `carrier` radians on the solver and returns the angles the cutaway draws. */
export function gearPose(gears, carrier) {
  const pose = gears.drive(carrier);
  // The even tooth counts give every opposed contact the same assembly phase: half a tooth puts a crest in a gap.
  return {carrier: pose.carrier, left: pose.left, right: pose.right, pinions: pose.pinion + Math.PI / pinionTeeth};
}

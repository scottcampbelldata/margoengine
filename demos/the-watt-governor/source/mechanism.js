// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { wattGovernorEquilibrium } from '@margoengine/machinery/mechanisms';

export const minRpm=58,maxRpm=112;
export const ballArm=.292;
export const pickoff=.198;
export const linkLength=.232;
export const pivotHeight=.705;

function geometry(rpm) {
  const e=wattGovernorEquilibrium(rpm*2*Math.PI/60,{arm:ballArm,pickoff,link:linkLength});
  return {theta:e.angle,ballX:e.radius,ballY:pivotHeight-e.drop,jointRadius:e.joint[0],jointY:pivotHeight-e.joint[1],
    sleeveY:pivotHeight-e.sleeve};
}

export const lowSleeve=geometry(minRpm).sleeveY;
export const highSleeve=geometry(maxRpm).sleeveY;
/** The sleeve's rack turns the throttle a quarter turn over the speed range. */
export const rackPitchRadius=(highSleeve-lowSleeve)/(Math.PI*.5);

export function governorPose(rpm) {
  const pose=geometry(rpm);
  const travel=pose.sleeveY-lowSleeve;
  const valveAngle=travel/rackPitchRadius;
  return {...pose,travel,valveAngle,opening:1-Math.sin(valveAngle)};
}

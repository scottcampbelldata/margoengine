// This demo's mechanism: its dimensions, its rest poses from @margoengine/machinery/mechanisms and its motion from a stepped
// @margoengine/physics world (@margoengine/machinery/rigs), checked every step against Maxwell's equilibrium.
import { wattGovernorEquilibrium } from '@margoengine/machinery/mechanisms';
import { openRig, wattGovernorRig } from '@margoengine/machinery/rigs';

export const minRpm=58,maxRpm=112;
export const ballArm=.292;
export const pickoff=.198;
export const linkLength=.232;
export const pivotHeight=.705;

const sleeveAt=(rpm)=>pivotHeight-wattGovernorEquilibrium(rpm*2*Math.PI/60,{arm:ballArm,pickoff,link:linkLength}).sleeve;

export const lowSleeve=sleeveAt(minRpm);
export const highSleeve=sleeveAt(maxRpm);
/** The sleeve's rack turns the throttle a quarter turn over the speed range. */
export const rackPitchRadius=(highSleeve-lowSleeve)/(Math.PI*.5);

/** Builds the governor spinning at `rpm` on the solver, the arms already at their balance; `signal` disposes it. */
export const openGovernor=(rpm,signal)=>openRig(wattGovernorRig,{arm:ballArm,pickoff,link:linkLength,rpm,signal});

/** The drawn poses from the solver's: the balls, the link's joint and the sleeve, then the sleeve's rise and the valve. */
export function governorPose(rig) {
  const pose={ballX:rig.radius,ballY:pivotHeight-rig.drop,jointRadius:rig.joint[0],jointY:pivotHeight-rig.joint[1],
    sleeveY:pivotHeight-rig.sleeve};
  const travel=pose.sleeveY-lowSleeve;
  const valveAngle=travel/rackPitchRadius;
  return {...pose,travel,valveAngle,opening:1-Math.sin(valveAngle)};
}

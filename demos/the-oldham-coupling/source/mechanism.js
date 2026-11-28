// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { oldhamPose } from '@margoengine/machinery/mechanisms';

export const maxOffset=.104;
export const hubRadius=.139;
export const tongueHalfLength=.088;
export const tongueHalfWidth=.015;
export const grooveHalfWidth=.0164;

export function couplingPose(degrees,offset) {
  const angle=degrees*Math.PI/180, pose=oldhamPose(angle,offset);
  return {inputAngle:angle,outputAngle:pose.output,diskAngle:pose.disc,center:pose.center,orbitCenter:pose.orbitCenter,
    orbitRadius:pose.orbitRadius,inputSlide:pose.inputSlide,outputSlide:pose.outputSlide};
}

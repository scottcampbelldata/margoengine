// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { reuleauxOutline, reuleauxPose } from '@margoengine/machinery/mechanisms';

export const width=.456;
export const directions=[[1,0],[0,1],[-1,0],[0,-1]];
export const camOutline=(subdivisions=78)=>reuleauxOutline(width,subdivisions);

export function drivePose(degrees) {
  const angle=degrees*Math.PI/180, {center,contacts}=reuleauxPose(angle,width);
  return {angle,center,contacts};
}

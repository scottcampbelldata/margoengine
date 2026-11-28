// This demo's mechanism: its dimensions, the closed-form centre path from @margoengine/machinery/mechanisms and its motion from a
// stepped @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the closed form.
import { reuleauxOutline, reuleauxPose } from '@margoengine/machinery/mechanisms';
import { openRig, reuleauxRig } from '@margoengine/machinery/rigs';

export const width=.456;
export const directions=[[1,0],[0,1],[-1,0],[0,-1]];
export const camOutline=(subdivisions=78)=>reuleauxOutline(width,subdivisions);

/** The exact centre path, which the drawn trace follows. */
export function drivePose(degrees) {
  const angle=degrees*Math.PI/180, {center,contacts}=reuleauxPose(angle,width);
  return {angle,center,contacts};
}

/** Builds the drive on the solver at `degrees`; `signal` disposes it. */
export const openDrive=(degrees,signal)=>openRig(reuleauxRig,width,{angle:degrees*Math.PI/180,signal});

/** The cam turned to `degrees` on the solver: its centre and its four wall contacts. */
export function solvedPose(drive,degrees) {
  const {angle,center,contacts}=drive.drive(degrees*Math.PI/180,false);
  return {angle,center,contacts};
}

// This demo's mechanism: its dimensions, its open stroke from @margoengine/machinery/mechanisms and its motion from a stepped
// @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the closed form.
import { togglePressPose } from '@margoengine/machinery/mechanisms';
import { openRig, togglePressRig } from '@margoengine/machinery/rigs';

export const linkLength=.231;
export const pivotY=.767;
export const openAngle=52, stopAngle=8;
const radians=Math.PI/180;
export const openOffset=linkLength*Math.sin(openAngle*radians);
export const stopOffset=linkLength*Math.sin(stopAngle*radians);
export const kneeTravel=openOffset-stopOffset;
const openRam=togglePressPose(openOffset,linkLength).ram;

/** The links' angle from the vertical with the knee `progress` (0 to 1) of the way from open to the stop. */
const linkAngle=(progress)=>Math.asin((openOffset-kneeTravel*progress)/linkLength);

/** Builds the press on the solver at `progress` of the stroke; `signal` disposes it. */
export const openPress=(progress,signal)=>openRig(togglePressRig,linkLength,{angle:linkAngle(progress),signal});

/** Turns the press to `progress` of the stroke on the solver and returns the drawn pose. */
export function pressPose(press,progress) {
  const {knee,drop,ram,angle,advantage}=press.drive(linkAngle(progress),false);
  return {input:kneeTravel*progress,kneeX:knee,kneeY:pivotY-drop,ramY:pivotY-ram,angle:angle/radians,descent:ram-openRam,advantage};
}

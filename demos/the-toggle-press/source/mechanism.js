// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { togglePressPose } from '@margoengine/machinery/mechanisms';

export const linkLength=.231;
export const pivotY=.767;
export const openAngle=52, stopAngle=8;
const radians=Math.PI/180;
export const openOffset=linkLength*Math.sin(openAngle*radians);
export const stopOffset=linkLength*Math.sin(stopAngle*radians);
export const kneeTravel=openOffset-stopOffset;
const openRam=togglePressPose(openOffset,linkLength).ram;

export function pressPose(progress) {
  const input=kneeTravel*progress, kneeX=openOffset-input;
  const {drop,ram,angle,advantage}=togglePressPose(kneeX,linkLength);
  return {input,kneeX,kneeY:pivotY-drop,ramY:pivotY-ram,angle:angle/radians,descent:ram-openRam,advantage};
}

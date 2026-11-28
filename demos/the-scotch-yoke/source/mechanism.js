// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { scotchYokePose } from '@margoengine/machinery/mechanisms';

export const crankRadius=.142;
export const rollerRadius=.019;
export const slotHalfWidth=.021;
export const slotHalfHeight=.168;
export const slotEndRadius=.021;

export function yokePose(degrees) {
  const angle=degrees*Math.PI/180, {slide,slot}=scotchYokePose(angle,crankRadius);
  return {angle,x:slide,y:slot};
}

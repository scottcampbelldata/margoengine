// This demo's mechanism: its dimensions, and its pose from @margoengine/machinery/mechanisms.
import { roseEnginePose, rosetteModulation } from '@margoengine/machinery/mechanisms';

export const rosettes=[
  {lobes:6,amplitude:.015,overtone:.0028},
  {lobes:9,amplitude:.0125,overtone:.0022},
];
export const camRadius=.198;
export const toolX=.125;

export const modulation=(rosette,angle)=>rosetteModulation(rosette,angle);
/** The cut at work angle `angle`: the pose of the spindle turned to -angle. */
export const cutAt=(rosette,angle,baseRadius=toolX)=>roseEnginePose(-angle,rosette,baseRadius).cut;

export function spindlePose(degrees,rosette) {
  const angle=degrees*Math.PI/180, {shift,contact,cut}=roseEnginePose(angle,rosette,toolX);
  return {angle,shift,contactAngle:contact,cut,period:360/rosette.lobes};
}

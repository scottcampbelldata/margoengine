// This demo's mechanism: its dimensions, the closed-form cut from @margoengine/machinery/mechanisms and its motion from a stepped
// @margoengine/physics world (@margoengine/machinery/rigs), checked every step against the closed form.
import { roseEnginePose, rosetteModulation } from '@margoengine/machinery/mechanisms';
import { keyedRig, openRig, roseEngineRig } from '@margoengine/machinery/rigs';

export const rosettes=[
  {lobes:6,amplitude:.015,overtone:.0028},
  {lobes:9,amplitude:.0125,overtone:.0022},
];
export const camRadius=.198;
export const toolX=.125;

export const modulation=(rosette,angle)=>rosetteModulation(rosette,angle);
/** The cut at work angle `angle`: the pose of the spindle turned to -angle. */
export const cutAt=(rosette,angle,baseRadius=toolX)=>roseEnginePose(-angle,rosette,baseRadius).cut;

/** Builds the engine on the solver, remade for each rosette; `signal` disposes it. */
export const openEngine=(signal)=>openRig(keyedRig,(rosette,angle)=>roseEngineRig(rosette,{toolRadius:toolX,angle}),{signal});

/** The spindle turned to `degrees` on the solver with `rosette` fitted: the rock, the contact and the cut. */
export function spindlePose(engine,degrees,rosette) {
  const {angle,shift,contact,cut}=engine.drive(degrees*Math.PI/180,rosette,false);
  return {angle,shift,contactAngle:contact,cut,period:360/rosette.lobes};
}

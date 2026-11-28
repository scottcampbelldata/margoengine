// The teaching ram's dimensions and valve settings. The lumped cycle (drive column, waste and check valves, air
// vessel and riser) is integrated by @margoengine/physics/hydraulics (`HydraulicRam`).
import { HydraulicRam, ramFrameAt, water as waterAt } from '@margoengine/physics/hydraulics';

export const gravity=9.80665;
export const liquid=waterAt(20);
export const supplyHead=1.6;
export const atmosphericPressure=101325;
export const chamberVolume=.00230;
export const exponent=1.24;
export const compliance=7.5e-10;
export const minimumLift=2.6;
export const maximumLift=5.8;
export const fixedStep=.00075;

const rig=(vesselWater,step=fixedStep)=>new HydraulicRam({
  supplyHead,driveLength:8,driveDiameter:.042,driveResistance:1.14e10,compliance,
  waste:{conductance:1.90e-5,tripFlow:.000788,closeTime:.036,holdTime:.090,reopenPressure:4900,reopenTime:.055},
  checkConductance:5.05e-6,deliveryConductance:3.55e-6,
  vessel:{volume:chamberVolume,exponent},atmosphere:atmosphericPressure,step,
  initial:{pressure:1700,driveFlow:.0001,vesselWater},liquid,gravity,
});
const probe=rig(0);

/** Gauge pressure of the vessel's air with `water` m³ of water under it, Pa. */
export const gasPressure=water=>probe.airPressure(water);

// Each lift starts from the vessel charged a little above its riser's head, then runs until the cycle repeats.
function integrate(lift,step=fixedStep) {
  const head=liquid.density*gravity*lift;
  const cycle=rig(probe.vesselWaterAt(head+875),step).settle(lift);
  return {
    lift,frames:cycle.frames,seconds:cycle.period,cycle,
    meanDelivery:60000*cycle.meanDelivery,
    meanWaste:60000*cycle.meanWaste,
    efficiency:cycle.efficiency,
  };
}

const cache=new Map();
export function solve(lift) {
  const head=Math.max(minimumLift,Math.min(maximumLift,lift));
  if(!cache.has(head))cache.set(head,integrate(head));
  return cache.get(head);
}
export function verifyAtStep(lift,step) {return integrate(lift,step);}
export const sample=(model,time)=>ramFrameAt(model.cycle,time);

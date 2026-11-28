// The Pelton bench's dimensions. The runner's momentum theory (jet speed, force, torque, power and efficiency) and
// the free flight of the deflected water come from @margoengine/physics/hydraulics.
import { jetPoint, peltonRunner, water } from '@margoengine/physics/hydraulics';

export const gravity=9.80665;
export const liquid=water(20);
export const netHead=8.60;
export const nozzleRadius=.0085;
export const runnerRadius=.167;
export const nozzleCoefficient=.978;
export const relativeRetention=.90;
export const returnAngle=18*Math.PI/180;
export const bucketCount=16;
export const maximumRpm=700;
export const tau=2*Math.PI;
export const wheelCenter=[.132,.318,0];
export const jetHeight=wheelCenter[1]+runnerRadius;

const runner=rpm=>peltonRunner({
  netHead,nozzleDiameter:2*nozzleRadius,pitchRadius:runnerRadius,nozzleCoefficient,
  bucketRetention:relativeRetention,exitAngle:returnAngle,rpm,liquid,gravity,
});
const still=runner(0);
export const jetSpeed=still.jetSpeed;
export const flow=still.flow;
export const massFlow=still.massFlow;
export const hydraulicPower=still.hydraulicPower;
export const optimumRpm=still.optimumRpm;

export function impulse(input) {
  const state=runner(Math.max(0,Math.min(maximumRpm,input)));
  return {
    rpm:state.rpm,omega:state.omega,rim:state.bucketSpeed,incoming:state.relativeSpeed,
    tangential:state.leavingAxial,transverse:state.leavingTransverse,
    force:state.force,torque:state.torque,power:state.power,efficiency:state.efficiency,
  };
}

/** Where water thrown from a bucket's `side` (+1 or -1) is `time` s after it leaves. */
export function deflected(model,time,side) {
  const lateral=model.transverse*.78;
  const down=model.transverse*Math.sqrt(1-.78**2);
  return jetPoint([wheelCenter[0],jetHeight,side*.039],[model.tangential,-down,side*lateral],time,gravity);
}

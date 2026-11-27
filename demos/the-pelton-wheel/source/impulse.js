export const gravity=9.80665;
export const density=998.2;
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
export const jetSpeed=nozzleCoefficient*Math.sqrt(2*gravity*netHead);
export const flow=Math.PI*nozzleRadius**2*jetSpeed;
export const massFlow=density*flow;
export const hydraulicPower=massFlow*gravity*netHead;
export const optimumRpm=30*jetSpeed/(tau*runnerRadius);

export function impulse(input) {
  const rpm=Math.max(0,Math.min(maximumRpm,input));
  const omega=rpm*tau/60;
  const rim=runnerRadius*omega;
  const incoming=jetSpeed-rim;
  const leaving=relativeRetention*incoming;
  const reverse=leaving*Math.cos(returnAngle);
  const transverse=leaving*Math.sin(returnAngle);
  const tangential=rim-reverse;
  const force=massFlow*(jetSpeed-tangential);
  const torque=runnerRadius*force;
  const power=torque*omega;
  return {rpm,omega,rim,incoming,tangential,transverse,force,torque,power,efficiency:power/hydraulicPower};
}

export function deflected(model,time,side) {
  const lateral=model.transverse*.78;
  const down=model.transverse*Math.sqrt(1-.78**2);
  return [wheelCenter[0]+model.tangential*time,jetHeight-down*time-.5*gravity*time*time,side*(.039+lateral*time)];
}
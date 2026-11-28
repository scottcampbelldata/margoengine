export const tau = 2*Math.PI;
export const degrees = 26;
export const incline = degrees*Math.PI/180;
export const vertical = Math.sin(incline);
export const across = Math.cos(incline);
export const pitch = .348;
export const run = 1.43;
export const shellRadius = .175;
export const shaftRadius = .061;
export const phaseRate = (rpm) => rpm*tau/60;
export const lift = run*vertical;
export const risePerTurn = pitch*vertical;
export const lead = pitch/tau;
const rad = Math.min(1,lead*vertical/(shaftRadius*across));
const critical = Math.PI-Math.asin(rad);
const shaftHeight = theta => lead*theta*vertical + shaftRadius*across*Math.cos(theta);
export const fillLevel = Math.min(shaftHeight(0),shaftHeight(tau),shaftHeight(critical))-.0028;

export function wetSection(theta) {
  const radial = Math.cos(theta)*across;
  if(radial >= 0) return null;
  const start = lead*theta;
  const depth = Math.min(pitch,(fillLevel-start*vertical-shellRadius*radial)/vertical);
  if(depth <= 0) return null;
  return {start,depth,inner: (fillLevel-start*vertical)/radial,growth: -vertical/radial};
}

export function bucketVolume(steps=1600) {
  let sum = 0;
  const delta=tau/steps;
  for(let i=0;i<steps;i++) {
    const section=wetSection((i+.5)*delta);
    if(!section) continue;
    const {depth,inner,growth}=section;
    sum += .5*(shellRadius**2*depth -
      (inner**2*depth + inner*growth*depth**2 + growth**2*depth**3/3));
  }
  return sum*delta;
}

export const litersPerTurn = 1000*bucketVolume();
export const read = (speed) => {
  const rpm=Math.max(0,Math.min(55,speed));
  return {rpm,litersPerMinute:litersPerTurn*rpm,travel:pitch*rpm/60};
};
export function phaseInTurn(angle) {
  return (angle%tau+tau)%tau;
}
export const gravity=9.80665;
export const freshDensity=1002;
export const saltDensity=1023;
export const reducedGravity=gravity*(saltDensity-freshDensity)/freshDensity;
export const channelDepth=4.6;
export const channelWidth=70;
export const drag=.0038;
export const minDischarge=80;
export const maxDischarge=146;
export const upstream=676;
export const mouthX=.470;
export const seaX=.804;
export const planScale=.00168;
export const bed=.117;
export const surface=.248;
export const nearZ=.071;
export const farZ=nearZ-channelWidth*planScale;
export const leftX=mouthX-upstream*planScale;

function primitive(s,f2){
  return s**4/4-s**5/5-f2*(s-s*s/2);
}
export function distanceAt(model,s){
  return model.distanceScale*(primitive(s,model.f2)-model.zero);
}
export function solve(input){
  const discharge=Math.max(minDischarge,Math.min(maxDischarge,input));
  const flow=discharge/channelWidth;
  const froude=flow/Math.sqrt(reducedGravity*channelDepth**3),f2=froude*froude;
  const mouthFraction=Math.cbrt(f2);
  const zero=primitive(mouthFraction,f2);
  const distanceScale=channelDepth/(drag*f2);
  const model={discharge,flow,froude,f2,mouthFraction,zero,distanceScale};
  return {...model,length:distanceAt(model,1),mouthSalt:channelDepth*(1-mouthFraction)};
}
export function fractionAt(model,distance){
  if(distance<=0)return model.mouthFraction;
  if(distance>=model.length)return 1;
  let low=model.mouthFraction,high=1;
  for(let i=0;i<32;i++){
    const a=(low+high)*.5;
    if(distanceAt(model,a)<distance)low=a;
    else high=a;
  }
  return .5*(low+high);
}
export const position=distance=>mouthX-distance*planScale;
export const interfaceY=s=>bed+(surface-bed)*(1-s);

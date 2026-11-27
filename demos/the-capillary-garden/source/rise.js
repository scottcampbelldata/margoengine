export const gravity=9.80665;
export const density=1130;
export const viscosity=.022;
export const tension=.068;
export const immersion=.022;
export const radii=[.00015,.00021,.00029,.00040,.00059];
export const minimumAngle=12;
export const maximumAngle=70;
export const referenceY=.101;
export const playback=5;
export const boreMagnification=12;
export const positions=[-.149,-.075,0,.075,.149];

export function prepare(input){
  const angle=Math.max(minimumAngle,Math.min(maximumAngle,input));
  const wetting=Math.cos(angle*Math.PI/180);
  const tubes=radii.map(radius=>{
    const capillaryPressure=2*tension*wetting/radius;
    const heightLimit=capillaryPressure/(density*gravity);
    const timeScale=8*viscosity*(heightLimit+immersion)/(density*gravity*radius**2);
    return {radius,heightLimit,timeScale,ratio:heightLimit/(heightLimit+immersion),capillaryPressure};
  });
  return {angle,tubes};
}

export function heightAt(tube,seconds){
  const time=Math.max(0,seconds)/tube.timeScale;
  if(time===0)return 0;
  if(time>36)return tube.heightLimit;
  let lower=0,upper=1;
  for(let i=0;i<37;i++){
    const mid=(lower+upper)*.5;
    const timeAt=-Math.log1p(-mid)-tube.ratio*mid;
    if(timeAt>time)upper=mid;
    else lower=mid;
  }
  return tube.heightLimit*(lower+upper)*.5;
}

export function timeAt(tube,height){
  const fraction=Math.max(0,height/tube.heightLimit);
  if(fraction>=1)return Infinity;
  return tube.timeScale*(-Math.log1p(-fraction)-tube.ratio*fraction);
}

export const gravity=9.80665;
export const width=.28;
export const upstreamDepth=.028;
export const bed=.263;
export const minimumSpeed=2.4;
export const maximumSpeed=3.9;
export const jumpToe=-.504;
export const inlet=-1.414;
export const outlet=1.355;

export function solve(input){
  const speed=Math.max(minimumSpeed,Math.min(maximumSpeed,input));
  const f1=speed/Math.sqrt(gravity*upstreamDepth);
  const downstreamDepth=upstreamDepth*(Math.hypot(1,Math.sqrt(8)*f1)-1)/2;
  const discharge=width*upstreamDepth*speed;
  const downstreamSpeed=discharge/(width*downstreamDepth);
  const f2=downstreamSpeed/Math.sqrt(gravity*downstreamDepth);
  const head=upstreamDepth+speed*speed/(2*gravity);
  const depthRise=downstreamDepth-upstreamDepth;
  const loss=depthRise**3/(4*upstreamDepth*downstreamDepth);
  const roller=4.5*depthRise;
  return {speed,f1,downstreamDepth,downstreamSpeed,f2,discharge,head,loss,
    dissipation:loss/head,depthRise,roller,end:jumpToe+roller};
}

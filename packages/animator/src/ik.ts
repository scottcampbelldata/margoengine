import type {Vec3} from '@margoengine/core/extension';
import {finiteVector} from '@margoengine/math/validate';
const subtract=(a:Vec3,b:Vec3)=>a.map((v,i)=>v-b[i]) as [number,number,number];
export function solveTwoBoneIK(root:Vec3,knee:Vec3,ankle:Vec3,target:Vec3,pole:Vec3):{knee:Vec3;ankle:Vec3} {
  for(const v of [root,knee,ankle,target,pole])finiteVector(v,3,'IK point');
  const upper=Math.hypot(...subtract(knee,root)),lower=Math.hypot(...subtract(ankle,knee));if(upper<=1e-8||lower<=1e-8)throw new RangeError('IK bones have zero length');
  let axis=subtract(target,root),distance=Math.hypot(...axis);if(distance<1e-8){axis=subtract(ankle,root);distance=Math.hypot(...axis);if(distance<1e-8){axis=subtract(knee,root);distance=upper;}}
  axis=axis.map(v=>v/distance) as [number,number,number];const reach=Math.max(Math.abs(upper-lower)+1e-8,Math.min(upper+lower-1e-8,Math.hypot(...subtract(target,root))));
  const bend=subtract(pole,root),dot=bend.reduce((sum,v,i)=>sum+v*axis[i],0);let normal=bend.map((v,i)=>v-dot*axis[i]),length=Math.hypot(...normal);
  if(length<1e-8){const fallback=Math.abs(axis[1])<0.9?[0,1,0]:[1,0,0],d=fallback.reduce((sum,v,i)=>sum+v*axis[i],0);normal=fallback.map((v,i)=>v-d*axis[i]);length=Math.hypot(...normal);}
  const along=(upper*upper+reach*reach-lower*lower)/(2*reach),height=Math.sqrt(Math.max(0,upper*upper-along*along));
  return {knee:root.map((v,i)=>v+axis[i]*along+normal[i]/length*height) as [number,number,number],ankle:root.map((v,i)=>v+axis[i]*reach) as [number,number,number]};
}
export function rotationBetween(from:Vec3,to:Vec3):number[] {
  const aLength=Math.hypot(...from),bLength=Math.hypot(...to);if(aLength<1e-8||bLength<1e-8)throw new RangeError('Zero IK direction');const a=from.map(v=>v/aLength),b=to.map(v=>v/bLength),dot=a.reduce((sum,v,i)=>sum+v*b[i],0);
  let q=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0],1+dot];
  if(dot<-0.999999){const axis=Math.abs(a[0])<0.9?[1,0,0]:[0,1,0];q=[a[1]*axis[2]-a[2]*axis[1],a[2]*axis[0]-a[0]*axis[2],a[0]*axis[1]-a[1]*axis[0],0];}
  const length=Math.hypot(...q);return q.map(v=>v/length);
}

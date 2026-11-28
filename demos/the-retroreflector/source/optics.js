import { cornerCubeReflect } from '@margoengine/optics/imaging';
import { add, dot, normalize as unit, scale, sub as subtract } from '@margoengine/math/vec3';

export const aperture=.144;
export const arcRadius=.89;
export const rise=.094;
export const minAngle=-25;
export const maxAngle=25;
export const entry=Object.freeze([.238,.318,.444].map((fraction)=>aperture*fraction));
export const mirrorCenter=Object.freeze([0,.570,-.486]);

const root2=Math.sqrt(2),root3=Math.sqrt(3),root6=Math.sqrt(6);
export const axes=Object.freeze([
  Object.freeze([1/root2,-1/root2,0]),
  Object.freeze([1/root6,1/root6,-2/root6]),
  Object.freeze([1/root3,1/root3,1/root3]),
]);
export { add, dot, scale, subtract, unit };
export const addScaled=(a,b,t)=>add(a,scale(b,t));

export function directionToWorld(local){
  return axes.map((axis)=>dot(axis,local));
}
function directionToLocal([x,y,z]){
  return axes[0].map((a,i)=>x*a+y*axes[1][i]+z*axes[2][i]);
}
export function pointToWorld(local){
  return addScaled(add(mirrorCenter,directionToWorld(local)),[0,0,1],-aperture/root3);
}

export function traceRetroreflector(degrees){
  const azimuth=degrees*Math.PI/180;
  const relative=[arcRadius*Math.sin(azimuth),rise,arcRadius*Math.cos(azimuth)];
  const lamp=add(pointToWorld(entry),relative);
  const incoming=scale(unit(directionToLocal(relative)),-1);
  const trace=cornerCubeReflect(entry,incoming,aperture);
  if(!trace)throw new Error('Ray did not reach the entrance plane');
  const {hits,exit}=trace,direction=[...trace.direction];
  const outgoing=directionToWorld(direction);
  const exitWorld=pointToWorld(exit);
  const receiver=addScaled(exitWorld,outgoing,dot(subtract(lamp,exitWorld),outgoing));
  return {lamp,incoming,hits,exit,direction,outgoing,receiver,offset:Math.hypot(...subtract(receiver,lamp))};
}

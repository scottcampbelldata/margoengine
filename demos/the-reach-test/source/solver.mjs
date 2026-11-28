import { CapsuleVolume, ConvexHullVolume } from '@margoengine/kinematics-constraints';
import { ChainAvoidanceSolver } from '@margoengine/kinematics-constraints/chain';
import { sweepChain } from '@margoengine/kinematics-constraints/swept';

export const startPose = [[0,.64,0],[-.21,1.12,.04],[-.49,1.36,.15],[-.74,1.47,.23]];
export const gauges = {
  post: {a:[.29,.30,.25],b:[.29,1.27,.25],radius:.14},
  block: {center:[-.34,.51,.66],size:[.41,.52,.36]},
};
export const radii = [.087,.072,.061];
export const jointRadii = [.087,.088,.072,.066];
export const minClearance = .017;
export const presets = [[-.53,1.54,.15],[.61,1.35,.03],[.29,1.10,.25],[-.59,1.33,-.09]];
const {center:[x,y,z],size:[w,h,d]}=gauges.block;
const corners=[];
for(const i of [-1,1])for(const j of [-1,1])for(const k of [-1,1])corners.push([x+i*w/2,y+j*h/2,z+k*d/2]);
const colliders = [new CapsuleVolume({start:gauges.post.a,end:gauges.post.b,radius:gauges.post.radius}),new ConvexHullVolume({points:corners.flat()})];
const options={radius:radii,jointRadius:jointRadii,minClearance,tolerance:.0004,maxSteps:180};
let pathFrom;

function clearances(pose) {
  return colliders.map(collider=>{
    let gap=Infinity;
    for(let i=0;i<radii.length;i++)gap=Math.min(gap,collider.segmentClearance(pose[i],pose[i+1],radii[i]));
    for(let i=0;i<jointRadii.length;i++)gap=Math.min(gap,collider.segmentClearance(pose[i],pose[i],jointRadii[i]));
    return gap;
  });
}
const chain=new ChainAvoidanceSolver(colliders,{
  algorithm:'fabrik',radius:radii,minClearance,tolerance:.00025,iterations:24,candidates:24,
  acceptPose:pose=>clearances(pose).every(gap=>gap>=minClearance)&&sweepChain(pathFrom,pose,colliders,options).clear,
});
const subtract=(a,b)=>a.map((x,i)=>x-b[i]);
const length=v=>Math.hypot(...v);
const scaled=(v,s)=>v.map(n=>n*s);
const unit=v=>scaled(v,1/length(v));
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const sum=(a,b)=>a.map((n,i)=>n+b[i]);
const distance=(a,b)=>length(subtract(a,b));
const root=startPose[0];
const radius=startPose.slice(1).reduce((sum,p,i)=>sum+distance(p,startPose[i]),0);

export function stepReach(pose,requested,dt) {
  const from=pose.at(-1);
  const displacement=subtract(requested,from);
  const delta=Math.min(length(displacement),dt*.82);
  if(delta<.00018)return report(pose,requested,'Reached');
  const direct=sum(from,scaled(unit(displacement),delta));
  const inner=subtract(direct,root);
  if(length(inner)>radius-.014)return report(pose,requested,'Reach limit');
  pathFrom=pose;
  const gapToTarget=Math.min(...colliders.map(c=>c.segmentClearance(requested,requested,jointRadii.at(-1))));
  const directAttempt=chain.solve(pose,direct);
  if(directAttempt.resolved)return report(directAttempt.joints,requested,'Reaching');
  if(gapToTarget<minClearance)return report(pose,requested,'Target obstructed');
  const dirs=[[0,0,-1],[0,.70,-.70],[0,-.8,-.6],[0,0,1]];
  for(const direction of dirs){
    const toward=sum(scaled(unit(displacement),.34),direction);
    const step=sum(from,scaled(unit(toward),delta*.76));
    const detour=chain.solve(pose,step);
    if(detour.resolved)return report(detour.joints,requested,'Curving around');
  }
  return report(pose,requested,'Holding clearance');
}
export function report(pose,requested,status) {
  const gaps=clearances(pose);
  const gap=Math.min(...gaps);
  return {pose,miss:distance(pose.at(-1),requested),gap,near:gaps[0]<gaps[1]?'Capsule post':'Convex block',status};
}

export function between(from,to,t) {
  if(t<=0)return from;
  if(t>=1)return to;
  const pose=[from[0]];
  for(let i=1;i<from.length;i++){
    const length0=distance(from[i],from[i-1]),length1=distance(to[i],to[i-1]);
    const u=unit(subtract(from[i],from[i-1]));
    const v=unit(subtract(to[i],to[i-1]));
    const cosine=Math.max(-1,Math.min(1,dot(u,v)));
    const turn=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const sine=length(turn);
    const theta=Math.atan2(sine,cosine);
    let direction=u;
    if(theta>1e-12){
      // Antiparallel links use the same axis convention as the swept check.
      const axis=sine>1e-12?unit(turn):unit(Math.abs(u[0])<.7?[0,-u[2],u[1]]:[-u[2],0,u[0]]);
      const tangent=[axis[1]*u[2]-axis[2]*u[1],axis[2]*u[0]-axis[0]*u[2],axis[0]*u[1]-axis[1]*u[0]];
      direction=sum(scaled(u,Math.cos(t*theta)),scaled(tangent,Math.sin(t*theta)));
    }
    pose.push(sum(pose[i-1],scaled(direction,length0+(length1-length0)*t)));
  }
  return pose;
}

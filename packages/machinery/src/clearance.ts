import {meshRuntime} from '@margoengine/core/extension';
import type {Mesh,Vec3} from '@margoengine/core';
interface Bounds {center:number[];axes:number[][];half:number[];corners:number[][]}
const dot=(a:readonly number[],b:readonly number[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:readonly number[],b:readonly number[])=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:readonly number[],b:readonly number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function bounds(node:Mesh,kind:'aabb'|'obb'):Bounds {
  node.check();const g=node.geometry;if(!g)throw new TypeError('Clearance requires geometry');const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],m=meshRuntime(node).matrix;
  for(let i=0;i<g.vertices.length;i+=6)for(let a=0;a<3;a++){min[a]=Math.min(min[a],g.vertices[i+a]);max[a]=Math.max(max[a],g.vertices[i+a]);}
  const local=min.map((v,a)=>(v+max[a])/2),center=[0,1,2].map(a=>m[a]*local[0]+m[4+a]*local[1]+m[8+a]*local[2]+m[12+a]),axes=[0,1,2].map(a=>[m[a*4],m[a*4+1],m[a*4+2]]),half=min.map((v,a)=>(max[a]-v)/2*Math.hypot(...axes[a]));
  for(const axis of axes){const length=Math.hypot(...axis);if(!length||!Number.isFinite(length))throw new RangeError('Invalid clearance transform');for(let a=0;a<3;a++)axis[a]/=length;}
  if(kind==='obb'&&[dot(axes[0],axes[1]),dot(axes[0],axes[2]),dot(axes[1],axes[2])].some(v=>Math.abs(v)>1e-5))throw new RangeError('OBB clearance requires orthogonal transforms; use AABB for shear');
  if(kind==='aabb'){const extent=[0,1,2].map(a=>axes.reduce((sum,axis,i)=>sum+Math.abs(axis[a])*half[i],0));half.splice(0,3,...extent);axes.splice(0,3,[1,0,0],[0,1,0],[0,0,1]);}
  const corners=Array.from({length:8},(_,i)=>center.map((v,a)=>v+axes.reduce((sum,axis,j)=>sum+axis[a]*half[j]*(i&(1<<j)?1:-1),0)));return {center,axes,half,corners};
}
function closest(p:number[],box:Bounds):number[] {const delta=sub(p,box.center),out=box.center.slice();for(let a=0;a<3;a++){const t=Math.max(-box.half[a],Math.min(box.half[a],dot(delta,box.axes[a])));for(let j=0;j<3;j++)out[j]+=t*box.axes[a][j];}return out;}
function segment(a:number[],b:number[],c:number[],d:number[]):[number[],number[]] {
  const u=sub(b,a),v=sub(d,c),r=sub(a,c),aa=dot(u,u),bb=dot(v,v),f=dot(v,r);let s=0,t=0;
  if(aa<=1e-30&&bb<=1e-30)return [a,c];
  if(aa<=1e-30)t=Math.max(0,Math.min(1,f/bb));else {const e=dot(u,r);if(bb<=1e-30)s=Math.max(0,Math.min(1,-e/aa));else {const uv=dot(u,v),den=aa*bb-uv*uv;s=den>1e-30?Math.max(0,Math.min(1,(uv*f-e*bb)/den)):0;t=(uv*s+f)/bb;if(t<0){t=0;s=Math.max(0,Math.min(1,-e/aa));}else if(t>1){t=1;s=Math.max(0,Math.min(1,(uv-e)/aa));}}}
  return [a.map((x,i)=>x+u[i]*s),c.map((x,i)=>x+v[i]*t)];
}
export interface Clearance {distance:number;interfering:boolean;pointA:Vec3;pointB:Vec3}
export function measureClearance(a:Mesh,b:Mesh,kind:'aabb'|'obb'='obb'):Clearance {
  if(!['aabb','obb'].includes(kind))throw new TypeError('Invalid clearance bounds');const x=bounds(a,kind),y=bounds(b,kind),delta=sub(y.center,x.center),axes=[...x.axes,...y.axes,...x.axes.flatMap(u=>y.axes.map(v=>cross(u,v)))];let separated=false,touching=false;
  for(const axis of axes){const length=Math.hypot(...axis);if(length<1e-10)continue;const distance=Math.abs(dot(delta,axis))/length,radius=x.axes.reduce((sum,u,i)=>sum+Math.abs(dot(u,axis))*x.half[i]/length,0)+y.axes.reduce((sum,u,i)=>sum+Math.abs(dot(u,axis))*y.half[i]/length,0),gap=distance-radius;if(gap>1e-10)separated=true;if(gap>=-1e-10)touching=true;}
  let best=Infinity,pa=x.center,pb=y.center;const consider=(p:number[],q:number[])=>{const d=Math.hypot(...sub(p,q));if(d<best){best=d;pa=p;pb=q;}};
  for(const p of x.corners)consider(p,closest(p,y));for(const p of y.corners)consider(closest(p,x),p);
  const edges=(box:Bounds)=>box.corners.flatMap((p,i)=>[0,1,2].filter(axis=>!(i&(1<<axis))).map(axis=>[p,box.corners[i|(1<<axis)]]));for(const [p,q] of edges(x))for(const [r,s] of edges(y))consider(...segment(p,q,r,s));
  return {distance:separated?best:0,interfering:!separated&&!touching,pointA:pa as unknown as Vec3,pointB:pb as unknown as Vec3};
}

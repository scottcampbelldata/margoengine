import type {Mesh,Vec3} from '@scottcampbelldata/vexel-core';
import {worldAnchor,type Anchor} from './overlays.js';
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function vertex(node:Mesh,index:number):Vec3 {node.check();if(!node.geometry||!Number.isSafeInteger(index)||index<0||index>=node.geometry.vertices.length/6)throw new RangeError('Invalid metrology vertex');return Array.from(node.geometry.vertices.subarray(index*6,index*6+3)) as unknown as Vec3;}
export function vertexAnchor(node:Mesh,index:number):Anchor {return {node,point:vertex(node,index)};}
export function faceAnchor(node:Mesh,triangle:number):Anchor {node.check();const indices=node.geometry?.indices;if(!indices||!Number.isSafeInteger(triangle)||triangle<0||triangle>=indices.length/3)throw new RangeError('Invalid metrology face');const points=[0,1,2].map(i=>vertex(node,indices[triangle*3+i]));return {node,point:[0,1,2].map(a=>(points[0][a]+points[1][a]+points[2][a])/3) as unknown as Vec3};}
export function holeAnchor(node:Mesh,ring:readonly number[],tolerance=1e-5):Anchor {
  if(ring.length<3||ring.length>4096||!Number.isFinite(tolerance)||tolerance<=0)throw new RangeError('Invalid circular hole ring');const points=ring.map(i=>vertex(node,i)),a=points[0],u=sub(points[1],a);let v:Vec3=[0,0,0],n:Vec3=[0,0,0];for(let i=2;i<points.length;i++){v=sub(points[i],a);n=cross(u,v);if(dot(n,n)>1e-20)break;}const denominator=2*dot(n,n);if(denominator<=1e-20)throw new RangeError('Hole ring is collinear');const x=cross(v,n),y=cross(n,u),center:Vec3=[0,1,2].map(i=>a[i]+(dot(u,u)*x[i]+dot(v,v)*y[i])/denominator) as unknown as Vec3,radius=Math.hypot(...sub(a,center)),normal=Math.hypot(...n);
  if(points.some(p=>Math.abs(Math.hypot(...sub(p,center))-radius)>tolerance||Math.abs(dot(sub(p,a),n))/normal>tolerance))throw new RangeError('Hole ring is not circular and planar');return {node,point:center};
}
export function snapAnchor(node:Mesh,worldPoint:Vec3,{kind='vertex',holes=[],maxDistance=Infinity}:{kind?:'vertex'|'face'|'hole';holes?:readonly (readonly number[])[];maxDistance?:number}={}):Anchor|null {
  worldAnchor({point:worldPoint});node.check();if(!node.geometry||maxDistance<0||Number.isNaN(maxDistance)||!['vertex','face','hole'].includes(kind))throw new RangeError('Invalid snap');let best:Anchor|null=null,distance=maxDistance;const count=kind==='vertex'?node.geometry.vertices.length/6:kind==='face'?node.geometry.indices.length/3:holes.length;
  for(let i=0;i<count;i++){const anchor=kind==='vertex'?vertexAnchor(node,i):kind==='face'?faceAnchor(node,i):holeAnchor(node,holes[i]),p=worldAnchor(anchor),d=Math.hypot(...sub(p,worldPoint));if(d<=distance){best=anchor;distance=d;}}return best;
}
export function measureDistance(a:Anchor,b:Anchor,unit:'mm'|'in'|'m'='mm',sceneToMeters=1):number {if(!['mm','in','m'].includes(unit)||!Number.isFinite(sceneToMeters)||sceneToMeters<=0)throw new RangeError('Invalid measurement unit scale');return Math.hypot(...sub(worldAnchor(a),worldAnchor(b)))*sceneToMeters*(unit==='mm'?1000:unit==='in'?1/0.0254:1);}

import type {Mesh,Vec3} from '@margoengine/core';
import type {Geometry} from '@margoengine/core/extension';
import {cross,dot,sub} from '@margoengine/math/vec3';
import {anchorDelta,worldAnchor,type Anchor} from './anchors.js';
import {featureEdges} from './edges.js';
function vertex(node:Mesh,index:number):Vec3 {node.check();if(!node.geometry||!Number.isSafeInteger(index)||index<0||index>=node.geometry.vertices.length/6)throw new RangeError('Invalid metrology vertex');return Array.from(node.geometry.vertices.subarray(index*6,index*6+3)) as unknown as Vec3;}
/** A mesh vertex, in the node's local space. */
export function vertexAnchor(node:Mesh,index:number):Anchor {return {node,point:vertex(node,index)};}
/** The midpoint of the edge between two mesh vertices. */
export function edgeAnchor(node:Mesh,a:number,b:number):Anchor {const x=vertex(node,a),y=vertex(node,b);if(a===b)throw new RangeError('Edge needs two vertices');return {node,point:[(x[0]+y[0])/2,(x[1]+y[1])/2,(x[2]+y[2])/2]};}
/** The centroid of a triangle. */
export function faceAnchor(node:Mesh,triangle:number):Anchor {node.check();const indices=node.geometry?.indices;if(!indices||!Number.isSafeInteger(triangle)||triangle<0||triangle>=indices.length/3)throw new RangeError('Invalid metrology face');const points=[0,1,2].map(i=>vertex(node,indices[triangle*3+i]));return {node,point:[0,1,2].map(a=>(points[0][a]+points[1][a]+points[2][a])/3) as unknown as Vec3};}
/** The centre of a circular, planar ring of mesh vertices (a hole rim); throws if the ring is not circular within `tolerance`. */
export function holeAnchor(node:Mesh,ring:readonly number[],tolerance=1e-5):Anchor {
  if(ring.length<3||ring.length>4096||!Number.isFinite(tolerance)||tolerance<=0)throw new RangeError('Invalid circular hole ring');const points=ring.map(i=>vertex(node,i)),a=points[0],u=sub(points[1],a);let v:Vec3=[0,0,0],n:Vec3=[0,0,0];for(let i=2;i<points.length;i++){v=sub(points[i],a);n=cross(u,v);if(dot(n,n)>1e-20)break;}const denominator=2*dot(n,n);if(denominator<=1e-20)throw new RangeError('Hole ring is collinear');const x=cross(v,n),y=cross(n,u),center:Vec3=[0,1,2].map(i=>a[i]+(dot(u,u)*x[i]+dot(v,v)*y[i])/denominator) as unknown as Vec3,radius=Math.hypot(...sub(a,center)),normal=Math.hypot(...n);
  if(points.some(p=>Math.abs(Math.hypot(...sub(p,center))-radius)>tolerance||Math.abs(dot(sub(p,a),n))/normal>tolerance))throw new RangeError('Hole ring is not circular and planar');return {node,point:center};
}

// CAD topology of a tessellated part: feature edges (faces meeting above 30 degrees, plus open boundaries) and corners, the
// welded feature-edge endpoints where the edges do not continue smoothly (not exactly two edges, or a turn above 30 degrees).
// Triangulation diagonals and points inside flat faces are neither, so snapping never lands on them.
interface Features {pairs:Uint32Array;corners:Uint32Array}
const features=new WeakMap<Geometry,Features>(),SMOOTH=-Math.cos(Math.PI/6);
function topology(geometry:Geometry):Features {
  let found=features.get(geometry);if(found)return found;
  const pairs=featureEdges(geometry,30),v=geometry.vertices,ends=new Map<string,{index:number;directions:number[]}>();
  for(let e=0;e<pairs.length;e+=2)for(const [from,to] of [[pairs[e],pairs[e+1]],[pairs[e+1],pairs[e]]]){
    const a=from*6,b=to*6,key=`${v[a]},${v[a+1]},${v[a+2]}`,l=Math.hypot(v[b]-v[a],v[b+1]-v[a+1],v[b+2]-v[a+2])||1;let end=ends.get(key);
    if(!end)ends.set(key,end={index:from,directions:[]});end.directions.push((v[b]-v[a])/l,(v[b+1]-v[a+1])/l,(v[b+2]-v[a+2])/l);
  }
  const corners:number[]=[];for(const {index,directions:d} of ends.values())if(d.length!==6||d[0]*d[3]+d[1]*d[4]+d[2]*d[5]>SMOOTH)corners.push(index);
  features.set(geometry,found={pairs,corners:Uint32Array.from(corners)});return found;
}
/**
 * The CAD feature of `node` nearest a world point, within `maxDistance` world units: kind 'vertex' a corner (where feature
 * edges meet), kind 'edge' the closest point on a feature edge. Feature edges are where faces meet above 30 degrees, plus open
 * boundaries; triangulation diagonals and face interiors are never returned. Null when nothing is that close.
 */
export function snapFeature(node:Mesh,worldPoint:Vec3,kind:'vertex'|'edge',maxDistance=Infinity):Anchor|null {
  worldAnchor({point:worldPoint});node.check();if(!node.geometry||!(maxDistance>=0)||kind!=='vertex'&&kind!=='edge')throw new RangeError('Invalid snap');
  const {pairs,corners}=topology(node.geometry);let best:Anchor|null=null,distance=maxDistance;
  if(kind==='vertex'){for(const index of corners){const anchor=vertexAnchor(node,index),d=Math.hypot(...sub(worldAnchor(anchor),worldPoint));if(d<=distance){best=anchor;distance=d;}}return best;}
  for(let e=0;e<pairs.length;e+=2){
    // Affine transforms keep the segment parameter, so the world closest point maps back to the same t in local space.
    const pa=vertex(node,pairs[e]),pb=vertex(node,pairs[e+1]),a=worldAnchor({node,point:pa}),ab=sub(worldAnchor({node,point:pb}),a),l=dot(ab,ab);
    const t=l?Math.min(1,Math.max(0,dot(sub(worldPoint,a),ab)/l)):0,d=Math.hypot(a[0]+ab[0]*t-worldPoint[0],a[1]+ab[1]*t-worldPoint[1],a[2]+ab[2]*t-worldPoint[2]);
    if(d<=distance){distance=d;best={node,point:[pa[0]+(pb[0]-pa[0])*t,pa[1]+(pb[1]-pa[1])*t,pa[2]+(pb[2]-pa[2])*t]};}
  }
  return best;
}
/**
 * The anchor on `node` nearest a world point: 'vertex' a CAD corner and 'edge' the closest point on a feature edge (see
 * {@link snapFeature}), 'face' a triangle centroid, 'hole' the centre of one of `holes` (vertex index rings). Null beyond `maxDistance`.
 */
export function snapAnchor(node:Mesh,worldPoint:Vec3,{kind='vertex',holes=[],maxDistance=Infinity}:{kind?:'vertex'|'edge'|'face'|'hole';holes?:readonly (readonly number[])[];maxDistance?:number}={}):Anchor|null {
  worldAnchor({point:worldPoint});node.check();if(!node.geometry||maxDistance<0||Number.isNaN(maxDistance)||!['vertex','edge','face','hole'].includes(kind))throw new RangeError('Invalid snap');
  if(kind==='vertex'||kind==='edge')return snapFeature(node,worldPoint,kind,maxDistance);
  let best:Anchor|null=null,distance=maxDistance;const count=kind==='face'?node.geometry.indices.length/3:holes.length;
  for(let i=0;i<count;i++){const anchor=kind==='face'?faceAnchor(node,i):holeAnchor(node,holes[i]),p=worldAnchor(anchor),d=Math.hypot(...sub(p,worldPoint));if(d<=distance){best=anchor;distance=d;}}return best;
}
/**
 * Distance between two anchors in `unit` (1 scene unit = `sceneToMeters` m), computed in float64 through the anchors' nearest
 * common ancestor, so parts far from the origin measure as precisely as parts at it (see {@link anchorDelta}).
 */
export function measureDistance(a:Anchor,b:Anchor,unit:'mm'|'in'|'m'='mm',sceneToMeters=1):number {if(!['mm','in','m'].includes(unit)||!Number.isFinite(sceneToMeters)||sceneToMeters<=0)throw new RangeError('Invalid measurement unit scale');return Math.hypot(...anchorDelta(a,b))*sceneToMeters*(unit==='mm'?1000:unit==='in'?1/0.0254:1);}

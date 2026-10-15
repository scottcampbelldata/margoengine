import {meshRuntime} from '@margoengine/core/extension';
import type {Mesh as MeshHandle, Vec3} from '@margoengine/core';

/** A point: in world space, or in `node`'s local space (it then follows the node). */
export interface Anchor {point:Vec3;node?:MeshHandle}
/** The anchor's world position through the node's float32 world matrix (what the GPU draws). */
export function worldAnchor(anchor:Anchor):Vec3 {const p=anchor.point;if(p.length!==3||!p.every(v=>typeof v==='number'&&Number.isFinite(Math.fround(v))))throw new TypeError('Invalid annotation anchor');if(!anchor.node)return p;anchor.node.check();const m=meshRuntime(anchor.node).matrix;return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}
// The anchor's point carried up its node's hierarchy in float64 through each level's own position, rotation and scale (the
// inputs the transform kernel composes in float32), stopping below slot `stop` (a common ancestor, or -1 for world space).
function lift(anchor:Anchor,stop:number):number[] {
  let [x,y,z]=anchor.point;if(!anchor.node)return [x,y,z];
  // A node without a transform store (a test double) has only its world matrix.
  const mesh=meshRuntime(anchor.node),store=mesh.engine?.store;if(!store)return [...worldAnchor(anchor)];const t=store.transforms;
  for(let id=mesh.id,depth=0;id!==stop&&id>=0;id=store.parents[id],depth++){
    if(depth>=64)throw new Error('Invalid anchor hierarchy');
    const l=Math.hypot(t.qx[id],t.qy[id],t.qz[id],t.qw[id]),qx=t.qx[id]/l,qy=t.qy[id]/l,qz=t.qz[id]/l,qw=t.qw[id]/l,sx=x*t.sx[id],sy=y*t.sy[id],sz=z*t.sz[id];
    // v + 2 (w (q x v) + q x (q x v))
    const cx=qy*sz-qz*sy,cy=qz*sx-qx*sz,cz=qx*sy-qy*sx;
    x=sx+2*(qw*cx+qy*cz-qz*cy)+t.x[id];y=sy+2*(qw*cy+qz*cx-qx*cz)+t.y[id];z=sz+2*(qw*cz+qx*cy-qy*cx)+t.z[id];
  }
  return [x,y,z];
}
/**
 * World-space vector from anchor `a` to anchor `b`, in float64. Anchors on parts of one hierarchy are compared in their nearest
 * common ancestor's frame, so an offset they share (an assembly placed 1 km from the origin) cancels exactly instead of
 * rounding in each part's float32 world matrix; only that ancestor's rotation and scale are applied from its world matrix.
 */
export function anchorDelta(a:Anchor,b:Anchor):Vec3 {
  worldAnchor(a);worldAnchor(b);let stop=-1;
  const ma=a.node&&meshRuntime(a.node),mb=b.node&&meshRuntime(b.node);
  if(ma&&mb&&ma.engine?.store&&ma.engine===mb.engine){
    const parents=ma.engine.store.parents,seen=new Set<number>();
    for(let id=ma.id,depth=0;id>=0&&depth<64;id=parents[id],depth++)seen.add(id);
    for(let id=mb.id,depth=0;id>=0&&depth<64;id=parents[id],depth++)if(seen.has(id)){stop=id;break;}
  }
  const p=lift(a,stop),q=lift(b,stop),d=[q[0]-p[0],q[1]-p[1],q[2]-p[2]];
  if(stop<0)return d as unknown as Vec3;
  const m=ma!.engine.store.matrices,o=stop*16;
  return [m[o]*d[0]+m[o+4]*d[1]+m[o+8]*d[2],m[o+1]*d[0]+m[o+5]*d[1]+m[o+9]*d[2],m[o+2]*d[0]+m[o+6]*d[1]+m[o+10]*d[2]];
}

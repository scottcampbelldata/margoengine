import type { Spline } from '@margoengine/splines';
import type { Geometry } from '@margoengine/core';
import { DesignMesh, bounded, designError, type Point3 } from './design-mesh.js';
import { sampleRoadFrame } from './frame.js';

/** A bridge or tunnel over an arc-distance interval, in metres. */
export interface StructureSpan {
  /** Generated structure type. */
  kind: 'bridge' | 'tunnel';
  /** Start distance inclusive. */
  start: number;
  /** End distance inclusive. */
  end: number;
}
/** Another road that must stay clear of bridge piers and the underside of the deck. */
export interface CrossingRoad {
  /** Centreline in the same local coordinate system. */
  curve: Spline;
  /** Driving width, metres. Default 6. */
  width?: number;
}
/** Parametric visual structures; these dimensions do not certify engineering capacity. */
export interface StructureOptions {
  /** Road/deck inside width, metres. Default 6. */
  width?: number;
  /** Ground height(x,z), default flat 0. */
  ground?: (x:number,z:number)=>number;
  /** Authored spans replace terrain classification. Default automatically classify terrain and road crossings. */
  spans?: readonly StructureSpan[];
  /** Maximum arc-distance between samples, metres. Default 1. */
  step?: number;
  /** Height over terrain that starts a bridge, metres. Default 3. */
  bridgeHeight?: number;
  /** Deck thickness below road, metres. Default 0.5. */
  deckThickness?: number;
  /** Maximum centre-to-centre support spacing before exclusions, metres. Default 12. */
  supportSpacing?: number;
  /** Square pier width/depth, metres. Default 0.8. Two piers per support row. */
  pierWidth?: number;
  /** Tunnel interior height, metres. Default 5. */
  tunnelHeight?: number;
  /** Shell and portal thickness, metres. Default 0.4. */
  tunnelThickness?: number;
  /** Ground above the outer roof needed to classify a tunnel, metres. Default 1. */
  cover?: number;
  /** Tunnel profile, default arch (elliptical if height < half width). */
  tunnelShape?: 'arch' | 'box';
  /** Chords per half arch, default 16. */
  archSegments?: number;
  /** Other roads for automatic bridge spans and pier exclusion. Default empty. */
  crossings?: readonly CrossingRoad[];
  /** Required vertical clearance below deck at crossings, metres. Default 4.5. */
  clearance?: number;
  /** Horizontal margin beyond crossing road edges, metres. Default 1. */
  crossingMargin?: number;
  /** Checked before and after synchronous geometry work. Default none. */
  signal?: AbortSignal;
}
/** One independent CPU layer, possibly empty. */
export interface StructureMesh {
  /** Owned geometry with hard face normals. */
  geometry: Geometry;
  /** Owned planar UVs in metres. */
  uvs: Float32Array;
}
/** An open passage ring for application terrain-cutting or placement. */
export interface TunnelOpening {
  /** Arc-distance of portal. */
  distance: number;
  /** Inner boundary from the driver's right road edge over the roof to the left road edge. The floor is open. */
  boundary: Point3[];
  /** Normal pointing out of the tunnel. */
  outward: Point3;
}
/** Four renderable layers and owned classification/placement metadata. */
export interface RoadStructures {
  /** Closed bridge slabs: top, bottom, sides and abutment ends. */
  decks: StructureMesh;
  /** Vertical paired piers meeting terrain at their four bottom corners. */
  supports: StructureMesh;
  /** Double-sided-volume tunnel walls and roof, open at both ends and floor. */
  tunnels: StructureMesh;
  /** Separate annular portal end faces, leaving the driving opening clear. */
  portals: StructureMesh;
  /** Sorted merged authored or classified spans. */
  spans: StructureSpan[];
  /** Centre positions of emitted piers at deck underside. */
  supportPositions: Point3[];
  /** Portal boundary rings; application terrain meshes can use these to cut entrances. */
  openings: TunnelOpening[];
}

/** Build grade-separated decks, terrain-founded supports and open tunnel shells/portals along a road spline. */
export function structures(curve:Spline,options:StructureOptions={}):RoadStructures {
  const {width=6,ground=()=>0,spans:authored,step=1,bridgeHeight=3,deckThickness=0.5,supportSpacing=12,pierWidth=0.8,tunnelHeight=5,tunnelThickness=0.4,cover=1,tunnelShape='arch',archSegments=16,crossings=[],clearance=4.5,crossingMargin=1,signal}=options;
  signal?.throwIfAborted();
  if(!bounded(curve.length,0.01,100000)||!bounded(width,0.1,1000)||typeof ground!=='function'||!bounded(step,0.01,1000)||!bounded(bridgeHeight,0.1,1000)||!bounded(deckThickness,0.01,100)||!bounded(supportSpacing,0.5,1000)||!bounded(pierWidth,0.05,width/2)||!bounded(tunnelHeight,0.5,100)||!bounded(tunnelThickness,0.01,100)||!bounded(cover,0,1000)||!bounded(clearance,0.1,100)||!bounded(crossingMargin,0,100)||!['arch','box'].includes(tunnelShape)||!Number.isInteger(archSegments)||archSegments<4||archSegments>128||!Array.isArray(crossings)||crossings.length>64)
    throw designError('Invalid road structure options; use bounded metre dimensions, 4..128 arch segments and at most 64 crossings');
  const center=new Float64Array(3),before=new Float64Array(3),after=new Float64Array(3);
  const frame=(s:number)=>{
    sampleRoadFrame(curve,s,Math.min(step*0.01,curve.length*1e-5),center,before,after);
    const dx=after[0]-before[0],dy=after[1]-before[1],dz=after[2]-before[2],h=Math.hypot(dx,dz),l=Math.hypot(dx,dy,dz);
    if(!h||!l)throw designError('Road structures need a nonvertical, nonzero tangent; remove the cusp or vertical segment');
    return {p:[...center] as [number,number,number],rx:dz/h,rz:-dx/h,grade:dy/h,forward:[dx/h,0,dz/h] as Point3};
  };
  const point=(s:number,l:number,h:number):Point3=>{const f=frame(s);return [f.p[0]+f.rx*l,f.p[1]+h,f.p[2]+f.rz*l];};
  const terrain=(x:number,z:number)=>{const h=ground(x,z);if(!bounded(h,-1e6,1e6))throw designError('Ground must return finite heights within +/-1000000 metres');return h;};
  const count=Math.ceil(curve.length/step);
  if(count>8192)throw designError('Road structure sampling exceeds 8192 segments; increase step or split the curve');
  const samples=Array.from({length:count+1},(_,i)=>{const s=curve.length*i/count,f=frame(s),g=terrain(f.p[0],f.p[2]);return {s,p:f.p,g};});
  const spans:StructureSpan[]=[];
  if(authored!==undefined){
    if(!Array.isArray(authored)||authored.length>4096)throw designError('Use at most 4096 authored bridge/tunnel spans');
    for(const r of authored){if(!r||!['bridge','tunnel'].includes(r.kind)||!bounded(r.start,0,curve.length)||!bounded(r.end,r.start+0.001,curve.length))throw designError('Structure spans need valid kind and increasing arc distances within the curve');spans.push({...r});}
  }else{
    // Solve zero crossings on the sampled piecewise-linear clearance field.
    for(let i=0;i<count;i++)for(const kind of ['bridge','tunnel'] as const){
      const value=(v:typeof samples[number])=>kind==='bridge'?v.p[1]-v.g-bridgeHeight:v.g-v.p[1]-tunnelHeight-tunnelThickness-cover;
      const a=samples[i],b=samples[i+1],fa=value(a),fb=value(b);
      if(fa<=0&&fb<=0)continue;
      const root=a.s+(b.s-a.s)*fa/(fa-fb);
      spans.push({kind,start:fa>=0?a.s:root,end:fb>=0?b.s:root});
    }
  }
  type Obstacle={a:Point3;b:Point3;width:number};
  const obstacles:Obstacle[]=[];let candidates=0;
  for(const crossing of crossings){
    const w=crossing.width??6,len=crossing.curve?.length,n=Math.ceil(len/step);
    if(!bounded(w,0.1,1000)||!bounded(len,0.01,100000)||n>8192||obstacles.length+n>65536)throw designError('Crossing roads need bounded width/length and at most 65536 sampled segments total');
    let a=Array.from(crossing.curve.atDistance(0,new Float64Array(3))) as [number,number,number];
    for(let j=1;j<=n;j++){
      const b=Array.from(crossing.curve.atDistance(len*j/n,new Float64Array(3))) as [number,number,number];
      if(![...a,...b].every(v=>bounded(v,-1e6,1e6)))throw designError('Crossing positions must remain finite within +/-1000000 metres');
      obstacles.push({a,b,width:w});a=b;
    }
  }
  // X ordering rejects distant segments before pair work; the finite candidate
  // budget prevents unbounded work for many coincident vertical projections.
  const ordered=obstacles.slice().sort((a,b)=>Math.min(a.a[0],a.b[0])-Math.min(b.a[0],b.b[0]));
  for(let i=0;i<count;i++){
    const a=samples[i],b=samples[i+1],ax=b.p[0]-a.p[0],az=b.p[2]-a.p[2];
    for(const other of ordered){
      if(Math.min(other.a[0],other.b[0])>Math.max(a.p[0],b.p[0]))break;
      if(Math.max(other.a[0],other.b[0])<Math.min(a.p[0],b.p[0])||Math.min(other.a[2],other.b[2])>Math.max(a.p[2],b.p[2])||Math.max(other.a[2],other.b[2])<Math.min(a.p[2],b.p[2]))continue;
      if(++candidates>2_000_000)throw designError('Road crossing search exceeds two million candidates; split the road network');
      const bx=other.b[0]-other.a[0],bz=other.b[2]-other.a[2],dx=other.a[0]-a.p[0],dz=other.a[2]-a.p[2],det=ax*bz-az*bx;
      if(!det)continue;const t=(dx*bz-dz*bx)/det,u=(dx*az-dz*ax)/det;
      if(t<0||t>1||u<0||u>1)continue;
      const upper=a.p[1]+(b.p[1]-a.p[1])*t,lower=other.a[1]+(other.b[1]-other.a[1])*u;
      if(upper<=lower)continue;
      if(upper-lower-deckThickness<clearance)throw designError('Road crossing has insufficient deck clearance; raise the road or reduce deck thickness');
      if(authored===undefined){
        const s=a.s+(b.s-a.s)*t,sine=Math.abs(det)/Math.hypot(ax,az)/Math.hypot(bx,bz),half=(other.width/2+crossingMargin+pierWidth)/sine;
        spans.push({kind:'bridge',start:Math.max(0,s-half),end:Math.min(curve.length,s+half)});
      }
    }
  }
  spans.sort((a,b)=>a.start-b.start||a.end-b.end);
  const merged:StructureSpan[]=[];
  for(const span of spans){const previous=merged.at(-1);if(previous&&span.start<=previous.end+1e-9){if(previous.kind!==span.kind)throw designError('Bridge and tunnel spans overlap; correct the ground or authored spans');previous.end=Math.max(previous.end,span.end);}else merged.push({...span});}
  const decks=new DesignMesh(),supports=new DesignMesh(),tunnels=new DesignMesh(),portals=new DesignMesh(),supportPositions:Point3[]=[],openings:TunnelOpening[]=[];
  let quads=0;
  const quad=(mesh:DesignMesh,a:Point3,b:Point3,c:Point3,d:Point3)=>{if(++quads>131072)throw designError('Road structures exceed 131072 quads; increase step or reduce geometry');mesh.quad(a,b,c,d);};
  const sweep=(mesh:DesignMesh,profile:readonly (readonly [number,number])[],span:StructureSpan,inward=false)=>{
    const rows=Math.max(1,Math.ceil((span.end-span.start)/step));
    for(let i=0;i<rows;i++){
      const a=span.start+(span.end-span.start)*i/rows,b=span.start+(span.end-span.start)*(i+1)/rows;
      for(let j=0;j<profile.length-1;j++){
        const p=profile[j],q=profile[j+1],v=[point(a,...p),point(b,...p),point(b,...q),point(a,...q)];
        if(q[0]!==p[0]){
          const area=(a:Point3,b:Point3,c:Point3)=>(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
          if(area(v[0],v[1],v[2])*(q[0]-p[0])<=0||area(v[0],v[2],v[3])*(q[0]-p[0])<=0)
            throw designError('Road structure offsets fold on this bend; widen the bend, reduce width or refine step');
        }
        if(inward)quad(mesh,v[3],v[2],v[1],v[0]);else quad(mesh,v[0],v[1],v[2],v[3]);
      }
    }
  };
  const blocked=(x:number,y:number,z:number,base:number)=>obstacles.some(o=>{
    const dx=o.b[0]-o.a[0],dz=o.b[2]-o.a[2],den=dx*dx+dz*dz;if(!den)return false;
    const t=Math.max(0,Math.min(1,((x-o.a[0])*dx+(z-o.a[2])*dz)/den)),h=o.a[1]+(o.b[1]-o.a[1])*t;
    return h>=base&&h<=y+clearance&&Math.hypot(x-o.a[0]-t*dx,z-o.a[2]-t*dz)<=o.width/2+crossingMargin+pierWidth/Math.SQRT2;
  });
  const pier=(s:number,l:number)=>{
    const f=frame(s),x=f.p[0]+f.rx*l,z=f.p[2]+f.rz*l,top=f.p[1]-deckThickness,base=terrain(x,z);
    if(base>=top)throw designError('Bridge pier ground reaches above deck underside; correct the ground or bridge span');
    if(blocked(x,top,z,base))return;
    const size=pierWidth/2,forward=[-f.rz,f.rx],bottom:Point3[]=[],upper:Point3[]=[];
    for(const [a,b] of [[-size,-size],[size,-size],[size,size],[-size,size]]){
      const px=x+f.rx*a+forward[0]*b,pz=z+f.rz*a+forward[1]*b,h=terrain(px,pz);
      const roof=top+f.grade*b;
      if(h>=roof)throw designError('Ground intersects bridge pier/deck; increase clearance or refine the terrain');
      bottom.push([px,h,pz]);upper.push([px,roof,pz]);
    }
    for(let i=0;i<4;i++){const j=(i+1)%4;quad(supports,bottom[i],upper[i],upper[j],bottom[j]);}
    quad(supports,upper[0],upper[3],upper[2],upper[1]);quad(supports,bottom[0],bottom[1],bottom[2],bottom[3]);supportPositions.push([x,top,z]);
  };
  for(const span of merged){
    if(span.kind==='bridge'){
      const profile:[number,number][]=[[-width/2,0],[width/2,0],[width/2,-deckThickness],[-width/2,-deckThickness],[-width/2,0]];
      sweep(decks,profile,span);
      const a=profile.slice(0,4).map(p=>point(span.start,...p)),b=profile.slice(0,4).map(p=>point(span.end,...p));quad(decks,a[0],a[1],a[2],a[3]);quad(decks,b[3],b[2],b[1],b[0]);
      const rows=Math.max(1,Math.ceil((span.end-span.start)/supportSpacing)),positions=[span.start,...Array.from({length:rows},(_,i)=>span.start+(span.end-span.start)*(i+0.5)/rows),span.end];
      for(const s of positions)for(const l of [-width/4,width/4])pier(s,l);
    }else{
      const wall=Math.max(0,tunnelHeight-width/2),rise=tunnelHeight-wall;
      const profile=(extra:number):[number,number][]=>tunnelShape==='box'?[[-width/2-extra,0],[-width/2-extra,tunnelHeight+extra],[width/2+extra,tunnelHeight+extra],[width/2+extra,0]]:[[-width/2-extra,0],...(wall>0?[[-width/2-extra,wall] as [number,number]]:[]),...Array.from({length:archSegments},(_,i):[number,number]=>{const a=Math.PI*(1-(i+1)/archSegments);return [(width/2+extra)*Math.cos(a),wall+(rise+extra)*Math.sin(a)];}),...(wall>0?[[width/2+extra,0] as [number,number]]:[])];
      const inner=profile(0),outer=profile(tunnelThickness);
      sweep(tunnels,inner,span,true);sweep(tunnels,outer,span);
      sweep(tunnels,[inner[0],outer[0]],span);sweep(tunnels,[outer.at(-1)!,inner.at(-1)!],span);
      for(const [s,reverse] of [[span.start,false],[span.end,true]] as const){
        for(let i=0;i<inner.length-1;i++){
          const v=[point(s,...outer[i]),point(s,...outer[i+1]),point(s,...inner[i+1]),point(s,...inner[i])];
          if(reverse)quad(portals,v[3],v[2],v[1],v[0]);else quad(portals,v[0],v[1],v[2],v[3]);
        }
        const f=frame(s);openings.push({distance:s,boundary:inner.map(p=>point(s,...p)),outward:f.forward.map(v=>v*(reverse?1:-1)+0) as [number,number,number]});
      }
    }
  }
  signal?.throwIfAborted();return {decks:decks.finish(),supports:supports.finish(),tunnels:tunnels.finish(),portals:portals.finish(),spans:merged,supportPositions,openings};
}

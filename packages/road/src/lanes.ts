import type { Spline } from '@margoengine/splines';
import type { Geometry } from '@margoengine/core';
import { sampleRoadFrame } from './frame.js';
import { DesignMesh, bounded, designError, type Point3 } from './design-mesh.js';

/** Paint for one boundary, indexed left to right in the curve's direction. */
export interface LaneLine {
  /** Default solid at outside edges and dashed inside. */
  style?: 'solid' | 'dashed' | 'none';
  /** Stroke width, metres. Default 0.15. */
  width?: number;
  /** Painted metres then unpainted metres. Default [3,6]. */
  dash?: readonly [number,number];
  /** Distance into the dash pattern at curve start. Default 0; use accumulated route distance at junctions. */
  phase?: number;
  /** Linear RGB, default white. */
  color?: readonly [number,number,number];
}
/** An arrow authored in lane and arc-distance coordinates. */
export interface LaneArrow {
  /** Zero-based lane index, left to right. */
  lane: number;
  /** Centre distance along the curve, metres. */
  distance: number;
  /** Direction in road coordinates. Default straight. */
  turn?: 'straight' | 'left' | 'right' | 'straight-left' | 'straight-right';
  /** Longitudinal length, metres. Default 4. */
  length?: number;
  /** Width, metres. Default min(1.5, lane width * 0.7). */
  width?: number;
  /** Face the opposite travel direction. Default false. */
  reverse?: boolean;
  /** Linear RGB, default white. */
  color?: readonly [number,number,number];
}
/** Widths and paint placement, left to right looking along the curve. */
export interface LaneLayout {
  /** 1..32 positive lane widths in metres. */
  widths: readonly number[];
  /** Exactly widths.length+1 boundary styles when specified; omitted entries use defaults. */
  lines?: readonly LaneLine[];
  /** Up to 4096 arrows. Default empty. */
  arrows?: readonly LaneArrow[];
}
/** Arc-distance clipping and tessellation settings. */
export interface LaneOptions {
  /** Maximum centreline arc-distance per chord, metres. Default 0.5. */
  step?: number;
  /** Start/end arc distances to paint. Default [0,curve.length]. */
  range?: readonly [number,number];
  /** Suppress paint across junction conflict areas; pairs of arc distances. Default empty. */
  exclude?: readonly (readonly [number,number])[];
  /** Vertical offset above road, metres. Default 0.01. */
  lift?: number;
  /** Shared ground height(x,z); default spline height at that distance. */
  elevation?: (x:number,z:number)=>number;
  /** Checked before building and before return. Default none. */
  signal?: AbortSignal;
}
/** Independent paint mesh, ready for an opaque material with the supplied linear colour. */
export interface LanePaint {
  /** Line or arrow. */
  kind: 'line' | 'arrow';
  /** Boundary index for lines; lane index for arrows. */
  index: number;
  /** Owned finite CPU geometry. */
  geometry: Geometry;
  /** Owned planar UV coordinates in metres. */
  uvs: Float32Array;
  /** Owned linear RGB colour. */
  color: [number,number,number];
  /** Painted arc intervals, clipped to range/exclusions. */
  intervals: [number,number][];
}

/** Build lane/edge lines and arrows that follow spline curvature and grade, including authored junction connectors. */
export function lanes(curve: Spline, layout: LaneLayout, options: LaneOptions = {}): LanePaint[] {
  const {step=0.5,range=[0,curve.length],exclude=[],lift=0.01,elevation,signal}=options;
  signal?.throwIfAborted();
  const invalid=()=>designError('Invalid lane design; use 1..32 positive widths, valid arc ranges, paint styles and bounded tessellation');
  if(!bounded(curve.length,1e-6,1e6)||!bounded(step,0.001,1000)||!bounded(lift,0,10)||
      !Array.isArray(layout?.widths)||!layout.widths.length||layout.widths.length>32||!layout.widths.every(v=>bounded(v,0.1,100))||
      (elevation!==undefined&&typeof elevation!=='function')||!Array.isArray(exclude)||exclude.length>4096)throw invalid();
  const validRange=(r:readonly number[])=>Array.isArray(r)&&r.length===2&&bounded(r[0],0,curve.length)&&bounded(r[1],r[0],curve.length);
  if(!validRange(range)||!exclude.every(validRange))throw invalid();
  // point() offsets along (tz,-tx), the driver's left in Y-up right-handed axes, so left-to-right offsets descend.
  const widths=[...layout.widths],total=widths.reduce((a,b)=>a+b,0),offsets=[total/2];
  for(const width of widths)offsets.push(offsets.at(-1)!-width);
  if(layout.lines && (!Array.isArray(layout.lines)||layout.lines.length!==widths.length+1))throw invalid();
  if(layout.arrows && (!Array.isArray(layout.arrows)||layout.arrows.length>4096))throw invalid();
  const clip=(a:number,b:number):[number,number][]=>{
    let spans:[number,number][]=[[Math.max(a,range[0]),Math.min(b,range[1])]].filter(([s,e])=>e>s) as [number,number][];
    for(const [s,e] of exclude)spans=spans.flatMap(([lo,hi])=>e<=lo||s>=hi?[[lo,hi]]:[...(s>lo?[[lo,s]]:[]),...(e<hi?[[e,hi]]:[])] as [number,number][]);
    return spans;
  };
  const center=new Float64Array(3),before=new Float64Array(3),after=new Float64Array(3);
  const point=(s:number,lateral:number):Point3=>{
    sampleRoadFrame(curve,s,Math.min(step*0.01,curve.length*1e-5),center,before,after);
    const dx=after[0]-before[0],dz=after[2]-before[2],h=Math.hypot(dx,dz);
    if(!h)throw designError('Lane curve has a vertical or zero tangent; use a nonvertical road');
    const x=center[0]+dz/h*lateral,z=center[2]-dx/h*lateral;
    return [x,(elevation?elevation(x,z):center[1])+lift,z];
  };
  const color=(c:readonly number[]=[1,1,1]):[number,number,number]=>{if(!Array.isArray(c)||c.length!==3||!c.every(v=>bounded(v,0,1)))throw invalid();return [...c] as [number,number,number];};
  let quads=0;
  const stroke=(mesh:DesignMesh,a:number,b:number,l0:number,l1:number,width:number)=>{
    const count=Math.max(1,Math.ceil(Math.max(b-a,Math.abs(l1-l0))/step));
    if((quads+=count)>65536)throw designError('Lane paint exceeds 65536 quads; increase step or reduce the painted distance');
    const ds=b-a,dl=l1-l0,length=Math.hypot(ds,dl),ws=-dl/length*width/2,wl=ds/length*width/2;
    if(!length)throw invalid();
    const p=(t:number,sign:number)=>point(a+ds*t+ws*sign,l0+dl*t+wl*sign);
    for(let k=0;k<count;k++)mesh.quad(p(k/count,-1),p((k+1)/count,-1),p((k+1)/count,1),p(k/count,1));
  };
  const out:LanePaint[]=[];
  for(let i=0;i<offsets.length;i++){
    const line=layout.lines?.[i]??{}, {style=i===0||i===widths.length?'solid':'dashed',width=0.15,dash=[3,6],phase=0}=line;
    if(!['solid','dashed','none'].includes(style)||!bounded(width,0.001,10)||!Number.isFinite(phase)||!Array.isArray(dash)||dash.length!==2||!dash.every(v=>bounded(v,0.001,10000)))throw invalid();
    const rgb=color(line.color);if(style==='none')continue;
    const spans:[number,number][]=[];
    if(style==='solid')spans.push(...clip(0,curve.length));
    else {
      const period=dash[0]+dash[1],p=((phase%period)+period)%period;
      const first=Math.floor((range[0]+p)/period),last=Math.ceil((range[1]+p)/period);
      if(last-first>65536)throw invalid();
      for(let k=first;k<last;k++)spans.push(...clip(k*period-p,k*period-p+dash[0]));
    }
    if(!spans.length)continue;
    const mesh=new DesignMesh();for(const [a,b] of spans)stroke(mesh,a,b,offsets[i],offsets[i],width);
    out.push({kind:'line',index:i,...mesh.finish(),color:rgb,intervals:spans});
  }
  for(const arrow of layout.arrows??[]){
    const {lane,distance,turn='straight',length=4,width=Math.min(1.5,widths[lane]*0.7),reverse=false}=arrow;
    if(!Number.isInteger(lane)||lane<0||lane>=widths.length||!bounded(length,0.1,100)||!bounded(width,0.1,widths[lane]*0.9)||!bounded(distance,length/2+width/2,curve.length-length/2-width/2)||typeof reverse!=='boolean'||!['straight','left','right','straight-left','straight-right'].includes(turn))throw invalid();
    const rgb=color(arrow.color),a=distance-length/2,b=distance+length/2;
    if(clip(a-width/2,b+width/2).length!==1||clip(a-width/2,b+width/2)[0][0]!==a-width/2||clip(a-width/2,b+width/2)[0][1]!==b+width/2)continue;
    const mesh=new DesignMesh(),mid=(offsets[lane]+offsets[lane+1])/2,dir=reverse?-1:1;
    const add=(s0:number,l0:number,s1:number,l1:number)=>{
      const aa=distance+dir*s0,bb=distance+dir*s1,la=mid+dir*l0,lb=mid+dir*l1;
      if(aa<=bb)stroke(mesh,aa,bb,la,lb,width/6);else stroke(mesh,bb,aa,lb,la,width/6);
    };
    add(-length/2,0,length*0.1,0);
    if(turn.includes('straight')){add(length*0.1,0,length/2,0);add(length*0.25,-width/2,length/2,0);add(length*0.25,width/2,length/2,0);}
    if(turn!=='straight'){
      const side=turn.includes('left')?1:-1;
      add(length*0.1,0,length*0.3,side*width/2);
      add(length*0.3,side*width/2,length*0.05,side*width*0.3);
      add(length*0.3,side*width/2,length*0.45,side*width*0.25);
    }
    out.push({kind:'arrow',index:lane,...mesh.finish(),color:rgb,intervals:[[a,b]]});
  }
  signal?.throwIfAborted();return out;
}

import type { Decal } from '@margoengine/post/decals';
import { fault } from '../../shared/errors.js';

/** A projected solid/dashed line or stylized straight arrow, in world metres. */
export interface RoadMarking {
  /** Line, or a shaft with two arrowhead strokes. */
  kind: 'line' | 'arrow';
  /** World-space centre, each coordinate within +/-1,000,000 m. */
  position: readonly [number, number, number];
  /** Radians about +Y from +Z toward +X (counterclockwise as viewed from above, the right-handed sense): 0 runs along +Z, pi/2 along +X. Default 0. */
  angle?: number;
  /** Full longitudinal extent, positive through 10000 m. Default 4. */
  length?: number;
  /** Line thickness or full arrowhead span, positive through 1000 m. Default 0.15 for lines, 1.5 for arrows. */
  width?: number;
  /** Line only: [painted length, gap], each positive through 10000 m. Starts painted at the line's negative end. Default solid. */
  dash?: readonly [number, number];
}
/** Appearance and projection settings, shared by all returned decals. */
export interface RoadMarkingOptions {
  /** Linear RGB channels, each 0..1. Default white [1,1,1]. Uses decal 'over' mode (unlit). */
  color?: readonly [number,number,number];
  /** Alpha in 0..1. Default 1. */
  opacity?: number;
  /** Downward projector depth, positive through 1000 m. Default 2. Road surface must lie inside this box. */
  depth?: number;
}

/** Generate up to 4096 asset-free paint projectors for post/decals; [] clears all markings. All projector half-extents must be normal float32 values (at least 2^-126). No GPU allocation or import side effect. */
export function markings(items: readonly RoadMarking[], {color=[1,1,1], opacity=1, depth=2}: RoadMarkingOptions = {}): Decal[] {
  const invalid=()=>fault('failed','Road markings need bounded finite positions, valid line/arrow settings and at most 4096 projectors; reduce the markings or fix their dimensions','geometry');
  if(!Array.isArray(items)||items.length>4096||color.length!==3||!color.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!Number.isFinite(opacity)||opacity<0||opacity>1||!Number.isFinite(depth)||depth/2<2**-126||depth>1000)throw invalid();
  const out: Decal[]=[];
  for(const item of items as readonly RoadMarking[]) {
    if (!item || typeof item !== 'object') throw invalid();
    const {kind,position,angle=0,length=4,width=kind==='arrow'?1.5:0.15,dash}=item;
    if(!['line','arrow'].includes(kind)||!Array.isArray(position)||position.length!==3||!position.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)||!Number.isFinite(angle)||!Number.isFinite(length)||length/2<2**-126||length>10000||!Number.isFinite(width)||width/(kind==='arrow'?10:2)<2**-126||width>1000)throw invalid();
    if(dash && (kind!=='line'||dash.length!==2||!dash.every(v=>Number.isFinite(v)&&v/2>=2**-126&&v<=10000)))throw invalid();
    const count=kind==='arrow'?3:dash?Math.ceil(length/(dash[0]+dash[1])):1;
    if(out.length+count>4096)throw invalid();
    const s=Math.sin(angle),c=Math.cos(angle);
    const add=(ax:number,az:number,bx:number,bz:number,stroke:number)=>{
      const x=(ax+bx)/2,z=(az+bz)/2,a=angle+Math.atan2(bx-ax,bz-az),span=Math.hypot(bx-ax,bz-az);
      if (span/2<2**-126 || stroke/2<2**-126) throw invalid();
      out.push({position:[position[0]+c*x+s*z,position[1],position[2]-s*x+c*z],direction:[0,-1,0],up:[Math.sin(a),0,Math.cos(a)],width:stroke,height:span,depth,color:[...color],opacity,mode:'over'});
    };
    if(kind==='arrow') {
      add(0,-length/2,0,length/2,width/5);
      add(-width/2,length*0.15,0,length/2,width/5);
      add(width/2,length*0.15,0,length/2,width/5);
    } else for(let i=0;i<count;i++) {
      const start=dash?i*(dash[0]+dash[1]):0,paint=dash?Math.min(dash[0],length-start):length;
      add(0,start-length/2,0,start+paint-length/2,width);
    }
  }
  return out;
}

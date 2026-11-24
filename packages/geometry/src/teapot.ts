// Clean-room tensor Bernstein evaluation of the standard Utah Teapot model, not another engine's generator.
import {geometryData,type GeometryData,type GeometryGroup} from './data.js';
import {teapotPatches} from './teapot-data.js';

/** Historical Utah Teapot part and proportion controls. */
export interface TeapotOptions {
  /** Include the round bottom. Default true. */
  bottom?: boolean;
  /** Include the removable lid and knob. Default true. */
  lid?: boolean;
  /** Include rim, body, handle and spout. Default true. */
  body?: boolean;
  /** Expand lid horizontally by 14/13 to match the body's inner rim. Default true. */
  fitLid?: boolean;
  /** Use the familiar squashed proportions; false restores Newell's taller shape. Default true. */
  blinn?: boolean;
}
function basis(t:number):[number[],number[]] {
  const s=1-t;
  return [[s*s*s,3*s*s*t,3*s*t*t,t*t*t],[-3*s*s,3*s*s-6*s*t,6*s*t-3*t*t,3*t*t]];
}
function evaluate(patch:readonly (readonly number[])[],u:number,v:number):number[][] {
  const [U,dU]=basis(u),[V,dV]=basis(v),point=[0,0,0],du=[0,0,0],dv=[0,0,0];
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<3;k++) {
    const p=patch[i*4+j][k];point[k]+=p*U[i]*V[j];du[k]+=p*dU[i]*V[j];dv[k]+=p*U[i]*dV[j];
  }
  return [point,du,dv];
}
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

/** Standard 32-patch Utah Teapot, y-up and centered, with analytic normals and per-patch UVs. Size is the default half-height; segments defaults to 10. */
export function teapotGeometry(size=1,segments=10,options:TeapotOptions={}):GeometryData {
  if(!(size>0&&Math.fround(size)>0&&Number.isFinite(Math.fround(size*3.525/1.575))))throw new RangeError('Invalid teapot size; pass a positive size whose scaled positions fit Float32');
  if(!Number.isInteger(segments)||segments<2||segments>175)throw new RangeError('Invalid teapot resolution; pass an integer from 2 to 175');
  const {bottom=true,lid=true,body=true,fitLid=true,blinn=true}=options,
    positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[],groups:GeometryGroup[]=[],scale=size/1.575,vertical=blinn?1:4/3;
  for(let patchId=0;patchId<teapotPatches.length;patchId++) {
    const part=patchId<20?0:patchId<28?1:2;
    if(!(part===0?body:part===1?lid:bottom))continue;
    const patch=teapotPatches[patchId],base=positions.length/3,start=indices.length,expand=part===1&&fitLid?14/13:1;
    for(let i=0;i<=segments;i++)for(let j=0;j<=segments;j++) {
      const u=i/segments,v=j/segments,[p,du,dv]=evaluate(patch,u,v);
      let normal=cross(dv,du);
      if(Math.hypot(...normal)<1e-14) {
        const [,a,b]=evaluate(patch,Math.max(1e-6,Math.min(1-1e-6,u)),Math.max(1e-6,Math.min(1-1e-6,v)));
        normal=cross(b,a);
      }
      // Raw data is z-up. (x,z,-y) preserves orientation; normals use the inverse-transpose of scale.
      normal=[normal[0]/expand,normal[2]/vertical,-normal[1]/expand];
      const length=Math.hypot(...normal);
      positions.push(p[0]*expand*scale,(p[2]-1.575)*vertical*scale,-p[1]*expand*scale);
      normals.push(...normal.map(x=>x/length));uvs.push(v,1-u);
    }
    const add=(a:number,b:number,c:number)=>{
      const A=positions.slice(a*3,a*3+3),B=positions.slice(b*3,b*3+3).map((x,k)=>x-A[k]),C=positions.slice(c*3,c*3+3).map((x,k)=>x-A[k]);
      if(Math.hypot(...cross(B,C))>size*size*1e-14)indices.push(a,b,c);
    };
    for(let i=0;i<segments;i++)for(let j=0;j<segments;j++) {
      const a=base+i*(segments+1)+j,b=a+1,c=a+segments+1,d=c+1;add(a,b,c);add(b,d,c);
    }
    groups.push({start,count:indices.length-start,materialIndex:part});
  }
  return geometryData(positions,normals,uvs,indices,groups);
}

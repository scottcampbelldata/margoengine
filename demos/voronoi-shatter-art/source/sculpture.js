import { Geometry } from '@margoengine/core';
import { fractureMesh } from '@margoengine/procedural/voronoi';

const pi=Math.PI, tau=2*pi;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>s*v);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/Math.hypot(...a));
function curve(t) {
  const c=Math.cos(t),s=Math.sin(t);
  const p=[1.35*c+.24*Math.sin(2*t-.3),1.62*s+.14*Math.cos(2*t+.6),.26*Math.sin(2*t+.61)+.31*Math.sin(t-.4)];
  const tangent=unit([-1.35*s+.48*Math.cos(2*t-.3),1.62*c-.28*Math.sin(2*t+.6),
    .52*Math.cos(2*t+.61)+.31*Math.cos(t-.4)]);
  const down=unit(cross(tangent,[c,s,0])), across=unit(cross(down,tangent));
  const twist=.97*Math.sin(t+.36)+.30*Math.cos(3*t+.9);
  const a=add(mul(across,Math.cos(twist)),mul(down,Math.sin(twist)));
  const b=cross(tangent,a);
  const wide=.34+.16*(.5+.5*Math.cos(t+.72))+.047*Math.sin(t*3+.4);
  const deep=.26+.12*(.5+.5*Math.sin(t-1.23))+.035*Math.sin(t*2);
  return [p,a,b,wide,deep];
}
export function section(t,f) {
  const [p,a,b,wide,deep]=curve(t);
  return add(add(p,mul(a,Math.cos(f)*wide)),mul(b,Math.sin(f)*deep));
}
export function bodyGeometry() {
  const steps=112,sides=24;
  const p=[],n=[],ix=[], h=.00003125;
  for(let j=0;j<steps;j++) for(let k=0;k<sides;k++) {
    const t=j*tau/steps,f=k*tau/sides;
    const p0=section(t,f);
    const along=sub(section(t+h,f),section(t-h,f));
    const across=sub(section(t,f+h),section(t,f-h));
    p.push(...p0);
    n.push(...unit(cross(across,along)));
    const a=j*sides+k,b=j*sides+(k+1)%sides,c=((j+1)%steps)*sides+k,d=((j+1)%steps)*sides+(k+1)%sides;
    ix.push(a,b,d,a,d,c);
  }
  return new Geometry(p,n,ix);
}

function makeSites() {
  let state=972121;
  const random=()=>{
    state ^= state<<13;state ^= state>>>17;state ^= state<<5;
    return (state>>>0)/4294967296;
  };
  const points=[];
  for(let j=0;j<28;j++) {
    const t=(j+.58*(random()-.5))*tau/28;
    const [c,a,b,w,d]=curve(t);
    const offsetA=(random()-.5)*w*.83,offsetB=(random()-.5)*d*.91;
    points.push(...add(add(c,mul(a,offsetA)),mul(b,offsetB)));
    if(j%4===1) points.push(...add(add(c,mul(a,-offsetA+.13)),mul(b,-offsetB-.072)));
  }
  return new Float64Array(points);
}
function capPlanes(centers,site,center) {
  const planes=[];
  for(let j=0;j<centers.length/3;j++) {
    if(j===site)continue;
    const next=Array.from(centers.subarray(3*j,3*j+3));
    const n=unit(sub(next,center));
    planes.push([n,dot(n,add(next,center))*.5]);
  }
  return planes;
}
function volumeOf(vertices,indices) {
  let measure=0;
  for(let k=0;k<indices.length;k+=3) {
    const [a,b,c]=[indices[k],indices[k+1],indices[k+2]].map(v=>Array.from(vertices.subarray(v*6,v*6+3)));
    measure+=dot(a,cross(b,c));
  }
  return measure/6;
}
export function buildSculpture() {
  const solid=bodyGeometry(),sites=makeSites(),chunks=fractureMesh(solid,sites);
  const positions=[],normals=[],centers=[],features=[],translation=[];
  const volume=volumeOf(solid.vertices,solid.indices);
  let totalVolume=0,capTriangles=0,triangles=0,maxOffset=0;
  const pieces=[];
  for(const {site,center,geometry} of chunks) {
    const {vertices,indices}=geometry;
    totalVolume+=volumeOf(vertices,indices);
    const planes=capPlanes(sites,site,center);
    const normalDirection=unit([center[0],center[1],center[2]*1.4]);
    const distance=.62+.29*(.5+.5*Math.sin(site*5.921))+.14*Math.cos(site*1.88);
    const lateral=.13*Math.sin(site*4.57),shift=[
      normalDirection[0]*distance-normalDirection[1]*lateral,
      normalDirection[1]*distance+normalDirection[0]*lateral,
      center[2]*.56+.22*Math.sin(site*2.38),
    ];
    maxOffset=Math.max(maxOffset,Math.hypot(...shift));
    const offset=positions.length/3;
    let cuts=0;
    for(let k=0;k<indices.length;k+=3) {
      const vertex=[indices[k],indices[k+1],indices[k+2]].map(v=>Array.from(vertices.subarray(v*6,v*6+6)));
      const cut=planes.some(([n,d])=>vertex.every(p=>Math.abs(dot(n,p)-d)<.000016&&dot(n,p.slice(3))>.992));
      capTriangles+=Number(cut);
      cuts+=Number(cut);
      triangles++;
      for(const v of vertex) {
        positions.push(v[0],v[1],v[2]);
        normals.push(v[3],v[4],v[5]);
        centers.push(...center);
        translation.push(...shift);
        features.push(cut?1:0,site);
      }
    }
    pieces.push({site,center,shift,offset,length:positions.length/3-offset,cuts});
  }
  if(chunks.length<28||capTriangles<200||Math.abs(totalVolume/volume-1)>.0002) {
    throw new Error('The assembled pieces did not reproduce the sculpture.');
  }
  const output={positions,normals,centers,features,translation};
  return {
    shape:Object.fromEntries(Object.entries(output).map(([key,value])=>[key,new Float32Array(value)])),
    stats:{pieces:chunks.length,triangles,capTriangles,volume,totalVolume,maxOffset},
    sites,pieces,
  };
}

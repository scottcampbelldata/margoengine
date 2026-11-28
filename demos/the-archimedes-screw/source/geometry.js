import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { across, lead, pitch, run, shellRadius, shaftRadius, tau, vertical, wetSection } from './screw.js';

export const origin = [0,.234,0];
export const world = ([x,y,z]) => [x*across-y*vertical,origin[1]+x*vertical+y*across,z];
export const mix = (a,b,v) => a.map((n,i)=>n+v*(b[i]-n));

export function tint(hex) {
  return Array.from({length:3},(_,i)=>{
    const s=parseInt(hex.slice(2*i+1,2*i+3),16)/255;
    return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;
  });
}

export function move(shape,[x,y,z],angle=0) {
  const c=Math.cos(angle),s=Math.sin(angle);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export const box = (x,y,z,p,r=.013,angle=0) => move(roundedBoxGeometry(x,y,z,1,r),p,angle);
export const upright = (r,h,p,sides=18) => move(cylinderGeometry(r,r,h,sides,1),p);
export const turn = (profile,p,sides=36) => move(latheGeometry(profile,sides),p,-Math.PI/2);
export const batch = pieces => mergeGeometries(pieces);

export class MeshData {
  data={positions:[],normals:[],colors:[],indices:[]};
  vertex(position,normal,tint) {
    const index=this.data.positions.length/3;
    this.data.positions.push(...position);this.data.normals.push(...normal);this.data.colors.push(...tint);
    return index;
  }
  face(a,b,c,color,expected) {
    const [x,y,z]=b.map((v,i)=>v-a[i]);
    const [u,v,w]=c.map((n,i)=>n-a[i]);
    const normal=[y*w-z*v,z*u-x*w,x*v-y*u];
    const length=Math.hypot(...normal);
    if(length<1e-9)return;
    const reverse=expected&&normal.reduce((sum,n,i)=>sum+n*expected[i],0)<0;
    const scale=(reverse?-1:1)/length;
    this.data.indices.push(...(reverse?[a,c,b]:[a,b,c]).map(p=>this.vertex(p,normal.map(n=>n*scale),color)));
  }
  quad(a,b,c,d,color,n) {this.face(a,b,c,color,n);this.face(a,c,d,color,n);}
  strip(a,b,c,d){this.data.indices.push(a,b,c,a,c,d);}
}

const point = (x,r,theta) => [x,r*Math.cos(theta),r*Math.sin(theta)];

export function flight() {
  const g=new MeshData();
  const copper=tint('#b68955');
  const ochre=tint('#c6a679');
  const ox=tint('#8a7156');
  const resolution=260;
  const split=6;
  const thickness=.012;
  const ring=split+1;
  const position=(j,i,sign)=>{
    const x=run*j/resolution;
    const r=shaftRadius-.002+(shellRadius-shaftRadius+.0002)*i/split;
    return point(x+sign*thickness/2,r,x/lead);
  };
  for(const side of [-1,1]){
    for(let j=0;j<=resolution;j++){
      const θ=run*j/(resolution*lead);
      for(let i=0;i<=split;i++){
        const p=position(j,i,side);
        const r=Math.hypot(p[1],p[2]);
        const scale=side/Math.hypot(r,lead);
        const n=[r*scale,Math.sin(θ)*lead*scale,-Math.cos(θ)*lead*scale];
        const stripe=Math.min(1,.17+.46*i/split+.12*Math.sin(θ+.77)+.11*Math.cos(10*θ+3*i));
        const idx=g.vertex(p,n,mix(side>0?copper:ox,ochre,stripe));
        if(j&&i){
          const back=idx-ring;
          if(side>0)g.strip(back-1,back,idx,idx-1);
          else g.strip(back-1,idx-1,idx,back);
        }
      }
    }
  }
  for(let i=0;i<resolution;i++){
    const a=run*(i+.5)/(resolution*lead);
    g.quad(position(i,split,-1),position(i,split,1),position(i+1,split,1),position(i+1,split,-1),ochre,[0,Math.cos(a),Math.sin(a)]);
  }
  for(const end of [0,resolution]){
    for(let i=0;i<split;i++)g.quad(position(end,i,-1),position(end,i+1,-1),position(end,i+1,1),position(end,i,1),copper);
  }
  return g.data;
}

export const skirtStart=2.82;
export const skirtEnd=5.86;
export function trough(from,to,inner,outer,start=skirtStart,end=skirtEnd) {
  const g=new MeshData();
  const standard=tint('#658288');
  const polished=tint('#8da7a7');
  const sections=54;
  for(let i=0;i<sections;i++){
    const a=start+(end-start)*i/sections;
    const b=start+(end-start)*(i+1)/sections;
    const curve=[0,Math.cos((a+b)/2),Math.sin((a+b)/2)];
    const inside=curve.map(n=>-n);
    const color=mix(standard,polished,.38+.20*Math.sin(a*2));
    g.quad(point(from,inner,a),point(to,inner,a),point(to,inner,b),point(from,inner,b),color,inside);
    g.quad(point(from,outer,a),point(to,outer,a),point(to,outer,b),point(from,outer,b),standard,curve);
    g.quad(point(from,inner,a),point(from,outer,a),point(from,outer,b),point(from,inner,b),polished,[-1,0,0]);
    g.quad(point(to,inner,a),point(to,outer,a),point(to,outer,b),point(to,inner,b),polished,[1,0,0]);
  }
  for(const a of [start,end]){
    const direction=a===start?-1:1;
    g.quad(point(from,inner,a),point(to,inner,a),point(to,outer,a),point(from,outer,a),polished,
      [0,-Math.sin(a)*direction,Math.cos(a)*direction]);
  }
  return g.data;
}

export function waterBucket(shift=0,clip=false) {
  const g=new MeshData();
  const bright=tint('#81d8d2');
  const mid=tint('#3cacae');
  const dark=tint('#247780');
  const up=[vertical,across,0];
  const strips=54;
  const acrossCount=4;
  let prior;
  for(let i=0;i<=strips;i++){
    const theta=Math.PI/2+i*Math.PI/strips;
    const slice=wetSection(theta);
    if(!slice){prior=undefined;continue;}
    const xmin=clip?Math.max(0,-(slice.start+shift)):0;
    const xmax=clip?Math.min(slice.depth,run-(slice.start+shift)):slice.depth;
    if(xmin>=xmax){prior=undefined;continue;}
    const line=Array.from({length:acrossCount+1},(_,j)=>{
      const lambda=xmin+(xmax-xmin)*j/acrossCount;
      const x=slice.start+lambda;
      const r=slice.inner+slice.growth*lambda;
      const waterColor=mix(mid,bright,.23+.48*Math.sin(j*Math.PI/acrossCount)**2+.15*Math.cos(theta*21+j*.7)**3);
      return {
        top:point(x,r,theta),
        skin:point(x,shellRadius-.0004,theta),
        color:waterColor,
      };
    });
    if(prior){
      for(let j=0;j<acrossCount;j++){
        g.quad(prior[j].top,prior[j+1].top,line[j+1].top,line[j].top,line[j].color,up);
        g.quad(prior[j].skin,prior[j+1].skin,line[j+1].skin,line[j].skin,dark,[0,Math.cos(theta),Math.sin(theta)]);
      }
      for(const j of [0,acrossCount]){
        g.quad(prior[j].top,prior[j].skin,line[j].skin,line[j].top,mid,[j===0?-1:1,0,0]);
      }
    }
    prior=line;
  }
  return g.data;
}

export function studio() {
  const g=new MeshData();
  const low=tint('#547379');
  const high=tint('#233a46');
  const ribs=[[-.040,8,0,low],[-.040,.51,0,low],[-.040,-.73,0,high]];
  for(let i=1;i<=18;i++){
    const a=Math.PI*i/36;
    ribs.push([-.040+1.52*(1-Math.cos(a)),-.73-1.52*Math.sin(a),a,mix(high,tint('#4b6374'),.42*Math.sin(a))]);
  }
  ribs.push([7,-2.25,Math.PI/2,high]);
  for(const [i,[y,z,a,color]] of ribs.entries()){
    for(const x of [-7,7])g.vertex([x,y,z],[0,Math.cos(a),Math.sin(a)],color);
    if(i){const j=(i-1)*2;g.strip(j,j+1,j+3,j+2);}
  }
  return g.data;
}
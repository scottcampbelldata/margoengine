import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4,mergeGeometries } from '@margoengine/geometry/utils';
import { Texture } from '@margoengine/materials';
import { axisHeight,exitX,inletX,radiusAt } from './flow.js';

export function place(shape,[x,y,z],roll=0) {
  const c=Math.cos(roll),s=Math.sin(roll);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export const box=(x,y,z,p,r=.007,roll=0)=>place(roundedBoxGeometry(x,y,z,1,r),p,roll);
export const vertical=(profile,point,sides=44)=>place(latheGeometry(profile,sides),point);
export const horizontal=(profile,point,sides=44)=>place(latheGeometry(profile,sides),point,-Math.PI/2);
export const round=(r,h,p,sides=24)=>place(cylinderGeometry(r,r,h,sides,1),p);
export const merge=list=>mergeGeometries(list);

export function pipeGlass() {
  const inner=Array.from({length:65},(_,i)=>{
    const x=inletX+(exitX-inletX)*i/64;
    return [radiusAt(x),x];
  });
  const outer=inner.map(([r,x])=>[r+.0048,x]);
  return horizontal([inner[0],...outer,...inner.slice().reverse()],[0,axisHeight,0],48);
}

export function pipeWater() {
  const water=Array.from({length:65},(_,i)=>{
    const x=inletX+(exitX-inletX)*i/64;
    return [radiusAt(x)-.00032,x];
  });
  return horizontal([[0,inletX],...water,[0,exitX]],[0,axisHeight,0],42);
}

function linear(hex) {
  return Array.from({length:3},(_,i)=>{
    const u=parseInt(hex.slice(1+2*i,3+2*i),16)/255;
    return u<=.04045?u/12.92:((u+.055)/1.055)**2.4;
  });
}

export function sweep() {
  const positions=[],normals=[],indices=[],colors=[];
  const floor=linear('#718a88'),deep=linear('#273d49'),blue=linear('#466274');
  const shape=[[-.020,4,0,floor],[-.020,.37,0,floor],[-.020,-.39,0,deep]];
  for(let i=1;i<=18;i++){
    const a=Math.PI*i/36;
    shape.push([-.020+.91*(1-Math.cos(a)),-.39-.91*Math.sin(a),a,deep.map((v,j)=>v+(blue[j]-v)*.47*Math.sin(a))]);
  }
  shape.push([4,-1.3,Math.PI/2,blue]);
  for(const [i,[y,z,a,tone]] of shape.entries()){
    for(const x of [-5,5]){
      positions.push(x,y,z);normals.push(0,Math.cos(a),Math.sin(a));colors.push(...tone);
    }
    if(i){const j=(i-1)*2;indices.push(j,j+1,j+2,j+1,j+3,j+2);}
  }
  return {positions,normals,colors,indices};
}

function lightMap(base,panels) {
  const side=64,data=new Uint8Array(side*side*4);
  for(let j=0;j<side;j++)for(let i=0;i<side;i++){
    const u=2*(i+.5)/side-1,v=2*(j+.5)/side-1;
    const face=Math.max(0,1-u*u-v*v);
    const rim=(1-Math.sqrt(face))**2;
    const shades=base.map((tone,k)=>tone+(k===0?23:38)*rim);
    for(const [a,b,xscale,yscale,tint] of panels){
      const power=Math.exp(-2*((u-a)/xscale)**4-1.5*((v-b)/yscale)**4);
      for(let k=0;k<3;k++)shades[k]+=power*tint[k];
    }
    const at=(j*side+i)*4;
    for(let k=0;k<3;k++)data[at+k]=Math.min(255,shades[k]);
    data[at+3]=255;
  }
  return new Texture({width:side,height:side,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

export function finish() {
  const panels=[
    [-.47,.19,.20,.76,[139,130,100]],
    [.52,.22,.21,.61,[78,119,132]],
    [.02,.66,.65,.13,[52,61,73]],
    [.02,-.56,.57,.13,[43,36,29]],
  ];
  return {
    glass:lightMap([48,83,91],panels),
    metal:lightMap([113,107,94],panels),
    water:lightMap([36,121,151],panels.map(([a,b,x,y,c])=>[a,b,x*1.2,y*1.07,c.map(v=>v*.49)])),
  };
}

const strokes=[[0,1,1],[1,.5,0],[1,-.5,0],[0,-1,1],[-1,-.5,0],[-1,.5,0],[0,0,1]];
const digits={0:[0,1,2,3,4,5],1:[1,2],2:[0,1,6,4,3],3:[0,1,6,2,3]};
export function label(text,[x,y,z]) {
  const geometry=[];
  for (const [place,digit] of [...text].entries()) {
    for(const index of digits[digit]){
      const [a,b,horizontal]=strokes[index];
      geometry.push(box(horizontal?.0043:.0011,horizontal?.0011:.0041,.001,
        [x+place*.0082+a*.0027,y+b*.0043,z],.00028));
    }
  }
  return geometry;
}
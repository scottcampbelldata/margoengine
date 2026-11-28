import { triangulateShape } from '@margoengine/geometry/triangulate';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { Texture } from '@margoengine/materials';
import { flange, gap, intake } from './pump.js';

export const tau = 2*Math.PI;
export const center = .235;

export function move(shape,[x,y,z],roll=0) {
  const c=Math.cos(roll),s=Math.sin(roll);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export const box=(w,h,d,r,p,roll=0)=>move(roundedBoxGeometry(w,h,d,1,r),p,roll);
export const pin=(r,h,p,sides=20)=>move(cylinderGeometry(r,r,h,sides,1),p);
export const turn=(profile,p,roll=0,sides=40)=>move(latheGeometry(profile,sides),p,roll);
export const merge=pieces=>mergeGeometries(pieces);

const normals=flange.map((_,i)=>{
  const a=flange[(i+flange.length-1)%flange.length],b=flange[(i+1)%flange.length];
  const d=Math.hypot(b[0]-a[0],b[1]-a[1]);
  return [-(b[1]-a[1])/d,(b[0]-a[0])/d];
});
const uv=(x,z)=>[(x+.028)/.46,(z+.154)/.308];
const data=()=>({positions:[],normals:[],uvs:[],indices:[]});
function vertex(shape,p,n,uv) {
  const index=shape.positions.length/3;
  shape.positions.push(...p);shape.normals.push(...n);shape.uvs.push(...uv);
  return index;
}

function cap(shape,ring,inner,y,up) {
  const {contour,holes,indices}=triangulateShape(ring,inner?[inner]:[]);
  const points=[...contour,...holes.flat()];
  const start=shape.positions.length/3;
  for(const [x,z] of points)vertex(shape,[x,y,z],[0,up,0],uv(x,z));
  for(let index=0;index<indices.length;index+=3){
    const [a,b,c]=indices.slice(index,index+3);
    const p=points[a],q=points[b],r=points[c];
    const normal=(q[1]-p[1])*(r[0]-p[0])-(q[0]-p[0])*(r[1]-p[1]);
    shape.indices.push(start+a,start+(up*normal<0?c:b),start+(up*normal<0?b:c));
  }
}

export function contour(scale=1) {
  return flange.map(([x,z])=>[center+(x-center)*scale,z*scale]);
}

function skin(shape,profiles,normals,inverted=false) {
  const width=profiles[0].length;
  const start=shape.positions.length/3;
  for(const [row,line] of profiles.entries()){
    for(const [col,[x,y,z]] of line.entries()){
      vertex(shape,[x,y,z],normals(row,col),uv(x,z));
      if(row){
        const a=start+(row-1)*width+col;
        const b=start+(row-1)*width+(col+1)%width;
        if(inverted)shape.indices.push(a,b+width,b,a,a+width,b+width);
        else shape.indices.push(a,b,b+width,a,b+width,a+width);
      }
    }
  }
}

export function board(from,to,hole,scale=1.07) {
  const thickness=to-from;
  const rim=contour(scale);
  const chamfer=contour(scale-.021);
  const air=hole?Array.from({length:32},(_,i)=>{
    const a=tau*i/32;
    return [intake[0]+.0225*Math.sin(a),intake[2]+.0225*Math.cos(a)];
  }):null;
  const levels=[[from,chamfer],[from+thickness*.23,rim],[from+thickness*.77,rim],[to,chamfer]];
  const shape=data();
  skin(shape,levels.map(([y,outline])=>outline.map(([x,z])=>[x,y,z])),
    (row,col)=>{
      const y=row===0?-.7:row===3?.7:0,[x,z]=normals[col];
      return [x,y,z].map(value=>value/Math.hypot(x,y,z));
    });
  if(air){
    skin(shape,[from,to].map(y=>air.map(([x,z])=>[x,y,z])),(_,i)=>{
      const a=tau*i/air.length;
      return [-Math.sin(a),0,-Math.cos(a)];
    },true);
  }
  cap(shape,chamfer,air,from,-1);
  cap(shape,chamfer,air,to,1);
  return shape;
}

export function leather(angle,natural) {
  const shape=data();
  const rings=32;
  const sin=Math.sin(angle),cos=Math.cos(angle);
  const profiles=Array.from({length:rings+1},(_,row)=>{
    const alpha=row/rings;
    const relief=Math.sin(Math.PI*alpha)**.6;
    const pitch=4.0*tau*alpha;
    return flange.map(([x,z],col)=>{
      const [ax,az]=normals[col];
      const expansion=.49+.51*Math.max(0,Math.min(1,(x-.036)/.19));
      const offset=relief*expansion*((.005+.011*(1-natural))*Math.cos(pitch)+.0045*Math.sin(pitch*2+.39));
      const y=alpha*(gap+x*sin);
      return [x*(1+alpha*(cos-1))+ax*offset,y,z+az*offset];
    });
  });
  const count=flange.length;
  skin(shape,profiles,(row,col)=>{
    const side=profiles[row][(col+1)%count],prev=profiles[row][(col+count-1)%count];
    const up=profiles[Math.min(rings,row+1)][col],below=profiles[Math.max(0,row-1)][col];
    const x=side[0]-prev[0],y=side[1]-prev[1],z=side[2]-prev[2];
    const a=up[0]-below[0],b=up[1]-below[1],c=up[2]-below[2];
    const nx=y*c-z*b,ny=z*a-x*c,nz=x*b-y*a;
    const scale=1/Math.hypot(nx,ny,nz);
    return [nx*scale,ny*scale,nz*scale];
  });
  return shape;
}

function texture(width,height,shade) {
  const bytes=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rgb=shade((x+.5)/width,(y+.5)/height);
    const offset=(y*width+x)*4;
    for(let channel=0;channel<3;channel++) bytes[offset+channel]=Math.max(0,Math.min(255,rgb[channel]));
    bytes[offset+3]=255;
  }
  return new Texture({width,height,data:bytes},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

export function walnut() {
  return texture(128,256,(x,y)=>{
    const flow=y+.014*Math.sin(8*x)+.012*Math.sin(13*x+12*y)+.004*Math.sin(27*x-5*y);
    const broad=Math.sin(47*flow+4.1*Math.sin(2.4*x-1.13*y));
    const rings=(.5+.5*Math.sin(161*flow+4.4*broad))**4;
    const lace=(.5+.5*Math.sin(462*flow+7.5*Math.sin(9*x+3*y)))**5;
    const salt=Math.sin((23.3*x+73.0*y)*137.2)*Math.cos(y*661);
    const grain=.87+.20*broad-.21*rings-.09*lace+.028*salt;
    return [157*grain,101*grain,71*grain];
  });
}

export function brass() {
  return texture(64,64,(u,v)=>{
    const x=(u-.5)*2,y=(v-.5)*2;
    const sheen=Math.exp(-((x+.46)**2/.045+(y-.22)**2/.31));
    const cool=Math.exp(-((x-.54)**2/.095+(y+.21)**2/.45));
    const bounce=Math.exp(-((x+.16)**2/.36+(y+.51)**2/.061));
    return [143+100*sheen+62*cool+49*bounce,94+113*sheen+81*cool+34*bounce,54+108*sheen+86*cool+20*bounce];
  });
}

export function sweep() {
  const shape=data();shape.colors=[];
  const courses=[[-.012,3,0,[.099,.077,.061]],[-.012,.28,0,[.099,.077,.061]],[-.012,-.28,0,[.045,.042,.036]]];
  for(let i=1;i<=16;i++){
    const angle=Math.PI*i/32;
    courses.push([-.012+.67*(1-Math.cos(angle)),-.28-.67*Math.sin(angle),angle,[.040,.044,.043]]);
  }
  courses.push([2.8,-.95,Math.PI/2,[.037,.039,.042]]);
  for(const [i,[y,z,a,c]] of courses.entries()){
    for(const x of [-3,3]){
      vertex(shape,[x,y,z],[0,Math.cos(a),Math.sin(a)],[0,0]);shape.colors.push(...c);
    }
    if(i){const j=(i-1)*2;shape.indices.push(j,j+1,j+2,j+1,j+3,j+2);}
  }
  return shape;
}
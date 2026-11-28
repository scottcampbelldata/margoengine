import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { boxGeometry, cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';

export function place(geometry,[x,y,z],yaw=0) {
  const c=Math.cos(yaw);
  const s=Math.sin(yaw);
  return applyMatrix4(geometry,[c,0,-s,0,0,1,0,0,s,0,c,0,x,y,z,1]);
}
export const box = (w,h,d,p,r=0,yaw=0) => place(r ? roundedBoxGeometry(w,h,d,1,r) : boxGeometry(w,h,d),p,yaw);
export const round = (radius,height,p,sides=18) => place(cylinderGeometry(radius,radius,height,sides,1),p);
export const turn = (profile,p,sides=40) => place(latheGeometry(profile,sides),p);
export const batch = pieces => mergeGeometries(pieces);
export const mix = (a,b,n) => a.map((x,i)=>x+n*(b[i]-x));
export const clamp = (x,lo=0,hi=1) => Math.max(lo,Math.min(hi,x));
export const tau = Math.PI * 2;
export function randomFrom(seed) { return ()=> (seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296; }

export function color(value) {
  return Array.from({length:3},(_,index)=>{
    const s=parseInt(value.slice(1+2*index,3+2*index),16)/255;
    return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;
  });
}

export class Geometry {
  data={positions:[],normals:[],colors:[],indices:[]};
  vertex(pos,n,tone) {
    const index=this.data.positions.length/3;
    this.data.positions.push(...pos);
    this.data.normals.push(...n);
    this.data.colors.push(...tone);
    return index;
  }
  face(a,b,c,tone) {
    const [x,y,z]=b.map((p,i)=>p-a[i]);
    const [u,v,w]=c.map((p,i)=>p-a[i]);
    const n=[y*w-z*v,z*u-x*w,x*v-y*u];
    const q=Math.hypot(...n);
    if (q > 1e-9) this.data.indices.push(...[a,b,c].map(p=>this.vertex(p,n.map(value=>value/q),tone)));
  }
  quad(a,b,c,d,tone) {this.face(a,b,c,tone);this.face(a,c,d,tone);}
  append(shape,tone) {
    const offset=this.data.positions.length/3;
    for(let i=0;i<shape.positions.length;i+=3)
      this.vertex(shape.positions.slice(i,i+3),shape.normals.slice(i,i+3),tone);
    for(const index of shape.indices) this.data.indices.push(offset+index);
  }
}

export const radius=14.75;
const div=108;
const deckBase=-2.70;

const gaussian = (x,z=0) => Math.exp(-x*x-z*z);

export function bed(x,z) {
  const back=-3.85+1.40*Math.sin(x*.39+.32)+.49*Math.sin(x*.93)
    +4.95*gaussian((x+8.40)/3.35) + 2.27*gaussian((x-11.15)/3.45);
  const d=back-z;
  const headland=1.10*gaussian((x+9.0)/3.2,(z+3.1)/3.4);
  const spit=1.07*gaussian((x+5.00)/3.65,(z-3.0)/2.95);
  const ripple=.19*Math.sin(1.22*x+.21*z)*Math.cos(.72*z)+.13*Math.sin(.47*x+1.46*z);
  const slope=d<1.0?.47:.34;
  return clamp(d*slope+ripple+headland+spit,-2.60,3.18);
}

export function disk(r,height,pigment) {
  const g=new Geometry();
  const rings=32;
  g.vertex([0,height(0,0),0],[0,1,0],pigment(0,0,height(0,0)));
  for(let row=1;row<=rings;row++) {
    const current=r*row/rings;
    const offset=1+(row-1)*(div+1);
    for(let j=0;j<=div;j++) {
      const angle=j*tau/div;
      const x=current*Math.sin(angle);
      const z=current*Math.cos(angle);
      const y=height(x,z);
      const step=.045;
      const nx=(height(x-step,z)-height(x+step,z))/(2*step);
      const nz=(height(x,z-step)-height(x,z+step))/(2*step);
      const n=1/Math.hypot(nx,1,nz);
      g.vertex([x,y,z],[n*nx,n,n*nz],pigment(x,z,y));
      if(j && row===1) g.data.indices.push(0,offset+j-1,offset+j);
      if(j && row>1) {
        const b=offset+j;
        const a=b-div-1;
        g.data.indices.push(a-1,b-1,b,a-1,b,a);
      }
    }
  }
  return g.data;
}

export function skirt(r,top,base,styling) {
  const data=new Geometry();
  for(let index=0;index<div;index++) {
    const a=index*tau/div,b=(index+1)*tau/div;
    const x=r*Math.sin(a), z=r*Math.cos(a);
    const q=r*Math.sin(b), w=r*Math.cos(b);
    data.quad([x,base,z],[q,base,w],[q,top(q,w),w],[x,top(x,z),z],styling((a+b)/2));
  }
  return data.data;
}

export function groundGeometry() {
  const sand=color('#a68e69');
  const wet=color('#807866');
  const stone=color('#aba88f');
  const green=color('#87957b');
  const underwater=color('#596e6e');
  return {
    top: disk(radius,bed,(x,z,elevation)=>{
      const weave=.45+.24*Math.sin(x*3.18+z*1.19)+.13*Math.sin(z*5.06-x*2.34);
      const grain=.07*Math.sin(z*8.3+x*6.5);
      const shore=elevation<0?mix(underwater,wet,clamp((elevation+1.7)/1.7)):mix(wet,sand,clamp(elevation/.6));
      const hillside=mix(stone,green,clamp(weave+.3));
      const shade=mix(shore,hillside,clamp((elevation-.51)*.78));
      return shade.map(value=>value*(.92+.13*weave+grain));
    }),
    side:skirt(radius,bed,deckBase,az=>mix(wet,stone,.25+.10*Math.sin(az*3))),
  };
}

export function skySweep() {
  const g=new Geometry();
  const cool=color('#698891');
  const warm=color('#b7bfad');
  const samples=[[-3.66,100,0,warm],[-3.66,16,0,warm],[-3.66,-12,0,cool]];
  for(let i=1;i<=19;i++) {
    const a=i*Math.PI/38;
    samples.push([-3.66+24*(1-Math.cos(a)),-12-24*Math.sin(a),a,mix(cool,color('#587c90'),Math.sin(a)*.65)]);
  }
  samples.push([90,-36,Math.PI/2,color('#587788')]);
  for(const [i,[y,z,a,c]] of samples.entries()) {
    for(const x of [-105,105])g.vertex([x,y,z],[0,Math.cos(a),Math.sin(a)],c);
    if(i){const n=(i-1)*2;g.data.indices.push(n,n+1,n+2,n+1,n+3,n+2);}
  }
  return g.data;
}
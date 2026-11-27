import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { Texture } from '@margoengine/materials';
import { tau } from './impulse.js';

export function place(shape,[x,y,z],roll=0){
  const c=Math.cos(roll),s=Math.sin(roll);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export function front(shape,[x,y,z]){
  return applyMatrix4(shape,[1,0,0,0,0,0,1,0,0,-1,0,0,x,y,z,1]);
}
export const box=(w,h,d,p,r=.008,roll=0)=>place(roundedBoxGeometry(w,h,d,1,r),p,roll);
export const round=(r,h,p,sides=24)=>place(cylinderGeometry(r,r,h,sides,1),p);
export const lathe=(profile,p,roll=0,sides=40)=>place(latheGeometry(profile,sides),p,roll);
export const disk=(profile,p,sides=56,start=0,length=tau)=>front(latheGeometry(profile,sides,start,length),p);
export const merge=shapes=>mergeGeometries(shapes);

function color(hex){
  return Array.from({length:3},(_,i)=>{
    const v=parseInt(hex.slice(1+i*2,3+i*2),16)/255;
    return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  });
}
export const mix=(a,b,n)=>a.map((v,i)=>v+n*(b[i]-v));

export class MeshData{
  data={positions:[],normals:[],colors:[],indices:[]};
  point(p,n,c){
    const i=this.data.positions.length/3;
    this.data.positions.push(...p);this.data.normals.push(...n);this.data.colors.push(...c);
    return i;
  }
  face(a,b,c,tint,n){
    const [x,y,z]=b.map((v,i)=>v-a[i]),[u,v,w]=c.map((n,i)=>n-a[i]);
    const norm=[y*w-z*v,z*u-x*w,x*v-y*u];
    const scale=1/Math.hypot(...norm);
    if(!Number.isFinite(scale))return;
    const back=n&&norm.reduce((sum,v,i)=>sum+v*n[i],0)<0;
    if(back)[b,c]=[c,b];
    this.data.indices.push(...[a,b,c].map(p=>this.point(p,norm.map(v=>v*scale*(back?-1:1)),tint)));
  }
  quad(a,b,c,d,color,n){this.face(a,b,c,color,n);this.face(a,c,d,color,n);}
}
export { color };


export function cup(){
  const g=new MeshData();
  const base=color('#c09970'),edge=color('#e7c89a'),back=color('#896042');
  const ring=32,divisions=9;
  const point=(side,t,r,skin)=>{
    const y=.035*r*Math.cos(t);
    const z=side*(.025+.0244*r*Math.sin(t));
    const notch=.006*Math.exp(-((Math.cos(t)-.95)**2)/.008)*r**7;
    const ridge=.0026*Math.sin(t*2)*r*r+.0013*Math.cos(t)*r;
    return [-.0188+.033*(1-r*r)+ridge+notch+skin*.004,y,z];
  };
  function normals(side,t,r,skin){
    if(r===0)return [skin?1:-1,0,0];
    const p=point(side,t-.0001,r,skin),q=point(side,t+.0001,r,skin);
    const a=point(side,t,r-.0001,skin),b=point(side,t,r+.0001,skin);
    const [x,y,z]=q.map((v,i)=>v-p[i]),[u,v,w]=b.map((v,i)=>v-a[i]);
    const n=[y*w-z*v,z*u-x*w,x*v-y*u];
    const direction=(skin?1:-1)*(n[0]<0?-1:1)/Math.hypot(...n);
    return n.map(x=>x*direction);
  }
  function indices(a,b,c,side,skin){
    if((side===1)===Boolean(skin))g.data.indices.push(a,b,c);
    else g.data.indices.push(a,c,b);
  }
  for(const side of [-1,1]){
    for(const skin of [0,1]){
      const centre=g.point(point(side,0,0,skin),[skin?1:-1,0,0],skin?back:base);
      for(let j=1;j<=divisions;j++){
        const r=j/divisions;
        const current=g.data.positions.length/3;
        for(let i=0;i<ring;i++){
          const t=tau*i/ring;
          const tone=skin?mix(back,base,.41+.34*r):mix(base,edge,.66*r*r+.10*Math.sin(t+.7));
          g.point(point(side,t,r,skin),normals(side,t,r,skin),tone);
        }
        for(let i=0;i<ring;i++){
          const k=(i+1)%ring,p=current+i,q=current+k;
          if(j===1)indices(centre,p,q,side,skin);
          else{
            indices(p-ring,p,q,side,skin);
            indices(p-ring,q,q-ring,side,skin);
          }
        }
      }
    }
    for(let i=0;i<ring;i++){
      const t0=tau*i/ring,t1=tau*(i+1)/ring,m=(t0+t1)*.5;
      g.quad(point(side,t0,1,0),point(side,t1,1,0),point(side,t1,1,1),point(side,t0,1,1),
        edge,[0,Math.cos(m),side*Math.sin(m)]);
    }
  }
  const y0=-.032,y1=.033;
  const spine=[[.015,.010],[-.024,0],[.015,-.010]];
  const cap=row=>spine.map(([x,z])=>[x,row,z]);
  const low=cap(y0),high=cap(y1);
  for(let i=0;i<3;i++){
    const j=(i+1)%3;
    g.quad(low[i],low[j],high[j],high[i],i===1?edge:base);
  }
  g.face(...low,base,[0,-1,0]);g.face(...high,edge,[0,1,0]);
  return g.data;
}

export function oak(){
  const n=new MeshData();
  const dark=color('#29322e'),light=color('#6b5740');
  for(let i=0;i<102;i++){
    const q=Math.sin(i*17.361)*953.7;
    const grain=q-Math.floor(q);
    const row=-.176+i*.0037+.0015*Math.sin(i*17.8);
    const start=-.532+.30*grain,span=.34+.49*(1-grain);
    const width=.00025+.00083*(.5+.5*Math.sin(i*9.18));
    const shade=mix(dark,light,.22+grain*.41);
    let p,q2;
    for(let j=0;j<=9;j++){
      const s=j/9,x=start+s*span;
      const z=row+.0016*Math.sin(j*.37+i*.68)+.00056*Math.sin(j*1.1-i*3.7);
      const a=[x,.03955,z],b=[x,.03955,z+width];
      if(j)n.quad(p,q2,b,a,shade,[0,1,0]);
      p=a;q2=b;
    }
  }
  return n.data;
}

export function basin(){
  const g=new MeshData(),edges=color('#428c89'),floor=color('#27636b'),mark=color('#b5d5bb');
  const w=37,h=23;
  for(let j=0;j<=h;j++){
    for(let i=0;i<=w;i++){
      const u=i/w,v=j/h,x=-.151+.646*u,z=-.146+.303*v;
      const d=Math.hypot(.88*(x-.132),1.9*(z-.045));
      const e=Math.max(Math.abs(2*u-1)**5,Math.abs(2*v-1)**5);
      const bands=.13*(.50+.50*Math.sin(d*144+Math.sin(v*27)*.9))*Math.exp(-7*d);
      const light=mix(mix(floor,edges,e*.74),mark,bands);
      g.point([x,.088+.00065*Math.sin(d*99),z],[0,1,0],light);
      if(i&&j){
        const d=i+j*(w+1),c=d-1,b=d-(w+1),a=b-1;
        g.data.indices.push(a,c,b,b,c,d);
      }
    }
  }
  return g.data;
}
function map(base,key){
  const width=64,d=new Uint8Array(width*width*4);
  for(let j=0;j<width;j++)for(let i=0;i<width;i++){
    const x=2*(i+.5)/width-1,y=2*(j+.5)/width-1;
    const shine=Math.exp(-2*((x+.51)/.22)**4-1.31*((y-.15)/.73)**4);
    const rim=Math.exp(-2*((x-.44)/.19)**4-1.52*((y-.23)/.58)**4);
    const bounce=Math.exp(-2*((x+.09)/.54)**4-1.39*((y+.53)/.15)**4);
    const at=(i+j*width)*4;
    for(let k=0;k<3;k++)d[at+k]=Math.min(255,base[k]+key[k]*shine+[74,96,112][k]*rim+[57,52,43][k]*bounce);
    d[at+3]=255;
  }
  return new Texture({width,height:width,data:d},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}
export const studioMaps=()=>({metal:map([122,111,101],[133,131,127]),water:map([31,131,151],[81,96,101])});

export function sweep(){
  const g=new MeshData();
  const surface=color('#91a39d'),air=color('#294752'),blue=color('#47636e');
  const rows=[[-.019,4.0,0,surface],[-.019,.34,0,surface],[-.019,-.43,0,air]];
  for(let i=1;i<=17;i++){
    const theta=Math.PI*i/34;
    rows.push([-.019+.92*(1-Math.cos(theta)),-.43-.92*Math.sin(theta),theta,mix(air,blue,.52*Math.sin(theta))]);
  }
  rows.push([5,-1.35,Math.PI/2,blue]);
  for(const [i,[y,z,t,tone]] of rows.entries()){
    for(const x of [-5,5])g.point([x,y,z],[0,Math.cos(t),Math.sin(t)],tone);
    if(i){const k=(i-1)*2;g.data.indices.push(k,k+1,k+2,k+1,k+3,k+2);}
  }
  return g.data;
}
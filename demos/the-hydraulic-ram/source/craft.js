import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4,mergeGeometries } from '@margoengine/geometry/utils';
import { Texture } from '@margoengine/materials';
export const tau=Math.PI*2;

export function move(shape,[x,y,z],roll=0) {
  const c=Math.cos(roll),s=Math.sin(roll);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export const box=(w,h,d,p,r=.006,roll=0)=>move(roundedBoxGeometry(w,h,d,1,r),p,roll);
export const turn=(profile,p,roll=0,sides=38)=>move(latheGeometry(profile,sides),p,roll);
export const round=(r,h,p,sides=18)=>move(cylinderGeometry(r,r,h,sides,1),p);
export const merge=pieces=>mergeGeometries(pieces);

export function tube(points,radius,sides=24) {
  const positions=[],normals=[],indices=[];
  for(const [i,[x,y,z]] of points.entries()){
    const a=points[Math.max(0,i-1)],b=points[Math.min(i+1,points.length-1)];
    const dx=b[0]-a[0],dy=b[1]-a[1],inverse=1/Math.hypot(dx,dy);
    for(let j=0;j<=sides;j++){
      const angle=tau*j/sides;
      const c=Math.cos(angle),s=Math.sin(angle);
      const n=[-dy*inverse*c,dx*inverse*c,s];
      positions.push(x+n[0]*radius,y+n[1]*radius,z+n[2]*radius);normals.push(...n);
      if(i&&j){
        const k=positions.length/3-1,d=k-sides-1;
        indices.push(d-1,d,k-1,k-1,d,k);
      }
    }
  }
  return {positions,normals,indices};
}

export function line(points){
  let total=0;
  const path=points.map((point,i)=>{
    if(i)total+=Math.hypot(...point.map((n,k)=>n-points[i-1][k]));
    return {point,total};
  });
  return fraction=>{
    const distance=fraction*total;
    const index=Math.max(1,path.findIndex(x=>x.total>=distance));
    const a=path[index-1],b=path[index];
    const factor=(distance-a.total)/(b.total-a.total);
    return {
      p:a.point.map((n,j)=>n+(b.point[j]-n)*factor),
      a:Math.atan2(b.point[1]-a.point[1],b.point[0]-a.point[0]),
    };
  };
}

function environment(palette,lights) {
  const width=64,data=new Uint8Array(width*width*4);
  for(let j=0;j<width;j++)for(let i=0;i<width;i++){
    const u=2*(i+.5)/width-1,v=2*(j+.5)/width-1;
    const rim=(1-Math.sqrt(Math.max(0,1-u*u-v*v)))**2;
    const c=palette.map((n,k)=>n+rim*(29+k*13));
    for(const [x,y,w,h,tint] of lights){
      const strength=Math.exp(-2.12*((u-x)/w)**4-1.36*((v-y)/h)**4);
      for(let k=0;k<3;k++)c[k]+=strength*tint[k];
    }
    const offset=4*(j*width+i);
    for(let k=0;k<3;k++)data[offset+k]=Math.min(255,c[k]);
    data[offset+3]=255;
  }
  return new Texture({width,height:width,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

export function lighting(){
  const strips=[[-.50,.23,.18,.69,[135,144,118]],[.45,.21,.20,.59,[91,115,129]],[.05,.68,.62,.15,[73,66,59]],[-.01,-.52,.59,.13,[33,30,25]]];
  return {
    metal:environment([103,112,102],strips),
    glass:environment([44,70,74],strips),
    liquid:environment([30,126,149],strips.map(([x,y,w,h,c])=>[x,y,w*1.14,h,c.map(n=>n*.50)])),
  };
}

export function studio(){
  const positions=[],normals=[],indices=[],colors=[];
  const rows=[[-.015,4,0,[.142,.170,.139]],[-.015,.40,0,[.142,.170,.139]],[-.015,-.42,0,[.041,.060,.062]]];
  for(let i=1;i<=16;i++){
    const a=i*Math.PI/32;
    rows.push([-.015+.92*(1-Math.cos(a)),-.42-.92*Math.sin(a),a,[.043,.064,.067]]);
  }
  rows.push([6,-1.34,Math.PI/2,[.059,.092,.100]]);
  for(const [i,[y,z,a,c]] of rows.entries()){
    for(const x of [-5,5]){positions.push(x,y,z);normals.push(0,Math.cos(a),Math.sin(a));colors.push(...c);}
    if(i){const k=(i-1)*2;indices.push(k,k+1,k+2,k+1,k+3,k+2);}
  }
  return {positions,normals,indices,colors};
}
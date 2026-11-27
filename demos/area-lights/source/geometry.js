
import {Geometry} from '@margoengine/core';

const full=2*Math.PI;
const unit=(x,y,z)=>{const d=Math.hypot(x,y,z)||1;return [x/d,y/d,z/d];};

function sheet(){return {positions:[],normals:[],indices:[]};}
function patch(target,points,normals){
  const from=target.positions.length/3;
  for(const [index,point] of points.entries()){
    target.positions.push(...point);
    target.normals.push(...normals[index]);
  }
  for(let index=1;index<points.length-1;index++)target.indices.push(from,from+index,from+index+1);
}
const finish=data=>new Geometry(data.positions,data.normals,data.indices);

function outline(hx,hz,corner,y){
  const points=[];
  for(const [phase,sx,sz] of [[0,1,1],[1,-1,1],[2,-1,-1],[3,1,-1]]){
    for(let i=0;i<=4;i++){
      const theta=(phase+i/4)*Math.PI/2;
      points.push([sx*(hx-corner)+corner*Math.cos(theta),y,sz*(hz-corner)+corner*Math.sin(theta)]);
    }
  }
  return points;
}
export function tray(w,h,d,corner=.09,bevel=.017){
  const data=sheet();
  const levels=[
    [w/2-bevel,d/2-bevel,corner-bevel,-h/2],
    [w/2,d/2,corner,-h/2+bevel],
    [w/2,d/2,corner,h/2-bevel],
    [w/2-bevel,d/2-bevel,corner-bevel,h/2],
  ].map(([x,z,r,y])=>outline(x,z,r,y));
  for(let row=0;row<levels.length-1;row++){
    const a=levels[row],b=levels[row+1];
    for(let i=0;i<a.length;i++){
      const j=(i+1)%a.length, difference=b[i][1]-a[i][1];
      const x=a[j][2]-a[i][2], z=a[i][0]-a[j][0];
      const elevation=row===0?-1:row===2?1:0;
      const n=unit(x,elevation*difference,z);
      patch(data,[a[i],b[i],b[j],a[j]],[n,n,n,n]);
    }
  }
  const top=[...levels.at(-1)].reverse(),bottom=levels[0];
  patch(data,top,top.map(()=>[0,1,0]));
  patch(data,bottom,bottom.map(()=>[0,-1,0]));
  return finish(data);
}

export function ringProfile(profile,segments=60){
  const data=sheet();
  const directions=Array.from({length:segments},(_,i)=>{
    const angle=i/segments*full;
    return [Math.cos(angle),Math.sin(angle)];
  });
  const rounds=profile.map(([height,radius])=>
    directions.map(([cosine,sine])=>[radius*cosine,height,radius*sine]));
  const normals=profile.map((_,ring)=>{
    const [lower,lr]=profile[Math.max(0,ring-1)], [upper,ur]=profile[Math.min(profile.length-1,ring+1)];
    return directions.map(([cosine,sine])=>unit((upper-lower)*cosine,lr-ur,(upper-lower)*sine));
  });
  for(let ring=0;ring<rounds.length-1;ring++){
    const a=rounds[ring],b=rounds[ring+1],na=normals[ring],nb=normals[ring+1];
    for(let i=0;i<segments;i++){
      const j=(i+1)%segments;
      patch(data,[a[i],b[i],b[j],a[j]],[na[i],nb[i],nb[j],na[j]]);
    }
  }
  return finish(data);
}

export function sphere(radius,segments=56,rings=30){
  const profile=Array.from({length:rings+1},(_,i)=>{
    const phi=Math.PI*(i/rings-.5);
    return [radius*Math.sin(phi),radius*Math.max(0,Math.cos(phi))];
  });
  return ringProfile(profile,segments);
}

// An emitter tube lies along X. Its dimensions describe cap centres and outer radius.
export function capsule(radius,halfLength,segments=40){
  const rings=[];
  for(let i=0;i<=8;i++){
    const angle=Math.PI*(i/8-1)/2;
    rings.push([-halfLength+radius*Math.sin(angle),radius*Math.cos(angle)]);
  }
  for(let i=0;i<=8;i++){
    const angle=Math.PI*i/16;
    rings.push([halfLength+radius*Math.sin(angle),radius*Math.cos(angle)]);
  }
  const model=ringProfile(rings,segments);
  const p=[],n=[];
  for(let i=0;i<model.vertices.length;i+=6){
    const [x,y,z,nx,ny,nz]=model.vertices.subarray(i,i+6);
    p.push(y,-x,z);
    n.push(ny,-nx,nz);
  }
  return new Geometry(p,n,model.indices);
}

export function cyclorama(){
  const data=sheet(), width=6;
  const sweep=[[-.09,9,[0,1,0]],[-.09,-1.4,[0,1,0]]];
  for(let i=1;i<=19;i++){
    const angle=Math.PI*i/38, c=Math.cos(angle),s=Math.sin(angle);
    sweep.push([-.09+.85*(1-c),-1.4-.85*s,[0,c,s]]);
  }
  sweep.push([5,-2.25,[0,0,1]]);
  for(let i=0;i<sweep.length-1;i++){
    const [y,z,n]=sweep[i],[ny,nz,nn]=sweep[i+1];
    patch(data,[[-width,y,z],[width,y,z],[width,ny,nz],[-width,ny,nz]],[n,n,nn,nn]);
  }
  return finish(data);
}

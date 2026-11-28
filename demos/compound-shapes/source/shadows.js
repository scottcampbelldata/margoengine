import { Geometry } from '@margoengine/core';
import { deck,ramp,specimens } from './layout.js';

export const light=[-.54,.72,.44,3.0];

function rotate([x,y,z],[a,b,c,w]){
  const u=2*(b*z-c*y),v=2*(c*x-a*z),t=2*(a*y-b*x);
  return [x+w*u+b*t-c*v,y+w*v+c*u-a*t,z+w*t+a*v-b*u];
}

function outline(part){
  const points=[];
  if(part.shape==='box'){
    const [x,y,z]=part.halfExtents;
    for(const a of [-x,x])for(const b of [-y,y])for(const c of [-z,z])points.push([a,b,c]);
  }else if(part.shape==='sphere'){
    for(let j=0;j<=5;j++){
      const pitch=j*Math.PI/5;
      for(let i=0;i<20;i++){
        const yaw=i*Math.PI/10,ring=Math.sin(pitch)*part.radius;
        points.push([ring*Math.cos(yaw),part.radius*Math.cos(pitch),ring*Math.sin(yaw)]);
      }
    }
  }else{
    for(const y of [-part.halfHeight,part.halfHeight])for(let i=0;i<24;i++){
      const arc=i*Math.PI/12;
      points.push([part.radius*Math.cos(arc),y,part.radius*Math.sin(arc)]);
    }
  }
  return points.map(point=>(part.rotation?rotate(point,part.rotation):point).map((value,i)=>value+part.offset[i]));
}
const clouds=specimens.map(item=>item.parts.map(outline));

function hull(rows){
  const sorted=rows.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const side=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function chain(list){
    const path=[];
    for(const point of list){
      while(path.length>=2&&side(path.at(-2),path.at(-1),point)<=1e-10)path.pop();
      path.push(point);
    }
    return path.slice(0,-1);
  }
  return chain(sorted).concat(chain(sorted.reverse()));
}
function trim(rows,axis,and,side){
  const result=[];
  for(let i=0;i<rows.length;i++){
    const a=rows[i],b=rows[(i+1)%rows.length],x=side*(a[axis]-and),y=side*(b[axis]-and);
    if(x<=0)result.push(a);
    if(x*y<0){
      const q=x/(x-y);
      result.push(a.map((v,i)=>v+q*(b[i]-v)));
    }
  }
  return result;
}
const sine=Math.sin(ramp.angle),cosine=Math.cos(ramp.angle);
const surfaces=[
  {x:deck.size[0]/2-.009,depth:deck.size[2]/2-.009,y:0,z:0,tilt:0},
  {x:ramp.size[0]/2-.005,depth:cosine*ramp.size[2]/2-.007,
    y:ramp.position[1]+cosine*ramp.size[1]/2,z:ramp.position[2]+sine*ramp.size[1]/2,tilt:sine/cosine},
];

export function shadows(bodies,alpha){
  const pieces=[];
  for(let i=0;i<bodies.length;i++){
    const p=bodies[i].pose,turn=[];
    const sign=p[3]*p[10]+p[4]*p[11]+p[5]*p[12]+p[6]*p[13]<0?-1:1;
    for(let j=3;j<7;j++)turn.push(p[j]+alpha*(sign*p[j+7]-p[j]));
    const length=Math.hypot(...turn);
    const rotation=turn.map(value=>value/length);
    const origin=[0,1,2].map(j=>p[j]+alpha*(p[j+7]-p[j]));
    for(const samples of clouds[i])pieces.push(samples.map(point=>rotate(point,rotation).map((value,j)=>value+origin[j])));
  }
  return surfaces.map(surface=>{
    const positions=[],normals=[],indices=[];
    const key=light[1]+surface.tilt*light[2],normal=Math.hypot(1,surface.tilt);
    for(const vertices of pieces){
      const above=vertices.map(point=>point[1]-surface.y+(point[2]-surface.z)*surface.tilt);
      if(above.every(value=>value<=0))continue;
      let loop=hull(vertices.map((point,i)=>{
        const d=Math.max(0,above[i])/key;
        return [point[0]-d*light[0],point[2]-d*light[2]];
      }));
      loop=trim(trim(trim(trim(loop,0,surface.x,1),0,-surface.x,-1),1,surface.z+surface.depth,1),1,surface.z-surface.depth,-1);
      if(loop.length<3)continue;
      const start=positions.length/3;
      for(const [x,z] of loop){
        positions.push(x,surface.y-(z-surface.z)*surface.tilt+.00048,z);
        normals.push(0,1/normal,surface.tilt/normal);
      }
      for(let i=1;i+1<loop.length;i++)indices.push(start,start+i+1,start+i);
    }
    return new Geometry(positions,normals,indices);
  });
}

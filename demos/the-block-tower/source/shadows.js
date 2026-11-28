import { Geometry } from '@margoengine/core';
import { baseHeight,plinthSize,floorHeight } from './layout.js';

export const sunDirection=[-.54,.72,.44,2.4];

function corners(entity){
  const {size,body,center,rotation}=entity;
  const position=body?.position??center;
  const q=body?.rotation??rotation;
  const [a,b,c,w]=q;
  const points=[];
  for(const x of [-size[0]/2,size[0]/2])for(const y of [-size[1]/2,size[1]/2])for(const z of [-size[2]/2,size[2]/2]){
    const u=2*(b*z-c*y),v=2*(c*x-a*z),t=2*(a*y-b*x);
    points.push([position[0]+x+w*u+b*t-c*v,position[1]+y+w*v+c*u-a*t,position[2]+z+w*t+a*v-b*u]);
  }
  return points;
}

function convexHull(points){
  const sorted=points.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const turn=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function half(list){
    const result=[];
    for(const p of list){
      while(result.length>=2&&turn(result.at(-2),result.at(-1),p)<=1e-10)result.pop();
      result.push(p);
    }
    return result.slice(0,-1);
  }
  return half(sorted).concat(half(sorted.reverse()));
}

function trim(vertices,axis,bound,sign){
  const clipped=[];
  for(let i=0;i<vertices.length;i++){
    const a=vertices[i],b=vertices[(i+1)%vertices.length];
    const da=(a[axis]-bound)*sign,db=(b[axis]-bound)*sign;
    if(da<=0)clipped.push(a);
    if(da*db<0){
      const t=da/(da-db);
      clipped.push(a.map((value,j)=>value+t*(b[j]-value)));
    }
  }
  return clipped;
}

export function projectShadows(entities){
  const shapes=entities.map(corners);
  return [baseHeight,floorHeight].map((height,isFloor)=>{
    const positions=[],normals=[],indices=[];
    const [a,b,c]=sunDirection;
    for(const shape of shapes){
      if(shape.every(point=>point[1]<=height))continue;
      let polygon=convexHull(shape.map(([x,y,z])=>{
        const offset=Math.max(0,y-height)/b;
        return [x-offset*a,z-offset*c];
      }));
      if(!isFloor){
        const [x,z]=plinthSize.map(value=>value/2-.004);
        polygon=trim(trim(trim(trim(polygon,0,x,1),0,-x,-1),1,z,1),1,-z,-1);
      }
      if(polygon.length<3)continue;
      const start=positions.length/3;
      for(const [x,z] of polygon){
        positions.push(x,height+.00009,z);
        normals.push(0,1,0);
      }
      for(let i=1;i+1<polygon.length;i++)indices.push(start,start+i+1,start+i);
    }
    return new Geometry(positions,normals,indices);
  });
}

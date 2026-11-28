import {Geometry,PbrMaterial,box} from '@margoengine/core';

export const tau=Math.PI*2;

// Each adjacent pair is a bevel, face or barrel. The order runs clockwise in radius/depth.
export function turning(profile,segments=64){
  const points=[],normals=[],indices=[];
  for(let row=1;row<profile.length;row++){
    const [r0,z0]=profile[row-1],[r1,z1]=profile[row],dr=r1-r0,dz=z1-z0;
    const d=Math.hypot(dr,dz),base=points.length/3;
    for(let k=0;k<=segments;k++){
      const a=k*tau/segments,x=Math.cos(a),y=Math.sin(a);
      points.push(r0*x,r0*y,z0,r1*x,r1*y,z1);
      normals.push(dz/d*x,dz/d*y,-dr/d,dz/d*x,dz/d*y,-dr/d);
      if(k){
        const i=base+k*2;
        indices.push(i-2,i,i-1,i-1,i,i+1);
      }
    }
  }
  return new Geometry(points,normals,indices);
}
export const disc=(radius,back,front,edge,segments)=>turning([
  [0,back],[radius-edge,back],[radius,back+edge],[radius,front-edge],[radius-edge,front],[0,front],
],segments);
export const rim=(inner,outer,back,front,bevel,segments)=>turning([
  [inner+bevel,back],[outer-bevel,back],[outer,back+bevel],[outer,front-bevel],
  [outer-bevel,front],[inner+bevel,front],[inner,front-bevel],[inner,back+bevel],[inner+bevel,back],
],segments);

export function surrounds(radius,width,bottom,top){
  const points=[],normals=[],indices=[];
  for(let i=0;i<=96;i++){
    const angle=i*tau/96,x=Math.cos(angle),y=Math.sin(angle);
    const t=Math.min(width/Math.max(.0001,Math.abs(x)),(y>0?top:-bottom)/Math.max(.0001,Math.abs(y)));
    points.push(x*radius,y*radius,0,x*t,y*t,0);
    normals.push(0,0,1,0,0,1);
    if(i)indices.push(i*2-2,i*2-1,i*2,i*2,i*2-1,i*2+1);
  }
  return new Geometry(points,normals,indices);
}

export function marks(inner,outer,depth,amount,halfWidth,major=5,minor=.52){
  const p=[],n=[],index=[];
  for(let i=0;i<amount;i++){
    const a=i*tau/amount,r=i%major?outer+(inner-outer)*minor:inner;
    const k=p.length/3;
    for(const [radius,angle] of [[r,a-halfWidth],[outer,a-halfWidth],[outer,a+halfWidth],[r,a+halfWidth]]){
      p.push(radius*Math.cos(angle),radius*Math.sin(angle),depth);n.push(0,0,1);
    }
    index.push(k,k+1,k+2,k,k+2,k+3);
  }
  return new Geometry(p,n,index);
}

export function studio(engine){
  const unit=box(),materials=new Map();
  function paint(color,roughness=.69,metalness=0){
    const key=[color,roughness,metalness].join('~');
    if(!materials.has(key))materials.set(key,new PbrMaterial({color,roughness,metalness}));
    return materials.get(key);
  }
  function solid(name,geometry,material,position=[0,0,0],parent){
    const mesh=engine.createMesh(parent).setPosition(position);
    mesh.name=name;
    if(geometry)mesh.setGeometry(geometry).setMaterial(material);
    return mesh;
  }
  function block(name,material,position,size,parent){
    return solid(name,unit,material,position,parent).setScale(size);
  }
  return {paint,solid,block};
}

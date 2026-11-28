import {Geometry,PbrMaterial} from '@margoengine/core';

const sun=[-2.6,7.6,4.1];
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];
const turn=(p,[x,y,z,w])=>{
  const a=[x,y,z],twice=cross(a,p).map(v=>2*v),additional=cross(a,twice);
  return p.map((v,i)=>v+w*twice[i]+additional[i]);
};
const determinant=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);

function hull(points){
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  function chain(list){
    const output=[];
    for(const point of list){
      while(output.length>1&&determinant(output.at(-2),output.at(-1),point)<=1e-9)output.pop();
      output.push(point);
    }
    return output.slice(0,-1);
  }
  return [...chain(points),...chain(points.toReversed())];
}
function clip(polygon,axis,sign,edge){
  const cut=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length];
    const start=sign*(a[axis]-edge),end=sign*(b[axis]-edge);
    if(start<=0)cut.push(a);
    if((start<=0)!==(end<=0)){
      const fraction=start/(start-end);
      cut.push(a.map((v,j)=>v+(b[j]-v)*fraction));
    }
  }
  return cut;
}
function project(half,p,q,floor,limit,softness){
  const points=[];
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
    const off=turn([x*half[0],y*half[1],z*half[2]],q);
    const height=Math.max(0,off[1]+p[1]-floor);
    points.push([off[0]+p[0]-sun[0]*height/sun[1],off[2]+p[2]-sun[2]*height/sun[1]]);
  }
  const ring=hull(points);
  const center=[0,1].map(axis=>ring.reduce((sum,p)=>sum+p[axis],0)/ring.length);
  let outline=ring.map(p=>p.map((x,i)=>x+(x-center[i])*softness));
  if(limit)outline=clip(clip(outline,1,1,limit[1]),1,-1,limit[0]);
  if(outline.length<3)return null;
  const positions=[],normals=[],indices=[];
  for(const [x,z] of outline){positions.push(x,floor,z);normals.push(0,1,0);}
  for(let i=1;i<outline.length-1;i++)indices.push(0,i+1,i);
  return new Geometry(positions,normals,indices);
}
export function caster(engine,half,color,ground,limit,contactOnly=false){
  const shades=contactOnly?[.92,.84,.72]:[.84,.69,.55];
  const tinted=shades.map(scale=>{
    const shade=color.match(/../g).map(s=>Math.round(parseInt(s,16)*scale).toString(16).padStart(2,'0')).join('');
    return new PbrMaterial({color:'#'+shade,roughness:.75,doubleSided:false});
  });
  const meshes=tinted.map(material=>engine.createMesh().setMaterial(material));
  const sizes=contactOnly?[.048,.025,.009]:[.20,.10,0];
  return (p,q= [0,0,0,1])=>{
    for(let i=0;i<meshes.length;i++){
      const polygon=project(half,p,q,ground+i*.0008,limit,sizes[i]);
      meshes[i].visible=Boolean(polygon);
      if(polygon)meshes[i].setGeometry(polygon);
    }
  };
}

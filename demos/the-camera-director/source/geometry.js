import {Geometry,PbrMaterial,box} from '@margoengine/core';

export const tau=Math.PI*2;
export function profile(rows,segments=54){
  const p=[],n=[],f=[];
  for(let row=1;row<rows.length;row++){
    const [r0,z0]=rows[row-1],[r1,z1]=rows[row],dr=r1-r0,dz=z1-z0;
    const m=Math.hypot(dr,dz),base=p.length/3;
    if(!m)continue;
    for(let i=0;i<=segments;i++){
      const a=i*tau/segments,c=Math.cos(a),s=Math.sin(a);
      p.push(r0*c,r0*s,z0,r1*c,r1*s,z1);
      n.push(dz*c/m,dz*s/m,-dr/m,dz*c/m,dz*s/m,-dr/m);
      if(i){const k=base+i*2;f.push(k-2,k,k-1,k-1,k,k+1);}
    }
  }
  return new Geometry(p,n,f);
}
export const disc=(r,b,t,bevel,segments)=>profile([
  [0,b],[r-bevel,b],[r,b+bevel],[r,t-bevel],[r-bevel,t],[0,t],
],segments);

export function polygonMesh(){
  const p=[],n=[],f=[];
  function face(a,b,c){
    const x=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],y=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const cross=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
    const length=Math.hypot(...cross);
    if(length<1e-10)return;
    const i=p.length/3;
    for(const v of [a,b,c]){p.push(v[0],v[1],v[2]);n.push(cross[0]/length,cross[1]/length,cross[2]/length);}
    f.push(i,i+1,i+2);
  }
  function quad(a,b,c,d){face(a,b,c);face(a,c,d);}
  function smoothQuad(a,b,c,d,normals){
    const i=p.length/3;
    for(const [k,vertex] of [a,b,c,d].entries()){
      p.push(...vertex);
      n.push(...normals[k]);
    }
    f.push(i,i+1,i+2,i,i+2,i+3);
  }
  function ribbon(a,b,width){
    const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
    if(!length)return;
    const x=-dz*width/(2*length),z=dx*width/(2*length);
    quad([a[0]+x,a[1],a[2]+z],[b[0]+x,b[1],b[2]+z],
      [b[0]-x,b[1],b[2]-z],[a[0]-x,a[1],a[2]-z]);
  }
  return {face,quad,smoothQuad,ribbon,geometry:()=>f.length?new Geometry(p,n,f):null};
}

export function beveledBlock(w,h,d,bevel){
  const x=w/2,y=h/2,z=d/2,m=polygonMesh(),corners=(width,depth)=>[
    [-width+bevel,-depth],[width-bevel,-depth],[width,-depth+bevel],[width,depth-bevel],
    [width-bevel,depth],[-width+bevel,depth],[-width,depth-bevel],[-width,-depth+bevel],
  ];
  const b=bevel*.56;
  const layers=[
    [x-b,z-b,-y],[x,z,-y+b],[x,z,y-b],[x-b,z-b,y],
  ].map(([a,c,v])=>corners(a,c).map(([u,w])=>[u,v,w]));
  for(let l=1;l<layers.length;l++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    m.quad(layers[l-1][j],layers[l-1][i],layers[l][i],layers[l][j]);
  }
  for(let i=1;i<7;i++){
    m.face(layers[0][0],layers[0][i],layers[0][i+1]);
    m.face(layers[3][0],layers[3][i+1],layers[3][i]);
  }
  return m.geometry();
}

export function studio(engine){
  const cube=box(),materials=new Map();
  function paint(color,roughness=.8,metalness=0){
    const key=[color,roughness,metalness].join('/');
    if(!materials.has(key))materials.set(key,new PbrMaterial({color,roughness,metalness}));
    return materials.get(key);
  }
  function mesh(name,geometry,material,position=[0,0,0],parent){
    const node=engine.createMesh(parent).setPosition(position);
    node.name=name;
    if(geometry)node.setGeometry(geometry).setMaterial(material);
    return node;
  }
  function block(name,material,point,size,parent){return mesh(name,cube,material,point,parent).setScale(size);}
  function beam(name,material,a,b,width,depth,parent){
    const delta=b.map((v,i)=>v-a[i]),length=Math.hypot(...delta);
    const d=delta.map(v=>v/length);
    const q=d[1]<-.999999?[1,0,0,0]:[d[2],0,-d[0],1+d[1]];
    return block(name,material,a.map((v,i)=>(v+b[i])/2),[width,length,depth],parent).setQuaternion(q);
  }
  function diskAt(name,geometry,material,point,parent){
    return mesh(name,geometry,material,point,parent).setRotation([-Math.PI/2,0,0]);
  }
  return {paint,mesh,block,beam,diskAt};
}

export function random(seed){
  return ()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  };
}

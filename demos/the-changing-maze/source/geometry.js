import {Geometry,PbrMaterial,box} from '@margoengine/core';

const tau=Math.PI*2;
const half=Math.PI/2;
function railLoop(width,depth,r,steps){
  const loop=[];
  for(let c=0;c<4;c++){
    const a=half*(c+.5),x=Math.sign(Math.cos(a))*(width*.5-r),z=Math.sign(Math.sin(a))*(depth*.5-r);
    for(let j=0;j<=steps;j++){
      const t=half*(c+j/steps);
      loop.push([x+Math.cos(t)*r,z+Math.sin(t)*r]);
    }
  }
  return loop;
}
export function roundedTray(width,depth,corner,bottom,top,bevel,steps=8){
  const profile=[
    [width-2*bevel,depth-2*bevel,corner-bevel,bottom],
    [width,depth,corner,bottom+bevel],
    [width,depth,corner,top-bevel],
    [width-2*bevel,depth-2*bevel,corner-bevel,top],
  ];
  const rows=profile.map(([w,d,r,y])=>railLoop(w,d,r,steps).map(([x,z])=>[x,y,z]));
  const p=[],normals=[],index=[];
  function tri(a,b,c){
    const ax=b[0]-a[0],ay=b[1]-a[1],az=b[2]-a[2],bx=c[0]-a[0],by=c[1]-a[1],bz=c[2]-a[2];
    const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,m=Math.hypot(nx,ny,nz)||1,k=p.length/3;
    p.push(...a,...b,...c);
    for(let j=0;j<3;j++)normals.push(nx/m,ny/m,nz/m);
    index.push(k,k+1,k+2);
  }
  for(let row=0;row<rows.length-1;row++)for(let i=0;i<rows[row].length;i++){
    const next=(i+1)%rows[row].length,a=rows[row][i],b=rows[row][next],c=rows[row+1][i],d=rows[row+1][next];
    tri(a,c,b);tri(b,c,d);
  }
  const last=rows.at(-1),center=[0,top,0];
  for(let i=0;i<last.length;i++)tri(center,last[(i+1)%last.length],last[i]);
  return new Geometry(p,normals,index);
}
export function cylinder(rings,sides=46){
  const p=[],n=[],indices=[];
  for(let step=0;step+1<rings.length;step++){
    const [r0,y0]=rings[step],[r1,y1]=rings[step+1],dr=r1-r0,dy=y1-y0,m=Math.hypot(dr,dy)||1;
    const base=p.length/3;
    for(let i=0;i<=sides;i++){
      const a=i*tau/sides,c=Math.cos(a),s=Math.sin(a);
      for(const [r,y] of [rings[step],rings[step+1]]){p.push(r*c,y,r*s);n.push(dy*c/m,-dr/m,dy*s/m);}
      if(i){const k=base+i*2;indices.push(k-2,k-1,k,k-1,k+1,k);}
    }
  }
  return new Geometry(p,n,indices);
}
export function planarInk(y){
  const vertices=[],normals=[],triangles=[];
  function vertex(x,z){
    const i=vertices.length/3;
    vertices.push(x,y,z);normals.push(0,1,0);return i;
  }
  function line(ax,az,bx,bz,w){
    const dx=bx-ax,dz=bz-az,mag=Math.hypot(dx,dz);
    if(mag<1e-6)return;
    const x=w*dz/(mag*2),z=-w*dx/(mag*2);
    const a=vertex(ax-x,az-z),b=vertex(ax+x,az+z),c=vertex(bx-x,bz-z),d=vertex(bx+x,bz+z);
    triangles.push(a,c,b,b,c,d);
  }
  function disk(x,z,r,facets=16){
    const c=vertex(x,z);
    for(let i=0;i<facets;i++){
      const a=i*tau/facets,b=(i+1)*tau/facets;
      const k=vertex(x+r*Math.cos(a),z+r*Math.sin(a));
      const j=vertex(x+r*Math.cos(b),z+r*Math.sin(b));
      triangles.push(c,j,k);
    }
  }
  function polygon(points){
    const ids=points.map(([x,z])=>vertex(x,z));
    for(let i=1;i+1<ids.length;i++)triangles.push(ids[0],ids[i+1],ids[i]);
  }
  return {line,disk,polygon,shape:()=>new Geometry(vertices,normals,triangles)};
}

export function studio(engine){
  const cube=box(),cache=new Map();
  function paint(color,roughness=.7){
    const key=color+':'+roughness;
    if(!cache.has(key))cache.set(key,new PbrMaterial({color,roughness}));
    return cache.get(key);
  }
  function part(name,geometry,color,position=[0,0,0],roughness,parent){
    const item=engine.createMesh(parent).setMaterial(paint(color,roughness)).setPosition(position);
    item.name=name;
    if(geometry)item.setGeometry(geometry);
    return item;
  }
  function block(name,color,position,dimensions,roughness,parent){
    return part(name,cube,color,position,roughness,parent).setScale(dimensions);
  }
  return {engine,paint,part,block};
}

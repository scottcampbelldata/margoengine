import {Geometry,PbrMaterial,box} from '@margoengine/core';

const tau=Math.PI*2;
export function surface(columns,rows,sample){
  const points=[],normal=[],triangles=[];
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++){
    const u=x/columns,v=y/rows;
    points.push(...sample(u,v));
    const a=sample(u-.0001,v),b=sample(u+.0001,v),c=sample(u,v-.0001),d=sample(u,v+.0001);
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=d[0]-c[0],vy=d[1]-c[1],vz=d[2]-c[2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,l=Math.hypot(nx,ny,nz)||1;
    normal.push(nx/l,ny/l,nz/l);
    if(x&&y){
      const i=y*(columns+1)+x;
      triangles.push(i-columns-2,i-columns-1,i-1,i-columns-1,i,i-1);
    }
  }
  return new Geometry(points,normal,triangles);
}
export function crisp(points,triangles){
  const normal=[],p=[],idx=[];
  for(let i=0;i<triangles.length;i+=3){
    const [a,b,c]=triangles.slice(i,i+3).map(j=>points[j]);
    const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2],u=c[0]-a[0],v=c[1]-a[1],w=c[2]-a[2];
    const n=[y*w-z*v,z*u-x*w,x*v-y*u],l=Math.hypot(...n)||1,k=p.length/3;
    p.push(...a,...b,...c);
    for(let j=0;j<3;j++)normal.push(n[0]/l,n[1]/l,n[2]/l);
    idx.push(k,k+1,k+2);
  }
  return new Geometry(p,normal,idx);
}
export function lathe(rings,sides=24){
  const p=[],n=[],idx=[];
  for(let j=0;j+1<rings.length;j++){
    const [ra,ya]=rings[j],[rb,yb]=rings[j+1],dr=rb-ra,dy=yb-ya,len=Math.hypot(dr,dy)||1;
    const base=p.length/3;
    for(let i=0;i<=sides;i++){
      const angle=tau*i/sides,c=Math.cos(angle),s=Math.sin(angle);
      for(const [r,y] of [rings[j],rings[j+1]]){
        p.push(r*c,y,r*s);n.push(dy/len*c,-dr/len,dy/len*s);
      }
      if(i){const b=base+i*2;idx.push(b-2,b-1,b,b-1,b+1,b);}
    }
  }
  return new Geometry(p,n,idx);
}
export function axis(mesh,a,b,radius){
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],length=Math.hypot(dx,dy,dz)||1;
  const x=dx/length,y=dy/length,z=dz/length,n=Math.hypot(z,1+y,x);
  mesh.setPosition([(a[0]+b[0])*.5,(a[1]+b[1])*.5,(a[2]+b[2])*.5])
    .setScale([radius,length,radius]).setQuaternion(n>1e-7?[z/n,0,-x/n,(1+y)/n]:[1,0,0,0]);
  return mesh;
}
export function workshop(engine){
  const unit=box();
  const sphere=surface(16,10,(u,v)=>{
    const a=tau*u,b=Math.PI*v;
    return [Math.sin(b)*Math.cos(a),Math.cos(b),Math.sin(b)*Math.sin(a)];
  });
  const rod=lathe([[0,-.5],[1,-.5],[1,.5],[0,.5]],14);
  const materials=new Map();
  function paint(color,roughness=.72){
    const key=color+'/'+roughness;
    if(!materials.has(key))materials.set(key,new PbrMaterial({color,roughness}));
    return materials.get(key);
  }
  function add(name,shape,color,position=[0,0,0],scale=[1,1,1],roughness,parent){
    const mesh=engine.createMesh(parent).setGeometry(shape).setMaterial(paint(color,roughness));
    mesh.name=name;
    return mesh.setPosition(position).setScale(scale);
  }
  const block=(name,color,position,scale,roughness,parent)=>add(name,unit,color,position,scale,roughness,parent);
  const tube=(name,color,a,b,radius,parent)=>axis(add(name,rod,color,undefined,undefined,undefined,parent),a,b,radius);
  return {engine,add,block,paint,tube,sphere,rod};
}

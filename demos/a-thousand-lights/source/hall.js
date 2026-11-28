import { Geometry, PbrMaterial } from '@margoengine/core';

const tau=2*Math.PI;
const palettes={
  basalt:{color:'#374053',roughness:.85},
  seam:{color:'#242a3b',roughness:.83},
  honed:{color:'#576071',roughness:.67},
  slate:{color:'#485464',roughness:.43},
  nickel:{color:'#76868c',roughness:.34,metalness:1},
  bronze:{color:'#a77963',roughness:.29,metalness:1},
  brass:{color:'#bd9075',roughness:.39,metalness:1},
  ceramic:{color:'#927c8c',roughness:.58},
};

class Surface {
  points=[];
  normals=[];
  indices=[];

  face(corners, facing) {
    const [a,b,c]=corners;
    const x=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],y=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const n=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
    const length=Math.hypot(...n);
    if(length<1e-8)return;
    const reverse=facing&&n[0]*facing[0]+n[1]*facing[1]+n[2]*facing[2]<0;
    const normal=n.map(value=>value/length*(reverse?-1:1));
    const start=this.points.length/3;
    for(const point of corners){
      this.points.push(...point);
      this.normals.push(...normal);
    }
    for(let i=1;i<corners.length-1;i++){
      if(reverse)this.indices.push(start,start+i+1,start+i);
      else this.indices.push(start,start+i,start+i+1);
    }
  }

  box(x,y,z,width,height,depth,bevel=.04){
    const hw=width/2,hd=depth/2,hh=height/2;
    const d=Math.min(bevel,width*.2,depth*.2,height*.24);
    const layers=[[-hh,d],[-hh+d,0],[hh-d,0],[hh,d]];
    const rings=layers.map(([dy,inset])=>{
      const a=hw-inset,b=hd-inset;
      return [[-a,-b],[a,-b],[a,b],[-a,b]].map(([dx,dz])=>[x+dx,y+dy,z+dz]);
    });
    for(let i=1;i<4;i++)for(let j=0;j<4;j++){
      const k=(j+1)%4, lower=rings[i-1], upper=rings[i];
      this.face([lower[j],lower[k],upper[k],upper[j]],
        [lower[j][0]+lower[k][0]-2*x,0,lower[j][2]+lower[k][2]-2*z]);
    }
    this.face(rings[0],[0,-1,0]);
    this.face(rings[3],[0,1,0]);
  }

  ring(rx,rz,y,width,height,steps=80){
    const ring=(a,b)=>Array.from({length:steps},(_,i)=>{
      const t=tau*i/steps;
      return [Math.sin(t)*a,y,Math.cos(t)*b];
    });
    const inside=ring(rx-width,rz-width),outside=ring(rx,rz);
    for(let i=0;i<steps;i++){
      const j=(i+1)%steps;
      this.face([inside[i],inside[j],outside[j],outside[i]],[0,1,0]);
      const low=point=>[point[0],point[1]-height,point[2]];
      for(const [line,side] of [[inside,-1],[outside,1]]){
        this.face([low(line[i]),low(line[j]),line[j],line[i]],[side*line[i][0],0,side*line[i][2]]);
      }
    }
  }

  mesh(engine,material){
    return engine.createMesh().setGeometry(new Geometry(this.points,this.normals,this.indices))
      .setMaterial(new PbrMaterial({...material,doubleSided:true}));
  }
}

function arches(sets){
  for(let bay=0;bay<10;bay++){
    const z=13.1-bay*3.72;
    for(const side of [-1,1]){
      const x=side*10.25;
      sets.basalt.box(x,2.43,z,.79,4.86,.66,.12);
      sets.honed.box(x-side*.37,2.44,z,.15,4.12,.48,.025);
      sets.brass.box(x-side*.46,2.47,z,.032,3.58,.039,.006);
      sets.seam.box(x+side*.21,4.0,z-1.72,.28,8.1,3.42,.07);
      sets.basalt.box(x-side*.64,.33,z,.55,.62,1.36,.075);
    }
    for(let i=0;i<26;i++){
      const t=Math.PI*i/26,v=Math.PI*(i+1)/26;
      const p=(s,r,d)=>[Math.cos(s)*r,4.77+5.94*Math.sin(s)*r/10.25,z+d];
      sets.honed.face([p(t,10.2,-.35),p(v,10.2,-.35),p(v,10.2,.35),p(t,10.2,.35)]);
      sets.basalt.face([p(t,10.2,-.35),p(v,10.2,-.35),p(v,10.46,-.35),p(t,10.46,-.35)]);
      sets.basalt.face([p(t,10.2,.35),p(v,10.2,.35),p(v,10.46,.35),p(t,10.46,.35)]);
      sets.brass.face([p(t,10.17,-.25),p(v,10.17,-.25),p(v,10.17,-.205),p(t,10.17,-.205)]);
    }
  }
}

function rotor(spiral,trim){
  const vertices=[];
  for(let i=0;i<=144;i++){
    const u=i/144,t=u*tau*1.68;
    const r=1.88+.65*Math.sin(u*Math.PI);
    const center=[r*Math.cos(t),.57+u*6.05,r*Math.sin(t)];
    const width=.48+.25*Math.sin(2.2*Math.PI*u)**2;
    const axis=[Math.cos(t),0,Math.sin(t)];
    vertices.push([[-width,.16],[width,.06],[width,-.07],[-width,.01]].map(([dr,dy])=>
      [center[0]+axis[0]*dr,center[1]+dy,center[2]+axis[2]*dr]));
  }
  for(let i=1;i<vertices.length;i++){
    const a=vertices[i-1],b=vertices[i];
    for(let j=0;j<4;j++){
      const k=(j+1)%4;
      const target=j===1?trim:spiral;
      target.face([a[j],b[j],b[k],a[k]]);
    }
  }
  spiral.face(vertices[0]);
  spiral.face(vertices.at(-1));
}

export function buildHall(engine){
  const sets=Object.fromEntries(Object.keys(palettes).map(key=>[key,new Surface()]));
  sets.seam.box(0,-.18,-3.1,22,.32,39,.045);
  for(let row=0;row<14;row++)for(let column=0;column<7;column++){
    const x=(column-3)*3.07,z=15-row*2.75;
    const key=(column+2*row)%7===0?'honed':'slate';
    sets[key].box(x,-.007,z,3.034,.068,2.708,.009);
  }
  arches(sets);
  sets.seam.box(0,6.1,-23.1,21,12,.55,.03);
  for(let j=-8;j<=8;j++){
    sets.basalt.box(j*1.25,4.27,-22.76,1.13,8.54,.23,.038);
    sets.honed.box(j*1.25,.34,-22.58,.91,.64,.33,.051);
  }
  for(const side of [-1,1]){
    sets.nickel.box(side*1.88,.01,7.9,.052,.015,13.7,.002);
    sets.bronze.box(side*1.99,.013,7.9,.094,.016,13.7,.003);
  }
  sets.honed.ring(3.93,4.53,.093,1.13,.08);
  sets.nickel.ring(3.97,4.57,.12,.045,.033);
  sets.basalt.ring(3.61,4.21,.158,3.59,.18);
  for(let i=0;i<120;i++){
    const t=tau*i/120;
    const size=i%5===0?.087:.041;
    sets.brass.box(Math.sin(t)*3.75,.135,Math.cos(t)*4.31,size,.017,size,.006);
  }
  sets.bronze.ring(2.84,3.01,.29,.47,.18);
  sets.nickel.ring(2.89,3.06,.31,.067,.044);
  const spiral=new Surface(),edge=new Surface();
  rotor(spiral,edge);
  const main=spiral.mesh(engine,palettes.bronze);
  const spine=edge.mesh(engine,palettes.brass);
  for(const [key,set] of Object.entries(sets).filter(([,set])=>set.indices.length)){
    const mesh=set.mesh(engine,palettes[key]);
    mesh.name=key;
  }
  main.name='Suspended brushed-bronze ribbon';
  spine.name='Chamfered turbine edge';
  return {casters:[main,spine]};
}

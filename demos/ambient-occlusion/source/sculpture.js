
import {Geometry,PbrMaterial,box} from '@margoengine/core';

const tau=2*Math.PI,end=10.91;
const paint=(color,roughness=.61,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const shellWhite=paint('#d5bfa2',.7),shellInterior=paint('#ae906f',.8),partition=paint('#e1c9a9',.62),
  lip=paint('#e1cabb',.55),inclusion=paint('#b18e67',.77),slate=paint('#34484d',.82),
  footing=paint('#64645c',.77),wall=paint('#394d56',.9),floor=paint('#666a62',.9),bronze=paint('#927451',.48,.72);
const pose=[-.08,1.38,-.14];

function band(){
  const positions=[],normals=[],indices=[];
  function patch(sample,along,across,reverse=false){
    const base=positions.length/3,small=.0007,row=across+1;
    for(let j=0;j<=along;j++)for(let k=0;k<=across;k++){
      const u=j/along,v=k/across,p=sample(u,v);
      const au=sample(u-small,v),bu=sample(u+small,v),av=sample(u,v-small),bv=sample(u,v+small);
      const a=bu.map((x,i)=>x-au[i]),b=bv.map((x,i)=>x-av[i]);
      const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      const length=Math.hypot(...n)||1,s=reverse?-1:1;
      positions.push(...p);normals.push(n[0]*s/length,n[1]*s/length,n[2]*s/length);
      if(j&&k){
        const d=base+j*row+k,c=d-1,b=d-row,a=b-1;
        if(reverse)indices.push(a,b,c,c,b,d);
        else indices.push(a,c,b,c,d,b);
      }
    }
  }
  return {patch,toMesh(engine,material){
    return engine.createMesh().setGeometry(new Geometry(positions,normals,indices)).setMaterial(material).setPosition(pose);
  }};
}
const radius=t=>.104*Math.exp(.228*t);
const twist=t=>t+.71;
const vector=(theta,r,z)=>[r*Math.cos(theta),r*Math.sin(theta),z];
const outer=t=>radius(t)*(1+.027*Math.cos(16.5*t));
const inner=t=>Math.max(.027,radius(t-.67*tau));
const mouth=t=>.05+radius(t)*.14;
const depth=t=>.023+radius(t)*.20;
const mix=(a,b,v)=>a+(b-a)*v;

function shell(engine){
  const wall=band(),rear=band(),rims=band(),septa=band(),detail=band();
  wall.patch((u,v)=>{
    const t=end*u,r=outer(t)+mouth(t)*.18*Math.sin(Math.PI*v);
    return vector(twist(t),r,mouth(t)-v*depth(t)*1.58);
  },205,11);
  rear.patch((u,v)=>{
    const t=end*u,r=mix(inner(t),outer(t),v);
    return vector(twist(t),r,mouth(t)-depth(t)*1.52-.045*Math.sin(Math.PI*v)**2);
  },196,10,true);
  rims.patch((u,v)=>{
    const t=end*u,r=outer(t)+mouth(t)*.065*Math.cos(v*tau);
    return vector(twist(t),r,mouth(t)+mouth(t)*.065*Math.sin(v*tau));
  },210,9,true);
  rims.patch((u,v)=>{
    const t=end*u,r=inner(t)+mouth(t)*.052*Math.cos(v*tau);
    return vector(twist(t),r,mouth(t)-depth(t)*.36+mouth(t)*.063*Math.sin(v*tau));
  },170,8);
  for(let t=.22;t<end+.001;t+=.278+radius(t)*.063){
    const s=t;
    septa.patch((u,v)=>{
      const r=mix(inner(s),outer(s),u),bow=.115*Math.sin(Math.PI*u)*(.7-.3*u);
      const f=s-bow+(v-.5)*(.039+.010*Math.sin(7*s));
      return vector(twist(f),r,mouth(s)-depth(s)*1.36+
        depth(s)*(1.31-.30*Math.sin(Math.PI*u))*v);
    },15,7);
    detail.patch((u,v)=>{
      const r=mix(inner(s),outer(s),u),bow=.115*Math.sin(Math.PI*u)*(.7-.3*u);
      const f=s-bow+(v-.5)*.025;
      return vector(twist(f),r,mouth(s)-.258*depth(s)*Math.sin(Math.PI*u)+.010*Math.sin(v*Math.PI));
    },14,4);
  }
  for(let t=6.4;t<end;t+=.102){
    const s=t;
    detail.patch((u,v)=>{
      const t=s+(v-.5)*.015;
      return vector(twist(t),outer(t)+depth(t)*(.13+.024*Math.sin(v*Math.PI))*Math.sin(u*Math.PI),
        mouth(t)-depth(t)*(u*1.44+.021));
    },7,3);
  }
  wall.toMesh(engine,shellWhite);rear.toMesh(engine,shellInterior);rims.toMesh(engine,lip);
  septa.toMesh(engine,partition);detail.toMesh(engine,inclusion);
}

function cylinder(profile,sectors){
  const b=band();
  b.patch((u,v)=>{
    const scaled=v*(profile.length-1);
    const i=Math.max(0,Math.min(profile.length-2,Math.floor(scaled))),t=scaled-i;
    const [y,r]=profile[i],next=profile[i+1],theta=tau*u,outer=mix(r,next[1],t);
    return [outer*Math.cos(theta),mix(y,next[0],t),outer*Math.sin(theta)];
  },sectors,profile.length-1,true);
  return b;
}

export function installSculpture(engine){
  const block=(x,y,z,w,h,d,mat)=>engine.createMesh().setGeometry(box(w,h,d)).setPosition([x,y,z]).setMaterial(mat);
  block(0,-.12,0,15,.2,14,floor);
  block(0,2.6,-3.1,15,6,.13,wall);
  const podium=cylinder([[0,.79],[0,.81],[.027,.84],[.055,.84],[.078,.83],[.26,.82],[.284,.80],[.294,.77],[.294,0]],64);
  podium.toMesh(engine,slate).setPosition([0,-.018,.03]);
  const brass=cylinder([[0,.71],[0,.73],[.017,.73],[.023,.69],[.023,0]],60);
  brass.toMesh(engine,bronze).setPosition([0,.28,.03]);
  const inset=cylinder([[0,.675],[.012,.689],[.034,.689],[.04,.658],[.04,0]],60);
  inset.toMesh(engine,footing).setPosition([0,.303,.03]);
  const mount=cylinder([[0,.048],[.016,.052],[.036,.042],[.26,.030],[.287,.034],[.294,.028],[.294,0]],18);
  for(const x of [-.38,.40])mount.toMesh(engine,bronze).setPosition([x,.34,.02]);
  shell(engine);
}


import {PbrMaterial,box} from '@margoengine/core';
import {GeometryBuilder} from '@margoengine/geometry/builder';
import {turnedGeometry} from '@margoengine/geometry/parts';
import {toGeometry} from '@margoengine/geometry/utils';
import {lerp} from '@margoengine/math/mathutils';

const tau=2*Math.PI,end=10.91;
const paint=(color,roughness=.61,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const shellWhite=paint('#d5bfa2',.7),shellInterior=paint('#ae906f',.8),partition=paint('#e1c9a9',.62),
  lip=paint('#e1cabb',.55),inclusion=paint('#b18e67',.77),slate=paint('#34484d',.82),
  footing=paint('#64645c',.77),wall=paint('#394d56',.9),floor=paint('#666a62',.9),bronze=paint('#927451',.48,.72);
const pose=[-.08,1.38,-.14];

// One band per material: parametric patches whose normals the builder takes from the surface derivatives.
function band(){
  const builder=new GeometryBuilder();
  return {
    patch(sample,along,across,reverse=false){builder.grid(along,across,sample,{flip:reverse});},
    toMesh(engine,material){
      return engine.createMesh().setGeometry(builder.geometry()).setMaterial(material).setPosition(pose);
    },
  };
}
const radius=t=>.104*Math.exp(.228*t);
const twist=t=>t+.71;
const vector=(theta,r,z)=>[r*Math.cos(theta),r*Math.sin(theta),z];
const outer=t=>radius(t)*(1+.027*Math.cos(16.5*t));
const inner=t=>Math.max(.027,radius(t-.67*tau));
const mouth=t=>.05+radius(t)*.14;
const depth=t=>.023+radius(t)*.20;

function shell(engine){
  const wall=band(),rear=band(),rims=band(),septa=band(),detail=band();
  wall.patch((u,v)=>{
    const t=end*u,r=outer(t)+mouth(t)*.18*Math.sin(Math.PI*v);
    return vector(twist(t),r,mouth(t)-v*depth(t)*1.58);
  },205,11);
  rear.patch((u,v)=>{
    const t=end*u,r=lerp(inner(t),outer(t),v);
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
      const r=lerp(inner(s),outer(s),u),bow=.115*Math.sin(Math.PI*u)*(.7-.3*u);
      const f=s-bow+(v-.5)*(.039+.010*Math.sin(7*s));
      return vector(twist(f),r,mouth(s)-depth(s)*1.36+
        depth(s)*(1.31-.30*Math.sin(Math.PI*u))*v);
    },15,7);
    detail.patch((u,v)=>{
      const r=lerp(inner(s),outer(s),u),bow=.115*Math.sin(Math.PI*u)*(.7-.3*u);
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

// Turned plinth parts, profiles [radius, height] from the floor up.
function turned(engine,profile,segments,material,position){
  const geometry=toGeometry(turnedGeometry(profile,{segments}));
  return engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
}

export function installSculpture(engine){
  const block=(x,y,z,w,h,d,mat)=>engine.createMesh().setGeometry(box(w,h,d)).setPosition([x,y,z]).setMaterial(mat);
  block(0,-.12,0,15,.2,14,floor);
  block(0,2.6,-3.1,15,6,.13,wall);
  turned(engine,[[.79,0],[.81,0],[.84,.027],[.84,.055],[.83,.078],[.82,.26],[.80,.284],[.77,.294],[0,.294]],64,slate,[0,-.018,.03]);
  turned(engine,[[.71,0],[.73,0],[.73,.017],[.69,.023],[0,.023]],60,bronze,[0,.28,.03]);
  turned(engine,[[.675,0],[.689,.012],[.689,.034],[.658,.04],[0,.04]],60,footing,[0,.303,.03]);
  const mount=toGeometry(turnedGeometry([[.048,0],[.052,.016],[.042,.036],[.030,.26],[.034,.287],[.028,.294],[0,.294]],{segments:18}));
  for(const x of [-.38,.40])engine.createMesh().setGeometry(mount).setMaterial(bronze).setPosition([x,.34,.02]);
  shell(engine);
}

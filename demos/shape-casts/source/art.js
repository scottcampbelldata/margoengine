import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {capsuleGeometry,coneGeometry,cylinderGeometry,sphereGeometry} from '@margoengine/geometry';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {origin,targets,probes,rotation,span} from './layout.js';

const finishes={
  floor:['#363946',.85,0],rubber:['#202530',.82,0],base:['#303840',.52,.36],
  edge:['#838e94',.38,.47],black:['#222331',.62,.25],mark:['#677887',.62,.15],
  copper:['#b47764',.32,.70],ceramic:['#bbcfc6',.38,.08],
  gold:['#b39f74',.29,.67],blue:['#607a9a',.37,.48],probe:['#d2fccc',.28,.08],
  path:['#68a6a9',.61,.25],contact:['#ffe0a1',.29,.20],normal:['#b8f5ce',.34,.13],
  distance:['#849984',.32,.15]
};
const convert=({positions,normals,indices})=>new Geometry(positions,normals,indices);
function shapeMesh(d){
  if(d.shape==='sphere')return convert(sphereGeometry(d.radius,48,28));
  if(d.shape==='box')return convert(roundedBoxGeometry(...d.halfExtents.map(value=>value*2),2,.036));
  if(d.shape==='capsule')return convert(capsuleGeometry(d.radius,d.halfHeight*2,10,42,1));
  return convert(cylinderGeometry(d.radius,d.radius,d.halfHeight*2,42));
}
const sum=(p,v,scale)=>p.map((value,index)=>value+v[index]*scale);
function upward(dir){
  if(dir[1]<-.99999)return [1,0,0,0];
  return [dir[2],0,-dir[0],1+dir[1]];
}

export function buildStudio(engine){
  const materials=Object.fromEntries(Object.entries(finishes).map(([name,[color,roughness,metalness]])=>
    [name,new PbrMaterial({color,roughness,metalness,doubleSided:false})]));
  const unit=box(1,1,1);
  function item(name,p,geo=unit,scale=[1,1,1],root=null){
    return engine.createMesh(root).setGeometry(geo).setMaterial(materials[name]).setPosition(p).setScale(scale);
  }
  function slab(name,p,s,r){
    return item(name,p,convert(roundedBoxGeometry(...s,2,r)));
  }
  function cylinder(radius,height,segments=30){
    return convert(cylinderGeometry(radius,radius,height,segments));
  }
  function arrowCylinder(radius,height){
    return convert(coneGeometry(radius,height,24));
  }
  item('floor',[0,-.18,0],unit,[130,.32,90]);
  slab('rubber',[0,.017,0],[8.65,.078,2.79],.035);
  slab('base',[0,.123,0],[8.51,.142,2.65],.069);
  slab('edge',[0,.196,0],[8.32,.045,2.50],.020);
  slab('black',[0,.22,0],[8.26,.039,2.46],.019);
  for(const sign of [-1,1]){
    item('mark',[0,.242,sign*1.163],unit,[8.17,.007,.018]);
    for(let i=0;i<=34;i++){
      const card=i%4===0;
      item(card?'edge':'mark',[-4.07+i*.239,.247,sign*(1.129-(card?.019:0))],unit,[.011,.011,card?.072:.033]);
    }
  }
  for(const x of [-3.93,3.93])for(const z of [-.96,.96]){
    item('edge',[x,.245,z],cylinder(.048,.021,8));
    item('black',[x,.257,z],unit,[.019,.008,.049]);
  }
  for(const spec of targets){
    const [x,y,z]=spec.p;
    const support=spec.shape==='sphere'?y-spec.radius:
      spec.shape==='capsule'?y-(spec.radius+spec.halfHeight*Math.cos(spec.angle)):
      spec.shape==='box'?y-spec.halfExtents[1]:
      y-spec.halfHeight*Math.cos(spec.angle)-spec.radius*Math.sin(spec.angle);
    const bottom=.235,postTop=support+.036,postHeight=postTop-bottom;
    slab('base',[x,.28,z],[.81,.092,.96],.03);
    item('black',[x,bottom+postHeight*.5,z],cylinder(.185,postHeight,30));
    item('edge',[x,support-.024,z],cylinder(.208,.05,30));
    item(spec.color,spec.p,shapeMesh(spec)).setQuaternion(rotation(spec.axis,spec.angle));
    item(spec.color,[x,.269,.80],unit,[.58,.038,.025]);
  }
  const markerSphere=convert(sphereGeometry(.059,20,14));
  const normalCone=arrowCylinder(.045,.095);
  const trace=item('path',origin),progress=item('distance',origin);
  const probeShapes=Object.fromEntries(Object.entries(probes).map(([name,spec])=>{
    const mesh=item('probe',origin,shapeMesh(spec));
    if(name==='box')mesh.setQuaternion(rotation('y',.38));
    return [name,mesh];
  }));
  const marks=targets.map(()=>({
    bead:item('contact',origin,markerSphere),tail:item('normal',origin),tip:item('normal',origin,normalCone)
  }));
  function beam(mesh,start,dir,length,width){
    mesh.visible=length>.001;
    if(!mesh.visible)return;
    mesh.setPosition(sum(start,dir,length*.5)).setScale([width,length,width]).setQuaternion(upward(dir));
  }
  function update({start,dir},kind,travel,hits,normals,completed){
    beam(trace,start,dir,span,.015);
    beam(progress,start,dir,travel,.032);
    for(const [name,mesh] of Object.entries(probeShapes)){
      mesh.visible=name===kind;
      if(mesh.visible)mesh.setPosition(sum(start,dir,travel));
    }
    for(const [index,shape] of marks.entries()){
      const hit=hits[index];
      if(!hit||(!completed&&travel+.03<hit.distance)){
        shape.bead.visible=shape.tail.visible=shape.tip.visible=false;
        continue;
      }
      const point=sum(hit.point,hit.normal,.029);
      shape.bead.visible=true;
      shape.bead.setPosition(point);
      if(normals){
        beam(shape.tail,point,hit.normal,.32,.022);
        shape.tip.visible=true;
        shape.tip.setQuaternion(upward(hit.normal)).setPosition(sum(point,hit.normal,.355));
      }else shape.tip.visible=shape.tail.visible=false;
    }
  }
  return {update};
}

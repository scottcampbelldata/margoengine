import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { repeatedSectors } from './mechanism.js';

const front = [0,0,1], lateral = [1,0,0], tau = 2*Math.PI;

function sweepVane() {
  const positions=[], normals=[], indices=[];
  const root=.034, tip=.105, curvature=.42, span=.47, depth=.009;
  const steps=18;
  function sample(i,w,z){
    const f=i/steps;
    const r=root+(tip-root)*f;
    const angle=curvature*f**1.35+w*span*(1.04-.33*f);
    return [r*Math.cos(angle),r*Math.sin(angle),z];
  }
  function quad(a,b,c,d) {
    const u=b.map((v,i)=>v-a[i]),v=d.map((v,i)=>v-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const scale=Math.hypot(...n);
    const base=positions.length/3;
    for(const p of [a,b,c,d]){
      positions.push(...p);
      normals.push(...n.map(value=>value/scale));
    }
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  for(let i=0;i<steps;i++){
    const a=i,b=i+1;
    quad(sample(a,-.5,depth),sample(b,-.5,depth),sample(b,.5,depth),sample(a,.5,depth));
    quad(sample(a,.5,-depth),sample(b,.5,-depth),sample(b,-.5,-depth),sample(a,-.5,-depth));
    quad(sample(a,-.5,-depth),sample(b,-.5,-depth),sample(b,-.5,depth),sample(a,-.5,depth));
    quad(sample(a,.5,depth),sample(b,.5,depth),sample(b,.5,-depth),sample(a,.5,-depth));
  }
  quad(sample(0,-.5,-depth),sample(0,-.5,depth),sample(0,.5,depth),sample(0,.5,-depth));
  quad(sample(steps,.5,-depth),sample(steps,.5,depth),sample(steps,-.5,depth),sample(steps,-.5,-depth));
  return new Geometry(positions,normals,indices);
}

export function buildInstrument(engine,shadows) {
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const room=finish('#665665',.92), black=finish('#36313b',.64), iron=finish('#695662',.49);
  const steel=finish('#9fabb4',.29,1), darkSteel=finish('#676b77',.39,1);
  const brass=finish('#ce9d5c',.30,1), brassEdge=finish('#deb880',.27,1);
  const ruby=finish('#8e4b51',.47), dot=finish('#f5d692',.49);
  function node(name,position,parent=null){
    const item=engine.createMesh(parent).setPosition(position);
    item.name=name;
    return item;
  }
  function part(name,geometry,coat,position,parent=null,cast=true,dynamic=false){
    const item=node(name,position,parent).setGeometry('uvs' in geometry?toGeometry(geometry):geometry).setMaterial(coat);
    if(cast)shadows.add(item,{static:!dynamic});
    return item;
  }
  const round=(name,dimensions,r,coat,position,parent=null)=>
    part(name,roundedBoxGeometry(...dimensions,2,r),coat,position,parent);
  const lathe=(name,profile,coat,position,parent=null)=>
    part(name,latheGeometry(profile,80),coat,position,parent).setQuaternion(axisAngleToQuaternion(lateral,Math.PI/2));
  const pin=(name,r,h,coat,position,parent=null,sides=36)=>
    part(name,cylinderGeometry(r,r,h,sides),coat,position,parent).setQuaternion(axisAngleToQuaternion(lateral,Math.PI/2));

  part('Studio sweep',box(30,.058,30),room,[0,-.052,0],null,false);
  round('Cast test stand base',[.603,.034,.276],.011,black,[0,-.005,0]);
  round('Crimson enamel mounting bed',[.590,.015,.259],.006,ruby,[0,.013,0]);
  const vane=sweepVane();
  function rotor(offset,reference) {
    const still=node(reference?'Continuous instrument':'Sampled instrument',[offset,.153,.028]);
    round('Pedestal casting',[.083,.117,.074],.009,iron,[0,-.084,-.049],still);
    round('Spindle bearing housing',[.078,.056,.090],.009,iron,[0,0,-.049],still);
    pin('Spindle bearing',.040,.037,darkSteel,[0,0,-.036],still);
    lathe('Stationary cowl',[[.109,-.024],[.124,-.024],[.130,-.017],[.130,.005],
      [.125,.019],[.115,.022],[.110,.018],[.109,-.024]],darkSteel,[0,0,0],still);
    lathe('Machined front ring',[[.116,.020],[.126,.015],[.126,.022],[.118,.025],[.116,.020]],brassEdge,[0,0,0],still);
    for(let i=0;i<repeatedSectors;i++){
      const theta=tau*i/repeatedSectors;
      pin('Cowl steel bolt',.0042,.0040,steel,[.121*Math.cos(theta),.121*Math.sin(theta),.023],still,6);
    }
    const axle=node('Rotor axis',[0,0,.014],still);
    for(let i=0;i<repeatedSectors;i++){
      const paddle=part('Swept bronze rotor blade',vane,brass,[0,0,0],axle,false,true);
      paddle.setQuaternion(axisAngleToQuaternion(front,tau*i/repeatedSectors));
    }
    pin('Rotor hub',.035,.020,brassEdge,[0,0,.001],axle,48);
    pin('Steel hub trim',.024,.013,steel,[0,0,.015],axle,48);
    pin('Round axle end',.011,.008,darkSteel,[0,0,.024],axle,48);
    if(reference) {
      pin('Spindle tracking dot',.0045,.0018,dot,[.016,0,.022],axle,20);
    }
    return axle;
  }
  const continuous=rotor(-.151,true),sampled=rotor(.151,false);
  return {
    pose(actual, sample){
      continuous.setQuaternion(axisAngleToQuaternion(front,-actual));
      sampled.setQuaternion(axisAngleToQuaternion(front,-sample));
    },
  };
}


import { PbrMaterial, box } from '@margoengine/core';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { cylinderGeometry, sphereGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { count, pivotX, pivotY, radius } from './motion.js';

const Z=[0,0,1];
const railOffset=.063;

function turnUp(dx,dy,dz) {
  const size=Math.hypot(dx,dz);
  return axisAngleToQuaternion(size?[dz/size,0,-dx/size]:[1,0,0],Math.atan2(size,dy));
}
export function makeCradle(engine,shadows) {
  const material=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=material('#667162',.83);
  const walnut=material('#604832',.58);
  const grain=material('#815b3b',.56);
  const edge=material('#573d2e',.52);
  const enamel=material('#3f594d',.58);
  const shoe=material('#3f4038',.62);
  const brass=material('#ad8750',.32,1);
  const bright=material('#c9a66a',.28,1);
  const steel=material('#b4b8ad',.16,1);
  const satin=material('#959c97',.35,1);
  const silk=material('#c1ad85',.62);

  function plain(name,at,parent=null) {
    const item=engine.createMesh(parent).setPosition(at);
    item.name=name;
    return item;
  }
  function mesh(name,data,paint,at,parent=null,cast=true,moving=false) {
    const item=plain(name,at,parent).setGeometry('uvs' in data?toGeometry(data):data).setMaterial(paint);
    if(cast)shadows.add(item,{static:!moving});
    return item;
  }
  function block(name,dims,bevel,paint,at,parent=null,cast=true) {
    return mesh(name,roundedBoxGeometry(...dims,2,bevel),paint,at,parent,cast);
  }
  function cylinder(name,r,depth,paint,at,parent=null,sections=48,moving=false) {
    return mesh(name,cylinderGeometry(r,r,depth,sections),paint,at,parent,true,moving);
  }

  mesh('Neutral studio sweep',box(40,.07,40),floor,[0,-.060,0],null,false);
  block('Turned walnut plinth',[.680,.045,.313],.017,walnut,[0,-.001,0]);
  block('Walnut back bevel',[.657,.012,.293],.005,edge,[0,-.019,0]);
  block('Flush brass ribbon',[.643,.0059,.280],.0022,brass,[0,.0221,0]);
  block('Integral walnut deck',[.646,.016,.282],.007,grain,[0,.030,0]);
  block('Mineral enamel tile',[.449,.0071,.149],.0034,enamel,[0,.0407,0]);
  block('Front tile graduation',[.399,.0015,.0022],.0007,bright,[0,.046,.053]);
  for(let i=-10;i<=10;i++){
    block('Inlaid graduation',[.00105,.00071,(i%5===0?.012:.006)],.00026,bright,
      [i*.0173,.046,.058],null,false);
  }
  for(const x of [-.290,.290]){
    for(const z of [-.107,.107]){
      block('Vibration isolator',[.083,.014,.053],.005,shoe,[x,-.020,z]);
      cylinder('Hexagonal plinth fastener',.0061,.0058,satin,[x,.041,z],null,6);
    }
  }

  for(const x of [-.298,.298]){
    for(const sign of [-1,1]){
      block('Cast brass foot',[.069,.0107,.049],.0045,brass,[x,.041,sign*.082]);
      cylinder('Pedestal anchoring bolt',.0051,.0041,bright,[x+.021,.0495,sign*.094],null,6);
      cylinder('Upright lower ferrule',.0128,.020,bright,[x,.056,sign*.072],null,34);
    }
    const rail=new CatmullRomCurve3([
      [x,.060,-.072],[x,.263,-.072],[x,.337,-.071],[x,.367,-.049],
      [x,.373,0],[x,.367,.049],[x,.337,.071],[x,.263,.072],[x,.060,.072],
    ]);
    mesh('One-piece bronze end frame',tubeGeometry(rail,92,.0085,13),brass,[0,0,0]);
  }
  for(const sign of [-1,1]){
    const z=sign*railOffset;
    cylinder('Suspension crossbar',.0078,.613,brass,[0,pivotY+.011,z])
      .setQuaternion(axisAngleToQuaternion(Z,Math.PI/2));
    for(const x of [-.296,.296]){
      cylinder('Crossbar locking sleeve',.0109,.0252,bright,[x,pivotY+.011,z],null,42)
        .setQuaternion(axisAngleToQuaternion(Z,Math.PI/2));
    }
    for(let i=0;i<count;i++){
      const x=pivotX(i);
      cylinder('Thread anchor guide',.0042,.0113,satin,[x,pivotY+.002,z],null,28);
    }
  }
  const sphere=toGeometry(sphereGeometry(radius,64,42));
  const line=toGeometry(cylinderGeometry(.00064,.00064,1,8));
  const balls=Array.from({length:count},(_,i)=>{
    const pivot=plain('Ball '+String(i+1),[0,0,0]);
    mesh('Polished stainless sphere',sphere,steel,[0,0,0],pivot,true,true);
    const hooks=[-.0044,.0044].map((z)=>{
      cylinder('Bifilar thread lug',.0033,.0021,satin,[0,radius-.001,z],pivot,20,true);
      return [0,radius+.001,z];
    });
    const strings=hooks.map(()=>mesh('Waxed silk suspension',line,silk,[0,0,0],null,false));
    return {pivot,hooks,strings};
  });
  function cord(item,start,end) {
    const dx=end[0]-start[0],dy=end[1]-start[1],dz=end[2]-start[2];
    item.setPosition([start[0]+dx*.5,start[1]+dy*.5,start[2]+dz*.5]);
    item.setScale([1,Math.hypot(dx,dy,dz),1]);
    item.setQuaternion(turnUp(dx,dy,dz));
  }
  return {
    pose(system) {
      for(const [index,{pivot,hooks,strings}] of balls.entries()){
        const at=[system.x[index],system.y[index],0];
        const rotation=axisAngleToQuaternion(Z,system.angle[index]);
        pivot.setPosition(at).setQuaternion(rotation);
        for(let i=0;i<hooks.length;i++){
          const top=[pivotX(index),pivotY,i===0?-railOffset:railOffset];
          const bottom=rotateByQuaternion(hooks[i],rotation).map((value,axis)=>value+at[axis]);
          cord(strings[i],bottom,top);
        }
      }
    },
  };
}

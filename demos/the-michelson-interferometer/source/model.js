import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { mirrorPeriodNm, mirrorTilt } from './optics.js';
import { installLight } from './light.js';

const h=.264;
const fixedCell=-.394;
const stepCell=-.394;
const outputCell=.437;
export const detectorFocus=[outputCell-.004,h,0];
const alignZ=axisAngleToQuaternion([1,0,0],Math.PI/2);
const yaw=(theta)=>axisAngleToQuaternion([0,1,0],theta);
const alignX=axisAngleToQuaternion([0,0,1],Math.PI/2);
const toSource=yaw(Math.PI);

function ringShape(inner,outer,depth,bevel,sides=72){
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

export function createInterferometer(engine,shadows){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=finish('#5a596a',.86);
  const obsidian=finish('#323445',.38);
  const dark=finish('#2f3440',.62);
  const ceramic=finish('#4c5266',.49);
  const steel=finish('#a1a6b3',.35,.76);
  const warm=finish('#b48a64',.34,.70);
  const chrome=finish('#d6cbac',.25,.74);
  const violet=finish('#635974',.40);
  const slate=finish('#496675',.41);
  const seal=finish('#4a3a45',.62);
  const copper=finish('#9f574f',.39);
  const marks=finish('#e5d0b3',.53);
  const cache=new WeakMap();
  const light=installLight(engine);
  const fixed={cast:true};
  let meshes=0;
  function mount(data,material,at,{parent,rotation,cast}={}){
    if(!cache.has(data))cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const block=(w,y,z,r)=>roundedBoxGeometry(w,y,z,3,r);
  const box=(dims,r,mat,at,options)=>mount(block(...dims,r),mat,at,options);
  const disc=(r,d,mat,at,options)=>mount(cylinderGeometry(r,r,d,52,1),mat,at,options);
  const ring=(r0,r1,d,b,mat,at,options)=>mount(ringShape(r0,r1,d,b),mat,at,options);

  box([45,.10,45],.02,floor,[0,-.132,0]);
  const shape=latheGeometry([[0,-.055],[.598,-.055],[.642,-.044],[.653,-.018],[.653,.016],[.633,.033],[0,.033]],
    12,Math.PI/12);
  mount(shape,obsidian,[0,0,0],fixed);
  const edge=latheGeometry([[0,.021],[.635,.021],[.640,.027],[.625,.035],[0,.035]],12,Math.PI/12);
  mount(edge,steel,[0,0,0]);
  const deck=latheGeometry([[0,.033],[.609,.033],[.626,.042],[.620,.051],[.606,.057],[0,.057]],12,Math.PI/12);
  mount(deck,ceramic,[0,0,0],fixed);
  for(const x of [-.371,.371])for(const z of [-.363,.363])disc(.040,.025,dark,[x,-.067,z],fixed);
  const bezel=cylinderGeometry(.011,.011,.004,24,1);
  for(let i=0;i<12;i++){
    const a=(i+.5)*Math.PI/6;
    mount(bezel,steel,[.571*Math.sin(a),.059,.571*Math.cos(a)]);
  }
  box([.776,.016,.107],.008,dark,[0,.063,0]);
  box([.111,.016,.810],.008,obsidian,[0,.064,-.023]);
  for(const sign of [-1,1]){
    box([.515,.003,.006],.001,steel,[.028,.074,sign*.045]);
    box([.006,.003,.616],.001,steel,[sign*.044,.076,-.016]);
  }

  // HeNe collimator with heat fins, insulating mount, and illuminated output.
  box([.193,.032,.214],.013,obsidian,[0,.080,.418],fixed);
  for(const x of [-.053,.053])box([.059,.143,.096],.019,slate,[x,.139,.424],fixed);
  disc(.077,.194,dark,[0,h,.446],{rotation:alignZ,cast:true});
  disc(.081,.027,steel,[0,h,.534],{rotation:alignZ});
  ring(.021,.078,.016,.003,warm,[0,h,.552],{rotation:alignZ});
  const fin=block(.007,.014,.113,.003);
  for(let i=0;i<26;i++){
    const angle=2*Math.PI*i/26;
    mount(fin,i%4===0?steel:slate,[.076*Math.sin(angle),h+.076*Math.cos(angle),.447],
      {rotation:axisAngleToQuaternion([0,0,1],-angle)});
  }
  ring(.027,.077,.026,.004,steel,[0,h,.345],{rotation:alignZ,cast:true});
  ring(.017,.029,.006,.0018,warm,[0,h,.330],{rotation:alignZ});
  disc(.020,.008,seal,[0,h,.333],{rotation:alignZ});
  const lamp=engine.createMesh().setPosition([0,h,.327]);
  light.plate(lamp,.018,.018,5);

  // Two mirror cells share a family, with different adjustment housings.
  function mirror(parent,color,x,z,theta,tilt,isStatic){
    const stand=engine.createMesh(parent).setPosition([x,h,z]).setQuaternion(yaw(theta));
    const to={parent:stand};
    const swing=engine.createMesh(stand).setQuaternion(axisAngleToQuaternion([0,1,0],tilt));
    box([.081,.141,.064],.013,color,[0,-.123,-.028],to);
    const body=disc(.096,.041,color,[0,0,-.023],{parent:swing,rotation:alignZ});
    shadows.add(body,{static:isStatic});
    ring(.064,.088,.014,.003,steel,[0,0,.002],{parent:swing,rotation:alignZ});
    ring(.059,.067,.009,.002,warm,[0,0,.011],{parent:swing,rotation:alignZ});
    disc(.060,.010,steel,[0,0,.008],{parent:swing,rotation:alignZ});
    const screw=cylinderGeometry(.013,.013,.016,24,1);
    for(const v of [-1,1]){
      mount(screw,chrome,[v*.078,.057,-.047],{parent:stand,rotation:alignZ});
      box([.015,.006,.013],.002,marks,[v*.078,.057,-.054],to);
    }
    return stand;
  }
  box([.178,.032,.149],.013,obsidian,[0,.081,fixedCell-.024],fixed);
  mirror(null,slate,0,fixedCell,0,mirrorTilt,true);

  box([.248,.036,.174],.013,obsidian,[stepCell-.026,.080,0],fixed);
  box([.214,.019,.145],.006,warm,[stepCell-.026,.105,0]);
  for(const z of [-.064,.064])disc(.010,.208,steel,[stepCell-.027,.121,z],{rotation:alignX});
  const carriage=engine.createMesh();
  box([.126,.021,.104],.008,violet,[stepCell-.021,.131,0],{parent:carriage});
  mirror(carriage,violet,stepCell,0,Math.PI/2,0,false);
  disc(.020,.112,steel,[-.516,.154,0],{rotation:alignX});
  const dial=engine.createMesh().setPosition([-.575,.154,0]);
  disc(.044,.033,warm,[0,0,0],{parent:dial,rotation:alignX});
  disc(.035,.012,steel,[-.018,0,0],{parent:dial,rotation:alignX});
  const knurl=block(.029,.0065,.0065,.002);
  for(let i=0;i<24;i++){
    const a=i*Math.PI/12;
    mount(knurl,i===0?marks:warm,[0,.045*Math.sin(a),.045*Math.cos(a)],
      {parent:dial,rotation:axisAngleToQuaternion([1,0,0],-a)});
  }

  // Cube faces and the diagonal mixing coating are independent translucent surfaces.
  box([.173,.039,.173],.010,dark,[0,.084,0],fixed);
  disc(.085,.035,violet,[0,.113,0],fixed);
  box([.074,.072,.073],.009,steel,[0,.164,0],fixed);
  box([.129,.014,.130],.005,obsidian,[0,h-.068,0],fixed);
  box([.129,.013,.130],.005,warm,[0,h+.068,0]);
  const rod=block(.009,.132,.009,.002);
  for(const x of [-.061,.061])for(const z of [-.061,.061])mount(rod,steel,[x,h,z]);
  for(const deg of [0,90,180,270]){
    const rotation=deg*Math.PI/180;
    const glass=engine.createMesh().setPosition([.061*Math.sin(rotation),h,.061*Math.cos(rotation)]).setQuaternion(yaw(rotation));
    light.plate(glass,.060,.061,2);
  }
  const diagonal=engine.createMesh().setPosition([0,h,0]).setQuaternion(yaw(-Math.PI/4));
  light.plate(diagonal,.085,.060,3);

  // Circular receiver with a fixed top fiducial and a physical housing behind the image.
  box([.135,.036,.193],.013,obsidian,[outputCell+.038,.083,0],fixed);
  box([.063,.150,.100],.016,slate,[outputCell+.045,.151,0],fixed);
  disc(.130,.060,obsidian,[outputCell+.042,h,0],{rotation:alignX,cast:true});
  ring(.103,.130,.018,.004,steel,[outputCell+.011,h,0],{rotation:alignX});
  ring(.105,.109,.009,.0014,warm,[outputCell+.0005,h,0],{rotation:alignX});
  disc(.107,.014,seal,[outputCell+.005,h,0],{rotation:alignX});
  const receiver=engine.createMesh().setPosition(detectorFocus).setQuaternion(yaw(-Math.PI/2));
  light.detector(receiver);
  const indent=cylinderGeometry(.007,.007,.004,20,1);
  for(let i=0;i<4;i++){
    const a=(45+90*i)*Math.PI/180;
    mount(indent,chrome,[outputCell+.001,h+.119*Math.cos(a),.119*Math.sin(a)],{rotation:alignX});
  }
  box([.014,.004,.020],.001,marks,[outputCell+.001,h+.117,0],{rotation:axisAngleToQuaternion([1,0,0],.14)});

  const inBeam=engine.createMesh(),fixedBeam=engine.createMesh(),movingBeam=engine.createMesh(),outBeam=engine.createMesh();
  const guides=[light.beam(inBeam,0),light.beam(fixedBeam,1),light.beam(movingBeam,1),light.beam(outBeam,0)];
  function beam(anchor,from,to,width,rotation){
    anchor.setPosition(from).setQuaternion(rotation).setScale([width,width,Math.hypot(to[0]-from[0],to[2]-from[2])]);
  }
  const pivot=[0,h,0];
  beam(inBeam,[0,h,.327],pivot,.012,toSource);
  beam(fixedBeam,pivot,[0,h,fixedCell+.013],.013,toSource);
  beam(outBeam,pivot,detectorFocus,.024,yaw(Math.PI/2));

  return {
    meshes:meshes+10,
    ready:light.ready,
    showGuides(visible){for(const guide of guides)guide.visible=visible;},
    update(distance){
      const shift=distance*1e-9;
      carriage.setPosition([-shift,0,0]);
      dial.setQuaternion(axisAngleToQuaternion([1,0,0],2*Math.PI*distance/mirrorPeriodNm));
      beam(movingBeam,pivot,[stepCell+.013-shift,h,0],.013,yaw(-Math.PI/2));
      light.update(distance);
    },
  };
}

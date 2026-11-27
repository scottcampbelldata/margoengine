import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { focusOffset, focusRun } from './optics.js';
import { installLight } from './light.js';

const h=.272;
const side=.552;
const offset=focusRun;
const depth=focusOffset;
const nearZ=.225;
const farZ=nearZ-depth;
const sourceX=offset-side;
const knifeX=side-offset;
const tilt=Math.atan2(depth,offset)/2;
const facing=Math.PI/2-tilt;
export const screenFocus=[0,.227,.375];
const pitch=axisAngleToQuaternion([1,0,0],-.77);
const yaw=(a)=>axisAngleToQuaternion([0,1,0],a);
const axial=axisAngleToQuaternion([1,0,0],Math.PI/2);

function turnedRing(inner,outer,depth,bevel,sides=76){
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

export function createBench(engine,shadows){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=finish('#637b87',.86);
  const graphite=finish('#374652',.51);
  const shell=finish('#527a8a',.38);
  const porcelain=finish('#96aeb2',.53);
  const chrome=finish('#b9c9cb',.25,.75);
  const steel=finish('#697a87',.39,.71);
  const bronze=finish('#c79461',.33,.65);
  const rust=finish('#aa603f',.41);
  const hot=finish('#d28b60',.64);
  const mark=finish('#e4d8bf',.60);
  const seal=finish('#384956',.76);
  const cache=new WeakMap();
  const optics=installLight(engine);
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
  const box=(dims,r,material,where,options)=>mount(block(...dims,r),material,where,options);
  const disc=(r,d,material,where,options)=>mount(cylinderGeometry(r,r,d,56,1),material,where,options);
  const ring=(r0,r1,d,b,material,where,options)=>mount(turnedRing(r0,r1,d,b),material,where,options);

  box([48,.10,48],.02,floor,[0,-.133,0]);
  box([1.421,.075,.907],.033,graphite,[0,-.017,.024],fixed);
  box([1.416,.013,.898],.006,chrome,[0,.016,.024]);
  box([1.386,.054,.875],.025,shell,[0,.047,.024],fixed);
  box([1.339,.015,.831],.006,porcelain,[0,.080,.024],fixed);
  for(const x of [-.593,.593])for(const z of [-.313,.306])disc(.047,.028,seal,[x,-.068,z],fixed);
  box([1.285,.026,.230],.012,graphite,[0,.100,farZ],fixed);
  box([1.240,.006,.166],.003,steel,[0,.115,farZ]);
  for(const z of [farZ-.078,farZ+.078]){
    box([1.256,.008,.011],.003,chrome,[0,.121,z]);
  }
  for(const x of [-.624,-.475,.475,.624])for(const z of [-.307,.326]){
    disc(.009,.004,steel,[x,.091,z]);
  }

  function mirror(sign){
    const x=sign*side;
    const cell=engine.createMesh().setPosition([x,h,farZ]).setQuaternion(yaw(-sign*facing));
    const at={parent:cell};
    box([.209,.032,.195],.013,graphite,[x,.136,farZ],fixed);
    for(const side of [-.076,.076])box([.039,.118,.077],.011,shell,[side,-.114,-.033],at);
    box([.193,.051,.091],.012,steel,[0,-.084,-.032],at);
    const back=disc(.125,.058,shell,[0,0,-.021],{parent:cell,rotation:axial});
    shadows.add(back,{static:true});
    ring(.105,.124,.018,.003,chrome,[0,0,.010],{parent:cell,rotation:axial});
    ring(.101,.107,.008,.002,bronze,[0,0,.012],{parent:cell,rotation:axial});
    const figure=engine.createMesh(cell).setPosition([0,0,.005]);
    optics.mirror(figure,.103);
    const screw=cylinderGeometry(.012,.012,.012,20,1);
    for(const x of [-.099,.099])mount(screw,steel,[x,.074,-.043],{parent:cell,rotation:axial});
  }
  mirror(-1);
  mirror(1);

  // Thermally isolated ceramic heater in the collimated region.
  const heater=[0,.123,farZ];
  box([.140,.018,.126],.008,graphite,heater,fixed);
  for(const x of [-.044,.044])for(const z of [-.035,.035])
    box([.013,.028,.013],.004,porcelain,[x,.140,farZ+z],fixed);
  box([.112,.023,.083],.009,rust,[0,.165,farZ],fixed);
  box([.095,.007,.064],.003,hot,[0,.179,farZ]);
  const coil=block(.004,.002,.042,.0007);
  for(let i=-4;i<=4;i++)mount(coil,i%2===0?chrome:bronze,[i*.009,.183,farZ]);
  box([.159,.007,.026],.003,graphite,[0,.091,.155]);
  box([.051,.002,.005],.001,bronze,[-.031,.096,.155]);

  const sourceYaw=Math.atan2(-offset,-depth);
  const source=engine.createMesh().setPosition([sourceX,h,nearZ]).setQuaternion(yaw(sourceYaw));
  box([.147,.021,.127],.008,graphite,[sourceX,.101,nearZ],fixed);
  box([.073,.154,.058],.014,shell,[sourceX,.166,nearZ],fixed);
  disc(.045,.074,shell,[0,0,-.045],{parent:source,rotation:axial});
  for(const z of [-.074,-.059,-.044,-.029]){
    ring(.045,.052,.0054,.0017,steel,[0,0,z],{parent:source,rotation:axial});
  }
  ring(.015,.047,.013,.0029,chrome,[0,0,-.003],{parent:source,rotation:axial});
  disc(.015,.003,graphite,[0,0,-.001],{parent:source,rotation:axial});
  const aperture=engine.createMesh(source).setPosition([0,0,.001]);
  optics.plate(aperture,.0040,.017,4);

  const receiverYaw=Math.atan2(offset,-depth);
  const receiver=engine.createMesh().setPosition([knifeX,h,nearZ]).setQuaternion(yaw(receiverYaw));
  box([.154,.025,.127],.009,graphite,[knifeX,.103,nearZ],fixed);
  box([.067,.119,.047],.013,shell,[knifeX,.159,nearZ],fixed);
  box([.133,.070,.059],.010,graphite,[0,0,-.034],{parent:receiver});
  box([.103,.064,.009],.003,chrome,[0,0,-.003],{parent:receiver});
  const gate=engine.createMesh(receiver).setPosition([0,0,.003]);
  optics.plate(gate,.024,.021,4);
  const blade=box([.061,.070,.004],.0014,steel,[0,0,.006],{parent:receiver});
  box([.015,.065,.016],.003,bronze,[-.060,0,-.015],{parent:receiver});
  disc(.012,.050,steel,[-.077,0,-.016],{parent:receiver,rotation:axisAngleToQuaternion([0,0,1],Math.PI/2)});
  const dial=engine.createMesh(receiver).setPosition([-.103,0,-.016]);
  disc(.023,.015,bronze,[0,0,0],{parent:dial,rotation:axisAngleToQuaternion([0,0,1],Math.PI/2)});
  box([.002,.007,.013],.0009,mark,[-.009,.012,0],{parent:dial});

  // The relay signal is shown on a sloped monitor as a circular field of view.
  const monitor=engine.createMesh().setPosition(screenFocus).setQuaternion(pitch);
  const plate={parent:monitor};
  box([.355,.055,.198],.015,graphite,[0,.113,.350],fixed);
  box([.212,.072,.103],.015,shell,[0,.167,.360],fixed);
  box([.353,.265,.042],.019,graphite,[0,0,-.033],plate);
  box([.326,.247,.019],.013,shell,[0,0,-.010],plate);
  ring(.103,.119,.014,.003,chrome,[0,0,.004],{parent:monitor,rotation:axial});
  disc(.104,.008,seal,[0,0,.0005],{parent:monitor,rotation:axial});
  const display=engine.createMesh(monitor).setPosition([0,0,.0068]);
  optics.plate(display,.104,.104,3);
  box([.037,.006,.006],.0025,bronze,[0,-.124,.006],plate);
  for(const x of [-.143,.143]){
    disc(.007,.005,chrome,[x,.095,.004],{parent:monitor,rotation:axial});
    disc(.007,.005,chrome,[x,-.095,.004],{parent:monitor,rotation:axial});
  }

  const guides=[];
  function beam(from,to,width,weak=false){
    const anchor=engine.createMesh();
    guides.push(optics.beam(anchor,weak));
    const x=to[0]-from[0],z=to[2]-from[2];
    anchor.setPosition(from).setQuaternion(yaw(Math.atan2(x,z))).setScale([width,width,Math.hypot(x,z)]);
  }
  beam([sourceX,h,nearZ],[-side,h,farZ],.012);
  beam([-side,h,farZ],[side,h,farZ],.015);
  beam([side,h,farZ],[knifeX,h,nearZ],.012);
  for(const y of [h-.052,h+.052]){
    beam([-side+.016,y,farZ-.018],[side-.016,y,farZ-.018],.015,true);
  }
  return {
    meshes:meshes+9,
    ready:optics.ready,
    showGuides(visible){for(const guide of guides)guide.visible=visible;},
    updateCutoff(cut){
      const bladeCut=cut<0?-.31:cut;
      blade.setPosition([-.055+bladeCut*.047,0,.006]);
      dial.setQuaternion(axisAngleToQuaternion([1,0,0],Math.PI*1.25*bladeCut));
    },
    paint:optics.update,
  };
}

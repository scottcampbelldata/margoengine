import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { installDisplays } from './display.js';

const screenY=.303;
const screenZ=-.214;
const halfWidth=.139;
const halfHeight=.095;
const aperturesZ=.080;
const spacing=.350;
const screenTilt=axisAngleToQuaternion([1,0,0],-.33);
const towardFront=axisAngleToQuaternion([1,0,0],Math.PI/2);

function turnedRing(inner,outer,depth,bevel) {
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],64);
}

export function createArray(engine,shadows) {
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=finish('#53635d',.87);
  const casting=finish('#9c9c81',.49);
  const pale=finish('#b9ad8b',.44);
  const black=finish('#343c39',.66);
  const green=finish('#345a52',.37);
  const forest=finish('#37453d',.48);
  const silver=finish('#c4c3b7',.25,.74);
  const chrome=finish('#717a72',.26,.79);
  const copper=finish('#ae8454',.31,.59);
  const amber=finish('#ad7741',.36);
  const marks=finish('#e3ddbf',.52);
  const cache=new WeakMap();
  const displays=installDisplays(engine);
  const fixed={cast:true};
  let meshes=0;
  function mount(data,material,at,{parent,rotation,cast}={}) {
    if(!cache.has(data)) cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if(rotation) mesh.setQuaternion(rotation);
    if(cast) shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const shape=(w,h,d,r)=>roundedBoxGeometry(w,h,d,3,r);
  const box=(dims,r,mat,at,options)=>mount(shape(...dims,r),mat,at,options);
  const disc=(r,d,mat,at,options)=>mount(cylinderGeometry(r,r,d,56,1),mat,at,options);
  const ring=(r0,r1,d,b,mat,at,options)=>mount(turnedRing(r0,r1,d,b),mat,at,options);

  box([44,.10,44],.02,floor,[0,-.111,0]);
  box([1.265,.071,.766],.030,black,[0,-.011,0],fixed);
  box([1.248,.014,.754],.005,chrome,[0,.027,0]);
  box([1.228,.104,.742],.039,casting,[0,.075,0],fixed);
  box([1.179,.018,.691],.008,forest,[0,.129,-.008],fixed);
  for(const x of [-.531,.531])for(const z of [-.287,.286])disc(.043,.019,black,[x,-.052,z],fixed);
  // Two steel straps bound the broad, pitched deck and carry its shock mounts.
  for(const x of [-.565,.565]) {
    box([.035,.053,.625],.015,pale,[x,.139,-.024],fixed);
    box([.049,.060,.193],.018,black,[x,.168,-.222],fixed);
    box([.056,.012,.133],.004,chrome,[x,.200,-.222]);
  }
  box([1.132,.076,.134],.022,green,[0,.176,-.240],fixed);
  box([1.141,.016,.087],.006,chrome,[0,.210,-.233]);
  const trimScrew=cylinderGeometry(.008,.008,.0034,20,1);
  const groove=shape(.016,.0010,.002,.0004);
  for(const x of [-.525,-.183,.183,.525]) {
    mount(trimScrew,silver,[x,.145,.272]);
    mount(groove,black,[x,.147,.272]);
  }

  const backShell=shape(.324,.236,.082,.028);
  const innerFrame=shape(.311,.219,.021,.014);
  const rubber=shape(.295,.202,.014,.009);
  const backing=shape(.284,.193,.009,.004);
  const indicator=shape(.017,.005,.005,.002);
  const head=cylinderGeometry(.006,.006,.0034,18,1);
  const cellBody=cylinderGeometry(.043,.042,.061,52,1);
  const apertureRim=turnedRing(.010,.039,.013,.003);
  const innerRim=turnedRing(.0095,.016,.006,.0016);
  const brace=shape(.071,.080,.083,.017);
  const pitch=shape(.011,.012,.006,.002);

  for(let i=0;i<3;i++) {
    const x=(i-1)*spacing;
    const top=engine.createMesh().setPosition([x,screenY,screenZ]).setQuaternion(screenTilt);
    const at={parent:top};
    shadows.add(mount(backShell,green,[0,0,-.036],at),{static:true});
    mount(innerFrame,silver,[0,0,.004],at);
    mount(rubber,black,[0,0,.015],at);
    mount(backing,forest,[0,0,.024],at);
    const screen=engine.createMesh(top).setPosition([0,0,.0295]);
    displays.face(screen,halfWidth,halfHeight,i);
    for(const y of [-.103,.103]) for(const z of [-.145,.145])
      mount(head,chrome,[z,y,.015],{parent:top,rotation:towardFront});
    for(let marker=0;marker<=i;marker++)mount(indicator,marks,[(marker-i/2)*.027,-.106,.023],at);
    // Recessed precision cells form the visible three-input row.
    mount(brace,forest,[x,.167,aperturesZ],fixed);
    mount(cellBody,black,[x,.231,aperturesZ],{rotation:towardFront,cast:true});
    mount(apertureRim,silver,[x,.231,aperturesZ+.028],{rotation:towardFront});
    mount(innerRim,copper,[x,.231,aperturesZ+.035],{rotation:towardFront});
    const cell=engine.createMesh().setPosition([x,.231,aperturesZ+.0386]);
    displays.face(cell,.009,.009,4+i);
    for(let k=0;k<18;k++){
      const angle=k*Math.PI/9;
      mount(pitch,green,[x+.042*Math.cos(angle),.231+.042*Math.sin(angle),aperturesZ-.004],
        {rotation:axisAngleToQuaternion([0,0,1],angle-Math.PI/2)});
    }
    box([.106,.007,.042],.003,black,[x,.144,aperturesZ+.091]);
    for(let j=0;j<=i;j++){
      box([.008,.0016,.027],.0005,marks,[x+(j-i/2)*.019,.148,aperturesZ+.091]);
    }
  }

  // The brass fold-out plate shows the upright target pattern.
  const targetPlate=engine.createMesh().setPosition([.314,.175,.259])
    .setQuaternion(axisAngleToQuaternion([1,0,0],-1.13));
  const plaque={parent:targetPlate};
  box([.283,.100,.017],.007,copper,[0,0,-.008],plaque);
  box([.257,.082,.005],.002,black,[0,0,.001],plaque);
  const target=engine.createMesh(targetPlate).setPosition([0,0,.004]);
  displays.face(target,.124,.036,3);
  for(const x of [-.129,.129])disc(.005,.0025,chrome,[x,0,.002],{parent:targetPlate,rotation:towardFront});

  // Knob at the operator side actuates the aperture set.
  ring(.058,.083,.012,.003,copper,[-.354,.145,.247]);
  disc(.053,.027,black,[-.354,.160,.247],fixed);
  const turn=engine.createMesh().setPosition([-.354,.171,.247]);
  disc(.046,.017,chrome,[0,0,0],{parent:turn});
  box([.006,.002,.031],.001,marks,[0,.009,.015],{parent:turn});
  const tick=shape(.0026,.0014,.011,.0005);
  for(let i=0;i<13;i++){
    const angle=i*Math.PI/12-Math.PI/2;
    mount(tick,i%3===0?marks:silver,[-.354+.073*Math.sin(angle),.152,.247+.073*Math.cos(angle)],
      {rotation:axisAngleToQuaternion([0,1,0],angle)});
  }
  box([.049,.006,.025],.002,forest,[-.158,.145,.257]);
  box([.019,.002,.005],.0005,amber,[-.158,.149,.258]);

  return {
    meshes:meshes+7,
    ready:displays.ready,
    dispose:displays.dispose,
    update(percent,samples) {
      turn.setQuaternion(axisAngleToQuaternion([0,1,0],(percent-105)*Math.PI/80));
      displays.update(samples);
    },
  };
}

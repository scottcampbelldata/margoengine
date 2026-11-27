import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { pupilRadius, imagePoint, spotRadii } from './optics.js';
import { installOptics } from './light.js';

export const lensX = -.226;
export const beamHeight = .294;
export const centerZ = -.012;
const axial = axisAngleToQuaternion([0,0,1],Math.PI/2);

function turnedRing(inner,outer,depth,bevel,sides=80) {
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

export function createBench(engine, shadows) {
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=finish('#504753',.88);
  const shell=finish('#372d3a',.44);
  const enamel=finish('#734658',.37);
  const dark=finish('#443a43',.59);
  const bronze=finish('#ae7654',.28,.82);
  const bright=finish('#d6b38b',.31,.63);
  const silver=finish('#b7b6bb',.30,.74);
  const black=finish('#262633',.38);
  const warm=finish('#d3895c',.42,.24);
  const cool=finish('#7da7b7',.42,.24);
  const white=finish('#e8dacf',.46);
  const glassBack=finish('#38313f',.55);
  const cache=new WeakMap();
  const optics=installOptics(engine);
  const fixed={cast:true};
  let meshes=0;
  function mount(data,material,at,{parent,rotation,cast}={}) {
    if (!cache.has(data)) cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const shape=(w,h,d,r)=>roundedBoxGeometry(w,h,d,3,r);
  const box=(dims,r,mat,where,options)=>mount(shape(...dims,r),mat,where,options);
  const disc=(r,depth,mat,where,options)=>mount(cylinderGeometry(r,r,depth,56,1),mat,where,options);
  const ring=(r0,r1,depth,b,mat,where,options)=>mount(turnedRing(r0,r1,depth,b),mat,where,options);

  box([48,.08,48],.016,floor,[0,-.127,0]);
  box([1.516,.093,.734],.036,shell,[-.059,-.027,0],fixed);
  box([1.504,.016,.722],.007,bronze,[-.059,.017,0]);
  box([1.468,.065,.693],.029,enamel,[-.059,.047,0],fixed);
  box([1.426,.010,.646],.004,dark,[-.059,.080,0],fixed);
  for (const x of [-.648,.544])for (const z of [-.259,.259]) {
    disc(.052,.025,black,[x,-.076,z],fixed);
    disc(.015,.006,bronze,[x,.086,z]);
    box([.022,.0015,.003],.0006,black,[x,.090,z]);
  }

  // A low dovetail and two raised round tracks carry the receiver along the optical axis.
  box([1.286,.027,.191],.006,black,[-.055,.092,centerZ],fixed);
  box([1.282,.014,.110],.005,bronze,[-.055,.109,centerZ]);
  for (const z of [-.082,.082]) {
    disc(.017,1.266,silver,[-.055,.117,centerZ+z],{rotation:axial});
    for(const x of [-.671,.566])box([.054,.047,.063],.011,dark,[x,.113,centerZ+z],fixed);
  }
  box([.439,.009,.078],.004,black,[.155,.089,.191]);
  box([.405,.005,.009],.002,bronze,[.155,.096,.162]);
  const major=shape(.0028,.002,.029,.0006),minor=shape(.00175,.002,.016,.0006);
  for(let mm=260;mm<=590;mm+=10) {
    const prominent=mm%50===0;
    mount(prominent?major:minor,prominent?white:bright,[lensX+mm/1000,.095,prominent?.198:.191]);
  }
  const warmIndex=box([.011,.004,.031],.001,warm,[0,.099,.155]);
  const coolIndex=box([.011,.004,.031],.001,cool,[0,.099,.213]);
  box([.179,.008,.056],.003,black,[-.589,.090,.219]);
  box([.144,.002,.003],.0006,bronze,[-.597,.095,.228]);
  box([.092,.002,.002],.0006,white,[-.618,.095,.214]);
  box([.071,.002,.002],.0006,silver,[-.630,.095,.205]);

  // Short, broad collimator with knurling, a bright rim, and a recessed output.
  box([.236,.036,.225],.012,black,[-.575,.111,centerZ],fixed);
  for(const z of [-.067,.067])box([.160,.085,.049],.012,enamel,[-.575,.165,centerZ+z],fixed);
  disc(.095,.192,shell,[-.586,beamHeight,centerZ],{rotation:axial,cast:true});
  disc(.091,.031,dark,[-.688,beamHeight,centerZ],{rotation:axial,cast:true});
  ring(.035,.084,.016,.004,bronze,[-.705,beamHeight,centerZ],{rotation:axial});
  for(let index=0;index<5;index++) {
    ring(.090,.104,.007,.0025,bronze,[-.651+index*.019,beamHeight,centerZ],{rotation:axial});
  }
  ring(.060,.101,.041,.005,silver,[-.500,beamHeight,centerZ],{rotation:axial,cast:true});
  disc(.057,.008,glassBack,[-.478,beamHeight,centerZ],{rotation:axial});
  ring(.043,.059,.010,.002,bright,[-.472,beamHeight,centerZ],{rotation:axial});
  disc(.042,.008,white,[-.465,beamHeight,centerZ],{rotation:axial});
  const fin=shape(.076,.009,.008,.003);
  for(let i=0;i<28;i++){
    const a=i*Math.PI/14;
    mount(fin,enamel,[-.554,beamHeight+.093*Math.cos(a),centerZ+.093*Math.sin(a)],
      {rotation:axisAngleToQuaternion([1,0,0],a)});
  }

  // Differential-power optic in a machined toric cell.
  box([.142,.030,.230],.010,shell,[lensX,.121,centerZ],fixed);
  for(const z of [-.082,.082])box([.075,.128,.043],.012,enamel,[lensX,.180,centerZ+z],fixed);
  ring(.109,.137,.042,.006,dark,[lensX,beamHeight,centerZ],{rotation:axial,cast:true});
  ring(.106,.132,.011,.003,bronze,[lensX+.025,beamHeight,centerZ],{rotation:axial});
  ring(.106,.121,.013,.003,silver,[lensX-.024,beamHeight,centerZ],{rotation:axial});
  const focusDrum=engine.createMesh().setPosition([lensX,beamHeight,centerZ]);
  const knob=shape(.032,.013,.012,.0032);
  for(let i=0;i<20;i++) {
    const a=i*Math.PI/10;
    mount(knob,i===0?bright:enamel,[0,.135*Math.cos(a),.135*Math.sin(a)],
      {parent:focusDrum,rotation:axisAngleToQuaternion([1,0,0],a)});
  }
  const lens=engine.createMesh().setPosition([lensX,beamHeight,centerZ]);
  optics.lens(lens,pupilRadius+.002);

  // The observation plate rides on the rails. Its face is normal to the chief ray.
  const receiver=engine.createMesh();
  const carriage={parent:receiver};
  function support(dims,r,mat,at) {
    const mesh=box(dims,r,mat,at,carriage);
    shadows.add(mesh);
    return mesh;
  }
  support([.161,.030,.223],.011,shell,[.031,.125,centerZ]);
  for(const z of [-.084,.084]) support([.129,.043,.040],.010,bronze,[.027,.139,centerZ+z]);
  support([.044,.145,.091],.009,enamel,[.029,.180,centerZ]);
  support([.035,.235,.251],.012,black,[.027,beamHeight,centerZ]);
  box([.012,.208,.227],.006,bronze,[.008,beamHeight,centerZ],carriage);
  box([.009,.192,.199],.004,glassBack,[.004,beamHeight,centerZ],carriage);
  const plate=engine.createMesh(receiver).setPosition([-.001,beamHeight,centerZ]);
  optics.screen(plate);
  box([.031,.012,.067],.005,bright,[.020,.412,centerZ],carriage);
  const screw=cylinderGeometry(.0065,.0065,.004,16,1);
  for(const y of [-.104,.104])for(const z of [-.109,.109]){
    mount(screw,silver,[.005,beamHeight+y,centerZ+z],{parent:receiver,rotation:axial});
  }
  box([.048,.011,.029],.003,bright,[.012,.138,.146],carriage);
  box([.008,.003,.030],.001,white,[0,.146,.155],carriage);

  const rays=[];
  for(const fan of [0,1])for(const crossing of [-1,-.68,.68,1]){
    const anchor=engine.createMesh();
    const radius=crossing*pupilRadius*.989;
    const guide=optics.beam(anchor,fan);
    rays.push({anchor,guide,u:fan===1?radius:0,v:fan===0?radius:0});
  }
  const axis=engine.createMesh();
  const chiefGuide=optics.beam(axis,2);
  function beam(anchor,from,to,width) {
    const delta=to.map((value,index)=>value-from[index]);
    const length=Math.hypot(...delta);
    const axisLength=Math.hypot(delta[0],delta[1]);
    const rotation=axisAngleToQuaternion([-delta[1]/axisLength,delta[0]/axisLength,0],Math.acos(delta[2]/length));
    anchor.setPosition(from).setQuaternion(rotation).setScale([width,width,length]);
  }
  const carrierMotion=[0,0,0];
  return {
    meshes:meshes+rays.length+3,
    ready:optics.ready,
    showGuides(visible) {
      chiefGuide.visible=visible;
      for (const {guide} of rays) guide.visible=visible;
    },
    update(distance, separation, planes) {
      const screenX=lensX+distance;
      carrierMotion[0]=screenX;
      receiver.setPosition(carrierMotion);
      warmIndex.setPosition([lensX+planes.tangential,.099,.156]);
      coolIndex.setPosition([lensX+planes.sagittal,.099,.208]);
      focusDrum.setQuaternion(axisAngleToQuaternion([1,0,0],separation/.16*1.67));
      for(const {anchor,u,v} of rays) {
        const [right,up]=imagePoint(u,v,distance,planes);
        beam(anchor,[lensX,beamHeight+v,centerZ+u],[screenX-.0012,beamHeight+up,centerZ+right],.0066);
      }
      beam(axis,[-.463,beamHeight,centerZ],[screenX-.0012,beamHeight,centerZ],.0048);
      optics.update(spotRadii(distance,planes));
    },
  };
}

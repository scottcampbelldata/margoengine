import { OpticsScreens } from '@margoengine/optics/screens';

// Fan 0 is the tangential (amber) fan, 1 the sagittal (blue) fan and 2 the dimmer chief ray.
const beamLooks=[[.99,.52,.22],[.52,.83,.98],[.88,.83,.72]].map((color,fan)=>({
  edge:color,core:color,coreMix:0,coreFalloff:21,coreWeight:.84,haloFalloff:3.2,haloWeight:.16,
  lengthBase:.64,lengthSlope:.34,lengthTaper:0,opacity:fan===2?.65:1,
}));
// The screens' faces lie in their own xy plane; the bench's lens and screen face along x.
const faceX=[0,Math.SQRT1_2,0,Math.SQRT1_2],faceMinusX=[0,-Math.SQRT1_2,0,Math.SQRT1_2];

export function installOptics(engine) {
  const screens=OpticsScreens.attach(engine);
  let image;
  return {
    ready:()=>screens.ready(),
    update([horizontal,vertical]){
      image.set({spotRadius:[Math.max(.0012,horizontal),Math.max(.0012,vertical)],
        hueMix:vertical/Math.max(.00001,horizontal+vertical)});
    },
    beam(parent,fan){return screens.beam(parent,beamLooks[fan]).mesh;},
    // A decorative toric face: the two powers themselves come from the ray model.
    lens(parent,radius){
      screens.lens(engine.createMesh(parent).setQuaternion(faceX),radius,{ribbonX:-1},{sagU:-.0021,sagV:.004});
    },
    screen(parent){image=screens.reticle(engine.createMesh(parent).setQuaternion(faceMinusX),.092,.088);},
  };
}

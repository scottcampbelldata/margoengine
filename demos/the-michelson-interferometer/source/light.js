import { OpticsScreens } from '@margoengine/optics/screens';
import { carrierMeters, fringeCount, visibility } from './optics.js';

// The bench's light and glass: one optics-screens set, so the whole bench compiles one pipeline.
const coated={tint:[.79,.59,.40],sheen:[.79,.59,.40],sheenMix:0,base:.19,rimWeight:.28,bandWeight:0};
const halfWidth=.106;

export function installLight(engine){
  const screens=OpticsScreens.attach(engine,{name:'Interferometer light and glass'});
  let detector;
  return {
    ready:()=>screens.ready(),
    lamp(parent,radius){screens.spot(parent,radius,radius);},
    glass(parent,w,h){screens.plate(parent,w,h);},
    splitter(parent,w,h){screens.plate(parent,w,h,coated);},
    detector(parent){detector=screens.fringes(parent,halfWidth,{frequency:halfWidth/carrierMeters,visibility});},
    beam(parent,returning){return screens.beam(parent,returning?{opacity:.83}:{}).mesh;},
    update(distance){detector.set({cycles:fringeCount(distance)%1});},
  };
}

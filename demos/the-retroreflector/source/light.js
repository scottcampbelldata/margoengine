import { OpticsScreens } from '@margoengine/optics/screens';

// Amber lamp light, the returned (cyan) light and the blue guide; each face of the corner cube shows one of them.
const tints=[[1,.50,.16],[.36,1,.81],[.43,.70,1]];
const beamLook=(tint)=>({edge:tint,core:[1,.96,.83],coreMix:.37,colorFalloff:25,
  coreFalloff:25,coreWeight:.87,haloFalloff:4,haloWeight:.13,lengthTaper:0});
const glowLook=(tint)=>({edge:tint,core:[1,.97,.88],coreMix:.52,colorFalloff:7,
  innerFalloff:8,innerWeight:.86,outerFalloff:2.6,outerWeight:.17,fade:1});
const dotLook=(tint)=>({edge:tint,core:[1,.98,.91],coreMix:1,hardCore:[.035,.13],
  innerWeight:.87,outerFalloff:4.8,outerWeight:.34,fade:1});

export function installLight(engine){
  const glow=OpticsScreens.attach(engine);
  const mirrors=OpticsScreens.attach(engine,{blending:'none'});
  return {
    async ready(){await Promise.all([glow.ready(),mirrors.ready()]);},
    mirror(parent,points,normal,face){mirrors.facet(parent,points,normal,{tint:tints[face]});},
    // Styles 0 to 2 are soft glows in those tints, 3 to 5 the hard bounce dots.
    plate(parent,radius,style){
      const look=style<3?glowLook(tints[style]):dotLook(tints[style-3]);
      return glow.spot(parent,radius,radius,look).mesh;
    },
    beam(parent,style){return glow.beam(parent,beamLook(tints[style])).mesh;},
  };
}

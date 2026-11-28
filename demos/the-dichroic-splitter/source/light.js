import { OpticsScreens } from '@margoengine/optics/screens';
import { lerp } from '@margoengine/math/mathutils';

// The guides, the coating and the lit receivers share one additive optics-screens set (one pipeline).
const white=[.94,.96,1];
const beamLook={coreMix:0,coreFalloff:22,coreWeight:.78,haloFalloff:5.8,haloWeight:.28,lengthTaper:0};
const coatingLook={sheenMix:0,bandY:.7,bandOffset:0,rimStart:.70,base:.14,rimWeight:.20,bandWeight:.07,bandFalloff:14};
const spotLook={coreMix:0,innerFalloff:7,innerWeight:.98,outerFalloff:2.6,outerWeight:.26,fade:1};
const coated=(color)=>{const tint=color.map((c,i)=>lerp([.11,.18,.25][i],c,.58));return {tint,sheen:tint};};
const lit=(color)=>({edge:color,core:color});

export function installLight(engine) {
  const screens=OpticsScreens.attach(engine,{blending:'additive'});
  const reflected=[],transmitted=[],coatings=[];
  let colors={reflected:[.05,.8,1],transmitted:[1,.20,.04]};
  return {
    ready:()=>screens.ready(),
    update(next){
      colors=next;
      for(const part of reflected)part.set(lit(next.reflected));
      for(const part of coatings)part.set(coated(next.reflected));
      for(const part of transmitted)part.set(lit(next.transmitted));
    },
    // Guide 0 is the white input, 1 the transmitted and 2 the reflected beam.
    beam(parent,usage){
      const color=[white,colors.transmitted,colors.reflected][usage];
      const part=screens.beam(parent,{...beamLook,...lit(color)});
      if(usage===1)transmitted.push(part);
      if(usage===2)reflected.push(part);
    },
    coating(parent,width,height){
      const part=screens.plate(parent,width,height,{...coatingLook,...coated(colors.reflected)});
      coatings.push(part);
    },
    receiver(parent,width,height,isReflected){
      const part=screens.spot(parent,width,height,{...spotLook,...lit(isReflected?colors.reflected:colors.transmitted)});
      (isReflected?reflected:transmitted).push(part);
    },
  };
}

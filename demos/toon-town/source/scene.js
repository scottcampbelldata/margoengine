import { Toon } from '@margoengine/toon';
import { Hatching } from '@margoengine/toon/hatch';
import { buildVillage } from './village.js';
import { pressPlate } from './interaction.js';

export async function install(engine,canvas,signal,fail){
  engine.scene.background='#bed4c9';
  const village=buildVillage(engine);
  const toon=Toon.attach(engine,{bands:4,rim:.065,outline:.019,color:[.083,.073,.061]});
  engine.lighting.direction.set([-.43,.82,.38,1.3]);
  engine.lighting.radiance.set([1,.88,.73,.55]);
  engine.lighting.ambient.set([.86,.94,1]);

  const options={spacing:10,width:1.75,layers:3,angle:37,ink:[.204,.173,.147]};
  let ink=Hatching.attach(engine,options);
  return pressPlate(engine,canvas,signal,fail,village,{
    setMode(mode){
      if(mode==='bands'){ink?.dispose();ink=undefined;return;}
      ink??=Hatching.attach(engine,options);
      ink.set({style:mode,spacing:mode==='halftone'?11:10,angle:mode==='halftone'?32:37,ink:mode==='halftone'?[.214,.184,.162]:options.ink});
    },
    fence:()=>engine.gpu.queue.onSubmittedWorkDone(),
    dispose(){ink?.dispose();toon.dispose();}
  });
}

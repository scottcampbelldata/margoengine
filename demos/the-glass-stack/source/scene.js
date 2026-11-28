
import {OIT} from '@margoengine/oit';
import {MomentOIT} from '@margoengine/oit/moments';
import {ExactOIT} from '@margoengine/oit/exact';
import {PeelOIT} from '@margoengine/oit/peel';
import {makeGlassRoom} from './art.js';

import {runGlass} from './interaction.js';
export async function install(engine,canvas,signal,fail){
  const translated=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const room=makeGlassRoom(engine);
  const methods={weighted:()=>OIT.attach(engine),moments:()=>MomentOIT.attach(engine,{depthRange:[3.1,9.4]}),
    exact:()=>translated?PeelOIT.attach(engine,{layers:12}):ExactOIT.attach(engine,{layers:12})};
  let effect,method,removers=[];
  const adapter={room,renderer:translated?'webgl2':'webgpu',exact:translated?'Depth peeling':'Per-pixel fragment lists',
    select({mode,smoke,reverse}){
      for(const remove of removers)remove();
      if(mode!==method){effect?.dispose();effect=methods[mode]();method=mode;}
      const shapes=[...room.glazes,...(smoke?room.smoke:[])];
      for(const cloud of room.smoke)cloud.root.visible=smoke;
      if(reverse)shapes.reverse();
      removers=shapes.map(model=>effect.add(model));return removers.length;
    },
    wait:()=>engine.gpu.queue.onSubmittedWorkDone(),dispose:()=>effect?.dispose()
  };
  return runGlass(engine,canvas,signal,fail,adapter);
}

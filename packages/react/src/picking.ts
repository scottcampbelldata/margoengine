import type {Engine} from '@margoengine/core/extension';
import type {EngineKernel} from '@margoengine/core';
import type {Picking} from '@margoengine/selection';
import type {Frames,Resources} from './internal.js';
import {optionalPeer} from './optional.js';

interface PickerLease {active:boolean;promise:Promise<Picking|undefined>;sync:()=>void;release:()=>void}
const pickers=new WeakMap<Engine,PickerLease>();
/** One native GPU picker sees both core meshes and registered optional model draws. */
export async function preparePicking(engine:Engine,resources:Resources,frames:Frames):Promise<void> {
  let entry=pickers.get(engine);
  if(!entry) {
    let picker:Picking|undefined,owned=false;
    const models=new Map<Resources['models'] extends Set<infer M>?M:never,()=>void>();
    const sync=()=>{
      if(!picker||!entry!.active||engine.disposed)return;
      for(const [model,remove] of models)if(model.disposed||!resources.models.has(model)){remove();models.delete(model);}
      for(const model of resources.models)if(!model.disposed&&!models.has(model))models.set(model,picker.add(model));
    };
    const current:PickerLease={active:true,promise:Promise.resolve(undefined),sync,release(){
      current.active=false;frames.callbacks.delete(sync);for(const remove of models.values())remove();models.clear();if(owned)picker?.dispose();
    }};
    entry=current;pickers.set(engine,current);
    current.promise=optionalPeer('@margoengine/selection',()=>import('@margoengine/selection')).then(({Picking})=>{
      if(!current.active||engine.disposed)return;
      picker=Picking.forEngine?.(engine as unknown as EngineKernel);
      // A custom picking plugin remains responsible for its own optional sources.
      if(!picker&&engine.hasPlugin('picking'))return;
      if(!picker){picker=Picking.attach(engine as unknown as EngineKernel,{capture:false});owned=true;}
      frames.callbacks.add(sync);sync();return picker;
    }).catch(error=>{current.release();if(pickers.get(engine)===current)pickers.delete(engine);throw error;});
  }
  await entry.promise;
  // Assets may have loaded or unmounted since the previous pointer event.
  entry.sync();
}
export function releasePicking(engine:Engine):void {const entry=pickers.get(engine);if(entry){pickers.delete(engine);entry.release();}}

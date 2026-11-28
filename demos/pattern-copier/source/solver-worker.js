import {OverlappingModel} from '@margoengine/wfc/overlapping';
import {size,width,height} from './patterns.js';

let source=null,model=null;
self.addEventListener('message',event=>{
  const {id,seed,sample}=event.data;
  try{
    if(!source||!sample.every((value,index)=>value===source[index])){
      model=new OverlappingModel({data:sample,width:size,height:size},{N:3,periodicInput:true,symmetry:1});
      source=sample;
    }
    const solved=model.solve(width,height,{seed,periodic:false,attempts:3,backtracks:350});
    const cells=Uint8Array.from(solved);
    self.postMessage({id,seed,cells,patterns:model.patterns,backtracks:model.stats.backtracks},[cells.buffer]);
  }catch(reason){
    self.postMessage({id,seed,error:reason instanceof Error?reason.message:String(reason)});
  }
});

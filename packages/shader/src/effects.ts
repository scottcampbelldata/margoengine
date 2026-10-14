import type {Node} from './node.js';
/** Side-effect nodes (atomics) made while a ComputePass body runs; loop and Fn bodies run them only where their result is used. */
export const effects:{list?:Node[]}={};
/** Runs a loop or Fn body without collecting its effects. */
export const nested=<R>(body:()=>R):R=>{const saved=effects.list;effects.list=undefined;try{return body();}finally{effects.list=saved;}};

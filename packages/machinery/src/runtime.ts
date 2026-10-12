import {machineryWasm} from './wasm.js';
export interface MachineryExports extends WebAssembly.Exports {
  memory:WebAssembly.Memory;
  allocate(bytes:number):number;
  surface_tick(ptr:number,count:number,delta:number,gravity:number):number;
  telemetry_sample(ptr:number,count:number,t:number,span:number):void;
  bvh_build(ptr:number,count:number):number;
  bvh_ray(ptr:number,count:number,ox:number,oy:number,oz:number,dx:number,dy:number,dz:number,max:number,out:number):void;
}
let compiled:Promise<WebAssembly.Module>|undefined;
export async function machineryMemory(bytes:number):Promise<{api:MachineryExports;ptr:number;buffer:ArrayBuffer}> {
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>256*1024*1024)throw new RangeError('Machinery memory limit');
  compiled??=(async()=>{const data=Uint8Array.from(atob(machineryWasm),c=>c.charCodeAt(0));return WebAssembly.compile(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());})().catch(error=>{compiled=undefined;throw error;});
  const api=(await WebAssembly.instantiate(await compiled)).exports as MachineryExports,ptr=api.allocate(bytes);
  if(!ptr)throw new Error('Could not allocate machinery storage');return {api,ptr,buffer:api.memory.buffer as ArrayBuffer};
}

import {decodeXz} from '@margoengine/decoders/xz';

self.addEventListener('message',async ({data:packed})=>{
  try{
    const begin=performance.now();
    const decoded=decodeXz(new Uint8Array(packed),{maxBytes:730000});
    const decode=performance.now()-begin;
    const module=await WebAssembly.compile(decoded);
    self.postMessage({module,bytes:decoded.byteLength,decode});
  }catch(error){
    self.postMessage({error:error.message});
  }
},{once:true});

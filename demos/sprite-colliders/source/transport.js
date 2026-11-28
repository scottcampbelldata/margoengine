const simdInstruction=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);

export function kernelResponse(signal){
  if(typeof DecompressionStream==='undefined')return undefined;
  const url=WebAssembly.validate(simdInstruction)
    ?new URL('./kernel-simd.packed',import.meta.url)
    :new URL('./kernel-scalar.packed',import.meta.url);
  const channel=new TransformStream();
  fetch(url,{signal}).then(response=>{
    if(!response.ok||!response.body)throw new Error('The 2D physics kernel could not download.');
    return response.body.pipeThrough(new DecompressionStream('gzip')).pipeTo(channel.writable,{signal});
  }).catch(error=>{
    if(!channel.writable.locked)return channel.writable.abort(error).catch(()=>{});
  });
  return new Response(channel.readable,{headers:{'Content-Type':'application/wasm'}});
}

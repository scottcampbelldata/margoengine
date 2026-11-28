const simd=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);

export async function getKernel(signal){
  if(!globalThis.DecompressionStream)return undefined;
  const url=WebAssembly.validate(simd)
    ?new URL('./kernel-simd.packed',import.meta.url)
    :new URL('./kernel-scalar.packed',import.meta.url);
  const response=await fetch(url,{signal});
  if(!response.ok||!response.body)throw new Error('The physics kernel could not download.');
  const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream,{headers:{'Content-Type':'application/wasm'}});
}

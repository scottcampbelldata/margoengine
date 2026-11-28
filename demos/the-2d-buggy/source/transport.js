const simd=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
export async function unpackKernel(signal){
  if(typeof DecompressionStream==='undefined')return undefined;
  const url=WebAssembly.validate(simd)
    ?new URL('./kernel-simd.packed',import.meta.url)
    :new URL('./kernel-scalar.packed',import.meta.url);
  const source=await fetch(url,{signal});
  if(!source.ok||!source.body)throw new Error('The selected 2D physics kernel could not download.');
  const raw=source.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(raw).arrayBuffer();
}

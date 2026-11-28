const simdInstruction=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
let flight;

export function primeCourseKernel(signal){
  if(flight)return flight.result;
  const variant=WebAssembly.validate(simdInstruction)?'simd':'scalar';
  const file=variant==='simd'
    ?new URL('./course-simd.packed',import.meta.url)
    :new URL('./course-scalar.packed',import.meta.url);
  const worker=new Worker(new URL('./kernel-worker.js',import.meta.url),{type:'module'});
  const readback=new Promise((resolve,reject)=>{
    worker.addEventListener('message',({data})=>{
      if(data.error){reject(new Error(data.error));return;}
      performance.measure('course-xz-decode',{start:0,duration:data.decode});
      resolve(data.module);
    },{once:true});
    worker.addEventListener('error',event=>reject(new Error(event.message||'The course kernel worker stopped.')),{once:true});
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  readback.catch(()=>{});
  const result=(async()=>{
    try{
      const response=await fetch(file,{signal});
      if(!response.ok)throw new Error('The course physics kernel could not download.');
      const packed=await response.arrayBuffer();
      performance.mark('course-packed-ready');
      worker.postMessage(packed,[packed]);
      const module=await readback;
      performance.mark('course-compiled');
      return module;
    }finally{
      worker.terminate();
    }
  })();
  flight={variant,result};
  return result;
}
export function compileCourseKernel(variant){
  if(flight?.variant!==variant)throw new Error('The course requested an unprepared physics kernel.');
  return flight.result;
}

export function openModeler(signal){
  const worker=new Worker(new URL('./model-worker.js',import.meta.url),{type:'module'});
  let sequence=0;
  const pending=new Map();
  let unavailable;
  function stop(reason){
    unavailable=reason;
    worker.terminate();
    for(const job of pending.values())job.reject(reason);
    pending.clear();
  }
  signal.addEventListener('abort',()=>stop(signal.reason),{once:true});
  worker.addEventListener('error',event=>stop(new Error(event.message||'The model worker could not open.')));
  worker.addEventListener('message',({data})=>{
    const job=pending.get(data.id);
    if(!job)return;
    pending.delete(data.id);
    if(data.error)job.reject(new Error(data.error));
    else job.resolve(data);
  });
  return (mode,width)=>{
    if(unavailable)return Promise.reject(unavailable);
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      pending.set(id,{resolve,reject});
      worker.postMessage({id,mode,width});
    });
  };
}

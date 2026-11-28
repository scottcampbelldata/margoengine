export function openSolver(signal){
  const worker=new Worker(new URL('./solver-worker.js',import.meta.url),{type:'module'});
  const pending=new Map();
  let sequence=0,closed=false;
  function finish(reason){
    if(closed)return;
    closed=true;
    worker.terminate();
    for(const value of pending.values()){
      clearTimeout(value.timer);
      value.reject(reason);
    }
    pending.clear();
  }
  signal.addEventListener('abort',()=>finish(signal.reason),{once:true});
  worker.addEventListener('error',event=>finish(event.error??new Error(event.message||'The pattern worker stopped.')));
  worker.addEventListener('message',event=>{
    const result=event.data,task=pending.get(result.id);
    if(!task)return;
    pending.delete(result.id);
    clearTimeout(task.timer);
    task.resolve(result);
  });
  return function solve(sample,seed){
    signal.throwIfAborted();
    if(closed)return Promise.reject(new Error('The pattern worker is unavailable.'));
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>finish(new Error('The pattern worker timed out.')),8000);
      pending.set(id,{resolve,reject,timer});
      worker.postMessage({id,sample,seed});
    });
  };
}

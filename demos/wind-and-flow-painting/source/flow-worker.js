import {tracePathline,traceStreakline} from '@margoengine/sciviz/flow';
import {bounds,defaultSeed,duration,temporalGrid} from './flow-field.js';

const field=temporalGrid();
const maxSteps=320, step=.026;
const safeSeed=seed=>Array.isArray(seed)&&seed.length===3&&seed[2]===0&&
  seed[0]>bounds[0]&&seed[0]<bounds[1]&&seed[1]>bounds[2]&&seed[1]<bounds[3];
let cached, current;
function oldest(seed){
  const key=seed.join(',');
  if(cached?.key!==key){
    const path=tracePathline(field,seed,{from:0,to:duration,maxSteps,step});
    cached={key,path};
    path.catch(()=>{if(cached?.path===path)cached=undefined;});
  }
  return cached.path;
}
async function solve({time,seed},signal){
  if(!safeSeed(seed)||!Number.isFinite(time)||time<=0||time>duration)throw new RangeError('Invalid flow probe');
  const activeAge=Math.min(4.2,time), earliest=time-activeAge;
  const times=Float64Array.from({length:30},(_,k)=>earliest+activeAge*k/29);
  times[times.length-1]=time;
  const [path,streak]=await Promise.all([
    oldest(seed),
    traceStreakline(field,seed,times,{to:time,maxSteps,step,signal}),
  ]);
  return {path:path.samples.slice(),streak:streak.samples,time};
}
self.addEventListener('message',event=>{
  const request=event.data;
  if(request.kind==='cancel'){
    current?.abort();
    return;
  }
  current?.abort();
  const controller=new AbortController();
  current=controller;
  const opening=request.time===.68&&request.seed.every((v,i)=>v===defaultSeed[i]);
  const job=opening?initial.then(({path,streak,time})=>({path:path.slice(),streak:streak.slice(),time})):solve(request,controller.signal);
  job.then(result=>{
    if(!controller.signal.aborted)self.postMessage({id:request.id,...result},[result.path.buffer,result.streak.buffer]);
  }).catch(error=>{
    if(!controller.signal.aborted)self.postMessage({id:request.id,error:error instanceof Error?error.message:String(error)});
  });
});
const preparing=new AbortController();
const initial=solve({time:.68,seed:defaultSeed},preparing.signal);
initial.catch(()=>{});

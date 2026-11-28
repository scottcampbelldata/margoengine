import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'),push=el('push'),drop=el('drop'),status=demoStatus(exhibit,el('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';

const worker=globalThis.__margoRainWorker??new Worker(new URL('./physics-worker.js',import.meta.url),{type:'module'});
delete globalThis.__margoRainWorker;
let scene,settle,initial=false;
const prepared=new Promise(resolve=>{settle=resolve;});
worker.addEventListener('message',({data})=>{
  if(data.type==='kernel')performance.mark('rain-physics');
  if(data.type==='error'){
    const error=new Error(data.message);
    if(!initial)settle({error});
    fail(error);
  }
  if(data.type==='frame'){
    if(!initial){initial=true;settle(data);}
    else scene?.receive(data);
  }
},{signal});
worker.addEventListener('error',event=>{
  const error=new Error(event.message||'The physics worker could not start.');
  if(!initial)settle({error});
  fail(error);
},{signal});
function fail(error){
  if(signal.aborted||status.failed)return;
  push.disabled=drop.disabled=true;
  worker.terminate();
  scene?.close();
  status.error(error);
}
function show(state){
  const {awake,hit,inputs,steps,work,run,total,representative,queued,physicsReady}=state;
  Object.assign(exhibit.dataset,{awake:awake??'',inputs,steps,work,run,total,representative,queued:!!queued,physicsReady:!!physicsReady,
    target:hit?.id??'',deltaVelocity:hit?.change.toFixed(3)??'',mass:hit?.mass.toFixed(2)??'',observed:hit?.observed?.toFixed(3)??''});
  const waking=awake===null?'—':String(awake);
  if(el('awake').textContent!==waking)el('awake').textContent=waking;
  const last=hit?(hit.kind==='sphere'?'Sphere':'Box')+' · '+hit.mass.toFixed(1)+' kg':'—';
  if(el('last-hit').textContent!==last)el('last-hit').textContent=last;
  const activity=queued?'Release queued':steps===0?'Ready to fall':steps<110?'Falling':awake>0?'Settling':'At rest';
  if(el('activity').textContent!==activity)el('activity').textContent=activity;
}
push.addEventListener('click',()=>scene?.shoot(),{signal});
drop.addEventListener('click',()=>scene?.drop(),{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted){worker.terminate();controller.abort();}},{signal});
import('./scene.js').then(async module=>{
  scene=await module.openRain(el('canvas'),force,signal,worker,prepared,show,
    ()=>performance.mark('margo-first-input-rendered'),fail);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  scene.show();
  push.disabled=drop.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

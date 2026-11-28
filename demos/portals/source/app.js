import { demoStatus } from 'margo-demo-status';

const element=id=>document.getElementById(id);
const exhibit=element('exhibit'),input=element('eye'),reading=element('eye-value');
const status=demoStatus(exhibit,element('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,observer,frame,working=false,dirty=false,revision=0,value=0;

function show(pos){
  exhibit.dataset.eye=String(pos);
  reading.textContent=pos===0?'Centred':(Math.abs(pos)/100).toFixed(2)+' m '+(pos<0?'left':'right');
  input.setAttribute('aria-valuetext',reading.textContent);
}
function fail(cause){
  if(signal.aborted)return;
  status.error(cause);
  input.disabled=true;
  scene?.close();
}
function queue(){
  dirty=true;
  if(frame!==undefined||working||!scene||signal.aborted||status.failed)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    dirty=false;
    working=true;
    const next=value,serial=revision;
    try{
      await scene.render(next/100);
      if(signal.aborted)return;
      if(serial===revision){
        show(next);
        if(serial>0&&!performance.getEntriesByName('margo-first-input-rendered').length){
          performance.mark('margo-first-input-rendered');
        }
      }
    }catch(cause){fail(cause);}
    finally{
      working=false;
      if(dirty)queue();
    }
  });
}

input.addEventListener('input',()=>{
  value=Number(input.value);
  revision++;
  queue();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const art=new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./art-worker.js',import.meta.url),{type:'module'});
  const finish=()=>{
    signal.removeEventListener('abort',cancel);
    worker.terminate();
  };
  const cancel=()=>{finish();reject(signal.reason);};
  signal.addEventListener('abort',cancel,{once:true});
  worker.addEventListener('message',event=>{
    finish();
    performance.mark('margo-art-ready');
    resolve(event.data);
  },{once:true});
  worker.addEventListener('error',event=>{
    finish();
    reject(new Error(event.message||'The room geometry could not be prepared.'));
  },{once:true});
});
void art.catch(fail);
const compatibility=(force||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;

import('./scene.js').then(async({openGallery})=>{
  scene=await openGallery(element('view'),art,force,compatibility,signal);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  exhibit.dataset.references=scene.references.join(',');
  show(0);
  observer=new ResizeObserver(queue);
  observer.observe(element('stage'));
  input.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

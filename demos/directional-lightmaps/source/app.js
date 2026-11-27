import { demoStatus } from 'margo-demo-status';
import dataUrl from './tide-register.bin?url';

const element=id=>document.getElementById(id);
const stage=element('exhibit');
const controls={directional:element('directional'),flat:element('flat')};
const status=demoStatus(stage,element('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,observer,scheduled=false,dirty=false,working=false,target='directional',revision=0;

function update(mode,directional){
  stage.dataset.mode=mode;
  stage.dataset.applied=String(directional);
  for(const [name,button] of Object.entries(controls)){
    button.setAttribute('aria-pressed',String(mode===name));
  }
  element('summary').textContent=directional
    ? 'Glazed relief · intensity and direction'
    : 'Glazed relief · intensity only';
}
function fail(cause){
  if(signal.aborted)return;
  status.error(cause);
  Object.values(controls).forEach(button=>button.disabled=true);
  scene?.close();
}
function queue(){
  dirty=true;
  if(scheduled||working||!scene||status.failed||signal.aborted)return;
  scheduled=true;
  queueMicrotask(async()=>{
    scheduled=false;
    if(signal.aborted||status.failed)return;
    dirty=false;
    working=true;
    const selected=target,serial=revision;
    try{
      const directional=await scene.render(selected);
      if(signal.aborted)return;
      if(serial===revision){
        update(selected,directional);
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
for(const [key,button] of Object.entries(controls)){
  button.addEventListener('click',()=>{
    if(target===key)return;
    target=key;
    revision++;
    queue();
  },{signal});
}
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
},{signal});

const relief=new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./relief-worker.js',import.meta.url),{type:'module'});
  const finish=()=>{
    signal.removeEventListener('abort',cancel);
    worker.terminate();
  };
  const cancel=()=>{finish();reject(signal.reason);};
  signal.addEventListener('abort',cancel,{once:true});
  worker.addEventListener('message',event=>{
    finish();
    performance.mark('margo-relief-prepared');
    resolve(event.data);
  },{once:true});
  worker.addEventListener('error',cause=>{
    finish();
    reject(new Error(cause.message||'The relief worker could not prepare the material.'));
  },{once:true});
});
void relief.catch(fail);
const asset=fetch(dataUrl,{signal}).then(async response=>{
  if(!response.ok||!response.body)throw new Error('The Tide Register returned HTTP '+response.status);
  const packed=await response.arrayBuffer();
  const bytes=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const view=new DataView(bytes);
  if(view.getUint32(0,false)!==0x444c4d33)throw new Error('The Tide Register archive is invalid.');
  const width=view.getUint16(4,true),height=view.getUint16(6,true);
  const lightmapScale=view.getFloat32(8,true),directionalScale=view.getFloat32(12,true);
  const step=width*height*4;
  if(!width||!height||16+3*step!==bytes.byteLength){
    throw new Error('The Tide Register archive length is invalid.');
  }
  const map=index=>new Uint8Array(bytes,16+index*step,step);
  const images=await relief;
  return {images,bake:{width,height,lightmapScale,directionalScale,radiometry:'physical',
    lightmap:map(0),directionMap:map(1),directionalMap:map(2)}};
});
void asset.catch(fail);
const early=(force||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;

import('./scene.js').then(async({openRegister})=>{
  scene=await openRegister(element('view'),asset,force,early,signal);
  signal.throwIfAborted();
  if(status.failed){scene.close();return;}
  stage.dataset.renderer=scene.backend;
  update('directional',true);
  observer=new ResizeObserver(queue);
  observer.observe(element('stage'));
  Object.values(controls).forEach(button=>button.disabled=false);
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

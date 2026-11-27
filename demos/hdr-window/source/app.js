import { demoStatus } from 'margo-demo-status';
import exrUrl from './atrium.exr?url';
import bakedUrl from './atrium-ibl-packed.bin?url';

const element=id=>document.getElementById(id);
const panel=element('instrument'),select=element('source');
const passes={sdr:element('sdr'),extended:element('extended')};
const controls=[...Object.values(passes),select];
const status=demoStatus(panel,element('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let gallery,currentSource='exr',mode='sdr',busy=false,frame,request=0,handled=0,observer;
let needsFrame=false;

function read(state){
  const {backend,source,peak,mode,hdr,gamut,detail,extension}=state;
  Object.assign(panel.dataset,{renderer:backend,source,peak:peak.toFixed(2),mode,hdr,gamut,detail,extension});
  const name=mode==='sdr'?'SDR':extension?'HDR':'Highlight detail';
  element('view-label').textContent=name;
  passes.extended.textContent=hdr?'HDR':'Highlight detail';
  for(const [key,button] of Object.entries(passes))button.setAttribute('aria-pressed',String(key===mode));
  select.value=source;
  element('display').textContent=extension
    ? `HDR output · ${gamut==='p3'?'Display P3':'sRGB'} · rendered peak up to 4× SDR white`
    : detail
      ? `SDR output${gamut==='p3'?' · Display P3':''} · highlight-detail grade at −1.25 stops`
      : hdr?'SDR output · HDR available on this display':'SDR output · use Highlight detail to inspect bright areas';
  element('source-note').textContent=`${source==='exr'?'OpenEXR':'Ultra HDR JPEG'} · ${peak.toFixed(1)}× peak scene luminance relative to unit white`;
}

function fail(cause){
  if(signal.aborted)return;
  status.error(cause);
  controls.forEach(control=>control.disabled=true);
  gallery?.close();
}

function queue(){
  if(!gallery||busy||frame!==undefined||!needsFrame||signal.aborted||status.failed)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    busy=true;
    needsFrame=false;
    const serial=request;
    try{
      const state=await gallery.update({mode,source:currentSource});
      if(signal.aborted)return;
      read(state);
      handled=serial;
      if(serial>0&&serial===request&&!performance.getEntriesByName('margo-first-input-rendered').length)
        performance.mark('margo-first-input-rendered');
    }catch(cause){fail(cause);}
    finally{
      busy=false;
      if(!status.failed){
        select.disabled=false;
        if(handled!==request)needsFrame=true;
        queue();
      }
    }
  });
}
function edit(){
  request++;
  needsFrame=true;
  queue();
}
for(const [key,button] of Object.entries(passes)){
  button.addEventListener('click',()=>{
    if(mode===key)return;
    mode=key;
    edit();
  },{signal});
}
select.addEventListener('change',()=>{
  currentSource=select.value;
  select.disabled=true;
  edit();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

let sourceBytes;
const loadEXR=()=>sourceBytes??=fetch(exrUrl,{signal}).then(response=>{
  if(!response.ok)throw new Error('The gallery environment returned HTTP '+response.status);
  return response.arrayBuffer();
});
const earlyFallback=force||!navigator.gpu;
if(!earlyFallback)void loadEXR().catch(fail);
const compatibilityLighting=earlyFallback?fetch(bakedUrl,{signal}):undefined;
void compatibilityLighting?.catch(fail);
const compat=earlyFallback?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;

import('./scene.js').then(async({openWindow})=>{
  gallery=await openWindow(element('view'),loadEXR,compatibilityLighting,force,compat,signal);
  signal.throwIfAborted();
  if(status.failed){gallery.close();return;}
  read(gallery.read());
  observer=new ResizeObserver(()=>{needsFrame=true;queue();});
  observer.observe(element('stage'));
  controls.forEach(control=>control.disabled=false);
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

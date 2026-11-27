import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const panel=el('instrument'),tint=el('tint'),local=el('local'),file=el('lut');
const upload=el('upload'),remove=el('remove'),save=el('save'),fileStatus=el('file-status');
const curves={neutral:el('neutral'),agx:el('agx'),acescg:el('acescg')};
const controls=[...Object.values(curves),tint,local,upload,save];
const status=demoStatus(panel,el('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,observer,frame,working=false,dirty=false,eventNumber=0,fileNumber=0;
let liveFile='',pendingLUT;
const state={curve:'neutral',tint:0,local:0};

function show(state){
  panel.dataset.curve=state.curve;
  panel.dataset.tint=String(state.tint);
  panel.dataset.local=String(state.local);
  for(const [curve,button] of Object.entries(curves)){
    button.setAttribute('aria-pressed',String(state.curve===curve));
  }
  el('tint-value').textContent=Math.round(state.tint*100)+'%';
  el('local-value').textContent=Math.round(state.local*100)+'%';
  remove.disabled=!liveFile;
  panel.dataset.lut=liveFile;
}
function reportFile(message,error=false){
  fileStatus.textContent=message;
  if(error)fileStatus.setAttribute('role','alert');
  else fileStatus.removeAttribute('role');
}
function fail(cause){
  if(signal.aborted)return;
  status.error(cause);
  [...controls,remove].forEach(control=>control.disabled=true);
  scene?.close();
}
function queue(){
  dirty=true;
  if(frame!==undefined||working||!scene||signal.aborted||status.failed)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    dirty=false;
    working=true;
    const wanted={...state},serial=eventNumber,lut=pendingLUT;
    pendingLUT=undefined;
    if(lut)try{
      scene.load(lut.text);
      liveFile=lut.name;
      reportFile(liveFile?liveFile+' · applied after the tone curve':'No LUT loaded. Use a 3D LUT for display-linear RGB.');
    }catch(error){
      reportFile(error instanceof Error?error.message:String(error),true);
    }
    try{
      await scene.render(wanted);
      if(signal.aborted)return;
      if(serial===eventNumber){
        show(wanted);
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
function edit(){
  eventNumber++;
  queue();
}
for(const [curve,button] of Object.entries(curves))button.addEventListener('click',()=>{
  if(state.curve===curve)return;
  state.curve=curve;
  edit();
},{signal});
for(const input of [tint,local])input.addEventListener('input',()=>{
  state[input.id]=Number(input.value)/100;
  edit();
},{signal});
upload.addEventListener('click',()=>file.click(),{signal});
file.addEventListener('change',async()=>{
  const selected=file.files[0];
  file.value='';
  if(!selected)return;
  const request=++fileNumber;
  try{
    const text=await selected.text();
    if(request!==fileNumber||signal.aborted)return;
    pendingLUT={text,name:selected.name};
    edit();
  }catch(error){
    if(request===fileNumber)reportFile(error instanceof Error?error.message:String(error),true);
  }
},{signal});
remove.addEventListener('click',()=>{
  fileNumber++;
  pendingLUT={text:null,name:''};
  edit();
},{signal});
save.addEventListener('click',async()=>{
  save.disabled=true;
  try{
    const exportText=await scene.save();
    signal.throwIfAborted();
    const url=URL.createObjectURL(new Blob([exportText],{type:'text/plain'}));
    const link=document.createElement('a');
    link.href=url;
    link.download='signal-house-grade.cube';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){
    if(!signal.aborted)reportFile(error instanceof Error?error.message:String(error),true);
  }finally{
    if(!signal.aborted&&!status.failed)save.disabled=false;
  }
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const compatibility=(force||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;

import('./scene.js').then(async({openLook})=>{
  scene=await openLook(el('view'),force,compatibility,signal);
  signal.throwIfAborted();
  panel.dataset.renderer=scene.backend;
  show(state);
  observer=new ResizeObserver(queue);
  observer.observe(el('stage'));
  controls.forEach(control=>control.disabled=false);
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

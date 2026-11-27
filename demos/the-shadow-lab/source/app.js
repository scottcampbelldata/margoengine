import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const lab=el('lab'), slider=el('size'), glass=el('glass'), leaves=el('leaves');
const controls=[slider,glass,leaves];
const status=demoStatus(lab,el('status'));
const controller=new AbortController(), {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let state={size:Number(slider.value),glass:true,leaves:true};
let scene,frame,observer,rendering=false,dirty=false,revision=0;

function read(value){
  const angle=(value.size/10).toFixed(1)+'°';
  el('size-readout').textContent=angle;
  slider.setAttribute('aria-valuetext',angle+' angular radius');
  glass.setAttribute('aria-pressed',String(value.glass));
  leaves.setAttribute('aria-pressed',String(value.leaves));
  Object.assign(lab.dataset,value);
}

function fail(error){
  if(signal.aborted)return;
  for(const control of controls)control.disabled=true;
  status.error(error);
  scene?.close();
}

function queue(){
  if(signal.aborted||!scene||status.failed||rendering||frame!==undefined)return;
  frame=requestAnimationFrame(async()=>{
    frame=undefined;
    rendering=true;
    dirty=false;
    const next=state, serial=revision;
    try{
      await scene.render(next);
      if(signal.aborted)return;
      read(next);
      if(serial>0&&serial===revision&&!performance.getEntriesByName('margo-first-input-rendered').length){
        performance.mark('margo-first-input-rendered');
      }
    }catch(error){fail(error);}
    finally{
      rendering=false;
      if(dirty)queue();
    }
  });
}

function update(next){
  state={...state,...next};
  revision++;
  dirty=true;
  queue();
}
slider.addEventListener('input',()=>update({size:Number(slider.value)}),{signal});
glass.addEventListener('click',()=>update({glass:!state.glass}),{signal});
leaves.addEventListener('click',()=>update({leaves:!state.leaves}),{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const earlyCompatibility=(forced||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(forced,signal);
  return {};
}).catch(error=>({error})):undefined;
import('./scene.js').then(async({openScene})=>{
  scene=await openScene(el('view'),state,signal,forced,earlyCompatibility);
  signal.throwIfAborted();
  lab.dataset.renderer=scene.backend;
  Object.assign(lab.dataset,scene.passes);
  observer=new ResizeObserver(()=>{dirty=true;queue();});
  observer.observe(el('view').parentElement);
  read(state);
  for(const control of controls)control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

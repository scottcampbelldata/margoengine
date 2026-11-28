import { demoStatus } from 'margo-demo-status';

const byId=id=>document.getElementById(id);
const exhibit=byId('exhibit'),button=byId('shutter'),canvas=byId('canvas'),message=byId('status');
const status=demoStatus(exhibit,message);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const compatibility=(forced||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(forced,signal);
  return {};
}).catch(error=>({error})):undefined;
let scene,isOpen=false,revision=0,changing=false;

function display(sample) {
  const [red,green,blue]=sample.levels;
  for(const [id,level] of [['red',red],['green',green],['blue',blue]])byId(id).textContent=String(level);
  Object.assign(exhibit.dataset,{open:isOpen,rgb:sample.levels.join(','),quads:sample.quads,draws:sample.draws,revision});
  byId('position').textContent=isOpen?'Shutter open':'Shutter closed';
  button.setAttribute('aria-pressed',String(isOpen));
  button.innerHTML=(isOpen?'Close shutter':'Open shutter')+' <span aria-hidden="true">'+(isOpen?'↙':'↗')+'</span>';
  scene.canvas.setAttribute('aria-label','Stone vault in cutaway with its shutter '+(isOpen?'open':'closed')+
    '. The corner probe measures '+red+' red, '+green+' green and '+blue+' blue.');
}

function fail(error) {
  if(signal.aborted||status.failed)return;
  button.disabled=true;
  scene?.close();
  status.error(error);
}

button.addEventListener('click',async ()=>{
  if(!scene||changing||status.failed)return;
  changing=true;
  button.setAttribute('aria-busy','true');
  try{
    const sample=await scene.change(!isOpen);
    isOpen=!isOpen;
    revision++;
    display(sample);
    if(revision===1)performance.mark('margo-first-input-rendered');
  }catch(error){fail(error);}
  finally{
    changing=false;
    button.removeAttribute('aria-busy');
  }
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});
import('./scene.js').then(async module=>{
  scene=await module.openVault(canvas,forced,signal,compatibility,fail);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  display(scene.initial);
  button.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

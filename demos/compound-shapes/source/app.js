import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const exhibit=el('exhibit'),release=el('release'),reset=el('reset'),status=demoStatus(exhibit,el('status'));
const choices=[el('fork'),el('elbow')];
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const prepared=import('./physics.js').then(async module=>{
  await module.loadPhysics(signal);
  performance.mark('compound-physics');
  return module;
}).catch(error=>({error}));
let scene,lastSelected;
function fail(error){
  if(signal.aborted||status.failed)return;
  scene?.close();
  for(const control of [release,reset,...choices])control.disabled=true;
  status.error(error);
}
function text(id,value){
  const node=el(id);
  if(node.textContent!==value)node.textContent=value;
}
function present({observations,motion,selected,run,playing}){
  const item=observations[selected];
  const view=motion[selected];
  Object.assign(exhibit.dataset,{run,playing,selected,steps:view.steps,
    masses:observations.map(part=>part.mass.toFixed(4)).join(','),
    centers:observations.map(part=>part.center.map(x=>x.toFixed(6)).join(',')).join('|'),
    inertia:observations.map(part=>part.inertia.map(x=>x.toFixed(6)).join(',')).join('|'),
    contacts:motion.map(part=>part.contacts).join(','),
    height:motion.map(part=>part.height.toFixed(4)).join(','),
    angles:motion.map(part=>part.rotation.toFixed(5)).join(',')});
  if(lastSelected!==selected){
    lastSelected=selected;
    for(let i=0;i<choices.length;i++)choices[i].setAttribute('aria-pressed',String(i===selected));
    text('mass',item.mass.toFixed(2)+' kg');
    text('center',item.center.map(value=>Math.round(value*1000)).join(' / ')+' mm');
    text('inertia',item.inertia.map(value=>value.toFixed(2)).join(' / ')+' kg·m²');
  }
  text('motion',view.steps===0?'Ready to drop':view.contacts===0?'Falling':playing?'On the ramp':'At rest');
  release.disabled=playing;
}
release.addEventListener('click',()=>{try{scene?.release();}catch(error){fail(error);}},{signal});
reset.addEventListener('click',()=>{try{scene?.reset();}catch(error){fail(error);}},{signal});
for(const [index,button] of choices.entries()){
  button.addEventListener('click',()=>{try{scene?.select(index);}catch(error){fail(error);}},{signal});
}
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});
import('./scene.js').then(async module=>{
  scene=await module.openScene(el('canvas'),force,signal,prepared,present,
    ()=>performance.mark('margo-first-input-rendered'),fail);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  scene.status();
  for(const control of [reset,...choices])control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

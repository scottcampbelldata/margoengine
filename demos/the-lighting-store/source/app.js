import { demoStatus } from 'margo-demo-status';
import license from './profiles/LICENSE.txt?url&no-inline';

const exhibit=document.getElementById('exhibit'), slider=document.getElementById('distance');
const modes=[...document.querySelectorAll('[data-mode]')], controls=[slider,...modes];
const status=demoStatus(exhibit,document.getElementById('status'));
const controller=new AbortController(), {signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const first={distance:Number(slider.value),mode:'equal'};
let current=first, scene, frame, observer, rendering=false, dirty=false, revision=0;
const numeric=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
const label=id=>document.getElementById(id);
label('profile-license').href=license;

function read(state){
  const {distance,mode}=state;
  const [a,b]=scene.readings(distance,mode);
  label('distance-readout').textContent=distance.toFixed(2)+' m';
  slider.setAttribute('aria-valuetext',distance.toFixed(2)+' metres from the walls');
  for(const button of modes)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  const data={narrowCenter:a.center,narrowLower:a.lower,wideCenter:b.center,wideLower:b.lower};
  for(const [key,value] of Object.entries(data)){
    const id=key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
    label(id).textContent=numeric.format(value);
  }
  label('mode-note').textContent=mode==='equal'?'Both fixed at 3,000 lm':
    numeric.format(a.flux)+' lm narrow · '+numeric.format(b.flux)+' lm wide';
  Object.assign(exhibit.dataset,{distance,mode,...data});
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
    const next=current, serial=revision;
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

slider.addEventListener('input',()=>{
  current={...current,distance:Number(slider.value)};
  revision++;
  dirty=true;
  queue();
},{signal});
for(const mode of modes)mode.addEventListener('click',()=>{
  current={...current,mode:mode.dataset.mode};
  revision++;
  dirty=true;
  queue();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const earlyCompatibility=(forced||!navigator.gpu)
  ?import('./compatibility.js').then(async module=>{
    await module.installCompatibility(forced,signal);
    return {};
  }).catch(error=>({error})):undefined;
import('./scene.js').then(async({openScene})=>{
  scene=await openScene(label('lights'),first,signal,forced,earlyCompatibility);
  signal.throwIfAborted();
  exhibit.dataset.renderer=scene.backend;
  observer=new ResizeObserver(()=>{dirty=true;queue();});
  observer.observe(label('lights').parentElement);
  read(first);
  for(const control of controls)control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(fail);

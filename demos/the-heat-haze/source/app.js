import { demoStatus } from 'margo-demo-status';

const el=id=>document.getElementById(id);
const panel=el('haze'),slider=el('contrast'),motion=el('motion');
const status=demoStatus(panel,el('status'));
const controller=new AbortController(),{signal}=controller;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,observer,raf,rendering=false,dirty=false,serial=0;
let contrast=Number(slider.value),time=.73,playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastUpdate=0;
const frameGap=1000/30;

function read(state){
  const amount=state.contrast;
  el('amount').textContent=(amount?'+':'')+amount+' °C';
  slider.setAttribute('aria-valuetext',amount+' degrees Celsius warmer at the asphalt');
  motion.textContent=state.playing?'Pause shimmer':'Play shimmer';
  Object.assign(panel.dataset,{contrast:amount,time:state.time.toFixed(4),playing:state.playing});
}

function fail(error){
  if(signal.aborted)return;
  status.error(error);
  slider.disabled=motion.disabled=true;
  scene?.close();
}

function queue(){
  if(signal.aborted||!scene||status.failed||rendering||raf!==undefined||document.hidden)return;
  if(!dirty&&(!playing||contrast===0))return;
  raf=requestAnimationFrame(async now=>{
    raf=undefined;
    const elapsed=lastUpdate?Math.max(0,now-lastUpdate):0;
    if(!dirty&&elapsed<frameGap*.91){queue();return;}
    if(playing&&contrast>0)time+=Math.min(.08,elapsed/1000);
    lastUpdate=now;
    dirty=false;
    rendering=true;
    const state={contrast,time,playing},input=serial;
    try{
      await scene.render(state);
      if(signal.aborted)return;
      read(state);
      if(input>0&&input===serial&&!performance.getEntriesByName('margo-first-input-rendered').length){
        performance.mark('margo-first-input-rendered');
      }
    }catch(error){fail(error);}
    finally{rendering=false;queue();}
  });
}

slider.addEventListener('input',()=>{
  contrast=Number(slider.value);
  serial++;
  dirty=true;
  queue();
},{signal});
motion.addEventListener('click',()=>{
  playing=!playing;
  lastUpdate=0;
  serial++;
  dirty=true;
  queue();
},{signal});
document.addEventListener('visibilitychange',()=>{
  lastUpdate=0;
  if(!document.hidden)queue();
},{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(raf!==undefined)cancelAnimationFrame(raf);
},{signal});

const earlyCompatibility=(force||!navigator.gpu)?import('./compatibility.js').then(async module=>{
  await module.installCompatibility(force,signal);
  return {};
}).catch(error=>({error})):undefined;
import('./scene.js').then(async({openRoad})=>{
  scene=await openRoad(el('view'),{contrast,time},signal,force,earlyCompatibility);
  signal.throwIfAborted();
  panel.dataset.renderer=scene.backend;
  observer=new ResizeObserver(()=>{dirty=true;queue();});
  observer.observe(el('view').parentElement);
  read({contrast,time,playing});
  slider.disabled=motion.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
  queue();
}).catch(fail);

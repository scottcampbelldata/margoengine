import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createInterferometer, detectorFocus } from './model.js';
import { fringeCount, mirrorPeriodNm, opticalPathNm, travelNm } from './optics.js';
import { ShotBlend } from '@margoengine/cameras/shots';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const input=document.querySelector('#position');
const value=document.querySelector('#position-value');
const path=document.querySelector('#path');
const count=document.querySelector('#count');
const zero=document.querySelector('#zero');
const half=document.querySelector('#half');
const view=document.querySelector('#view');
const controls=[input,zero,half,view];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={target:[.021,.059,.020],offset:[-.85,.97,1.12],fit:1.25,fov:42};
const detail={target:[detectorFocus[0],detectorFocus[1]+.016,detectorFocus[2]],offset:[-.437,.182,.095],fit:1.06,fov:38};
let engine,shots,instrument,observer,frame,last=0;
let distance=Number(input.value),close=false,dirty=true,applied=false;
const nanometers=(nm)=>nm.toFixed(1)+' nm';

function resize(){
  const bounds=canvas.getBoundingClientRect();
  const w=Math.max(1,Math.round(bounds.width*1.5));
  const h=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}

function labels(){
  value.value=nanometers(distance);
  input.setAttribute('aria-valuetext',distance.toFixed(1)+' nanometers');
  path.value=nanometers(opticalPathNm(distance));
  count.value=fringeCount(distance).toFixed(3);
  if(document.body.dataset.state==='ready'){
    zero.disabled=distance===0;
    half.disabled=distance+mirrorPeriodNm/2>travelNm+.0001;
  }
  view.setAttribute('aria-pressed',String(close));
  view.textContent=close?'Whole bench':'Inspect fringes';
}

function paint(now){
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  shots.goal=Number(close);
  const moving=shots.update(delta,canvas.width,canvas.height);
  if(dirty){instrument.update(distance);dirty=false;}
  engine.render({delta});
  Object.assign(document.body.dataset,{
    distance:distance.toFixed(1),path:opticalPathNm(distance).toFixed(1),
    fringe:fringeCount(distance).toFixed(8),view:moving?'moving':close?'detector':'bench',
  });
  if(applied){performance.mark('margo-mirror-applied');applied=false;}
  if(moving)schedule();
  else last=0;
}

function schedule(){
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{try{paint(now);}catch(error){fail(error);}});
}

function clean(){
  if(lifetime.signal.aborted)return;
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error){
  document.body.dataset.state='error';
  for(const control of controls)control.disabled=true;
  loading.hidden=false;
  loading.textContent='The interferometer could not open on this browser.';
  console.error(error);
  clean();
}

function change(next){
  distance=next;
  input.value=distance.toFixed(1);
  dirty=true;
  applied=true;
  labels();
  schedule();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:400,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:42,near:.049,far:30},
  });
  if(!forced){
    try{engine=await open();}catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatibility=!engine;
  if(compatibility){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  shots=new ShotBlend(engine.camera,wide,detail,{rate:16,still:motion});
  engine.scene.background='#565568';
  engine.lighting.direction.set([-.74,1.59,.86,3.64]);
  engine.lighting.radiance.set([1,.94,.82,.48]);
  engine.lighting.ambient.set([.84,.91,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.063,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.72,-.21,-.70],max:[.72,.52,.70]},
  });
  instrument=createInterferometer(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:instrument.meshes});
  paint(performance.now());
  await instrument.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  input.addEventListener('input',()=>change(Number(input.value)),options);
  zero.addEventListener('click',()=>change(0),options);
  half.addEventListener('click',()=>change(Math.min(travelNm,distance+mirrorPeriodNm/2)),options);
  view.addEventListener('click',()=>{
    close=!close;
    instrument.showGuides(!close);
    labels();
    schedule();
  },options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  for(const control of controls)control.disabled=false;
  document.body.dataset.state='ready';
  labels();
  loading.hidden=true;
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createObservatory, prismCenter, skyCenter } from './model.js';
import { indices, minAt, minimumDeviation, tracePrism } from './optics.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const range=document.querySelector('#incidence');
const value=document.querySelector('#incidence-value');
const selected=document.querySelector('#ray');
const rim=document.querySelector('#rim');
const minimum=document.querySelector('#minimum');
const view=document.querySelector('#view');
const trace=document.querySelector('#trace');
const controls=[range,minimum,view,trace];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const optimum=minAt();
const redRim=minimumDeviation(indices[0]);
const wide={aim:[-.033,.173,.024],offset:[-.42,.746,1.81],fit:1.31,fov:43};
const halo={aim:skyCenter,offset:[-.022,.160,.714],fit:1.07,fov:42};
const prism={aim:[prismCenter[0]-.045,.250,prismCenter[2]-.052],offset:[.282,.640,.599],fit:1.13,fov:41};
const poses={bench:wide,halo,prism};
const mix=(a,b,t)=>a+(b-a)*t;
let engine,instrument,observer,frame,last=0;
let incidence=Number(range.value),ray=tracePrism(incidence),cameraView='bench',dirty=true,applied=false;
let pose=wide;

function resize(){
  const bounds=canvas.getBoundingClientRect();
  const width=Math.max(1,Math.round(bounds.width*1.5));
  const height=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function labels(){
  value.value=incidence.toFixed(1)+'°';
  range.setAttribute('aria-valuetext',incidence.toFixed(1)+' degrees');
  selected.value=ray.deviation.toFixed(1)+'°';
  rim.value=redRim.toFixed(1)+'°';
  if(document.body.dataset.state==='ready')minimum.disabled=incidence===optimum;
  view.setAttribute('aria-pressed',String(cameraView==='halo'));
  trace.setAttribute('aria-pressed',String(cameraView==='prism'));
}

function paint(now){
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const goal=poses[cameraView];
  const distance=Math.hypot(...pose.aim.map((v,i)=>v-goal.aim[i]),...pose.offset.map((v,i)=>v-goal.offset[i]));
  const portion=1-Math.exp(-delta*16);
  pose=motion.matches||distance<.002?goal:{
    aim:pose.aim.map((v,i)=>mix(v,goal.aim[i],portion)),
    offset:pose.offset.map((v,i)=>mix(v,goal.offset[i],portion)),
    fit:mix(pose.fit,goal.fit,portion),fov:mix(pose.fov,goal.fov,portion),
  };
  const fit=Math.max(1,pose.fit*canvas.height/canvas.width);
  engine.camera.target=pose.aim;
  engine.camera.position=pose.aim.map((axis,i)=>axis+pose.offset[i]*fit);
  engine.camera.fov=pose.fov;
  if(dirty){instrument.update(ray);dirty=false;}
  engine.render({delta});
  Object.assign(document.body.dataset,{
    incidence:incidence.toFixed(7),ray:ray.deviation.toFixed(7),rim:redRim.toFixed(7),
    entry:ray.entry.map((x)=>x.toFixed(7)).join(','),exit:ray.exit.map((x)=>x.toFixed(7)).join(','),
    view:pose===goal?cameraView:'moving',
  });
  if(applied){performance.mark('margo-incidence-applied');applied=false;}
  if(pose!==goal)schedule();
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
  instrument?.dispose();
  engine?.dispose();
}

function fail(error){
  document.body.dataset.state='error';
  for(const control of controls)control.disabled=true;
  loading.hidden=false;
  loading.textContent='The observatory could not open on this browser.';
  console.error(error);
  clean();
}

function change(next){
  incidence=next;
  range.value=next.toFixed(1);
  ray=tracePrism(next);
  dirty=true;
  applied=true;
  labels();
  schedule();
}
function chooseView(next){
  cameraView=cameraView===next?'bench':next;
  labels();
  schedule();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:352,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:43,near:.060,far:35},
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
  engine.scene.background='#7898bb';
  engine.lighting.direction.set([-.81,1.38,.68,3.4]);
  engine.lighting.radiance.set([.92,.97,1,.57]);
  engine.lighting.ambient.set([.87,.97,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.065,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-1.04,-.19,-.78],max:[1.02,.67,.71]},
  });
  instrument=createObservatory(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:instrument.meshes});
  paint(performance.now());
  await instrument.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  range.addEventListener('input',()=>change(Number(range.value)),options);
  minimum.addEventListener('click',()=>change(optimum),options);
  view.addEventListener('click',()=>chooseView('halo'),options);
  trace.addEventListener('click',()=>chooseView('prism'),options);
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

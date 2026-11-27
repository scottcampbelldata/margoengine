import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { sampleArray } from './optics.js';
import { createArray } from './model.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const input=document.querySelector('#aperture');
const value=document.querySelector('#aperture-value');
const outputs=['small','medium','large'].map((selector)=>document.getElementById(selector));
const holeSizes=[...document.querySelectorAll('.hole-size')];
const view=document.querySelector('#view');
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const controls=[input,view];
const wide={aim:[0,.105,-.016],position:[-.43,.92,1.34],fit:1.32,fov:41};
const detail={aim:[0,.288,-.185],position:[-.020,.451,1.09],fit:1.24,fov:42};
const mix=(a,b,t)=>a+(b-a)*t;
let engine,array,observer,frame,last=0,zoom=0;
let scale=Number(input.value),samples,close=false,dirty=true,applied=false;

function resize() {
  const bounds=canvas.getBoundingClientRect();
  const w=Math.max(1,Math.round(bounds.width*1.5));
  const h=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===w&&canvas.height===h) return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}

function labels() {
  value.value=scale+'%';
  input.setAttribute('aria-valuetext',scale+' percent');
  for(let i=0;i<outputs.length;i++) {
    outputs[i].value=(samples.profiles[i].diameter80*1000).toFixed(2)+' mm';
    holeSizes[i].textContent=samples.mm[i].toFixed(3)+' mm hole';
  }
  view.setAttribute('aria-pressed',String(close));
  view.textContent=close?'Whole array':'Inspect images';
}

function paint(now) {
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const goal=Number(close);
  zoom=motion.matches||Math.abs(zoom-goal)<.001?goal:mix(goal,zoom,Math.exp(-delta*15));
  const aspect=canvas.width/canvas.height;
  const fit=Math.max(1,mix(wide.fit,detail.fit,zoom)/aspect);
  engine.camera.target=wide.aim.map((axis,i)=>mix(axis,detail.aim[i],zoom));
  engine.camera.position=engine.camera.target.map((axis,i)=>axis+fit*mix(wide.position[i],detail.position[i],zoom));
  engine.camera.fov=mix(wide.fov,detail.fov,zoom);
  if(dirty) {
    samples=sampleArray(scale/100);
    array.update(scale,samples);
    labels();
    dirty=false;
  }
  engine.render({delta});
  Object.assign(document.body.dataset,{
    aperture:scale,diameters:samples.mm.map((mm)=>mm.toFixed(5)).join(','),
    blur:samples.profiles.map((part)=>part.diameter80.toFixed(9)).join(','),
    view:zoom===0?'array':zoom===1?'images':'moving',
  });
  if(applied) {performance.mark('margo-aperture-applied');applied=false;}
  if(zoom!==goal) schedule();
  else last=0;
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted) return;
  frame=requestAnimationFrame((now)=>{try{paint(now);}catch(error){fail(error);}});
}

function clean() {
  if(lifetime.signal.aborted) return;
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  array?.dispose();
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state='error';
  for(const control of controls) control.disabled=true;
  loading.hidden=false;
  loading.textContent='The pinhole array could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:384,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:41,near:.06,far:30},
  });
  if(!forced) {
    try {engine=await open();} catch(error) {if(error?.code!=='unsupported') throw error;}
  }
  const compatibility=!engine;
  if(compatibility) {
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#53635d';
  engine.lighting.direction.set([-.64,1.25,.70,3.5]);
  engine.lighting.radiance.set([1,.94,.81,.49]);
  engine.lighting.ambient.set([.87,.97,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.063,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.72,-.16,-.51],max:[.73,.48,.48]},
  });
  array=createArray(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:array.meshes});
  paint(performance.now());
  await array.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  input.addEventListener('input',()=>{
    scale=Number(input.value);
    dirty=true;
    applied=true;
    schedule();
  },options);
  view.addEventListener('click',()=>{close=!close; labels(); schedule();},options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  for(const control of controls) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

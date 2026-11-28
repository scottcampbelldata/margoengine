import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createLantern } from './model.js';
import { beamMeasure, facets, focalDistance, targetRadius, traceFacet } from './optics.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const range=document.querySelector('#distance');
const value=document.querySelector('#distance-value');
const angle=document.querySelector('#angle');
const shape=document.querySelector('#shape');
const focus=document.querySelector('#focus');
const view=document.querySelector('#view');
const controls=[range,focus,view];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={aim:[-.04,.144,.047],offset:[.90,1.04,1.55],fit:1.33,fov:41};
const detail={aim:[-.028,.221,0],offset:[.095,1.88,.315],fit:1.48,fov:40};
const mix=(a,b,t)=>a+(b-a)*t;
let engine,lantern,observer,frame,last=0,zoom=0;
let distance=Number(range.value)/1000;
let measure=beamMeasure(distance),top=false,dirty=true,applied=false;

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
  value.value=Math.round(distance*1000)+' mm';
  range.setAttribute('aria-valuetext',Math.round(distance*1000)+' millimeters');
  angle.value=measure.spread.toFixed(1)+'°';
  shape.value=measure.state;
  if(document.body.dataset.state==='ready')focus.disabled=distance===focalDistance;
  view.setAttribute('aria-pressed',String(top));
  view.textContent=top?'Whole lantern':'Look down on the beam';
}

function paint(now){
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const goal=Number(top);
  zoom=motion.matches||Math.abs(zoom-goal)<.001?goal:mix(goal,zoom,Math.exp(-delta*15));
  const fit=Math.max(1,mix(wide.fit,detail.fit,zoom)*canvas.height/canvas.width);
  engine.camera.target=wide.aim.map((axis,i)=>mix(axis,detail.aim[i],zoom));
  engine.camera.position=engine.camera.target.map((axis,i)=>axis+fit*mix(wide.offset[i],detail.offset[i],zoom));
  engine.camera.fov=mix(wide.fov,detail.fov,zoom);
  if(dirty){lantern.update(distance);dirty=false;}
  engine.render({delta});
  Object.assign(document.body.dataset,{
    distance:Math.round(distance*1000),angle:measure.spread.toFixed(7),shape:measure.state,
    footprint:targetRadius(traceFacet(distance,facets.length-1)).toFixed(7),
    view:zoom===0?'lantern':zoom===1?'beam':'moving',
  });
  if(applied){performance.mark('margo-lamp-applied');applied=false;}
  if(zoom!==goal)schedule();
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
  loading.textContent='The lantern could not open on this browser.';
  console.error(error);
  clean();
}

function change(next){
  distance=next;
  range.value=String(Math.round(next*1000));
  measure=beamMeasure(distance);
  dirty=true;
  applied=true;
  labels();
  schedule();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:448,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:41,near:.063,far:30},
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
  engine.scene.background='#5d5962';
  engine.lighting.direction.set([-.66,1.43,.78,3.74]);
  engine.lighting.radiance.set([1,.93,.81,.49]);
  engine.lighting.ambient.set([.84,.91,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.061,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.92,-.18,-.48],max:[.84,.76,.48]},
  });
  lantern=createLantern(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:lantern.meshes});
  paint(performance.now());
  await lantern.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  range.addEventListener('input',()=>change(Number(range.value)/1000),options);
  focus.addEventListener('click',()=>change(focalDistance),options);
  view.addEventListener('click',()=>{top=!top;labels();schedule();},options);
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

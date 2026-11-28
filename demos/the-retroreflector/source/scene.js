import { Engine } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { Shadows } from '@margoengine/shadows';
import { createRoad } from './model.js';
import { mirrorCenter, traceRetroreflector } from './optics.js';
import { lerp as mix } from '@margoengine/math/mathutils';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const range=document.querySelector('#azimuth');
const value=document.querySelector('#azimuth-value');
const route=document.querySelector('#route');
const offset=document.querySelector('#offset');
const view=document.querySelector('#view');
const controls=[range,view];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={aim:[0,.080,.044],offset:[1.05,1.31,1.96],fit:1.45,fov:45};
const detail={aim:[mirrorCenter[0],mirrorCenter[1],mirrorCenter[2]-.025],offset:[.065,.214,.475],fit:1.08,fov:40};
let engine,road,observer,frame,last=0,zoom=0;
let angle=Number(range.value),ray=traceRetroreflector(angle),close=false,dirty=true,applied=false;

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
  value.value=(angle<0?'−':angle>0?'+':'')+Math.abs(angle)+'°';
  range.setAttribute('aria-valuetext',angle<0?-angle+' degrees left':angle>0?angle+' degrees right':'zero degrees');
  route.value=ray.hits.map(({axis})=>axis+1).join(' → ');
  offset.value=(1000*ray.offset).toFixed(1)+' mm';
  view.setAttribute('aria-pressed',String(close));
  view.textContent=close?'Whole roadside':'Trace three reflections';
}

function paint(now){
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const goal=Number(close);
  zoom=motion.matches||Math.abs(zoom-goal)<.001?goal:mix(goal,zoom,Math.exp(-delta*16));
  const fit=Math.max(1,mix(wide.fit,detail.fit,zoom)*canvas.height/canvas.width);
  engine.camera.target=wide.aim.map((axis,i)=>mix(axis,detail.aim[i],zoom));
  engine.camera.position=engine.camera.target.map((axis,i)=>axis+fit*mix(wide.offset[i],detail.offset[i],zoom));
  engine.camera.fov=mix(wide.fov,detail.fov,zoom);
  if(dirty){road.update(angle,ray,close);dirty=false;}
  engine.render({delta});
  Object.assign(document.body.dataset,{
    angle,route:ray.hits.map(({axis})=>axis+1).join(','),
    offset:(1000*ray.offset).toFixed(6),view:zoom===0?'road':zoom===1?'reflections':'moving',
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
  loading.textContent='The roadside scene could not open on this browser.';
  console.error(error);
  clean();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:512,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:45,near:.057,far:30},
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
  engine.scene.background='#263744';
  engine.lighting.direction.set([-.77,.57,-.43,1.35]);
  engine.lighting.radiance.set([.60,.78,1,.26]);
  engine.lighting.ambient.set([.78,.87,1]);
  const clustered=Clustered.attach(engine,{grid:[12,8,16],maxLights:3});
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.086,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-1.25,-.22,-1.10],max:[1.25,.86,.79]},
  });
  road=createRoad(engine,shadows,clustered);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:road.meshes});
  paint(performance.now());
  await road.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  range.addEventListener('input',()=>{
    angle=Number(range.value);
    ray=traceRetroreflector(angle);
    dirty=true;
    applied=true;
    labels();
    schedule();
  },options);
  view.addEventListener('click',()=>{close=!close;dirty=true;labels();schedule();},options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  for(const control of controls)control.disabled=false;
  labels();
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

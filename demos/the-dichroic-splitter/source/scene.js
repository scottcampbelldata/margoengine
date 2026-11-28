import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createSplitter } from './model.js';
import { reflectionDirection, splitSpectrum } from './optics.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const angle=document.querySelector('#incidence');
const output=document.querySelector('#angle-output');
const reflection=document.querySelector('#reflection');
const transmission=document.querySelector('#transmission');
const view=document.querySelector('#view');
const controls=[angle,view];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={target:[.004,.111,.018],offset:[-.46,.94,1.46],fitAspect:1.17};
const overhead={target:[.017,.144,.045],offset:[-.047,1.66,.403],fitAspect:1.17};
const mix=(a,b,t)=>a+(b-a)*t;
let degrees=Number(angle.value),spectrum=splitSpectrum(degrees);
let engine,splitter,observer,frame,last=0;
let zoom=0,detail=false,dirty=true,pending=false;

function resize(){
  const bounds=canvas.getBoundingClientRect();
  const width=Math.max(1,Math.round(bounds.width*1.5));
  const height=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===width&&canvas.height===height)return false;
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  return true;
}

function readout(){
  const part=Math.round(spectrum.fraction*100);
  output.value=degrees+'°';
  angle.setAttribute('aria-valuetext',degrees+' degrees');
  reflection.value=part+'%';
  transmission.value=(100-part)+'%';
  view.setAttribute('aria-pressed',String(detail));
  view.textContent=detail?'Whole splitter':'Trace the paths';
}

function paint(now){
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const target=Number(detail);
  zoom=motion.matches||Math.abs(zoom-target)<.001?target:mix(target,zoom,Math.exp(-delta*15));
  const fit=Math.max(1,mix(wide.fitAspect,overhead.fitAspect,zoom)*canvas.height/canvas.width);
  const focus=wide.target.map((value,index)=>mix(value,overhead.target[index],zoom));
  engine.camera.target=focus;
  engine.camera.position=focus.map((value,index)=>value+fit*mix(wide.offset[index],overhead.offset[index],zoom));
  if(dirty){splitter.update(degrees,spectrum);dirty=false;}
  engine.render({delta});
  Object.assign(document.body.dataset,{
    incidence:degrees,reflected:spectrum.fraction.toFixed(7),
    direction:reflectionDirection(degrees).map((value)=>value.toFixed(7)).join(','),
    view:zoom===1?'paths':zoom===0?'bench':'moving',
  });
  if(pending){performance.mark('margo-incidence-applied');pending=false;}
  if(zoom!==target)schedule();
  else last=0;
}

function schedule(){
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{try{paint(now);}catch(error){fail(error);}});
}

function clean(){
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error){
  document.body.dataset.state='error';
  for(const control of controls)control.disabled=true;
  loading.hidden=false;
  loading.textContent='The splitter could not open on this browser.';
  console.error(error);
  clean();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:256,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:39,near:.110,far:30},
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
  engine.scene.background='#657984';
  engine.lighting.direction.set([-.84,1.40,.76,3.70]);
  engine.lighting.radiance.set([1,.93,.80,.44]);
  engine.lighting.ambient.set([.81,.94,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.056,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.82,-.22,-.88],max:[.91,.58,.88]},
  });
  splitter=createSplitter(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:splitter.meshes});
  paint(performance.now());
  await splitter.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  angle.addEventListener('input',()=>{
    degrees=Number(angle.value);
    spectrum=splitSpectrum(degrees);
    dirty=true;
    pending=true;
    readout();
    schedule();
  },options);
  view.addEventListener('click',()=>{detail=!detail;readout();schedule();},options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  readout();
  for(const control of controls)control.disabled=false;
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

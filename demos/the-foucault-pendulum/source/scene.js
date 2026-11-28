import { EngineKernel } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { pendulumPose, periodSeconds, precessionRate } from './model.js';
import { makeRotunda } from './rotunda.js';

const canvas=document.querySelector('#scene');
const loader=document.querySelector('#loading');
const latitude=document.querySelector('#latitude');
const hours=document.querySelector('#hours');
const latitudeLabel=document.querySelector('#latitude-label');
const hoursLabel=document.querySelector('#hours-label');
const angle=document.querySelector('#angle');
const rate=document.querySelector('#rate');
const play=document.querySelector('#play');
const view=document.querySelector('#view');
const places=Array.from(document.querySelectorAll('[data-latitude]'));
const controls=[latitude,hours,play,view,...places];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const lifetime=new AbortController();
const options={signal:lifetime.signal};
const exactSize=true;
const tau=Math.PI*2;
let engine, setPose, observer, frame, previous;
let phase=.89, elapsed=0, running=false, overhead=false, dirty=true;

function windowLight() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  for(let y=0;y<height;y++) {
    const elevation=Math.PI*(.5-(y+.5)/height);
    for(let x=0;x<width;x++) {
      const azimuth=tau*((x+.5)/width-.5);
      const high=Math.max(0,Math.sin(elevation));
      const key=4.6*Math.exp(-3.3*((azimuth+.57)/.70)**4-2.0*((elevation-.44)/.36)**4);
      const fill=1.7*Math.exp(-2.2*((azimuth-1.87)/.47)**4-2.8*((elevation-.32)/.27)**4);
      data.set([.15+.27*high+key+fill*.72,.16+.29*high+key*.84+fill*.85,.15+.34*high+key*.61+fill,1],(y*width+x)*4);
    }
  }
  return {width,height,data};
}

function fitCamera() {
  const density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(canvas.clientWidth*density)), height=Math.max(1,Math.round(canvas.clientHeight*density));
  if(canvas.width!==width) canvas.width=width;
  if(canvas.height!==height) canvas.height=height;
  const distance=1+.96*Math.max(0,1.09/(width/height)-1);
  if(overhead) {
    engine.camera.target=[0,0,0];
    engine.camera.position=[0,6.75*distance,.048];
  } else {
    engine.camera.target=[0,.48,0];
    engine.camera.position=[2.65*distance,.48+2.47*distance,4.66*distance];
  }
}

function display() {
  const value=Number(latitude.value), absoluteRate=precessionRate(value), rotation=absoluteRate*elapsed;
  const formatted=value===0?'0°':Math.abs(value).toFixed(1)+'° '+(value<0?'S':'N');
  const direction=degrees=>Math.abs(degrees)<.045?'0.0°':Math.abs(degrees).toFixed(1)+'° '+(degrees>0?'CW':'CCW');
  latitudeLabel.textContent=formatted;
  latitude.setAttribute('aria-valuetext',formatted);
  hoursLabel.textContent=elapsed.toFixed(1)+' h';
  hours.setAttribute('aria-valuetext',hoursLabel.textContent);
  angle.textContent=direction(rotation);
  rate.textContent=direction(absoluteRate);
  play.textContent=running?'Pause':elapsed>=24?'Start over':'Advance time';
  play.setAttribute('aria-pressed',String(running));
  for(const place of places) place.setAttribute('aria-pressed',String(Number(place.dataset.latitude)===value));
  document.body.dataset.latitude=String(value);
  document.body.dataset.hours=elapsed.toFixed(4);
  document.body.dataset.rotation=rotation.toFixed(7);
}

function schedule() {
  if(frame===undefined&&!lifetime.signal.aborted) frame=requestAnimationFrame(tick);
}

function draw(delta) {
  if(!reduced.matches) phase=(phase+delta*tau/periodSeconds)%tau;
  if(running) {
    elapsed=Math.min(24,elapsed+delta);
    hours.value=String(elapsed);
    if(elapsed>=24) running=false;
    dirty=true;
  }
  setPose(pendulumPose(Number(latitude.value),elapsed,phase),overhead);
  engine.render({delta});
  if(!dirty) return;
  dirty=false;
  display();
}

function tick(now) {
  frame=undefined;
  if(lifetime.signal.aborted) return;
  try {
    const delta=previous===undefined?0:Math.max(0,Math.min(.06,(now-previous)/1000));
    previous=now;
    draw(delta);
    if(running||!reduced.matches) schedule();
    else previous=undefined;
  } catch(error) { fail(error); }
}

function dispose() {
  lifetime.abort();
  if(frame!==undefined) cancelAnimationFrame(frame);
  observer?.disconnect();
  engine?.dispose();
}

function fail(error) {
  if(lifetime.signal.aborted) return;
  document.body.dataset.state='error';
  loader.hidden=false;
  loader.textContent='The rotunda could not open on this browser.';
  for(const control of controls) control.disabled=true;
  console.error(error);
  dispose();
}

async function open() {
  fitInitialSize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const create=()=>EngineKernel.create(canvas,{backend:'webgpu',exactSize,antialias:true,capacity:460,
    camera:{fov:39,near:.23,far:32},startupTimeout:8000,...options});
  if(!forced) {
    try{engine=await create();}
    catch(error){if(error?.code!=='unsupported') throw error;}
  }
  const native=Boolean(engine);
  if(!native) {
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,...options});
    engine=await create();
  }
  engine.onError=fail;
  engine.scene.background='#a9b3a5';
  engine.lighting.direction.set([.56,.80,.30,1.42]);
  engine.lighting.radiance.set([1,.94,.76,.36]);
  engine.lighting.ambient.set([.64,.69,.66]);
  const shadows=Shadows.attach(engine,{resolution:1024, filter:'soft',lightSize:.14,normalBias:.0018,
    bounds:{min:[-5.1,-.1,-5.1],max:[5.1,5.0,5.1]}});
  await EnvironmentLighting.load(engine,windowLight(),{size:32,specularSize:32,intensity:1.05,...options});
  setPose=makeRotunda(engine,shadows);
  fitCamera();
  draw(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  lifetime.signal.throwIfAborted();

  const changed=()=>{dirty=true;schedule();};
  latitude.addEventListener('input',changed,options);
  for(const place of places) place.addEventListener('click',()=>{latitude.value=place.dataset.latitude;changed();},options);
  hours.addEventListener('input',()=>{
    running=false;
    elapsed=Number(hours.value);
    changed();
  },options);
  play.addEventListener('click',()=>{
    if(!running&&elapsed>=24) elapsed=0;
    running=!running;
    changed();
  },options);
  view.addEventListener('click',()=>{
    overhead=!overhead;
    view.textContent=overhead?'Floor view':'Overhead';
    view.setAttribute('aria-pressed',String(overhead));
    fitCamera();
    schedule();
  },options);
  reduced.addEventListener('change',changed,options);
  observer=new ResizeObserver(()=>{fitCamera();schedule();});
  observer.observe(canvas);
  addEventListener('pagehide',event=>{if(!event.persisted) dispose();},options);
  for(const control of controls) control.disabled=false;
  document.body.dataset.renderer=native?'webgpu':'webgl2';
  document.body.dataset.state='ready';
  loader.hidden=true;
  performance.mark('margo-first-usable-frame');
  schedule();
}

function fitInitialSize() {
  const density=Math.min(devicePixelRatio,1.5);
  canvas.width=Math.max(1,Math.round(canvas.clientWidth*density));
  canvas.height=Math.max(1,Math.round(canvas.clientHeight*density));
}

open().catch(fail);

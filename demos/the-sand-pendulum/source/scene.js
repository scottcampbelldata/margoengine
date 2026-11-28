import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makePendulum } from './instrument.js';
import { duration, fallTime, fullLength, impact, nozzle, period, ratioChoices, shortLength } from './motion.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const release=document.querySelector('#release');
const view=document.querySelector('#view');
const patterns=[...document.querySelectorAll('[data-pattern]')];
const fast=document.querySelector('#fast');
const slow=document.querySelector('#slow');
const progress=document.querySelector('#progress');
const elapsed=document.querySelector('#elapsed');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const lifetime=new AbortController();
const controls=[release,view,...patterns];
const sampleInterval=1/80;
const totalFrames=Math.round(duration/sampleInterval);

let engine, model, frame, resize, before;
let selected=1, clock=0, emitted=0, resting=true, overhead=false, cameraBlend=0, marked=false;
let pending=[], laid=[];
let pendulum=nozzle(0,ratioChoices[selected]);

function studio() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const lights=[
    [-.69,.59,.52,.29,[6.05,5.12,4.12]],
    [1.18,.28,.39,.47,[2.85,4.16,4.62]],
    [-2.38,.48,.54,.18,[4.95,3.50,2.18]],
  ];
  for(let j=0;j<height;j++){
    const elevation=Math.PI*(.5-(j+.5)/height);
    for(let i=0;i<width;i++){
      const longitude=Math.PI*2*((i+.5)/width-.5);
      const base=.12+.12*Math.max(0,elevation);
      const rgb=[base*.90,base,base*1.12];
      for(const [bearing,tilt,wide,high,intensity] of lights){
        const x=Math.atan2(Math.sin(longitude-bearing),Math.cos(longitude-bearing));
        const g=Math.exp(-1.8*((x/wide)**4+((elevation-tilt)/high)**4));
        for(let k=0;k<3;k++)rgb[k]+=intensity[k]*g;
      }
      data.set([...rgb,1],(j*width+i)*4);
    }
  }
  return {width,height,data};
}

function size() {
  const bounds=canvas.getBoundingClientRect();
  const density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density));
  const height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function camera(blend) {
  const mix=(a,b)=>a+(b-a)*blend;
  const aspect=canvas.width/canvas.height;
  const fit=Math.max(1,mix(1.28,1.06)/aspect);
  const target=[.015,mix(.397,.089),.019];
  engine.camera.target=target;
  engine.camera.position=[
    target[0]+mix(.71,.37)*fit,
    target[1]+mix(.62,.93)*fit,
    target[2]+mix(1.48,.63)*fit,
  ];
}

function updateProgress(time) {
  progress.value=time;
  elapsed.textContent=time.toFixed(1)+' s';
}

function handoff() {
  for(const [index,button] of patterns.entries())button.setAttribute('aria-pressed',String(index===selected));
  fast.textContent=period(shortLength(ratioChoices[selected])).toFixed(2);
  slow.textContent=period(fullLength).toFixed(2);
  view.textContent=overhead?'Full instrument':'Tray view';
  view.setAttribute('aria-pressed',String(overhead));
}
function clear() {
  pending=[];
  laid=[];
  clock=0;
  emitted=0;
  pendulum=nozzle(0,ratioChoices[selected]);
  updateProgress(0);
}
function drop() {
  const ratio=ratioChoices[selected];
  while(emitted<totalFrames&&emitted*sampleInterval<=clock){
    const time=emitted*sampleInterval;
    const p=nozzle(time,ratio);
    const delay=fallTime(p);
    pending.push({t:time,p,delay});
    emitted++;
  }
  const live=[];
  for(const drop of pending){
    const age=clock-drop.t;
    if(age>=drop.delay)laid.push(impact(drop.t,ratio));
    else live.push(drop);
  }
  pending=live;
  return live.map((drop)=>({p:drop.p,age:clock-drop.t}));
}

function draw(now) {
  frame=undefined;
  const dt=before===undefined?1/60:Math.min(.078,(now-before)/1000);
  before=now;
  let grains=[];
  if(!resting){
    clock+=dt;
    pendulum=nozzle(Math.min(clock,duration),ratioChoices[selected]);
    grains=drop();
    updateProgress(Math.min(clock,duration));
    if(emitted===totalFrames&&!pending.length&&clock>=duration)resting=true;
  }
  const target=Number(overhead);
  cameraBlend=Math.abs(target-cameraBlend)<.0008||reduced.matches?target
    : cameraBlend+(target-cameraBlend)*(1-Math.exp(-dt*14));
  model.pose(pendulum,ratioChoices[selected],grains);
  model.deposits(laid);
  camera(cameraBlend);
  engine.render({delta:dt});
  document.body.dataset.pattern=String(selected);
  document.body.dataset.trace=String(laid.length);
  document.body.dataset.drawing=resting?'done':'drawing';
  document.body.dataset.view=cameraBlend===1?'tray':cameraBlend===0?'full':'moving';
  if(marked&&laid.length>=2){
    marked=false;
    performance.mark('margo-first-sand-drawn');
  }
  if(!resting||target!==cameraBlend)schedule();
  else before=undefined;
}

function schedule() {
  if(frame===undefined&&!lifetime.signal.aborted)frame=requestAnimationFrame((now)=>{
    try{draw(now);}catch(error){fail(error);}
  });
}
function dispose() {
  lifetime.abort();
  resize?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state='error';
  controls.forEach((control)=>{control.disabled=true;});
  loading.hidden=false;
  loading.textContent='The sand pendulum could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:170,
    signal:lifetime.signal,camera:{fov:36,near:.15,far:20},startupTimeout:9500,
  });
  size();
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#526b71';
  engine.lighting.direction.set([-.48,.80,.35,1.81]);
  engine.lighting.radiance.set([1,.94,.83,.42]);
  engine.lighting.ambient.set([.61,.73,.83]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',normalBias:.0010,lightSize:.11,
    bounds:{min:[-.53,-.10,-.41],max:[.53,.89,.53]},
  });
  await EnvironmentLighting.load(engine,studio(),{size:32,specularSize:32,intensity:1.02,signal:lifetime.signal});
  model=makePendulum(engine,shadows);
  // Show one complete drawing from this model before the first release.
  laid=Array.from({length:totalFrames},(_,index)=>impact(index*sampleInterval,ratioChoices[selected]));
  updateProgress(duration);
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;

  const options={signal:lifetime.signal};
  for(const [index,button] of patterns.entries())button.addEventListener('click',()=>{
    if(index===selected)return;
    selected=index;
    clear();
    resting=true;
    marked=false;
    handoff();
    schedule();
  },options);
  release.addEventListener('click',()=>{
    clear();
    resting=false;
    marked=true;
    schedule();
  },options);
  view.addEventListener('click',()=>{
    overhead=!overhead;
    handoff();
    schedule();
  },options);
  resize=new ResizeObserver(()=>{size();schedule();});
  resize.observe(canvas);
  handoff();
  controls.forEach((control)=>{control.disabled=false;});
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);

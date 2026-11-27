import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { dayMilliseconds, duration, start } from './orbits.js';
import { prepareOrrery } from './model.js';

const canvas=document.querySelector('#scene');
const days=document.querySelector('#days');
const date=document.querySelector('#date');
const play=document.querySelector('#play');
const plan=document.querySelector('#plan');
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const format=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const fov=32;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,move,observer,frame,fitDirty=true,previous=-1,playing=null,overhead=false;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const yaw=overhead?0:.24,pitch=overhead?Math.PI*.499:.76;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,overhead?.10:.04,overhead?0:.019];
  const slope=Math.tan(fov*Math.PI/360);
  let distance=0;
  for(let i=0;i<28;i++) {
    const angle=i*Math.PI/14;
    for(const [radius,y] of [[.499,-.015],[.495,.072],[.459,.227]]) {
      const p=[Math.cos(angle)*radius-target[0],y-target[1],Math.sin(angle)*radius-target[2]];
      const across=Math.abs(dot(right,p))/(slope*.90*width/height);
      const above=Math.abs(dot(up,p))/(slope*.87);
      distance=Math.max(distance,dot(eye,p)+Math.max(across,above));
    }
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function setPlaying(value) {
  playing=value;
  play.setAttribute('aria-pressed',String(Boolean(playing)));
  play.firstChild.textContent=playing?'Pause time':'Play time';
}

function update() {
  const value=Number(days.value);
  if(!fitDirty&&value===previous) return;
  if(fitDirty) fit();
  if(value!==previous) move(value);
  engine.render({delta:0});
  if(value!==previous) {
    const timestamp=start+value*dayMilliseconds;
    const text=format.format(timestamp);
    date.textContent=text;
    days.setAttribute('aria-valuetext',text);
    document.body.dataset.day=String(value);
  }
  document.body.dataset.view=overhead?'overhead':'exhibit';
  previous=value;
  fitDirty=false;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      const day=Math.min(duration,Math.round(playing.day+(now-playing.start)*.060));
      days.value=String(day);
      if(day===duration) setPlaying(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  days.addEventListener('input',()=>{ setPlaying(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(playing) setPlaying(null);
    else {
      if(Number(days.value)===duration) days.value='0';
      setPlaying({day:Number(days.value)});
    }
    schedule();
  },listen);
  plan.addEventListener('click',()=>{
    overhead=!overhead;
    plan.setAttribute('aria-pressed',String(overhead));
    plan.textContent=overhead?'Exhibit view':'Overhead view';
    fitDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlaying(null); },listen);
  observer=new ResizeObserver(()=>{ fitDirty=true; schedule(); });
  observer.observe(canvas);
}

function dispose() {
  stop.abort();
  observer?.disconnect();
  if(frame!==undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  dispose();
  for(const control of [days,plan,play]) control.disabled=true;
  loading.textContent='This browser could not open the orrery.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.10,far:55},
  };
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  async function create() {
    if(!force) {
      try { return [await EngineKernel.create(canvas,options),'webgpu']; }
      catch(error) { if(error?.code!=='unsupported'&&error?.code!=='timeout') throw error; }
    }
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true});
    return [await EngineKernel.create(canvas,options),'compatibility'];
  }

  const opening=create();
  const assemble=prepareOrrery();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#292128';
  engine.lighting.direction.set([-.46,.73,-.47,3.0]);
  engine.lighting.radiance.set([1,.90,.80,.26]);
  engine.lighting.ambient.set([.37,.43,.55]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.71,-.042,-.67],max:[.64,.29,.66]},
    normalBias:.0017,filter:'soft',lightSize:.029});
  move=assemble(engine,shadows);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [days,plan,play]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

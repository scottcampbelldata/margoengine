import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { limits, positionAt } from './mechanism.js';
import { prepareSarrus } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const degrees=document.querySelector('#degrees');
const height=document.querySelector('#height');
const drift=document.querySelector('#drift');
const view=document.querySelector('#view');
const cycle=document.querySelector('#cycle');
const loading=document.querySelector('#loading');
const controls=[angle,view,cycle];
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=36;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,observer,frame,playing;
let viewDirty=true,overhead=false,previous=-1;

function fit(pose) {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const w=Math.round(width*dpr),h=Math.round(height*dpr);
  if(canvas.width!==w) canvas.width=w;
  if(canvas.height!==h) canvas.height=h;
  const yaw=overhead?-.13:-.74,pitch=overhead?1.504:.36;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const y=pose.center[1];
  const target=overhead?[0,y+.32,0]:[-.128,1.05,.066];
  const points=overhead
    ?[-1.09,1.02].flatMap((x)=>[-.80,.81].map((z)=>[x,y+.36,z])).concat([[-.84,y+.82,-.66],[.84,y+.82,-.66]])
    :[
      ...[-1.24,1.05].flatMap((x)=>[-1.01,1.12].map((z)=>[x,.023,z])),
      [-1.59,.54,.16],[.49,.58,1.45],[-.83,2.60,-.64],[.82,2.60,-.63],[-.84,2.56,.48],
    ];
  const slope=Math.tan(fov*Math.PI/360);
  let distance=0;
  for(const point of points) {
    const v=point.map((x,i)=>x-target[i]);
    const horizontal=Math.abs(dot(right,v))/(slope*.92*width/height);
    const vertical=Math.abs(dot(up,v))/(slope*.90);
    distance=Math.max(distance,dot(eye,v)+Math.max(horizontal,vertical));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((x,i)=>x+eye[i]*distance);
}

function paint() {
  const value=Number(angle.value);
  const changed=previous!==value;
  if(!changed&&!viewDirty) return;
  const pose=positionAt(value);
  if(viewDirty||overhead) fit(pose);
  if(changed) model(pose);
  engine.render({delta:0});
  if(changed) {
    const label=Number.isInteger(value)?String(value):value.toFixed(1);
    degrees.textContent=label+'°';
    height.textContent=pose.height.toFixed(3)+' m';
    drift.textContent=(pose.offset*1000).toFixed(1)+' mm';
    angle.setAttribute('aria-valuetext',label+' degrees');
    document.body.dataset.angle=value.toFixed(1);
    document.body.dataset.height=pose.height.toFixed(8);
    previous=value;
  }
  if(viewDirty) document.body.dataset.view=overhead?'top':'field';
  viewDirty=false;
}

function setPlayback(value) {
  playing=value;
  cycle.textContent=playing?'Pause':'Raise and lower';
  document.body.dataset.playing=String(Boolean(playing));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      const progress=(now-playing.start)*.017;
      const rising=limits.max-playing.from;
      const value=progress<rising?playing.from+progress:Math.max(limits.min,limits.max-(progress-rising));
      angle.value=value.toFixed(1);
      if(value===limits.min) setPlayback(null);
    }
    paint();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ setPlayback(null); schedule(); },listen);
  cycle.addEventListener('click',()=>{
    if(playing) setPlayback(null);
    else setPlayback({from:Number(angle.value)});
    schedule();
  },listen);
  view.addEventListener('click',()=>{
    overhead=!overhead;
    view.setAttribute('aria-pressed',String(overhead));
    viewDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlayback(null); },listen);
  observer=new ResizeObserver(()=>{ viewDirty=true; schedule(); });
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
  for(const control of controls) control.disabled=true;
  loading.textContent='This browser could not open the platform.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.23,far:62}};
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  async function create() {
    if(!forced) {
      try { return [await EngineKernel.create(canvas,options),'webgpu']; }
      catch(error) { if(error?.code!=='unsupported'&&error?.code!=='timeout') throw error; }
    }
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true});
    return [await EngineKernel.create(canvas,options),'compatibility'];
  }
  const opening=create();
  const assemble=prepareSarrus();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#b6b0ab';
  engine.lighting.direction.set([-.41,.72,.58,2.3]);
  engine.lighting.radiance.set([1,.91,.76,.29]);
  engine.lighting.ambient.set([.53,.59,.69]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-2.00,-.15,-1.47],max:[1.91,2.76,1.53]},
    normalBias:.009,filter:'soft',lightSize:.046});
  model=assemble(engine,shadows);
  setPlayback(null);
  paint();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of controls) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.state='ready';
  document.body.dataset.renderer=renderer;
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { governorPose } from './mechanism.js';
import { prepareGovernor } from './model.js';

const canvas=document.querySelector('#scene');
const rpm=document.querySelector('#rpm');
const speed=document.querySelector('#speed');
const rise=document.querySelector('#rise');
const opening=document.querySelector('#opening');
const radius=document.querySelector('#radius');
const spin=document.querySelector('#spin');
const loading=document.querySelector('#loading');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=34;
const tau=Math.PI*2;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,observer,frame;
let yaw=.20,last=null,spinning=!reduced.matches,fitDirty=true,poseDirty=true;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const viewYaw=-.31,pitch=.285;
  const eye=[Math.sin(viewYaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(viewYaw)*Math.cos(pitch)];
  const right=[Math.cos(viewYaw),0,-Math.sin(viewYaw)];
  const up=[-Math.sin(viewYaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(viewYaw)*Math.sin(pitch)];
  const target=[0,.287,.037],slope=Math.tan(fov*Math.PI/360);
  const points=[
    ...[-.633,.633].flatMap((x)=>[-.277,.328].map((z)=>[x,-.061,z])),
    [-.476,.692,.063],[-.138,.758,0],[.156,.700,.077],
    [.45,.59,.32],[.557,.464,.24],[.31,.675,.26],[-.14,.674,.337],
  ];
  let distance=0;
  for(const p of points) {
    const v=p.map((value,i)=>value-target[i]);
    const horizontal=Math.abs(dot(right,v))/(slope*.91*width/height);
    const vertical=Math.abs(dot(up,v))/(slope*.886);
    distance=Math.max(distance,dot(eye,v)+Math.max(horizontal,vertical));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function readout(value,pose) {
  const pct=pose.opening*100;
  speed.textContent=value+' rpm';
  rpm.setAttribute('aria-valuetext',speed.textContent);
  rise.textContent=(pose.travel*1000).toFixed(1)+' mm';
  opening.textContent=Math.round(pct)+'%';
  radius.textContent=(pose.ballX*1000).toFixed(1)+' mm';
  document.body.dataset.rpm=String(value);
  document.body.dataset.travel=(pose.travel*1000).toFixed(5);
  document.body.dataset.valve=pct.toFixed(5);
}

function setSpin(value) {
  spinning=value;
  last=null;
  spin.textContent=value?'Hold rotation':'Resume rotation';
  document.body.dataset.spinning=String(value);
}

function update(now) {
  const value=Number(rpm.value);
  const dt=last===null?0:now-last;
  const rotate=spinning&&!document.hidden&&(last===null||dt>=1000/30-.65);
  if(!fitDirty&&!poseDirty&&!rotate) return;
  if(fitDirty) fit();
  if(rotate) {
    last=now;
    yaw=(yaw+Math.min(dt,72)*value*tau/60000)%tau;
  }
  // The held view exposes both links at any of the equilibrium positions.
  model.spin(spinning?yaw:.20);
  const pose=poseDirty?governorPose(value):null;
  if(pose) model.pose(pose);
  engine.render({delta:0});
  if(pose) readout(value,pose);
  document.body.dataset.rotation=yaw.toFixed(6);
  fitDirty=poseDirty=false;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try { update(now); }
  catch(error) { fail(error); return; }
  if(spinning&&!document.hidden) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  rpm.addEventListener('input',()=>{ poseDirty=true; schedule(); },listen);
  spin.addEventListener('click',()=>{
    setSpin(!spinning);
    yaw=.20;
    poseDirty=true;
    schedule();
  },listen);
  reduced.addEventListener('change',()=>{
    if(reduced.matches) {
      setSpin(false);
      yaw=.20;
      poseDirty=true;
      schedule();
    }
  },listen);
  document.addEventListener('visibilitychange',()=>{ last=null; if(!document.hidden) schedule(); },listen);
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
  rpm.disabled=spin.disabled=true;
  loading.textContent='This browser could not open the governor.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.10,far:72},
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
  const assemble=prepareGovernor();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#4b3d2f';
  engine.lighting.direction.set([-.39,.66,.63,2.85]);
  engine.lighting.radiance.set([1,.92,.81,.22]);
  engine.lighting.ambient.set([.40,.49,.57]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.77,-.07,-.57],max:[.77,.79,.63]},
    normalBias:.0021,filter:'soft',lightSize:.026});
  model=assemble(engine,shadows);
  setSpin(spinning);
  update(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  rpm.disabled=spin.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

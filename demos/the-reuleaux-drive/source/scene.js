import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { drivePose } from './kinematics.js';
import { prepareDrive } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const turn=document.querySelector('#turn');
const face=document.querySelector('#face');
const play=document.querySelector('#play');
const guides=document.querySelector('#guides');
const contacts=document.querySelector('#contacts');
const offsets=[document.querySelector('#offset-x'),document.querySelector('#offset-y')];
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,observer,frame,previous=-1,viewDirty=true,guidesDirty=true;
let faceOn=false,showGuides=true,playing=null;

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
  if(canvas.width!==pixelWidth) canvas.width=pixelWidth;
  if(canvas.height!==pixelHeight) canvas.height=pixelHeight;
  const yaw=faceOn?0:.306,pitch=faceOn?.021:.255;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.307,.048],slope=Math.tan(fov*Math.PI/360);
  const points=[
    ...[-.435,.435].flatMap((x)=>[-.245,.344].map((z)=>[x,-.066,z])),
    ...[-.313,.313].flatMap((x)=>[.085,.693].map((y)=>[x,y,.111])),
  ];
  let distance=0;
  for(const p of points) {
    const v=p.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,v))/(slope*.92*width/height);
    const above=Math.abs(dot(up,v))/(slope*.86);
    distance=Math.max(distance,dot(eye,v)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function signed(shift) {
  const mm=Math.round(shift*10000)/10;
  return (mm<0?'−':mm>0?'+':'')+Math.abs(mm).toFixed(1)+' mm';
}

function update() {
  const value=Number(angle.value);
  if(!viewDirty&&!guidesDirty&&value===previous) return;
  if(viewDirty) fit();
  const pose=value===previous?null:drivePose(value);
  if(pose) model.pose(pose);
  if(guidesDirty) model.show(showGuides);
  engine.render({delta:0});
  if(pose) {
    turn.textContent=value+'°';
    angle.setAttribute('aria-valuetext',value+' degrees');
    contacts.textContent=pose.contacts.length+' of 4';
    pose.center.forEach((value,i)=>{ offsets[i].textContent=signed(value); });
    document.body.dataset.angle=String(value);
    document.body.dataset.center=pose.center.map((value)=>value.toFixed(7)).join(',');
    document.body.dataset.contacts=String(pose.contacts.length);
  }
  if(viewDirty) document.body.dataset.view=faceOn?'face':'exhibit';
  if(guidesDirty) document.body.dataset.guides=String(showGuides);
  viewDirty=guidesDirty=false;
  previous=value;
}

function setPlay(value) {
  playing=value;
  play.firstChild.textContent=value?'Pause turn':'Play a turn';
  document.body.dataset.running=String(Boolean(value));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      angle.value=String(Math.min(360,Math.floor(playing.angle+(now-playing.start)*.081)));
      if(angle.value==='360') setPlay(null);
    }
    update();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ setPlay(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(playing) setPlay(null);
    else {
      if(angle.value==='360') angle.value='0';
      setPlay({angle:Number(angle.value)});
    }
    schedule();
  },listen);
  face.addEventListener('click',()=>{
    faceOn=!faceOn;
    face.textContent=faceOn?'Exhibit view':'Face-on view';
    viewDirty=true;
    schedule();
  },listen);
  guides.addEventListener('click',()=>{
    showGuides=!showGuides;
    guides.setAttribute('aria-pressed',String(showGuides));
    guidesDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlay(null); },listen);
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
  for(const control of [angle,face,play,guides]) control.disabled=true;
  loading.textContent='This browser could not open the Reuleaux drive.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.10,far:66},
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
  const assemble=prepareDrive();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#615766';
  engine.lighting.direction.set([-.44,.67,.61,2.70]);
  engine.lighting.radiance.set([1,.925,.86,.23]);
  engine.lighting.ambient.set([.43,.53,.62]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.63,-.065,-.50],max:[.65,.72,.58]},
    normalBias:.0019,filter:'soft',lightSize:.026});
  model=assemble(engine,shadows);
  setPlay(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of [angle,face,play,guides]) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

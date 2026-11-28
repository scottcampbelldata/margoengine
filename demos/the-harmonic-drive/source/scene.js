import { startEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';
import { describeCheck, signedReading } from '@margoengine/machinery/rigs';
import { openDrive, tau } from './mechanism.js';
import { prepareHarmonicDrive } from './model.js';

const canvas=document.querySelector('#scene');
const turns=document.querySelector('#turns');
const input=document.querySelector('#input');
const output=document.querySelector('#output');
const view=document.querySelector('#view');
const step=document.querySelector('#step');
const run=document.querySelector('#run');
const loading=document.querySelector('#loading');
const gap=document.querySelector('#check');
const controls=[turns,view,step,run];
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,mechanism,observer,frame,playing;
let viewDirty=true,frontView=false,previous=-1;

function fit() {
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const w=Math.round(width*dpr),h=Math.round(height*dpr);
  if(canvas.width!==w) canvas.width=w;
  if(canvas.height!==h) canvas.height=h;
  const yaw=frontView?.045:.645,pitch=frontView?.045:.31;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const cameraRight=[Math.cos(yaw),0,-Math.sin(yaw)];
  const cameraUp=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=frontView?[-.014,.351,.027]:[.004,.240,-.072];
  const points=frontView
    ?[-.294,.266].flatMap((x)=>[.072,.629].map((y)=>[x,y,.110]))
    :[
      ...[-.444,.449].flatMap((x)=>[-.380,.241].map((z)=>[x,.023,z])),
      [-.016,.641,.114],[-.304,.350,.097],[.278,.367,.116],[.257,.441,-.159],
    ];
  const slope=Math.tan(fov*Math.PI/360);
  let distance=0;
  for(const point of points) {
    const v=point.map((x,i)=>x-target[i]);
    const horizontal=Math.abs(dot(cameraRight,v))/(slope*.92*width/height);
    const vertical=Math.abs(dot(cameraUp,v))/(slope*(frontView?.82:.92));
    distance=Math.max(distance,dot(eye,v)+Math.max(horizontal,vertical));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((x,i)=>x+eye[i]*distance);
}

function commitFrame() {
  const value=Number(turns.value);
  const updated=value!==previous;
  if(!viewDirty&&!updated) return;
  if(viewDirty) fit();
  const pose=updated?mechanism.drive(value*tau,false):null;
  if(updated) model(pose);
  engine.render({delta:0});
  if(updated) {
    const unit=value===1?' turn':' turns';
    input.textContent=value.toFixed(2)+unit;
    output.textContent=signedReading(pose.output*180/Math.PI,'°',2);
    document.body.dataset.check=gap.textContent=describeCheck(mechanism.check);
    turns.setAttribute('aria-valuetext',input.textContent+' of 30');
    step.disabled=value>=30||document.body.dataset.state!=='ready';
    document.body.dataset.turns=value.toFixed(2);
    previous=value;
  }
  if(viewDirty) document.body.dataset.view=frontView?'front':'cutaway';
  viewDirty=false;
}

function setPlaying(value) {
  playing=value;
  run.textContent=playing?'Pause':'Run';
  document.body.dataset.playing=String(Boolean(playing));
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(playing) {
      playing.start??=now;
      turns.value=Math.min(30,playing.from+(now-playing.start)*.00058).toFixed(2);
      if(Number(turns.value)===30) setPlaying(null);
    }
    commitFrame();
  } catch(error) { fail(error); return; }
  if(playing) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  turns.addEventListener('input',()=>{ setPlaying(null); schedule(); },listen);
  step.addEventListener('click',()=>{
    setPlaying(null);
    turns.value=Math.min(30,Number(turns.value)+1).toFixed(2);
    schedule();
  },listen);
  run.addEventListener('click',()=>{
    if(playing) setPlaying(null);
    else {
      if(Number(turns.value)===30) turns.value='0';
      setPlaying({from:Number(turns.value)});
    }
    schedule();
  },listen);
  view.addEventListener('click',()=>{
    frontView=!frontView;
    view.setAttribute('aria-pressed',String(frontView));
    viewDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPlaying(null); },listen);
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
  loading.textContent='This browser could not open the cutaway.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const opening=startEngine(canvas,{exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.13,far:44},forceCompat:location.search.includes('backend=webgl2'),
    loadCompat:()=>import('@margoengine/webgl2-compat')});
  const assemble=prepareHarmonicDrive();
  const solving=openDrive(Number(turns.value),stop.signal);
  const {engine:device,renderer}=await opening;
  mechanism=await solving;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#45515b';
  engine.lighting.direction.set([-.42,.74,.57,2.8]);
  engine.lighting.radiance.set([1,.96,.88,.31]);
  engine.lighting.ambient.set([.48,.55,.65]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.54,-.015,-.47],max:[.56,.68,.31]},
    normalBias:.0019,filter:'soft',lightSize:.028});
  model=assemble(engine,shadows);
  setPlaying(null);
  commitFrame();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  for(const control of controls) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

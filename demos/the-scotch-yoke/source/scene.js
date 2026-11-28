import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { yokePose } from './mechanism.js';
import { prepareYoke } from './model.js';

const canvas=document.querySelector('#scene');
const angle=document.querySelector('#angle');
const degrees=document.querySelector('#degrees');
const piston=document.querySelector('#piston');
const roller=document.querySelector('#roller');
const front=document.querySelector('#front');
const play=document.querySelector('#play');
const loading=document.querySelector('#loading');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine,model,observer,frame,viewDirty=true,prior=-1,frontView=false,running=null;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const yaw=frontView?0:.302,pitch=frontView?.012:.367;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,frontView?.241:.225,.111],slope=Math.tan(fov*Math.PI/360);
  const limits=[
    ...[-.825,.825].flatMap((x)=>[-.229,.374].map((z)=>[x,-.054,z])),
    [-.388,.532,.099],[.20,.531,.114],[.712,.441,.255],[-.853,.351,.186],[.78,.351,.173],
  ];
  let distance=0;
  for(const p of limits) {
    const ray=p.map((value,i)=>value-target[i]);
    const vertical=Math.abs(dot(up,ray))/(slope*.86);
    const horizontal=Math.abs(dot(right,ray))/(slope*.94*width/height);
    distance=Math.max(distance,dot(eye,ray)+Math.max(vertical,horizontal));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function formattedLength(value) {
  const mm=Math.round(value*10000)/10;
  if(mm===0) return '0.0 mm';
  return (mm<0?'−':'+')+Math.abs(mm).toFixed(1)+' mm';
}

function show(value,pose) {
  degrees.textContent=value+'°';
  angle.setAttribute('aria-valuetext',value+' degrees');
  piston.textContent=formattedLength(pose.x);
  roller.textContent=formattedLength(pose.y);
  document.body.dataset.angle=String(value);
  document.body.dataset.offset=(pose.x*1000).toFixed(6);
  document.body.dataset.height=(pose.y*1000).toFixed(6);
}

function setRun(value) {
  running=value;
  play.firstChild.textContent=value?'Pause crank':'Run crank';
  document.body.dataset.running=String(Boolean(value));
}

function update() {
  const value=Number(angle.value);
  if(!viewDirty&&value===prior) return;
  if(viewDirty) fit();
  const pose=yokePose(value);
  if(value!==prior) model(pose);
  engine.render({delta:0});
  if(value!==prior) show(value,pose);
  if(viewDirty) document.body.dataset.view=frontView?'front':'exhibit';
  viewDirty=false;
  prior=value;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  try {
    if(running) {
      running.time??=now;
      angle.value=String(Math.floor(running.value+(now-running.time)*.12)%360);
    }
    update();
  } catch(error) { fail(error); return; }
  if(running) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  angle.addEventListener('input',()=>{ setRun(null); schedule(); },listen);
  play.addEventListener('click',()=>{
    if(running) setRun(null);
    else setRun({value:Number(angle.value)});
    schedule();
  },listen);
  front.addEventListener('click',()=>{
    frontView=!frontView;
    front.textContent=frontView?'Exhibit view':'Front view';
    viewDirty=true;
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setRun(null); },listen);
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
  angle.disabled=front.disabled=play.disabled=true;
  loading.textContent='This browser could not open the Scotch yoke.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.12,far:66},
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
  const assemble=prepareYoke();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#4e575f';
  engine.lighting.direction.set([-.37,.77,.50,2.6]);
  engine.lighting.radiance.set([1,.925,.852,.24]);
  engine.lighting.ambient.set([.37,.47,.56]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.94,-.067,-.501],max:[.96,.65,.69]},
    normalBias:.0023,filter:'soft',lightSize:.026});
  model=assemble(engine,shadows);
  setRun(null);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  angle.disabled=front.disabled=play.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

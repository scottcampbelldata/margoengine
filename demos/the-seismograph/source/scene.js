import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { groundStroke, naturalHz, recorder, transfer } from './motion.js';
import { prepareInstrument } from './model.js';

const canvas=document.querySelector('#scene');
const frequency=document.querySelector('#frequency');
const hz=document.querySelector('#hz');
const stroke=document.querySelector('#stroke');
const run=document.querySelector('#run');
const note=document.querySelector('#note');
const loading=document.querySelector('#loading');
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const stop=new AbortController();
const listen={signal:stop.signal};
const fov=33;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

let engine,model,observer,frame;
let running=!reducedMotion.matches,dirty=true,fitDirty=true;
let previous=Number(frequency.value),simulation=recorder(previous),time=0,last=null;

function fit() {
  const width=Math.max(1,canvas.clientWidth);
  const height=Math.max(1,canvas.clientHeight);
  const dpr=Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixels=[Math.round(width*dpr),Math.round(height*dpr)];
  if(canvas.width!==pixels[0]) canvas.width=pixels[0];
  if(canvas.height!==pixels[1]) canvas.height=pixels[1];

  const yaw=-.27,pitch=.37;
  const eye=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target=[0,.223,.093],slope=Math.tan(fov*Math.PI/360);
  const vertices=[
    ...[-.637,.637].flatMap((x)=>[-.255,.275].map((z)=>[x,-.115,z])),
    [-.573,.445,.215],[-.548,.412,.218],[.556,.593,.179],
    [.375,.645,.149],[.367,.648,.080],[.62,.075,.26],[-.622,.064,.26],
  ];
  let distance=0;
  for(const vertex of vertices) {
    const p=vertex.map((value,i)=>value-target[i]);
    const across=Math.abs(dot(right,p))/(slope*.926*width/height);
    const above=Math.abs(dot(up,p))/(slope*.90);
    distance=Math.max(distance,dot(eye,p)+Math.max(across,above));
  }
  engine.camera.target=target;
  engine.camera.position=target.map((value,i)=>value+eye[i]*distance);
}

function setRun(value) {
  running=value;
  last=null;
  run.textContent=value?'Pause recording':'Start recording';
}

function readout(value) {
  const amplitude=groundStroke*transfer(value).gain*1000;
  hz.textContent=value.toFixed(2)+' Hz';
  frequency.setAttribute('aria-valuetext',hz.textContent);
  stroke.textContent=amplitude.toFixed(1)+' mm';
  if(value<naturalHz-.25) note.textContent='The spring carries the mass along at low frequencies. The pen moves very little.';
  else if(value>naturalHz+.27) note.textContent='At high frequencies the frame moves around the mass. The pen travel approaches the ground motion.';
  else note.textContent='Near 1.20 Hz, resonance makes the pen move farther than the ground.';
  document.body.dataset.frequency=value.toFixed(2);
  document.body.dataset.amplitude=amplitude.toFixed(5);
}

function update() {
  if(fitDirty) fit();
  model(simulation,time);
  engine.render({delta:0});
  if(document.body.dataset.frequency!==previous.toFixed(2)) readout(previous);
  document.body.dataset.recordTime=time.toFixed(4);
  document.body.dataset.running=String(running);
  dirty=fitDirty=false;
}

function tick(now) {
  frame=undefined;
  if(stop.signal.aborted) return;
  const elapsed=last===null?0:now-last;
  if(dirty||fitDirty||(running&&!document.hidden&&(last===null||elapsed>=1000/30-.65))) {
    if(running&&!document.hidden) {
      time+=Math.min(.095,elapsed*.001);
      last=now;
    }
    try { update(); }
    catch(error) { fail(error); return; }
  }
  if(running&&!document.hidden) schedule();
}

function schedule() { frame??=requestAnimationFrame(tick); }

function connect() {
  frequency.addEventListener('input',()=>{
    const value=Number(frequency.value);
    if(value===previous) return;
    previous=value;
    if(running) simulation.frequency(value,time);
    else { simulation=recorder(value); time=0; }
    dirty=true;
    schedule();
  },listen);
  run.addEventListener('click',()=>{
    setRun(!running);
    dirty=true;
    schedule();
  },listen);
  reducedMotion.addEventListener('change',()=>{
    if(reducedMotion.matches) { setRun(false); dirty=true; schedule(); }
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
  frequency.disabled=run.disabled=true;
  loading.textContent='This browser could not open the seismograph.';
  loading.hidden=false;
  document.body.dataset.state='error';
  console.error(error);
}

async function open() {
  const options={
    backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.12,far:65},
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
  const assemble=prepareInstrument();
  const [device,renderer]=await opening;
  engine=device;
  engine.onError=fail;
  engine.scene.background='#383b33';
  engine.lighting.direction.set([-.48,.73,.50,2.65]);
  engine.lighting.radiance.set([1,.91,.78,.23]);
  engine.lighting.ambient.set([.42,.51,.56]);
  const shadows=Shadows.attach(engine,{resolution:1024,bounds:{min:[-.78,-.145,-.62],max:[.80,.69,.67]},
    normalBias:.0022,filter:'soft',lightSize:.028});
  model=assemble(engine,shadows);
  setRun(running);
  update();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  frequency.disabled=run.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

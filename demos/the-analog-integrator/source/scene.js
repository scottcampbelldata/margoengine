import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createIntegrator, diskTurnsPerSecond, transmission } from './kinematics.js';
import { prepareIntegrator } from './model.js';

const canvas = document.querySelector('#scene');
const slider = document.querySelector('#radius');
const position = document.querySelector('#position');
const total = document.querySelector('#total');
const speed = document.querySelector('#speed');
const direction = document.querySelector('#direction');
const motor = document.querySelector('#motor');
const zero = document.querySelector('#zero');
const loading = document.querySelector('#loading');
const controls = [slider,motor,zero];
const stop = new AbortController();
const listen = {signal:stop.signal};
const fov = 32;
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine, model, integrator, observer, frame;
let preferredRun = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let viewDirty = true, readingsDirty = true;

function fitCamera() {
  const width = Math.max(1,canvas.clientWidth), height = Math.max(1,canvas.clientHeight);
  const pixelRatio = Math.min(1.5,Math.max(1.25,devicePixelRatio));
  const pixelWidth=Math.round(width*pixelRatio), pixelHeight=Math.round(height*pixelRatio);
  if(canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if(canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const yaw = .675, pitch = .565;
  const eye = [Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right = [Math.cos(yaw),0,-Math.sin(yaw)];
  const up = [-Math.sin(yaw)*Math.sin(pitch),Math.cos(pitch),-Math.cos(yaw)*Math.sin(pitch)];
  const target = [.007,.116,.004];
  const slope = Math.tan(fov*Math.PI/360);
  const points = [
    ...[-.621,.625].flatMap((x)=>[-.32,.37].map((z)=>[x,.028,z])),
    [-.54,.38,-.133],[.3,.39,-.179],[.456,.481,.026],[.456,.329,.176],[-.382,.29,.229],
  ];
  let distance = 0;
  for(const point of points) {
    const v = point.map((value,i)=>value-target[i]);
    const horizontal = Math.abs(dot(right,v))/(slope*.92*width/height);
    const vertical = Math.abs(dot(up,v))/(slope*.92);
    distance = Math.max(distance,dot(eye,v)+Math.max(horizontal,vertical));
  }
  engine.camera.target = target;
  engine.camera.position = target.map((value,i)=>value+eye[i]*distance);
  viewDirty = false;
}

function signed(value,decimals) {
  const magnitude = Math.abs(value).toFixed(decimals);
  return (Number(magnitude)===0?'':value<0?'−':'+')+magnitude;
}

function render() {
  if(viewDirty) fitCamera();
  model(integrator.state);
  engine.render({delta:0});
  if(readingsDirty) {
    readings();
    readingsDirty = false;
  }
  const formatted = signed(integrator.state.outputTurns,2);
  if(total.textContent!==formatted) total.textContent=formatted;
}

function tick(now) {
  frame = undefined;
  if(stop.signal.aborted) return;
  try {
    integrator.advance(now);
    render();
  } catch(error) { fail(error); return; }
  if(integrator.state.running) schedule();
}

function schedule() { frame ??= requestAnimationFrame(tick); }

function readings() {
  const mm = Number(slider.value);
  const moving = integrator.state.running;
  const rate = moving ? diskTurnsPerSecond * transmission(integrator.state.radius) : 0;
  const state = !moving?'Paused':mm===0?'Stopped at center':mm>0?'Forward':'Reverse';
  position.textContent = signed(mm,0)+' mm';
  slider.setAttribute('aria-valuetext',mm===0?'Center, 0 millimeters':Math.abs(mm)+' millimeters '+(mm<0?'left':'right')+' of center');
  speed.textContent = signed(rate,2)+' turns/s';
  direction.textContent = state;
  motor.textContent = preferredRun?'Pause disk':'Run disk';
  document.body.dataset.direction = state;
  document.body.dataset.radius = String(mm);
}

function connect() {
  slider.addEventListener('input',()=>{
    integrator.setRadius(performance.now(),Number(slider.value)/1000);
    readingsDirty = true;
    schedule();
  },listen);
  motor.addEventListener('click',()=>{
    preferredRun = !preferredRun;
    integrator.setRunning(performance.now(),preferredRun&&!document.hidden);
    readingsDirty = true;
    schedule();
  },listen);
  zero.addEventListener('click',()=>{
    integrator.resetOutput(performance.now());
    schedule();
  },listen);
  document.addEventListener('visibilitychange',()=>{
    integrator.setRunning(performance.now(),preferredRun&&!document.hidden);
    readingsDirty = true;
    if(!document.hidden) schedule();
  },listen);
  observer = new ResizeObserver(()=>{ viewDirty=true; schedule(); });
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
  for(const control of controls) control.disabled = true;
  loading.textContent = 'This browser could not open the integrator.';
  loading.hidden = false;
  document.body.dataset.state = 'error';
  console.error(error);
}

async function open() {
  const options = {backend:'webgpu',exactSize:true,antialias:true,signal:stop.signal,
    startupTimeout:5000,camera:{fov,near:.12,far:36}};
  const force = new URLSearchParams(location.search).get('backend')==='webgl2';
  async function create() {
    if(!force) {
      try { return [await EngineKernel.create(canvas,options),'webgpu']; }
      catch(error) { if(error?.code!=='unsupported'&&error?.code!=='timeout') throw error; }
    }
    const {install} = await import('@margoengine/webgl2-compat');
    await install({force:true});
    return [await EngineKernel.create(canvas,options),'compatibility'];
  }
  const opening = create();
  const assemble = prepareIntegrator();
  const [device,renderer] = await opening;
  engine = device;
  engine.onError = fail;
  engine.scene.background = '#2c3e43';
  engine.lighting.direction.set([-.36,.77,.54,2.7]);
  engine.lighting.radiance.set([1,.96,.88,.27]);
  engine.lighting.ambient.set([.48,.55,.64]);
  const shadows = Shadows.attach(engine,{resolution:1024,bounds:{min:[-.71,-.013,-.44],max:[.72,.52,.49]},
    normalBias:.0019,filter:'soft',lightSize:.029});
  model = assemble(engine,shadows);
  integrator = createIntegrator(performance.now(),Number(slider.value)/1000,false);
  render();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(stop.signal.aborted) return;
  connect();
  integrator.setRunning(performance.now(),preferredRun&&!document.hidden);
  readingsDirty = true;
  for(const control of controls) control.disabled = false;
  loading.hidden=true;
  document.body.dataset.renderer=renderer;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}

addEventListener('pagehide',(event)=>{ if(!event.persisted) dispose(); });
open().catch((error)=>{ if(!stop.signal.aborted) fail(error); });

import { margoError } from '@margoengine/core/extension';
import { applyQualityTier } from '@margoengine/quality';
import { MarshSky } from './sky-backdrop.js';
import { GPUFlock } from '@margoengine/vfx/flocking';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { flightOptions, flightInfluences, openingFormation, seed, starling } from './birds.js';
import { buildMarsh } from './marsh.js';

let canvas = document.querySelector('#view');
const overlay = document.querySelector('#status');
const help = document.querySelector('#help');
let notice = demoStatus(canvas,overlay,document.querySelector('#error-reason'));
const disturb = document.querySelector('#disturb');
const pause = document.querySelector('#pause');
const reset = document.querySelector('#reset');
const marker = document.querySelector('#disturbance');
const buttons = [disturb,pause,reset];
const controller = new AbortController();
const {signal} = controller;
const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
const sunDirection = [-.28,.045,-.958];
const eyeHeight=2.9, viewHeight=4.6;
const distance = 59;
const predatorRadius = 9.5;
applyQualityTier();

let engine, flock, observer, frame;
let lastTime, active = 0, pending = false, paused = false, pointerId;
let predator, inputNumber = 0, markedNumber = 0;
let worker, workerBusy = false, workerReady = false, workerFrame, generation = 0;
let viewportWidth = 0, viewportHeight = 0;
let lastEntry = '';
function error(cause) {
  if (signal.aborted || notice.failed) return;
  notice.error(cause);
  overlay.hidden = false;
  overlay.querySelector('strong').textContent = 'The flock could not be opened.';
  help.hidden = false;
  for (const button of buttons) button.disabled = true;
  if(frame !== undefined) cancelAnimationFrame(frame);
}

function readySize() {
  viewportWidth = canvas.clientWidth;
  viewportHeight = canvas.clientHeight;
  const dpr = Math.max(1,Math.min(1.4,devicePixelRatio));
  const width = Math.max(1,Math.round(viewportWidth*dpr));
  const height = Math.max(1,Math.round(viewportHeight*dpr));
  if(canvas.width !== width) canvas.width = width;
  if(canvas.height !== height) canvas.height = height;
  engine.camera.fov = 2 * Math.atan(Math.max(.39,.515*height/width)) * 180 / Math.PI;
}

function unsetDisturbance() {
  predator = undefined;
  marker.hidden = true;
  if (!worker) flock.setPredators([]);
}

function begin(x,y) {
  if (!flock || notice.failed) return;
  const tangent = Math.tan(engine.camera.fov * Math.PI / 360);
  const length = Math.hypot(distance,viewHeight-eyeHeight);
  const tilt = (viewHeight-eyeHeight)/length, forward = distance/length;
  const horizontal = (2*x/viewportWidth-1) * tangent * viewportWidth/viewportHeight;
  const vertical = (1-2*y/viewportHeight) * tangent;
  const depth = distance / (forward - tilt * vertical);
  const position = [horizontal*depth,eyeHeight+(tilt+forward*vertical)*depth,0];
  const influence={position,radius:predatorRadius,strength:36};
  predator = {influence,expiry:performance.now()+1050};
  if (!worker) flock.setPredators([influence]);
  inputNumber++;
  marker.style.left = x+'px';
  marker.style.top = y+'px';
  marker.hidden = false;
  if (paused) togglePause();
}

function eventPosition(event) {
  const rect = canvas.getBoundingClientRect();
  begin(event.clientX-rect.left,event.clientY-rect.top);
}

function schedule() {
  if(frame===undefined && !notice.failed) frame=requestAnimationFrame(tick);
}

function readout() {
  const stats = flock.stats;
  const entry = [stats.steps,predator?'true':'false',paused,markedNumber].join(';');
  if (entry===lastEntry) return;
  lastEntry=entry;
  Object.assign(canvas.dataset,{steps:stats.steps,disturbing:String(!!predator),paused:String(paused),input:markedNumber});
}

function tick(now) {
  frame = undefined;
  if(signal.aborted || document.hidden || notice.failed) return;
  if(pending) { schedule(); return; }
  if (predator && markedNumber===inputNumber && now >= predator.expiry) unsetDisturbance();
  if(worker && !paused && workerReady && !workerBusy) {
    const seconds=.046;
    active+=seconds;
    workerBusy=true;
    worker.postMessage({generation,record:predator?inputNumber:0,delta:seconds,time:active,predator:predator?.influence});
  }
  const delta = paused ? 0 : Math.min(.046,Math.max(0,lastTime===undefined?1/60:(now-lastTime)/1000));
  lastTime = now;
  let record = 0;
  if(worker) {
    if(workerFrame && !paused) {
      flock.restore(workerFrame);
      record=workerFrame.record;
      workerFrame=undefined;
    }
  } else if(delta>0) {
    active += delta;
    flock.setAttractors(flightInfluences(active));
    record=predator?inputNumber:0;
  }
  try {
    engine.render({delta});
    readout();
    pending=true;
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      pending=false;
      if(signal.aborted)return;
      if(record>markedNumber) {
        markedNumber=record;
        if(!performance.getEntriesByName('murmuration-first-disturbance').length) performance.mark('murmuration-first-disturbance');
        readout();
      }
      if(!paused && (!worker || workerFrame))schedule();
    }).catch(error);
  } catch(cause) {
    error(cause);
    return;
  }
  if(!paused && !worker)schedule();
}

function startWorker() {
  worker=new Worker(new URL('./flight-worker.js',import.meta.url),{type:'module'});
  worker.addEventListener('error',event=>error(event.error??new Error('The flock worker could not start.')),{signal});
  worker.addEventListener('message',event=>{
    if(event.data.ready){
      workerReady=true;
    }else{
      workerBusy=false;
      if(event.data.generation===generation)workerFrame=event.data;
    }
    if(flock&&engine&&!paused)schedule();
  },{signal});
}
function togglePause() {
  paused=!paused;
  flock.options.paused=!!worker||paused;
  pause.setAttribute('aria-pressed',String(paused));
  pause.textContent=paused?'Resume':'Pause';
  lastTime=undefined;
  readout();
  schedule();
}

function connect() {
  canvas.addEventListener('pointerdown',event=>{
    if (!event.isPrimary) return;
    pointerId=event.pointerId;
    canvas.setPointerCapture(pointerId);
    eventPosition(event);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if (event.pointerId===pointerId || (event.pointerType==='mouse' && !paused))eventPosition(event);
  },{signal});
  for (const type of ['pointerup','pointercancel','lostpointercapture'])
    canvas.addEventListener(type,event=>{if(event.pointerId===pointerId)pointerId=undefined;},{signal});
  disturb.addEventListener('click',()=>begin(viewportWidth*.52,viewportHeight*.38),{signal});
  pause.addEventListener('click',togglePause,{signal});
  reset.addEventListener('click',()=>{
    unsetDisturbance();
    flock.restore(openingFormation(seed));
    if(worker) {
      generation++;
      workerFrame=undefined;
      worker.postMessage({reset:true});
    }
    active=0;
    schedule();
  },{signal});
  document.addEventListener('visibilitychange',()=>{
    lastTime=undefined;
    if(!document.hidden)schedule();
  },{signal});
  observer=new ResizeObserver(()=>{readySize();schedule();});
  observer.observe(canvas);
}

function decodeBackdrop(blob){
  return createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
}

async function loadBackdrop(){
  const response=await fetch(new URL('./marsh-sky.webp',import.meta.url),{signal});
  if(!response.ok)throw new Error('The marsh sky could not be loaded.');
  const blob=await response.blob();
  return {blob,bitmap:await decodeBackdrop(blob)};
}

async function open() {
  const backdrop=loadBackdrop().catch(error=>({error}));
  const knownCompatibility=force || !navigator.gpu;
  const earlyCompat = knownCompatibility
    ? import('@margoengine/webgl2-compat').then(module=>({module}),error=>({error}))
    : undefined;
  const loadCompat = async()=>{
    const prepared=await earlyCompat;
    if(prepared?.error)throw prepared.error;
    const compat=prepared?.module??await import('@margoengine/webgl2-compat');
    return {install:()=>compat.install({force,signal})};
  };
  if(knownCompatibility){
    startWorker();
    await (await loadCompat()).install();
  }
  engine = await autoEngine(canvas,async target=>{
    if(!target.gpu) throw margoError('unsupported','The flock requires the Margo GPU frame graph','flocking');
    engine=target;
    canvas=target.canvas;
    notice=demoStatus(canvas,overlay,document.querySelector('#error-reason'));
    readySize();
    target.lighting.direction.set([...sunDirection,1.08]);
    target.lighting.radiance.set([1,.63,.53,.28]);
    target.lighting.ambient.set([.38,.33,.43]);
    const image=await backdrop;
    if(image.error)throw image.error;
    target.scene.use(new MarshSky(image.bitmap.width?image.bitmap:await decodeBackdrop(image.blob)));
    buildMarsh(target);
    const fallback = target.gpu.adapterInfo?.vendor==='margo-webgl2';
    flock=GPUFlock.attach(target,{
      ...flightOptions,geometry:starling(),paused:fallback,
      color:'#362a37',accentColor:'#593f49',ambient:.61,lightDirection:sunDirection,
      lightColor:'#f4a78b',scale:.207,
    });
    flock.restore(openingFormation(seed));
    target.render({delta:0});
    await target.gpu.queue.onSubmittedWorkDone();
  },{
    loadCompat,backend:knownCompatibility?'webgpu':undefined,signal,exactSize:true,antialias:false,capacity:96,
    startupTimeout:8500,camera:{position:[0,eyeHeight,distance],target:[0,viewHeight,0],near:.15,far:1150,fov:52},
  });
  signal.throwIfAborted();
  engine.onError=error;
  if(flock.stats.backend==='webgl2-compat'&&!worker)startWorker();
  canvas.dataset.renderer=flock.stats.backend;
  canvas.dataset.birds=String(flock.count);
  canvas.dataset.sky='margo-baked-dusk';
  for (const button of buttons) button.disabled=false;
  overlay.hidden=true;
  readout();
  notice.ready();
  performance.mark('margo-first-usable-frame');
  connect();
  schedule();
}

window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  worker?.terminate();
  flock?.dispose();
  engine?.dispose();
});
open().catch(error);

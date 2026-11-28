import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { buildLock } from './model.js';
import { finish, lockage } from './lockage.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const travel = document.getElementById('travel');
const reset = document.getElementById('reset');
const message = document.getElementById('phase-message');
const levels = ['level','volume','flow'].map(id => document.getElementById(id));
const route = [...document.querySelectorAll('#route li')];
const status = ['Boat entering. The gates ahead are closed.', 'The entry gates are closing behind the boat.',
  'Both gates are sealed. The valves move water through the culvert.', 'Water levels match. The exit gates are opening.',
  'The boat is passing into the next reach.'];
const stop = new AbortController();

let engine;
let exhibit;
let observer;
let frame;
let position = 0;
let previous;
let running = false;
let active = false;
let direction = 'up';
let previousPhase;
let firstInput;
let predicted = lockage(direction,0);

function measure() {
  const dpr = Math.min(1.7, Math.max(1.20,devicePixelRatio));
  const width = Math.max(1,Math.round(canvas.clientWidth*dpr));
  const height = Math.max(1,Math.round(canvas.clientHeight*dpr));
  if (canvas.width===width && canvas.height===height) return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function camera() {
  const aspect=canvas.clientWidth / Math.max(1,canvas.clientHeight);
  const distance=Math.max(32.9,59.0/aspect);
  const yaw=.27+.12*Math.max(0,1.6-aspect);
  const pitch=.43;
  const point=[0,1.32,-3.22];
  const offset=Math.cos(pitch)*distance;
  engine.camera.target=point;
  engine.camera.position=[point[0]+Math.sin(yaw)*offset,point[1]+Math.sin(pitch)*distance,point[2]+Math.cos(yaw)*offset];
}

function render() {
  camera();
  exhibit.update(predicted,position);
  engine.render({delta:0});
  if (firstInput && !performance.getEntriesByName('margo-first-input-applied').length) {
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(() => {
      if (!stop.signal.aborted) performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  firstInput=false;
}

function interfaceState() {
  const atEnd=position>=finish;
  const visible=active?predicted.phase:-1;
  levels[0].value=predicted.level.toFixed(2);
  levels[1].value=Math.round(predicted.volume).toString();
  levels[2].value=Math.abs(predicted.flow).toFixed(1);

  const state=atEnd?'complete':visible<0?'waiting':String(route[visible].textContent.toLowerCase());
  const signature=state+'-'+running+'-'+direction;
  if (signature===previousPhase) return;
  previousPhase=signature;
  document.body.dataset.phase=state;
  document.body.dataset.port=atEnd?(direction==='up'?'upper':'lower'):active?'chamber':'lower';
  document.body.dataset.running=String(running);
  for (const [index,item] of route.entries()) {
    item.classList.toggle('done',atEnd || visible>index);
    if (visible===index&&!atEnd) item.setAttribute('aria-current','step');
    else item.removeAttribute('aria-current');
  }
  if (atEnd) {
    travel.textContent=direction==='up'?'Lower the boat':'Lift the boat';
    message.textContent=direction==='up'?'The boat has reached the upper canal.':'The boat has returned to the lower canal.';
  } else if (active) {
    travel.textContent=running?'Pause lockage':'Resume lockage';
    const current = visible === 2
      ? direction === 'up' ? 'Both gates are sealed. The upper reach is filling the chamber.'
        : 'Both gates are sealed. The chamber is draining to the lower reach.'
      : status[visible];
    message.textContent=running?current:'Lockage paused. '+current;
  } else {
    travel.textContent='Lift the boat';
    message.textContent='Lower gates open. The boat is waiting to enter.';
  }
}

function animate(now) {
  frame=undefined;
  if (stop.signal.aborted) return;
  if (running && previous!==undefined) {
    position=Math.min(finish,position+Math.min(.12,(now-previous)/1000));
    if (position===finish) running=false;
  }
  previous=running?now:undefined;
  try {
    predicted=lockage(direction,position);
    interfaceState();
    render();
  } catch (error) {
    fail(error);
    return;
  }
  if (running) schedule();
}

function schedule() {
  if (frame===undefined && !stop.signal.aborted) frame=requestAnimationFrame(animate);
}

function bind() {
  const options={signal:stop.signal};
  travel.addEventListener('click',() => {
    if (!active || position>=finish) {
      if (active) direction=direction==='up'?'down':'up';
      position=0;
      active=true;
      running=true;
      previous=undefined;
    } else {
      running=!running;
      previous=undefined;
    }
    firstInput=true;
    schedule();
  },options);
  reset.addEventListener('click',() => {
    position=0;
    running=false;
    active=false;
    previous=undefined;
    direction='up';
    schedule();
  },options);
}

function dispose() {
  stop.abort();
  if (frame!==undefined) cancelAnimationFrame(frame);
  observer?.disconnect();
  exhibit?.dispose();
  engine?.dispose();
}

function fail(error) {
  if (stop.signal.aborted) return;
  document.body.dataset.state='error';
  loading.hidden=false;
  loading.textContent='The lock could not open. '+(error?.message??error);
  travel.disabled=reset.disabled=true;
  dispose();
  console.error(error);
}

async function start() {
  measure();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.52,far:228,fov:38},signal:stop.signal});
  if (!forced) {
    try { engine=await open(); }
    catch (error) { if (error?.code!=='unsupported') throw error; }
  }
  const compatible=!engine;
  if (compatible) {
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#3c4846';
  engine.lighting.direction.set([-.47,.73,.49,2.3]);
  engine.lighting.radiance.set([1,.94,.82,.61]);
  engine.lighting.ambient.set([.55,.67,.75]);
  const shadows=Shadows.attach(engine,{
    bounds:{min:[-22,-2.2,-12],max:[22,8,4.6]},resolution:1024,filter:'pcf',normalBias:.031,
  });
  exhibit=buildLock(engine,shadows);
  render();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (stop.signal.aborted) return;
  bind();
  observer=new ResizeObserver(()=>{if(measure()) schedule();});
  observer.observe(canvas);
  travel.disabled=reset.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=compatible?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',event=>{if(!event.persisted) dispose();});
await start().catch(fail);
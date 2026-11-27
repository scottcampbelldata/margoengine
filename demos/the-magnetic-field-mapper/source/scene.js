import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { buildBoard } from './rig.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const separation = document.querySelector('#separation');
const separationValue = document.querySelector('#separation-value');
const flip = document.querySelector('#flip');
const alignment = document.querySelector('#alignment');
const field = document.querySelector('#field');
const view = document.querySelector('#view');
const lifetime = new AbortController();
const controls = [separation, flip, view];

let engine, board, observer, pending;
let orientation = 1, plan = false, changed = false;

function laboratoryLight() {
  const width = 64, height = 32;
  const data = new Float32Array(width * height * 4);
  const reflectors = [
    [-.88,.62,.52,.27,[7.2,5.7,3.9]],
    [1.64,.31,.42,.57,[3.2,4.4,4.9]],
    [2.85,.18,.55,.24,[4.3,3.8,2.9]],
  ];
  for (let row = 0; row < height; row++) {
    const elevation = Math.PI * (.5 - (row + .5) / height);
    for (let col = 0; col < width; col++) {
      const azimuth = Math.PI * (2 * (col + .5) / width - 1);
      const base = .09 + .18 * Math.max(0,Math.sin(elevation));
      const sample = [base,base*1.07,base*1.04,1];
      for (const [angle,pitch,w,h,color] of reflectors) {
        const delta = Math.atan2(Math.sin(azimuth-angle),Math.cos(azimuth-angle));
        const mask = Math.exp(-1.8*((delta/w)**4+((elevation-pitch)/h)**4));
        for (let channel = 0; channel < 3; channel++) sample[channel] += color[channel] * mask;
      }
      data.set(sample,(row*width+col)*4);
    }
  }
  return { width, height, data };
}

function size() {
  const bounds = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio,1.5);
  const width = Math.max(1,Math.round(bounds.width*density));
  const height = Math.max(1,Math.round(bounds.height*density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  if (!engine) return;
  const distance = Math.max(1,1.48*height/width);
  const target = [0,.032,0];
  const offset = plan ? [0,.778,.014] : [.181,.609,.542];
  engine.camera.target = target;
  engine.camera.position = target.map((value,axis)=>value+offset[axis]*distance);
}

function render() {
  const mm = separation.valueAsNumber;
  const reading = board.pose(mm*.001,orientation);
  engine.render();
  separationValue.value = mm + ' mm';
  separation.setAttribute('aria-valuetext',mm+' millimeters');
  alignment.value = orientation === 1 ? 'Same direction' : 'Opposite directions';
  field.value = (reading.horizontal*1e6).toFixed(0);
  document.body.dataset.field = field.value;
  document.body.dataset.separation = separation.value;
  document.body.dataset.orientation = String(orientation);
  if (changed) {
    performance.mark('margo-field-input-rendered');
    changed = false;
  }
}

function schedule() {
  if (pending !== undefined || lifetime.signal.aborted) return;
  pending = requestAnimationFrame(() => {
    pending = undefined;
    try { render(); } catch (error) { fail(error); }
  });
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (pending !== undefined) cancelAnimationFrame(pending);
  engine?.dispose();
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  document.body.dataset.state='error';
  controls.forEach(control=>{control.disabled=true;});
  loading.hidden=false;
  loading.textContent='The magnetic field mapper could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend')==='webgl2';
  const open = () => Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:560,
    startupTimeout:9500,signal:lifetime.signal,camera:{fov:34,near:.039,far:19},
  });
  size();
  if (!forced) {
    try { engine=await open(); }
    catch (error) { if(error?.code!=='unsupported')throw error; }
  }
  const fallback=!engine;
  if (fallback) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#576e66';
  engine.lighting.direction.set([-.57,.70,.43,1.75]);
  engine.lighting.radiance.set([1,.944,.838,.51]);
  engine.lighting.ambient.set([.60,.70,.65]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.07,normalBias:.00039,
    bounds:{min:[-.41,-.04,-.29],max:[.41,.20,.30]},
  });
  await EnvironmentLighting.load(engine,laboratoryLight(),{
    size:32,specularSize:32,intensity:1.04,signal:lifetime.signal,
  });
  board=buildBoard(engine,shadows);
  size();
  render();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  const intuitive=()=>{changed=true;schedule();};
  separation.addEventListener('input',intuitive,options);
  flip.addEventListener('click',()=>{
    orientation=-orientation;
    flip.setAttribute('aria-pressed',String(orientation===-1));
    intuitive();
  },options);
  view.addEventListener('click',()=>{
    plan=!plan;
    view.setAttribute('aria-pressed',String(plan));
    view.textContent=plan?'Instrument view':'Plan view';
    size();
    schedule();
  },options);
  observer=new ResizeObserver(()=>{size();schedule();});
  observer.observe(canvas);
  controls.forEach(control=>{control.disabled=false;});
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',event=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);



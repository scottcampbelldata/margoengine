import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createRuler } from './model.js';
import { displayedOrders, orderAngle, radians } from './optics.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const wavelength = document.querySelector('#wavelength');
const groove = document.querySelector('#density');
const output = document.querySelector('#wavelength-output');
const first = document.querySelector('#first');
const count = document.querySelector('#order-count');
const view = document.querySelector('#view');
const controls = [wavelength,groove,view];
const lifetime = new AbortController();
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const wide = { target:[-.026,.098,.011],offset:[.63,1.17,1.63],fitAspect:1.14 };
const overhead = { target:[0,.124,-.059],offset:[.004,1.77,.315],fitAspect:1.16 };
const mix = (a,b,t) => a+(b-a)*t;
let nm = Number(wavelength.value), density = Number(groove.value);
let engine,ruler,observer,frame,last=0;
let zoom=0,detail=false,dirty=true,pending=false;

function resize() {
  const bounds=canvas.getBoundingClientRect();
  const width=Math.max(1,Math.round(bounds.width*1.5));
  const height=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===width && canvas.height===height)return false;
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  return true;
}

function readout() {
  output.value=nm+' nm';
  wavelength.setAttribute('aria-valuetext',nm+' nanometers');
  first.value='±'+(orderAngle(1,nm,density)/radians).toFixed(1)+'°';
  count.textContent=displayedOrders(nm,density).length+' spots on the ruler';
  view.setAttribute('aria-pressed',String(detail));
  view.textContent=detail?'Bench view':'View from above';
}

function paint(now) {
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const target=Number(detail);
  zoom=motion.matches||Math.abs(zoom-target)<.001?target:mix(target,zoom,Math.exp(-delta*15));
  const fit=Math.max(1,mix(wide.fitAspect,overhead.fitAspect,zoom)*canvas.height/canvas.width);
  const focus=wide.target.map((value,i)=>mix(value,overhead.target[i],zoom));
  engine.camera.target=focus;
  engine.camera.position=focus.map((value,i)=>value+fit*mix(wide.offset[i],overhead.offset[i],zoom));
  if(dirty) {
    ruler.update(nm,density);
    dirty=false;
  }
  engine.render({delta});
  Object.assign(document.body.dataset,{wavelength:nm,density,view:zoom===1?'overhead':zoom===0?'bench':'moving',
    orders:displayedOrders(nm,density).map(({order,angle})=>order+'='+angle.toFixed(7)).join(',')});
  if(pending) {
    performance.mark('margo-wavelength-applied');
    pending=false;
  }
  if(zoom!==target)schedule();
  else last=0;
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{try{paint(now);}catch(error){fail(error);}});
}

function adjust() {
  dirty=true;
  readout();
  schedule();
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state='error';
  for(const control of controls)control.disabled=true;
  loading.hidden=false;
  loading.textContent='The grating could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:320,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:39,near:.110,far:30},
  });
  if(!forced) {
    try{engine=await open();}catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatibility=!engine;
  if(compatibility) {
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#626276';
  engine.lighting.direction.set([-.64,1.42,.69,3.63]);
  engine.lighting.radiance.set([1,.92,.79,.43]);
  engine.lighting.ambient.set([.80,.92,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.059,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.93,-.22,-.84],max:[.92,.66,.78]},
  });
  ruler=createRuler(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:ruler.meshes});
  paint(performance.now());
  await ruler.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  wavelength.addEventListener('input',()=>{nm=Number(wavelength.value);pending=true;adjust();},options);
  groove.addEventListener('change',()=>{density=Number(groove.value);adjust();},options);
  view.addEventListener('click',()=>{detail=!detail;readout();schedule();},options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  readout();
  for(const control of controls)control.disabled=false;
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

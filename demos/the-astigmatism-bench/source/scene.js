import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { beamHeight, centerZ, createBench, lensX } from './model.js';
import { focusPlanes, spotRadii } from './optics.js';
import { lerp as mix } from '@margoengine/math/mathutils';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const distanceInput=document.querySelector('#distance');
const separationInput=document.querySelector('#separation');
const distanceValue=document.querySelector('#distance-value');
const separationValue=document.querySelector('#separation-value');
const spotValue=document.querySelector('#spot-value');
const view=document.querySelector('#view');
const stations=[...document.querySelectorAll('[data-station]')];
const controls=[distanceInput,separationInput,view,...stations];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={focus:[-.069,.090,.024],offset:[-.49,.96,1.37],fit:1.53};
const detail={offset:[-.30,.035,.052],fit:1.08};
const mm=(value)=> (value*1000).toFixed(1);
let distance=Number(distanceInput.value)/1000;
let separation=Number(separationInput.value)/1000;
let planes=focusPlanes(separation),station=null,close=false;
let engine,bench,observer,frame,last=0,zoom=0,dirty=true,applied=false;

function resize() {
  const bounds=canvas.getBoundingClientRect();
  const width=Math.max(1,Math.round(bounds.width*1.5));
  const height=Math.max(1,Math.round(bounds.height*1.5));
  if (canvas.width===width&&canvas.height===height) return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function updateLabels() {
  const [horizontal,vertical]=spotRadii(distance,planes);
  distanceValue.value=mm(distance)+' mm';
  separationValue.value=Math.round(separation*1000)+' mm';
  distanceInput.setAttribute('aria-valuetext',mm(distance)+' millimeters');
  separationInput.setAttribute('aria-valuetext',Math.round(separation*1000)+' millimeters');
  spotValue.value=mm(2*horizontal)+' × '+mm(2*vertical)+' mm';
  view.setAttribute('aria-pressed',String(close));
  view.textContent=close?'Whole bench':'Inspect the spot';
  for (const button of stations) button.setAttribute('aria-pressed',String(button.dataset.station===station));
}

function paint(now) {
  frame=undefined;
  const delta=last?Math.min(.06,(now-last)/1000):1/60;
  last=now;
  const target=Number(close);
  zoom=motion.matches||Math.abs(zoom-target)<.001?target:mix(target,zoom,Math.exp(-delta*15));
  const aspect=canvas.width/canvas.height;
  const wideFit=Math.max(1,wide.fit/aspect);
  const detailFit=Math.max(1,detail.fit/aspect);
  const screen=[lensX+distance,beamHeight,centerZ];
  const focus=wide.focus.map((value,index)=>mix(value,screen[index],zoom));
  const closeX=Math.max(detail.offset[0]*detailFit,.035-distance);
  const closeOffset=[closeX,detail.offset[1]*detailFit,detail.offset[2]*detailFit];
  const offset=wide.offset.map((value,index)=>mix(value*wideFit,closeOffset[index],zoom));
  engine.camera.target=focus;
  engine.camera.position=focus.map((value,index)=>value+offset[index]);
  engine.camera.fov=mix(39,43,zoom);
  if (dirty) {
    bench.update(distance,separation,planes);
    dirty=false;
  }
  engine.render({delta});
  const [horizontal,vertical]=spotRadii(distance,planes);
  Object.assign(document.body.dataset,{
    distance:(distance*1000).toFixed(4),
    separation:Math.round(separation*1000),
    spot:[horizontal,vertical].map((value)=>value.toFixed(8)).join(','),
    view:zoom===1?'spot':zoom===0?'bench':'moving',
  });
  if(applied){
    performance.mark('margo-image-plane-applied');
    applied=false;
  }
  if (zoom!==target) schedule();
  else last=0;
}

function schedule() {
  if (frame!==undefined||lifetime.signal.aborted) return;
  frame=requestAnimationFrame((now)=>{try { paint(now); } catch(error) { fail(error); }});
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if (frame!==undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state='error';
  for (const control of controls) control.disabled=true;
  loading.hidden=false;
  loading.textContent='The bench could not open on this browser.';
  console.error(error);
  clean();
}

function chooseStation(name) {
  station=name;
  distance=planes[name];
  distanceInput.value=String(distance*1000);
}

function change() {
  dirty=true;
  applied=true;
  updateLabels();
  schedule();
}

async function start() {
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:400,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:39,near:.033,far:30},
  });
  if (!forced) {
    try { engine=await open(); } catch(error) { if (error?.code!=='unsupported') throw error; }
  }
  const compatibility=!engine;
  if (compatibility) {
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#504753';
  engine.lighting.direction.set([-.75,1.46,.74,3.55]);
  engine.lighting.radiance.set([1,.94,.86,.47]);
  engine.lighting.ambient.set([.87,.92,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.058,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.90,-.18,-.49],max:[.76,.54,.51]},
  });
  bench=createBench(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:bench.meshes});
  paint(performance.now());
  await bench.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options={signal:lifetime.signal};
  distanceInput.addEventListener('input',()=>{
    station=null;
    distance=Number(distanceInput.value)/1000;
    change();
  },options);
  separationInput.addEventListener('input',()=>{
    separation=Number(separationInput.value)/1000;
    planes=focusPlanes(separation);
    if(station) chooseStation(station);
    change();
  },options);
  for(const button of stations)button.addEventListener('click',()=>{
    chooseStation(button.dataset.station);
    change();
  },options);
  view.addEventListener('click',()=>{
    close=!close;
    bench.showGuides(!close);
    updateLabels();
    schedule();
  },options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted) clean();},options);
  observer=new ResizeObserver(()=>{if(resize()) schedule();});
  observer.observe(canvas);
  updateLabels();
  for(const control of controls) control.disabled=false;
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

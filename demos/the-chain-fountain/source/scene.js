import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { buildApparatus } from './rig.js';
import { steadyFountain } from './model.js';
import { floorY } from './path.js';

const canvas=document.querySelector('#scene'),loading=document.querySelector('#loading');
const pickup=document.querySelector('#pickup'),drop=document.querySelector('#drop'),pause=document.querySelector('#pause');
const pickupValue=document.querySelector('#pickup-value'),dropValue=document.querySelector('#drop-value');
const rise=document.querySelector('#rise'),speed=document.querySelector('#speed');
const view=document.querySelector('#view');
const controls=[pickup,drop,pause,view];
const lifetime=new AbortController(),reduced=matchMedia('(prefers-reduced-motion: reduce)');

let engine,apparatus,observer,frame,previousTime,current;
let running=!reduced.matches, travel=0, action=false, zoomHeight, detail=false;

function reflectorMap() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const reflectors=[
    [-.76,.59,.51,.42,[7.0,5.9,4.5]],
    [1.13,.28,.51,.54,[3.2,4.4,5.6]],
    [2.81,.40,.48,.25,[5.0,4.3,3.0]],
  ];
  for(let y=0;y<height;y++){
    const elevation=Math.PI*(.5-(y+.5)/height);
    for(let x=0;x<width;x++){
      const bearing=Math.PI*(2*(x+.5)/width-1);
      const ambient=.08+.17*Math.max(0,Math.sin(elevation));
      const pixel=[ambient*.91,ambient,ambient*1.09,1];
      for(const [angle,pitch,w,h,radiance] of reflectors){
        const delta=Math.atan2(Math.sin(bearing-angle),Math.cos(bearing-angle));
        const mask=Math.exp(-1.7*((delta/w)**4+((elevation-pitch)/h)**4));
        for(let c=0;c<3;c++)pixel[c]+=radiance[c]*mask;
      }
      data.set(pixel,(y*width+x)*4);
    }
  }
  return {width,height,data};
}

function updateModel() {
  const fall=drop.valueAsNumber,push=pickup.valueAsNumber;
  current={fall,push,...steadyFountain(fall,push/100)};
  updateCamera();
  pickupValue.value=push+'%';
  dropValue.value=fall.toFixed(1)+' m';
  pickup.setAttribute('aria-valuetext',push+' percent');
  drop.setAttribute('aria-valuetext',fall.toFixed(1)+' meters');
  rise.value=(current.rise*100).toFixed(1);
  speed.value=current.speed.toFixed(2);
}

function updateCamera() {
  if(!engine||!current)return;
  const height=current.fall+current.rise+floorY+.15;
  if(zoomHeight===height)return;
  zoomHeight=height;
  const center=detail ? current.fall+floorY+current.rise*.44-.045 : height*.50;
  const distance=detail ? Math.max(.82,(current.rise+.36)*1.89) : Math.max(2.68,height*1.90);
  engine.camera.target=[-.023,center,0];
  engine.camera.position=[distance*.144,center+distance*.094,distance*.985];
}
function resize() {
  const bounds=canvas.getBoundingClientRect(),density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density)),height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
}

function draw(now) {
  if(running&&previousTime!==undefined)travel+=Math.min(.080,(now-previousTime)*.001)*current.speed*.25;
  previousTime=running?now:undefined;
  const crest=apparatus.pose(current.fall,current.rise,travel);
  engine.render();
  document.body.dataset.pickup=String(current.push);
  document.body.dataset.drop=String(current.fall);
  document.body.dataset.rise=rise.value;
  document.body.dataset.crest=crest.toFixed(5);
  document.body.dataset.travel=travel.toFixed(5);
  document.body.dataset.running=String(running);
  if(action){
    performance.mark('margo-chain-input-rendered');
    action=false;
  }
  if(running)schedule();
}

function schedule() {
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{
    frame=undefined;
    try{draw(now);}catch(error){fail(error);}
  });
}
function run(next) {
  running=next;
  previousTime=undefined;
  pause.textContent=running?'Pause chain':'Run chain';
  schedule();
}
function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state='error';
  controls.forEach(control=>{control.disabled=true;});
  loading.hidden=false;
  loading.textContent='The chain fountain could not open in this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:610,
    startupTimeout:9500,signal:lifetime.signal,camera:{fov:33,near:.17,far:30},
  });
  resize();
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compat=!engine;
  if(compat){
    const { install }=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#53636c';
  engine.lighting.direction.set([-.46,.74,.52,1.81]);
  engine.lighting.ambient.set([.59,.66,.70]);
  engine.lighting.radiance.set([1,.943,.850,.45]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.06,normalBias:.00205,
    bounds:{min:[-.77,-.12,-.51],max:[.76,3.56,.57]},
  });
  await EnvironmentLighting.load(engine,reflectorMap(),{
    size:32,specularSize:32,intensity:1.09,signal:lifetime.signal,
  });
  apparatus=buildApparatus(engine,shadows);
  updateModel();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  for(const control of [pickup,drop]){
    control.addEventListener('input',()=>{
      updateModel();
      action=true;
      schedule();
    },options);
  }
  view.addEventListener('click',()=>{
    detail=!detail;
    zoomHeight=undefined;
    view.setAttribute('aria-pressed',String(detail));
    view.textContent=detail?'Full instrument':'Feed close-up';
    updateCamera();
    schedule();
  },options);
  pause.addEventListener('click',()=>run(!running),options);
  reduced.addEventListener('change',(event)=>{if(event.matches)run(false);},options);
  observer=new ResizeObserver(()=>{resize();schedule();});
  observer.observe(canvas);
  controls.forEach(control=>{control.disabled=false;});
  run(running);
  loading.hidden=true;
  document.body.dataset.renderer=compat?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);



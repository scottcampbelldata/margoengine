import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makeCradle } from './instrument.js';
import { advance, energy, initialise, length } from './motion.js';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const release=document.querySelector('#release');
const slow=document.querySelector('#slow');
const count=[...document.querySelectorAll('[data-count]')];
const retained=document.querySelector('#energy');
const speed=document.querySelector('#speed');
const lifetime=new AbortController();
const controls=[release,slow,...count];

let engine,cradle,frame,observer,last;
let selected=1,slowed=false,running=false,firstMotion=false;
let system=initialise(selected);

function room() {
  const width=64,height=32,data=new Float32Array(width*height*4);
  const panels=[
    [-.76,.52,.39,.48,[7.6,6.7,5.55]],
    [1.44,.25,.32,.55,[4.55,5.6,6.38]],
    [2.87,-.15,.67,.20,[2.58,2.37,1.91]],
    [-2.52,.68,.63,.19,[5.8,4.8,3.63]],
  ];
  for(let j=0;j<height;j++){
    const pitch=Math.PI*(.5-(j+.5)/height);
    for(let i=0;i<width;i++){
      const azimuth=Math.PI*2*((i+.5)/width-.5);
      const base=.085+.22*Math.max(0,Math.sin(pitch));
      const rgb=[base,base*1.05,base*1.01];
      for(const [bearing,elevation,wide,high,intensity] of panels){
        const x=Math.atan2(Math.sin(azimuth-bearing),Math.cos(azimuth-bearing))/wide;
        const y=(pitch-elevation)/high;
        const contribution=Math.exp(-2*(x**4+y**4));
        for(let k=0;k<3;k++)rgb[k]+=intensity[k]*contribution;
      }
      data.set([...rgb,1],(j*width+i)*4);
    }
  }
  return {width,height,data};
}

function size() {
  const bounds=canvas.getBoundingClientRect();
  const density=Math.min(devicePixelRatio,1.5);
  const width=Math.max(1,Math.round(bounds.width*density));
  const height=Math.max(1,Math.round(bounds.height*density));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  if(engine){
    const fit=Math.max(1,1.37*height/width);
    engine.camera.target=[-.009,.161,0];
    engine.camera.position=[-.009+.177*fit,.161+.321*fit,.853*fit];
  }
}

function draw(now) {
  frame=undefined;
  const delta=last===undefined?1/60:Math.min(.065,(now-last)/1000);
  last=running?now:undefined;
  if(running)advance(system,delta*(slowed?.25:1));
  const fraction=energy(system)/system.initial;
  if(running&&fraction<.025)running=false;
  const fastest=system.velocity.reduce((max,value)=>Math.max(max,Math.abs(value)*length),0);
  retained.textContent=String(Math.round(100*fraction));
  speed.textContent=fastest.toFixed(2);
  cradle.pose(system);
  engine.render({delta});
  document.body.dataset.count=String(selected);
  document.body.dataset.contacts=String(system.contacts);
  document.body.dataset.outer=system.angle.at(-1).toFixed(4);
  document.body.dataset.energy=fraction.toFixed(4);
  document.body.dataset.speed=fastest.toFixed(4);
  if(firstMotion&&fastest>.008){
    performance.mark('margo-release-rendered');
    firstMotion=false;
  }
  if(running)schedule();
}

function schedule() {
  if(frame===undefined&&!lifetime.signal.aborted)frame=requestAnimationFrame((now)=>{
    try{draw(now);}catch(error){fail(error);}
  });
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
  loading.hidden=false;
  loading.textContent='The cradle could not open in this browser.';
  controls.forEach((control)=>{control.disabled=true;});
  console.error(error);
  dispose();
}
function reset() {
  system=initialise(selected);
  last=undefined;
}

async function start() {
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,capacity:163,
    startupTimeout:9000,signal:lifetime.signal,camera:{fov:34,near:.092,far:14},
  });
  size();
  if(!forced){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#687567';
  engine.lighting.direction.set([-.49,.78,.34,1.86]);
  engine.lighting.radiance.set([.98,.94,.87,.45]);
  engine.lighting.ambient.set([.59,.70,.64]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.11,normalBias:.00042,
    bounds:{min:[-.38,-.067,-.19],max:[.38,.45,.25]},
  });
  await EnvironmentLighting.load(engine,room(),{size:32,specularSize:32,intensity:1.00,signal:lifetime.signal});
  cradle=makeCradle(engine,shadows);
  size();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;

  const options={signal:lifetime.signal};
  count.forEach((button)=>button.addEventListener('click',()=>{
    const next=Number(button.dataset.count);
    if(selected===next)return;
    selected=next;
    running=false;
    firstMotion=false;
    reset();
    count.forEach((item)=>item.setAttribute('aria-pressed',String(item===button)));
    schedule();
  },options));
  release.addEventListener('click',()=>{
    reset();
    running=true;
    firstMotion=true;
    schedule();
  },options);
  slow.addEventListener('click',()=>{
    slowed=!slowed;
    slow.setAttribute('aria-pressed',String(slowed));
    schedule();
  },options);
  observer=new ResizeObserver(()=>{size();schedule();});
  observer.observe(canvas);
  controls.forEach((control)=>{control.disabled=false;});
  loading.hidden=true;
  document.body.dataset.state='ready';
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},{signal:lifetime.signal});
start().catch(fail);

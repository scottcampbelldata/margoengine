import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createBench, screenFocus } from './model.js';
import { bladeOut } from './optics.js';
import { lerp as mix } from '@margoengine/math/mathutils';

const canvas=document.querySelector('#scene');
const loading=document.querySelector('#loading');
const range=document.querySelector('#cutoff');
const value=document.querySelector('#cutoff-value');
const clear=document.querySelector('#clear');
const bypass=document.querySelector('#bypass');
const view=document.querySelector('#view');
const controls=[range,bypass,view];
const lifetime=new AbortController();
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const wide={aim:[0,.103,.070],offset:[-.42,1.10,1.37],fit:1.37,fov:42};
const detail={aim:screenFocus,offset:[-.012,.316,.336],fit:1.10,fov:38};
const still=.68;
let engine,bench,resizeObserver,screenObserver,frame;
let cutoff=Number(range.value),out=false,close=false,inView=true,dirty=true,applied=false,zoom=0;
let last=0,time=still;

function resize(){
  const bounds=canvas.getBoundingClientRect();
  const w=Math.max(1,Math.round(bounds.width*1.5));
  const h=Math.max(1,Math.round(bounds.height*1.5));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;
  canvas.height=h;
  return true;
}

function labels(){
  value.value=out?'Withdrawn':cutoff+'%';
  range.setAttribute('aria-valuetext',cutoff+' percent');
  clear.value=(out?100:100-cutoff)+'%';
  bypass.setAttribute('aria-pressed',String(out));
  bypass.textContent=out?'Insert blade':'Withdraw blade';
  view.setAttribute('aria-pressed',String(close));
  view.textContent=close?'Whole bench':'Inspect the plume';
}

function paint(now){
  frame=undefined;
  const goal=Number(close);
  const animating=!motion.matches&&!out&&inView&&!document.hidden;
  const changing=Math.abs(zoom-goal)>.001;
  const elapsed=last?now-last:33;
  if(animating&&!changing&&!dirty&&elapsed<31){schedule();return;}
  const delta=Math.min(.055,elapsed/1000);
  last=now;
  if(motion.matches)time=still;
  else if(animating)time+=delta;
  zoom=motion.matches||!changing?goal:mix(goal,zoom,Math.exp(-delta*15));
  const fit=Math.max(1,mix(wide.fit,detail.fit,zoom)*canvas.height/canvas.width);
  engine.camera.target=wide.aim.map((axis,i)=>mix(axis,detail.aim[i],zoom));
  engine.camera.position=engine.camera.target.map((axis,i)=>axis+fit*mix(wide.offset[i],detail.offset[i],zoom));
  engine.camera.fov=mix(wide.fov,detail.fov,zoom);
  const cut=out?bladeOut:cutoff/100;
  if(dirty){bench.updateCutoff(cut);dirty=false;}
  bench.paint(time,cut);
  engine.render({delta});
  Object.assign(document.body.dataset,{
    cutoff, blade:out?'withdrawn':'inserted', clear:out?100:100-cutoff,
    view:zoom===0?'bench':zoom===1?'plume':'moving', plumeTime:time.toFixed(4),
  });
  if(applied){performance.mark('margo-cutoff-applied');applied=false;}
  if(zoom!==goal||animating)schedule();
  else last=0;
}

function schedule(){
  if(frame!==undefined||lifetime.signal.aborted)return;
  frame=requestAnimationFrame((now)=>{try{paint(now);}catch(error){fail(error);}});
}

function clean(){
  if(lifetime.signal.aborted)return;
  lifetime.abort();
  resizeObserver?.disconnect();
  screenObserver?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error){
  document.body.dataset.state='error';
  for(const control of controls)control.disabled=true;
  loading.hidden=false;
  loading.textContent='The schlieren bench could not open on this browser.';
  console.error(error);
  clean();
}

function change(){
  dirty=true;
  applied=true;
  labels();
  schedule();
}

async function start(){
  resize();
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:352,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:42,near:.060,far:30},
  });
  if(!forced){
    try{engine=await open();}catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatibility=!engine;
  if(compatibility){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#607483';
  engine.lighting.direction.set([-.62,1.52,.81,3.54]);
  engine.lighting.radiance.set([1,.96,.86,.48]);
  engine.lighting.ambient.set([.84,.94,1]);
  const shadows=Shadows.attach(engine,{
    resolution:1024,filter:'soft',lightSize:.066,blockerSamples:8,samples:16,jitter:false,
    bounds:{min:[-.74,-.17,-.48],max:[.74,.48,.54]},
  });
  bench=createBench(engine,shadows);
  Object.assign(document.body.dataset,{renderer:compatibility?'compatibility':'webgpu',meshes:bench.meshes});
  paint(performance.now());
  await bench.ready();
  dirty=true;
  if(frame!==undefined)cancelAnimationFrame(frame);
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  range.addEventListener('input',()=>{cutoff=Number(range.value);out=false;change();},options);
  bypass.addEventListener('click',()=>{out=!out;change();},options);
  view.addEventListener('click',()=>{
    close=!close;
    bench.showGuides(!close);
    labels();
    schedule();
  },options);
  motion.addEventListener('change',schedule,options);
  document.addEventListener('visibilitychange',schedule,options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)clean();},options);
  resizeObserver=new ResizeObserver(()=>{if(resize())schedule();});
  resizeObserver.observe(canvas);
  screenObserver=new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;if(inView)schedule();});
  screenObserver.observe(canvas);
  for(const control of controls)control.disabled=false;
  labels();
  loading.hidden=true;
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

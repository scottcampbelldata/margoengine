import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { buildRam } from './machine.js';
import { sample,solve } from './cycle.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('lift');
const button=document.getElementById('pause');
const [lift,average,pressure,message]=['lift-value','average','pressure','phase-message'].map(id=>document.getElementById(id));
const markers=['waste','air','delivery'].map(id=>document.getElementById(id));
const sequence=[...document.querySelectorAll('ol li')];
const stop=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projected={x:0,y:0,z:0};
let engine,ram,observer,frame,previous,model;
let stage;
let time=0;
let paused=false;
let fresh=false;
let framing=true;

function measure(){
  const dpr=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*dpr));
  const height=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;canvas.height=height;framing=true;
  return true;
}

function aim(){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const distance=Math.max(1.265,(1.96+.38*Math.max(0,1.48-aspect))/aspect);
  const yaw=.16,pitch=.26,target=[-.016,.278,0];
  const ground=distance*Math.cos(pitch);
  engine.camera.target=target;
  engine.camera.position=[target[0]+Math.sin(yaw)*ground,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*ground];
}

function labels(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  ram.anchors.forEach(([x,y,z],i)=>{
    const tag=markers[i];
    worldToScreen({x,y,z},engine.camera,width,height,projected);
    const left=Math.max(8,Math.min(width-tag.offsetWidth-8,projected.x-tag.offsetWidth*.5));
    const top=Math.max(8,Math.min(height-35,projected.y-24));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  });
}

function controlData(){
  lift.value=model.lift.toFixed(1)+' m';
  average.value=model.meanDelivery.toFixed(2);
  slider.style.setProperty('--progress',((model.lift-2.6)/.032)+'%');
  slider.setAttribute('aria-valuetext',model.lift.toFixed(1)+' meters of delivery lift');
  document.body.dataset.lift=model.lift.toFixed(1);
  document.body.dataset.running=String(!paused&&!reduced.matches);
  button.textContent=reduced.matches?'Step through the cycle':paused?'Resume cycle':'Pause cycle';
}

function phaseData(state){
  pressure.value=(state.airPressure/1000).toFixed(1);
  const charging=state.phase===1 || (state.phase===2 && state.driveFlow>state.checkFlow);
  const current=state.checkFlow>.00001?'pulse':state.phase===0?'accel':charging?'close':'recover';
  if(current===stage)return;
  stage=current;
  const order=current==='accel'?0:current==='recover'?2:1;
  document.body.dataset.phase=['acceleration','pump','recovery'][order];
  const describe={accel:'Waste valve open · Water accelerates',
    close:'Waste valve closes · Pressure rises',pulse:'Delivery valve open · Water compresses the trapped air',
    recover:'Delivery valve shuts · The waste valve resets'};
  message.textContent=describe[current];
  for(const [i,item] of sequence.entries()){
    if(i===order)item.setAttribute('aria-current','step');
    else item.removeAttribute('aria-current');
  }
}

function draw(delta){
  if(framing)aim();
  const state=sample(model,time);
  ram.update(state,delta);
  phaseData(state);
  engine.render({delta:0});
  if(framing){labels();framing=false;}
  if(fresh&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!stop.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  fresh=false;
}

function animate(now){
  frame=undefined;
  if(stop.signal.aborted)return;
  const moving=!paused&&!reduced.matches&&!document.hidden;
  const delta=moving&&previous!==undefined?Math.min(.10,(now-previous)/1000):0;
  if(moving)time=(time+delta*.52)%model.seconds;
  previous=moving?now:undefined;
  try{draw(delta);}
  catch(error){fail(error);return;}
  if(moving)schedule();
}
function schedule(){
  if(frame===undefined&&!stop.signal.aborted)frame=requestAnimationFrame(animate);
}
function choose(){
  const phase=model?time/model.seconds:.21;
  model=solve(Number(slider.value));
  time=phase*model.seconds;
  controlData();
}
function wire(){
  const options={signal:stop.signal};
  slider.addEventListener('input',()=>{
    try{choose();fresh=true;schedule();}
    catch(error){fail(error);}
  },options);
  button.addEventListener('click',()=>{
    if(reduced.matches)time=(time+model.seconds*.135)%model.seconds;
    else paused=!paused;
    previous=undefined;controlData();fresh=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;controlData();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  stop.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();ram?.dispose();engine?.dispose();
}
function fail(error){
  if(stop.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;loading.textContent='The ram could not open. '+(error?.message??error);
  slider.disabled=button.disabled=true;
  dispose();console.error(error);
}
async function start(){
  measure();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.043,far:9,fov:39},signal:stop.signal});
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#4c6059';
  engine.lighting.direction.set([-.52,.76,.43,2.36]);
  engine.lighting.radiance.set([1,.94,.81,.59]);
  engine.lighting.ambient.set([.58,.72,.76]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.65,-.025,-.24],max:[.65,.588,.24]},
    resolution:1024,filter:'pcf',normalBias:.0017});
  ram=buildRam(engine,shadows);
  choose();draw(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(measure())schedule();});
  observer.observe(canvas);
  slider.disabled=button.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);
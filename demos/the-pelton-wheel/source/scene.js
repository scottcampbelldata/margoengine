import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { impulse, maximumRpm, optimumRpm, tau } from './impulse.js';
import { buildWheel } from './machine.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('speed');
const button=document.getElementById('pause');
const [speed,power,efficiency,torque]=['speed-value','power','efficiency','torque'].map(id=>document.getElementById(id));
const labels=['jet','split'].map(id=>document.getElementById(id));
const signaler=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projected={x:0,y:0,z:0};
let engine,wheel,observer,model,frame,previous;
let phase=0,flowTime=0;
let reframing=true,waitingOnInput=false,paused=false;

function measure(){
  const dpr=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr));
  const h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;
  reframing=true;
  return true;
}

function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const distance=Math.max(1.25,(1.82+.40*Math.max(0,1.4-aspect))/aspect);
  const yaw=-.43,pitch=.370,target=[-.035,.231,0];
  const ground=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*ground,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*ground];
  engine.camera.target=target;
}

function locateLabels(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  for(const [i,[x,y,z]] of wheel.anchors.entries()){
    const tag=labels[i];
    worldToScreen({x,y,z},engine.camera,width,height,projected);
    const left=Math.max(6,Math.min(width-tag.offsetWidth-6,projected.x-tag.offsetWidth*.5));
    const top=Math.max(6,Math.min(height-32,projected.y-18));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  }
}

function readControl(){
  model=impulse(Number(slider.value));
  speed.value=model.rpm+' rpm';
  power.value=model.power.toFixed(1);
  efficiency.value=(model.efficiency*100).toFixed(1);
  torque.value=model.torque.toFixed(2);
  slider.style.setProperty('--progress',(model.rpm/maximumRpm*100)+'%');
  slider.setAttribute('aria-valuetext',model.rpm+' revolutions per minute');
  document.body.dataset.rpm=String(model.rpm);
}
function updateMotionControl(){
  button.textContent=reduced.matches?'Step motion':paused?'Resume motion':'Pause motion';
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':'playing';
}

function draw(){
  if(reframing)aim();
  wheel.update(model,phase,flowTime);
  engine.render({delta:0});
  if(reframing){locateLabels();reframing=false;}
  if(waitingOnInput&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!signaler.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  waitingOnInput=false;
}

function advance(delta){
  phase=(phase+model.omega*delta)%tau;
  flowTime=(flowTime+delta*.23)%600;
}
function animate(now){
  frame=undefined;
  if(signaler.signal.aborted)return;
  const moving=!paused&&!reduced.matches&&!document.hidden;
  if(moving&&previous!==undefined)advance(Math.min(.075,(now-previous)/1000)*.12);
  previous=moving?now:undefined;
  try{draw();}
  catch(error){fail(error);return;}
  if(moving)schedule();
}
function schedule(){
  if(frame===undefined&&!signaler.signal.aborted)frame=requestAnimationFrame(animate);
}
function wire(){
  const options={signal:signaler.signal};
  slider.addEventListener('input',()=>{
    readControl();waitingOnInput=true;schedule();
  },options);
  button.addEventListener('click',()=>{
    if(reduced.matches)advance(.021);
    else paused=!paused;
    previous=undefined;updateMotionControl();waitingOnInput=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{
    previous=undefined;updateMotionControl();schedule();
  },options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  signaler.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();wheel?.dispose();engine?.dispose();
}
function fail(error){
  if(signaler.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;
  loading.textContent='The wheel could not open. '+(error?.message??error);
  slider.disabled=button.disabled=true;
  dispose();
  console.error(error);
}

async function start(){
  measure();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.038,far:8,fov:40},signal:signaler.signal});
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:signaler.signal});
    engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#49616a';
  engine.lighting.direction.set([-.51,.78,.46,2.5]);
  engine.lighting.radiance.set([1,.94,.80,.56]);
  engine.lighting.ambient.set([.58,.72,.78]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.60,-.024,-.23],max:[.57,.57,.23]},
    resolution:1024,filter:'pcf',normalBias:.0017});
  wheel=buildWheel(engine,shadows);
  document.getElementById('speed-note').textContent='Peak power at '+Math.round(optimumRpm)+' rpm';
  readControl();updateMotionControl();draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(signaler.signal.aborted)return;
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

import { Engine } from '@margoengine/core';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { buildBellows } from './instrument.js';
import { cycle,pumpDuration,response } from './pump.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('stroke');
const button=document.getElementById('pump');
const [liftReadout,liters,air,status]=['lift','liters','air','valve-status'].map(id=>document.getElementById(id));
const pins=['intake-pin','nozzle-pin'].map(id=>document.getElementById(id));
const stop=new AbortController();
const projected={x:0,y:0,z:0};
let engine,exhibit,observer,frame,manual,automatic;
let lift=Number(slider.value)/100;
let velocity=0;
let interacted=false;

function resize(){
  const ratio=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function camera(){
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const distance=Math.max(.98,1.52/aspect);
  const yaw=.26;
  const pitch=.31;
  const target=[.125,.149,0];
  const ground=distance*Math.cos(pitch);
  engine.camera.target=target;
  engine.camera.position=[target[0]+Math.sin(yaw)*ground,target[1]+Math.sin(pitch)*distance,Math.cos(yaw)*ground];
}

function placeLabels(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  exhibit.anchors().forEach(([x,y,z],index)=>{
    const pin=pins[index];
    worldToScreen({x,y,z},engine.camera,width,height,projected);
    const left=Math.max(8,Math.min(width-pin.offsetWidth-8,projected.x-pin.offsetWidth*.45));
    const upper=Math.max(8,Math.min(height-38,projected.y-24));
    pin.style.transform='translate('+left+'px,'+upper+'px)';
  });
}

function outputs(model){
  const actual=Math.round(lift*100);
  liftReadout.value=actual+'%';
  slider.style.setProperty('--progress',slider.value+'%');
  slider.setAttribute('aria-valuetext',slider.value+' percent handle lift');
  liters.value=model.liters.toFixed(2);
  air.value=Math.max(model.intake,model.outlet).toFixed(1);
  const direction=model.intake>.055?'in':model.outlet>.055?'out':'closed';
  if(document.body.dataset.valve!==direction){
    document.body.dataset.valve=direction;
    status.textContent=direction==='in'?'Intake open · Air enters':direction==='out'?'Outlet open · Air leaves':'Both valves closed';
  }
}

function draw(time){
  const model=response(lift,velocity);
  exhibit.update(lift,model,time);
  outputs(model);
  camera();
  engine.render({delta:0});
  placeLabels();
  if(interacted&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!stop.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  interacted=false;
}

function cancelCycle(){
  automatic=undefined;
  button.textContent='Pump one cycle';
  velocity=0;
}

function frameAt(now){
  frame=undefined;
  if(stop.signal.aborted)return;
  if(automatic){
    const time=(now-automatic.time)/1000;
    const step=cycle(automatic.start,time);
    lift=step.lift;
    velocity=step.speed;
    slider.value=String(Math.round(lift*100));
    if(time>=pumpDuration)cancelCycle();
  }else if(manual){
    const time=Math.min(1,Math.max(0,(now-manual.time)/manual.length));
    const difference=manual.end-manual.start;
    lift=time===1?manual.end:manual.start+difference*time*time*(3-2*time);
    velocity=difference*6*time*(1-time)/manual.length*1000;
    if(time===1)manual=undefined;
  }
  try{draw(now/1000);}catch(error){fail(error);return;}
  if(automatic||manual)schedule();
}

function schedule(){
  if(frame===undefined&&!stop.signal.aborted)frame=requestAnimationFrame(frameAt);
}

function wire(){
  const options={signal:stop.signal};
  slider.addEventListener('input',()=>{
    cancelCycle();
    const end=Number(slider.value)/100;
    manual={start:lift,end,time:performance.now(),length:205+140*Math.abs(lift-end)};
    interacted=true;
    schedule();
  },options);
  button.addEventListener('click',()=>{
    manual=undefined;
    if(automatic)cancelCycle();
    else {
      automatic={start:lift,time:performance.now()};
      button.textContent='Stop cycle';
    }
    interacted=true;
    schedule();
  },options);
}

function dispose(){
  stop.abort();
  if(frame!==undefined)cancelAnimationFrame(frame);
  observer?.disconnect();
  exhibit?.dispose();
  engine?.dispose();
}

function fail(error){
  if(stop.signal.aborted)return;
  document.body.dataset.state='error';
  loading.hidden=false;
  loading.textContent='The bellows could not open. '+(error?.message??error);
  button.disabled=slider.disabled=true;
  dispose();
  console.error(error);
}

async function start(){
  resize();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:true,
    camera:{near:.034,far:8,fov:38},signal:stop.signal});
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const compatibility=!engine;
  if(compatibility){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:stop.signal});
    engine=await open();
  }
  performance.mark('margo-engine-ready');
  engine.onError=fail;
  engine.scene.background='#42413c';
  engine.lighting.direction.set([-.42,.751,.49,2.50]);
  engine.lighting.radiance.set([1,.927,.82,.59]);
  engine.lighting.ambient.set([.54,.655,.753]);
  const shadows=Shadows.attach(engine,{
    bounds:{min:[-.43,-.014,-.23],max:[.63,.52,.23]},resolution:1024,filter:'pcf',normalBias:.001,
  });
  exhibit=buildBellows(engine,shadows,lift);
  performance.mark('margo-geometry-ready');
  draw(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(stop.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(resize())schedule();});
  observer.observe(canvas);
  button.disabled=slider.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=compatibility?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);
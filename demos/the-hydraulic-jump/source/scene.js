import { Engine } from '@margoengine/core';
import { createMesh } from '@margoengine/materials';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { bed, jumpToe, maximumSpeed, minimumSpeed, solve, upstreamDepth } from './hydraulics.js';
import { setDressing } from './scenery.js';
import { buildWater } from './water.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('speed');
const pause=document.getElementById('pause');
const [speed,depth,froude,energy]=['speed-value','depth2','froude','energy'].map(id=>document.getElementById(id));
const labels=['approach','roller','tailwater'].map(id=>document.getElementById(id));
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projection={x:0,y:0,z:0};
const meshes=[];
let engine,water,scenery,observer,pending,previous,model;
let time=0,framing=true,placingLabels=true,fresh=false,paused=false;

function measure(){
  const scale=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*scale));
  const h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;framing=true;
  return true;
}

function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const yaw=.43,pitch=.35,target=[.226,.197,0];
  const distance=Math.max(3.13,(5.00+.35*Math.max(0,1.65-aspect))/aspect);
  const level=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*level,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*level];
  engine.camera.target=target;
  placingLabels=true;
}

function labelPositions(){
  const anchors=[[-1.080,bed+upstreamDepth+.071,.024], [jumpToe+.43*model.roller,bed+upstreamDepth+.57*model.depthRise+.097,-.028],
    [1.112,bed+model.downstreamDepth+.082,.025]];
  const w=canvas.clientWidth,h=canvas.clientHeight;
  for(const [i,[x,y,z]] of anchors.entries()){
    const tag=labels[i];
    worldToScreen({x,y,z},engine.camera,w,h,projection);
    const left=Math.min(w-tag.offsetWidth-5,Math.max(5,projection.x-tag.offsetWidth*.5));
    const top=Math.max(6,Math.min(h-30,projection.y-tag.offsetHeight));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  }
}

function readControl(){
  model=solve(Number(slider.value));
  speed.value=model.speed.toFixed(2)+' m/s';
  depth.value=(model.downstreamDepth*100).toFixed(1);
  froude.value=model.f1.toFixed(2);
  energy.value=(100*model.dissipation).toFixed(1);
  slider.setAttribute('aria-valuetext',model.speed.toFixed(2)+' meters per second');
  slider.style.setProperty('--progress',(100*(model.speed-minimumSpeed)/(maximumSpeed-minimumSpeed))+'%');
  document.body.dataset.speed=model.speed.toFixed(2);
  placingLabels=true;
}
function motionText(){
  pause.textContent=reduced.matches?'Step water':paused?'Resume water':'Pause water';
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':'playing';
}
function draw(){
  if(framing)aim();
  water.update(model,time);
  engine.render({delta:0});
  if(placingLabels){labelPositions();placingLabels=false;}
  framing=false;
  if(fresh&&!performance.getEntriesByName('margo-first-input-applied').length){
    performance.mark('margo-first-input-applied');
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!controller.signal.aborted)performance.mark('margo-first-input-rendered');
    }).catch(fail);
  }
  fresh=false;
}
function animate(now){
  pending=undefined;
  if(controller.signal.aborted)return;
  const moving=!paused&&!reduced.matches&&!document.hidden;
  if(moving&&previous!==undefined)time+=Math.min(.07,(now-previous)/1000)*.65;
  previous=moving?now:undefined;
  try{draw();}
  catch(error){fail(error);return;}
  if(moving)schedule();
}
function schedule(){
  if(pending===undefined&&!controller.signal.aborted)pending=requestAnimationFrame(animate);
}
function wire(){
  const options={signal:controller.signal};
  slider.addEventListener('input',()=>{
    readControl();fresh=true;schedule();
  },options);
  pause.addEventListener('click',()=>{
    if(reduced.matches)time+=.14;
    else paused=!paused;
    previous=undefined;motionText();fresh=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;motionText();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  controller.abort();
  if(pending!==undefined)cancelAnimationFrame(pending);
  observer?.disconnect();
  for(const mesh of meshes.reverse())mesh.dispose();
  water?.dispose();scenery?.dispose();engine?.dispose();
}
function fail(error){
  if(controller.signal.aborted)return;
  document.body.dataset.state='error';loading.hidden=false;
  loading.textContent='The flume could not open. '+(error?.message??error);
  pause.disabled=slider.disabled=true;
  dispose();console.error(error);
}
async function start(){
  measure();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,camera:{near:.11,far:18,fov:42},signal:controller.signal,
  });
  if(!force){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal:controller.signal});engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#685b56';
  engine.lighting.direction.set([-.54,.78,.45,2.70]);
  engine.lighting.radiance.set([1,.91,.77,.59]);
  engine.lighting.ambient.set([.54,.67,.73]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-1.81,-.024,-.48],max:[1.81,.91,.50]},
    resolution:1024,filter:'pcf',normalBias:.003});
  const add=(geometry,material,name,shadow,renderOrder=0)=>{
    const mesh=createMesh(engine,geometry,material,{renderOrder});
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow!=='receive',receiveShadow:shadow!=='cast-only'});
    return mesh;
  };
  readControl();motionText();
  scenery=setDressing(add);water=buildWater(add,model);draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(controller.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(measure())schedule();});
  observer.observe(canvas);
  slider.disabled=pause.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
await start().catch(fail);

import { Engine } from '@margoengine/core';
import { createMesh } from '@margoengine/materials';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { assemble } from './bench.js';
import { dye } from './dye.js';
import { maxDiameter,minDiameter,solve,unobstructed } from './pressure.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('diameter');
const pause=document.getElementById('pause');
const [diameter,flow,peak,reduction]=['diameter-value','flow','peak','reduction'].map(id=>document.getElementById(id));
const labels=['inlet','disk','outlet'].map(id=>document.getElementById(id));
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projection={x:0,y:0,z:0};
const meshes=[];
let engine,bench,ink,observer,pending,previous,model;
let time=0,framing=true,fresh=false,paused=false;
let requested=Number(slider.value);

function measure(){
  const scale=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;framing=true;
  return true;
}

function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const yaw=-.26,pitch=.78,target=[-.006,.092,.057];
  const distance=Math.max(.745,(1.065+.13*Math.max(0,1.45-aspect))/aspect);
  const plane=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*plane,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*plane];
  engine.camera.target=target;
}

function labelPositions(){
  const anchors=[[-.238,.150,-.085],[.010,.168,-.062],[.238,.150,-.080]];
  const w=canvas.clientWidth,h=canvas.clientHeight;
  for(const [i,[x,y,z]] of anchors.entries()){
    const tag=labels[i];
    worldToScreen({x,y,z},engine.camera,w,h,projection);
    const left=Math.min(w-tag.offsetWidth-5,Math.max(5,projection.x-tag.offsetWidth*.5));
    const top=Math.max(6,Math.min(h-30,projection.y-tag.offsetHeight));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  }
}

function updateControl(){
  model=solve(requested);
  diameter.value=model.diameter+' mm';
  flow.value=(model.inletFlow*6e7).toFixed(2);
  peak.value=(model.maxSpeed*1000).toFixed(2);
  reduction.value=(100*(1-model.inletFlow/unobstructed)).toFixed(1);
  slider.setAttribute('aria-valuetext',model.diameter+' millimeters');
  slider.style.setProperty('--progress',(100*(model.diameter-minDiameter)/(maxDiameter-minDiameter))+'%');
  document.body.dataset.diameter=String(model.diameter);
  bench?.radius(model.radius);
}
function motionText(){
  pause.textContent=reduced.matches?'Step dye':paused?'Resume dye':'Pause dye';
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':'playing';
}
function draw(){
  if(framing)aim();
  if(model.diameter!==requested)updateControl();
  ink.update(model,time);
  engine.render({delta:0});
  if(framing)labelPositions();
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
  if(moving&&previous!==undefined)time+=Math.min(.09,(now-previous)/1000);
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
    requested=Number(slider.value);fresh=true;schedule();
  },options);
  pause.addEventListener('click',()=>{
    if(reduced.matches)time+=.47;
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
  ink?.dispose();bench?.dispose();engine?.dispose();
}
function fail(error){
  if(controller.signal.aborted)return;
  document.body.dataset.state='error';loading.hidden=false;
  loading.textContent='The glass cell could not open. '+(error?.message??error);
  pause.disabled=slider.disabled=true;
  dispose();console.error(error);
}
async function start(){
  measure();
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,camera:{near:.042,far:9,fov:42},signal:controller.signal,
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
  engine.scene.background='#6a837b';
  engine.lighting.direction.set([-.47,.75,.50,2.81]);
  engine.lighting.radiance.set([1,.92,.78,.52]);
  engine.lighting.ambient.set([.61,.74,.76]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.38,-.023,-.22],max:[.38,.215,.24]},
    resolution:1024,filter:'pcf',normalBias:.0018});
  const add=(geometry,material,name,shadow,renderOrder=0)=>{
    const mesh=createMesh(engine,geometry,material,{renderOrder});
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow==='cast'});
    return mesh;
  };
  bench=assemble(add);
  updateControl();motionText();ink=dye(add,model);draw();
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

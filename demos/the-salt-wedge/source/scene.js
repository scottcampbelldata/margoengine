import { Engine } from '@margoengine/core';
import { LineBatches } from '@margoengine/lines/batch';
import { createMesh } from '@margoengine/materials';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { makeCoast } from './coast.js';
import { bed,maxDischarge,minDischarge,nearZ,position,solve,surface } from './estuary.js';
import { makeWater } from './water.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('discharge');
const pause=document.getElementById('pause');
const [discharge,reach,depth]=['flow-value','reach','depth'].map(id=>document.getElementById(id));
const anchors=['fresh','salt','toe'].map(id=>document.getElementById(id));
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projected={x:0,y:0,z:0};
const meshes=[];
let engine,coast,water,observer,pending,previous,model;
let time=0,framing=true,fresh=false,paused=false,placing=true;

function measure(){
  const dpr=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;framing=true;
  return true;
}
function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const yaw=.228,pitch=.320,target=[.130,.230,-.091];
  const distance=Math.max(1.34,(2.285+.19*Math.max(0,1.4-aspect))/aspect);
  const plane=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*plane,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*plane];
  engine.camera.target=target;
}
function locate(){
  const points=[
    [-.344,surface+.028,nearZ],
    [.634,bed+(surface-bed)*(1-model.mouthFraction)*.57,nearZ+.0009],
    [position(model.length),bed-.018,nearZ+.003],
  ];
  const w=canvas.clientWidth,h=canvas.clientHeight;
  for(const [i,[x,y,z]] of points.entries()){
    const tag=anchors[i];
    worldToScreen({x,y,z},engine.camera,w,h,projected);
    const left=Math.min(w-tag.offsetWidth-5,Math.max(5,projected.x-tag.offsetWidth*.5));
    const top=Math.max(6,Math.min(h-29,projected.y-(i===2?0:tag.offsetHeight)));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  }
}
function choose(){
  model=solve(Number(slider.value));
  discharge.value=model.discharge+' m³/s';
  reach.value=String(Math.round(model.length));
  depth.value=model.mouthSalt.toFixed(2);
  slider.setAttribute('aria-valuetext',model.discharge+' cubic meters per second');
  slider.style.setProperty('--progress',(100*(model.discharge-minDischarge)/(maxDischarge-minDischarge))+'%');
  document.body.dataset.discharge=String(model.discharge);
  placing=true;
}
function motion(){
  pause.textContent=reduced.matches?'Step tracers':paused?'Resume tracers':'Pause tracers';
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':'playing';
}
function draw(){
  if(framing)aim();
  if(framing||placing)locate();
  water.update(model,time);
  engine.render({delta:0});
  framing=placing=false;
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
  if(moving&&previous!==undefined)time+=Math.min(.085,(now-previous)/1000);
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
  slider.addEventListener('input',()=>{choose();fresh=true;schedule();},options);
  pause.addEventListener('click',()=>{
    if(reduced.matches)time+=.86;
    else paused=!paused;
    previous=undefined;motion();fresh=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;motion();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  controller.abort();
  if(pending!==undefined)cancelAnimationFrame(pending);
  observer?.disconnect();
  for(const mesh of meshes.reverse())mesh.dispose();
  water?.dispose();coast?.dispose();engine?.dispose();
}
function fail(error){
  if(controller.signal.aborted)return;
  document.body.dataset.state='error';loading.hidden=false;
  loading.textContent='The estuary could not open. '+(error?.message??error);
  pause.disabled=slider.disabled=true;
  dispose();console.error(error);
}
async function initialize(installCompatibility){
  measure();
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,camera:{near:.057,far:12,fov:42},signal:controller.signal,
  });
  if(!installCompatibility){
    try{engine=await open();}
    catch(error){if(error?.code!=='unsupported')throw error;}
  }
  const fallback=!engine;
  if(fallback){
    const install=installCompatibility??(await import('@margoengine/webgl2-compat')).install;
    await install({force:true,signal:controller.signal});engine=await open();
  }
  engine.onError=fail;
  engine.scene.background='#9aaf9f';
  engine.lighting.direction.set([-.54,.79,.37,2.72]);
  engine.lighting.radiance.set([1,.94,.82,.60]);
  engine.lighting.ambient.set([.56,.69,.69]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.75,-.02,-.42],max:[.85,.52,.125]},
    resolution:1024,filter:'pcf',normalBias:.0025});
  const add=(geometry,material,name,shadow,renderOrder=0)=>{
    const mesh=createMesh(engine,geometry,material,{renderOrder});
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow==='cast'});
    return mesh;
  };
  choose();motion();coast=makeCoast(add);water=makeWater(add,model,LineBatches.attach(engine));draw();
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
export function start(installCompatibility){return initialize(installCompatibility).catch(fail);}

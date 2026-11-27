import { Engine } from '@margoengine/core';
import { createMesh } from '@margoengine/materials';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { createDye } from './dye.js';
import { assemble,gradeX } from './tank.js';
import { coreAt,maximumCirculation,minimumCirculation,playback,prepare,riseAt,speedAt,startY } from './vortex.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('circulation');
const pause=document.getElementById('pause'),replay=document.getElementById('replay');
const marker=document.getElementById('scale');
const [strength,speed,rise,core,clock]=['strength','speed','rise','core','clock'].map(id=>document.getElementById(id));
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projection={x:0,y:0,z:0};
const meshes=[];
let engine,apparatus,dye,observer,pending,previous,model,oldModel,oldAge;
let age=3.5,framing=true,fresh=false,paused=false;

function measure(){
  const dpr=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;framing=true;
  return true;
}
function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const yaw=.209,pitch=.301,target=[.021,.198,.009];
  const distance=Math.max(.765,(.838+.09*Math.max(0,1.40-aspect))/aspect);
  const plane=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*plane,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*plane];
  engine.camera.target=target;
}
function locateMarker(height){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  worldToScreen({x:gradeX+.015,y:startY+height,z:.034},engine.camera,w,h,projection);
  const left=Math.max(5,Math.min(w-marker.offsetWidth-5,projection.x+6));
  const top=Math.max(6,Math.min(h-30,projection.y-marker.offsetHeight*.50));
  marker.style.transform='translate('+left+'px,'+top+'px)';
}
function choose(){
  model=prepare(Number(slider.value));
  if(age>model.duration)age=model.duration;
  strength.value=model.circulation+' cm²/s';
  slider.setAttribute('aria-valuetext',model.circulation+' square centimeters per second');
  slider.style.setProperty('--progress',(100*(model.circulation-minimumCirculation)/(maximumCirculation-minimumCirculation))+'%');
  document.body.dataset.circulation=String(model.circulation);
}
function motion(){
  const done=age>=model.duration;
  if(reduced.matches)pause.textContent=done?'Ring at limit':'Step +1 s';
  else pause.textContent=paused?'Resume':done?'Ring at limit':'Pause';
  pause.disabled=done;
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':done?'complete':'playing';
}
function draw(){
  if(framing)aim();
  const height=riseAt(model,age);
  if(oldModel!==model||oldAge!==age||framing){
    apparatus.positionCursor(height);locateMarker(height);
    dye.update(model,age);
    speed.value=(100*speedAt(model,age)).toFixed(2);
    rise.value=(100*height).toFixed(1);
    core.value=(1000*coreAt(age)).toFixed(1);
    clock.value=age.toFixed(1)+' s';
    oldModel=model;oldAge=age;
  }
  engine.render({delta:0});
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
  const moving=!paused&&!reduced.matches&&!document.hidden&&age<model.duration;
  if(moving&&previous!==undefined)age=Math.min(model.duration,age+Math.min(.085,(now-previous)/1000)*playback);
  previous=moving?now:undefined;
  try{draw();}
  catch(error){fail(error);return;}
  if(moving&&age<model.duration)schedule();
  else motion();
}
function schedule(){
  if(pending===undefined&&!controller.signal.aborted)pending=requestAnimationFrame(animate);
}
function wire(){
  const options={signal:controller.signal};
  slider.addEventListener('input',()=>{choose();motion();fresh=true;schedule();},options);
  pause.addEventListener('click',()=>{
    if(reduced.matches)age=Math.min(model.duration,age+1);
    else paused=!paused;
    previous=undefined;motion();fresh=true;schedule();
  },options);
  replay.addEventListener('click',()=>{
    age=0;paused=false;previous=undefined;motion();fresh=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;motion();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  controller.abort();
  if(pending!==undefined)cancelAnimationFrame(pending);
  observer?.disconnect();
  for(const mesh of meshes.reverse())mesh.dispose();
  dye?.dispose();apparatus?.dispose();engine?.dispose();
}
function fail(error){
  if(controller.signal.aborted)return;
  document.body.dataset.state='error';loading.hidden=false;
  loading.textContent='The tank could not open. '+(error?.message??error);
  pause.disabled=replay.disabled=slider.disabled=true;
  dispose();console.error(error);
}
async function initialize(installCompatibility){
  measure();
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,camera:{near:.055,far:9,fov:41},signal:controller.signal,
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
  engine.scene.background='#162034';
  engine.lighting.direction.set([-.57,.71,.46,2.92]);
  engine.lighting.radiance.set([1,.93,.86,.58]);
  engine.lighting.ambient.set([.47,.55,.69]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.27,-.018,-.20],max:[.27,.46,.21]},
    resolution:1024,filter:'pcf',normalBias:.0017});
  const add=(geometry,material,name,shadow,renderOrder=0)=>{
    const mesh=createMesh(engine,geometry,material,{renderOrder});
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow==='cast'});
    return mesh;
  };
  choose();apparatus=assemble(add);dye=createDye(add,model,age);draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(controller.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(measure())schedule();});
  observer.observe(canvas);
  slider.disabled=replay.disabled=false;motion();
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
export function start(installCompatibility){return initialize(installCompatibility).catch(fail);}

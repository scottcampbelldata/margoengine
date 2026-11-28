import { Engine } from '@margoengine/core';
import { createMesh } from '@margoengine/materials';
import { worldToScreen } from '@margoengine/math';
import { Shadows } from '@margoengine/shadows';
import { makeGarden,studioMap } from './garden.js';
import { heightAt,maximumAngle,minimumAngle,playback,positions,prepare } from './rise.js';
import { makeRisers,riserZ } from './risers.js';

const canvas=document.getElementById('scene');
const loading=document.getElementById('loading');
const slider=document.getElementById('wetting');
const pause=document.getElementById('pause'),replay=document.getElementById('replay');
const [angle,narrow,wide,clock]=['angle','narrow','wide','clock'].map(id=>document.getElementById(id));
const labels=[...document.querySelectorAll('.riser')];
const controller=new AbortController();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const projection={x:0,y:0,z:0};
const meshes=[];
const endTime=360;
let engine,garden,risers,observer,pending,previous,model,maps;
let time=32,framing=true,fresh=false,paused=false,priorModel,priorTime;

function measure(){
  const dpr=Math.min(1.70,Math.max(1.20,devicePixelRatio));
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(w===canvas.width&&h===canvas.height)return false;
  canvas.width=w;canvas.height=h;framing=true;
  return true;
}
function aim(){
  const aspect=canvas.clientWidth/Math.max(canvas.clientHeight,1);
  const yaw=-.122,pitch=.180,target=[.006,.191,-.015];
  const distance=Math.max(.600,(.967+.14*Math.max(0,1.42-aspect))/aspect);
  const plane=distance*Math.cos(pitch);
  engine.camera.position=[target[0]+Math.sin(yaw)*plane,target[1]+Math.sin(pitch)*distance,target[2]+Math.cos(yaw)*plane];
  engine.camera.target=target;
}
function placeLabels(){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  for(const [i,x] of positions.entries()){
    const tag=labels[i];
    worldToScreen({x,y:.062,z:riserZ+.068},engine.camera,w,h,projection);
    const left=Math.min(w-tag.offsetWidth-5,Math.max(5,projection.x-tag.offsetWidth*.5));
    const top=Math.max(6,Math.min(h-30,projection.y-tag.offsetHeight*.5));
    tag.style.transform='translate('+left+'px,'+top+'px)';
  }
}
function updateControl(){
  model=prepare(Number(slider.value));
  angle.value=model.angle+'°';
  narrow.value=(model.tubes[0].heightLimit*1000).toFixed(1);
  wide.value=(model.tubes.at(-1).heightLimit*1000).toFixed(1);
  slider.setAttribute('aria-valuetext',model.angle+' degree contact angle');
  slider.style.setProperty('--progress',(100*(model.angle-minimumAngle)/(maximumAngle-minimumAngle))+'%');
  document.body.dataset.angle=String(model.angle);
}
function updateMotion(){
  pause.textContent=reduced.matches?'Step +5 s':paused?'Resume':'Pause';
  document.body.dataset.motion=reduced.matches?'stepping':paused?'paused':'playing';
}
function draw(){
  if(framing)aim();
  if(priorModel!==model||priorTime!==time){
    const heights=model.tubes.map(tube=>heightAt(tube,time));
    risers.set(heights,model.angle);
    const reading=time.toFixed(1)+' s';
    if(clock.value!==reading)clock.value=reading;
    priorModel=model;priorTime=time;
  }
  engine.render({delta:0});
  if(framing)placeLabels();
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
  const moving=!paused&&!reduced.matches&&!document.hidden&&time<endTime;
  if(moving&&previous!==undefined)time=Math.min(endTime,time+Math.min(.080,(now-previous)/1000)*playback);
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
  slider.addEventListener('input',()=>{updateControl();fresh=true;schedule();},options);
  pause.addEventListener('click',()=>{
    if(reduced.matches)time=Math.min(endTime,time+5);
    else paused=!paused;
    previous=undefined;updateMotion();fresh=true;schedule();
  },options);
  replay.addEventListener('click',()=>{
    time=0;paused=false;previous=undefined;updateMotion();fresh=true;schedule();
  },options);
  reduced.addEventListener('change',()=>{previous=undefined;updateMotion();schedule();},options);
  document.addEventListener('visibilitychange',()=>{previous=undefined;schedule();},options);
}
function dispose(){
  controller.abort();
  if(pending!==undefined)cancelAnimationFrame(pending);
  observer?.disconnect();
  for(const mesh of meshes.reverse())mesh.dispose();
  risers?.dispose();garden?.dispose();
  if(maps)for(const texture of Object.values(maps))texture.dispose();
  engine?.dispose();
}
function fail(error){
  if(controller.signal.aborted)return;
  document.body.dataset.state='error';loading.hidden=false;
  loading.textContent='The glasshouse could not open. '+(error?.message??error);
  pause.disabled=replay.disabled=slider.disabled=true;
  dispose();console.error(error);
}
async function initialize(installCompatibility){
  measure();
  const open=()=>Engine.create(canvas,{
    backend:'webgpu',exactSize:true,antialias:true,camera:{near:.046,far:9,fov:43},signal:controller.signal,
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
  engine.scene.background='#a4b68e';
  engine.lighting.direction.set([-.57,.78,.39,2.70]);
  engine.lighting.radiance.set([1,.94,.80,.61]);
  engine.lighting.ambient.set([.57,.68,.67]);
  const shadows=Shadows.attach(engine,{bounds:{min:[-.49,-.024,-.39],max:[.47,.47,.20]},
    resolution:1024,filter:'pcf',normalBias:.0022});
  const add=(geometry,material,name,shadow,renderOrder=0)=>{
    const mesh=createMesh(engine,geometry,material,{renderOrder});
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow==='cast'});
    return mesh;
  };
  maps={metal:studioMap([100,113,105],[145,125,105]),water:studioMap([26,101,139],[100,123,108]),column:studioMap([15,50,105],[67,118,120])};
  garden=makeGarden(add,maps);risers=makeRisers(add,maps);
  updateControl();updateMotion();draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(controller.signal.aborted)return;
  wire();
  observer=new ResizeObserver(()=>{if(measure())schedule();});
  observer.observe(canvas);
  slider.disabled=pause.disabled=replay.disabled=false;
  loading.hidden=true;
  document.body.dataset.renderer=fallback?'compatibility':'webgpu';
  document.body.dataset.state='ready';
  performance.mark('margo-first-usable-frame');
  schedule();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
export function start(installCompatibility){return initialize(installCompatibility).catch(fail);}

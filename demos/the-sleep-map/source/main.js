import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';
import {bays,pellets,count,frequency} from './layout.js';
import {makeCase,selectionHardware,pelletGeometry,pelletMaterials,cameraFor,setLights} from './art.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error'),debug=by('debug');
const buttons=bays.map(({id})=>by('bed-'+id.toLowerCase()));
const outputs=['awake','asleep','islands'].map(by);
const status=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
let simulation,owner,recent,firstControl=false,debugWanted=false,drawDebug,debugOpening;
const queuedStrikes=[];
let selected=-1,ready=false,rendering=false,resize=true,raf=0,lastStep=0,pressStart=0,ambientStart=0;
let ceramics=[],materials=[],indicators=[],plungers=[];
const previousFlags=new Int8Array(count).fill(-1);
const fallbackCodes=['unsupported','adapter','device','timeout','startup'];

function fail(reason){
  if(signal.aborted||status.failed)return;
  for(const control of [...buttons,debug])control.disabled=true;
  loading.hidden=true;error.hidden=false;
  status.error(reason);
}
async function read({steps,strikes=[],debug}){
  const world=await simulationOpening;
  signal.throwIfAborted();
  for(const bay of strikes)world.strike(bay);
  if(steps)world.step(steps);
  return world.state(debug);
}
function size(){
  const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.65,1350/width);
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(!w||!h||canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function openEngine(){
  const options={backend:'webgpu',exactSize:true,antialias:true,signal,startupWarning:3000,startupTimeout:9000,
    camera:cameraFor(canvas.width,canvas.height)};
  if(!forced&&navigator.gpu){
    try{
      const result=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return result;
    }catch(reason){
      signal.throwIfAborted();
      if(reason?.code&&!fallbackCodes.includes(reason.code))throw reason;
    }
  }
  const {webglRenderer}=await import('@margoengine/webgl2-compat/preview');
  const result=await Engine.create(canvas,{...options,backend:'webgl2',fallback:webglRenderer});
  viewport.dataset.renderer='webgl2';
  return result;
}
async function painted(){
  if(owner.gpu)await owner.gpu.queue.onSubmittedWorkDone();
  else canvas.getContext('webgl2')?.finish();
  await waitFrame();
  signal.throwIfAborted();
}
function camera(){
  const view=cameraFor(canvas.width,canvas.height);
  owner.camera.position=view.position;owner.camera.target=view.target;owner.camera.fov=view.fov;
}
function add(parts,parent){
  for(const {geometry,material} of parts)owner.createMesh(parent).setGeometry(geometry).setMaterial(material);
}
function makeObjects(art){
  setLights(owner);
  add(art.structure);
  const geometry=pelletGeometry(),hardware=selectionHardware();
  materials=pelletMaterials();
  ceramics=pellets.map(({x,y,z,shade})=>owner.createMesh().setGeometry(geometry).setMaterial(materials[1][shade]).setPosition([x,y,z]));
  for(const {center:[x,z]} of bays){
    const glow=owner.createMesh().setPosition([x,0,z]);
    add(hardware.marker,glow);glow.visible=false;
    const raised=owner.createMesh(),plain=owner.createMesh();
    add(hardware.selected,raised);add(hardware.other,plain);
    plungers.push({raised,plain,x:x+.236,z:z+.319});
    indicators.push(glow);
  }
  hardwareState(0);
}
function hardwareState(now){
  const phase=Math.max(0,Math.min(1,(now-pressStart)/270));
  const depression=pressStart?Math.sin(Math.PI*phase)*.016:0;
  for(let i=0;i<plungers.length;i++){
    const active=i===selected;
    const {raised,plain,x,z}=plungers[i];
    raised.visible=indicators[i].visible=active;
    plain.visible=!active;
    raised.setPosition([x,.180-depression,z]);plain.setPosition([x,.180,z]);
  }
}
function put(state){
  const {positions,flags}=state;
  for(let i=0;i<count;i++){
    const base=i*3;
    ceramics[i].setPosition([positions[base],positions[base+1],positions[base+2]]);
    if(flags[i]!==previousFlags[i]){
      ceramics[i].setMaterial(materials[flags[i]][pellets[i].shade]);
      previousFlags[i]=flags[i];
    }
  }
  drawDebug?.(debugWanted?state.traces:null);
}
function show(state){
  const {byBay,islands,step,serial,positions,contacts,links,traces}=state;
  const awake=byBay.reduce((sum,n)=>sum+n,0),values=[awake,count-awake,islands];
  for(let i=0;i<values.length;i++)if(outputs[i].value!==String(values[i]))outputs[i].value=values[i];
  Object.assign(viewport.dataset,{awake:String(awake),islands:String(islands),beds:byBay.join(','),step:String(step),
    serial:String(serial),contacts:String(contacts),links:String(links),selected:bays[selected]?.id??'',
    centerHeights:bays.map((_,i)=>positions[(i*count/4)*3+1].toFixed(5)).join(','),
    debugSegments:String(debugWanted&&traces?traces.vertices.length/6:0)});
}
function schedule(){
  if(raf||rendering||!ready||signal.aborted||status.failed)return;
  raf=requestAnimationFrame(update);
}
async function update(now){
  raf=0;rendering=true;
  try{
    const strikes=queuedStrikes.splice(0);
    const struck=strikes.length>0;
    const priorAwake=recent.byBay.some(Boolean);
    const run=struck||priorAwake&&now>=ambientStart&&now-lastStep>=27;
    const newDebug=debugWanted&&!recent.traces&&drawDebug;
    if(run||newDebug){
      const dt=struck?1:Math.max(1,Math.min(4,Math.round((now-lastStep)*frequency/1000)));
      lastStep=now;
      recent=await read({steps:run?dt:0,strikes,debug:debugWanted&&!!drawDebug});
      signal.throwIfAborted();
      put(recent);
    }
    if(run||resize||newDebug||pressStart&&now-pressStart<295){
      camera();hardwareState(now);resize=false;
      owner.render({delta:0});
      if(struck&&!firstControl){
        await painted();
        firstControl=true;performance.mark('first-control-frame');
      }
      show(recent);
    }
  }catch(reason){fail(reason);}
  finally{
    rendering=false;
    if(queuedStrikes.length||resize||recent?.byBay.some(Boolean)||pressStart&&performance.now()-pressStart<310||
      debugWanted&&drawDebug&&!recent?.traces)schedule();
  }
}
function hit(i){
  for(const [index,button] of buttons.entries())button.dataset.selected=String(index===i);
  selected=i;queuedStrikes.push(i);pressStart=performance.now();
  if(!firstControl)performance.mark('first-strike-input');
  schedule();
}
function toggleDebug(){
  debugWanted=!debugWanted;
  debug.setAttribute('aria-pressed',String(debugWanted));
  debug.textContent=debugWanted?'Hide springs and contacts':'Show springs and contacts';
  resize=true;
  if(!debugWanted){
    drawDebug?.(null);
    if(recent)recent.traces=null;
    schedule();return;
  }
  debugOpening??=import('./debug-draw.js').then(({attachDebug})=>{
    signal.throwIfAborted();drawDebug=attachDebug(owner);schedule();
  }).catch(fail);
  schedule();
}
size();
const simulationOpening=import('./physics.js').then(({createSimulation})=>createSimulation(signal)).then(world=>{
  if(signal.aborted){world.dispose();signal.throwIfAborted();}
  simulation=world;
  performance.mark('kernel-ready');
  return world;
});
const first=read({steps:0,debug:false});
first.catch(fail);
const structure=Promise.resolve().then(()=>makeCase());
const observer=new ResizeObserver(()=>{if(size()){resize=true;schedule();}});
async function boot(){
  owner=await openEngine();
  signal.throwIfAborted();
  owner.onError=fail;
  performance.mark('engine-ready');
  makeObjects({structure:await structure});
  camera();resize=false;
  owner.render({delta:0});
  await painted();
  performance.mark('bench-frame');
  recent=await first;
  signal.throwIfAborted();
  put(recent);camera();owner.render({delta:0});
  await painted();
  show(recent);
  performance.mark('solver-frame');
  buttons.forEach((button,i)=>button.addEventListener('click',()=>hit(i),{signal}));
  debug.addEventListener('click',toggleDebug,{signal});
  observer.observe(canvas);
  if(status.ready()){
    ready=true;lastStep=performance.now();ambientStart=lastStep+260;
    for(const control of [...buttons,debug])control.disabled=false;
    loading.hidden=true;schedule();
  }
}
boot().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();simulation?.dispose();observer.disconnect();if(raf)cancelAnimationFrame(raf);
  owner?.dispose();
});

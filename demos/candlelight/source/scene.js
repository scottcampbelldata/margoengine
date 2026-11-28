import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {Bloom} from '@margoengine/post/bloom';
import {Clustered} from '@margoengine/clustered';
import {flameLight,flickerAt} from '@margoengine/clustered/flicker';
import {shadowBudget} from '@margoengine/clustered/budget';
import {installRoom,candles} from './room.js';
import {installFlames} from './flame.js';

const id=name=>document.getElementById(name), canvas=id('view'),tools=id('tools'),button=id('flicker');
const state=document.body.dataset,choices=[...document.querySelectorAll('[data-budget]')];
const lifetime=new AbortController(),{signal}=lifetime;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const preferReduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const formatter=new Intl.NumberFormat('en-US');
const bloomOptions={threshold:1.7,strength:.23,radius:.52,fireflies:"karis",exposure:.20};
const physical=candles.map((record,index)=>({position:record.flame,...flameLight({
  kelvin:record.kelvin,lumens:record.lumens,range:3.6,radius:.009,curve:'candle',seed:100+index*43,
  speed:.67+index*.092,
}),castShadow:true,shadow:{near:.024,far:3.6}}));
const budgetLimit={0:0,1:6*192*192,3:6*(192*192+2*96*96)};
let engine,clustered,emission,selected,observer,request,drag,epoch;
let animateAfter=Infinity,openingTimer,bloomTimer,bloom=false;
let anime=!preferReduced,time=0,budget=1,heading=.32,vertical=.226,revision=0,displayed=0,busy=false,needsPaint=true;
const anchor=[0,1.19,-.25],baseDistance=3.72;

function eye(){
  const level=baseDistance*Math.cos(vertical);
  return [anchor[0]+level*Math.sin(heading),anchor[1]+baseDistance*Math.sin(vertical),anchor[2]+level*Math.cos(heading)];
}
function allocate(){
  selected=budget?shadowBudget(physical,{viewer:eye(),texels:budgetLimit[budget],resolution:192,minResolution:64,maxLights:budget}):
    physical.map(source=>({...source,castShadow:false,shadow:false}));
  selected=selected.map(source=>source.castShadow?source:{...source,shadow:false});
  const size=selected.filter(source=>source.castShadow);
  id('maps').textContent=size.length+' flames · '+(size.length*6)+' faces';
  const allocated=size.reduce((sum,source)=>sum+6*source.shadow.resolution**2,0);
  id('allocation').textContent=formatter.format(allocated);
  state.allocation=String(allocated);
  state.shadowLights=String(size.length);
  state.shadowFaces=String(size.length*6);
  state.budget=String(budget);
  for(const item of choices)item.setAttribute('aria-pressed',String(+item.dataset.budget===budget));
}
function rasterSize(){
  const dpr=Math.min(1.68,Math.max(1,devicePixelRatio||1));
  return [Math.max(1,Math.round(canvas.clientWidth*dpr)),Math.max(1,Math.round(canvas.clientHeight*dpr))];
}
function paint(){
  const [width,height]=rasterSize();
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const camera=engine.camera;
  camera.position=eye();camera.target=anchor;
  state.yaw=heading.toFixed(3);state.pitch=vertical.toFixed(3);
  const factor=selected.map(light=>flickerAt(light.flicker.curve,time*light.flicker.speed,light.flicker.seed));
  const moonlight={position:[-1.37,2.23,-.95],intensity:.29,color:[.18,.36,1],range:1.58};
  clustered.setLights([...selected.map((light,i)=>({...light,intensity:light.intensity*factor[i]})),moonlight]);
  emission.set(selected,factor,time);
  state.time=time.toFixed(3);
  state.flames=String(selected.length);
  engine.render({delta:0});
}
function schedule(){
  if(request||busy||signal.aborted)return;
  request=requestAnimationFrame(async stamp=>{
    request=undefined;
    const expected=revision;
    const motion=anime&&stamp>=animateAfter;
    if(!motion&&!needsPaint&&expected===displayed)return;
    busy=true;
    try{
      if(motion&&epoch!==undefined)time+=Math.min(.075,(stamp-epoch)/1000);
      epoch=motion?stamp:undefined;
      paint();
      needsPaint=false;
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      displayed=expected;state.revision=String(displayed);
      if(bloom&&!state.bloom){state.bloom="true";performance.mark("candle-bloom-ready");}
      if(expected>0&&!performance.getEntriesByName('candle-first-budget').length)performance.mark('candle-first-budget');
    }catch(error){fail(error);}
    finally{busy=false;}
    if(motion||needsPaint||revision!==displayed)schedule();
  });
}
function move(yaw,pitch){
  heading=Math.max(-.83,Math.min(.89,yaw));
  vertical=Math.max(.06,Math.min(.71,pitch));
  allocate();needsPaint=true;schedule();
}
function updateMotion(){
  state.animating=String(anime);
  button.textContent=anime?'Pause flicker':'Start flicker';
  button.setAttribute('aria-pressed',String(anime));
}
function connect(){
  for(const entry of choices)entry.addEventListener('click',()=>{
    const next=+entry.dataset.budget;
    if(next===budget)return;
    budget=next;revision++;allocate();needsPaint=true;schedule();
  },{signal});
  button.addEventListener('click',()=>{anime=!anime;epoch=undefined;animateAfter=0;updateMotion();needsPaint=true;schedule();},{signal});
  id('reset').addEventListener('click',()=>move(.32,.226),{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,heading,vertical};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.pointer!==event.pointerId)return;
    move(drag.heading+(drag.x-event.clientX)*.007,drag.vertical+(event.clientY-drag.y)*.006);
  },{signal});
  for(const kind of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(kind,event=>{
    if(drag?.pointer===event.pointerId)drag=undefined;
  },{signal});
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:[-.105,0],ArrowRight:[.105,0],ArrowUp:[0,.09],ArrowDown:[0,-.09]}[event.key];
    if(!step)return;
    event.preventDefault();move(heading+step[0],vertical+step[1]);
  },{signal});
  observer=new ResizeObserver(()=>{
      const [width,height]=rasterSize();
      if(canvas.width===width&&canvas.height===height)return;
      needsPaint=true;schedule();
    });observer.observe(canvas);
}
async function loadCompat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
function prepareRoom(){
  const worker=new Worker(new URL("./room-worker.js",import.meta.url),{type:"module"});
  signal.addEventListener("abort",()=>worker.terminate(),{once:true});
  return new Promise((resolve,reject)=>{
    worker.addEventListener("message",event=>{worker.terminate();resolve(event.data);},{once:true});
    worker.addEventListener("error",event=>{worker.terminate();reject(event.error??Error(event.message));},{once:true});
    signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  });
}
async function start(){
  const geometry=prepareRoom();
  geometry.catch(fail);
  const known=forced||!navigator.gpu;
  if(known)await (await loadCompat()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw Error('The archive needs WebGPU or WebGL2.');
    engine=target;engine.onError=fail;
    performance.mark('candle-device');
    engine.scene.background='#232538';
    engine.lighting.direction.set([-2.7,2.7,1.4,.71]);
    engine.lighting.radiance.set([.43,.65,1,.095]);
    engine.lighting.ambient.set([.77,.87,1]);

    const room=installRoom(engine,await geometry);
    performance.mark("candle-room");
    clustered=Clustered.attach(engine,{tilesX:8,tilesY:5,slices:10,maxLightsPerCluster:8,shadows:{maxLights:3,resolution:192}});
    performance.mark("candle-clusters");
    for(const item of room.cast)clustered.addShadowCaster(item);
    performance.mark("candle-casters");
    emission=installFlames(engine);
    allocate();
    performance.mark('candle-model');
    paint();
    performance.mark('candle-submit');
    await engine.gpu.queue.onSubmittedWorkDone();
  },{backend:known?'webgpu':undefined,loadCompat,signal,exactSize:true,antialias:false,startupTimeout:9000,
    camera:{near:.055,far:18,fov:41}});
  signal.throwIfAborted();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  tools.disabled=false;id('status').hidden=true;state.ready='true';
  updateMotion();connect();
  performance.mark('margo-first-usable-frame');
  // Give the opening frame and a first tap priority over the continuous flicker.
  animateAfter=performance.now()+540;
  openingTimer=setTimeout(schedule,550);
  bloomTimer=setTimeout(addBloom,920);
}
function addBloom(){
  if(signal.aborted)return;
  if(busy){bloomTimer=setTimeout(addBloom,80);return;}
  try{
    Bloom.attach(engine,bloomOptions);
    bloom=true;needsPaint=true;schedule();
  }catch(error){fail(error);}
}
function dispose(){
  lifetime.abort();clearTimeout(openingTimer);clearTimeout(bloomTimer);cancelAnimationFrame(request);observer?.disconnect();emission?.dispose();engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  id('status').hidden=true;id('error').hidden=false;id('error').textContent=error.message;
  state.error=error.message;delete state.ready;console.error(error);dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);

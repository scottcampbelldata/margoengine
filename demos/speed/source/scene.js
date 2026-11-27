
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {PostStack} from '@margoengine/post/stack';
import {MotionBlur} from '@margoengine/post/motion-blur';
import {TAA} from '@margoengine/taa';
import {installSet} from './set.js';

const element=id=>document.getElementById(id),canvas=element('track'),controls=element('controls'),slider=element('shutter');
const choices=[...document.querySelectorAll('[data-shutter]')],state=document.body.dataset;
const lifetime=new AbortController(),{signal}=lifetime;
const fallback=new URLSearchParams(location.search).get('backend')==='webgl2'||!navigator.gpu;
const opening=1.17,velocity=23,turn=280/60*2*Math.PI,nominal=1/60;
let engine,rig,blur,taa,observer,request,clock,busy,openingTimer;
let running=!matchMedia('(prefers-reduced-motion: reduce)').matches;
let seconds=opening,angle=180,revision=0,displayed=0,needsPaint=false,animateAt=Infinity;

function raster(){
  const scale=Math.min(1.7,Math.max(1,devicePixelRatio||1));
  return [Math.max(1,Math.round(canvas.clientWidth*scale)),Math.max(1,Math.round(canvas.clientHeight*scale))];
}
function pose(t){
  rig.rotor.setRotation([0,t*turn,0]);
  rig.train.setPosition([28-velocity*(t%(95/velocity)),.025,-6.26]);
}
function aim(){
  const [width,height]=raster();
  const phone=canvas.clientWidth<650;
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  engine.camera.position=phone?[2.63,3.65,7.80]:[3.36,3.95,8.56];
  engine.camera.target=phone?[-.45,1.07,-2.56]:[-.06,1.00,-2.72];
  engine.camera.fov=phone?43:36;
}
function updateLabel(){
  slider.value=String(angle);
  element('angle').value=angle+'°';
  element('play').textContent=running?'Pause':'Play';
  element('motion-status').textContent=running?'Running':'Held frame';
  for(const button of choices)button.setAttribute('aria-pressed',String(+button.dataset.shutter===angle));
  state.running=String(running);
  state.shutter=String(angle);
}
function paint(delta,hold){
  aim();
  blur.options.shutter=angle/360;
  if(hold){
    pose(seconds-nominal);
    engine.render({delta:0});
  }
  pose(seconds);
  engine.render({delta});
  state.time=seconds.toFixed(4);
}
function schedule(){
  if(request||busy||signal.aborted)return;
  request=requestAnimationFrame(async stamp=>{
    request=undefined;
    const next=revision,moving=running&&stamp>=animateAt;
    if(!moving&&!needsPaint&&next===displayed)return;
    const delta=moving?Math.min(.045,Math.max(.004,(stamp-(clock??stamp-1000*nominal))/1000)):0;
    clock=moving?stamp:undefined;
    seconds+=delta;
    busy=true;needsPaint=false;
    try{
      paint(delta,!moving);
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      displayed=next;
      state.revision=String(next);
      if(next&&!performance.getEntriesByName('speed-exposure-applied').length)performance.mark('speed-exposure-applied');
    }catch(error){fail(error);}
    finally{busy=false;}
    if(moving||needsPaint||revision!==displayed)schedule();
  });
}
function change(){
  updateLabel();revision++;needsPaint=true;schedule();
}
function connect(){
  slider.addEventListener('input',()=>{angle=+slider.value;change();},{signal});
  for(const item of choices)item.addEventListener('click',()=>{
    const next=+item.dataset.shutter;
    if(next===angle)return;
    angle=next;change();
  },{signal});
  element('play').addEventListener('click',()=>{running=!running;clock=undefined;animateAt=0;change();},{signal});
  element('reset').addEventListener('click',()=>{seconds=opening;clock=undefined;change();},{signal});
  observer=new ResizeObserver(()=>{
    const [width,height]=raster();
    if(canvas.width===width&&canvas.height===height)return;
    needsPaint=true;schedule();
  });
  observer.observe(canvas);
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  if(fallback)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;
    performance.mark('speed-device');
    engine.scene.background='#2e4550';
    engine.lighting.direction.set([-1.2,2.90,4.8,2.82]);
    engine.lighting.radiance.set([1,.89,.73,.78]);
    engine.lighting.ambient.set([.58,.71,.86]);
    rig=installSet(engine);
    performance.mark('speed-model');
    blur=new MotionBlur({velocity:()=>taa?.velocity,shutter:.5,maxBlur:42,samples:21});
    const stack=PostStack.attach(engine,[blur]);
    taa=TAA.attach(engine,{velocityOnly:true,depth:()=>stack.depthTexture});
    performance.mark('speed-pipeline');
    paint(0,true);
    performance.mark('speed-submit');
    await engine.gpu.queue.onSubmittedWorkDone();
  },{backend:fallback?'webgpu':undefined,loadCompat:compat,signal,exactSize:true,antialias:false,camera:{near:.055,far:150,fov:42}});
  signal.throwIfAborted();
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  state.ready='true';state.revision='0';
  controls.disabled=false;updateLabel();connect();
  element('loading').hidden=true;
  performance.mark('margo-first-usable-frame');
  animateAt=performance.now()+420;
  openingTimer=setTimeout(schedule,435);
}
function dispose(){
  lifetime.abort();cancelAnimationFrame(request);clearTimeout(openingTimer);observer?.disconnect();engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  delete state.ready;
  state.error=error.message;
  element('loading').hidden=true;element('error').textContent=error.message;element('error').hidden=false;
  console.error(error);dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);


import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {GTAO} from '@margoengine/post/gtao';
import {installSculpture} from './sculpture.js';

const el=id=>document.getElementById(id),canvas=el('sculpture'),control=el('controls');
const modes=[...document.querySelectorAll('[data-mode]')],slider=el('radius'),status=document.body.dataset;
const lifetime=new AbortController(),{signal}=lifetime;
const force=new URLSearchParams(location.search).get('backend')==='webgl2'||!navigator.gpu;
const topic={
  off:'Ambient light reaches the scene without an occlusion estimate.',
  ssao:'SSAO samples the surrounding depth in a hemisphere. Watch the shadows around the narrow inside corners.',
  gtao:'GTAO estimates the visible part of the hemisphere by measuring how high nearby surfaces rise in each direction.'
};
const lookAt=[.04,1.11,-.13],distance=4.35,home=[.255,.139];
let engine,stack,effect,observer,requested,busy,drag;
let mode='ssao',radius=.36,yaw=home[0],incline=home[1],revision=0,rendered=0,resize=false;
function dimensions(){
  const dpr=Math.min(1.75,Math.max(1,devicePixelRatio||1));
  return [Math.round(canvas.clientWidth*dpr),Math.round(canvas.clientHeight*dpr)];
}
function draw(){
  const [width,height]=dimensions();
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const across=distance*Math.cos(incline);
  engine.camera.fov=canvas.clientWidth<650?36:32;
  engine.camera.position=[lookAt[0]+across*Math.sin(yaw),lookAt[1]+distance*Math.sin(incline),lookAt[2]+across*Math.cos(yaw)];
  engine.camera.target=lookAt;
  if(mode!=="off"&&effect.name!==mode){
    stack.removeEffect(effect);
    effect=mode==="gtao"?new GTAO({radius,slices:3,steps:7}):new SSAO({radius,bias:.016,samples:28});
    stack.addEffect(effect);
  }
  effect.enabled=mode!=="off";
  effect.options.radius=radius;
  for(const button of modes)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  el('radius-value').value=Math.round(radius*100)+' cm';
  el('method-note').textContent=topic[mode];
  status.mode=mode;status.radius=String(radius);status.yaw=yaw.toFixed(3);
  engine.render({delta:0});
}
function update(){revision++;schedule();}
function schedule(){
  if(requested||busy||signal.aborted)return;
  requested=requestAnimationFrame(async ()=>{
    requested=undefined;
    const pending=revision;
    if(pending===rendered&&!resize)return;
    resize=false;busy=true;
    try{
      draw();
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      rendered=pending;status.revision=String(rendered);
      if(pending&&!performance.getEntriesByName('occlusion-first-input').length)performance.mark('occlusion-first-input');
    }catch(error){fail(error);}
    finally{busy=false;}
    if(resize||revision!==rendered)schedule();
  });
}
function move(a,b){
  yaw=Math.max(-1.02,Math.min(1.06,a));
  incline=Math.max(-.10,Math.min(.68,b));
  update();
}
function controls(){
  for(const button of modes)button.addEventListener('click',()=>{
    const selected=button.dataset.mode;
    if(selected!==mode){mode=selected;update();}
  },{signal});
  slider.addEventListener('input',()=>{radius=+slider.value*.01;update();},{signal});
  el('reset').addEventListener('click',()=>move(...home),{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,incline};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    move(drag.yaw+(drag.x-event.clientX)*.007,drag.incline+(event.clientY-drag.y)*.006);
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture']){
    canvas.addEventListener(type,event=>{if(drag?.id===event.pointerId)drag=undefined;},{signal});
  }
  canvas.addEventListener('keydown',event=>{
    const change={ArrowLeft:[-.12,0],ArrowRight:[.12,0],ArrowUp:[0,.095],ArrowDown:[0,-.095]}[event.key];
    if(change){event.preventDefault();move(yaw+change[0],incline+change[1]);}
  },{signal});
  observer=new ResizeObserver(()=>{
    const [width,height]=dimensions();
    if(canvas.width===width&&canvas.height===height)return;
    resize=true;schedule();
  });observer.observe(canvas);
}
async function compat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  if(force)await (await compat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;
    performance.mark('occlusion-device');
    engine.scene.background='#435860';
    engine.lighting.direction.set([-3.1,3.8,2.6,1.07]);
    engine.lighting.radiance.set([1,.87,.73,1.15]);
    engine.lighting.ambient.set([.79,.89,.98]);
    installSculpture(engine);
    performance.mark('occlusion-art');
    effect=new SSAO({radius,bias:.016,samples:28});
    stack=PostStack.attach(engine,[effect]);
    performance.mark('occlusion-stack');
    draw();
    performance.mark('occlusion-submit');
    await engine.gpu.queue.onSubmittedWorkDone();
  },{backend:force?'webgpu':undefined,loadCompat:compat,signal,exactSize:true,antialias:false,camera:{near:.09,far:25,fov:36}});
  signal.throwIfAborted();
  status.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  status.ready='true';status.revision='0';
  control.disabled=false;el('loading').hidden=true;controls();
  performance.mark('margo-first-usable-frame');
}
function dispose(){lifetime.abort();cancelAnimationFrame(requested);observer?.disconnect();engine?.dispose();}
function fail(error){
  if(signal.aborted)return;
  status.error=error.message;
  delete status.ready;
  el('loading').hidden=true;el('error').hidden=false;el('error').textContent=error.message;
  console.error(error);dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);

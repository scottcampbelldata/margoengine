import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import {paths} from './field.js';
import {installBench,installTubeRenderer} from './renderer.js';

const id=name=>document.getElementById(name);
const canvas=id('view'),tools=id('tools'),status=id('status');
const slider=id('thickness'),state=document.body.dataset;
const buttons=[...tools.querySelectorAll('[data-group]')],views=[...tools.querySelectorAll('[data-view]')];
const lifetime=new AbortController(),{signal}=lifetime;
const message=demoStatus(document.body,status,id('error'));
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:0});
const cameras={
  three:{yaw:-.28,pitch:.51,title:'Oblique view'},
  top:{yaw:0,pitch:1.56,title:'Overhead view'},
  end:{yaw:Math.PI*.5,pitch:.14,title:'Downstream view'},
};
let engine,tubes,observer,frame,drag;
let group=0,multiplier=1,view='three',yaw=cameras.three.yaw,pitch=cameras.three.pitch,revision=0;

function selectData(){
  const visible=paths.filter(path=>!group||path.side===group);
  const speeds=visible.flatMap(path=>path.scalar);
  const mesh=tubes.show(.047*multiplier,group);
  id('count').value=String(visible.length);
  id('triangles').value=number.format(mesh.faces);
  id('speed').value=Math.min(...speeds).toFixed(2)+'–'+Math.max(...speeds).toFixed(2);
  id('multiplier').value=multiplier.toFixed(2)+'×';
  state.multiplier=String(multiplier);
  state.group=String(group);
  state.activeTubes=String(visible.length);
  state.triangles=String(mesh.faces);
  for(const button of buttons)button.setAttribute('aria-pressed',String(Number(button.dataset.group)===group));
}
function paint(){
  const dpr=Math.min(1.65,devicePixelRatio||1),w=Math.max(1,Math.round(canvas.clientWidth*dpr)),
    h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  const reach=Math.max(11.6,13.9/(w/h)),level=reach*Math.cos(pitch);
  engine.camera.position=[.25+Math.sin(yaw)*level,.04+Math.sin(pitch)*reach,Math.cos(yaw)*level];
  engine.camera.target=[.25,.04,0];
  state.camera=engine.camera.position.map(n=>n.toFixed(4)).join(',');
  engine.render({delta:0});
}
function schedule(){
  if(frame||signal.aborted)return;
  frame=requestAnimationFrame(()=>{frame=undefined;try{paint();}catch(error){fail(error);}});
}
function changeView(next){
  view=next;
  const preset=cameras[next];
  yaw=preset.yaw;
  pitch=preset.pitch;
  id('angle').textContent=preset.title;
  state.view=next;
  for(const button of views)button.setAttribute('aria-pressed',String(button.dataset.view===next));
  schedule();
}
function orbit(x,y){
  yaw+=x;
  pitch=Math.min(1.55,Math.max(.10,pitch+y));
  view='custom';
  id('angle').textContent='Orbit view';
  state.view=view;
  for(const button of views)button.setAttribute('aria-pressed','false');
  schedule();
}
function remesh(){
  const count=++revision;
  selectData();
  paint();
  engine.gpu.queue.onSubmittedWorkDone().then(()=>{
    if(signal.aborted||count!==revision)return;
    state.revision=String(count);
    if(!performance.getEntriesByName('tube-thickness-applied').length)performance.mark('tube-thickness-applied');
  },fail);
}
function connect(){
  slider.addEventListener('input',()=>{multiplier=slider.valueAsNumber;remesh();},{signal});
  for(const button of buttons)button.addEventListener('click',()=>{
    const next=Number(button.dataset.group);
    if(next===group)return;
    group=next;remesh();
  },{signal});
  for(const button of views)button.addEventListener('click',()=>changeView(button.dataset.view),{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    orbit((drag.x-event.clientX)*.007,(event.clientY-drag.y)*.007);
    drag.x=event.clientX;
    drag.y=event.clientY;
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{drag=undefined;},{signal});
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:[.13,0],ArrowRight:[-.13,0],ArrowUp:[0,.12],ArrowDown:[0,-.12]}[event.key];
    if(!step)return;
    event.preventDefault();orbit(...step);
  },{signal});
  observer=new ResizeObserver(schedule);observer.observe(canvas);
}
async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const known=force||!navigator.gpu;
  if(known)await (await compatibility()).install();
  await autoEngine(canvas,async target=>{
    if(!target.gpu)throw Error('The wind tunnel needs WebGPU or WebGL2.');
    engine=target;
    engine.onError=fail;
    engine.scene.background='#2c3941';
    engine.lighting.direction.set([-1.7,4.3,2.8,3.5]);
    engine.lighting.radiance.set([.93,.98,1,.46]);
    installBench(engine);
    tubes=installTubeRenderer(engine);
    selectData();
    paint();
    await engine.gpu.queue.onSubmittedWorkDone();
  },{signal,backend:known?'webgpu':undefined,loadCompat:compatibility,exactSize:true,
    antialias:true,startupTimeout:4900,camera:{near:.1,far:110,fov:41}});
  signal.throwIfAborted();
  tools.disabled=false;
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  state.view=view;
  status.hidden=true;
  connect();
  message.ready();
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  lifetime.abort();cancelAnimationFrame(frame);observer?.disconnect();
  tubes?.dispose();engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  message.error(error);console.error(error);
  status.hidden=true;id('error').hidden=false;dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);

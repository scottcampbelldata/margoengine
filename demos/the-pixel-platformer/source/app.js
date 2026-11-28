import { demoStatus } from 'margo-demo-status';
import { getKernel } from './transport.js';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),canvas=get('canvas'),status=demoStatus(exhibit,get('status'));
const left=get('left'),right=get('right'),jump=get('jump'),reset=get('reset'),lighting=get('lighting');
const controls=[left,right,jump,reset,lighting];
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const prepared=Promise.all([import('./physics.js'),getKernel(signal)]).then(async ([module,kernel])=>{
  await module.loadPhysics(kernel,signal);
  performance.mark('pixel-physics-ready');
  return module;
}).catch(error=>({error}));
let scene,lastMessage='',advancing=0;
const pointerDirections=new Map(),keys=new Set();
function fail(error){
  if(signal.aborted)return;
  for(const control of controls)control.disabled=true;
  status.error(error);
  controller.abort();
}
function present(model,draws,compatibility,mode){
  const {position,velocity,steps,jumps,grounded,flag,attempts,lit,victory}=model;
  Object.assign(exhibit.dataset,{position:position.map(n=>n.toFixed(4)).join(','),
    velocity:velocity.map(n=>n.toFixed(4)).join(','),steps,jumps,grounded,flag,attempts,lit,victory,draws,
    renderer:compatibility?'compatibility':'webgpu',light:mode});
  const message=victory?'Beacon relit':lit+' / 3';
  if(lastMessage!==message){
    lastMessage=message;
    const result=get('mission');
    result.querySelector('strong').textContent=message;
    result.lastChild.textContent=victory?'':' prisms';
  }
}
function direction(trusted=false){
  const keysSum=Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft'));
  const value=Math.sign(Array.from(pointerDirections.values()).reduce((a,b)=>a+b,keysSum));
  if(value===advancing)return;
  advancing=value;
  for(const node of [left,right])node.dataset.held=String(Number(node.dataset.direction)===value);
  scene?.move(value,trusted);
}
function stop(){
  pointerDirections.clear();
  keys.clear();
  direction();
}
for(const button of [left,right]){
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0||!scene)return;
    button.setPointerCapture(event.pointerId);
    pointerDirections.set(event.pointerId,Number(button.dataset.direction));
    direction(event.isTrusted);
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,event=>{
    pointerDirections.delete(event.pointerId);
    direction();
  },{signal});
  let timer;
  button.addEventListener('click',event=>{
    if(event.detail!==0||!scene)return;
    const key=button===left?'ArrowLeft':'ArrowRight';
    clearTimeout(timer);
    keys.add(key);
    direction(event.isTrusted);
    timer=setTimeout(()=>{keys.delete(key);direction();},145);
  },{signal});
  signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
}
jump.addEventListener('pointerdown',event=>{
  if(event.button!==0||!scene)return;
  jump.setPointerCapture(event.pointerId);
  jump.dataset.held='true';
  scene.jump(event.isTrusted);
},{signal});
for(const type of ['pointerup','pointercancel','lostpointercapture']){
  jump.addEventListener(type,()=>{delete jump.dataset.held;},{signal});
}
jump.addEventListener('click',event=>{
  if(event.detail===0)scene?.jump(event.isTrusted);
},{signal});
reset.addEventListener('click',()=>{stop();scene?.reset();},{signal});
lighting.addEventListener('change',()=>scene?.compare(lighting.value),{signal});
window.addEventListener('keydown',event=>{
  if(!scene||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('select'))return;
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
    event.preventDefault();
    keys.add(event.key);
    direction(event.isTrusted);
  }
  if((event.code==='Space'||event.key==='ArrowUp')&&!event.target.closest?.('button')){
    event.preventDefault();
    if(!event.repeat)scene.jump(event.isTrusted);
  }
},{signal});
window.addEventListener('keyup',event=>{if(keys.delete(event.key))direction();},{signal});
window.addEventListener('blur',stop,{signal});
window.addEventListener('pagehide',event=>{stop();if(!event.persisted)controller.abort();},{signal});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();},{signal});

async function open(){
  const opening=import('./scene.js');
  const native=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const compatibility=!native;
  if(compatibility){
    const module=await import('./compatibility.js');
    await module.prepareCompatibility();
  }
  signal.throwIfAborted();
  const {start}=await opening;
  scene=await start(canvas,{compatibility,prepared,signal,state:present,fail,
    firstInput:()=>performance.mark('margo-first-input-rendered')});
  signal.throwIfAborted();
  for(const control of controls)control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);

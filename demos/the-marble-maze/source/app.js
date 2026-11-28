import { demoStatus } from 'margo-demo-status';
import { wireTilt } from './input.js';
import { goal,maximumTilt,pitch } from './layout.js';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),canvas=get('canvas'),reset=get('reset'),phone=get('phone');
const status=demoStatus(exhibit,get('status'));
const arrows=Array.from(exhibit.querySelectorAll('[data-direction]'));
const controls=[...arrows,reset,phone];
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const prepared=import('./physics.js').then(async module=>{
  await module.loadPhysics(signal);
  performance.mark('maze-physics');
  return module;
}).catch(error=>({error}));

let scene,completed=false;
function fail(error){
  if(signal.aborted||status.failed)return;
  scene?.close();
  for(const button of controls)button.disabled=true;
  status.error(error);
}
const input=wireTilt(canvas,arrows,phone,()=>{
  if(scene&&!exhibit.dataset.physicsReady)get('progress').textContent='Warming physics…';
  scene?.wake();
},text=>{get('motion').textContent=text;},signal);
function renderState(state){
  const {position,tilt,traveled,solved,crossing,caught,steps,contacts}=state;
  Object.assign(exhibit.dataset,{velocity:state.velocity.map(n=>n.toFixed(5)).join(','),position:position.map(n=>n.toFixed(5)).join(','),
    tilt:tilt.map(n=>(n*maximumTilt*180/Math.PI).toFixed(4)).join(','),
    solved,caught,steps,contacts,traveled:traveled.toFixed(5),
    crossing:crossing?.position.map(n=>n.toFixed(5)).join(',')??''});
  if(solved!==completed){
    completed=solved;
    get('progress').textContent=solved?'Maze solved':'Ready to roll';
  }
}
reset.addEventListener('click',()=>{
  try{input.neutral();scene?.reset();}catch(error){fail(error);}
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});

function preview(controlsHandle){
  scene=controlsHandle;
  exhibit.dataset.opening=goal.join(',');
  exhibit.dataset.pitch=String(pitch);
  exhibit.dataset.renderer=scene.backend;
  for(const control of controls)control.disabled=false;
  performance.mark('maze-input-available');
  status.ready('');
}
import('./scene.js').then(module=>module.openScene(canvas,forced,signal,prepared,input.sample,renderState,
  ()=>performance.mark('margo-first-input-rendered'),fail,preview,()=>{
    exhibit.dataset.physicsReady='true';
    if(!completed)get('progress').textContent='Ready to roll';
    performance.mark('margo-first-usable-frame');
  })).catch(fail);

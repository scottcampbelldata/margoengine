import { demoStatus } from 'margo-demo-status';
import { course } from './flight.js';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),play=get('play'),overlay=get('callout'),status=demoStatus(exhibit,get('status'));
const lanes=[get('left'),get('middle'),get('right')];
const inspect=['display','palette','dither'];
const names=['Left','Center','Right'];
const labels={idle:'Launch',running:'Pause',paused:'Resume',finished:'Fly again'};
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,activeLane=0,lastStatus='',lastPhase='',failed=false;
function fail(error){
  if(failed||signal.aborted)return;
  failed=true;
  for(const node of [play,...lanes,...inspect.map(get)])node.disabled=true;
  status.error(error);
  controller.abort();
}
function writeIfDifferent(element,value){
  if(element.textContent!==value)element.textContent=value;
}
function present(state,compatibility,modes,visible,meshes,raster){
  const {phase,lane,position,z,next,correct,gates,lastEvent,elapsed}=state;
  activeLane=lane;
  Object.assign(exhibit.dataset,{phase,lane,x:position.toFixed(4),z:z.toFixed(4),gate:next,correct,
    gates:gates.join(','),crossing:lastEvent?JSON.stringify(lastEvent):'',elapsed:elapsed.toFixed(3),
    renderer:compatibility?'compatibility':'webgpu',display:modes.display,palette:modes.palette,dither:modes.dither,
    visible,meshes,raster:raster.join('×')});
  writeIfDifferent(get('score'),correct+' / '+course.length);
  let text;
  if(phase==='finished')text=correct===course.length?'Perfect approach':'Course complete';
  else if(phase==='paused')text='Paused';
  else if(next===course.length)text='Approach complete';
  else text='Gate '+(next+1)+' · '+names[course[next].lane+1];
  if(text!==lastStatus){lastStatus=text;writeIfDifferent(overlay,text);}
  if(phase!==lastPhase){
    lastPhase=phase;
    writeIfDifferent(play,labels[phase]);
  }
  for(const [i,button] of lanes.entries()){
    button.disabled=!scene||phase!=='running'||next===course.length;
    const pressed=String(lane===i-1);
    if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
  }
}
play.addEventListener('click',event=>scene?.toggle(event.isTrusted),{signal});
for(const [i,button] of lanes.entries())button.addEventListener('click',()=>scene?.choose(i-1),{signal});
for(const name of inspect){
  const element=get(name);
  element.addEventListener('change',()=>scene?.adjust(name,element.value),{signal});
}
window.addEventListener('keydown',event=>{
  if(!scene||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('select'))return;
  if(event.code==='Space'&&!event.target.closest?.('button')){
    event.preventDefault();
    if(!event.repeat)scene.toggle(event.isTrusted);
  }
  if(exhibit.dataset.phase!=='running')return;
  const lane=event.key==='ArrowLeft'?activeLane-1:event.key==='ArrowRight'?activeLane+1:
    event.key==='ArrowUp'?0:['1','2','3'].includes(event.key)?Number(event.key)-2:null;
  if(lane!==null){
    event.preventDefault();
    if(!event.repeat)scene.choose(lane);
  }
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});

async function open(){
  const opening=import('./scene.js');
  const native=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const compatibility=!native;
  if(compatibility){
    const module=await import('./compatibility.js');
    await module.prepareCompatibility();
  }
  signal.throwIfAborted();
  const {show}=await opening;
  scene=await show(get('canvas'),{compatibility,signal,fail,report:present,
    onFirst:()=>performance.mark('margo-first-input-rendered')});
  signal.throwIfAborted();
  play.disabled=false;
  for(const name of inspect)get(name).disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);

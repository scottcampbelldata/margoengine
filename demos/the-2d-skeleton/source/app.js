import { demoStatus } from 'margo-demo-status';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),play=get('play'),time=get('time'),bones=get('bones'),status=demoStatus(exhibit,get('status'));
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,failed=false;
function fail(error){
  if(failed||signal.aborted)return;
  failed=true;
  for(const node of [play,time,bones])node.disabled=true;
  status.error(error);
  controller.abort();
}
function write(node,text){if(node.textContent!==text)node.textContent=text;}
function present(view){
  const vec=pair=>pair.map(value=>value.toFixed(3)).join(',');
  Object.assign(exhibit.dataset,{time:view.time.toFixed(5),duration:view.duration,playing:view.playing,
    bonesVisible:view.showBones,bones:view.bones,slots:view.slots,hand:vec(view.hand),light:vec(view.source),
    ribbon:vec(view.ribbon),joints:view.jointPositions.map(vec).join('|'),warnings:view.warnings,
    renderer:view.compatibility?'compatibility':'webgpu'});
  if(time.max!==String(view.duration))time.max=String(view.duration);
  time.value=String(view.time);
  time.setAttribute('aria-valuetext',view.time.toFixed(2)+' seconds');
  write(get('elapsed'),view.time.toFixed(2)+' / '+view.duration.toFixed(2)+' s');
  write(play,view.playing?'Pause signal':view.time===view.duration?'Play again':'Play signal');
  if(bones.getAttribute('aria-pressed')!==String(view.showBones))bones.setAttribute('aria-pressed',String(view.showBones));
  write(bones,view.showBones?'Hide bones':'Show bones');
}
play.addEventListener('click',event=>scene?.play(event.isTrusted),{signal});
time.addEventListener('input',event=>scene?.seek(Number(time.value),event.isTrusted),{signal});
bones.addEventListener('click',()=>scene?.bones(bones.getAttribute('aria-pressed')!=='true'),{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)controller.abort();},{signal});

async function open(){
  const boot=import('./scene.js');
  const useNative=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const compatibility=!useNative;
  if(compatibility)await (await import('./compatibility.js')).prepareCompatibility();
  signal.throwIfAborted();
  const {animate}=await boot;
  scene=await animate(get('canvas'),{compatibility,signal,report:present,fail,
    firstInput:()=>performance.mark('margo-first-input-rendered')});
  signal.throwIfAborted();
  for(const node of [play,time,bones])node.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);

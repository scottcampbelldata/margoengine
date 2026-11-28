import {autoEngine} from '@margoengine/webgl2-compat/auto';

const canvas=document.querySelector('#view');
const life=new AbortController();
const {signal}=life;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const scene=import('./scene.js');
const mapURL=new URL('./imagery/earth-start.webp',import.meta.url);
const image=new Image();
image.crossOrigin='anonymous';
image.src=mapURL;
const map=image.decode().then(()=>{
  signal.throwIfAborted();
  return createImageBitmap(image,{colorSpaceConversion:'none'});
});
map.catch(()=>{});
let engine,exhibit;

function fail(error){
  if(signal.aborted)return;
  const display=document.querySelector('#error');
  display.hidden=false;
  display.textContent=error.message;
  document.querySelector('#loading').hidden=true;
  document.querySelector('#controls').disabled=true;
  document.body.dataset.error=error.message;
  console.error(error);
}

async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}

async function start(){
  if(force||!navigator.gpu)await (await compatibility()).install();
  await autoEngine(canvas,async target=>{
    engine=target;
    engine.onError=fail;
    performance.mark('globe-device');
    exhibit=await (await scene).connect(engine,engine.canvas,await map,signal,fail);
  },{loadCompat:compatibility,signal,exactSize:true,antialias:true,camera:{fov:43,near:100,far:6e7}});
}
start().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  exhibit?.dispose();
  engine?.dispose();
});

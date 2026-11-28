import { autoEngine } from '@margoengine/webgl2-compat/auto';
const canvas = document.querySelector('#village');
const lifetime = new AbortController();
const { signal } = lifetime;
const forCompatibility = new URLSearchParams(location.search).get('backend') === 'webgl2';
const print = import('./scene.js');
let engine, plate;
function fail(cause){
  if(signal.aborted)return;
  delete document.body.dataset.ready;
  document.body.dataset.error=cause.message;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');
  notice.hidden=false;
  notice.textContent=cause.message;
  console.error(cause);
}
async function loadCompat(){
  const { install } = await import('@margoengine/webgl2-compat');
  return { install:()=>install({ force:true,signal }) };
}
async function open(){
  if(forCompatibility||!navigator.gpu)await (await loadCompat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;
    engine.onError=fail;
    performance.mark('toon-device');
    plate=await (await print).install(target,target.canvas,signal,fail);
  },{loadCompat,signal,exactSize:true,antialias:true,camera:{near:.16,far:60,fov:39}});
  plate?.connect();
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  plate?.dispose();
  engine?.dispose();
});

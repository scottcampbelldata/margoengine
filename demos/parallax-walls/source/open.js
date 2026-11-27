import { autoEngine } from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#vault'),life=new AbortController(),{signal}=life;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const setup=import('./scene.js');
const maps=async()=>{
  const prepare=stone=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./map-worker.js',import.meta.url),{type:'module'});
    const dispose=()=>worker.terminate();
    signal.addEventListener('abort',()=>{
      dispose();reject(signal.reason);
    },{once:true});
    worker.addEventListener('message',event=>{dispose();resolve(event.data);},{once:true});
    worker.addEventListener('error',event=>{dispose();reject(new Error(event.message));},{once:true});
    worker.postMessage(stone);
  });
  const [brick,stone]=await Promise.all([prepare(false),prepare(true)]);
  performance.mark('walls-maps-ready');
  return {brick,stone};
};
const prepared=maps();
prepared.catch(()=>{});
let engine,installation;
function fail(error){
  if(signal.aborted)return;
  const state=document.body.dataset;
  delete state.ready;state.error=error.message;
  document.querySelector('#loading').hidden=true;
  const notice=document.querySelector('#error');
  notice.hidden=false;notice.textContent=error.message;
  console.error(error);
}
async function loadCompat(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function open(){
  if(force||!navigator.gpu)await (await loadCompat()).install();
  await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;
    performance.mark('walls-device');
    installation=await (await setup).install(target,target.canvas,await prepared,signal,fail);
  },{loadCompat,signal,exactSize:true,antialias:true,camera:{near:.15,far:40,fov:41}});
  installation.connect();
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();
  installation?.dispose();
  engine?.dispose();
});

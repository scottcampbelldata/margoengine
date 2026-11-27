
import {autoEngine} from '@margoengine/webgl2-compat/auto';
const canvas=document.querySelector('#art'),life=new AbortController(),{signal}=life;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2'||!navigator.gpu;
const render=forced?import('./direct.js'):import('./scene.js');
let engine,installation;
function fail(error){
  if(signal.aborted)return;
  delete document.body.dataset.ready;
  document.body.dataset.error=error.message;
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
  if(forced){
    const stage=await (await render).openDirect(canvas,signal,fail);
    engine=stage.engine;installation=stage.view;
  }else await autoEngine(canvas,async target=>{
    engine=target;engine.onError=fail;
    performance.mark('glass-device');
    const gallery=await render;
    installation=await gallery.install(target,canvas,signal,fail);
  },{loadCompat,signal,exactSize:true,antialias:false,camera:{near:.14,far:45,fov:39}});
  if(signal.aborted)return;
  installation.connect();
  performance.mark('margo-first-usable-frame');
}
open().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();installation?.dispose();engine?.dispose();
});

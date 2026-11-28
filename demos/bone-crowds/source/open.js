import {EngineKernel} from '@margoengine/core';
const canvas=document.querySelector('#view'),loading=document.querySelector('#loading');
const lifetime=new AbortController(),{signal}=lifetime;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine, compatibility=false;
const followButton=document.querySelector('#follow');
let initialFollow=false, initialTrusted=false, command=null;
followButton.addEventListener('click',event=>{
  initialFollow=!initialFollow;
  if(command){command(initialFollow,event.isTrusted);return;}
  initialTrusted ||= event.isTrusted;
  loading.textContent=initialFollow?'Setting the tracking camera…':'Finding the herd…';
},{signal});
const followControl=callback=>{
  command=callback;
  callback(initialFollow,initialTrusted);
};
followButton.disabled=false;
function fail(error){
  if(signal.aborted)return;
  canvas.dataset.error=error.message;
  document.querySelector('#controls').disabled=true;
  loading.hidden=false;
  loading.textContent='The herd could not render on this device.';
  console.error(error);
  lifetime.abort();
  engine?.dispose();
}
async function open(){
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:384,startupTimeout:2800,signal};
  if(!force&&navigator.gpu){
    try{return await EngineKernel.create(canvas,options);}
    catch(error){if(error.code!=='unsupported'&&error.code!=='timeout')throw error;}
  }
  const {install}=await import('./compatibility.js');
  await install({force:true,signal});
  compatibility=true;
  return EngineKernel.create(canvas,options);
}
const scene=import('./scene.js');
Promise.all([open(),scene]).then(async ([device,module])=>{
  if(signal.aborted){device.dispose();return;}
  engine=device;
  engine.onError=fail;
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  performance.mark('herd-device');
  await module.show(engine,canvas,loading,signal,fail,followControl);
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted||signal.aborted)return;
  lifetime.abort();
  engine?.dispose();
},{signal});

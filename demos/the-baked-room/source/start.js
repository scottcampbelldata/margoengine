import {Engine} from '@margoengine/core';
import {demoStatus} from 'margo-demo-status';

const canvas=document.querySelector('#room'), notice=document.querySelector('#notice');
const message=document.querySelector('#status'),error=document.querySelector('#error');
const status=demoStatus(canvas,message,error);
const lifecycle=new AbortController(),{signal}=lifecycle;
let engine;

function stop(){
  if(signal.aborted)return;
  lifecycle.abort();
  engine?.dispose();
}
function fail(reason){
  if(signal.aborted)return;
  status.error(reason);
  notice.hidden=false;
  message.textContent='The lightmap room could not start.';
  for(const button of document.querySelectorAll('button'))button.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  stop();
}
function size(){
  const ratio=Math.min(1.65,devicePixelRatio);
  const w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function connect(){
  const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:24,startupTimeout:2500,signal,
    camera:{position:[3.69,2.02,6.94],target:[-.45,1.53,-1.90],near:.22,far:22,fov:43}};
  if(!forced&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {installCompatibility}=await import('./compatibility.js');
  await installCompatibility(signal);
  return Engine.create(canvas,options);
}
async function readStarter(){
  const file=await fetch(new URL('./starter.atlas',import.meta.url),{signal});
  if(!file.ok)throw new Error('The reference lightmap could not be loaded.');
  const bytes=await new Response(file.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const head=new DataView(bytes);
  const width=head.getUint32(0,true),height=head.getUint32(4,true);
  const passes=head.getUint32(8,true),lightmapScale=head.getFloat32(12,true);
  const count=width*height;
  if(width!==256||height!==192||passes!==2||!Number.isFinite(lightmapScale)||lightmapScale<1
    ||bytes.byteLength!==16+count*6)throw new Error('The reference lightmap data are invalid.');
  const lightmap=new Uint8Array(bytes,16,count*4),triangle=new Int32Array(count),irradiance=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    triangle[i]=head.getInt16(16+count*4+2*i,true);
    for(let ch=0;ch<3;ch++)irradiance[i*3+ch]=lightmap[i*4+ch]*(lightmapScale/255);
  }
  performance.mark('baked-reference-ready');
  return {width,height,passes,lightmapScale,lightmap,triangle,irradiance,radiometry:'physical'};
}

addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
size();
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  engine.onError=fail;
  performance.mark('baked-device');
  return result;
});
const study=import('./scene.js').then(({prepareRoom,show})=>{
  signal.throwIfAborted();
  const prepared=prepareRoom();
  performance.mark('baked-geometry-ready');
  return {prepared,show};
});
Promise.all([device,study,readStarter()]).then(([engine,{prepared,show},starter])=>
  show({engine,prepared,starter,canvas,notice,status,size,signal,fail})).catch(fail);

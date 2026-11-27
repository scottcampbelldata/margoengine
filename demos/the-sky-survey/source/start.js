import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { loadSurvey } from './survey.js';

const canvas=document.querySelector('#globe');
const notice=document.querySelector('#status');
const error=document.querySelector('#error');
const help=document.querySelector('#help');
const status=demoStatus(canvas,notice,document.querySelector('#message'));
const controller=new AbortController();
const {signal}=controller;
let engine;

function fit() {
  const ratio=Math.min(1.8,devicePixelRatio);
  const width=Math.max(1,Math.round(canvas.clientWidth*ratio));
  const height=Math.max(1,Math.round(canvas.clientHeight*ratio));
  if(canvas.width===width&&canvas.height===height)return false;
  canvas.width=width;
  canvas.height=height;
  return true;
}

function fail(reason) {
  if(signal.aborted)return;
  status.error(reason); notice.hidden=true; error.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  for(const button of document.querySelectorAll('button'))button.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  queueMicrotask(stop);
}

function stop() {
  if(signal.aborted)return;
  controller.abort();
  engine?.dispose();
}

async function connect() {
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:32,startupTimeout:2500,signal,
    camera:{near:.1,far:70}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(reason){if(reason?.code!=='unsupported'&&reason?.code!=='timeout')throw reason;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

fit();
applyQualityTier({search:'?quality=high',userAgent:''});
addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
const catalog=loadSurvey(signal);
const device=connect().then(result=>{
  if(signal.aborted){result.dispose();signal.throwIfAborted();}
  engine=result;
  performance.mark('sky-device-ready');
  return result;
});
Promise.all([catalog,device,import('./scene.js')]).then(([rows,engine,scene])=>
  scene.open({canvas,rows,engine,fit,status,signal,notice,fail})).catch(fail);

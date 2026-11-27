import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { metadata, openingMRI, readMRI } from './scan-data.js';

const canvas = document.querySelector('#viewer');
const progress = document.querySelector('#status');
const message = document.querySelector('#message');
const errorBox = document.querySelector('#error');
const help = document.querySelector('#help');
const status = demoStatus(canvas,progress,message);
const controller = new AbortController();
const { signal } = controller;
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
applyQualityTier();
const data = readMRI(openingMRI, metadata.initial.dims, signal);
const scene = import('./scene.js');

function fit() {
  const width = Math.max(1, Math.round(canvas.clientWidth * 1.44));
  const height = Math.max(1, Math.round(canvas.clientHeight * 1.44));
  if(canvas.width === width && canvas.height === height)return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
fit();

const options = {
  backend:'webgpu', exactSize:true, antialias:true, capacity:170, startupTimeout:2500, signal,
  camera:{near:.014,far:9,fov:42},
};

async function openEngine() {
  if (!forced && navigator.gpu) {
    try {
      return await Engine.create(canvas, options);
    } catch (reason) {
      if (reason?.code !== 'unsupported' && reason?.code !== 'timeout') throw reason;
    }
  }
  const { install } = await import('@margoengine/webgl2-compat');
  await install({ force:true, signal });
  return Engine.create(canvas, options);
}
let engine;
function stop() {
  controller.abort();
  engine?.dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)stop();},{signal});
const opening = openEngine().then(value=>{
  if(signal.aborted) {
    value.dispose();
    signal.throwIfAborted();
  }
  engine = value;
  performance.mark('brain-device-ready');
  return value;
});

Promise.all([opening, scene, data]).then(([target, exhibit, values])=>
  exhibit.open({target, values, controller, fit, status, stop}),
).catch(reason=>{
  if(signal.aborted)return;
  status.error(reason);
  errorBox.hidden = false;
  progress.hidden = true;
  help.hidden = reason?.code !== 'unsupported';
  if(reason?.code !== 'unsupported')console.error(reason);
  stop();
});

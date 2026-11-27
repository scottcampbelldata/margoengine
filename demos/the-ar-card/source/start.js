import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { chooseARRoute, quickLookURL } from '@margoengine/xr/launch';
import { demoStatus } from 'margo-demo-status';
import archive from './assets/vela-17.bin?url';
import glb from './assets/vela-17.glb?url';
import model from './assets/vela-17.usdz?url';
import compressedAR from './assets/vela-17-ar.bin?url';

const canvas = document.querySelector('#radio');
const notice = document.querySelector('#status');
const error = document.querySelector('#error');
const help = document.querySelector('#help');
const angle = document.querySelector('#angle');
const status = demoStatus(canvas,notice,document.querySelector('#message'));
const ar = document.querySelector('#ar');
const arHelp = document.querySelector('#ar-help');
const viewer = new AbortController(), placement = new AbortController();
const { signal } = viewer;
const usdzType = 'model/vnd.usdz+zip';
const decompress = typeof DecompressionStream === 'function';
let localModelURL;
let engine;

function link({ route, href, label, help }) {
  if (href) {
    ar.href = href;
    ar.removeAttribute('aria-disabled');
    performance.mark('ar-card-placement-ready');
  } else ar.setAttribute('aria-disabled','true');
  if (route === 'quick-look') ar.rel = 'ar';
  if (route === 'download') ar.download = 'Vela-17.usdz';
  ar.dataset.route = route;
  ar.dataset.label = label;
  arHelp.textContent = help;
  ar.setAttribute('aria-label',label);
  ar.hidden = false;
}

function download() {
  link({route:'download',href:model,label:'Download USDZ',
    help:'Open the USDZ in Quick Look on a supported Apple device.'});
}

async function openQuickLook(preview) {
  const arSignal = placement.signal;
  const direct = await fetch(model,{method:'HEAD',signal:arSignal}).catch(()=>null);
  if (arSignal.aborted) return;
  const type = direct?.headers.get('content-type')?.split(';')[0].trim();
  if (!direct?.ok || type !== usdzType) {
    // Keep file preparation behind the first model frame. The link still opens on one native tap.
    await preview.catch(()=>{});
    if (arSignal.aborted) return;
    const response = await fetch(decompress ? compressedAR : model,{signal:arSignal});
    if (!response.ok) throw new Error('The Quick Look model could not be prepared.');
    const bytes = await (decompress ?
      new Response(response.body.pipeThrough(new DecompressionStream('gzip'))) : response).arrayBuffer();
    arSignal.throwIfAborted();
    localModelURL = URL.createObjectURL(new Blob([bytes],{type:usdzType}));
  }
  link({route:'quick-look',href:quickLookURL(localModelURL??model,{allowsContentScaling:false}),
    label:'View in your space',help:'Place the radio at its actual size.'});
}

function fit() {
  const width = Math.max(1,Math.round(canvas.clientWidth*1.65));
  const height = Math.max(1,Math.round(canvas.clientHeight*1.65));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
function destroy() {
  if (signal.aborted) return;
  viewer.abort();
  engine?.dispose();
}
function fail(reason) {
  if (signal.aborted) return;
  status.error(reason);
  notice.hidden = true;
  error.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  angle.disabled = true;
  if (reason?.code !== 'unsupported') console.error(reason);
  queueMicrotask(destroy);
}

fit();
applyQualityTier({ search: '?quality=high', userAgent: '' });
addEventListener('pagehide',event=>{
  if (event.persisted) return;
  destroy();
  placement.abort();
  if (localModelURL) URL.revokeObjectURL(localModelURL);
},{signal:placement.signal});

async function loadModel() {
  const response = await fetch(decompress ? archive : glb,{signal});
  if (!response.ok) throw new Error(`The Vela 17 model could not be opened (${response.status}).`);
  return decompress ? new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : response.arrayBuffer();
}

async function connect() {
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const options = { backend:'webgpu', exactSize:true, antialias:true, capacity:20,
    startupTimeout:2500, camera:{fov:34,near:.025,far:10}, signal };
  if (!force && navigator.gpu) {
    try { return await Engine.create(canvas,options); }
    catch (reason) { if (reason?.code !== 'unsupported' && reason?.code !== 'timeout') throw reason; }
  }
  const { install } = await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

const modelBytes = loadModel();
const scene = import('./scene.js');
const opening = connect().then(target=>{
  if (signal.aborted) { target.dispose(); signal.throwIfAborted(); }
  engine = target;
  performance.mark('ar-card-device-ready');
  return target;
});
const preview=Promise.all([opening,modelBytes,scene]).then(([target,bytes,exhibit])=>
  exhibit.open({engine:target,bytes,fit,status,notice,angle,signal,fail})).catch(fail);
if (chooseARRoute({webxr:false}) === 'quick-look') {
  const save = document.querySelector('#save-model');
  save.href = model;
  save.hidden = false;
  link({route:'preparing',label:'Preparing Quick Look…',help:'The model will open at its actual size.'});
  openQuickLook(preview).catch(()=>{
    if (placement.signal.aborted) return;
    save.hidden = true;
    download();
  });
} else download();

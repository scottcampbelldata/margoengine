import {EngineKernel} from '@margoengine/core';
import {width, height} from './layout.js';

const canvas = document.querySelector('#view');
const loading = document.querySelector('#loading');
const lifetime = new AbortController();
const {signal} = lifetime;
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const legacy = forced || !navigator.gpu;
let engine, compatible = false;

function fail(error) {
  if (signal.aborted) return;
  canvas.dataset.error = error.message;
  document.querySelector('#controls').disabled = true;
  loading.hidden = false;
  loading.textContent = 'The chamber could not render on this device.';
  console.error(error);
  lifetime.abort();
  engine?.dispose();
}
async function connect() {
  const options = {backend:'webgpu', exactSize:[width,height], antialias:false, startupTimeout:2500, signal};
  if (!legacy) {
    try { return await EngineKernel.create(canvas, options); }
    catch (error) {
      if (error.code !== 'unsupported' && error.code !== 'timeout') throw error;
    }
  }
  const {install} = await import('./compatibility.js');
  await install({force: true, signal});
  compatible = true;
  return EngineKernel.create(canvas, options);
}
addEventListener('pagehide', event => {
  if (event.persisted || signal.aborted) return;
  lifetime.abort();
  engine?.dispose();
},{signal});

const scene = import('./scene.js');
Promise.all([connect(), scene]).then(async ([device, module]) => {
  if (signal.aborted) {
    device.dispose();
    return;
  }
  engine = device;
  engine.onError = fail;
  canvas.dataset.renderer = compatible ? 'compatibility' : 'webgpu';
  performance.mark('karst-device');
  await module.show(engine, canvas, loading, signal, fail);
}).catch(fail);

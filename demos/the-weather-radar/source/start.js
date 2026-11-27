import { Engine } from '@margoengine/core';
import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { readOpening } from './radar-data.js';

const canvas = document.querySelector('#radar');
const notice = document.querySelector('#status');
const error = document.querySelector('#error');
const help = document.querySelector('#help');
const status = demoStatus(canvas, notice, document.querySelector('#message'));
const controller = new AbortController();
const {signal} = controller;
let engine;

function fit() {
  const factor = Math.min(1.8, devicePixelRatio);
  const width = Math.max(1, Math.round(canvas.clientWidth * factor));
  const height = Math.max(1, Math.round(canvas.clientHeight * factor));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function stop() {
  if (signal.aborted) return;
  controller.abort();
  engine?.dispose();
}

function fail(reason) {
  if (signal.aborted) return;
  status.error(reason);
  notice.hidden = true;
  error.hidden = false;
  help.hidden = reason?.code !== 'unsupported';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  if (reason?.code !== 'unsupported') console.error(reason);
  queueMicrotask(stop);
}

async function connect() {
  const force = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const options = {backend:'webgpu', exactSize:true, antialias:true, capacity:50, startupTimeout:2500, signal,
    camera:{near:.06, far:40}};
  if (!force && navigator.gpu) {
    try {
      return await Engine.create(canvas, options);
    } catch (reason) {
      if (reason?.code !== 'unsupported' && reason?.code !== 'timeout') throw reason;
    }
  }
  const {install} = await import('@margoengine/webgl2-compat');
  await install({force:true, signal});
  return Engine.create(canvas, options);
}

fit();
applyQualityTier({search:'?quality=high',userAgent:''});
addEventListener('pagehide', event => {
  if (!event.persisted) stop();
}, {signal});
const device = connect().then(result => {
  if (signal.aborted) {
    result.dispose();
    signal.throwIfAborted();
  }
  engine = result;
  performance.mark('weather-device-ready');
  return result;
});
const data = readOpening(signal);
const scene = import('./scene.js');
Promise.all([device, data, scene]).then(([result, grid, exhibit]) =>
  exhibit.open({engine:result, grid, fit, status, notice, signal, fail})).catch(fail);

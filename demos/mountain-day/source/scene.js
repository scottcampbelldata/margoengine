import { applyQualityTier } from '@margoengine/quality';
import { demoStatus } from 'margo-demo-status';
import { beats, conditions, duration } from './day.mjs';
import { openLandscape } from './opening.js';

const openingCanvas = document.querySelector('#opening-canvas');
const fullCanvas = document.querySelector('#full-canvas');
const loading = document.querySelector('#status');
const details = document.querySelector('#detail-status');
const loadStatus = demoStatus(document.body, loading, document.querySelector('#error-reason'));
const slider = document.querySelector('#time');
const clock = document.querySelector('#clock');
const phase = document.querySelector('#phase');
const play = document.querySelector('#play');
const presets = [...document.querySelectorAll('[data-phase]')];
const controls = [slider,play,...presets];
const controller = new AbortController();
const {signal} = controller;
const quality = applyQualityTier();
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
const initialSecond = 3.6;
const info = document.body.dataset;

let opening, full, observer, nextFrame, streamTimer, transitionTimer, frameSize, backend;
let rendered = -1, desired = initialSecond, playing = null, busy = false, dirty = true;
let lastRequested, firstInteraction = false, showingFull = false, streamFailed = false;
let serial = 0;

function fail(error) {
  if (signal.aborted || loadStatus.failed) return;
  loadStatus.error(error);
  loading.hidden = false;
  document.querySelector('#status-title').textContent = 'The landscape could not be opened.';
  document.querySelector('#webgpu-help').hidden = false;
  for (const control of controls) control.disabled = true;
}

function streamFailure(error) {
  if (signal.aborted || streamFailed) return;
  if (showingFull) {
    fail(error);
    return;
  }
  streamFailed = true;
  info.atmosphere = 'unavailable';
  info.atmosphereError = error?.message ?? String(error);
  details.textContent = error?.code === 'unsupported'
    ? 'The full atmosphere needs WebGPU. The live terrain and solar time are available.'
    : 'The cloud and forest detail could not be loaded. You can still scrub the live terrain.';
  details.hidden = false;
  full?.dispose();
  full = undefined;
}

function resize() {
  const ratio = Math.max(1,Math.min(devicePixelRatio,1.3));
  const width = Math.max(1,Math.round(openingCanvas.clientWidth * ratio));
  const height = Math.max(1,Math.round(openingCanvas.clientHeight * ratio));
  const fov = Math.max(33,Math.min(60,46 / Math.sqrt(width / height)));
  frameSize = {width,height,fov};
}

function timeLabel(minutes) {
  const digits = n => String(n).padStart(2,'0');
  return digits(Math.floor(minutes/60)) + ':' + digits(minutes%60);
}

function readout(second,state) {
  const label = timeLabel(state.minutes);
  clock.textContent = label;
  phase.textContent = state.label;
  slider.value = String(second);
  slider.setAttribute('aria-valuetext',label + ' local solar time, ' + state.label);
  play.textContent = playing ? 'Pause' : second >= duration ? 'Replay day' : 'Play 40-second day';
  info.second = second.toFixed(3);
  info.minute = String(state.minutes);
  info.sunElevation = state.elevation.toFixed(2);
  info.cloudCoverage = state.clouds.toFixed(3);
  info.stars = state.stars.toFixed(3);
  info.playing = String(!!playing);
}

function recordPresented(second,state) {
  rendered = second;
  readout(second,state);
  if (firstInteraction && !performance.getEntriesByName('mountain-first-input-frame').length) {
    performance.mark('mountain-first-input-frame');
    performance.mark('margo-first-input-rendered');
  }
}

function onFullFrame(frame) {
  if (signal.aborted || streamFailed) return;
  if (!showingFull) {
    const synchronized = frame.width === frameSize.width && frame.height === frameSize.height &&
      (frame.second === desired || (playing && Math.abs(frame.second - desired) < .5));
    if (!synchronized) return;
    showingFull = true;
    fullCanvas.classList.add('shown');
    openingCanvas.setAttribute('aria-hidden','true');
    fullCanvas.removeAttribute('aria-hidden');
    info.atmosphere = 'full';
    details.hidden = true;
    performance.mark('mountain-atmosphere-presented');
    transitionTimer = setTimeout(() => {
      opening?.dispose();
      opening = undefined;
    },200);
  }
  recordPresented(frame.second,conditions(frame.second));
  if (playing || frame.second !== desired) queue();
}

function progress(name) {
  performance.mark('mountain-full-' + name);
  info.atmospherePhase = name;
}

function attachWorker() {
  const worker = new Worker(new URL('./landscape-worker.js',import.meta.url),{type:'module'});
  worker.addEventListener('message',({data}) => {
    if (data.type === 'frame') onFullFrame(data.frame);
    else if (data.type === 'phase') progress(data.name);
    else if (data.type === 'error') streamFailure(data);
  },{signal});
  worker.addEventListener('error', event => streamFailure(event.error ?? new Error(event.message)),{signal});
  const canvas = fullCanvas.transferControlToOffscreen();
  worker.postMessage({type:'attach',canvas,renderer:backend},[canvas]);
  return {
    set(frame) { worker.postMessage({type:'frame',frame}); },
    dispose() { worker.terminate(); },
  };
}

async function attachLocal() {
  let next, painter, drawing = false;
  const paint = async () => {
    if (!next || !painter || drawing || signal.aborted || streamFailed) return;
    const frame = next;
    next = undefined;
    drawing = true;
    try {
      await painter.render(frame,!showingFull);
      onFullFrame(frame);
    } catch (error) {
      streamFailure(error);
    } finally {
      drawing = false;
      if (next) paint();
    }
  };
  const {buildFull} = await import('./full-landscape.js');
  painter = await buildFull(fullCanvas,backend,signal,progress);
  painter.engine.onError = streamFailure;
  return {
    set(frame) { next = frame; paint(); },
    dispose() { painter.dispose(); },
  };
}

async function stream() {
  if (signal.aborted) return;
  info.atmosphere = 'streaming';
  details.hidden = false;
  try {
    full = typeof fullCanvas.transferControlToOffscreen === 'function' ? attachWorker() : await attachLocal();
    if (signal.aborted) {
      full.dispose();
      full = undefined;
      return;
    }
    dirty = true;
    queue();
  } catch (error) {
    streamFailure(error);
  }
}

function queue() {
  if (nextFrame === undefined && !busy) nextFrame = requestAnimationFrame(tick);
}

async function tick(now) {
  nextFrame = undefined;
  if (signal.aborted || loadStatus.failed) return;
  if (playing) {
    desired = Math.min(duration,playing.second + Math.max(0,now - playing.start)/1000);
    if (desired === duration) playing = null;
  }
  const second = desired;
  const frame = {...frameSize,second,serial:serial++};
  if (full && (lastRequested?.second !== second || dirty)) {
    full.set(frame);
    lastRequested = frame;
  }
  if (showingFull || (rendered === second && !dirty)) {
    dirty = false;
    if (playing) queue();
    return;
  }
  busy = true;
  dirty = false;
  try {
    const state = conditions(second);
    await opening.render(state,frame);
    if (!signal.aborted && !loadStatus.failed && !showingFull) recordPresented(second,state);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    if (!signal.aborted && !loadStatus.failed && (playing || rendered !== desired || dirty)) queue();
  }
}

function seek(second) {
  playing = null;
  desired = second;
  if (second !== rendered) firstInteraction = true;
  queue();
}

function connect() {
  slider.addEventListener('input',() => seek(Number(slider.value)),{signal});
  for (const [i,button] of presets.entries()) button.addEventListener('click',() => seek(beats[i].second),{signal});
  play.addEventListener('click',() => {
    if (playing) {
      playing = null;
      desired = rendered;
      readout(rendered,conditions(rendered));
    } else {
      const second = rendered === initialSecond || rendered >= duration ? 0 : Math.max(0,rendered);
      playing = {second,start:performance.now()};
      firstInteraction = true;
    }
    queue();
  },{signal});
  observer = new ResizeObserver(() => { resize(); dirty = true; queue(); });
  observer.observe(openingCanvas);
}

async function open() {
  resize();
  opening = await openLandscape(openingCanvas,forced,signal);
  backend = opening.engine.backend;
  opening.engine.onError = fail;
  const state = conditions(initialSecond);
  await opening.render(state,{...frameSize,second:initialSecond});
  if (signal.aborted || loadStatus.failed) return;
  recordPresented(initialSecond,state);
  for (const control of controls) control.disabled = false;
  info.renderer = backend;
  info.quality = quality;
  info.atmosphere = 'opening';
  loadStatus.ready();
  loading.hidden = true;
  performance.mark('margo-first-usable-frame');
  connect();
  streamTimer = setTimeout(stream,300);
}

addEventListener('pagehide',event => {
  if (event.persisted) return;
  controller.abort();
  if (nextFrame !== undefined) cancelAnimationFrame(nextFrame);
  clearTimeout(streamTimer);
  clearTimeout(transitionTimer);
  observer?.disconnect();
  full?.dispose();
  opening?.dispose();
});

open().catch(fail);
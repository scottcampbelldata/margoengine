import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { makeApparatus } from './apparatus.js';
import { advance, freshRun, launchRpm, referenceSpeed } from './brake.js';

const canvas = document.querySelector('#machine');
const loading = document.querySelector('#loading');
const current = document.querySelector('#current');
const level = document.querySelector('#level');
const trace = document.querySelector('#trace');
const spin = document.querySelector('#spin');
const speed = document.querySelector('#speed');
const heat = document.querySelector('#heat');
const plot = document.querySelector('#plot');
const ink = plot.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const stop = new AbortController();
const controls = [current, spin, trace];
const horizon = 10;

let engine, apparatus, observer, frame, run;
let currentRatio = current.valueAsNumber / 100, showTrace = true;
let lastFrame, lastPlot = 0, tracerClock = 0, angles = 0, spinPending = false;
let samples = [];

function studioMap() {
  const width = 80, height = 40, data = new Float32Array(width * height * 4);
  const lamps = [
    [-.72, .71, .54, .27, [6.8, 6.45, 5.6]],
    [1.83, .31, .35, .52, [4.3, 5.4, 4.8]],
    [-2.48, .48, .59, .16, [5.2, 4.3, 3.2]],
    [2.84, -.25, .29, .27, [3.15, 2.84, 2.27]],
  ];
  for (let y = 0; y < height; y++) {
    const pitch = Math.PI * (.5 - (y + .5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = Math.PI * 2 * ((x + .5) / width - .5);
      const base = .091 + .15 * Math.max(0, pitch);
      const rgb = [base, base * 1.02, base * .93];
      for (const [bearing, tilt, w, h, intensity] of lamps) {
        const distance = Math.atan2(Math.sin(azimuth - bearing), Math.cos(azimuth - bearing));
        const value = Math.exp(-1.6 * ((distance / w) ** 4 + ((pitch - tilt) / h) ** 4));
        for (let channel = 0; channel < 3; channel++) rgb[channel] += value * intensity[channel];
      }
      data.set([...rgb, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function chart() {
  const w = plot.width, h = plot.height;
  const area = { x: 23, y: 9, width: w - 32, height: h - 29 };
  const x = (seconds) => area.x + area.width * seconds / horizon;
  const y = (rpm) => area.y + area.height * (1 - rpm / 150);
  ink.clearRect(0, 0, w, h);
  ink.lineWidth = 1;
  ink.strokeStyle = '#4b5850';
  ink.fillStyle = '#c0c3b2';
  ink.font = '10px system-ui';
  for (const rpm of [150, 75, 0]) {
    const row = y(rpm);
    ink.fillText(String(rpm), 1, row + 3);
    ink.beginPath();
    ink.moveTo(area.x, row);
    ink.lineTo(w - 9, row);
    ink.stroke();
  }
  for (const tick of [0, 5, 10]) {
    ink.textAlign = tick === horizon ? 'right' : 'left';
    ink.fillText(tick + 's', x(tick), h - 3);
  }
  ink.textAlign = 'left';
  if (!samples.length) return;
  ink.setLineDash([5, 4]);
  ink.strokeStyle = '#a9a799';
  ink.beginPath();
  for (let i = 0; i <= 60; i++) {
    const seconds = i * horizon / 60;
    ink.lineTo(x(seconds), y(referenceSpeed(seconds)));
  }
  ink.stroke();
  ink.setLineDash([]);
  ink.strokeStyle = '#a5dbca';
  ink.lineWidth = 2.5;
  ink.beginPath();
  for (const [time, rpm] of samples) ink.lineTo(x(time), y(rpm));
  ink.stroke();
}
function updateReadout() {
  speed.textContent = String(Math.round(run?.speed ?? 0));
  heat.textContent = (run?.heat ?? 0).toFixed(1);
  document.body.dataset.speed = (run?.speed ?? 0).toFixed(2);
  document.body.dataset.heat = (run?.heat ?? 0).toFixed(3);
  document.body.dataset.field = String(current.valueAsNumber);
}

function measure() {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio, 1.5);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const fit = Math.max(1, 1.35 * height / width);
  engine.camera.target = [.051, .247, .018];
  engine.camera.position = [.051 - .44 * fit, .247 + .47 * fit, .018 + 1.10 * fit];
}

function render(now) {
  frame = undefined;
  const running = run && run.speed > .45;
  const delta = lastFrame === undefined ? 1 / 60 : Math.min(.08, (now - lastFrame) / 1000);
  lastFrame = running ? now : undefined;
  if (running) {
    advance(run, delta, currentRatio);
    angles = run.angle;
    if (run.time <= horizon || samples.at(-1)[0] < horizon) {
      if (run.time - lastPlot > .084 || run.time > horizon) {
        const time = Math.min(horizon, run.time);
        const [before, rpm] = samples.at(-1);
        const sample = time === run.time ? run.speed : rpm + (run.speed - rpm) * (time - before) / (run.time - before);
        samples.push([time, sample]);
        lastPlot = time;
        chart();
      }
    }
    updateReadout();
  }
  const strength = currentRatio * (run?.speed ?? 0) / launchRpm;
  const currentsVisible = showTrace && strength > .012;
  tracerClock += delta * (.22 + .66 * strength);
  apparatus.render(angles, reduced.matches ? 0 : tracerClock, strength, currentsVisible);
  engine.render({ delta });
  const state = document.body.dataset;
  state.currentLines = currentsVisible ? 'visible' : 'hidden';
  state.angle = (angles % (2 * Math.PI)).toFixed(4);
  if (spinPending) {
    spinPending = false;
    performance.mark('margo-spin-rendered');
  }
  if (running) schedule();
}

function schedule() {
  if (frame === undefined && !stop.signal.aborted) frame = requestAnimationFrame((now) => {
    try { render(now); } catch (error) { fail(error); }
  });
}
function dispose() {
  stop.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error) {
  if (stop.signal.aborted) return;
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The brake exhibit could not open in this browser.';
  controls.forEach((control) => { control.disabled = true; });
  console.error(error);
  dispose();
}
async function start() {
  const forceFallback = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const density = Math.min(devicePixelRatio, 1.5);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * density));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * density));
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, antialias: true, capacity: 210,
    camera: { fov: 33, near: .14, far: 15 }, signal: stop.signal, startupTimeout: 9000,
  });
  if (!forceFallback) {
    try { engine = await open(); }
    catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const fallback = !engine;
  if (fallback) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: stop.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#62645a';
  engine.lighting.direction.set([-.51, .69, .52, 2.13]);
  engine.lighting.radiance.set([1, .93, .82, .39]);
  engine.lighting.ambient.set([.63, .69, .65]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .12, normalBias: .00065,
    bounds: { min: [-.46, -.09, -.30], max: [.46, .59, .31] },
  });
  await EnvironmentLighting.load(engine, studioMap(), { size: 32, specularSize: 32, intensity: 1.03, signal: stop.signal });
  apparatus = makeApparatus(engine, shadows);
  measure();
  chart();
  render(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (stop.signal.aborted) return;
  const options = { signal: stop.signal };
  spin.addEventListener('click', () => {
    run = freshRun();
    run.angle = angles;
    lastPlot = 0;
    samples = [[0, launchRpm]];
    chart();
    updateReadout();
    spinPending = true;
    schedule();
  }, options);
  current.addEventListener('input', () => {
    currentRatio = current.valueAsNumber / 100;
    level.textContent = current.value + '%';
    current.setAttribute('aria-valuetext', current.value + ' percent');
    updateReadout();
    schedule();
  }, options);
  trace.addEventListener('click', () => {
    showTrace = !showTrace;
    trace.setAttribute('aria-pressed', String(showTrace));
    schedule();
  }, options);
  observer = new ResizeObserver(() => { measure(); schedule(); });
  observer.observe(canvas);
  controls.forEach((control) => { control.disabled = false; });
  updateReadout();
  document.body.dataset.renderer = fallback ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  loading.hidden = true;
  performance.mark('margo-first-usable-frame');
}
window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: stop.signal });
start().catch(fail);

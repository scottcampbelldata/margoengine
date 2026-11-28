import { EngineKernel } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { presets } from './acoustics.js';
import { preparePressureDisplay } from './pressure.js';
import { prepareRoom } from './room.js';

const canvas = document.querySelector('#scene');
const slider = document.querySelector('#pitch');
const frequency = document.querySelector('#frequency');
const status = document.querySelector('#loading');
const level = document.querySelector('#level');
const mode = document.querySelector('#mode');
const listen = document.querySelector('#listen');
const audioStatus = document.querySelector('#audio-status');
const buttons = [...document.querySelectorAll('[data-preset]')];
const slices = [...document.querySelectorAll('[data-slice]')];
const sliceCaption = document.querySelector('#slice-caption');
const stop = new AbortController();
const listenerOptions = { signal:stop.signal };
const yaw = .77, elevation = .48, fov = 33;
const target = [0,.71,-.10];
const direction = [Math.sin(yaw)*Math.cos(elevation),Math.sin(elevation),Math.cos(yaw)*Math.cos(elevation)];
const horizontal = [Math.cos(yaw),0,-Math.sin(yaw)];
const vertical = [-Math.sin(yaw)*Math.sin(elevation),Math.cos(elevation),-Math.cos(yaw)*Math.sin(elevation)];
const corners = [
  [-2.65,-.52,-3.35],[2.65,-.52,-3.35],[-2.65,-.52,3.35],[2.65,-.52,3.35],
  [-2.65,2.87,-3.35],[2.60,2.87,-3.35],[-2.65,2.87,3.22],
];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
let engine, model, pressure, resize, frame, orientation='plan';
let audio, tone, startingTone = false;

function updateCamera() {
  const width = Math.max(1,canvas.clientWidth), height = Math.max(1,canvas.clientHeight);
  const ratio = Math.min(Math.max(devicePixelRatio,1.25),1.5);
  const pixels = [Math.round(width*ratio),Math.round(height*ratio)];
  if (canvas.width !== pixels[0]) canvas.width = pixels[0];
  if (canvas.height !== pixels[1]) canvas.height = pixels[1];
  const slope = Math.tan(fov*Math.PI/360);
  const distance = Math.max(...corners.map((corner) => {
    const b = corner.map((v,i) => v-target[i]);
    return dot(b,direction) + Math.max(
      Math.abs(dot(b,horizontal))/(slope*.94*width/height),
      Math.abs(dot(b,vertical))/(slope*.865),
    );
  }));
  engine.camera.target = target;
  engine.camera.position = target.map((v,i) => v+direction[i]*distance);
}

function showReading(value, reading) {
  const [number] = frequency.childNodes;
  number.nodeValue = value.toFixed(1)+' ';
  const { x,y,z,frequency:resonance } = reading.strongest;
  const dimensions = Number(x!==0)+Number(y!==0)+Number(z!==0);
  mode.textContent = ['','Axial','Tangential','Oblique'][dimensions]+' '+x+'·'+y+'·'+z;
  mode.title = 'Natural frequency '+resonance.toFixed(1)+' Hz. Orders shown as width, height, length.';
  level.textContent = (reading.level<-.05 ? '−' : '')+Math.abs(reading.level).toFixed(1)+' dB';
  document.body.dataset.frequency = value.toFixed(1);
  document.body.dataset.mode = [x,y,z].join(',');
}

function draw() {
  frame = undefined;
  if (stop.signal.aborted) return;
  try {
    const value = Number(slider.value);
    const reading = pressure.setPressure(value,orientation);
    showReading(value,reading);
    updateCamera();
    engine.render({ delta:0 });
  } catch (error) {
    fail(error);
  }
}

function enqueueDraw() {
  frame ??= requestAnimationFrame(draw);
}

function selectFrequency() {
  const value = Number(slider.value);
  const [number] = frequency.childNodes;
  number.nodeValue = value.toFixed(1)+' ';
  for (const [index,button] of buttons.entries())
    button.setAttribute('aria-pressed',String(value===presets[index].frequency));
  tone?.oscillator.frequency.setTargetAtTime(value,audio.currentTime,.045);
  enqueueDraw();
}

function selectSlice(button) {
  orientation = button.dataset.slice;
  document.body.dataset.slice = orientation;
  sliceCaption.textContent = orientation==='plan' ? 'Ear-height pressure' : 'Centerline pressure';
  for (const slice of slices) slice.setAttribute('aria-pressed',String(slice===button));
  enqueueDraw();
}

function endTone() {
  if (!tone) return;
  const now = audio.currentTime, { gain,oscillator,began } = tone;
  const age = now-began;
  const held = .046*Math.max(0,Math.min(1,age/.10,(2-age)/.13));
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(held,now);
  gain.gain.linearRampToValueAtTime(0,now+.065);
  oscillator.stop(now+.071);
}

async function playTone() {
  if (startingTone) return;
  if (tone) return endTone();
  startingTone = true;
  try {
    audio ??= new AudioContext();
    await audio.resume();
    if (stop.signal.aborted) return;
    const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.value = Number(slider.value);
    gain.gain.setValueAtTime(0,now);
    gain.gain.linearRampToValueAtTime(.046,now+.10);
    gain.gain.setValueAtTime(.046,now+1.87);
    gain.gain.linearRampToValueAtTime(0,now+2);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.addEventListener('ended',() => {
      if (tone?.oscillator===oscillator) tone = undefined;
      oscillator.disconnect();
      gain.disconnect();
      listen.setAttribute('aria-pressed','false');
      listen.lastChild.nodeValue = ' Hear test tone';
      document.body.dataset.tone = 'idle';
    },{ once:true });
    oscillator.start(now);
    oscillator.stop(now+2.01);
    tone = { oscillator,gain,began:now };
    listen.setAttribute('aria-pressed','true');
    listen.lastChild.nodeValue = ' Stop test tone';
    document.body.dataset.tone = 'playing';
    audioStatus.hidden = true;
  } catch (error) {
    audioStatus.textContent = 'Audio could not start on this device.';
    audioStatus.hidden = false;
  } finally { startingTone = false; }
}

function connect() {
  slider.addEventListener('input',selectFrequency,listenerOptions);
  for (const [index,button] of buttons.entries())
    button.addEventListener('click',() => { slider.value=String(presets[index].frequency); selectFrequency(); },listenerOptions);
  for (const button of slices) button.addEventListener('click',() => selectSlice(button),listenerOptions);
  listen.addEventListener('click',playTone,listenerOptions);
  document.addEventListener('visibilitychange',() => { if(document.hidden) endTone(); },listenerOptions);
  resize = new ResizeObserver(() => {
    if (stop.signal.aborted) return;
    try { updateCamera(); engine.render({ delta:0 }); } catch (error) { fail(error); }
  });
  resize.observe(canvas);
}

function dispose() {
  stop.abort();
  if (frame !== undefined) cancelAnimationFrame(frame);
  resize?.disconnect();
  if (audio && audio.state !== 'closed') void audio.close();
  pressure?.dispose();
  model?.dispose();
  engine?.dispose();
}

function fail(error) {
  dispose();
  document.body.dataset.state = 'error';
  status.textContent = 'This browser could not open the listening room.';
  status.hidden = false;
  console.error(error);
}

async function createRenderer(forceFallback) {
  const options = { backend:'webgpu', exactSize:true, antialias:false, startupTimeout:5000, signal:stop.signal,
    camera:{ fov,near:.4,far:85 } };
  if (!forceFallback) {
    try { return { engine:await EngineKernel.create(canvas,options),renderer:'webgpu' }; }
    catch (error) {
      if (error?.code!=='unsupported' && error?.code!=='timeout') throw error;
    }
  }
  const { install } = await import('@margoengine/webgl2-compat');
  await install({ force:true });
  return { engine:await EngineKernel.create(canvas,options),renderer:'compatibility' };
}

async function open() {
  const forceFallback = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const [rendering,attachRoom,attachPressure] = await Promise.all([
    createRenderer(forceFallback),
    Promise.resolve().then(prepareRoom),
    Promise.resolve().then(() => preparePressureDisplay(Number(slider.value))),
  ]);
  engine = rendering.engine;
  document.body.dataset.renderer = rendering.renderer;
  engine.onError = fail;
  engine.scene.background = '#23232a';
  engine.lighting.direction.set([.38,.83,.45,2.58]);
  engine.lighting.radiance.set([1,.91,.83,.23]);
  engine.lighting.ambient.set([.29,.30,.38]);
  const shadows = Shadows.attach(engine,{ resolution:1024, bounds:{ min:[-3,-.64,-3.7],max:[3,3.04,3.7] },
    normalBias:.019, filter:'pcf' });
  performance.mark('margo-device-ready');
  model = attachRoom(engine,shadows);
  pressure = attachPressure(engine);
  updateCamera();
  engine.render({ delta:0 });
  performance.mark('margo-frame-submitted');
  await engine.gpu.queue.onSubmittedWorkDone();
  if (stop.signal.aborted) return;
  connect();
  showReading(Number(slider.value),pressure.first);
  for (const control of [slider,listen,...buttons,...slices]) control.disabled = false;
  document.body.dataset.state = 'ready';
  document.body.dataset.slice = orientation;
  status.hidden = true;
  performance.mark('margo-first-usable-frame');
}

addEventListener('pagehide',(event) => { if (!event.persisted) dispose(); });
open().catch((error) => { if (!stop.signal.aborted) fail(error); });

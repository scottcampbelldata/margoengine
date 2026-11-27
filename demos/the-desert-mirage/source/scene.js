import { Engine } from '@margoengine/core';
import { ambient, criticalAngle, eyeHeight, refractiveIndex, targetAngle, trace } from './optics.js';
import { installRoad } from './road.js';
import { installSection } from './section.js';

const canvas = document.querySelector('#scene');
const slider = document.querySelector('#temperature');
const value = document.querySelector('#temperature-value');
const result = document.querySelector('#ray');
const index = document.querySelector('#index');
const compare = document.querySelector('#compare');
const toggle = document.querySelector('#section');
const caption = document.querySelector('#caption');
const loading = document.querySelector('#loading');
const controls = [slider,compare,toggle];
const lifetime = new AbortController();
const initial = Number(slider.value);
let temperature = initial;
let previousHot = initial;
let traced = false;
let engine, road, section, resizeObserver, frame;
let dirty = false;
let applied = false;

function resize() {
  const {width,height} = canvas.getBoundingClientRect();
  canvas.width = Math.max(1,Math.round(width * 1.5));
  canvas.height = Math.max(1,Math.round(height * 1.5));
}

function updateLabels() {
  const ray = trace(targetAngle,temperature);
  const delta = (refractiveIndex(eyeHeight,temperature) - refractiveIndex(0,temperature)) * 1e6;
  value.value = temperature + ' °C';
  slider.setAttribute('aria-valuetext',temperature + ' degrees Celsius');
  result.value = ray.kind === 'turned' ? 'Turns at ' + (ray.turn.height * 100).toFixed(1) + ' cm'
    : ray.kind === 'ground' ? 'Hits the road' : 'Still descending';
  index.value = delta.toFixed(1) + ' ppm';
  compare.textContent = temperature === ambient ? 'Heat the road' : 'Cool the road';
  toggle.textContent = traced ? 'Show road view' : 'Show ray section';
  toggle.setAttribute('aria-pressed',String(traced));
  caption.hidden = !traced;
  return {ray,delta};
}

function paint() {
  frame = undefined;
  if(dirty) {
    road.setTemperature(temperature);
    section.setTemperature(temperature);
    dirty = false;
  }
  road.setView(traced);
  section.setView(traced);
  const distance = Math.max(1,canvas.height / canvas.width * 2.14);
  engine.camera.position = [-.255 * distance,.398 + .51 * distance,2.37 * distance];
  engine.camera.target = [0,.362,.06];
  engine.render();
  const {ray,delta} = updateLabels();
  Object.assign(document.body.dataset,{
    temperature, view:traced ? 'section' : 'road', ray:ray.kind,
    height:ray.turn?.height.toFixed(8) ?? '', index:delta.toFixed(6),
    critical:criticalAngle(temperature).toFixed(8),
  });
  if(applied && !performance.getEntriesByName('margo-temperature-applied').length){
    engine.gpu.queue.onSubmittedWorkDone().then(()=>{
      if(!lifetime.signal.aborted)performance.mark('margo-temperature-applied');
    }).catch(fail);
  }
}
function schedule() {
  if(frame === undefined)frame = requestAnimationFrame(paint);
}
function update(next) {
  temperature = next;
  slider.value = next;
  if(next > ambient)previousHot = next;
  dirty = true;
  applied = true;
  schedule();
}

function dispose() {
  if(lifetime.signal.aborted)return;
  lifetime.abort();
  resizeObserver?.disconnect();
  if(frame !== undefined)cancelAnimationFrame(frame);
  road?.dispose();
  engine?.dispose();
}
function fail(error) {
  if(lifetime.signal.aborted)return;
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The desert road could not open on this browser.';
  for(const control of controls)control.disabled = true;
  console.error(error);
  dispose();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas,{
    backend:'webgpu',exactSize:true,capacity:128,signal:lifetime.signal,startupTimeout:10000,
    camera:{fov:38,near:.055,far:80},
  });
  if(!forced){
    try { engine = await open(); } catch(error) { if(error?.code !== 'unsupported')throw error; }
  }
  const compat = !engine;
  if(compat){
    const {install} = await import('@margoengine/webgl2-compat');
    await install({force:true,signal:lifetime.signal});
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#37262b';
  engine.lighting.direction.set([-.65,1.05,.58,3.7]);
  engine.lighting.radiance.set([1,.89,.76,.76]);
  engine.lighting.ambient.set([.76,.84,1]);
  road = installRoad(engine,initial);
  section = installSection(engine,initial);
  Object.assign(document.body.dataset,{renderer:compat ? 'compatibility' : 'webgpu', meshes:section.modelParts.length});
  paint();
  await road.ready();
  paint();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if(lifetime.signal.aborted)return;
  const options = {signal:lifetime.signal};
  slider.addEventListener('input',()=>update(Number(slider.value)),options);
  compare.addEventListener('click',()=>update(temperature === ambient ? previousHot : ambient),options);
  toggle.addEventListener('click',()=>{traced = !traced; schedule();},options);
  addEventListener('pagehide',(event)=>{if(!event.persisted)dispose();},options);
  resizeObserver = new ResizeObserver(()=>{ resize(); schedule(); });
  resizeObserver.observe(canvas);
  for(const control of controls)control.disabled = false;
  document.body.dataset.state = 'ready';
  loading.hidden = true;
  performance.mark('margo-first-usable-frame');
}
await start().catch(fail);

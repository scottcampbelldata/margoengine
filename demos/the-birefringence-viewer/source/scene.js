import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createPolariscope } from './model.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const load = document.querySelector('#load');
const angle = document.querySelector('#angle');
const loadOutput = document.querySelector('#load-output');
const angleOutput = document.querySelector('#angle-output');
const filter = document.querySelector('#parallel');
const view = document.querySelector('#view');
const controls = [load, angle, filter, view];
const lifetime = new AbortController();
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const wide = { target: [0,.239,.039], offset: [.49,.505,1.145], fitAspect: 1.10 };
const close = { target: [.012,.315,.112], offset: [.19,.227,.75], fitAspect: .92 };
const mix = (a,b,t) => a + (b-a)*t;
let force = Number(load.value), degrees = Number(angle.value);
let engine, polariscope, observer, frame, last = 0;
let detail = false, zoom = 0, parallel = false, dirty = true, pending = false;

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * 1.5));
  const height = Math.max(1, Math.round(bounds.height * 1.5));
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
}

function readout() {
  const weight = force.toLocaleString('en-US');
  loadOutput.value = weight + ' N';
  load.setAttribute('aria-valuetext', weight + ' newtons');
  angleOutput.value = degrees + '°';
  angle.setAttribute('aria-valuetext', degrees + ' degrees');
  filter.setAttribute('aria-pressed', String(parallel));
  filter.textContent = parallel ? 'Use crossed filters' : 'Use parallel filters';
  view.setAttribute('aria-pressed', String(detail));
  view.textContent = detail ? 'Whole instrument' : 'Disc close-up';
}

function paint(now) {
  frame = undefined;
  const delta = last ? Math.min(.06, (now-last)/1000) : 1/60;
  last = now;
  const target = Number(detail);
  zoom = motion.matches || Math.abs(zoom-target) < .001 ? target : mix(target,zoom,Math.exp(-delta*15));
  const fit = Math.max(1, mix(wide.fitAspect,close.fitAspect,zoom)*canvas.height/canvas.width);
  const focus = wide.target.map((value,i) => mix(value,close.target[i],zoom));
  engine.camera.target = focus;
  engine.camera.position = focus.map((value,i) => value + fit*mix(wide.offset[i],close.offset[i],zoom));
  if (dirty) {
    polariscope.update(force,degrees,parallel);
    dirty = false;
  }
  engine.render({ delta });
  Object.assign(document.body.dataset, { force,degrees,mode:parallel?'parallel':'crossed',
    view:zoom===1?'disc':zoom===0?'overview':'moving' });
  if (pending) {
    performance.mark('margo-load-applied');
    pending = false;
  }
  if (zoom !== target) schedule();
  else last = 0;
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => { try { paint(now); } catch (error) { fail(error); } });
}

function adjust() {
  dirty = true;
  readout();
  schedule();
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
  polariscope?.dispose();
}

function fail(error) {
  document.body.dataset.state = 'error';
  for (const control of controls) control.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The polariscope could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend:'webgpu', exactSize:true, capacity:192, signal:lifetime.signal, startupTimeout:10000,
    camera:{ fov:37, near:.100, far:27 },
  });
  if (!forced) {
    try { engine = await open(); } catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const compatibility = !engine;
  if (compatibility) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force:true,signal:lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#64736b';
  engine.lighting.direction.set([-.55,1.33,.78,3.52]);
  engine.lighting.radiance.set([1,.93,.80,.46]);
  engine.lighting.ambient.set([.79,.93,1]);
  const shadows = Shadows.attach(engine, {
    resolution:1024, filter:'soft', lightSize:.057, blockerSamples:8, samples:16, jitter:false,
    bounds:{ min:[-.67,-.22,-.62],max:[.64,.69,.61] },
  });
  polariscope = createPolariscope(engine,shadows);
  Object.assign(document.body.dataset, { renderer:compatibility?'compatibility':'webgpu',meshes:polariscope.meshes });
  paint(performance.now());
  await polariscope.ready();
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal:lifetime.signal };
  load.addEventListener('input',() => { force = Number(load.value); pending = true; adjust(); },options);
  angle.addEventListener('input',() => { degrees = Number(angle.value); adjust(); },options);
  filter.addEventListener('click',() => { parallel = !parallel; adjust(); },options);
  view.addEventListener('click',() => { detail = !detail;readout();schedule(); },options);
  motion.addEventListener('change',schedule,options);
  addEventListener('pagehide',(event) => { if (!event.persisted) clean(); },options);
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas);
  readout();
  for (const control of controls) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

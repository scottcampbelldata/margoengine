import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { createPress } from './model.js';
import { bandSpacing } from './grating.js';

const canvas = document.querySelector('#glass');
const loading = document.querySelector('#loading');
const angle = document.querySelector('#angle');
const output = document.querySelector('#angle-output');
const spacing = document.querySelector('#spacing');
const description = document.querySelector('#description');
const lift = document.querySelector('#lift');
const presets = Array.from(document.querySelectorAll('[data-angle]'));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const lifetime = new AbortController();
const pressView = { target: [-.014, .049, .053], offset: [.39, 1.00, .86], fitAspect: 1.09 };
const openView = { target: [-.01, .161, -.044], offset: [.45, .83, 1.02], fitAspect: 1.07 };
const mix = (from, to, amount) => from + (to - from) * amount;
let engine, press, observer, frame, last = 0;
let degrees = Number(angle.value), liftTarget = 0, opening = 0, pending = false;

function resize() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * 1.5));
  const height = Math.max(1, Math.round(bounds.height * 1.5));
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
}

function status() {
  const pitch = bandSpacing(degrees);
  output.value = degrees + '°';
  angle.setAttribute('aria-valuetext', degrees + ' degrees');
  spacing.value = liftTarget ? '—' : Number.isFinite(pitch) ? Math.round(pitch * 1000) + ' mm' : 'Aligned';
  const detail = liftTarget ? 'Close the press to see the two screens overlap.'
    : degrees === 0 ? 'The slits line up. No broad bands form.' : 'Measured perpendicular to the bands.';
  if (description.textContent !== detail) description.textContent = detail;
  lift.setAttribute('aria-pressed', String(Boolean(liftTarget)));
  lift.textContent = liftTarget ? 'Close the press' : 'Lift top screen';
  for (const preset of presets) preset.setAttribute('aria-pressed', String(Number(preset.dataset.angle) === degrees));
}

function paint(now) {
  frame = undefined;
  const delta = last ? Math.min(.06, (now - last) / 1000) : 1 / 60;
  last = now;
  opening = reducedMotion.matches || Math.abs(opening - liftTarget) < .001
    ? liftTarget : mix(liftTarget, opening, Math.exp(-delta * 14));
  const fit = Math.max(1, mix(pressView.fitAspect, openView.fitAspect, opening) * canvas.height / canvas.width);
  const target = pressView.target.map((value, i) => mix(value, openView.target[i], opening));
  engine.camera.target = target;
  engine.camera.position = target.map((value, i) => value + fit * mix(pressView.offset[i], openView.offset[i], opening));
  press.update(degrees, opening);
  engine.render({ delta });
  Object.assign(document.body.dataset, { angle: degrees, spacing: String(bandSpacing(degrees)),
    lift: opening === 1 ? 'open' : opening === 0 ? 'closed' : 'moving' });
  if (pending) {
    performance.mark('margo-angle-applied');
    pending = false;
  }
  if (opening !== liftTarget) schedule();
  else last = 0;
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => { try { paint(now); } catch (error) { fail(error); } });
}

function turn(next) {
  if (next === degrees) return;
  degrees = next;
  angle.value = String(next);
  status();
  pending = true;
  schedule();
}

function clean() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}

function fail(error) {
  document.body.dataset.state = 'error';
  for (const control of [angle, lift, ...presets]) control.disabled = true;
  loading.hidden = false;
  loading.textContent = 'The press could not open on this browser.';
  console.error(error);
  clean();
}

async function start() {
  resize();
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu', exactSize: true, capacity: 128, signal: lifetime.signal, startupTimeout: 10000,
    camera: { fov: 39, near: .095, far: 27 },
  });
  if (!forced) {
    try { engine = await open(); } catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const compat = !engine;
  if (compat) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#9a8582';
  engine.lighting.direction.set([-.57, 1.62, .60, 3.2]);
  engine.lighting.radiance.set([1, .91, .79, .45]);
  engine.lighting.ambient.set([.83, .97, 1]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .076, blockerSamples: 8, samples: 16, jitter: false,
    bounds: { min: [-.68, -.20, -.66], max: [.70, .64, .71] },
  });
  press = createPress(engine, shadows);
  Object.assign(document.body.dataset, { renderer: compat ? 'compatibility' : 'webgpu', meshes: press.meshes });
  paint(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  const options = { signal: lifetime.signal };
  angle.addEventListener('input', () => turn(Number(angle.value)), options);
  for (const button of presets) button.addEventListener('click', () => turn(Number(button.dataset.angle)), options);
  lift.addEventListener('click', () => { liftTarget = 1 - liftTarget; status(); schedule(); }, options);
  reducedMotion.addEventListener('change', schedule, options);
  addEventListener('pagehide', (event) => { if (!event.persisted) clean(); }, options);
  observer = new ResizeObserver(() => { if (resize()) schedule(); });
  observer.observe(canvas);
  status();
  for (const control of [angle, lift, ...presets]) control.disabled = false;
  loading.hidden = true;
  document.body.dataset.state = 'ready';
  performance.mark('margo-first-usable-frame');
}

await start().catch(fail);

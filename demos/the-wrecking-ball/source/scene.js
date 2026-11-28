import { Engine } from '@margoengine/core';
import { Environment, EnvironmentBackground, EnvironmentLighting } from '@margoengine/environment';
import { STUDIO_LIGHTS, studio } from '@margoengine/environment/studio';
import { Shadows } from '@margoengine/shadows';
import { PostStack } from '@margoengine/post/stack';
import { ContactShadows } from '@margoengine/post/contact-shadows';
import { Tonemap } from '@margoengine/tonemap';
import { demoStatus } from 'margo-demo-status';
import { buildExhibit } from './art.js';
import { createTrial, disposeTrial, loadTrial, run, trialSeconds } from './trial.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene'), loading = $('#loading'), errorNotice = $('#error'), controls = $('#controls');
const releaseButton = $('#release'), note = $('#trial');
const angles = [...document.querySelectorAll('input[name=angle]')];
const status = demoStatus($('#exhibit'), loading, errorNotice);
const lifetime = new AbortController();
/** Playback runs slower than real time so the strike can be followed; the solver's own time is unchanged. */
const playback = 0.68;
let engine, art, trial, frame, last, observer, running = false;

function size() {
  const bounds = canvas.getBoundingClientRect(), density = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
  if (!engine) return;
  // On narrow screens the camera backs off along its own line so the crane and the tower stay in frame.
  const fit = Math.max(1, (1.32 * canvas.height) / canvas.width), target = [-0.11, 0.33, 0], offset = [0.52, 0.3, 1.78];
  engine.camera.target = target;
  engine.camera.position = target.map((t, i) => t + offset[i] * fit);
}

function show() {
  $('#speed').textContent = trial.impactSpeed === null ? '—' : trial.impactSpeed.toFixed(2);
  $('#fallen').textContent = String(trial.fallen.size);
  Object.assign(document.body.dataset, { fallen: trial.fallen.size, impact: trial.impactSpeed?.toFixed(4) ?? '', time: trial.time.toFixed(3) });
}

function draw(now) {
  frame = undefined;
  const delta = last === undefined ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = running ? now : undefined;
  if (running) {
    run(trial, delta * playback);
    if (trial.done) (running = false), (note.textContent = 'Trial complete. Rebuild the tower to run another.');
    show();
  }
  art.pose(trial);
  engine.render({ delta });
  if (running) schedule();
}

function schedule() {
  if (frame !== undefined || lifetime.signal.aborted) return;
  frame = requestAnimationFrame((now) => {
    try { draw(now); } catch (error) { fail(error); }
  });
}

function rebuild() {
  disposeTrial(trial);
  trial = createTrial(Number(angles.find((a) => a.checked)?.value ?? 58));
  running = false;
  releaseButton.disabled = false;
  note.textContent = 'The ball is latched.';
  show();
  schedule();
}

function dispose() {
  lifetime.abort();
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
  disposeTrial(trial);
}

function fail(error) {
  if (lifetime.signal.aborted) return;
  console.error(error);
  status.error(error);
  errorNotice.hidden = false;
  loading.hidden = true;
  controls.disabled = true;
  dispose();
}

async function start() {
  const options = { backend: 'webgpu', exactSize: true, antialias: true, startupTimeout: 9000, signal: lifetime.signal, camera: { fov: 32, near: 0.05, far: 60 } };
  size();
  if (new URLSearchParams(location.search).get('backend') !== 'webgl2') {
    engine = await Engine.create(canvas, options).catch((error) => { if (error?.code !== 'unsupported') throw error; });
  }
  const compatibility = !engine;
  if (compatibility) {
    await (await import('@margoengine/webgl2-compat')).install({ force: true, signal: lifetime.signal });
    engine = await Engine.create(canvas, options);
  }
  engine.onError = fail;
  // A dark warm studio for reflections and the backdrop: the package's overhead, key, fill and rim softboxes, plus a
  // low warm card that lifts the tower's front faces.
  const warmCard = { direction: [0.3, 0.12, 1], width: 0.7, height: 0.25, intensity: 1.2, color: [1, 0.86, 0.7] };
  const room = studio({ floor: [0.05, 0.047, 0.045], walls: [0.13, 0.125, 0.12], ceiling: [0.34, 0.33, 0.31], lights: [...STUDIO_LIGHTS, warmCard] });
  const environment = await Environment.attach(engine, room, { intensity: 0.42 });
  EnvironmentLighting.attach(engine, environment);
  EnvironmentBackground.attach(engine, environment, { blur: 0.6, exposure: 0.42 });
  // The key: a warm light from the front left that casts the soft shadows.
  engine.lighting.direction.set([-0.42, 0.82, 0.4, 4.2]);
  engine.lighting.radiance.set([1, 0.93, 0.84, 0.35]);
  engine.lighting.ambient.set([0.55, 0.6, 0.66]);
  const shadows = Shadows.attach(engine, {
    resolution: 2048, filter: 'soft', lightSize: 0.022, samples: 64, blockerSamples: 24, jitter: false, normalBias: 0.001,
    bounds: { min: [-0.82, -0.06, -0.4], max: [0.82, 0.9, 0.4] },
  });
  PostStack.attach(engine, [new ContactShadows({ distance: 0.06, thickness: 0.03, strength: 0.75 }), new Tonemap({ curve: 'agx', exposure: 0.2, contrast: 1.1, vignette: 0.3 })]);
  await loadTrial(lifetime.signal);
  art = buildExhibit(engine, shadows);
  rebuild();
  size();
  draw(performance.now());
  await engine.gpu.queue.onSubmittedWorkDone();
  if (lifetime.signal.aborted) return;

  const listen = { signal: lifetime.signal };
  releaseButton.addEventListener('click', () => {
    if (running || trial.done) return;
    running = true;
    releaseButton.disabled = true;
    note.textContent = `The ball swings. The solver runs ${trialSeconds} s, shown at ${Math.round(playback * 100)}% speed.`;
    schedule();
  }, listen);
  $('#reset').addEventListener('click', rebuild, listen);
  for (const input of angles) input.addEventListener('change', rebuild, listen);
  observer = new ResizeObserver(() => (size(), schedule()));
  observer.observe(canvas);
  controls.disabled = false;
  loading.hidden = true;
  document.body.dataset.renderer = compatibility ? 'compatibility' : 'webgpu';
  status.ready();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);

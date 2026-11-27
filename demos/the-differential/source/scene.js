import { Engine } from '@margoengine/core';
import { EnvironmentLighting } from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { carrierRpm, gearPose, pinionTeeth, speeds } from './kinematics.js';
import { makeRig } from './rig.js';
import { frameDelta } from './clock.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const steering = document.querySelector('#turn');
const turnValue = document.querySelector('#turn-value');
const pause = document.querySelector('#pause');
const view = document.querySelector('#view');
const left = document.querySelector('#left');
const right = document.querySelector('#right');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const lifetime = new AbortController();
const controls = [steering, pause, view];
const tau = Math.PI * 2;
const timeScale = 1 / 7;

let engine, rig, resizeObserver, frame;
let last, distance = 0;
let isPaused = reduced.matches, closeUp = false, changed = false;
let rates = speeds(0);
let carrierAngle = .22, sideOffset = 0;

function reflectionStudio() {
  const width = 80, height = 40, data = new Float32Array(width * height * 4);
  const panels = [
    [-.82, .73, .51, .28, [7.1, 6.3, 5.25]],
    [1.02, .26, .31, .52, [3.75, 4.75, 5.35]],
    [2.77, .50, .64, .12, [3.45, 3.77, 3.76]],
  ];
  for (let y = 0; y < height; y++) {
    const elevation = Math.PI * (.5 - (y + .5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = tau * ((x + .5) / width - .5);
      const room = .12 + .11 * Math.max(0, elevation);
      const rgb = [room * .91, room, room * 1.05];
      for (const [bearing, tilt, w, h, power] of panels) {
        const offset = Math.atan2(Math.sin(azimuth - bearing), Math.cos(azimuth - bearing));
        const square = Math.exp(-1.9 * ((offset / w) ** 4 + ((elevation - tilt) / h) ** 4));
        for (let channel = 0; channel < 3; channel++) rgb[channel] += square * power[channel];
      }
      data.set([...rgb, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function size() {
  const bounds = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio, 1.5);
  const width = Math.max(1, Math.round(bounds.width * density));
  const height = Math.max(1, Math.round(bounds.height * density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
function camera(t) {
  const aspect = canvas.width / canvas.height;
  const framing = Math.max(1, (1.81 - .32 * t) / aspect);
  const at = [-.012 + .024 * t, .128 + .094 * t, 0];
  engine.camera.target = at;
  engine.camera.position = [
    at[0] + (.30 - .11 * t) * framing,
    at[1] + (.55 - .22 * t) * framing,
    at[2] + (1.12 - .48 * t) * framing,
  ];
}

function schedule() {
  if (frame === undefined && !lifetime.signal.aborted) frame = requestAnimationFrame((now) => {
    try { draw(now); } catch (error) { fail(error); }
  });
}
function draw(now) {
  frame = undefined;
  const dt = frameDelta(last, now);
  last = now;
  if (!isPaused) {
    const mul = dt * timeScale * tau / 60;
    carrierAngle = (carrierAngle + carrierRpm * mul) % tau;
    sideOffset = (sideOffset + (rates.left - carrierRpm) * mul) % (tau * pinionTeeth);
  }
  const target = Number(closeUp);
  distance = Math.abs(target - distance) < .0008 || reduced.matches ? target
    : distance + (target - distance) * (1 - Math.exp(-(dt || .016) * 14));
  const pose = gearPose(carrierAngle, sideOffset);
  rig.setAngles(pose);
  camera(distance);
  engine.render({ delta: dt });
  document.body.dataset.left = rates.left.toFixed(1);
  document.body.dataset.right = rates.right.toFixed(1);
  document.body.dataset.spider = rates.spider.toFixed(1);
  document.body.dataset.gearPhase = pose.pinions.toFixed(4);
  document.body.dataset.view = distance === 0 ? 'bench' : distance === 1 ? 'gears' : 'moving';
  if (changed) {
    performance.mark('margo-steering-applied');
    changed = false;
  }
  if (!isPaused || target !== distance) schedule();
  else last = undefined;
}

function sync() {
  const v = Number(steering.value);
  const label = v === 0 ? 'Straight' : (v < 0 ? 'Left ' : 'Right ') + Math.abs(v) + '%';
  turnValue.textContent = label;
  steering.setAttribute('aria-valuetext', label);
  rates = speeds(v);
  left.textContent = rates.left.toFixed(1).replace(/\.0$/, '');
  right.textContent = rates.right.toFixed(1).replace(/\.0$/, '');
  pause.setAttribute('aria-pressed', String(isPaused));
  pause.textContent = isPaused ? 'Play' : 'Pause';
  view.setAttribute('aria-pressed', String(closeUp));
  view.textContent = closeUp ? 'Whole bench' : 'Gear close-up';
  schedule();
}
function dispose() {
  lifetime.abort();
  resizeObserver?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  engine?.dispose();
}
function fail(error) {
  if (lifetime.signal.aborted) return;
  document.body.dataset.state = 'error';
  controls.forEach((control) => { control.disabled = true; });
  loading.hidden = false;
  loading.textContent = 'The gear exhibit could not open on this browser.';
  console.error(error);
  dispose();
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const open = () => Engine.create(canvas, {
    backend: 'webgpu',
    exactSize: true,
    antialias: true,
    capacity: 192,
    camera: { fov: 32, near: .17, far: 20 },
    signal: lifetime.signal,
    startupTimeout: 9000,
  });
  size();
  if (!forced) {
    try { engine = await open(); }
    catch (error) { if (error?.code !== 'unsupported') throw error; }
  }
  const compatible = !engine;
  if (compatible) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: lifetime.signal });
    engine = await open();
  }
  engine.onError = fail;
  engine.scene.background = '#3d4849';
  engine.lighting.direction.set([-.46, .78, .43, 1.85]);
  engine.lighting.radiance.set([1, .92, .79, .34]);
  engine.lighting.ambient.set([.57, .69, .73]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, filter: 'soft', lightSize: .13, normalBias: .0007,
    bounds: { min: [-.51, -.07, -.31], max: [.51, .53, .31] },
  });
  await EnvironmentLighting.load(engine, reflectionStudio(), {
    size: 32, specularSize: 32, intensity: 1.04, signal: lifetime.signal,
  });
  rig = makeRig(engine, shadows);
  // The initial pose does not have an animation-frame timestamp.
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  if (lifetime.signal.aborted) return;
  performance.mark('margo-first-usable-frame');
  document.body.dataset.renderer = compatible ? 'compatibility' : 'webgpu';
  document.body.dataset.state = 'ready';
  loading.hidden = true;
  const options = { signal: lifetime.signal };
  controls.forEach((control) => { control.disabled = false; });
  steering.addEventListener('input', () => { changed = true; sync(); }, options);
  pause.addEventListener('click', () => { isPaused = !isPaused; sync(); }, options);
  view.addEventListener('click', () => { closeUp = !closeUp; sync(); }, options);
  reduced.addEventListener('change', () => { isPaused = reduced.matches; sync(); }, options);
  resizeObserver = new ResizeObserver(() => { size(); schedule(); });
  resizeObserver.observe(canvas);
  sync();
}

window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
start().catch(fail);

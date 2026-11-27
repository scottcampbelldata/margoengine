import { createStage } from '@margoengine/stage';
import { worldToScreen } from '@margoengine/math';
import { PostStack } from '@margoengine/post/stack';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { bounds, ground, levees, table } from './terrain.js';
import { nativeWater } from './native-water.js';

const canvas = document.querySelector('#terrain');
const loading = document.querySelector('#loading');
const release = document.querySelector('#release');
const reset = document.querySelector('#reset');
const view = document.querySelector('#view');
const sites = [...document.querySelectorAll('[data-site]')];
const settlement = document.querySelector('#settlement');
const headwater = document.querySelector('#headwater');
const village = document.querySelector('#village');
const velocity = document.querySelector('#velocity');
const selection = document.querySelector('#selection');
const message = document.querySelector('#message');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const stop = new AbortController();
let stage, set, run, renderId, resize;
let frameTime = 0, surveyTime = 0, releaseTime = null, selected = -1, villagePeak = 0;
let overhead = 0, framing = 0;
let epoch = 0, canFlow = false, requested = false, pending = false;
const vec = () => ({ x: 0, y: 0, z: 0 });

function fail(error) {
  document.body.dataset.state = 'error';
  loading.hidden = false;
  loading.textContent = 'The table could not open. ' + (error?.message ?? error);
  release.disabled = true;
  view.disabled = true;
  reset.disabled = true;
  stop.abort();
  console.error(error);
}

function sync() {
  selection.textContent = levees[selected]?.name ?? 'None';
  sites.forEach((site, index) => {
    site.disabled = requested;
    site.setAttribute('aria-pressed', String(index === selected));
  });
  release.disabled = requested || !canFlow;
  set.setWall(selected);
}

function newRun() {
  epoch++;
  requested = false;
  run?.reset();
  surveyTime = 0;
  releaseTime = null;
  villagePeak = 0;
  village.textContent = '—';
  velocity.textContent = '—';
  document.body.dataset.phase = 'holding';
  document.body.dataset.peak = '0';
  delete document.body.dataset.time;
  set.setGate(0);
  sync();
}

function project(x, y, z) {
  return worldToScreen({ x,y,z }, stage.engine.camera, canvas.clientWidth, canvas.clientHeight, vec());
}

function pin(element, x, y, z) {
  const screen = project(x,y,z);
  if (!screen) return;
  element.style.left = screen.x + 'px';
  element.style.top = screen.y + 'px';
}

function screenLabels() {
  pin(headwater, -20.5, 1.93, -1.7);
  pin(settlement, 21.2, ground(21.2,10.9) + 3.8, 10.9);
  sites.forEach((site,i) => {
    const {x,z} = levees[i];
    pin(site, x, ground(x,z+3.15) + 1.35, z+3.15);
  });
  const a = project(0,0,0), b = project(5,0,0);
  if (a && b) document.documentElement.style.setProperty('--scale', Math.round(Math.hypot(a.x-b.x,a.y-b.y)) + 'px');
}

function sizeCanvas() {
  const { width, height } = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(devicePixelRatio, 1.5);
  const nextWidth = Math.max(1, Math.round(width * pixelRatio));
  const nextHeight = Math.max(1, Math.round(height * pixelRatio));
  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
}

function render(now, continueLoop = true) {
  if (stop.signal.aborted) return;
  if (continueLoop) renderId = requestAnimationFrame(loop);
  if (frameTime && now - frameTime < 30) return;
  const delta = frameTime ? Math.min(.05, (now-frameTime)/1000) : 0;
  frameTime = now;
  overhead += (framing - overhead) * (motion.matches ? 1 : Math.min(1, delta * 6));
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const fit = Math.max(.91, 1.21 / aspect);
  stage.engine.camera.position = [(24-12*overhead)*fit, (54+20*overhead)*fit, (48-35*overhead)*fit];
  stage.engine.camera.target = [0,-.9,0];
  if (releaseTime !== null) {
    const t = Math.max(0, Math.min(1, (run.time-releaseTime)/.78));
    set.setGate(1 - (1 - t) ** 3);
    if (run.time - surveyTime > .34 && !pending) {
      surveyTime = run.time;
      survey(run, epoch);
    }
  }
  stage.engine.render({ delta: releaseTime === null ? 0 : delta });
  screenLabels();
}

function loop(now) {
  try {
    render(now);
  } catch (error) {
    fail(error);
  }
}

function survey(simulation, generation) {
  pending = true;
  void simulation.read().then(({ depth, width, height, maxSpeed, time, wetArea }) => {
    if (epoch !== generation || stop.signal.aborted) return;
    let peak = 0;
    for (let j = 0; j < height; j++) {
      const z = bounds.z + (j+.5)*bounds.length/height;
      if (z < 5.2 || z > 11.8) continue;
      for (let i = 0; i < width; i++) {
        const x = bounds.x + (i+.5)*bounds.width/width;
        if (x < 10.6 || x > 21.5) continue;
        peak = Math.max(peak, depth[j*width+i]);
      }
    }
    villagePeak = Math.max(peak, villagePeak);
    village.textContent = peak.toFixed(2) + ' m';
    velocity.textContent = maxSpeed.toFixed(1) + ' m/s';
    document.body.dataset.peak = (villagePeak).toFixed(3);
    document.body.dataset.wetArea = wetArea.toFixed(2);
    document.body.dataset.time = (time-releaseTime).toFixed(1);
  }).catch((error) => {
    if (epoch === generation && !stop.signal.aborted) fail(error);
  }).finally(() => { pending = false; });
}

function beginRelease() {
  if (!requested || !canFlow || releaseTime !== null) return;
  releaseTime = run.time;
  surveyTime = releaseTime;
  run.release(selected);
  performance.mark('margo-release-applied');
  document.body.dataset.phase = 'released';
  message.textContent = 'Reservoir released. Watch the surge move down the valley.';
}

function interact() {
  for (const [index, button] of sites.entries()) button.addEventListener('click', () => {
    selected = selected === index ? -1 : index;
    message.textContent = selected === -1 ? 'Floodwall removed.' : 'Floodwall placed at ' + levees[index].name.toLowerCase() + '.';
    sync();
  }, { signal: stop.signal });
  release.addEventListener('click', () => {
    requested = true;
    sync();
    beginRelease();
  }, { signal: stop.signal });
  reset.addEventListener('click', () => {
    selected = -1;
    newRun();
    message.textContent = 'Reservoir restored.';
  }, { signal: stop.signal });
  view.addEventListener('click', () => {
    framing = framing === 0 ? 1 : 0;
    view.setAttribute('aria-pressed', String(framing === 1));
    view.textContent = framing ? 'Table view' : 'Overhead';
  }, { signal: stop.signal });
}

async function start() {
  const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';
  sizeCanvas();
  const openStage = () => createStage(canvas, {
    autoStart: false, controls: false, exactSize: true, backend: 'webgpu',
    label: 'The Hawthorn hydraulic model', background: '#1a2521',
    camera: { near: 1, far: 300, fov: 39 }, onError: fail,
  });
  if (!forced) {
    try {
      stage = await openStage();
    } catch (error) {
      if (error?.code !== 'unsupported') throw error;
    }
  }
  const compatible = !stage;
  if (compatible) {
    const { install } = await import('@margoengine/webgl2-compat');
    await install({ force: true, signal: stop.signal });
    stage = await openStage();
  }
  const { engine } = stage;
  performance.mark('margo-engine-ready');
  engine.lighting.direction.set([-0.66,.72,.23,3.45]);
  engine.lighting.radiance.set([1,.895,.72,.22]);
  engine.lighting.ambient.set([.26,.36,.36]);
  const shadows = Shadows.attach(engine, {
    resolution: 1024, bounds: { min: [-30,-4,-17], max: [30,7,17] }, normalBias: .035,
    lightSize: .12, filter: 'pcf', samples: 12,
  });
  PostStack.attach(engine, [new Tonemap({ curve: 'agx', exposure: .16, contrast: 1.13 })]);
  set = table(engine, shadows);
  run = nativeWater(engine);
  performance.mark('margo-terrain-ready');
  newRun();
  interact();
  addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stop.abort();
    cancelAnimationFrame(renderId);
    resize?.disconnect();
    run.dispose();
    set.dispose();
    stage.dispose();
  });
  render(performance.now(), false);
  performance.mark('margo-first-submission');
  if (stop.signal.aborted) return;
  canFlow = true;
  sync();
  performance.mark('margo-simulation-ready');
  document.body.dataset.solver = 'margo-flood';
  document.body.dataset.renderer = compatible ? 'compatibility' : 'webgpu';
  await engine.gpu.queue.onSubmittedWorkDone();
  performance.mark('margo-first-gpu-complete');
  await new Promise(requestAnimationFrame);
  if (stop.signal.aborted) return;
  performance.mark('margo-first-usable-frame');
  document.body.dataset.state = 'ready';
  loading.hidden = true;
  renderId = requestAnimationFrame(loop);
  reset.disabled = false;
  view.disabled = false;
  resize = new ResizeObserver(sizeCanvas);
  resize.observe(canvas);
  if (new URLSearchParams(location.search).has('verify-surface')) {
    window.verifyFloodSurface = async () => {
      cancelAnimationFrame(renderId);
      try {
        return await run.verify();
      } finally {
        if (!stop.signal.aborted) renderId = requestAnimationFrame(loop);
      }
    };
  }
}

await start().catch(fail);

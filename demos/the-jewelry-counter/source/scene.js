import { createStage } from '@margoengine/stage';
import { EnvironmentLighting } from '@margoengine/environment';
import { planeGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material, Texture } from '@margoengine/materials';
import { PostStack } from '@margoengine/post/stack';
import { FXAA } from '@margoengine/post/fxaa';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { jewelry } from './model.js';

const canvas = document.querySelector('#ring-view');
const loading = document.querySelector('#loading');
const controls = [...document.querySelectorAll('button, input')];
const lightControl = document.querySelector('#light');
const angleDisplay = document.querySelector('#angle');
const macro = document.querySelector('#macro');
const opticsButton = document.querySelector('#optics');
const opticsKey = document.querySelector('#optics-key');
const finish = {
  gold: { color: [1, 0.74, 0.365], roughness: 0.23 },
  platinum: { color: [0.78, 0.83, 0.87], roughness: 0.23 },
  rose: { color: [0.97, 0.59, 0.47], roughness: 0.238 },
};
const initial = { yaw: 0.42, pitch: 0.62, distance: 0.064 };
const view = { ...initial };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
let stage;
let resize;
let raf;
let light;
let model;
let disposed = false;
let pixelRatio = 1;
let diagram;

function studioPixels() {
  const width = 128;
  const height = 64;
  const pixels = new Float32Array(width * height * 4);
  const lights = [
    [-0.9, 0.72, 0.72, 0.34, [8.1, 6.5, 4.72]],
    [1.02, 0.43, 0.16, 0.75, [4.8, 5.8, 7.5]],
    [2.90, 0.32, 1.12, 0.29, [1.2, 1.25, 1.44]],
    [-2.36, 0.92, 0.28, 0.23, [3.65, 3.05, 2.41]],
  ];
  for (let y = 0; y < height; y++) {
    const altitude = Math.PI * (0.5 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = Math.PI * 2 * ((x + 0.5) / width - 0.5);
      const base = 0.085 + 0.14 * Math.max(0, Math.sin(altitude));
      const rgb = [base * 1.06, base, base * 0.93];
      for (const [az, alt, w, h, radiance] of lights) {
        const distance = Math.atan2(Math.sin(azimuth - az), Math.cos(azimuth - az));
        const v = Math.exp(-2 * ((distance / w) ** 4 + ((altitude - alt) / h) ** 4));
        for (let i = 0; i < 3; i++) rgb[i] += v * radiance[i];
      }
      pixels.set([...rgb, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data: pixels };
}

function platform(engine) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const scratch = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const grain = Math.sin(i * 0.241 + Math.cos(j * 0.135) * 0.7) * Math.cos(j * 0.247);
      const pores = Math.sin(i * 2.227 + j * 0.69) * Math.sin(j * 2.36 - i * 0.38);
      const value = 46 + 3 * grain + 2.25 * pores;
      data.set([value * 1.05, value, value * 0.86, 255], (i + size * j) * 4);
      const rough = 220 + 13 * grain + 6 * pores;
      scratch.set([rough, rough, rough, 255], (i + size * j) * 4);
    }
  }
  const texture = new Texture({ width: size, height: size, data }, { colorSpace: 'srgb', wrapS: 'repeat', wrapT: 'repeat' });
  const roughnessMap = new Texture({ width: size, height: size, data: scratch }, { colorSpace: 'linear' });
  const felt = new Material({ color: '#526773', map: texture, roughness: 0.98, roughnessMap,
    sheenColor: '#263543', sheenRoughness: 0.94 });
  const edge = new Material({ color: '#75664d', metalness: 1, roughness: 0.37 });
  const counter = new Material({ color: '#161b2a', roughness: 0.96 });
  const platter = createMesh(engine, roundedBoxGeometry(0.103, 0.010, 0.078, 5, 0.0046), felt);
  platter.root.name = 'Velvet jeweler’s presentation pad';
  platter.root.setPosition([0, -0.00515, -0.001]).setRotation([0, 0.18, 0]);
  const trim = createMesh(engine, roundedBoxGeometry(0.105, 0.005, 0.080, 4, 0.0022), edge);
  trim.root.name = 'Oxidized bronze tray';
  trim.root.setPosition([0, -0.01004, -0.001]).setRotation([0, 0.18, 0]);
  const floor = createMesh(engine, planeGeometry(2.8, 2.8), counter);
  floor.root.setPosition([0, -0.01252, 0]).setRotation([-Math.PI / 2, 0, 0]);
  return { models: [platter, trim, floor], dispose: () => { texture.dispose(); roughnessMap.dispose(); } };
}

const fail = (error) => {
  loading.hidden = false;
  loading.textContent = 'The scene could not open: ' + (error?.message ?? String(error));
  document.body.dataset.state = 'error';
  console.error(error);
};

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function draw() {
  raf = undefined;
  if (disposed || !stage) return;
  resizeCanvas();
  const { yaw, pitch, distance } = view;
  const target = macro.getAttribute('aria-pressed') === 'true' ? [0, 0.0208, 0] : [0, 0.0108, 0];
  stage.engine.camera.target = target;
  const eye = [
    Math.sin(yaw) * Math.cos(pitch) * distance,
    target[1] + Math.sin(pitch) * distance,
    Math.cos(yaw) * Math.cos(pitch) * distance,
  ];
  stage.engine.camera.position = eye;
  model.optics.eye.value = [eye[0], eye[1] - 0.02574, eye[2]];
  stage.engine.render();
}
const invalidate = () => { if (raf === undefined) raf = requestAnimationFrame(draw); };
const updateLight = () => {
  const angle = Number(lightControl.value);
  const radians = angle * Math.PI / 180;
  angleDisplay.value = angle + '°';
  stage.engine.lighting.direction.set([Math.sin(radians) * 0.64, 0.77, Math.cos(radians) * 0.64, 2.15]);
  light.environment.rotation = radians - Math.PI * 0.23;
  model.optics.rotation.value = light.environment.rotation;
  diagram?.update(radians, opticsButton.getAttribute('aria-pressed') === 'true');
  invalidate();
};

function interactions() {
  let pointer;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(pointer.id);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointer?.id !== event.pointerId) return;
    view.yaw -= (event.clientX - pointer.x) * 0.0075;
    view.pitch = clamp(view.pitch + (event.clientY - pointer.y) * 0.006, 0.07, 1.28);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    invalidate();
  });
  canvas.addEventListener('lostpointercapture', () => { pointer = undefined; });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    view.distance = clamp(view.distance * Math.exp(event.deltaY * 0.002), 0.021, 0.135);
    invalidate();
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    const rotation = { ArrowLeft: [0.11, 0], ArrowRight: [-0.11, 0], ArrowUp: [0, 0.07], ArrowDown: [0, -0.07] }[event.key];
    if (!rotation) return;
    event.preventDefault();
    view.yaw += rotation[0];
    view.pitch = clamp(view.pitch + rotation[1], 0.07, 1.28);
    invalidate();
  });
  document.querySelector('#reset').addEventListener('click', () => {
    Object.assign(view, initial);
    macro.setAttribute('aria-pressed', 'false');
    invalidate();
  });
  macro.addEventListener('click', () => {
    const active = macro.getAttribute('aria-pressed') === 'true';
    macro.setAttribute('aria-pressed', String(!active));
    view.distance = active ? initial.distance : 0.031;
    invalidate();
  });
  const finishes = [...document.querySelectorAll('[data-finish]')];
  finishes.forEach((button) => button.addEventListener('click', () => {
    for (const other of finishes) other.setAttribute('aria-pressed', String(other === button));
    const { color, roughness } = finish[button.dataset.finish];
    model.metal.color = color;
    model.metal.roughness = roughness;
    canvas.dataset.finish = button.dataset.finish;
    invalidate();
  }));
  lightControl.addEventListener('input', updateLight);
  opticsButton.addEventListener('click', async () => {
    opticsButton.disabled = true;
    try {
      const active = opticsButton.getAttribute('aria-pressed') === 'true';
      if (!diagram) {
        const { showOptics } = await import('./optics-view.js');
        if (disposed) return;
        diagram = showOptics(stage.engine, model);
      }
      opticsButton.setAttribute('aria-pressed', String(!active));
      opticsKey.hidden = active;
      if (!active && macro.getAttribute('aria-pressed') !== 'true') macro.click();
      updateLight();
    } catch (error) {
      if (!disposed) fail(error);
    } finally {
      opticsButton.disabled = false;
    }
  });
}

async function start() {
  controls.forEach((element) => { element.disabled = true; });
  const compat = new URLSearchParams(location.search).get('backend') === 'webgl2';
  const installedCompatibility = compat || !navigator.gpu || !(await navigator.gpu.requestAdapter());
  if (installedCompatibility) await (await import('@margoengine/webgl2-compat')).install({ force: Boolean(navigator.gpu) });
  const mobile = matchMedia('(pointer: coarse)').matches;
  pixelRatio = Math.min(devicePixelRatio, installedCompatibility ? 1 : mobile ? 1.45 : 1.6);
  resizeCanvas();
  stage = await createStage(canvas, {
    autoStart: false, controls: false, exactSize: true, backend: 'webgpu', label: 'Interactive ring in a studio',
    background: '#2b2924', camera: { near: 0.004, far: 1.6, fov: 34 }, onError: fail,
  });
  const { engine } = stage;
  performance.mark('margo-engine-ready');
  model = jewelry(engine);
  const studio = platform(engine);
  model.metal.color = finish.gold.color;
  model.metal.roughness = finish.gold.roughness;
  engine.lighting.radiance.set([1, 0.93, 0.82, 0.19]);
  engine.lighting.ambient.set([0.55, 0.59, 0.65]);
  const shadows = Shadows.attach(engine, {
    resolution: mobile ? 512 : 1024, distance: 0.16, cascades: 1, normalBias: 0.00014,
    lightSize: 0.18, samples: 16, blockerSamples: 8,
    ...(installedCompatibility ? { filter: 'pcf' } : {}),
  });
  PostStack.attach(engine, [new Tonemap({ curve: 'agx', exposure: 0.12, contrast: 1.08 }), ...(installedCompatibility ? [] : [new FXAA()])]);
  light = await EnvironmentLighting.load(engine, studioPixels(), {
    size: 64, specularSize: 64, intensity: 0.96, signal: stage.signal,
  });
  performance.mark('margo-lighting-ready');
  const metal = [model.ring, model.gallery, model.girdleSupport, ...model.claws, ...model.shoulders];
  for (const asset of [...metal, model.gem, ...studio.models]) {
    if (asset !== model.gem && asset !== model.shoulders[0]) light.add(asset);
    shadows.add(asset);
  }
  canvas.dataset.finish = 'gold';
  interactions();
  updateLight();
  if (raf !== undefined) cancelAnimationFrame(raf);
  draw();
  await engine.gpu?.queue.onSubmittedWorkDone();
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  if (document.body.dataset.state === 'error') return;
  performance.mark('margo-first-usable-frame');
  document.body.dataset.state = 'ready';
  document.body.dataset.renderer = installedCompatibility ? 'compatibility' : 'webgpu';
  loading.hidden = true;
  controls.forEach((element) => { element.disabled = false; });
  resize = new ResizeObserver(invalidate);
  resize.observe(canvas);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    disposed = true;
    resize.disconnect();
    if (raf !== undefined) cancelAnimationFrame(raf);
    stage.dispose();
    model.wear.dispose();
    studio.dispose();
  });
}
await start().catch(fail);


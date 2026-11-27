// GPU flocking: 16,384 birds or fish by default (up to 65,536), the pointer as predator or attractor, a sphere to fly
// around, live rule sliders and the flock's debug view. @margoengine/vfx/flocking, docs in packages/vfx/README.md.
import { createStage } from 'margoengine';
import { sphereGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { projectPoint, screenToWorld } from '@margoengine/math/project';
import { GPUFlock, type FlockPreset, type FlockVec3, type GPUFlockOptions } from '@margoengine/vfx/flocking';
import { demoStatus } from './demo-status.ts';

declare global {
  interface Window {
    flockDemo?: { flock: GPUFlock };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const page = demoStatus(canvas, status);
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);

const byId = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const slider = (id: string) => Number(byId<HTMLInputElement>(id).value);
const checked = (id: string) => byId<HTMLInputElement>(id).checked;

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    background: '#0d1a2d',
    camera: { position: [0, 8, 34], target: [0, 0, 0], near: 0.2, far: 200 },
    onError: (err) => {
      if (!life.signal.aborted) page.error(err);
    },
  });
  life.signal.throwIfAborted();
  const engine = stage.engine;

  const obstacle = { position: [0, 0, 0] as FlockVec3, radius: 2.6, strength: 10 };
  createMesh(engine, sphereGeometry(obstacle.radius, 24, 16), new Material({ color: '#2b3a52', roughness: 0.45, metalness: 0.25 }));
  const cursorMat = new Material({ color: '#ff5268', roughness: 0.3, emissive: '#ff3355', emissiveIntensity: 1.4 });
  const cursor = createMesh(engine, sphereGeometry(0.55, 16, 12), cursorMat);
  cursor.root.setPosition([0, -100, 0]);

  const countSelect = byId<HTMLSelectElement>('boid-count');

  let pointerMode: 'predator' | 'attractor' | 'off' = 'predator';
  let pointer: FlockVec3 | null = null;
  let preset: FlockPreset = 'bird';

  const makeOptions = (count: number): GPUFlockOptions => ({
    count,
    preset,
    bounds: { shape: 'box', halfSize: [18, 10, 18] },
    obstacles: [obstacle],
    separation: slider('sl-sep'),
    alignment: slider('sl-ali'),
    cohesion: slider('sl-coh'),
    neighborRadius: slider('sl-rad'),
    visionAngle: (slider('sl-vis') * Math.PI) / 180,
    maxSpeed: slider('sl-spd'),
    scale: preset === 'fish' ? 0.48 : 0.42,
    paused: byId('btn-pause').getAttribute('aria-pressed') === 'true',
    debug: debugOptions(),
  });
  const debugOptions = () => ({
    enabled: byId('btn-debug').getAttribute('aria-pressed') === 'true',
    velocities: checked('dbg-vel'),
    grid: checked('dbg-grid'),
    perception: checked('dbg-perc'),
    vectors: checked('dbg-vecs'),
  });

  let flock = GPUFlock.attach(engine, makeOptions(Number(countSelect.value)));
  // On the WebGL2 layer the flock steps on the CPU, so the page flies a smaller one there.
  if (flock.stats.backend === 'webgl2-compat') {
    flock.dispose();
    countSelect.value = '2048';
    flock = GPUFlock.attach(engine, makeOptions(2048));
  }
  window.flockDemo = { flock };
  dispose = () => {
    flock.dispose();
    stage.dispose();
  };

  const syncPointer = () => {
    if (!pointer || pointerMode === 'off') {
      flock.setPredators([]);
      flock.setAttractors([]);
      cursor.root.setPosition([0, -100, 0]);
      return;
    }
    cursor.root.setPosition(pointer);
    const predator = pointerMode === 'predator';
    cursorMat.color = predator ? '#ff5268' : '#38e89e';
    cursorMat.emissive = predator ? '#ff3355' : '#22c980';
    flock.setPredators(predator ? [{ position: pointer, radius: 7.5, strength: 18 }] : []);
    flock.setAttractors(predator ? [] : [{ position: pointer, strength: 5.5, radius: 22 }]);
  };

  // The pointer, unprojected onto the depth of the flock's centre.
  const at = { x: 0, y: 0, z: 0 };
  canvas.addEventListener('pointermove', (event) => {
    const depth = projectPoint({ x: 0, y: 0, z: 0 }, engine.camera, at)?.z ?? 0.5;
    const p = screenToWorld(event.offsetX, event.offsetY, depth, engine.camera, canvas.clientWidth, canvas.clientHeight, at);
    pointer = p ? [p.x, p.y, p.z] : null;
    syncPointer();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    syncPointer();
  });

  const presetButtons = [
    ['bird', byId<HTMLButtonElement>('preset-bird')],
    ['fish', byId<HTMLButtonElement>('preset-fish')],
  ] as const;
  for (const [name, button] of presetButtons)
    button.addEventListener('click', () => {
      preset = name;
      for (const [n, b] of presetButtons) b.setAttribute('aria-pressed', String(n === name));
      engine.scene.background = name === 'fish' ? '#061c2c' : '#0d1a2d';
      flock.options.color = name === 'fish' ? '#38c6e8' : '#e8eef8';
      flock.options.accentColor = name === 'fish' ? '#f0a83c' : '#4c7cc2';
      flock.options.scale = name === 'fish' ? 0.48 : 0.42;
      flock.options.flapFrequency = name === 'fish' ? 7 : 5.5;
      flock.setPreset(name);
    });

  countSelect.addEventListener('change', () => {
    flock.dispose();
    flock = GPUFlock.attach(engine, makeOptions(Number(countSelect.value)));
    window.flockDemo = { flock };
    syncPointer();
  });

  const modeButtons = [
    ['predator', byId<HTMLButtonElement>('mode-predator')],
    ['attractor', byId<HTMLButtonElement>('mode-attractor')],
    ['off', byId<HTMLButtonElement>('mode-off')],
  ] as const;
  for (const [mode, button] of modeButtons)
    button.addEventListener('click', () => {
      pointerMode = mode;
      for (const [m, b] of modeButtons) b.setAttribute('aria-pressed', String(m === mode));
      syncPointer();
    });

  const bind = (id: string, apply: (v: number) => void) => {
    const input = byId<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      byId<HTMLOutputElement>(id.replace('sl-', 'out-')).textContent = input.value;
      apply(Number(input.value));
    });
  };
  bind('sl-sep', (v) => (flock.options.separation = v));
  bind('sl-ali', (v) => (flock.options.alignment = v));
  bind('sl-coh', (v) => (flock.options.cohesion = v));
  bind('sl-rad', (v) => (flock.options.neighborRadius = v));
  bind('sl-vis', (v) => (flock.options.visionAngle = (v * Math.PI) / 180));
  bind('sl-spd', (v) => (flock.options.maxSpeed = v));

  const debugButton = byId<HTMLButtonElement>('btn-debug');
  debugButton.addEventListener('click', () => {
    const on = debugButton.getAttribute('aria-pressed') !== 'true';
    debugButton.setAttribute('aria-pressed', String(on));
    byId('debug-opts').hidden = !on;
    flock.setDebug(debugOptions());
  });
  for (const id of ['dbg-vel', 'dbg-grid', 'dbg-perc', 'dbg-vecs'])
    byId<HTMLInputElement>(id).addEventListener('change', () => flock.setDebug(debugOptions()));

  const pauseButton = byId<HTMLButtonElement>('btn-pause');
  pauseButton.addEventListener('click', () => {
    const paused = pauseButton.getAttribute('aria-pressed') !== 'true';
    flock.options.paused = paused;
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
  });
  byId<HTMLButtonElement>('btn-reset').addEventListener('click', () => flock.reset());

  let frames = 0;
  let elapsed = 0;
  stage.onTick((dt) => {
    frames++;
    elapsed += dt;
    if (elapsed < 0.5) return;
    status.textContent = `${flock.count.toLocaleString()} ${preset === 'fish' ? 'fish' : 'birds'} · ${Math.round(frames / elapsed)} fps · ${flock.stats.backend}`;
    frames = 0;
    elapsed = 0;
  });

  engine.render({ delta: 1 / 60 });
  page.ready(`${flock.count.toLocaleString()} birds · ${flock.stats.backend}`);
} catch (cause) {
  page.error(cause);
}

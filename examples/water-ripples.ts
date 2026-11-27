// Interactive Water Ripples demo: click/drag pond ripples (disturbRay), moving boat & bobbing sphere
// tracked with trackBody(), reflecting cylinder pillars + pier wall (setObstacles), rain toggle, and debug heatmap.
import { createStage } from 'margoengine';
import { OrbitControls } from '@margoengine/controls';
import { engineRuntime } from '@margoengine/core/extension';
import { boxGeometry, cylinderGeometry, sphereGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { Sky } from '@margoengine/sky/base';
import { bruneton } from '@margoengine/sky/bruneton';
import { lighting } from '@margoengine/sky/lighting';
import { Water } from '@margoengine/water';
import { Ripples, type RippleDebugMode, type RippleObstacle } from '@margoengine/water/ripples';
import { WaterRain } from '@margoengine/water/rain';
import { demoStatus } from './demo-status.ts';

declare global {
  interface Window {
    ripplesDemo?: { water: Water; ripples: Ripples; rain: WaterRain };
  }
}

const errorEl = document.querySelector<HTMLElement>('#error')!,
  statusEl = document.querySelector<HTMLElement>('#status')!,
  viewport = document.querySelector<HTMLElement>('#viewport')!;
const page = demoStatus(viewport, statusEl, errorEl);
const abort = new AbortController();
let dispose = () => abort.abort();
window.addEventListener('pagehide', () => dispose(), { once: true });

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function screenRay(
  cameraMatrix: Float32Array,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { origin: [number, number, number]; direction: [number, number, number] } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
  const inv = new Float32Array(16);
  if (!invertMatrixStable(cameraMatrix, inv)) return null;
  const unproject = (ndcZ: number): [number, number, number] => {
    const x = inv[0]! * nx + inv[4]! * ny + inv[8]! * ndcZ + inv[12]!;
    const y = inv[1]! * nx + inv[5]! * ny + inv[9]! * ndcZ + inv[13]!;
    const z = inv[2]! * nx + inv[6]! * ny + inv[10]! * ndcZ + inv[14]!;
    const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * ndcZ + inv[15]!;
    return [x / w, y / w, z / w];
  };
  // Margo uses reverse-Z clip space (near = 1, far = 0).
  const near = unproject(1);
  const far = unproject(0.01);
  const dx = far[0] - near[0],
    dy = far[1] - near[1],
    dz = far[2] - near[2];
  const len = Math.hypot(dx, dy, dz);
  if (!len || !Number.isFinite(len)) return null;
  return { origin: near, direction: [dx / len, dy / len, dz / len] };
}

try {
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    label: 'Interactive ripple pond with reflecting pillars, moving boat wakes, rain, and debug heatmap',
    camera: { position: [0, 14, 18], target: [0, 0, 0], near: 0.1, far: 300 },
    onError: (value) => page.error(value),
  });
  dispose = () => stage.dispose();
  if (abort.signal.aborted) {
    stage.dispose();
    abort.signal.throwIfAborted();
  }
  const engine = stage.engine;
  const controls = new OrbitControls(engine.camera, stage.canvas);
  controls.minDistance = 6;
  controls.maxDistance = 45;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.saveState();

  const sky = Sky.attach(
    engine,
    {
      model: 'bruneton',
      hours: 16.2,
      timeScale: 0,
      turbidity: 2.2,
      exposure: -0.15,
      lighting: {
        intensity: 3.0,
        color: [1, 0.96, 0.9],
        ambient: { day: [0.18, 0.23, 0.28], night: [0.02, 0.04, 0.08] },
      },
    },
    { bruneton, lighting },
  );
  engineRuntime(engine).lighting.direction.set([0.35, 0.85, -0.4, 2.8]);

  // Pond bed & rim for depth contrast.
  const stoneMat = new Material({ color: '#455459', roughness: 0.9 });
  const pillarMat = new Material({ color: '#b7a994', roughness: 0.72 });
  const woodMat = new Material({ color: '#7a4d2c', roughness: 0.65 });
  const boatMat = new Material({ color: '#d44933', roughness: 0.35 });
  const sphereMat = new Material({ color: '#e6b83c', roughness: 0.3 });

  createMesh(engine, boxGeometry(38, 0.4, 38), stoneMat).root.setPosition([0, -2.0, 0]);

  const water = Water.attach(engine, {
    size: [36, 36],
    segments: 192,
    height: 0,
    waves: [{ direction: [1, 0.3], amplitude: 0.015, wavelength: 14, steepness: 0.1 }],
    color: [0.02, 0.22, 0.26],
    reflection: () => sky.reflectionTexture,
    lights: sky.lights,
    foamDistance: 0.8,
  });

  const POND_OBSTACLES: RippleObstacle[] = [
    { kind: 'cylinder', center: [-5.5, -3.0], radius: 1.25 },
    { kind: 'cylinder', center: [5.5, -3.0], radius: 1.25 },
    { kind: 'cylinder', center: [0, 5.5], radius: 1.5 },
    { kind: 'box', center: [-6.5, 4.5], halfExtents: [2.2, 0.7], rotation: 0.35 },
    { kind: 'wall', from: [4.5, 2.5], to: [11.5, 6.5], thickness: 0.9 },
  ];

  // Visual 3D meshes matching the reflecting obstacles.
  const p1 = createMesh(engine, cylinderGeometry(1.25, 1.35, 3.6, 24), pillarMat);
  p1.root.setPosition([-5.5, -0.2, -3.0]);
  const p2 = createMesh(engine, cylinderGeometry(1.25, 1.35, 3.6, 24), pillarMat);
  p2.root.setPosition([5.5, -0.2, -3.0]);
  const p3 = createMesh(engine, cylinderGeometry(1.5, 1.6, 3.2, 24), pillarMat);
  p3.root.setPosition([0, -0.4, 5.5]);
  const pier = createMesh(engine, boxGeometry(4.4, 2.2, 1.4), woodMat);
  pier.root.setPosition([-6.5, -0.4, 4.5]);
  pier.root.setRotation([0, 0.35, 0]);
  const wallLen = Math.hypot(11.5 - 4.5, 6.5 - 2.5);
  const wallAngle = Math.atan2(6.5 - 2.5, 11.5 - 4.5);
  const wallMesh = createMesh(engine, boxGeometry(wallLen, 2.4, 0.9), pillarMat);
  wallMesh.root.setPosition([(4.5 + 11.5) / 2, -0.2, (2.5 + 6.5) / 2]);
  wallMesh.root.setRotation([0, -wallAngle, 0]);

  const ripples = Ripples.attach(engine, {
    surface: water,
    size: 32,
    resolution: 160,
    speed: 3.4,
    damping: 0.38,
    followCamera: false,
    obstacles: POND_OBSTACLES,
  });

  const rain = WaterRain.attach(engine, {
    surface: water,
    rain: 0,
    splashes: { field: ripples, rate: 18, area: 26, radius: 0.55, depth: 0.04 },
  });

  // Tracked moving boat + bobbing splasher sphere (duck-typed { position }).
  const boatMesh = createMesh(engine, boxGeometry(1.1, 0.55, 2.4), boatMat);
  const boatBody = { position: [0, 0, -7] as [number, number, number] };
  const bobberMesh = createMesh(engine, sphereGeometry(0.65, 20, 14), sphereMat);
  const bobberBody = { position: [3.2, 1.6, -0.5] as [number, number, number] };

  ripples.trackBody(boatBody, { radius: 1.0, strength: 0.08, halfHeight: 0.9 });
  ripples.trackBody(bobberBody, { radius: 0.9, strength: 0.09, halfHeight: 0.65, splashStrength: 2.2 });

  // UI elements
  const paintMode = document.querySelector<HTMLInputElement>('#paint-mode')!,
    radiusInput = document.querySelector<HTMLInputElement>('#brush-radius')!,
    radiusOut = document.querySelector<HTMLOutputElement>('#radius-value')!,
    strengthInput = document.querySelector<HTMLInputElement>('#brush-strength')!,
    strengthOut = document.querySelector<HTMLOutputElement>('#strength-value')!,
    boatActive = document.querySelector<HTMLInputElement>('#boat-active')!,
    obstaclesActive = document.querySelector<HTMLInputElement>('#obstacles-active')!,
    rainActive = document.querySelector<HTMLInputElement>('#rain-active')!,
    debugMode = document.querySelector<HTMLSelectElement>('#debug-mode')!,
    debugBounds = document.querySelector<HTMLInputElement>('#debug-bounds')!,
    dropBtn = document.querySelector<HTMLButtonElement>('#drop-splash')!,
    resetBtn = document.querySelector<HTMLButtonElement>('#reset-view')!;

  document.querySelector<HTMLDetailsElement>('#settings')!.open = !matchMedia('(max-width:600px)').matches;

  const syncDebug = () => {
    const mode = debugMode.value;
    if (mode === 'off') {
      ripples.setDebug(false);
    } else {
      ripples.setDebug({ enabled: true, mode: mode as RippleDebugMode, bounds: debugBounds.checked });
    }
  };
  debugMode.addEventListener('change', syncDebug, { signal: abort.signal });
  debugBounds.addEventListener('change', syncDebug, { signal: abort.signal });

  radiusInput.addEventListener(
    'input',
    () => (radiusOut.textContent = `${radiusInput.valueAsNumber.toFixed(1)} m`),
    { signal: abort.signal },
  );
  strengthInput.addEventListener(
    'input',
    () => (strengthOut.textContent = `${strengthInput.valueAsNumber.toFixed(2)} m`),
    { signal: abort.signal },
  );
  obstaclesActive.addEventListener(
    'change',
    () => ripples.setObstacles(obstaclesActive.checked ? POND_OBSTACLES : []),
    { signal: abort.signal },
  );
  rainActive.addEventListener(
    'change',
    () => {
      rain.setRain(rainActive.checked ? 0.85 : 0);
    },
    { signal: abort.signal },
  );
  dropBtn.addEventListener(
    'click',
    () => ripples.disturb(0, 0, Math.max(1.2, radiusInput.valueAsNumber), -strengthInput.valueAsNumber * 1.4),
    { signal: abort.signal },
  );
  resetBtn.addEventListener('click', () => controls.reset(), { signal: abort.signal });

  // Pointer click/drag ripples via disturbRay().
  let painting = false;
  const castPointerRipple = (event: PointerEvent, scale: number) => {
    const ray = screenRay(engine.camera.matrix, stage.canvas, event.clientX, event.clientY);
    if (!ray) return;
    ripples.disturbRay(
      ray.origin,
      ray.direction,
      radiusInput.valueAsNumber,
      -strengthInput.valueAsNumber * scale,
    );
  };
  stage.canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (paintMode.checked && event.button === 0 && !event.shiftKey && !event.altKey) {
        painting = true;
        controls.enabled = false;
        castPointerRipple(event, 1.0);
      }
    },
    { capture: true, signal: abort.signal },
  );
  stage.canvas.addEventListener(
    'pointermove',
    (event) => {
      if (painting) castPointerRipple(event, 0.45);
    },
    { signal: abort.signal },
  );
  const stopPainting = () => {
    if (!painting) return;
    painting = false;
    controls.enabled = true;
  };
  window.addEventListener('pointerup', stopPainting, { signal: abort.signal });
  window.addEventListener('pointercancel', stopPainting, { signal: abort.signal });

  stage.use({
    name: 'ripples-demo-cleanup',
    setup() {},
    dispose: () => {
      controls.dispose();
      abort.abort();
    },
  });

  // Seed one welcoming ripple at startup so the pond immediately comes alive.
  ripples.disturb(0, -0.5, 1.4, -0.22);
  let simTime = 0;
  const updateBodies = (dt: number) => {
    if (boatActive.checked) simTime += dt;
    const angle = simTime * 0.55;
    const bx = Math.cos(angle) * 8.5;
    const bz = Math.sin(angle * 2) * 3.8 - 1.2;
    const heading = Math.atan2(-Math.sin(angle) * 8.5, Math.cos(angle * 2) * 7.6);
    boatBody.position = [bx, water.sampleHeight(bx, bz), bz];
    boatMesh.root.setPosition(boatBody.position);
    boatMesh.root.setRotation([0, heading, 0]);

    const bobY = Math.sin(simTime * 1.9) * 1.45;
    bobberBody.position = [3.2, bobY, -0.5];
    bobberMesh.root.setPosition(bobberBody.position);
  };

  updateBodies(0);
  engine.render({ delta: reducedMotion ? 0.08 : 0 });
  window.ripplesDemo = { water, ripples, rain };

  let last = performance.now();
  const loop = (now: number) => {
    if (abort.signal.aborted) return;
    const dt = reducedMotion ? 0 : Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      controls.update();
      updateBodies(dt);
      engine.render({ delta: dt });
    } catch (err) {
      page.error(err);
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  page.ready(
    document.documentElement.dataset.webgpuCompat !== undefined
      ? 'WebGL2 compatibility mode · 160² ripple grid · 5 reflecting obstacles'
      : 'WebGPU · 160² ripple grid · 5 reflecting obstacles',
  );
} catch (error) {
  if (!abort.signal.aborted) page.error(error);
}

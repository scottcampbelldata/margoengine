// FFT Ocean demo: live FFTOcean with setWind(), WATER_LOOKS presets, choppiness & whitecaps sliders,
// dive-underwater camera with Snell's window, synchronous CPU ocean.sample() buoy, and debug overlays.
import { createStage } from 'margoengine';
import { OrbitControls } from '@margoengine/controls';
import { engineRuntime } from '@margoengine/core/extension';
import { cylinderGeometry, sphereGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { Sky } from '@margoengine/sky/base';
import { bruneton } from '@margoengine/sky/bruneton';
import { lighting } from '@margoengine/sky/lighting';
import { FFTOcean, type OceanDebugMode } from '@margoengine/water/fft';
import { Underwater } from '@margoengine/water/underwater';
import { WATER_LOOKS, type WaterLookName } from '@margoengine/water/settings';
import { demoStatus } from './demo-status.ts';

declare global {
  interface Window {
    oceanDemo?: { ocean: FFTOcean; underwater: Underwater };
  }
}

const errorEl = document.querySelector<HTMLElement>('#error')!,
  statusEl = document.querySelector<HTMLElement>('#status')!,
  buoyReadout = document.querySelector<HTMLElement>('#buoy-readout')!,
  viewport = document.querySelector<HTMLElement>('#viewport')!;
const page = demoStatus(viewport, statusEl, errorEl);
const abort = new AbortController();
let dispose = () => abort.abort();
window.addEventListener('pagehide', () => dispose(), { once: true });

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

try {
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    label: 'Spectral FFT ocean with live wind retuning, floating buoy, underwater dive, and debug overlays',
    camera: { position: [0, 7.5, 22], target: [0, 0.5, 0], near: 0.1, far: 1200 },
    onError: (value) => page.error(value),
  });
  dispose = () => stage.dispose();
  if (abort.signal.aborted) {
    stage.dispose();
    abort.signal.throwIfAborted();
  }
  const engine = stage.engine;
  const controls = new OrbitControls(engine.camera, stage.canvas);
  controls.minDistance = 4;
  controls.maxDistance = 180;
  controls.saveState();

  const sky = Sky.attach(
    engine,
    {
      model: 'bruneton',
      hours: 15.5,
      timeScale: 0,
      turbidity: 2.5,
      exposure: -0.2,
      lighting: {
        intensity: 3.2,
        color: [1, 0.96, 0.9],
        ambient: { day: [0.16, 0.22, 0.28], night: [0.02, 0.04, 0.08] },
      },
    },
    { bruneton, lighting },
  );
  engineRuntime(engine).lighting.direction.set([0.4, 0.75, -0.5, 3.0]);

  const ocean = FFTOcean.attach(engine, {
    resolution: 64,
    size: 512,
    segments: 192,
    windSpeed: 10,
    windDirection: [Math.sin((73 * Math.PI) / 180), Math.cos((73 * Math.PI) / 180)],
    choppiness: 1.0,
    foamThreshold: 0.7,
    followCamera: true,
  });
  const underwater = Underwater.attach(engine, {
    surface: ocean,
    environment: () => sky.reflectionTexture,
    shafts: 1.2,
    waterline: 2.5,
  });

  // Floating navigation buoy driven synchronously by ocean.sample() (zero GPU readback).
  const buoyHullMat = new Material({ color: '#d93829', roughness: 0.35 });
  const buoyStripeMat = new Material({ color: '#f4f7fa', roughness: 0.4 });
  const buoyLightMat = new Material({ color: '#ffd94a', roughness: 0.2, emissive: '#ffbb22' });
  const buoyBase = createMesh(engine, cylinderGeometry(0.95, 1.15, 1.3, 24), buoyHullMat);
  const buoyTower = createMesh(engine, cylinderGeometry(0.32, 0.55, 1.9, 16), buoyStripeMat);
  const buoyBeacon = createMesh(engine, sphereGeometry(0.3, 16, 12), buoyLightMat);
  const buoyX = 0,
    buoyZ = 0;

  const updateBuoy = () => {
    const s = ocean.sample(buoyX, buoyZ);
    const [nx, ny, nz] = s.normal;
    // Small-angle pitch/roll alignment with the wave normal.
    const pitch = Math.atan2(nz, Math.max(0.2, ny)) * 0.75;
    const roll = -Math.atan2(nx, Math.max(0.2, ny)) * 0.75;
    const y = s.height + 0.15;
    buoyBase.root.setPosition([buoyX, y, buoyZ]);
    buoyBase.root.setRotation([pitch, 0, roll]);
    // Offset tower & beacon along tilted normal.
    buoyTower.root.setPosition([buoyX + nx * 1.4, y + ny * 1.4, buoyZ + nz * 1.4]);
    buoyTower.root.setRotation([pitch, 0, roll]);
    buoyBeacon.root.setPosition([buoyX + nx * 2.45, y + ny * 2.45, buoyZ + nz * 2.45]);
    buoyReadout.textContent =
      `Buoy sync sample · y ${s.height.toFixed(2)} m · normal [${nx.toFixed(2)}, ${ny.toFixed(2)}, ${nz.toFixed(2)}] · ` +
      `vy ${s.velocity[1].toFixed(2)} m/s · J ${s.jacobian.toFixed(2)}`;
  };

  // Controls wiring
  const lookSelect = document.querySelector<HTMLSelectElement>('#look')!,
    windInput = document.querySelector<HTMLInputElement>('#wind')!,
    windOut = document.querySelector<HTMLOutputElement>('#wind-value')!,
    dirInput = document.querySelector<HTMLInputElement>('#direction')!,
    dirOut = document.querySelector<HTMLOutputElement>('#direction-value')!,
    chopInput = document.querySelector<HTMLInputElement>('#chop')!,
    chopOut = document.querySelector<HTMLOutputElement>('#chop-value')!,
    whitecapsInput = document.querySelector<HTMLInputElement>('#whitecaps')!,
    whitecapsOut = document.querySelector<HTMLOutputElement>('#whitecaps-value')!,
    debugMode = document.querySelector<HTMLSelectElement>('#debug-mode')!,
    debugWire = document.querySelector<HTMLInputElement>('#debug-wire')!,
    debugRings = document.querySelector<HTMLInputElement>('#debug-rings')!,
    debugPoints = document.querySelector<HTMLInputElement>('#debug-points')!,
    diveBtn = document.querySelector<HTMLButtonElement>('#dive')!,
    pauseBtn = document.querySelector<HTMLButtonElement>('#pause')!,
    resetBtn = document.querySelector<HTMLButtonElement>('#reset-view')!;

  document.querySelector<HTMLDetailsElement>('#settings')!.open = !matchMedia('(max-width:600px)').matches;

  const syncWind = () => {
    const speed = windInput.valueAsNumber;
    const deg = dirInput.valueAsNumber;
    const rad = (deg * Math.PI) / 180;
    windOut.textContent = `${speed.toFixed(1)} m/s`;
    dirOut.textContent = `${Math.round(deg)}°`;
    ocean.setWind({ speed, direction: [Math.sin(rad), Math.cos(rad)] });
  };

  const syncDebug = () => {
    const mode = debugMode.value as OceanDebugMode;
    const anyOn = mode !== 'off' || debugWire.checked || debugRings.checked;
    ocean.setDebug(
      anyOn
        ? {
            enabled: true,
            mode,
            wireframe: debugWire.checked || mode === 'wireframe',
            lodRings: debugRings.checked,
            samplePoints: debugPoints.checked ? [[buoyX, buoyZ], [10, -8], [-12, 6]] : [],
          }
        : false,
    );
  };

  lookSelect.addEventListener(
    'change',
    () => {
      const name = lookSelect.value as WaterLookName;
      const look = WATER_LOOKS[name] as Record<string, unknown>;
      const speed = typeof look.windSpeed === 'number' ? Math.max(0.5, Math.min(35, look.windSpeed)) : 10;
      const chop = typeof look.chop === 'number' ? Math.min(2.5, 0.3 + look.chop * 1.7) : 1.0;
      const foam = Math.min(0.95, 0.35 + (speed / 35) * 0.55);
      windInput.value = String(speed);
      chopInput.value = chop.toFixed(2);
      whitecapsInput.value = foam.toFixed(2);
      chopOut.textContent = chop.toFixed(2);
      whitecapsOut.textContent = foam.toFixed(2);
      syncWind();
      ocean.setChoppiness(chop).setFoamThreshold(foam);
      if (Array.isArray(look.color) && look.color.length === 3) {
        ocean.setColor(look.color as [number, number, number]);
      } else {
        ocean.setColor([0.01, 0.18, 0.25]);
      }
      sky.options.hours = name === 'nightSea' ? 23.0 : 15.5;
    },
    { signal: abort.signal },
  );

  windInput.addEventListener('input', syncWind, { signal: abort.signal });
  dirInput.addEventListener('input', syncWind, { signal: abort.signal });
  chopInput.addEventListener(
    'input',
    () => {
      const v = chopInput.valueAsNumber;
      chopOut.textContent = v.toFixed(2);
      ocean.setChoppiness(v);
    },
    { signal: abort.signal },
  );
  whitecapsInput.addEventListener(
    'input',
    () => {
      const v = whitecapsInput.valueAsNumber;
      whitecapsOut.textContent = v.toFixed(2);
      ocean.setFoamThreshold(v);
    },
    { signal: abort.signal },
  );
  for (const el of [debugMode, debugWire, debugRings, debugPoints]) {
    el.addEventListener('change', syncDebug, { signal: abort.signal });
  }

  let submerged = false;
  diveBtn.addEventListener(
    'click',
    () => {
      submerged = !submerged;
      diveBtn.setAttribute('aria-pressed', String(submerged));
      diveBtn.textContent = submerged ? 'Surface camera' : 'Dive underwater';
      if (submerged) {
        engine.camera.position = [4, -3.5, 11];
        engine.camera.target = [0, 1.0, 0];
      } else {
        engine.camera.position = [0, 7.5, 22];
        engine.camera.target = [0, 0.5, 0];
      }
      controls.update();
    },
    { signal: abort.signal },
  );

  let paused = reducedMotion;
  pauseBtn.setAttribute('aria-pressed', String(paused));
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  pauseBtn.addEventListener(
    'click',
    () => {
      paused = !paused;
      pauseBtn.setAttribute('aria-pressed', String(paused));
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    },
    { signal: abort.signal },
  );

  resetBtn.addEventListener(
    'click',
    () => {
      submerged = false;
      diveBtn.setAttribute('aria-pressed', 'false');
      diveBtn.textContent = 'Dive underwater';
      controls.reset();
    },
    { signal: abort.signal },
  );

  stage.use({
    name: 'ocean-demo-cleanup',
    setup() {},
    dispose: () => {
      controls.dispose();
      abort.abort();
    },
  });

  if (reducedMotion) ocean.setTime(2.5);
  updateBuoy();
  engine.render({ delta: 0 });
  window.oceanDemo = { ocean, underwater };

  let last = performance.now();
  const loop = (now: number) => {
    if (abort.signal.aborted) return;
    const dt = paused ? 0 : Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      controls.update();
      engine.render({ delta: dt });
      updateBuoy();
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
      ? 'WebGL2 compatibility mode · 64² × 3 cascades'
      : 'WebGPU · 64² × 3 cascades',
  );
} catch (error) {
  if (!abort.signal.aborted) page.error(error);
}

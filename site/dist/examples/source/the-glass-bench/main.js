import { Clustered } from '@margoengine/clustered';
import { AreaLights } from '@margoengine/clustered/area';
import { DOF } from '@margoengine/dof';
import { EnvironmentLighting } from '@margoengine/environment';
import { Transmission } from '@margoengine/materials/transmission';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { Shadows } from '@margoengine/shadows';
import { createStage } from '@margoengine/stage';
import { ContactShadows } from '@margoengine/studio';
import { ProductCaustics } from '@margoengine/studio/caustics';
import { Tonemap } from '@margoengine/tonemap';
import { Label, Panel, Ui, UiRenderer } from '@margoengine/ui';
import { buildBench, ior } from './bench.js';
import { between, duration, filmAt, reticleHeight } from './timeline.js';

const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const controls = document.querySelector('#controls');
const seek = document.querySelector('#seek');
const toggle = document.querySelector('#play');
const clock = document.querySelector('#clock');
const offline = new URLSearchParams(location.search).has('capture');

function report(error) {
  status.hidden = false;
  status.textContent = String(error);
  viewport.dataset.error = String(error);
}

function studioEnvironment() {
  const width = 512;
  const height = 256;
  const data = new Float32Array(width * height * 4);
  const lamps = [
    { center: [-0.39, 0.52, -0.76], spread: [0.47, 0.145], value: [12.2, 10.0, 7.7] },
    { center: [-0.83, 0.45, 0.34], spread: [0.14, 0.32], value: [3.5, 5.9, 8.0] },
    { center: [0.83, 0.47, 0.29], spread: [0.31, 0.31], value: [2.3, 2.6, 2.8] },
  ].map(({ center, spread, value }) => ({
    azimuth: Math.atan2(center[0], -center[2]),
    elevation: Math.atan2(center[1], Math.hypot(center[0], center[2])),
    spread,
    value,
  }));

  for (let y = 0; y < height; y++) {
    const elevation = Math.PI * (0.5 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const azimuth = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      const pixel = (y * width + x) * 4;
      const room = 0.105 + 0.125 * Math.max(0, Math.sin(elevation));
      data.set([room * 0.92, room, room * 1.08, 1], pixel);
      for (const lamp of lamps) {
        const dx = Math.abs(Math.atan2(Math.sin(azimuth - lamp.azimuth), Math.cos(azimuth - lamp.azimuth)));
        const dy = Math.abs(elevation - lamp.elevation);
        const mask =
          (1 - between(dx, lamp.spread[0] * 0.82, lamp.spread[0])) *
          (1 - between(dy, lamp.spread[1] * 0.81, lamp.spread[1]));
        for (let c = 0; c < 3; c++) data[pixel + c] += mask * lamp.value[c];
      }
    }
  }
  return { width, height, data };
}

class FadingTitle extends Panel {
  alpha = 0;

  get opacity() {
    return this.alpha;
  }

  setOpacity(alpha) {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.visible = alpha > 0;
    this.invalidate(false);
  }
}

function createTitle(engine) {
  const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
  const title = new FadingTitle({
    visible: false,
    anchor: 'bottom-left',
    margin: [0, 0, 87, 96],
    gap: 5,
    background: 'none',
    pointerEvents: 'none',
    children: [
      new Label({ text: 'MARGO ENGINE', size: 26, color: '#e9c99f', outline: true, wrap: false }),
      new Label({ text: 'The Glass Bench', size: 67, color: '#f4ede1', outline: true, wrap: false }),
    ],
  });
  ui.add(title);
  UiRenderer.attach(engine, ui);
  return title;
}

async function start() {
  const controller = new AbortController();
  const stage = await createStage(viewport, {
    autoStart: false,
    controls: false,
    backend: 'webgpu',
    camera: { ...filmAt(0), near: 0.008, far: 2.5 },
    background: '#202427',
    label: 'Macro film of a precision optical lens in a calibration rig',
    onError: report,
  });
  const { engine } = stage;
  let textures = [];
  window.addEventListener(
    'pagehide',
    () => {
      controller.abort();
      stage.dispose();
      for (const texture of textures) texture.dispose();
    },
    { once: true },
  );

  // The cold lab fill and the moving inspection strip are realized as area lights.
  engine.lighting.direction.set([-0.3, 0.9, -0.3, 1.42]);
  engine.lighting.radiance.set([1.0, 0.92, 0.8, 0.24]);
  engine.lighting.ambient.set([0.53, 0.6, 0.68]);
  const light = await EnvironmentLighting.load(engine, studioEnvironment(), {
    size: 256,
    specularSize: 128,
    intensity: 0.78,
    signal: controller.signal,
  });
  const clustered = Clustered.attach(engine, { maxLights: 3 });
  const panels = AreaLights.attach(engine, { lights: clustered, maxLights: 2 });
  const key = {
    position: [-0.036, 0.196, -0.098],
    direction: [0.24, -0.82, 0.61],
    width: 0.093,
    height: 0.018,
    color: [1, 0.8, 0.56],
    intensity: 5.8,
  };
  const fill = {
    position: [-0.17, 0.22, 0.15],
    direction: [0.54, -0.64, -0.52],
    width: 0.26,
    height: 0.18,
    color: [0.58, 0.76, 1],
    intensity: 2.7,
  };

  const dof = new DOF({ focalLength: 0.043, focalDistance: 0.16, aperture: 8, maxRadius: 18 });
  PostStack.attach(engine, [
    dof,
    new Bloom({ threshold: 1.35, strength: 0.1, radius: 0.58 }),
    new Tonemap({ curve: 'agx', contrast: 1.12, exposure: -0.24 }),
  ]);
  Transmission.attach(engine);

  const bench = buildBench(engine);
  textures = bench.textures;
  for (const model of bench.models) {
    light.add(model);
    clustered.add(model);
  }
  const sunShadow = Shadows.attach(engine, { resolution: 2048, distance: 0.76, normalBias: 0.00031, lightSize: 0.16 });
  const contact = ContactShadows.attach(engine, {
    size: [0.41, 0.35],
    resolution: 512,
    height: 0.2,
    blur: 0.006,
    opacity: 0.6,
  });
  for (const model of bench.casters) {
    sunShadow.add(model);
    contact.add(model);
  }
  const caustics = await ProductCaustics.attach(engine, {
    geometry: bench.photonGeometry,
    position: [0, reticleHeight + 0.00004, 0],
    size: 0.116,
    height: 0.133,
    lightDirection: [-0.011, 1, 0.02],
    ior,
    photonSide: 256,
    resolution: 256,
    worldRadius: 0.0013,
    color: [1, 0.88, 0.69],
    intensity: 0.01,
    signal: controller.signal,
  });
  const title = createTitle(engine);

  const apply = ({ time }) => {
    const shot = filmAt(time);
    const camera = engine.camera;
    camera.position = shot.position;
    camera.target = shot.target;
    camera.fov = shot.fov;
    const sight = shot.target.map((component, i) => component - shot.position[i]);
    const depth = shot.focus.reduce((sum, component, i) => sum + (component - shot.position[i]) * sight[i], 0);
    dof.options.focalDistance = depth / Math.hypot(...sight);
    dof.options.aperture = shot.aperture;
    bench.ring.setRotation([0, shot.ringAngle, 0]);
    bench.slide.setPosition([0, 0, shot.reticleTravel]);
    bench.dial.setRotation([0, 0, shot.dialAngle]);
    key.intensity = 3.6 + 6 * shot.lamp;
    panels.setLights([key, fill]);
    bench.diffuser.emissiveIntensity = 0.65 + 3.8 * shot.lamp;
    caustics.options.intensity = 0.006 + 0.045 * between(time, 34.7, 38.0);
    title.setOpacity(between(time, 53.2, 54.4));
  };

  let time = 0;
  let frames = 0;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const updateClock = () => {
    const elapsed = Math.floor(time);
    seek.value = String(time);
    clock.value = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') + ' / 1:00';
    toggle.textContent = playing ? 'Pause' : time === duration ? 'Replay' : 'Play';
  };
  toggle.addEventListener('click', () => {
    if (time === duration) time = 0;
    playing = !playing;
    updateClock();
  });
  seek.addEventListener('input', () => {
    time = Number(seek.value);
    playing = false;
    apply({ time });
    updateClock();
  });
  engine.onFrame((_, delta) => {
    if (!offline && playing) {
      time = Math.min(duration, time + delta);
      if (time === duration) playing = false;
      apply({ time });
      updateClock();
    }
    if (++frames === 5 && !viewport.dataset.error) {
      status.hidden = true;
      controls.hidden = offline;
      viewport.dataset.ready = 'true';
    }
  });
  apply({ time });
  updateClock();
  window.glassBench = { engine, apply, caustics };
  engine.start();
}

await start().catch((error) => {
  report(error);
  throw error;
});

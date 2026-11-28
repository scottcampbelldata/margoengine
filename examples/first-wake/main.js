import { Clustered } from '@margoengine/clustered';
import { Quaternion } from '@margoengine/math/quaternion';
import {
  Environment,
  EnvironmentBackground,
  EnvironmentLighting,
  Fog,
  loadEnvironmentImage,
} from '@margoengine/environment';
import { SSR } from '@margoengine/post/ssr';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { Shadows } from '@margoengine/shadows';
import { createStage } from '@margoengine/stage';
import { Tonemap } from '@margoengine/tonemap';
import { Label, Panel, Ui, UiRenderer } from '@margoengine/ui';
import { Water } from '@margoengine/water';

import { ShipWakes } from '@margoengine/water/ships';
import { Underwater } from '@margoengine/water/underwater';
import { exampleAsset } from '../live/asset-base.js';
import { makeHarbor } from './harbor.js';
import {
  duration,
  ease,
  filmAt,
  screwAngle,
  shipPose,
  surveyHull,
  vesselLength,
  waterlineOffset,
  waterlinePath,
} from './timeline.js';

const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const transport = document.querySelector('#transport');
const seek = document.querySelector('#seek');
const toggle = document.querySelector('#play');
const clock = document.querySelector('#clock');
const capture = new URLSearchParams(location.search).has('capture');
const signal = new AbortController();

function report(error) {
  status.textContent = String(error);
  status.hidden = false;
  viewport.dataset.error = String(error);
}

function calibrateSky({ data, width, height }) {
  const luma = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const horizon = Array.from({ length: width }, (_, x) => luma(4 * (Math.floor(height * 0.47) * width + x))).sort(
    (a, b) => a - b,
  );
  const exposure = 0.44 / Math.max(0.00001, horizon[Math.floor(width * 0.54)]);
  let peak = 0;
  let sun = [-0.56, 0.14, 0.81];
  for (let y = Math.floor(height * 0.29); y < height * 0.5; y++) {
    for (let x = 0; x < width; x++) {
      const brightness = luma(4 * (y * width + x));
      if (brightness > peak) {
        peak = brightness;
        const azimuth = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        const elevation = (0.5 - (y + 0.5) / height) * Math.PI;
        sun = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)];
      }
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] *= exposure;
  }
  return sun;
}

class EndTitle extends Panel {
  alpha = 0;
  get opacity() {
    return this.alpha;
  }
  show(alpha) {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.visible = alpha > 0;
    this.invalidate(false);
  }
}

function attachTitle(engine) {
  const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
  const title = new EndTitle({
    visible: false,
    anchor: 'bottom-left',
    margin: [0, 0, 75, 89],
    padding: 23,
    radius: 9,
    background: '#101820cc',
    pointerEvents: 'none',
    gap: 2,
    children: [
      new Label({ text: 'Made with Margo Engine', color: '#efd1aa', size: 34, outline: true, wrap: false }),
      new Label({ text: 'First Wake', color: '#f8f2e7', size: 75, outline: true, wrap: false }),
      new Label({ text: 'Please subscribe', color: '#f8f2e7', size: 40, outline: true, wrap: false }),
    ],
  });
  ui.add(title);
  UiRenderer.attach(engine, ui);
  const message = new Label({
    text: '',
    color: '#fff5e4',
    size: 37,
    outline: true,
    wrap: false,
  });
  const annotation = new EndTitle({
    visible: false,
    anchor: 'bottom-left',
    margin: [0, 0, 96, 104],
    background: 'none',
    pointerEvents: 'none',
    children: [message],
  });
  ui.add(annotation);
  return { title, annotation, message };
}

const cues = [
  [0.1, 4.2, 'Watch the water climb the bow.'],
  [4.65, 9.15, 'Moments earlier · Berth 04'],
  [19.5, 24.3, 'A 72 m survey ship eases into the channel.'],
  [35.5, 40.6, 'Water rolls away from the hull.'],
  [44.0, 49.25, 'The trail from the dock.'],
  [51.2, 55.7, 'Underwater along the starboard side'],
  [61.1, 64.7, 'The propeller drives water past the rudder.'],
  [67.2, 73.2, 'Farther astern, the foam breaks up.'],
  [83.1, 88.7, 'The wake thins as the ship pulls away.'],
];

async function start() {
  const stage = await createStage(viewport, {
    autoStart: false,
    controls: false,
    backend: 'webgpu',
    camera: { ...filmAt(0), near: 0.18, far: 1050 },
    label: 'A survey ship clears a harbor berth at dawn',
    onError: report,
  });
  const { engine } = stage;
  const abort = signal.signal;
  let textures = [];
  window.addEventListener(
    'pagehide',
    () => {
      signal.abort();
      stage.dispose();
      for (const texture of textures) texture.dispose();
    },
    { once: true },
  );

  const [source, harbor, survey, screw] = await Promise.all([
    loadEnvironmentImage(exampleAsset('first-wake/dawn.hdr'), { signal: abort }),
    makeHarbor(engine, abort),
    loadGLTF(engine, exampleAsset('first-wake/survey-hull.glb'), { signal: abort }),
    loadGLTF(engine, exampleAsset('first-wake/survey-screw.glb'), { signal: abort }),
  ]);
  textures = harbor.textures;
  const sun = calibrateSky(source);
  engine.lighting.direction.set([...sun, 2.18]);
  engine.lighting.radiance.set([1, 0.72, 0.48, 0.47]);
  engine.lighting.ambient.set([0.71, 0.78, 0.88]);
  const environment = await Environment.attach(engine, source, {
    size: 512,
    specularSize: 128,
    float32: false,
    intensity: 0.86,
    signal: abort,
  });
  EnvironmentBackground.attach(engine, environment);
  const imageLight = EnvironmentLighting.attach(engine, environment);
  const fog = Fog.attach(engine, { color: '#929da1', density: 0.005, near: 27 });
  const shadows = Shadows.attach(engine, {
    resolution: 2048,
    distance: 144,
    lightSize: 0.085,
    normalBias: 0.026,
    casterMargin: 24,
  });
  const ssr = new SSR({ maxRoughness: 0.48, thickness: 0.18, maxDistance: 108, steps: 56, stochastic: true });
  const stack = PostStack.attach(engine, [
    ssr,
    new Bloom({ threshold: 1.18, strength: 0.07, radius: 0.53 }),
    new Tonemap({ curve: 'agx', exposure: 0.06, contrast: 1.11 }),
  ]);
  const surface = Water.attach(engine, {
    // The horizon grid follows the camera. Use 0.375 m cells to resolve the bow crest in the close shots.
    size: [192, 128],
    segments: 512,
    height: 0,
    horizon: true,
    depth: () => stack.depthTexture,
    sceneColor: () => stack.sceneTexture,
    reflectionEnvironment: environment,
    shadows,
    color: [0.017, 0.052, 0.064],
    shallowColor: [0.041, 0.094, 0.085],
    foamDistance: 0.16,
    glitterRoughness: 0.225,
    wind: { speed: 4.4, direction: [0.75, 0.66], fetch: 2700 },
    waves: [
      { direction: [0.36, -0.93], amplitude: 0.083, wavelength: 13.5, steepness: 0.32 },
      { direction: [0.89, -0.45], amplitude: 0.043, wavelength: 6.2, steepness: 0.42 },
      { direction: [0.58, 0.81], amplitude: 0.026, wavelength: 2.75, steepness: 0.39 },
    ],
    chop: 0.61,
    whitecaps: 0.035,
    lights: [],
  });
  ssr.add(surface);
  const underwater = Underwater.attach(engine, {
    surface,
    skyEnvironment: environment,
    enabled: false,
    absorption: [0.12, 0.06, 0.036],
    scattering: [0.012, 0.022, 0.022],
    anisotropy: 0.78,
    maxDistance: 95,
    shaftDistance: 26,
    raySteps: 154,
    steps: 22,
    shaftExtent: 36,
    shafts: 1.45,
    waterline: 4,
  });

  // The Tripo hull uses Water's opaque-depth contact foam. ShipWakes supplies the traveling waves and stern trail.
  const wakes = ShipWakes.attach(engine, {
    surface,
    ships: [{ hull: surveyHull, path: waterlinePath, wake: 1.24 }],
    trail: 12,
    look: { wakeHeight: 0.39, waterlineFoam: 0, bowWave: 0.8, turbulentWake: 0.88, foamLife: 9.5, wakeLife: 45 },
  });

  const [minX, minY, minZ, maxX, maxY, maxZ] = survey.bounds;
  const scale = [surveyHull.beam / (maxX - minX), 25.9 / (maxY - minY), vesselLength / (maxZ - minZ)];
  survey.root
    .setParent(harbor.ship)
    .setScale(scale)
    .setPosition([
      -0.5 * (minX + maxX) * scale[0],
      -minY * scale[1] - surveyHull.draft,
      -0.5 * (minZ + maxZ) * scale[2] - waterlineOffset,
    ]);
  screw.root.setParent(harbor.ship).setPosition([-0.02, -4.63, -28.61 - waterlineOffset]);
  for (const model of [...harbor.models, survey, screw]) {
    imageLight.add(model);
    fog.add(model);
  }
  for (const mesh of harbor.casters) shadows.add(mesh);
  shadows.add(survey);
  shadows.add(screw);
  ssr.add(survey);
  const inspectionLights = Clustered.attach(engine, { maxLights: 1 });
  inspectionLights.add(survey);
  inspectionLights.add(screw);
  // A floodlight on the underwater inspection camera picks out the rudder and turning screw.
  const inspectionLamp = {
    position: [0, 0, 0],
    direction: [0, 0, -1],
    color: [0.93, 0.98, 1],
    radius: 0.16,
    range: 24,
    intensity: 255,
    innerAngle: 0.25,
    outerAngle: 0.76,
  };
  const { title, annotation, message } = attachTitle(engine);

  const hullRotation = new Quaternion();
  const apply = ({ time }) => {
    const t = Math.min(duration, Math.max(0, time));
    const camera = filmAt(t);
    engine.camera.position = camera.position;
    engine.camera.target = camera.target;
    engine.camera.fov = camera.fov;
    const pose = shipPose(camera.vesselTime);
    const [pitch, heading, roll] = pose.rotation;
    hullRotation.setFromEuler({ x: pitch, y: heading, z: roll, order: 'YXZ' });
    harbor.ship.setPosition(pose.position).setQuaternion(hullRotation.toArray());
    screw.root.setRotation([0, 0, screwAngle(camera.vesselTime)]);
    for (const line of harbor.moorings) line.visible = t >= 4.25 && t < 11.25;
    surface.setTime(camera.sceneTime);
    wakes.setTime(camera.vesselTime);
    underwater.options.enabled = camera.submerged;
    if (camera.submerged) {
      const [x, y, z] = camera.position;
      inspectionLamp.position = [x - 0.68, y + 0.84, z - 0.56];
      inspectionLamp.intensity = 140 + 350 * ease(t, 56.5, 61.5);
      inspectionLamp.direction = camera.target.map((value, axis) => value - inspectionLamp.position[axis]);
      inspectionLights.setLights([inspectionLamp]);
    } else {
      inspectionLights.setLights([]);
    }
    const cue = cues.find(([from, until]) => t >= from && t < until);
    if (cue) message.text = cue[2];
    annotation.show(cue ? ease(t, cue[0], cue[0] + 0.22) * (1 - ease(t, cue[1] - 0.3, cue[1])) : 0);
    title.show(ease(t, 90.25, 91.5));
  };

  let time = 0;
  let frameCount = 0;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  function updateTransport() {
    seek.value = String(time);
    const seconds = Math.floor(time);
    clock.value = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' / 1:37';
    toggle.textContent = playing ? 'Pause' : time === duration ? 'Replay' : 'Play';
  }
  toggle.addEventListener('click', () => {
    if (time === duration) time = 0;
    playing = !playing;
    updateTransport();
  });
  seek.addEventListener('input', () => {
    playing = false;
    time = Number(seek.value);
    apply({ time });
    updateTransport();
  });
  engine.onFrame((_, delta) => {
    if (!capture && playing) {
      time = Math.min(duration, time + delta);
      if (time === duration) playing = false;
      apply({ time });
      updateTransport();
    }
    if (++frameCount === 5 && !viewport.dataset.error) {
      status.hidden = true;
      transport.hidden = capture;
      viewport.dataset.ready = 'true';
    }
  });
  apply({ time });
  updateTransport();
  window.firstWake = { engine, apply };
  engine.start();
}

await start().catch((error) => {
  report(error);
  throw error;
});

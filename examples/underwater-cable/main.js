import { createStage } from '@margoengine/stage';
import { PbrMaterial } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Clustered } from '@margoengine/clustered';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { SSAO } from '@margoengine/post/ssao';
import { SceneTargets } from '@margoengine/post/mrt';
import { Tonemap } from '@margoengine/tonemap';
import { Grade } from '@margoengine/tonemap/grade';
import {
  Environment,
  EnvironmentBackground,
  EnvironmentLighting,
  Fog,
  loadEnvironmentImage,
} from '@margoengine/environment';
import { Reflector } from '@margoengine/environment/reflector';
import { Shadows } from '@margoengine/shadows';
import { Water } from '@margoengine/water';
import { Underwater } from '@margoengine/water/underwater';
import { Caustics } from '@margoengine/water/caustics';
import { ShipWakes } from '@margoengine/water/ships';
import { WaterReflection } from '@margoengine/water/reflector';
import { materialImages, plateImage, suitNormalImage } from './materials.js';
import { bed, makeSet, seededRandom } from './set.js';
import { bindDiver } from './diver.js';
import { breathCycleAt, cameraAt, diverTravel, diveAt, duration, shipTrack, submarinePosition } from './timeline.js';
import { exampleAsset } from '../live/asset-base.js';
import { showcaseCameraAt, showcaseDiverTime } from './showcase.js';

const viewport = document.querySelector('#viewport');
const controls = document.querySelector('#controls');
const status = document.querySelector('#status');
const toggle = document.querySelector('#play');
const seek = document.querySelector('#seek');
const clock = document.querySelector('#clock');
const params = new URLSearchParams(location.search);
const offline = params.get('capture') === '1';
const showcase = params.get('cut') === 'showcase';
const shotCameraAt = showcase ? showcaseCameraAt : cameraAt;
const controller = new AbortController();
const shipHull = { length: 71.9, beam: 15.5, draft: 6.15, entrance: 20 };
const shipHeight = 25.9;

function report(error) {
  status.textContent = String(error);
  status.hidden = false;
  viewport.dataset.error = String(error);
}

async function start() {
  const assets = exampleAsset('below-the-swell/');
  const stage = await createStage(viewport, {
    autoStart: false,
    controls: false,
    backend: 'webgpu',
    background: '#29424e',
    label: 'Animated ocean crossing and subsea cable inspection',
    camera: { ...shotCameraAt(0), near: 0.075, far: 1400 },
    onError: report,
  });
  const engine = stage.engine;
  const camera = engine.camera;
  window.addEventListener(
    'pagehide',
    () => {
      controller.abort();
      stage.dispose();
    },
    { once: true },
  );

  const sunlight = [-0.32, 0.85, -0.42];
  engine.lighting.direction.set([...sunlight, 2.65]);
  engine.lighting.radiance.set([1.0, 0.94, 0.86, 0.51]);
  engine.lighting.ambient.set([0.64, 0.77, 0.85]);
  const signal = controller.signal;
  const hdr = await loadEnvironmentImage(new URL('overcast-sky.hdr', assets), { signal });
  const horizon = Array.from({ length: hdr.width }, (_, x) => {
    const i = (Math.floor(hdr.height * 0.47) * hdr.width + x) * 4;
    return 0.2126 * hdr.data[i] + 0.7152 * hdr.data[i + 1] + 0.0722 * hdr.data[i + 2];
  }).sort((a, b) => a - b);
  const exposure = 0.44 / Math.max(0.0001, horizon[Math.floor(horizon.length / 2)]);
  for (let i = 0; i < hdr.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) hdr.data[i + channel] *= exposure;
  }
  const environment = await Environment.attach(engine, hdr, {
    size: 256,
    specularSize: 128,
    float32: false,
    intensity: 0.73,
  });
  EnvironmentBackground.attach(engine, environment);
  const imageLight = EnvironmentLighting.attach(engine, environment);
  const seaHaze = Fog.attach(engine, { color: '#8c9aa2', density: 0.0058, near: 16 });

  const shadow = Shadows.attach(engine, {
    resolution: 2048,
    distance: 116,
    lightSize: 0.095,
    normalBias: 0.025,
    casterMargin: 13,
  });
  const lights = Clustered.attach(engine, { grid: [12, 8, 20], maxLights: 6 });
  const ao = new SSAO({ radius: 0.65, bias: 0.02, samples: 12 });
  const stack = PostStack.attach(engine, [
    ao,
    new Bloom({ strength: 0.08, threshold: 1.4, radius: 0.62 }),
    new Tonemap({
      curve: 'agx',
      exposure: -0.1,
      contrast: 1.14,
      extensions: showcase ? [new Grade({ hueSaturation: [1, 0.96, 0.9, 0.68, 0.76, 0.94] })] : [],
    }),
  ]);
  const surface = Water.attach(engine, {
    size: [230, 230],
    segments: 432,
    height: 0,
    horizon: true,
    depth: () => stack.depthTexture,
    sceneColor: () => stack.sceneTexture,
    reflectionEnvironment: environment,
    shadows: shadow,
    color: [0.004, 0.016, 0.023],
    foamDistance: 0.12,
    glitterRoughness: 0.156,
    lights: [],
    wind: { speed: 10.3, direction: [0.88, -0.49], fetch: 64_000 },
    chop: 0.57,
    whitecaps: 0.23,
  });
  const seaMirror = Reflector.attach(engine, {
    width: 230,
    height: 230,
    resolution: 0.85,
    captureOnly: true,
    autoUpdate: false,
  });
  seaMirror.node.setRotation([-Math.PI / 2, 0, 0]);
  WaterReflection.attach(engine, { surface, reflector: seaMirror, distortion: 0.065, roughness: 0.95, strength: 0.64 });
  const wake = ShipWakes.attach(engine, {
    surface,
    ships: [{ hull: shipHull, path: shipTrack, wake: 0.53 }],
    look: { waterlineFoam: 0.49, turbulentWake: 0.42, foamLife: 3.1 },
  });
  const absorption = [0.113, 0.035, 0.022];
  Caustics.attach(engine, {
    surface,
    size: 52,
    heightRange: [-13.5, 0],
    resolution: 128,
    layers: 8,
    color: [0.76, 0.92, 0.84],
    intensity: 1.7,
    absorption,
    shadows: shadow,
  });
  const underwater = Underwater.attach(engine, {
    surface,
    skyEnvironment: environment,
    absorption,
    scattering: [0.0065, 0.0105, 0.014],
    anisotropy: 0.83,
    shafts: 2.15,
    steps: 32,
    shaftDistance: 37,
    shaftExtent: 38,
    maxDistance: 160,
    raySteps: 206,
    waterline: 5.5,
  });

  const [images, coast, boat, face, buddyFace, submarine] = await Promise.all([
    materialImages(assets, signal),
    loadGLTF(engine, new URL('coast_rocks_05_1k.gltf', assets), { signal }),
    loadGLTF(engine, new URL('tripo-vessel.glb', assets), { signal }),
    loadGLTF(engine, new URL('diver-head.glb', assets), { signal }),
    loadGLTF(engine, new URL('diver-head.glb', assets), { signal }),
    loadGLTF(engine, new URL('survey-submarine.glb', assets), { signal }),
  ]);
  images.push(plateImage(), suitNormalImage());
  const { scene, diver, buddy, grasses } = makeSet(engine, images, { offshore: showcase });
  const poseDiver = bindDiver(scene, diver, face);
  const poseBuddy = bindDiver(scene, buddy, buddyFace, { offset: [4.8, -0.17, -0.46], heading: Math.PI });
  const submarinePivot = engine.createMesh();
  submarinePivot.name = 'Submarine tracking pivot';
  const [stern, , , bow] = submarine.bounds;
  const subScale = 44 / (bow - stern);
  submarine.root
    .setParent(submarinePivot)
    .setScale([subScale, subScale, subScale])
    .setPosition([(-subScale * (stern + bow)) / 2, 0, 0]);
  imageLight.add(submarine);
  imageLight.add(buddyFace);
  const vessel = engine.createMesh();
  const heading = Math.atan2(0.093, -0.68);
  vessel.name = 'Survey vessel waterline pivot';
  boat.root.name = 'Survey vessel';
  // The exported vessel is Y-up and bow-forward along +Z. Fit the normalized mesh to the wake's hull.
  const [minX, minY, minZ, maxX, maxY, maxZ] = boat.bounds;
  const scale = [shipHull.beam / (maxX - minX), shipHeight / (maxY - minY), shipHull.length / (maxZ - minZ)];
  boat.root
    .setParent(vessel)
    .setScale(scale)
    .setPosition([-0.5 * (minX + maxX) * scale[0], -minY * scale[1] - shipHull.draft, -0.5 * (minZ + maxZ) * scale[2]]);
  imageLight.add(boat);
  imageLight.add(face);
  seaHaze.add(boat);
  coast.root
    .setPosition([2.5, bed(2.5, -8) - 0.26, -8])
    .setScale([0.91, 0.91, 0.91])
    .setRotation([0, 0.9, 0]);
  lights.add(scene);
  lights.add(coast);
  lights.add(face);
  lights.add(buddyFace);
  lights.add(submarine);
  ao.add(face);
  ao.add(buddyFace);
  ao.add(scene);
  ao.add(coast);
  shadow.add(scene);
  shadow.add(coast, { static: true });
  shadow.add(boat);
  shadow.add(face);

  const targets =
    params.get('aovs') === '1'
      ? SceneTargets.attach(engine, {
          outputs: {
            geometry: { wgsl: 'vec4f(1.0, 0.0, 0.0, 1.0)', format: 'r8unorm' },
            depth: { wgsl: 'vec4f(exp(-distance(t.eye, t.position) / 28.0), 0.0, 0.0, 1.0)', format: 'r8unorm' },
            normal: { wgsl: 'vec4f(t.normal * 0.5 + 0.5, 1.0)', format: 'rgba8unorm' },
            albedo: 'albedo',
            emissive: { value: 'emissive', format: 'rgba8unorm' },
          },
        })
      : undefined;
  targets?.add(scene);
  targets?.add(coast);
  targets?.add(boat);
  targets?.add(face);

  const torch = {
    position: [0, 0, 0],
    direction: [0, 0, -1],
    innerAngle: 0.18,
    outerAngle: 0.49,
    range: 21,
    intensity: 0,
    color: [0.79, 0.96, 1],
    radius: 0.12,
  };
  // Twin lamps on the survey camera bracket illuminate the inspection team.
  const fill = {
    position: [0, 0, 0],
    direction: [0, 0, -1],
    innerAngle: 0.22,
    outerAngle: 0.68,
    range: 9.5,
    intensity: 0,
    color: [1.0, 0.79, 0.56],
    radius: 0.16,
  };
  const active = [torch, fill];
  const random = seededRandom(8923);
  const showTitle = showcase ? await import('./showcase-title.js').then(({ addTitle }) => addTitle(engine)) : null;
  const grainGeometry = toGeometry(sphereGeometry(1, 6, 4));
  const grainMaterial = new PbrMaterial({ color: '#88a7a4', roughness: 0.61 });
  const drift = Array.from({ length: 104 }, () => ({
    mesh: engine.createMesh().setGeometry(grainGeometry).setMaterial(grainMaterial),
    x: -16 + 27 * random(),
    y: 10.7 * random(),
    z: -7 + 16 * random(),
    radius: 0.007 + 0.019 * random() ** 3,
    seed: random() * 6.28,
  }));

  const bubble = new PbrMaterial({ color: '#8aa7ac', metalness: 0.64, roughness: 0.1 });
  const exhale = Array.from({ length: 30 }, (_, id) => ({
    mesh: engine.createMesh().setGeometry(grainGeometry).setMaterial(bubble),
    delay: id * 0.047,
    size: 0.008 + random() ** 1.6 * 0.024,
    phase: random() * 6.283,
    speed: 0.32 + random() * 0.24,
  }));

  function compose(seconds) {
    showTitle?.(seconds);
    surface.setTime(seconds);
    wake.setTime(seconds);
    const shot = shotCameraAt(seconds);
    camera.position = shot.position;
    camera.target = shot.target;
    camera.fov = shot.fov;
    const [shipX, shipZ] = shipTrack(seconds);
    vessel.setPosition([shipX, 0.12 * Math.sin(seconds * 0.82), shipZ]);
    vessel.rotation.set(0.0038 * Math.sin(seconds * 0.86 + 0.24), heading, 0.013 * Math.sin(seconds * 0.64));
    submarinePivot.setPosition(submarinePosition(seconds));
    submarinePivot.rotation.set(0, 0.043, 0.008 * Math.sin(seconds * 0.36));
    const diverTime = showcase ? showcaseDiverTime(seconds) : seconds;
    const travel = diverTravel(diverTime);
    const [rx, ry, rz] = poseDiver(diverTime, travel);
    poseBuddy(diverTime + 2.3, travel + 0.42);
    for (const air of exhale) {
      const age = breathCycleAt(diverTime) - air.delay;
      const elevation = ry + air.speed * age;
      air.mesh.visible = diverTime > diveAt + 0.25 && age > 0 && age < 3.01 && elevation < -0.04;
      if (air.mesh.visible) {
        air.mesh.position.set(
          rx - 0.14 * age + 0.11 * Math.sin(age * 2.5 + air.phase),
          elevation,
          rz + 0.13 * Math.sin(age * 1.9 + air.phase),
        );
        const r = air.size * (0.84 + 0.29 * age);
        air.mesh.scale.set(r, r * (0.74 + 0.19 * Math.sin(age * 7 + air.phase)), r);
      }
    }
    for (let i = 0; i < grasses.length; i++) {
      const phase = seconds * 1.14 + i * 0.51;
      grasses[i].rotation.set(0.113 * Math.sin(phase), 0, 0.106 * Math.cos(phase + 0.8));
    }
    for (const mote of drift) {
      mote.mesh.position.set(
        mote.x + 0.22 * seconds + 0.17 * Math.sin(seconds * 0.56 + mote.seed),
        -11.49 + ((mote.y + seconds * 0.038) % 10.7),
        mote.z + 0.13 * Math.cos(seconds * 0.79 + mote.seed),
      );
      mote.mesh.scale.setAll(mote.radius);
    }
    const [x, y, z] = shot.position;
    if (showcase) underwater.options.enabled = y < 2.25;
    torch.position = [x + 0.68, y + 0.3, z - 0.18];
    torch.direction = shot.target.map((value, i) => value - torch.position[i]);
    const divingPastSub = shot.id === 'submarine' || shot.id === 'return';
    torch.intensity = y < -0.4 && !divingPastSub ? Math.min(79, -y * 11) : 0;
    fill.position = [x - 0.46, y + 0.14, z - 0.05];
    fill.direction = shot.target.map((value, i) => value - fill.position[i]);
    fill.intensity = torch.intensity * 0.34;
    if (divingPastSub) {
      // Broad survey-camera lamps are aimed at the sail during the separate submersible pass.
      torch.range = 52;
      torch.intensity = 746;
      fill.range = 34;
      fill.intensity = 177;
    } else {
      torch.range = 21;
      fill.range = 9.5;
    }
    lights.setLights(active);
    ao.enabled = y < -5 && !divingPastSub;
  }

  function show(seconds) {
    compose(seconds);
    if (camera.position[1] > 0) seaMirror.update();
  }

  let frameCount = 0;
  let seconds = 0;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minutes = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  const setClock = () => {
    seek.value = String(seconds);
    clock.value = minutes(seconds) + ' / ' + minutes(duration);
    toggle.textContent = playing ? 'Pause' : seconds >= duration ? 'Replay' : 'Play';
  };
  toggle.addEventListener('click', () => {
    if (seconds >= duration) seconds = 0;
    playing = !playing;
    setClock();
  });
  seek.addEventListener('input', () => {
    seconds = Number(seek.value);
    playing = false;
    show(seconds);
    setClock();
  });
  engine.onFrame((_, delta) => {
    if (!offline && playing) {
      seconds = Math.min(duration, seconds + delta);
      if (seconds >= duration) playing = false;
      show(seconds);
      setClock();
    }
    if (++frameCount === 4 && !viewport.dataset.error) {
      status.hidden = true;
      controls.hidden = offline;
      viewport.dataset.ready = 'true';
    }
  });

  show(seconds);
  setClock();
  window.belowTheSwell = {
    engine,
    apply: (state) => show(state.time),
    aovs:
      targets &&
      (() => ({
        device: engine.gpu,
        textures: Object.fromEntries(targets.names.map((name) => [name, targets.texture(name)])),
      })),
  };
  engine.start();
}

await start().catch((error) => {
  report(error);
  throw error;
});

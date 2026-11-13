// Storm Light: a lighthouse on a rocky headland at night in a building storm. The headland, lighthouse, cottage, jetty
// and boat are modelled and textured in Blender by the scripts in ./blender; everything else is Margo Engine packages:
// the sea and its breakers (@margoengine/water), rain and lightning (@margoengine/sky/weather), the night sky and its
// storm clouds (@margoengine/sky), the beam's light shafts in volumetric fog (@margoengine/environment/volumetric lit
// by two @margoengine/clustered spot lights with local shadows), moonlight shadows (@margoengine/shadows), and
// TAA, AgX tone mapping and bloom. One Storm slider drives wind, rain, swell, cloud, fog and lightning together.
import { createStage } from 'margoengine';
import { engineRuntime } from '@margoengine/core/extension';
import { loadGLTF } from '@margoengine/gltf-pro';
import { OrbitControls } from '@margoengine/controls';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { Tonemap } from '@margoengine/tonemap';
import { TAA } from '@margoengine/taa';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { night } from '@margoengine/sky/night';
import { reflection } from '@margoengine/sky/reflection';
import { lighting } from '@margoengine/sky/lighting';
import { Weather } from '@margoengine/sky/weather';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Shadows } from '@margoengine/shadows';
import { Clustered, type PointLight, type SpotLight } from '@margoengine/clustered';
type ClusteredLight = PointLight | SpotLight;
import { LocalShadows } from '@margoengine/clustered/shadows';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { FogVolumes } from '@margoengine/environment/fog-volumes';
import { Water } from '@margoengine/water';
import { WaterRain } from '@margoengine/water/rain';
import { WaveQuery } from '@margoengine/water/query';
import { applyQualityTier, paceEngine } from '@margoengine/quality';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Vec3 = [number, number, number];

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  error = document.querySelector<HTMLParagraphElement>('#error')!,
  slider = document.querySelector<HTMLInputElement>('#storm')!,
  force = document.querySelector<HTMLOutputElement>('#force')!;
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const asked = new URLSearchParams(location.search).get('storm');
if (asked !== null && Number(asked) >= 0 && Number(asked) <= 1) slider.value = asked;

const tier = applyQualityTier();
const scene = await fetch(new URL('./assets/scene.json', import.meta.url)).then((r) => r.json());
const lamp = scene.lamp as Vec3;

// The hero view: out at sea to the south-east, low over the swell, the tower against the storm.
const view = new URLSearchParams(location.search).get('view')?.split(',').map(Number);
const hero =
  view?.length === 6 && view.every(Number.isFinite)
    ? { position: view.slice(0, 3) as Vec3, target: view.slice(3) as Vec3 }
    : { position: [62, 7, 80] as Vec3, target: [-4, 19, 2] as Vec3 };
const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A lighthouse on a rocky headland at night in a storm, its beam sweeping through rain over a heaving sea',
  camera: { ...hero, fov: 46, near: 0.3, far: Number(new URLSearchParams(location.search).get('far') ?? 6000) },
  onError: (value) => {
    error.textContent = String(value);
  },
});
const engine = stage.engine,
  camera = engine.camera;
paceEngine(engine);

// Post: one HDR capture shared by bloom and AgX, TAA over the result.
const bloom = new Bloom({ strength: 0.18, threshold: 1.4, radius: 0.85 }),
  tonemap = new Tonemap({ curve: 'agx', exposure: 0, contrast: 1.1 }),
  stack = PostStack.attach(engine, [bloom, tonemap]);
TAA.attach(engine, { depth: () => stack.depthTexture });

// The least night sky light on anything: the moonlit deck itself lights the scene and shows in the sea (the volumetric
// clouds lay it over the sky's reflection map and scene light), so the floor only keeps the darkest gaps from black.
const nightAmbient: Vec3 = [0.02, 0.026, 0.04];
// The sky: dusk light fading behind the storm, a moon behind the clouds, the cloud deck closing in with the storm.
const sky = Sky.attach(
  engine,
  {
    model: 'preetham',
    hours: 20.2,
    timeScale: 0,
    turbidity: 6,
    exposure: -0.6,
    night: {
      zenithColor: [0.004, 0.007, 0.016],
      horizonColor: [0.03, 0.04, 0.06],
      hazeDensity: 1.4,
      // The night's moon sits where the lighting moon is (it lights the scene and casts the shadows): a dim disc whose
      // glow shows through the thinner cloud and matches its path on the sea.
      moonDirection: [-0.3, 0.22, -1],
      moonColor: [0.16, 0.19, 0.24],
      moonSize: 0.03,
      moonPhase: 0.7,
      glowIntensity: 1.2,
      starIntensity: 0.25,
      starTwinkleIntensity: 1,
    },
    lighting: {
      intensity: 3,
      moon: { intensity: 0.22, color: [0.55, 0.68, 1] },
      ambient: { day: [0.03, 0.035, 0.045], night: nightAmbient },
    },
  },
  { preetham, night, reflection, lighting },
);

// An overcast deck of real 3D cloud, low and heavy, thickening with the storm; the moon and the lightning light it.
const deck = VolumetricClouds.attach(engine, {
  sky,
  coverage: 0.8,
  bottom: 650,
  top: 2600,
  density: 0.03,
  scale: 6000,
  wind: [-14, -9],
  evolution: 6,
  // Steps of at most about 260 m (the 25 km cut of the low slant rays right of the tower in 96): longer ones left the
  // edges of the rifts there grainy.
  steps: tier === 'phone' ? 32 : 96,
  lightSteps: 4,
  maxDistance: 25000,
  depth: () => stack.depthTexture,
});

const shadows = Shadows.attach(engine, {
  resolution: tier === 'phone' ? 1024 : 2048,
  distance: 260,
  lightSize: 0.03,
  normalBias: 0.06,
  casterMargin: 60,
});
const lights = Clustered.attach(engine);
const localShadows = LocalShadows.attach(engine, { lights, resolution: 1024, maxLights: 2 });

const [land, boat] = await Promise.all([
  loadGLTF(engine, new URL('./assets/storm-light.glb', import.meta.url)),
  loadGLTF(engine, new URL('./assets/boat.glb', import.meta.url)),
]).catch((reason: unknown) => {
  status.textContent = 'Unable to light the lamp';
  error.textContent = String(reason);
  throw reason;
});
shadows.add(land, { static: true });
shadows.add(boat);
lights.add(land);
lights.add(boat);
localShadows.add(land);
const lens = land.nodes.find((node) => node.name === 'Lens');

// The headland's height map, written by the Blender scripts, couples the sea to the shore: run-up, breakers, foam.
const map = scene.heightmap as { origin: [number, number]; size: [number, number]; cells: [number, number] };
const heights = new Float32Array(
  (await fetch(new URL('./assets/headland-height.bin', import.meta.url)).then((r) => r.arrayBuffer())) as ArrayBuffer,
);
const device = engineRuntime(engine).gpu!,
  heightmap = device.createTexture({
    size: map.cells,
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
device.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: map.cells[0] * 4 }, map.cells);

// Long Atlantic swell from the south-west and a shorter wind sea on top; the Storm slider scales them together.
let water: Water | undefined;
water = Water.attach(engine, {
  size: [640, 640],
  segments: tier === 'phone' ? 256 : 384,
  horizon: true,
  height: 0,
  color: [0.004, 0.012, 0.016],
  foamDistance: 2.5,
  spray: true,
  depth: () => stack.depthTexture,
  sceneColor: () => stack.sceneTexture,
  reflection: () => sky.reflectionTexture,
  lights: sky.lights,
  shadows,
  terrain: { heightmap: () => heightmap, origin: map.origin, size: map.size },
  // Breaking whitecaps, foam lines off the rocks, spray and wind chop; the Storm slider sets them (setStorm).
  whitecaps: 0.5,
  chop: 0.5,
  waves: [
    { direction: [-0.8, -0.6], amplitude: 1, wavelength: 78, steepness: 0.55, phase: 0.4 },
    { direction: [-0.55, -0.83], amplitude: 0.55, wavelength: 41, steepness: 0.5, phase: 2.1 },
    // The wind sea: short and steep enough that its crests break into foam as the storm rises (gentle crests never
    // reach the water's whitecap steepness), with a low crest sharpness so a full storm still does not fold it.
    { direction: [-0.95, -0.2], amplitude: 0.82, wavelength: 12, steepness: 0.3, phase: 4.3 },
  ],
});

// Far out, past the volumetric fog's range, the sea fades into the rain haze; it stays darker than the sky above it.
const haze = { color: [0.012, 0.016, 0.026] as Vec3, near: 220, far: 2600 };
water.setFog(haze);

// Thicker storm air round the headland: rain haze and spray the beam lights up close, a soft-edged sphere of fog on the
// tower that thins out to the open sea (where the thin sea fog keeps the horizon).
const stormAir = new FogVolumes([
  { shape: 'sphere', center: [-6, 20, -6], radius: 80, edge: 55, density: 0.008, noise: 0.6, noiseScale: 22 },
]);
const fog = VolumetricFog.attach(engine, {
  volumes: stormAir,
  density: 0.008,
  heightFalloff: 0.035,
  height: 0,
  anisotropy: 0.3,
  color: [0.9, 0.93, 1],
  ambient: [0.004, 0.005, 0.008],
  multipleScattering: 4,
  noise: 0.55,
  noiseScale: 22,
  wind: [-6, 0, -4],
  range: 480,
  grid: [160, 90, 80],
  temporal: Number(new URLSearchParams(location.search).get('temporal') ?? 0.9),
  shadows,
  lights,
  depth: () => water?.depthTexture ?? stack.depthTexture,
});

const weather = Weather.attach(engine, {
  precipitation: 'rain',
  intensity: 0.6,
  fadeSeconds: 1.5,
  particles: tier === 'phone' ? 12000 : 30000,
  radius: 28,
  height: 24,
  brightness: 0.3,
  opacity: 0.18,
  lightning: { rate: 6, threshold: 0.55, minDistance: 900, maxDistance: 7000, strength: 0.35, seed: 7 },
});
WaterRain.attach(engine, {
  surface: water,
  weather: {
    get rain() {
      return weather.amount;
    },
  },
});

// The lamp: two opposite beams from the lens, turning once every twelve seconds, with local shadows so the lantern's
// astragals and the gallery rail cut them. A warm point light glows round the lantern; the cottage windows, the lamp
// post and the boat's mast light glow warm and small.
const beamColor: Vec3 = [1, 0.88, 0.66];
const windows = (scene.windows as { position: Vec3; normal: Vec3 }[]).map(
  ({ position, normal }): ClusteredLight => ({
    position: [position[0] + normal[0] * 0.6, position[1], position[2] + normal[2] * 0.6],
    range: 9,
    color: [1, 0.62, 0.3],
    intensity: 4,
  }),
);
const post: ClusteredLight = {
  position: scene.lampPost as Vec3,
  range: 10,
  color: [1, 0.7, 0.4],
  intensity: 5,
};
const mast: ClusteredLight = { position: [0, 0, 0], range: 8, color: [1, 0.95, 0.85], intensity: 2 };
const cabin: ClusteredLight = { position: [0, 0, 0], range: 7, color: [1, 0.6, 0.28], intensity: 7 };
const cabinLocal: Vec3 = [0, 1.5, -0.6];
// A cool fill from the open sea, the night sky's light off the water, so the cliffs keep their form in the dark.
const fillAt: Vec3 = [110, 50, 140],
  fillTo: Vec3 = [-6, 2, 4],
  fillSpan = Math.hypot(fillTo[0] - fillAt[0], fillTo[1] - fillAt[1], fillTo[2] - fillAt[2]);
const fill: ClusteredLight = {
  position: fillAt,
  direction: [
    (fillTo[0] - fillAt[0]) / fillSpan,
    (fillTo[1] - fillAt[1]) / fillSpan,
    (fillTo[2] - fillAt[2]) / fillSpan,
  ],
  angle: 0.32,
  penumbra: 1,
  decay: 2,
  range: 420,
  color: [0.42, 0.52, 0.78],
  intensity: 60000,
};
// The moonlit cloud deck over the camera's shoulder: a broad, soft, cool light on the seaward rock faces and their
// strata, which the moon (behind the headland from the sea) leaves in shadow.
const skyAt: Vec3 = [150, 170, 170],
  skyTo: Vec3 = [-8, 10, 0],
  skySpan = Math.hypot(skyTo[0] - skyAt[0], skyTo[1] - skyAt[1], skyTo[2] - skyAt[2]);
const skyFill: ClusteredLight = {
  position: skyAt,
  direction: [(skyTo[0] - skyAt[0]) / skySpan, (skyTo[1] - skyAt[1]) / skySpan, (skyTo[2] - skyAt[2]) / skySpan],
  angle: 0.42,
  penumbra: 1,
  decay: 2,
  range: 600,
  color: [0.5, 0.6, 0.85],
  intensity: 90000,
};
// Lightning: the bolt's light from behind the headland while a flash lasts (setLights), and the opening strike: the
// first seconds of every visit (not under reduced motion) flash once, at the same time and place, so stills and the
// tour show the deck lit from inside. ?flash=<0..1> holds that flash at one brightness for stills.
const held = new URLSearchParams(location.search).get('flash');
const heldFlash = held !== null && Number(held) >= 0 && Number(held) <= 1 ? Number(held) : undefined;
const opening = { distance: 1800, azimuth: -2.2, strength: 1, seconds: 1.6 };
const strikeAt = (distance: number, azimuth: number): Vec3 => [
  hero.position[0] + Math.sin(azimuth) * distance,
  0,
  hero.position[2] + Math.cos(azimuth) * distance,
];
let strikePosition = strikeAt(opening.distance, opening.azimuth);
const bolt: ClusteredLight = { position: [0, 0, 0], range: 5000, color: [0.75, 0.82, 1], intensity: 0, decay: 2 };
const mastLocal = scene.boat.mastLight as Vec3;
// ?beam=<radians> holds the beams at one bearing (for stills and tests); otherwise they turn once every twelve seconds.
const heldBeam = new URLSearchParams(location.search).get('beam');
let beamAngle = Number(heldBeam ?? 2.5);
function setLights() {
  const beams: ClusteredLight[] = [0, Math.PI].map((offset) => {
    const a = beamAngle + offset;
    return {
      position: [lamp[0], lamp[1], lamp[2]],
      direction: [Math.cos(a), -0.05, -Math.sin(a)],
      angle: 0.045,
      penumbra: 0.55,
      decay: 2,
      range: 600,
      color: beamColor,
      intensity: 1.5e6,
      castShadow: true,
      shadow: { near: 2.4, far: 600 },
    };
  });
  lights.setLights([
    ...beams,
    { position: [lamp[0], lamp[1] + 0.2, lamp[2]], range: 16, color: beamColor, intensity: 260 },
    ...windows,
    post,
    mast,
    cabin,
    fill,
    skyFill,
    bolt,
  ]);
}

// The lens as the eye sees it: a soft core round the lamp, and a flare when one of the beams swings toward the camera.
// Drawn additively, depth tested, so the tower and the gallery hide it.
const glow = new RawShaderMaterial({
  vertexShader: /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, @location(1) facing:f32 }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let corner = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[i];
  let view = camera.view;
  let right = vec3f(view[0][0], view[1][0], view[2][0]); let up = vec3f(view[0][1], view[1][1], view[2][1]);
  let toEye = normalize(camera.position - uniforms.lamp);
  let a = uniforms.beam;
  let beam = normalize(vec3f(cos(a), -0.05, -sin(a)));
  let facing = pow(max(abs(dot(beam, toEye)), 0.0), 60.0);
  let size = 2.2 + 26.0 * facing;
  // Pulled a little toward the eye so the lantern glass does not cut the sprite.
  let centre = uniforms.lamp + toEye * 2.6;
  return Out(camera.viewProjection * vec4f(centre + (right * corner.x + up * corner.y) * size, 1.0), corner * size, facing);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let r = length(i.uv);
  let core = exp(-r * r * 2.2) * 6.0 + exp(-r * 1.6) * 0.5;
  let flare = i.facing * (exp(-r * 0.35) * 2.5 + exp(-abs(i.uv.y) * 6.0) * exp(-abs(i.uv.x) * 0.12) * 1.5);
  return margoDisplay(vec4f(uniforms.color * (core + flare), 0.0));
}`,
  uniforms: {
    lamp: { value: [lamp[0], lamp[1], lamp[2]], type: 'vec3f' },
    color: { value: [1, 0.78, 0.5], type: 'vec3f' },
    beam: { value: 0 },
  },
  transparent: true,
  blending: 'additive',
  depthTest: true,
  depthWrite: false,
  cull: 'none',
  name: 'storm-light-lens',
});
const raw = RawShaders.attach(engine);
raw.add(new RawMesh({ material: glow, vertexCount: 6 }));

// The cabin's glow on the sea: a broken warm streak running from the boat toward the eye, as a light's reflection
// does on rough water, flickering as the facets move. Depth tested, so the swell in front cuts it.
const streak = new RawShaderMaterial({
  vertexShader: /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, @location(1) along:f32 }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let corner = array<vec2f, 6>(vec2f(-1, 0), vec2f(1, 0), vec2f(1, 1), vec2f(-1, 0), vec2f(1, 1), vec2f(-1, 1))[i];
  let a = uniforms.anchor;
  let to = camera.position.xz - a.xz;
  let d = to / max(0.001, length(to));
  let reach = min(18.0, length(to) * 0.4);
  let p = a + vec3f(d.x * corner.y * reach - d.y * corner.x * 0.9, 0.0, d.y * corner.y * reach + d.x * corner.x * 0.9);
  return Out(camera.viewProjection * vec4f(p, 1.0), corner, corner.y * reach);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let t = uniforms.time;
  let facets = sin(i.along * 5.3 + t * 4.1 + sin(i.along * 1.7 - t * 2.3) * 2.5) * sin(i.uv.x * 7.0 + i.along * 2.1 - t * 3.0);
  let glints = pow(max(facets, 0.0), 4.0);
  let fade = (1.0 - i.uv.y) * exp(-i.uv.x * i.uv.x * 3.0) * smoothstep(0.0, 0.08, i.uv.y);
  return margoDisplay(vec4f(uniforms.color * glints * fade, 0.0));
}`,
  uniforms: {
    anchor: { value: [0, 0, 0], type: 'vec3f' },
    color: { value: [2.4, 1.3, 0.55], type: 'vec3f' },
    time: { value: 0 },
  },
  transparent: true,
  blending: 'additive',
  depthTest: true,
  depthWrite: false,
  cull: 'none',
  name: 'storm-light-cabin-glow',
});
raw.add(new RawMesh({ material: streak, vertexCount: 6 }));

// The boat rides the swell: the water is captured on the GPU, sampled under its hull, and the hull eases toward
// that pose like a heavy wooden boat would.
const boatHome: Vec3 = [16, 0, 46];
const pose = { y: 0, pitch: 0, roll: 0, vy: 0, vp: 0, vr: 0 };
let surface: WaveQuery | undefined,
  capturing = false,
  since = 0;
function sampleSea(x: number, z: number) {
  const s = surface?.sample(x, z);
  return s ? s.height + s.velocity[1] * since : undefined;
}
function moveBoat(delta: number, time: number) {
  if (!capturing && water) {
    capturing = true;
    WaveQuery.capture(water)
      .then((frame) => {
        surface = frame;
        since = 0;
      })
      .catch(() => {})
      .finally(() => (capturing = false));
  }
  since += delta;
  const heading = 2.5 + 0.12 * Math.sin(time * 0.11),
    fx = Math.sin(heading),
    fz = Math.cos(heading),
    [x, , z] = boatHome;
  const bow = sampleSea(x + fx * 3, z + fz * 3),
    stern = sampleSea(x - fx * 3, z - fz * 3),
    port = sampleSea(x - fz * 1.2, z + fx * 1.2),
    starboard = sampleSea(x + fz * 1.2, z - fx * 1.2);
  if (bow !== undefined && stern !== undefined && port !== undefined && starboard !== undefined) {
    const y = (bow + stern + port + starboard) / 4 - 0.15,
      // A small boat in a gale pitches and rolls more than the mean slope under it: the chop throws it about.
      pitch = 1.8 * Math.atan2(stern - bow, 6),
      roll = 2.2 * Math.atan2(port - starboard, 2.4);
    // A damped spring per axis: stiff enough to follow the swell, soft enough to lag the chop.
    const k = 14,
      c = 5.5;
    pose.vy += (k * (y - pose.y) - c * pose.vy) * delta;
    pose.vp += (k * (pitch - pose.pitch) - c * pose.vp) * delta;
    pose.vr += (k * 0.8 * (roll - pose.roll) - c * 0.7 * pose.vr) * delta;
    pose.y += pose.vy * delta;
    pose.pitch += pose.vp * delta;
    pose.roll += pose.vr * delta;
  }
  const q = quaternionYXZ(heading, pose.pitch, pose.roll);
  boat.root.setPosition([x, pose.y, z]);
  boat.root.setQuaternion(q);
  const m = rotate(q, mastLocal),
    c = rotate(q, cabinLocal);
  mast.position = [x + m[0], pose.y + m[1], z + m[2]];
  cabin.position = [x + c[0], pose.y + c[1], z + c[2]];
  streak.uniforms.anchor.value = [x, pose.y + 0.15, z];
}
function quaternionYXZ(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2),
    sy = Math.sin(yaw / 2),
    cp = Math.cos(pitch / 2),
    sp = Math.sin(pitch / 2),
    cr = Math.cos(roll / 2),
    sr = Math.sin(roll / 2);
  // yaw about Y, then pitch about the boat's X, then roll about its Z.
  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}
function rotate(q: readonly number[], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}

// One slider, calm dusk to full gale.
const ramp = (a: number, b: number, x: number) => {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
};
const NAMES = ['Calm', 'Breeze', 'Fresh', 'Squall', 'Gale', 'Storm'];
let storm = Number(slider.value),
  windSpeed = 0,
  moonLight = 1.2;
function setStorm(value: number) {
  storm = value;
  force.value = NAMES[Math.min(NAMES.length - 1, Math.floor(value * NAMES.length))];
  windSpeed = 3 + 24 * value;
  const wind: [number, number] = [-0.8 * windSpeed * 0.7, -0.6 * windSpeed * 0.7];
  sky.options.hours = 20.1 + 2.4 * ramp(0, 1, value);
  haze.far = 4200 - 2600 * ramp(0.2, 1, value);
  moonLight = 1.2 * (1 - 0.5 * ramp(0.3, 1, value));
  // Broken enough that the deck shows its masses and the dark rifts between them, the moon glowing through the thin
  // places; a flash lights them from inside.
  deck.options.coverage = 0.55 + 0.2 * ramp(0, 0.9, value);
  deck.options.density = 0.012 + 0.016 * value;
  deck.options.wind = [wind[0] * 1.5, wind[1] * 1.5];
  weather.options.intensity = ramp(0.18, 0.9, value);
  weather.options.wind = wind;
  // No flashes for anyone who asks for reduced motion.
  weather.options.lightning!.rate = still ? 0 : 2 + 10 * ramp(0.5, 1, value);
  water?.setWaveHeight(0.25 + 1.95 * value ** 1.4);
  // Thin enough near the sea that a level ray keeps about a fifth of its light across the fog's 480 m: the fog covers
  // the far sea and the sky behind it alike (both get its full range), so any thicker and the horizon is lost.
  fog.options.density = 0.001 + 0.0035 * ramp(0.1, 1, value);
  stormAir.volumes[0].density = 0.001 + 0.008 * ramp(0.1, 1, value);
  water?.setWhitecaps(ramp(0.2, 0.95, value)).setChop(0.25 + 0.75 * ramp(0, 1, value));
  fog.options.noise = 0.3 + 0.5 * value;
  fog.options.wind = [wind[0] * 0.6, 0, wind[1] * 0.6];
}
setStorm(storm);
slider.addEventListener('input', () => setStorm(Number(slider.value)));
document.querySelector('#form')!.addEventListener('submit', (event) => event.preventDefault());

// Orbit after the tour; any input ends the tour where the camera is.
const controls = new OrbitControls(camera, stage.canvas);
controls.enabled = false;
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 20;
controls.maxDistance = 220;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
const shots: { position: Vec3; target: Vec3; seconds: number }[] = [
  { position: hero.position, target: hero.target, seconds: 0 },
  { position: [38, 3.5, 58], target: [2, 26, 0], seconds: 7 },
  { position: [10, 34, 26], target: [-6, 30, -4], seconds: 15 },
  { position: [-44, 22, 54], target: [-4, 22, 4], seconds: 23 },
  { position: hero.position, target: hero.target, seconds: 31 },
];
const params = new URLSearchParams(location.search);
let touring = !still && params.get('tour') !== '0',
  tourTime = 0;
function endTour() {
  if (!touring) return;
  touring = false;
  controls.target = camera.target;
  controls.enabled = true;
}
for (const type of ['pointerdown', 'wheel', 'keydown'] as const) addEventListener(type, endTour, { capture: true });
const ease = (t: number) => t * t * (3 - 2 * t);
function tour(delta: number) {
  tourTime += delta;
  const end = shots[shots.length - 1].seconds;
  if (tourTime >= end) return endTour();
  let i = 0;
  while (shots[i + 1].seconds <= tourTime) i++;
  const a = shots[i],
    b = shots[i + 1],
    k = ease((tourTime - a.seconds) / (b.seconds - a.seconds)),
    mix = (u: Vec3, v: Vec3): Vec3 => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k, u[2] + (v[2] - u[2]) * k];
  camera.position = mix(a.position, b.position);
  camera.target = mix(a.target, b.target);
}

// A click that does not drag strikes lightning toward where you clicked.
let down: { x: number; y: number; t: number } | undefined;
stage.canvas.addEventListener(
  'pointerdown',
  (event) => (down = { x: event.clientX, y: event.clientY, t: performance.now() }),
);
stage.canvas.addEventListener('pointerup', (event) => {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || performance.now() - down.t > 400)
    return;
  const dx = camera.target[0] - camera.position[0],
    dz = camera.target[2] - camera.position[2],
    across = (event.clientX / innerWidth - 0.5) * 0.9;
  weather.strike({ distance: 1200 + Math.random() * 1500, azimuth: Math.atan2(dx, dz) + across, strength: 1 });
});
// Each strike moves the flash's light over it.
let lastStrike: { azimuth: number; time: number } | undefined, openingStrike: typeof lastStrike;
weather.onLightning((strike) => {
  strikePosition = [strike.position[0], 0, strike.position[2]];
  lastStrike = strike;
});

let time = 0,
  frames = 0;
stage.use({
  name: 'storm-light',
  setup() {},
  onPreUpdate(delta) {
    if (still) delta = 0;
    time += delta;
    if (touring) tour(delta);
    if (heldBeam === null) beamAngle += delta * ((Math.PI * 2) / 12);
    lens?.setQuaternion([0, Math.sin(beamAngle / 2), 0, Math.cos(beamAngle / 2)]);
    moveBoat(delta, time);
    if (!still && heldFlash === undefined && time - delta < opening.seconds && time >= opening.seconds)
      openingStrike = weather.strike(opening);
    // A lightning flash lights the cloud deck from inside (a light in the deck above the strike), and through the deck
    // the scene's sky light and the sea's reflection; the bolt's light from behind the headland lights the cliffs and
    // the sea, and the moon's light flares with it.
    const flash = heldFlash ?? weather.flash;
    bolt.position = [strikePosition[0], 420, strikePosition[2]];
    bolt.intensity = flash * 4e6;
    deck.options.flash = { position: [strikePosition[0], 950, strikePosition[2]], intensity: flash * 1.6e6 };
    setLights();
    sky.options.lighting!.moon!.intensity = moonLight + flash * 3;
    glow.uniforms.beam.value = beamAngle;
    streak.uniforms.time.value = time;
    fog.options.ambient = [0.004 + flash * 0.06, 0.005 + flash * 0.066, 0.008 + flash * 0.084];
    if (status.isConnected && ++frames > 30) {
      status.remove();
      document.querySelector<HTMLElement>('#viewport')!.dataset.ready = 'true';
    }
  },
  dispose: () => controls.dispose(),
});
setLights();
// For tests and the console.
(window as unknown as Record<string, unknown>).stormLight = {
  engine,
  sky,
  deck,
  water,
  fog,
  weather,
  lights,
  beam: () => beamAngle,
  strike: () => lastStrike,
  opening: () => openingStrike,
};
engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

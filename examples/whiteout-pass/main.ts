// Whiteout Pass: a blizzard at dusk on a mountain pass, and one lit window in a small log hut. Everything that sets the
// look comes from one scene kit, `whiteout` from @margoengine/sky/scene-kits: the overcast sky (@margoengine/sky), the
// blizzard as a weather state that a WeatherMachine and WeatherDrive (@margoengine/weather) turn into gusting snow
// (@margoengine/sky/weather) and froxel fog streaming with the wind (@margoengine/environment/volumetric), the snow
// lying with depth (@margoengine/weather/snow), kept out of the hut by one cover map (@margoengine/weather/cover), the
// lamp's flickering, shadowed light (@margoengine/clustered), bloom and AgX (@margoengine/post, @margoengine/tonemap)
// and TAA. This page only builds the hut and the pass and composes those parts.
//
// URL options: `view=window|close` picks the opening view; `storm=0..1` blends the lull (0) to the blizzard (1, the
// default); `debug=wireframe` draws every mesh's edges, `debug=wind` the wind field as arrows; `fog=0`, `snow=0`
// (falling), `cover=0` (lying), `drift=0` (the fog keeps still) and `lamp=0` turn one layer off.
// `exposure=<seconds>` sets the flakes' shutter time (default 1/120 s).
import { createStage } from 'margoengine';
import { type Mesh, PbrMaterial } from '@margoengine/core';
import {
  type GeometryData,
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  planeGeometry,
  toGeometry,
  wireframePositions,
} from '@margoengine/geometry';
import { generateLogWall } from '@margoengine/procedural';
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
import { WeatherFX } from '@margoengine/sky/weather-fx';
import { WeatherMachine, blendStates } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { PrecipitationCover } from '@margoengine/weather/cover';
import { Snow } from '@margoengine/weather/snow';
import { Shadows } from '@margoengine/shadows';
import { Clustered } from '@margoengine/clustered';
import { animateFlicker } from '@margoengine/clustered/flicker';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { Lines, Line, LineMaterial } from '@margoengine/lines';
import { applyQualityTier, paceEngine } from '@margoengine/quality';
import { fogDensityForVisibility, whiteout, whiteoutVisibility } from '@margoengine/sky/scene-kits';
import { demoStatus } from '../demo-status.ts';

type Vec3 = [number, number, number];
const params = new URLSearchParams(location.search),
  on = (name: string) => params.get(name) !== '0',
  status = document.querySelector<HTMLParagraphElement>('#status')!,
  error = document.querySelector<HTMLParagraphElement>('#error')!;
const page = demoStatus(document.querySelector<HTMLElement>('#viewport')!, status, error);
const tier = applyQualityTier();
const kit = whiteout();

// Views: window, the hut small in the storm; close, the lit window from a few steps away.
const views: Record<string, { position: Vec3; target: Vec3; fov: number }> = {
  window: { position: [4.6, 1.7, 30], target: [0.5, 1.5, 0], fov: 34 },
  close: { position: [3.4, 1.55, 6.8], target: [0.55, 1.3, 1.7], fov: 40 },
};
const view = views[params.get('view') ?? 'window'] ?? views.window;
for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a'))
  link.setAttribute('aria-current', String(link.search === location.search));

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label: 'A blizzard at dusk on a mountain pass: snow streams sideways past a small log hut with one warm lit window',
  camera: { position: view.position, target: view.target, fov: view.fov, near: 0.05, far: 400 },
  onError: (value) => {
    page.error(value);
  },
});
const engine = stage.engine,
  camera = engine.camera;
paceEngine(engine);

// The weather first, so the drive writes this frame's snow, wind and fog before they draw.
// `storm` sets the level, 1 the blizzard and 0 the lull: the machine's state blends between the kit's two, and the
// fog's density follows the visibility the kit gives for that level (the drive's own fog stops at 196 m).
const machine = new WeatherMachine({ ...kit.storm }, { seed: 5 });
const drive = WeatherDrive.attach(engine, { weather: machine, listener: camera });
const scene: { fog?: VolumetricFog } = {};
const storm = (value: number) => {
  const level = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
  machine.set(blendStates({ ...kit.lull }, { ...kit.storm }, level));
  if (scene.fog) scene.fog.options.density = fogDensityForVisibility(whiteoutVisibility(kit, level));
};

const bloom = new Bloom({ ...kit.bloom }),
  tonemap = new Tonemap({ ...kit.tonemap }),
  stack = PostStack.attach(engine, [bloom, tonemap]);
// The snow's reactive mask reaches TAA by itself (Weather publishes it while TAA runs).
TAA.attach(engine, { depth: () => stack.depthTexture });

const sky = Sky.attach(engine, structuredClone(kit.sky) as typeof kit.sky, { preetham, night, reflection, lighting });
const shadows = Shadows.attach(engine, { resolution: tier === 'phone' ? 1024 : 2048, distance: 50, lightSize: 0.03 });
const lights = Clustered.attach(engine, { shadows: { resolution: tier === 'phone' ? 512 : 1024, maxLights: 1 } });

// The hut and the pass, built from primitives. Every mesh keeps its geometry data for the wireframe view.
const built: { mesh: Mesh; data: GeometryData }[] = [];
const quat = (axis: Vec3, angle: number): number[] => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const material = (color: string, roughness: number, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
const add = (data: GeometryData, mat: PbrMaterial, position: Vec3, rotation?: number[]): Mesh => {
  const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(mat).setPosition(position);
  if (rotation) mesh.setQuaternion(rotation);
  built.push({ mesh, data });
  return mesh;
};
const block = (size: Vec3, mat: PbrMaterial, center: Vec3, rotation?: number[]) =>
  add(boxGeometry(size[0], size[1], size[2]), mat, center, rotation);

const logs = material('#4e3320', 0.85),
  logEnds = material('#7d5a3a', 0.8),
  planks = material('#6a4628', 0.72),
  frame = material('#352214', 0.75),
  roofing = material('#2f241d', 0.9),
  iron = material('#262422', 0.5, 0.8),
  brass = material('#a8813a', 0.3, 1),
  glass = material('#f3d9a8', 0.2),
  cloth = material('#6b2a20', 0.95),
  bark = material('#33251b', 0.95),
  needles = material('#1a2c21', 0.9),
  pole = material('#2b2622', 0.7),
  marker = material('#c4521c', 0.6),
  ground = material('#8d949c', 0.95);

// Ground: a fine grid, so the snow's drifts have vertices to lift.
add(planeGeometry(220, 220, 220, 220), ground, [0, 0, 0], quat([1, 0, 0], -Math.PI / 2));

// Log walls: x from -2.1 to 2.1, z from -1.7 to 1.7, logs 0.26 m thick from the ground to 2.08 m. The front wall
// (z = 1.7, facing the trail and the wind) has the one window at x 0.25 to 1.15, y 0.9 to 1.65; the door is on the
// west wall, out of the wind.
const width = 4.2,
  depth = 3.4,
  log = 0.26,
  rows = 8,
  windowX = [0.25, 1.15],
  windowY = [0.9, 1.65],
  doorZ = [-0.45, 0.45],
  doorTop = 1.85;
// The walls come from @margoengine/procedural: stacked logs with chinking between the courses, so no seam between two
// logs shows the sky. The side walls sit half a log higher, notched over the front and back logs; above them the
// gables are stacked logs under the roof slope, shortening toward the ridge. The door is in the west (-x) wall.
const wallTop = rows * log,
  pitch = (35 * Math.PI) / 180,
  ridge = wallTop + (depth / 2 + 0.35) * Math.tan(pitch),
  frontHalf = width / 2 + 0.22,
  sideHalf = depth / 2 + 0.22,
  course = (half: number): [number, number] => (half > 0.15 ? [-half, half] : [0, 0]),
  sideCourses = [
    ...Array.from({ length: rows }, () => course(sideHalf)),
    ...Array.from({ length: 5 }, (_, r) => course(depth / 2 - (log / 2 + r * log) / Math.tan(pitch) - 0.05)),
  ],
  frontWall = generateLogWall({
    courses: Array.from({ length: rows }, () => course(frontHalf)),
    diameter: log,
    segments: 12,
    openings: [[windowX[0], windowX[1], windowY[0], windowY[1]]],
  }),
  backWall = generateLogWall({
    courses: Array.from({ length: rows }, () => course(frontHalf)),
    diameter: log,
    segments: 12,
  }),
  eastWall = generateLogWall({ courses: sideCourses, diameter: log, bottom: log, segments: 12 }),
  // Turned -90 degrees about y, the wall's x runs along world z: the door at z -0.45 to 0.45 is at x -0.45 to 0.45.
  westWall = generateLogWall({
    courses: sideCourses,
    diameter: log,
    bottom: log,
    segments: 12,
    openings: [[doorZ[0], doorZ[1], -Infinity, doorTop]],
  });
add(frontWall, logs, [0, 0, depth / 2]);
add(backWall, logs, [0, 0, -depth / 2]);
add(westWall, logs, [-width / 2, 0, 0], quat([0, 1, 0], -Math.PI / 2));
add(eastWall, logs, [width / 2, 0, 0], quat([0, 1, 0], -Math.PI / 2));
// Window frame, a cross bar, and a sill outside that gathers snow; the door's planks on the west wall.
const wx = (windowX[0] + windowX[1]) / 2,
  wy = (windowY[0] + windowY[1]) / 2,
  ww = windowX[1] - windowX[0],
  wh = windowY[1] - windowY[0];
block([ww + 0.16, 0.07, 0.4], frame, [wx, windowY[0] - 0.02, depth / 2 + 0.06]);
block([ww + 0.16, 0.07, 0.3], frame, [wx, windowY[1] + 0.02, depth / 2]);
for (const x of [windowX[0] - 0.04, windowX[1] + 0.04]) block([0.07, wh, 0.3], frame, [x, wy, depth / 2]);
block([0.04, wh, 0.04], frame, [wx, wy, depth / 2 - 0.04]);
block([ww, 0.04, 0.04], frame, [wx, wy, depth / 2 - 0.04]);
block([0.07, doorTop, doorZ[1] - doorZ[0]], planks, [-width / 2 - 0.03, doorTop / 2, 0]);
for (const x of [-width / 2, width / 2])
  for (const z of [-depth / 2, depth / 2]) block([0.3, wallTop, 0.3], logEnds, [x, wallTop / 2, z]);

// Floor, ceiling, and the roof: two slabs at 35 degrees with an overhang; an iron stovepipe through the back slope.
block([width - 0.26, 0.05, depth - 0.26], planks, [0, 0.1, 0]);
block([width - 0.26, 0.05, depth - 0.26], planks, [0, wallTop - 0.04, 0]);
const roofSlab = (side: 1 | -1) => {
  const run = depth / 2 + 0.55,
    slope = run / Math.cos(pitch);
  return block(
    [width + 0.8, 0.2, slope],
    roofing,
    [0, ridge - (run / 2) * Math.tan(pitch) + 0.1, (side * run) / 2],
    quat([1, 0, 0], side * pitch),
  );
};
const roof = [roofSlab(1), roofSlab(-1)];
const stovepipe = add(cylinderGeometry(0.09, 0.09, 1.4, 12), iron, [-1.1, ridge - 0.1, -0.9]);

// Inside: a table under the window with the oil lamp, a bench, a shelf and a hanging blanket on the back wall, a
// cast-iron stove in the corner. They catch the lamp's light, so the window shows a warm room, not a flat glow.
block([1.1, 0.05, 0.6], planks, [0.7, 0.78, 1.15]);
for (const [dx, dz] of [
  [-0.48, -0.24],
  [0.48, -0.24],
  [-0.48, 0.24],
  [0.48, 0.24],
])
  block([0.05, 0.75, 0.05], planks, [0.7 + dx, 0.39, 1.15 + dz]);
const lampAt: Vec3 = [0.55, 0.9, 1.25];
add(cylinderGeometry(0.055, 0.075, 0.07, 16), brass, lampAt);
add(cylinderGeometry(0.03, 0.04, 0.15, 16), glass, [lampAt[0], lampAt[1] + 0.11, lampAt[2]]);
add(cylinderGeometry(0.04, 0.035, 0.09, 16), material('#c9c2b0', 0.4), [0.95, 0.85, 1.05]);
block([1.4, 0.05, 0.35], planks, [-0.9, 0.45, 1.2]);
block([1.6, 0.04, 0.25], planks, [0.3, 1.45, -depth / 2 + 0.28]);
for (const [x, h] of [
  [-0.25, 0.22],
  [0, 0.16],
  [0.45, 0.2],
  [0.75, 0.12],
])
  block([0.12, h, 0.12], material('#8f7a5c', 0.6), [x, 1.47 + h / 2, -depth / 2 + 0.28]);
block([0.9, 0.85, 0.03], cloth, [1.2, 1.05, -depth / 2 + 0.17]);
block([0.55, 0.6, 0.5], iron, [-1.45, 0.4, -1.05]);

const hut = built.length;
// The trail: snow stakes every six metres marking the pass, each with an orange top, leaning a little. In the storm the
// far ones fade out one by one, which is how far you can see.
let seed = 4242;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 12; i++) {
  const z = 4.5 + i * 6,
    x = -3.2 - Math.sin(i * 0.7) * 1.1,
    tilt = random() * Math.PI * 2,
    lean = quat([Math.cos(tilt), 0, Math.sin(tilt)], 0.03 + random() * 0.06);
  add(cylinderGeometry(0.045, 0.05, 2.3, 8), pole, [x, 1.15, z], lean);
  add(cylinderGeometry(0.048, 0.048, 0.4, 8), marker, [x, 2.1, z], lean);
}
// Pines on the slopes round the pass, seeded so every load and every shot is the same.
for (let i = 0; i < 60; i++) {
  const angle = random() * Math.PI * 2,
    radius = 8 + random() * 60,
    x = Math.cos(angle) * radius,
    z = Math.sin(angle) * radius,
    tall = 4 + random() * 7;
  if (z > 2 && x > -7 && x < 10) continue; // keep the trail and the window in view
  add(cylinderGeometry(0.1, 0.18, tall * 0.3, 8), bark, [x, tall * 0.15, z]);
  for (let k = 0; k < 4; k++) {
    const s = 1 - k * 0.22;
    add(coneGeometry(tall * 0.24 * s, tall * 0.34, 12), needles, [x, tall * (0.3 + k * 0.17) + tall * 0.17, z]);
  }
}

// Snow: falling and blowing, kept out of the hut by one top-down cover map, and lying with depth where the sky sees.
const weather = Weather.attach(engine, {
  ...kit.precipitation,
  intensity: on('snow') ? kit.precipitation.intensity : 0,
  particles: tier === 'phone' ? 16000 : kit.precipitation.particles,
  // A camera's shutter: each flake is swept over this many seconds, so the gale streaks it. 1/120 s is a 180 degree
  // shutter at 60 fps; a shot summing sub-frames gives each one its share (`exposure=` in the URL).
  exposure: Number(params.get('exposure') ?? 1 / 120),
});
if (on('snow')) drive.options.precipitation = weather;
PrecipitationCover.attach(
  engine,
  new WeatherFX({ weather, occluders: [...roof, stovepipe], splashes: 0, lensDrops: 0 }),
);
const snow = on('cover') ? Snow.attach(engine, { ...kit.cover }) : undefined;

// The lamp: one shadowed point light on the table, flickering on the candle curve. The log walls hold its light in,
// so it leaves the hut only through the window, onto the sill, the snow below and the blowing fog in front of it.
const lampLight = {
  position: [lampAt[0], lampAt[1] + 0.2, lampAt[2]] as Vec3,
  range: kit.window.light.range,
  color: [...kit.window.light.color] as Vec3,
  intensity: on('lamp') ? kit.window.light.intensity : 0,
  shadow: { near: 0.05, bias: 0.0008, normalBias: 0.02 },
  flicker: { ...kit.window.light.flicker },
};
for (const { mesh } of built.slice(1, hut)) lights.addShadowCaster(mesh);
const stopFlicker = animateFlicker(engine, lights, [lampLight]);

const fog = on('fog')
  ? VolumetricFog.attach(engine, {
      ...structuredClone(kit.fog),
      grid: tier === 'phone' ? [96, 54, 48] : [160, 90, 128],
      temporal: 0.9,
      shadows,
      lights,
      depth: () => stack.depthTexture,
    })
  : undefined;
scene.fog = fog;
if (fog && on('drift')) drive.options.fogWind = fog;
storm(Number(params.get('storm') ?? 1));

// Debug views: every mesh's edges, or the wind field the snow and the fog follow, as arrows that swing with the gusts.
const debug = params.get('debug');
const lines = debug === 'wireframe' || debug === 'wind' ? new Lines() : undefined;
if (lines) engine.use(lines);
if (lines && debug === 'wireframe') {
  const edge = new LineMaterial({ color: '#7fd4ff', width: 1 });
  for (const { mesh, data } of built)
    lines.add(new Line({ mode: 'segments', positions: wireframePositions(data), material: edge, mesh }));
}
let arrows: { line: Line; points: Float32Array; at: Vec3[] } | undefined;
if (lines && debug === 'wind') {
  const at: Vec3[] = [];
  for (let i = -3; i <= 4; i++)
    for (let k = 0; k < 6; k++) for (const y of [0.4, 1.6, 2.8]) at.push([i * 1.6, y, 3 + k * 2.6]);
  const points = new Float32Array(at.length * 6);
  arrows = {
    line: new Line({ mode: 'segments', positions: points, material: new LineMaterial({ color: '#ffb86b', width: 2 }) }),
    points,
    at,
  };
  lines.add(arrows.line);
}
const sample: [number, number, number] = [0, 0, 0];
const drawArrows = () => {
  if (!arrows) return;
  const { points, at, line } = arrows;
  // Each arrow is the wind over the next 0.08 s: 1.4 m long at the 18 m/s mean wind.
  at.forEach((p, i) => {
    machine.wind.sample(p[0], p[1], p[2], machine.time, sample);
    points.set([p[0], p[1], p[2], p[0] + sample[0] * 0.08, p[1] + sample[1] * 0.08, p[2] + sample[2] * 0.08], i * 6);
  });
  line.setPositions(points);
};

// Orbit with the mouse, except when the shot tool drives the camera (`ui=0`).
const controls = params.get('ui') === '0' ? undefined : new OrbitControls(camera, stage.canvas);
if (controls) {
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.minDistance = 0.5;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
}

let frames = 0;
stage.use({
  name: 'whiteout-pass',
  setup() {},
  onPreUpdate() {
    drawArrows();
    if (status.isConnected && ++frames > 30 && page.ready()) status.remove();
  },
  dispose() {
    stopFlicker();
    controls?.dispose();
  },
});
// For tests, the console and the shot tool (tools/shot/shots/whiteout-*.json): `apply` takes a shot's evaluated
// cutscene state and sets the storm from its `weather.storm` property (1 the blizzard, 0 the lull).
const apply = (state: { properties?: Record<string, Record<string, number | number[]>> }) => {
  const level = state.properties?.weather?.storm;
  if (typeof level === 'number') storm(level);
};
(window as unknown as Record<string, unknown>).whiteoutPass = {
  engine,
  kit,
  machine,
  drive,
  sky,
  weather,
  snow,
  fog,
  lights,
  apply,
};
engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

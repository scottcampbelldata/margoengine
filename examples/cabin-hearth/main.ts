// Cabin Hearth: a snowbound log cabin at night, one lit window in the falling snow, and inside a fire in the hearth
// with a kettle steaming on it. Everything that sets the look comes from one scene kit, `snowNight` from
// @margoengine/sky/scene-kits: the moonlit sky (@margoengine/sky), the falling snow (@margoengine/sky/weather) kept off
// under the roof by one top-down cover map (@margoengine/weather/cover), snow lying with depth
// (@margoengine/weather/snow), the moonlight the snow bounces up under the eaves (@margoengine/environment's
// HemisphereLight), froxel fog lit by the moon and the fire (@margoengine/environment/volumetric), the fire,
// the fire itself, its flames, embers, steam and flickering, soft-shadowed flame-line light (@margoengine/vfx/fire,
// on @margoengine/vfx and @margoengine/clustered), the room's light through the window's frosted glass
// (@margoengine/procedural `generateWindowPane`, @margoengine/clustered/area `openingLight` and `glazingSurface`), the
// one bounce of the lights off what they light (@margoengine/clustered/bounce `LightBounce`), the
// hearth's smoke-dark stone, soot, metals and wood
// (@margoengine/materials/presets), bloom and AgX (@margoengine/post, @margoengine/tonemap) and TAA. This page only
// builds the cabin, places the fire and composes those parts: no light rig, material tuning or particle settings of its
// own.
//
// URL options: `view=outside|hearth` picks the opening view; `debug=wireframe` draws every mesh's edges;
// `debug=layers` shows one on/off switch per layer below;
// `fog=0`, `snow=0` (falling), `cover=0` (lying), `fire=0` and `steam=0` turn one layer off for before and after views;
// `glazing=clear` shows the window as it was before its glass frosted over (no glass drawn, the lantern's beam
// through it); `bounce=0` turns the bounce light off (the direct-light checks of scripts/cabin-hearth-browser-test.mjs
// run so).
import { createStage } from 'margoengine';
import { type Mesh, PbrMaterial } from '@margoengine/core';
import { UnlitMaterial } from '@margoengine/materials';
import {
  castIron,
  hearthstone,
  soot,
  tarnishedCopper,
  weatheredWood,
  type MaterialPreset,
} from '@margoengine/materials/presets';
import {
  type GeometryData,
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  geometryData,
  latheGeometry,
  planeGeometry,
  sphereGeometry,
  toGeometry,
  torusGeometry,
  wireframePositions,
} from '@margoengine/geometry';
import { generateLogWall, generateWindowPane } from '@margoengine/procedural';
import { createMesh, PbrMaterial as SurfaceMaterial, Texture } from '@margoengine/materials';
import { createTree } from '@margoengine/procedural/tree';
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
import { PrecipitationCover } from '@margoengine/weather/cover';
import { Snow } from '@margoengine/weather/snow';
import { Shadows } from '@margoengine/shadows';
import { Clustered } from '@margoengine/clustered';
import { LocalShadows } from '@margoengine/clustered/shadows';
import { LightGroups } from '@margoengine/clustered/groups';
import { AreaLights, glazingSurface, openingLight } from '@margoengine/clustered/area';
import { LightBounce } from '@margoengine/clustered/bounce';
import { animateFlicker, flameEmission } from '@margoengine/clustered/flicker';
import { HemisphereLight } from '@margoengine/environment';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { Lines, Line, LineMaterial } from '@margoengine/lines';
import { applyQualityTier, paceEngine } from '@margoengine/quality';
import { snowNight } from '@margoengine/sky/scene-kits';
import { Fire } from '@margoengine/vfx/fire';

type Vec3 = [number, number, number];
const params = new URLSearchParams(location.search),
  on = (name: string) => params.get(name) !== '0',
  status = document.querySelector<HTMLParagraphElement>('#status')!,
  error = document.querySelector<HTMLParagraphElement>('#error')!;
const tier = applyQualityTier();
// The moon stands to the front right of the cabin, over the outside views' right shoulder, so it lights the log walls,
// the chimney and the snow in front. At the kit's default, low behind the cabin, it backlit every outside view: the
// walls and the chimney read black.
const moonDirection: Vec3 = [0.6, 0.45, 0.66];
// Views: outside, the lit window from the snow; hearth, the fire and the kettle from the room.
const views: Record<string, { position: Vec3; target: Vec3 }> = {
  outside: { position: [5.2, 1.7, 13.5], target: [0.4, 1.6, 0] },
  hearth: { position: [2.3, 1.25, -0.1], target: [0.95, 0.62, -2.05] },
};
const view = views[params.get('view') ?? 'outside'] ?? views.outside;
// The shot is focused on what the view looks at, so the snow passing close to the lens is out of focus.
const kit = snowNight({
  snowfall: (params.get('snowfall') as 'light' | 'moderate' | 'heavy' | null) ?? 'moderate',
  moonDirection,
  focalDistance: Math.hypot(...view.target.map((t, i) => t - view.position[i])),
});
// A view link is current when its view and debug view match this page's, whatever layers are off.
const viewKey = (search: URLSearchParams) => `${search.get('view') ?? 'outside'} ${search.get('debug') ?? ''}`;
for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a'))
  link.setAttribute('aria-current', String(viewKey(new URLSearchParams(link.search)) === viewKey(params)));

// The layers view (`debug=layers`): one switch per layer, each a link to this view with that layer off or back on.
const layers: [name: string, label: string][] = [
  ['fog', 'Fog'],
  ['snow', 'Falling snow'],
  ['cover', 'Lying snow'],
  ['fire', 'Fire'],
  ['steam', 'Steam'],
];
if (params.get('debug') === 'layers') {
  const nav = document.createElement('nav');
  nav.id = 'layers';
  nav.setAttribute('aria-label', 'Layers');
  for (const [name, label] of layers) {
    const next = new URLSearchParams(params);
    if (on(name)) next.set(name, '0');
    else next.delete(name);
    const link = document.createElement('a');
    link.href = `?${next}`;
    link.textContent = `${label}: ${on(name) ? 'on' : 'off'}`;
    link.dataset.layer = name;
    nav.append(link);
  }
  document.body.append(nav);
}

const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  autoStart: false,
  label:
    'A snowbound log cabin at night: snow falls past one warm lit window; inside, a fire burns in a stone hearth and a kettle steams',
  camera: { ...view, fov: params.get('view') === 'hearth' ? 55 : 40, near: 0.05, far: 600 },
  onError: (value) => {
    error.textContent = String(value);
  },
});
const engine = stage.engine,
  camera = engine.camera;
paceEngine(engine);

const bloom = new Bloom({ ...kit.bloom }),
  tonemap = new Tonemap({ ...kit.tonemap }),
  stack = PostStack.attach(engine, [bloom, tonemap]);
const falling: { weather?: Weather } = {};
TAA.attach(engine, { depth: () => stack.depthTexture, reactive: () => falling.weather?.reactiveMask });

const sky = Sky.attach(engine, structuredClone(kit.sky) as typeof kit.sky, { preetham, night, reflection, lighting });
// The moonlit snow lights the cabin from below: the eaves, the sills and the logs' undersides that face the snow.
const bounce = HemisphereLight.attach(engine, {
  sky: [...kit.bounce.sky],
  ground: [...kit.bounce.ground],
  intensity: kit.bounce.intensity,
});
// Shadow map sizes come from the quality tier's preset (@margoengine/quality).
const shadows = Shadows.attach(engine, { distance: 60, lightSize: 0.02 });
// The local lights' shadows: the fire's flame line and the lantern, each a point light with six cube faces. The fire
// and the lantern each light through a group of their own, so neither's flicker replaces the other's lights.
const lights = Clustered.attach(engine),
  localShadows = LocalShadows.attach(engine, { lights }),
  groups = LightGroups.attach(engine, lights);

// The cabin, built from primitives. Every mesh keeps its geometry data for the wireframe view.
const built: { mesh: Mesh; data: GeometryData }[] = [];
const quat = (axis: Vec3, angle: number): number[] => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
// Colours of the cabin's own things (the rug, the roof, the pines): what this cabin is made of, not a look default.
const material = (color: string, roughness: number, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
// A materials preset (@margoengine/materials/presets) on a plain mesh: its linear colour, roughness and metalness.
const preset = ({ color, roughness, metalness }: MaterialPreset) =>
  new PbrMaterial({ color: [color[0], color[1], color[2]], roughness, metalness });
const add = (data: GeometryData, mat: PbrMaterial, position: Vec3, rotation?: number[]): Mesh => {
  const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(mat).setPosition(position);
  if (rotation) mesh.setQuaternion(rotation);
  built.push({ mesh, data });
  return mesh;
};
const block = (size: Vec3, mat: PbrMaterial, center: Vec3, rotation?: number[]) =>
  add(boxGeometry(size[0], size[1], size[2]), mat, center, rotation);

const logs = preset(weatheredWood),
  planks = material('#6e4a2c', 0.7),
  // The stone of the mantel and the chimney; the firebox's jambs and the hearthstone are smoke-dark stone and its back
  // is soot (presets).
  stone = material('#6a6560', 0.92),
  smokeStone = preset(hearthstone),
  sooted = preset(soot),
  iron = preset(castIron),
  copper = preset(tarnishedCopper),
  roofing = material('#5a5049', 0.9),
  fabric = material('#7a2e22', 0.95),
  bark = material('#3b2a1e', 0.95),
  ground = material('#8d949c', 0.95);

// Ground: a fine grid, so the snow's drifts have vertices to lift.
add(planeGeometry(180, 180, 180, 180), ground, [0, 0, 0], quat([1, 0, 0], -Math.PI / 2));

// Log walls: x from -3 to 3, z from -2.5 to 2.5, logs 0.3 m thick from the ground to 2.7 m. The front wall (z = 2.5,
// facing the snow and the camera) has the window at x 0.6 to 1.8, y 1.0 to 2.0 and the door at x -2.1 to -1.1.
const width = 6,
  depth = 5,
  log = 0.3,
  rows = 9,
  windowX: Vec3 = [0.6, 1.8, 0],
  windowY = [0.95, 2.05],
  doorX = [-2.1, -1.1],
  doorTop = 2.15;
// The walls come from @margoengine/procedural: stacked logs with chinking between the courses, so no seam between two
// logs shows the sky. The side walls sit half a log higher, notched over the front and back logs, as a log cabin's
// corners are; above them the gables are stacked logs under the roof slope, shortening toward the ridge.
const wallTop = rows * log,
  pitch = Math.PI / 6,
  ridge = wallTop + (depth / 2 + 0.4) * Math.tan(pitch),
  frontHalf = width / 2 + 0.25,
  sideHalf = depth / 2 + 0.25,
  course = (half: number): [number, number] => (half > 0.2 ? [-half, half] : [0, 0]),
  frontWall = generateLogWall({
    courses: Array.from({ length: rows }, () => course(frontHalf)),
    diameter: log,
    openings: [
      [windowX[0], windowX[1], windowY[0], windowY[1]],
      [doorX[0], doorX[1], -Infinity, doorTop],
    ],
  }),
  backWall = generateLogWall({ courses: Array.from({ length: rows }, () => course(frontHalf)), diameter: log }),
  gable = Array.from({ length: 4 }, (_, r) => course(depth / 2 - (log / 2 + r * log) / Math.tan(pitch) - 0.05)),
  sideWall = generateLogWall({
    courses: [...Array.from({ length: rows }, () => course(sideHalf)), ...gable],
    diameter: log,
    bottom: log,
  });
add(frontWall, logs, [0, 0, depth / 2]);
add(backWall, logs, [0, 0, -depth / 2]);
for (const x of [-width / 2, width / 2]) add(sideWall, logs, [x, 0, 0], quat([0, 1, 0], -Math.PI / 2));
// Window frame, a sill outside that gathers snow, the door's planks.
const frame = material('#5a4330', 0.75);
block([windowX[1] - windowX[0] + 0.16, 0.08, 0.42], frame, [
  (windowX[0] + windowX[1]) / 2,
  windowY[0] - 0.02,
  depth / 2 + 0.05,
]);
block([windowX[1] - windowX[0] + 0.16, 0.08, 0.34], frame, [
  (windowX[0] + windowX[1]) / 2,
  windowY[1] + 0.02,
  depth / 2,
]);
for (const x of [windowX[0] - 0.04, windowX[1] + 0.04])
  block([0.08, windowY[1] - windowY[0], 0.34], frame, [x, (windowY[0] + windowY[1]) / 2, depth / 2]);
// The window's glass and its cross of glazing bars (@margoengine/procedural `generateWindowPane`), set 0.2 m into the
// wall: four lites, the bars 45 mm wide and 50 mm deep in the glass's plane. It is a winter night, and the glass has
// frosted over inside (KB-CABIN-EDGE-SOFT2, Scott 2026-11-16); `glazing=clear` shows it as it was before (no glass
// drawn, the lantern's beam through it). The bars are the frame's wood, and cast shadows like the cabin's other parts.
const glazing = params.get('glazing') === 'clear' ? 'clear' : 'frosted',
  paneAt: Vec3 = [(windowX[0] + windowX[1]) / 2, (windowY[0] + windowY[1]) / 2, depth / 2 - 0.05],
  sash = { lites: [2, 2] as [number, number], barWidth: 0.045, barDepth: 0.05 },
  pane = generateWindowPane({ width: windowX[1] - windowX[0], height: windowY[1] - windowY[0], glazing, ...sash });
add(pane.bars, frame, paneAt);
block([doorX[1] - doorX[0], doorTop, 0.08], planks, [(doorX[0] + doorX[1]) / 2, doorTop / 2, depth / 2 + 0.02]);
// Log ends at the corners.
for (const x of [-width / 2, width / 2])
  for (const z of [-depth / 2, depth / 2]) block([0.34, wallTop, 0.34], logs, [x, wallTop / 2, z]);

// Where the fire sits: in the hearth on the back wall, the flames born on the fuel's top, the centre between the two
// logs' tops (0.415 and 0.505 m).
const hx = 0.95,
  hz = -depth / 2 + 0.35,
  fuelTop: Vec3 = [hx, 0.46, hz];

// Floor and ceiling inside, and the roof: two slabs at 30 degrees with an overhang.
block([width - 0.3, 0.06, depth - 0.3], planks, [0, 0.12, 0]);
block([width - 0.3, 0.05, depth - 0.3], planks, [0, wallTop - 0.05, 0]);
const roofSlab = (side: 1 | -1) => {
  const run = depth / 2 + 0.6,
    slope = run / Math.cos(pitch);
  return block(
    [width + 0.9, 0.22, slope],
    roofing,
    [0, ridge - (run / 2) * Math.tan(pitch) + 0.11, (side * run) / 2],
    quat([1, 0, 0], side * pitch),
  );
};
const roof = [roofSlab(1), roofSlab(-1)];
// Chimney: a stone stack through the back slope.
const chimney = block([0.7, 2.6, 0.7], stone, [0.95, ridge - 0.2, -1.45]);

// The hearth on the back wall: a sooted firebox with smoke-dark stone jambs, a stone mantel and chimney breast, a
// hearthstone, two burning logs on an iron grate, and a copper kettle on a trivet over the fire. A rug and a chair
// before it.
block([1.7, 1.45, 0.12], sooted, [hx, 0.15 + 0.72, -depth / 2 + 0.2]);
for (const x of [hx - 0.78, hx + 0.78]) block([0.22, 1.1, 0.55], smokeStone, [x, 0.15 + 0.55, hz]);
block([1.95, 0.24, 0.62], stone, [hx, 0.15 + 1.22, hz + 0.02]);
block([1.85, 0.06, 0.12], planks, [hx, 0.15 + 1.37, hz + 0.3]);
block([1.4, 1.2, 0.5], stone, [hx, 1.45 + 0.6, hz - 0.03]);
block([2, 0.08, 1.05], smokeStone, [hx, 0.16, hz + 0.25]);
for (const x of [-0.25, 0.25]) block([0.04, 0.12, 0.42], iron, [hx + x, 0.26, hz]);
add(cylinderGeometry(0.075, 0.08, 0.72, 12), bark, [hx, 0.34, hz - 0.05], quat([0, 0, 1], Math.PI / 2 + 0.08));
add(cylinderGeometry(0.065, 0.07, 0.62, 12), bark, [hx + 0.04, 0.44, hz + 0.02], quat([0, 0, 1], Math.PI / 2 - 0.12));
add(torusGeometry(0.14, 0.012, 8, 24), iron, [hx, 0.58, hz + 0.06], quat([1, 0, 0], Math.PI / 2));
for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3])
  add(cylinderGeometry(0.01, 0.01, 0.42, 6), iron, [hx + Math.cos(a) * 0.13, 0.38, hz + 0.06 + Math.sin(a) * 0.13]);
const kettleAt: Vec3 = [hx, 0.6, hz + 0.06];
add(
  latheGeometry(
    [
      [0.001, 0],
      [0.1, 0.005],
      [0.13, 0.05],
      [0.125, 0.11],
      [0.09, 0.16],
      [0.04, 0.18],
      [0.035, 0.2],
      [0.001, 0.205],
    ],
    48,
  ),
  copper,
  kettleAt,
);
const spoutTip: Vec3 = [kettleAt[0] + 0.2, kettleAt[1] + 0.15, kettleAt[2]];
add(
  cylinderGeometry(0.012, 0.025, 0.17, 10),
  copper,
  [kettleAt[0] + 0.15, kettleAt[1] + 0.1, kettleAt[2]],
  quat([0, 0, 1], -0.95),
);
add(torusGeometry(0.09, 0.008, 8, 24, Math.PI), iron, [kettleAt[0], kettleAt[1] + 0.2, kettleAt[2]]);
block([1.6, 0.012, 1.1], fabric, [hx + 0.1, 0.16, hz + 1.25]);
const cx = hx - 1.25;
block([0.5, 0.05, 0.5], planks, [cx, 0.6, hz + 1.3]);
for (const [dx, dz] of [
  [-0.21, -0.21],
  [0.21, -0.21],
  [-0.21, 0.21],
  [0.21, 0.21],
])
  block([0.05, 0.45, 0.05], planks, [cx + dx, 0.37, hz + 1.3 + dz]);
block([0.5, 0.55, 0.05], planks, [cx, 0.9, hz + 1.53]);
// A table by the window with a mug.
block([1.2, 0.05, 0.7], planks, [1.2, 0.85, 1.6]);
for (const [dx, dz] of [
  [-0.5, -0.27],
  [0.5, -0.27],
  [-0.5, 0.27],
  [0.5, 0.27],
])
  block([0.06, 0.7, 0.06], planks, [1.2 + dx, 0.48, 1.6 + dz]);
add(cylinderGeometry(0.045, 0.04, 0.1, 16), material('#c9c2b0', 0.4), [1.45, 0.925, 1.5]);

const cabin = built.length;
// A lantern hung from the ceiling behind the window's cross bars (after `cabin`, so it casts no shadow of its own
// light): an iron rod, cap and frame and a brass base; its flame is drawn with the light below. Hung high, its light
// leaves through the window downward and lays a warm, cross-barred patch on the snow 1 to 4 m in front of the wall;
// a lamp on the table sent it out level, past the sill, to land beyond its range.
const lanternAt: Vec3 = [1.2, 1.875, 1.95],
  brass = material('#a8813a', 0.3, 1);
add(cylinderGeometry(0.006, 0.006, 0.62, 6), iron, [lanternAt[0], 2.31, lanternAt[2]]);
add(coneGeometry(0.07, 0.06, 12), iron, [lanternAt[0], lanternAt[1] + 0.115, lanternAt[2]]);
add(cylinderGeometry(0.06, 0.06, 0.03, 16), brass, [lanternAt[0], lanternAt[1] - 0.095, lanternAt[2]]);
for (const [dx, dz] of [
  [-0.045, -0.045],
  [0.045, -0.045],
  [-0.045, 0.045],
  [0.045, 0.045],
])
  add(cylinderGeometry(0.005, 0.005, 0.18, 6), iron, [lanternAt[0] + dx, lanternAt[1] - 0.005, lanternAt[2] + dz]);
// Spruces round the clearing (@margoengine/procedural/tree: branch whorls and the needles' measured colour), seeded so
// every load and every shot is the same. The wireframe view draws each tree's own geometry as created (a spruce near
// the camera shows its shoots, and each trunk its flare at its height).
const wireTrees = params.get('debug') === 'wireframe';
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 70; i++) {
  const angle = random() * Math.PI * 2,
    radius = 11 + random() * 45,
    x = Math.cos(angle) * radius,
    z = Math.sin(angle) * radius - 6,
    tall = 5 + random() * 7;
  if (z > 8 && Math.abs(x) < 9) continue; // keep the view to the window open
  const tree = createTree(engine, 'conifer', { position: [x, 0, z], height: tall });
  if (wireTrees)
    for (const mesh of [tree.trunk, tree.canopy]) {
      const { vertices, indices } = mesh.geometry!,
        positions = new Float32Array(vertices.length / 2),
        normals = new Float32Array(vertices.length / 2);
      for (let v = 0; v < positions.length; v += 3) {
        positions.set(vertices.subarray(v * 2, v * 2 + 3), v);
        normals.set(vertices.subarray(v * 2 + 3, v * 2 + 6), v);
      }
      built.push({
        mesh,
        data: geometryData(positions, normals, new Float32Array((positions.length / 3) * 2), indices),
      });
    }
}

// Snow: falling, kept off under the roof by one top-down cover map, and lying with depth wherever the sky sees.
const weather = Weather.attach(engine, {
  ...kit.precipitation,
  intensity: on('snow') ? kit.precipitation.intensity : 0,
  particles: tier === 'phone' ? kit.precipitation.particles! / 3 : kit.precipitation.particles,
});
falling.weather = weather;
PrecipitationCover.attach(engine, new WeatherFX({ weather, occluders: [...roof, chimney], splashes: 0, lensDrops: 0 }));
const snow = on('cover') ? Snow.attach(engine, { ...kit.cover }) : undefined;

// The fire (@margoengine/vfx/fire): the kit's flames, embers and steam at the kettle's spout, and its light, a
// flickering flame line of soft-shadowed sphere lights in a group of its own, all from the kit's hearth. The page only
// places it on the fuel's top. The lantern is the kit's lamp, hung behind the window, in another group: it lights the
// snow below the window, and the window's bars cast its shadow.
for (const { mesh } of built.slice(1, cabin)) localShadows.add(mesh);
const fire = on('fire')
  ? Fire.attach(engine, {
      position: fuelTop,
      lights: groups,
      depth: () => stack.depthTexture,
      steam: on('steam') ? spoutTip : undefined,
    })
  : undefined;
const { flicker: lampFlicker, ...lamp } = kit.hearth.lamp;
const lantern = {
  ...lamp,
  color: [...lamp.color] as Vec3,
  position: [...lanternAt] as Vec3,
  castShadow: true,
  flicker: { ...lampFlicker },
};
// Its flame (@margoengine/clustered/flicker `flameEmission`): an emitter at the lamp's own radiance, its intensity over
// its 11 mm flame's projected area (17,000 cd/m2), flickering with it, so it glows through the kit's bloom. The
// ellipsoid, 16.5 mm across and 29 mm tall, shows that area, pi 0.011^2, from the side.
const flame = new UnlitMaterial({ color: [0, 0, 0], ...flameEmission(lantern) }),
  flameMesh = createMesh(engine, sphereGeometry(lantern.radius, 16, 12), flame);
flameMesh.root.setPosition([lanternAt[0], lanternAt[1] - 0.045, lanternAt[2]]).setScale([0.75, 4 / 3, 0.75]);
const stopFlicker = animateFlicker(engine, groups.group('lamp'), [lantern], { emitters: [flame] });
// The room's light leaving through the window (@margoengine/clustered/area `openingLight`): the lantern's and the
// fire's light, reflected round the room, lights the sill, the logs round the window and the snow under it. The page
// gives only the room: its inner walls of logs and its plank floor and ceiling, and the lights in it.
// The frost stops the lantern's beam and sends its light out diffusely, so the window glows milky, brightest nearest
// the lantern, with the bars dark across it and their shadows on the frost (KB-CABIN-FROST2), and the patch on the snow
// is a soft glow with no window-bar lines in it. The pane stops the lights' beams in their shadow maps; its faces and
// the light it sends out come from the same opening, on the glass's outdoor face. Behind the frost the frame's sides
// reach 0.118 m into the room (to z 2.33), the reveal that can shade it.
const inner = { width: width - log, depth: depth - log, height: wallTop - 0.075 - 0.15 },
  walls = 2 * (inner.width + inner.depth) * inner.height - (windowX[1] - windowX[0]) * (windowY[1] - windowY[0]),
  opening = {
    position: [paneAt[0], paneAt[1], paneAt[2] + 0.002] as Vec3,
    direction: [0, 0, 1] as Vec3,
    width: windowX[1] - windowX[0],
    height: windowY[1] - windowY[0],
    room: [
      { area: walls, reflectance: [...weatheredWood.color.slice(0, 3)] as Vec3 },
      { area: 2 * inner.width * inner.depth, reflectance: [...planks.data.slice(0, 3)] as Vec3 },
    ],
    lights: [lantern, ...(fire?.lights ?? [])],
    glazing,
    ...sash,
    reveal: paneAt[2] - 0.002 - (depth / 2 - 0.17),
    // The frame's outer face (z 2.67) stands this far out of the glass, and the sill (to z 2.76) this far past it: the
    // light clips to what each point outside sees through the opening and over the sill (KB-BOUNCE-REVEAL1).
    recess: depth / 2 + 0.17 - (paneAt[2] + 0.002),
    sill: 0.09,
  } as const;
const windowLight = AreaLights.attach(engine, { lights });
const roomLight = openingLight(opening);
windowLight.setLights([roomLight]);
if (glazing === 'frosted') {
  // The frost's outdoor face glows with the light it lets through at each point (`emissiveMap`), as the lamps' places
  // and the bars give it.
  const look = glazingSurface(opening),
    glow = new Texture(look.emissiveMap, { wrapS: 'clamp', wrapT: 'clamp' }),
    glass = createMesh(engine, pane.frosted, [
      new SurfaceMaterial({ ...look.outside, emissiveMap: glow }),
      new SurfaceMaterial(look.inside),
    ]);
  glass.root.setPosition(paneAt);
  localShadows.add(glass);
  lights.add(glass);
}
// One bounce (@margoengine/clustered/bounce): what the lantern, the fire and the window light lights in turn what
// faces it, so the lantern-lit snow warms the logs round the window and the hearth's lit stone the room. The window's
// light is the room's light leaving it, counted once (the package's README), captured from in front of the bars (their
// lites and depth). Every shadowed light bounces by default.
const lightBounce = on('bounce')
  ? LightBounce.attach(engine, {
      lights,
      openings: [{ light: roomLight, glazing, lites: sash.lites, barDepth: sash.barDepth }],
    })
  : undefined;

// The fog's froxel grid comes from the quality tier's preset.
const fog = on('fog')
  ? VolumetricFog.attach(engine, {
      ...structuredClone(kit.fog),
      shadows,
      lights,
      depth: () => stack.depthTexture,
    })
  : undefined;

// The wireframe view: every mesh's edges, drawn over the shaded scene.
if (params.get('debug') === 'wireframe') {
  const lines = new Lines();
  engine.use(lines);
  const edge = new LineMaterial({ color: '#7fd4ff', width: 1 });
  for (const { mesh, data } of built)
    lines.add(new Line({ mode: 'segments', positions: wireframePositions(data), material: edge, mesh }));
}

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
  name: 'cabin-hearth',
  setup() {},
  onPreUpdate() {
    if (status.isConnected && ++frames > 30) {
      status.remove();
      document.querySelector<HTMLElement>('#viewport')!.dataset.ready = 'true';
    }
  },
  dispose() {
    stopFlicker();
    controls?.dispose();
  },
});
// For tests, the console and the shot tool (tools/shot/shots/cabin-*.json).
(window as unknown as Record<string, unknown>).cabinHearth = {
  engine,
  kit,
  sky,
  bounce,
  lightBounce,
  bloom,
  tonemap,
  weather,
  snow,
  fog,
  lights,
  groups,
  windowLight,
  flame,
  fire,
  embers: fire?.particles.embers,
  steam: fire?.particles.steam,
};
engine.start();
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

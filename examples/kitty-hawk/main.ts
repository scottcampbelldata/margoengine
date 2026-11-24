// Kitty Hawk 1903: the dune coast of the Kill Devil Hills (@margoengine/scenes/dune-coast) with the 1903 Wright Flyer
// (@margoengine/procedural/flyer) flying one of the four flights of 17 December 1903 from the published distances and
// times. Every picture is the engine's; the page only places the Flyer, and the camera.
//
// URL options: any dune-coast setting (weather, hour, wind, grass, surf, visibility; its quality is `detail`); flight (0 parks the
// Flyer on the rail, 1 to 4 flies that flight); start (the flight's clock at time 0, seconds; default 0); spin (1: the
// propellers turn while parked); view (a scene anchor for the first frame);
// rig: world (the camera keys are world positions), track (the keys are offsets from the Flyer), pan (the position keys
// are world positions and the target keys are offsets from the Flyer); above (1: the world keys' heights are above the
// sand under them); flyer (library, the default: the hero Flyer from the film's asset library; procedural: the
// procedural Flyer); assets (library, the default: the camp, rail and props from the asset library in place of the
// scene's procedural camp; procedural keeps the scene's); lod (1: the wide-shot builds of the library assets). The
// library is the film's asset folder beside the checkout, served by the dev servers at /asset-library/; where it is
// missing the page draws the procedural Flyer and camp.
// The film's staging: wrecked (1: the procedural Flyer as the gust left it), gust (1: the gust rolls the parked Flyer
// over, its clock from `start`), wire (1: the restraining wire to a stake behind the skids, taut before release and
// loose after), z and yaw (the Flyer's place along the rail's line and an extra turn, for the camp shots), props (more
// library models: JSON [[file under kitty-hawk/ without .glb, x, z, turn in radians], ...], each set on the sand) and
// cast (the people, library men with Mixamo skeletons and baked clips: JSON [{who, clip, at, heading, path, then,
// offset}], `who` a library folder such as wright-wilbur, `at` "pilot" (prone in the Flyer's cradle, riding with it),
// "wingtip" (Wilbur's mark at the right wing tip) or [x, z], `path` [[time, x, z], ...] walked in turn (facing the
// way it goes), `then` [time, clip] to change clip, `offset` seconds into the clip at time 0). Camera: shake (a
// @margoengine/cinematic/noise profile, handheld or walking, on the shot's clock; shakeGain scales it) and focus (a
// rack focus: JSON [[time, x, y, z], ...], points the lens pulls between in turn, y above the sand there, in place of
// focusing on the Flyer).
// The film's colour, as JSON in the URL: model (preetham or bruneton, the sky's day model), air (the sky's
// `atmosphere`), skylook (the sky's `look`), clouds (fields merged into the sky's cloud sheet) and grade (a live
// `Grade` of @margoengine/tonemap/grade: lift, gamma, gain, saturation, wheels, curves) after the preset's grade;
// vclouds (VolumetricClouds options of @margoengine/sky/volumetric-clouds, lit by the scene's sky: a cumulus layer with
// depth; set clouds {"coverage": 0} with it so the sky's flat sheet is off), muslin (the wings' fabric albedo, linear
// RGB; default unbleached muslin 0.62,0.55,0.42), ao (the ambient occlusion radius, metres; default 1.2) and ambient
// (the sky's least daytime fill light on any side, linear RGB: a warm value stands in for the light the sunlit sand
// throws back up into shadow sides).
import { Engine, PbrMaterial, type Mesh, type Vec3 } from '@margoengine/core';
import { toGeometry, applyMatrix4, type GeometryData } from '@margoengine/geometry/utils';
import { generateWrightFlyer, wrightFlightPose, wrightGustRoll, restrainingWire } from '@margoengine/procedural/flyer';
import { Animation } from '@margoengine/animation';
import { install } from '@margoengine/materials';
import { skin } from '@margoengine/materials/skin';
import { eye } from '@margoengine/materials/eye';
import { hair } from '@margoengine/materials/hair';
import { CameraNoise, handheld, walking } from '@margoengine/cinematic/noise';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { attach, info } from '@margoengine/scenes/dune-coast';
import { MotionBlur } from '@margoengine/post/motion-blur';
import { SMAA } from '@margoengine/post/smaa';
import { DOF } from '@margoengine/dof';
import { Autofocus } from '@margoengine/dof/autofocus';
import { TAA } from '@margoengine/taa';
import { Grade, type GradeOptions } from '@margoengine/tonemap/grade';
import { VolumetricClouds, type VolumetricCloudOptions } from '@margoengine/sky/volumetric-clouds';

const q = new URLSearchParams(location.search);
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
canvas.width = Math.round(innerWidth * devicePixelRatio);
canvas.height = Math.round(innerHeight * devicePixelRatio);

const engine = await Engine.create(canvas, {
  camera: { position: [14, 3, -10], target: [0, 1.4, -18], fov: 40, near: 0.2, far: 30000 },
});
const settings: Record<string, unknown> = {};
// `quality` in the URL is the quality tier (@margoengine/quality); the scene's own ground detail is `detail`.
for (const [k, spec] of Object.entries(info.settings)) {
  const v = q.get(k === 'quality' ? 'detail' : k);
  if (v === null) continue;
  const d = (spec as { default: unknown }).default;
  settings[k] =
    typeof d === 'number'
      ? Number(v)
      : typeof d === 'boolean'
        ? v !== '0'
        : Array.isArray(d)
          ? v.split(',').map(Number)
          : v;
}
// The film's assets are Blender builds kept outside the repository; dev servers serve them at /asset-library/.
const LIBRARY = '/asset-library/kitty-hawk/';
const lod = q.get('lod') === '1' ? '-lod1' : '';
// A checkout without the library (or a host without the dev server's /asset-library/) draws the procedural ones.
const inLibrary = async (file: string) => {
  const res = await fetch(`${LIBRARY}${file}${lod}.glb`, { method: 'HEAD' });
  return res.ok && res.headers.get('content-type') === 'model/gltf-binary';
};
const libraryFlyer =
  q.get('flyer') !== 'procedural' && q.get('wrecked') !== '1' && (await inLibrary('flyer-1903/flyer-1903'));
const libraryCamp =
  q.get('assets') !== 'procedural' && settings.camp !== false && (await inLibrary('hangar-1903/hangar-1903'));
if (libraryCamp) settings.camp = false;
// ao: the scene's ambient occlusion reach, metres (its `occlusion` setting); the page's default is 1.2.
if (settings.occlusion === undefined) settings.occlusion = Number(q.get('ao') ?? 1.2);
const scene = attach(engine, settings);
// The blown sand loads on demand: wait for it so the first frame already has it.
await scene.ready;
// The film's grade, through the sky preset's live Tonemap options (no preset default changes): ev (stops added to the
// preset's exposure), kelvin (white balance), contrast, vignette, grain (film grain, 0 to 1) and curve (the tone curve,
// such as agx for a soft highlight roll-off); unset keeps the preset's value.
{
  const grade = scene.parts.preset.tonemap.options as Record<string, number>;
  if (q.get('ev') !== null) grade.exposure = (grade.exposure ?? 0) + Number(q.get('ev'));
  for (const [key, option] of [
    ['kelvin', 'temperature'],
    ['contrast', 'contrast'],
    ['vignette', 'vignette'],
    ['grain', 'grain'],
  ] as const)
    if (q.get(key) !== null) grade[option] = Number(q.get(key));
  const curve = q.get('curve');
  if (curve) (scene.parts.preset.tonemap.options as { curve?: string }).curve = curve;
}
{
  const sky = scene.parts.preset.sky;
  const json = (key: string): Record<string, unknown> | null =>
    q.get(key) === null ? null : JSON.parse(q.get(key) as string);
  const model = q.get('model');
  if (model === 'preetham' || model === 'bruneton') sky.options.model = model;
  const air = json('air'),
    look = json('skylook'),
    clouds = json('clouds'),
    primaries = json('grade');
  if (air) sky.options.atmosphere = air;
  if (look) sky.options.look = look;
  if (clouds) sky.options.clouds = { ...sky.options.clouds, ...clouds };
  const fill = q.get('ambient');
  if (fill !== null && sky.options.lighting?.ambient) {
    const day = fill.split(',').map(Number) as [number, number, number];
    sky.options.lighting = { ...sky.options.lighting, ambient: { ...sky.options.lighting.ambient, day } };
  }
  if (primaries) {
    const tone = scene.parts.preset.tonemap.options;
    tone.extensions = [...(tone.extensions ?? []), new Grade(primaries as GradeOptions)];
  }
}
// The film chain (post=0 turns it off), added to the scene's own PostStack (its ambient occlusion comes from the scene,
// its Bloom and Tonemap from the sky preset): motion blur from TAA's velocity after the occlusion, depth of field
// focused on the Flyer before the bloom, and SMAA after the grade.
let focus: Autofocus | null = null;
if (q.get('post') !== '0') {
  const stack = scene.parts.preset.post;
  let taa: TAA | null = null;
  const dof = new DOF({ focalLength: Number(q.get('lens') ?? 0.05), aperture: Number(q.get('fstop') ?? 4) });
  stack.addEffect(new MotionBlur({ velocity: () => taa?.velocity, shutter: 0.5 }), 1);
  stack.addEffect(dof, 2);
  stack.addEffect(new SMAA());
  taa = TAA.attach(engine, { depth: () => stack.depthTexture });
  focus = Autofocus.attach(engine, dof, { smoothing: 0.3 });
}
if (q.get('vclouds') !== null) {
  // Real 3D cumulus, lit by the scene's sky; they stop at the scene's surfaces and take TAA's new march start each frame.
  const stack = scene.parts.preset.post;
  VolumetricClouds.attach(engine, {
    sky: scene.parts.preset.sky,
    depth: () => stack.depthTexture,
    temporal: q.get('post') !== '0',
    ...(JSON.parse(q.get('vclouds') as string) as VolumetricCloudOptions),
  });
}
if (q.get('view')) scene.view(q.get('view') as string, Number(q.get('fov') ?? 40));

// The Flyer: fabric, wood and metal, the moving parts on pivots under a body node pitched about the centre of mass.
const flyer = generateWrightFlyer({ wrecked: q.get('wrecked') === '1' });
// Unbleached muslin: a mid cream, about 0.6 albedo (the 0.86 white of before burned out in the sun).
const muslinColor = (q.get('muslin') ?? '0.62,0.55,0.42').split(',').map(Number) as [number, number, number];
const muslin = new PbrMaterial({ color: muslinColor, roughness: 0.9, doubleSided: true });
const spruce = new PbrMaterial({ color: [0.55, 0.36, 0.18], roughness: 0.8 });
const iron = new PbrMaterial({ color: [0.07, 0.07, 0.07], roughness: 0.55, metalness: 0.7 });
const propWood = new PbrMaterial({ color: [0.62, 0.38, 0.16], roughness: 0.6 });
const CG = 1.2;
const root = engine.createMesh();
const body = engine.createMesh(root);
body.position.set(0, -CG, 0);
const casters: Mesh[] = [];
const part = (data: GeometryData, material: PbrMaterial, parent: Mesh, name: string) => {
  const mesh = engine.createMesh(parent).setGeometry(toGeometry(data)).setMaterial(material);
  mesh.name = name;
  casters.push(mesh);
  return mesh;
};
const offset = (data: GeometryData, p: readonly number[]) =>
  applyMatrix4(data, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1]);
part(flyer.wings, muslin, body, 'wings');
part(flyer.frame, spruce, body, 'frame');
part(flyer.cradle, spruce, body, 'cradle');
part(flyer.ribs, new PbrMaterial({ color: [0.7, 0.56, 0.36], roughness: 0.85 }), body, 'ribs');
part(flyer.wires, iron, body, 'wires');
part(flyer.engine, iron, body, 'engine');
const pivot = (p: readonly number[]) => {
  const m = engine.createMesh(body);
  m.position.set(p[0], p[1], p[2]);
  return m;
};
let elevator = pivot(flyer.elevator.pivot);
part(offset(flyer.elevator.geometry, flyer.elevator.pivot), muslin, elevator, 'elevator');
const lever = pivot(flyer.lever.pivot);
part(offset(flyer.lever.geometry, flyer.lever.pivot), spruce, lever, 'lever');
const rudder = pivot(flyer.rudder.pivot);
part(offset(flyer.rudder.geometry, flyer.rudder.pivot), muslin, rudder, 'rudders');
let props = flyer.propellers.map((p, i) => {
  const hub = pivot(p.pivot);
  part(offset(p.geometry, p.pivot), propWood, hub, `propeller ${i}`);
  return { hub, spin: p.spin };
});

// People: no figure is drawn until the realistic, rigged Orville and Wilbur land as an engine asset entry (no capsule
// or mannequin stand-in). Their marks are kept every frame in `people`, by id, so the men drop in by id: `orville`
// prone on the lower wing (a child of the Flyer's body, which pitches with it), `wilbur` running at the right wing tip
// (his run speed in m/s), and the lifesaving station's `watchers` by the camp.
type Mark = { position: Vec3; heading: number; speed: number; parent?: Mesh };
const people: Record<string, Mark> = {
  orville: {
    position: [flyer.pilot.hips[0], flyer.pilot.hips[1] + 0.12, flyer.pilot.hips[2] - 0.75],
    heading: 0,
    speed: 0,
    parent: undefined,
  },
  wilbur: { position: [0, 0, 0], heading: Math.PI, speed: 0 },
};
const watchers: Mark[] = [
  [-14, -6, 2.6],
  [-15.5, -4.5, 2.2],
  [-13, -3.2, 2.9],
  [-16.8, -7.4, 2.5],
  [-12, -8.6, 2.7],
].map(([x, z, h]) => ({
  position: [x, scene.height(x, z), z] as Vec3,
  heading: h,
  speed: 0,
}));
// The hero Flyer (`flyer-1903` in the asset library): its pivots are named nodes, its skids 0.08 m higher on the
// truck's cross-beam than the procedural Flyer's.
let crank: Mesh | null = null;
let pilotNode: Mesh | null = null;
let rest = 0.2;
if (libraryFlyer) {
  const model = await loadGLTF(engine, `${LIBRARY}flyer-1903/flyer-1903${lod}.glb`);
  for (const m of casters) m.visible = false;
  casters.length = 0;
  // gltf/pbr types its nodes with the engine's internal Mesh; the page's meshes come from the public facade.
  model.root.setParent(body as unknown as Parameters<typeof model.root.setParent>[0]);
  casters.push(model.root);
  scene.parts.occlusion?.add(model);
  const node = (name: string) => {
    const found = model.nodes.find((m) => m.name === name);
    if (!found) throw new Error(`flyer-1903 has no node ${name}`);
    return found;
  };
  elevator = node('elevator');
  props = [
    { hub: node('propeller_right'), spin: 1 },
    { hub: node('propeller_left'), spin: -1 },
  ];
  crank = node('engine_crank');
  pilotNode = model.nodes.find((m) => m.name === 'pilot_hips') ?? null;
  rest = 0.28;
}
for (const m of casters) scene.parts.shadows.add(m, {});

// The camp from the asset library: the 1903 hangar and the 1901 shed where the scene's procedural camp stands, the
// 60 ft rail north from the origin with its truck, and the props of the first-flight photograph.
let truck: Mesh | null = null;
const assets: Record<string, Mesh> = {};
if (libraryCamp) {
  const put = async (name: string, file: string, x: number, z: number, yaw: number) => {
    const model = await loadGLTF(engine, `${LIBRARY}${file}${lod}.glb`);
    model.root.position.set(x, scene.height(x, z) - 0.03, z);
    model.root.setQuaternion([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    scene.parts.shadows.add(model.root, {});
    scene.parts.occlusion?.add(model);
    assets[name] = model.root;
    return model;
  };
  const rx = Number(q.get('x') ?? 0);
  const [, , rail] = await Promise.all([
    put('hangar', 'hangar-1903/hangar-1903', -70, 30, Math.PI),
    put('shed', 'shed-1901/shed-1901', -90, 30, Math.PI),
    put('rail', 'launch-rail/launch-rail', rx, 0, 0),
    put('bench', 'camp-props/bench/bench', rx + 5.9, 0.4, 0.1),
    put('shovel', 'camp-props/shovel/shovel', rx + 1.6, 2.4, 0.7),
    put('can', 'camp-props/tin-can/tin-can', rx + 2.1, 1.7, 0),
    put('anemometer', 'camp-props/hand-anemometer/hand-anemometer', rx + 3.2, 2.8, 0.4),
    put('camera', 'camp-props/camera-tripod/camera-tripod', rx - 12, -17, Math.PI / 2),
    put('sawhorse', 'camp-props/sawhorse/sawhorse', -61.5, 26.5, 0.3),
    put('crate', 'camp-props/crate/crate', -60.5, 28.5, -0.2),
  ]);
  truck = rail.nodes.find((m) => m.name === 'truck') ?? null;
}

const flight = Number(q.get('flight') ?? 0);
const start = Number(q.get('start') ?? 0);
const spinParked = q.get('spin') === '1';
const rig = q.get('rig') ?? 'world';
const railX = Number(q.get('x') ?? 0);
const railZ = Number(q.get('z') ?? 0);
const turn = Number(q.get('yaw') ?? 0);
const gust = q.get('gust') === '1';
// The restraining wire: from the tie at the skids' rear to a stake 3 m behind; it lies loose once let go (t >= 0).
const wireMesh = q.get('wire') === '1' ? engine.createMesh().setMaterial(iron) : null;
if (wireMesh) scene.parts.shadows.add(wireMesh, {});
let wireLoose: boolean | null = null;

// More library props (the lifesaving station, the signal pole, crates), set on the sand.
const propList = q.get('props') ? (JSON.parse(q.get('props') as string) as [string, number, number, number?][]) : [];
await Promise.all(
  propList.map(async ([file, x, z, yaw = 0]) => {
    const model = await loadGLTF(engine, `${LIBRARY}${file}${lod}.glb`);
    model.root.position.set(x, scene.height(x, z) - 0.03, z);
    model.root.setQuaternion([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    scene.parts.shadows.add(model.root, {});
    scene.parts.occlusion?.add(model);
  }),
);

// The cast: library men, each on a clip seeked to the shot's clock every frame (no wall clock, so renders repeat).
type CastEntry = {
  who: string;
  clip: string;
  at?: 'pilot' | 'wingtip' | [number, number];
  heading?: number;
  path?: number[][];
  then?: [number, string];
  offset?: number;
};
const castList = q.get('cast') ? (JSON.parse(q.get('cast') as string) as CastEntry[]) : [];
const cast = await Promise.all(
  castList.map(async (entry) => {
    const model = await loadGLTF(engine, `/asset-library/${entry.who}/${entry.who}.glb`);
    // Skin, eyes and strand hair from @margoengine/materials, on the material names the cast files carry.
    const strands = () => [hair({ direction: 'v', strands: 1024 })];
    const iris = { irisColor: [0.2, 0.27, 0.32] as [number, number, number], pupil: 0.3 };
    const want = {
      Skin: [skin()],
      EyeL: [eye(iris)],
      EyeR: [eye(iris)],
      Hair: strands(),
      Brows: strands(),
      Lashes: strands(),
      Moustache: strands(),
    };
    // Each man carries only some of these (Wilbur has no moustache).
    const named = new Set(model.primitives.map((p) => (p.material as { name?: string }).name));
    install(model as unknown as Parameters<typeof install>[0], {
      features: Object.fromEntries(Object.entries(want).filter(([name]) => named.has(name))),
    });
    const animation = Animation.attach(model as unknown as Parameters<typeof Animation.attach>[0]);
    animation.play(entry.clip);
    animation.playing = false;
    scene.parts.shadows.add(model.root, {});
    scene.parts.occlusion?.add(model);
    if (entry.at === 'pilot') {
      // Prone in the cradle: a child of the Flyer's body (or the library Flyer's pilot node), so he pitches with it.
      const parent = (pilotNode ?? body) as unknown as Parameters<typeof model.root.setParent>[0];
      model.root.setParent(parent);
      if (!pilotNode) model.root.position.set(flyer.pilot.hips[0], flyer.pilot.hips[1], flyer.pilot.hips[2]);
    }
    return { entry, model, animation, clip: entry.clip };
  }),
);

type Q = [number, number, number, number];
const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axis = (x: number, y: number, z: number, angle: number): Q => {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
};
// Yaw about Y, then nose-up pitch (about -X, since the Flyer's +Z is forward), then roll about Z.
const quat = (yaw: number, pitch: number, roll: number) =>
  mul(mul(axis(0, 1, 0, yaw), axis(-1, 0, 0, pitch)), axis(0, 0, 1, roll));
const world: [number, number, number] = [0, 0, 0];
function place(t: number) {
  const pose = flight >= 1 && !gust ? wrightFlightPose(flight, t) : null;
  const roll = gust ? wrightGustRoll(t) : null;
  const along = pose ? pose.position[2] : 0;
  // The Flyer faces -Z (north), so its own +X and +Z are world -X and -Z.
  const x = railX - (roll ? roll.position[0] : 0);
  const z = railZ - along - (roll ? roll.position[2] : 0);
  const ground = scene.height(x, z);
  const y = ground + (pose ? pose.position[1] : roll ? roll.position[1] + 0.05 : 0.2) + rest - 0.2;
  world[0] = x;
  world[1] = y + CG;
  world[2] = z;
  root.position.set(world[0], world[1], world[2]);
  if (focus) focus.options.target = [world[0], world[1], world[2]];
  root.setQuaternion(
    quat(Math.PI + turn + (roll?.yaw ?? 0), pose?.pitch ?? roll?.pitch ?? 0, pose?.roll ?? roll?.roll ?? 0),
  );
  elevator.rotation.set(pose?.elevator ?? 0, 0, 0);
  lever.rotation.set(-(pose?.elevator ?? 0) * 1.5, 0, 0);
  if (wireMesh && wireLoose !== (t >= 0 && flight >= 1)) {
    wireLoose = t >= 0 && flight >= 1;
    const sz = railZ + 1.17 + 3,
      floor = scene.height(railX, sz),
      stake = [railX, floor + 0.25, sz],
      tie = wireLoose
        ? [railX + 0.4, floor + 0.02, sz - 2.6]
        : [railX, scene.height(railX, railZ) + rest + 0.08, railZ + 1.17];
    wireMesh.setGeometry(toGeometry(restrainingWire(tie, stake, wireLoose ? 1 : 0, floor + 0.01)));
  }
  const angle = pose ? pose.propeller : spinParked ? (2 * Math.PI * 350 * (t + 4)) / 60 : 0.6;
  for (const p of props) p.hub.rotation.set(0, 0, p.spin * angle);
  crank?.rotation.set(0, 0, (angle * 23) / 8);
  // The truck runs under the machine to the end of the rail and stays where the machine lifted off it.
  if (truck) truck.position.z = -Math.min(along, 60 * 0.3048 - 1);
  // Wilbur steadies the right wing on the rail and runs beside it; after lift-off he slows to a stop. The pilot's right is
  // the Flyer's -X, which the half turn of the heading puts at world +X.
  const run = pose ? Math.min(along, 16 + Math.max(0, along - 16) * 0.35) : 0;
  const wz = -Math.min(run, 22),
    wx = railX + 5.9;
  people.wilbur.position = [wx, scene.height(wx, wz), wz];
  people.wilbur.speed =
    pose && along > 0.05 && along < 30 ? Math.min(3, pose.phase === 'rail' ? along / Math.max(0.5, t) : 1.2) : 0;
  // The cast on their marks and paths, each clip at the shot's time.
  for (const c of cast) {
    const e = c.entry;
    const clip = e.then && t - start >= e.then[0] ? e.then[1] : e.clip;
    if (clip !== c.clip) {
      c.animation.play(clip);
      c.animation.playing = false;
      c.clip = clip;
    }
    const local = t - start - (e.then && clip === e.then[1] ? e.then[0] : 0);
    c.animation.seek(Math.max(0, local + (e.offset ?? 0)));
    if (e.at === 'pilot') continue;
    let px: number,
      pz: number,
      heading = e.heading ?? Math.PI;
    if (e.at === 'wingtip') [px, pz] = [people.wilbur.position[0], people.wilbur.position[2]];
    else if (e.path) {
      const keys = e.path,
        now = t - start;
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1][0] <= now) i++;
      const a = keys[i],
        b = keys[i + 1] ?? a,
        u = b[0] > a[0] ? Math.min(1, Math.max(0, (now - a[0]) / (b[0] - a[0]))) : 0;
      px = a[1] + (b[1] - a[1]) * u;
      pz = a[2] + (b[2] - a[2]) * u;
      if (e.heading === undefined && (b[1] !== a[1] || b[2] !== a[2])) heading = Math.atan2(b[1] - a[1], b[2] - a[2]);
    } else [px, pz] = (e.at as [number, number]) ?? [0, 0];
    c.model.root.position.set(px, scene.height(px, pz), pz);
    c.model.root.setQuaternion([0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);
  }
}
people.orville.parent = body;
place(-start);

const cam = engine.camera;
const above = q.get('above') === '1';
const shakeName = q.get('shake');
const shake = shakeName
  ? new CameraNoise(shakeName === 'walking' ? walking : handheld, { gain: Number(q.get('shakeGain') ?? 1), seed: 1903 })
  : null;
const camPose = {
  position: new Float64Array(3),
  target: new Float64Array(3),
  up: new Float64Array([0, 1, 0]),
  fov: 40,
  roll: 0,
  focusDistance: 10,
};
const focusKeys = q.get('focus') ? (JSON.parse(q.get('focus') as string) as number[][]) : null;
function focusAt(time: number): [number, number, number] {
  const keys = focusKeys as number[][];
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= time) i++;
  const a = keys[i],
    b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b[0] > a[0] ? Math.min(1, Math.max(0, (time - a[0]) / (b[0] - a[0]))) : 0,
    e = u * u * (3 - 2 * u);
  const x = a[1] + (b[1] - a[1]) * e,
    z = a[3] + (b[3] - a[3]) * e;
  return [x, a[2] + (b[2] - a[2]) * e + scene.height(x, z), z];
}
function apply(_state: unknown, { time }: { time: number }) {
  place(time + start);
  if (focus && focusKeys) focus.options.target = focusAt(time);
  cam.up = [0, 1, 0];
  if (above && rig !== 'track') {
    // The keys' heights are above the sand under them, so a move over the dunes never dips into a hummock.
    const p = cam.position,
      t = cam.target;
    cam.position = [p[0], p[1] + scene.height(p[0], p[2]), p[2]] as Vec3;
    if (rig === 'world') cam.target = [t[0], t[1] + scene.height(t[0], t[2]), t[2]] as Vec3;
  }
  if (rig === 'track') {
    cam.position = [world[0] + cam.position[0], world[1] + cam.position[1], world[2] + cam.position[2]] as Vec3;
    cam.target = [world[0] + cam.target[0], world[1] + cam.target[1], world[2] + cam.target[2]] as Vec3;
  } else if (rig === 'pan') {
    cam.target = [world[0] + cam.target[0], world[1] + cam.target[1], world[2] + cam.target[2]] as Vec3;
  }
  if (shake) {
    // The noise runs on the shot's clock, so every frame of a render is the same on a second render.
    camPose.position.set(cam.position);
    camPose.target.set(cam.target);
    shake.time = time;
    shake.update(camPose, 0);
    cam.position = [camPose.position[0], camPose.position[1], camPose.position[2]] as Vec3;
    cam.target = [camPose.target[0], camPose.target[1], camPose.target[2]] as Vec3;
  }
}

(window as unknown as Record<string, unknown>).kitty = {
  engine,
  scene,
  apply,
  flyer,
  assets,
  people: { ...people, watchers },
};
engine.start();
document.body.dataset.ready = 'true';

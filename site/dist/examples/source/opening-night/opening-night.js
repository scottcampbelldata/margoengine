import { Animation } from '@margoengine/animation';
import { SkinnedCrowd, bakeBones } from '@margoengine/animation/instanced-skin';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { walkCrowd } from '@margoengine/humans/crowd';
import { Material, loadTexture } from '@margoengine/materials';
import { Crowd, NavMesh } from '@margoengine/navmesh';
import { Sky } from '@margoengine/sky';
import { exampleAsset } from '../live/asset-base.js';
import { finishTexture, mix, ramp, rng, shotAt } from './film.js';
import { surface, texturedGround } from './environment-films.js';

const input = (name) => exampleAsset(`opening-night/${name}`);
const entries = [-10, 0, 10];
const canopyPosts = [-15.5, -5, 5, 15.5];
const planters = [
  [0, 9, 4.8, 6.5],
  [-7.45, 1.8, 3.0, 2.5],
  [7.45, 1.8, 3.0, 2.5],
];
const wall = -9.25;
const crowdCount = 96;
const framesPerSecond = 24;

function plazaNavigation() {
  const xs = [-20, -10.95, -9.05, -8.95, -5.95, -2.7, -0.95, 0.95, 2.7, 5.95, 8.95, 9.05, 10.95, 20];
  const zs = [-16.3, -9.55, -8.95, 0.25, 3.35, 5.4, 12.6, 21, 36];
  const vertices = zs.flatMap((z) => xs.map((x) => [x, 0, z]));
  const polygons = [];
  for (let j = 0; j < zs.length - 1; j++)
    for (let i = 0; i < xs.length - 1; i++) {
      const x = (xs[i] + xs[i + 1]) / 2,
        z = (zs[j] + zs[j + 1]) / 2;
      if (Math.abs(z - wall) < 0.31 && !entries.some((door) => Math.abs(x - door) < 0.95)) continue;
      if (planters.some(([cx, cz, w, d]) => Math.abs(x - cx) < w / 2 + 0.3 && Math.abs(z - cz) < d / 2 + 0.3)) continue;
      const first = j * xs.length + i;
      polygons.push([first, first + 1, first + xs.length + 1, first + xs.length]);
    }
  return new NavMesh(vertices, polygons);
}

function stageCrowd(nav) {
  const crowd = new Crowd(nav, { density: true, neighborDistance: 3.7, maxNeighbors: 12 });
  for (const x of canopyPosts) crowd.addObstacle({ position: [x, 0, -5.7], radius: 0.29 });
  const random = rng(6213);
  const arrivals = [];
  for (let i = 0; i < crowdCount; i++) {
    const x = -9.1 + (i % 12) * 1.64 + 0.68 * (random() - 0.5);
    const z = 13.4 + Math.floor(i / 12) * 2.57 + 0.85 * random();
    const agent = crowd.addAgent({ position: [x, 0, z], radius: 0.29, maxSpeed: mix(1.02, 1.47, random()) });
    const bag = Math.floor(i / 12);
    const entry = i % 7 < 2 ? 1 : x < -3 ? 0 : x > 3 ? 2 : 1;
    arrivals.push({
      agent,
      time: bag * 6.3 + random() * 3.5,
      destination: [entries[entry] + mix(-1.29, 1.29, random()), 0, mix(-15.5, -11.5, random())],
    });
  }
  arrivals.sort((a, b) => a.time - b.time);
  return { crowd, arrivals };
}

async function castType(engine, name) {
  const signal = AbortSignal.timeout(30_000);
  const [model, map] = await Promise.all([
    loadGLTF(engine, input(`${name}.glb`), { signal }),
    loadTexture(input(`${name}.png`), { colorSpace: 'srgb', signal }),
  ]);
  const animation = new Animation(model);
  const bake = bakeBones(animation, { fps: 24, clips: ['Walk', 'Stand'] });
  animation.dispose();
  model.dispose();
  const drawer = SkinnedCrowd.attach(engine, bake, { map, color: [0.95, 0.91, 0.85, 1], roughness: 0.77 });
  return { drawer, map };
}

export async function buildOpeningNight(engine, shop, cluster) {
  const [slate, stone, ...cast] = await Promise.all([
    surface('asphalt_02', { color: '#767782', normalScale: 0.62 }),
    surface('concrete_floor_02', { color: '#d0c5b5', normalScale: 0.41 }),
    ...[
      'business_male_02',
      'business_female_01',
      'business_male_07',
      'business_female_03',
      'business_male_01',
      'business_female_02',
      'business_male_05',
      'business_female_04',
    ].map((name) => castType(engine, name)),
  ]);
  const sky = Sky.attach(engine, {
    model: 'bruneton',
    sunDirection: [-0.56, -0.16, -0.78],
    timeScale: 0.1,
    night: { zenithColor: [0.008, 0.015, 0.041], horizonColor: [0.06, 0.094, 0.156], starIntensity: 0.31 },
    clouds: { coverage: 0.24, height: 750, speed: 0.02 },
  });
  const terrace = texturedGround(
    engine,
    () => -0.025,
    slate.material,
    { origin: [-49, -28], size: [98, 85], resolution: 30 },
    2.4,
  );
  const texture = finishTexture(5305, { grain: 17, mottling: 20, streak: true });
  const copper = new Material({ color: '#9a6845', metalness: 0.73, roughness: 0.42, roughnessMap: texture });
  const dark = new Material({ color: '#27313a', metalness: 0.54, roughness: 0.48, roughnessMap: texture });
  const black = new Material({ color: '#292e32', roughness: 0.91, roughnessMap: texture });
  const pale = new Material({ color: '#a99c81', roughness: 0.83, roughnessMap: texture });
  const glass = new Material({ color: '#71818a', roughness: 0.17, metalness: 0.23, transparent: true, opacity: 0.22 });
  const light = new Material({ color: '#d0ab77', emissive: '#ffbf75', emissiveIntensity: 2.2, roughness: 0.32 });
  const facade = shop.group('Aster Hall');
  shop.box([31.7, 0.13, 8.7], stone.material, [0, -0.004, -12.95], undefined, facade, 0.032);
  shop.box([31.8, 0.42, 11.8], dark, [0, 6.62, -14.1], undefined, facade, 0.1);
  shop.box([31.4, 1.8, 0.38], pale, [0, 5.5, wall], undefined, facade, 0.04);
  shop.box([31.45, 0.16, 4.52], dark, [0, 3.76, -7.8], undefined, facade, 0.037);
  shop.box([31.52, 0.039, 0.032], light, [0, 3.67, -5.58], undefined, facade, 0.005);
  shop.box([31.45, 0.21, 0.081], copper, [0, 3.78, -5.6], undefined, facade, 0.011);
  for (const x of canopyPosts) {
    shop.box([0.66, 6.15, 0.72], stone.material, [x, 3.04, wall], undefined, facade, 0.06);
    shop.box([0.37, 3.61, 0.39], copper, [x, 1.8, -5.7], undefined, facade, 0.035);
  }
  for (const x of [-15.5, 15.5]) shop.box([0.43, 6.38, 11.9], dark, [x, 3.11, -14.2], undefined, facade, 0.04);
  shop.box([31.1, 6.1, 0.33], black, [0, 3.04, -19.2], undefined, facade, 0.034);
  const leaves = [];
  for (const [door, x] of entries.entries()) {
    const front = shop.group('Entrance ' + (door + 1), facade, [x, 0, wall]);
    for (const side of [-1, 1]) {
      const panelX = side * 2.79;
      shop.box([1.68, 2.72, 0.066], glass, [panelX, 1.43, 0], undefined, front, 0.018);
      for (const offset of [-0.81, 0.81])
        shop.box([0.072, 2.83, 0.12], dark, [panelX + offset, 1.43, 0], undefined, front, 0.01);
      const doorLeaf = shop.group('Sliding glazed door leaf', front);
      shop.box([1.76, 2.53, 0.065], glass, [0, 1.3, 0.024], undefined, doorLeaf, 0.013);
      for (const offset of [-0.866, 0.866])
        shop.box([0.053, 2.62, 0.102], copper, [offset, 1.31, 0.024], undefined, doorLeaf, 0.012);
      shop.box([1.76, 0.078, 0.105], copper, [0, 0.032, 0.024], undefined, doorLeaf, 0.011);
      leaves.push({ element: doorLeaf, side });
    }
    for (const height of [2.74, 3.28, 4.4])
      shop.box([8.64, 0.074, 0.16], copper, [0, height, 0], undefined, front, 0.016);
    shop.box([8.68, 1.08, 0.047], glass, [0, 3.82, 0], undefined, front, 0.012);
    shop.box([6.7, 0.064, 0.18], light, [0, 2.72, -0.92], undefined, front, 0.022);
    shop.sign(['ENTRANCE ' + (door + 1)], [1.46, 0.32], [0, 2.98, 0.105], undefined, front, {
      foreground: '#f1d3a1',
      background: '#2a2424',
      lit: 0.36,
    });
  }
  shop.sign(['ASTER HALL'], [7.25, 0.98], [0, 5.49, wall + 0.225], undefined, facade, {
    foreground: '#f8dfb1',
    background: '#353031',
    lit: 0.72,
  });
  const planter = new Material({ color: '#6c6557', roughness: 0.84, roughnessMap: texture });
  const garden = new Material({ color: '#485646', roughness: 0.92, roughnessMap: texture });
  for (const [x, z, w, d] of planters) {
    shop.box([w, 0.64, d], planter, [x, 0.31, z], undefined, null, 0.064);
    shop.box([w - 0.15, 0.11, d - 0.15], black, [x, 0.62, z], undefined, null, 0.041);
    for (let i = 0; i < Math.floor(w / 0.43); i++)
      for (let j = 0; j < Math.floor(d / 0.58); j++) {
        const u = (i + 0.5) / Math.floor(w / 0.43),
          v = (j + 0.5) / Math.floor(d / 0.58);
        const at = [x + (w - 0.58) * (u - 0.5), 0.67 + 0.054 * Math.sin(i * 2 + j), z + (d - 0.62) * (v - 0.5)];
        const r = 0.18 + 0.065 * Math.sin(i * 3 + j);
        shop.ring([0.027, r, 0.25], garden, at, [0.17 * Math.sin(j), i * 0.64, 0.15 * Math.sin(i)], undefined, 6);
      }
    shop.box([w * 0.86, 0.021, 0.055], light, [x, 0.052, z + d / 2 + 0.025], undefined, null, 0.006);
  }
  for (const x of [-13.5, 13.5])
    for (const z of [2.6, 10.1, 18.3, 25]) {
      shop.ring([0.064, 0.088, 3.86], dark, [x, 1.91, z], undefined, null, 17);
      shop.box([0.54, 0.13, 0.3], dark, [x, 3.84, z], undefined, null, 0.022);
      shop.box([0.45, 0.028, 0.234], light, [x, 3.773, z], undefined, null, 0.01);
    }
  const plazaLamps = [
    [-2.08, 6.18],
    [2.08, 6.18],
    [-2.08, 11.81],
    [2.08, 11.81],
  ];
  for (const [x, z] of plazaLamps) {
    shop.ring([0.053, 0.085, 2.76], dark, [x, 1.38, z], undefined, null, 20);
    shop.box([0.46, 0.093, 0.34], dark, [x, 2.75, z], undefined, null, 0.021);
    shop.box([0.39, 0.023, 0.27], light, [x, 2.694, z], undefined, null, 0.009);
  }
  cluster.setLights([
    ...entries.map((x) => ({ position: [x, 2.88, -7.95], color: [1, 0.66, 0.37], intensity: 68, range: 14 })),
    ...entries.map((x) => ({ position: [x, 3.4, -12.1], color: [1, 0.82, 0.55], intensity: 51, range: 14 })),
    ...[-13.5, 13.5].flatMap((x) =>
      [2.6, 10.1, 18.3, 25].map((z) => ({ position: [x, 3.71, z], color: [0.55, 0.7, 1], intensity: 26, range: 10 })),
    ),
    ...plazaLamps.map(([x, z]) => ({ position: [x, 2.6, z], color: [0.87, 0.84, 0.72], intensity: 32, range: 8.7 })),
  ]);
  const nav = plazaNavigation();
  let { crowd, arrivals } = stageCrowd(nav);
  let released = 0,
    current = 0;
  const walkers = cast.map(({ drawer }, index) =>
    walkCrowd(
      {
        get agents() {
          return crowd.agents.filter((_agent, i) => i % cast.length === index);
        },
      },
      drawer,
      { walk: 0, stand: 1, stride: 1.31, turnRate: 5, seed: 39 + index, scale: 0.986 + index * 0.012 },
    ),
  );
  const phases = walkers.map((w) => w.phases.slice()),
    headings = walkers.map((w) => w.headings.slice());
  function simulate(time) {
    const frame = Math.floor(time * framesPerSecond + 0.00001);
    if (frame < current) {
      ({ crowd, arrivals } = stageCrowd(nav));
      released = 0;
      current = 0;
      walkers.forEach((w, index) => {
        w.phases.set(phases[index]);
        w.headings.set(headings[index]);
      });
    }
    for (; current < frame; current++) {
      while (released < arrivals.length && arrivals[released].time <= current / framesPerSecond) {
        const { agent, destination } = arrivals[released++];
        agent.setTarget(destination);
      }
      crowd.update(1 / framesPerSecond);
      for (const walker of walkers) walker.update(1 / framesPerSecond);
    }
    for (const walker of walkers) walker.update(0);
  }
  const shots = [
    [5.6, [-4.7, 2.2, 20.1], [-4.09, 2.33, 18.5], [-1.8, 2.04, 13], [-1.74, 2.11, 11.8], 42],
    [12.5, [4.65, 2.26, -3.2], [3.36, 1.83, -4.55], [0, 1.73, wall], [0, 1.88, wall], 45],
    [17.9, [2.3, 1.63, 4.79], [2.03, 1.74, 3.86], [-2.63, 1.46, 8.8], [-2.22, 1.51, 8.9], 42],
    [33.8, [-10.75, 2.21, 11.3], [-8.75, 2.56, 9.8], [-3.9, 1.32, 4.8], [-4.7, 1.31, 2], 41],
    [51.7, [3.4, 16.8, 15.8], [4.0, 19, 16.35], [0, 0.55, 6.1], [0, 0.68, 3.7], 45],
    [66.4, [10.3, 1.83, -3.81], [9.04, 1.87, -4.17], [9.31, 1.59, -9.44], [10.02, 1.83, -11.25], 46],
    [79.5, [-3.65, 2.93, -13.25], [-4.53, 3.11, -13.87], [-0.3, 1.45, -8.7], [0.06, 1.37, -7.7], 53],
    [90, [19.2, 4.3, 22.8], [22.72, 5.17, 25.1], [1, 2.4, -4.4], [0.3, 2.25, -4.6], 43],
  ];
  return {
    apply(time) {
      simulate(time);
      const spread = mix(0.87, 1.84, ramp(time, 7.8, 10.4));
      for (const { element, side } of leaves) element.setPosition([side * spread, 0, 0]);
      return shotAt(shots, time);
    },
    cues: [
      [0.2, 5.25, 'Opening night at Aster Hall.'],
      [7.95, 12.24, 'Three entrances open onto the same foyer.'],
      [20.1, 30.5, 'Visitors adjust their pace as the plaza fills.'],
      [35.1, 47.0, 'From above, the crowd splits around the planters.'],
      [53.1, 63.1, 'Each group takes a different route to the doors.'],
      [68.2, 76.6, 'The three paths converge inside the hall.'],
    ],
    musicCredit: 'Music: Sax and Piano • Maarten Schellekens • CC0',
    models: [terrace, ...cast.map((c) => c.drawer)],
    dispose() {
      for (const { drawer, map } of cast) {
        drawer.dispose();
        map.dispose();
      }
      sky.dispose();
      texture.dispose();
      slate.dispose();
      stone.dispose();
    },
    inspection: {
      visitors: () => crowd.agents.length,
      entrants: () => crowd.agents.filter((a) => a.position[2] < wall).length,
    },
  };
}

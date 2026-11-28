import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { alpineTreelineGraph } from '@margoengine/biomes/treeline';
import { Geometry, PbrMaterial } from '@margoengine/core';
import { DOF } from '@margoengine/dof';
import { GTAO } from '@margoengine/post/gtao';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { SURFACES } from '@margoengine/materials/presets';
import { FORB_COLORS, forb } from '@margoengine/procedural/forbs';
import { libraryParts } from '@margoengine/scenes/library';
import { Scatter } from '@margoengine/scatter';
import { GrassScatter } from '@margoengine/scatter/grass';
import { Sky } from '@margoengine/sky';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { TerrainHeightmap } from '@margoengine/terrain';
import { buildBoulder } from '@margoengine/terrain/rocks';
import { RockSurface } from '@margoengine/terrain/rock-surface';
import { mix, ramp, rng } from './film.js';
import { ridgeTrees } from './subalpine-fir.js';
import { asset as libraryAsset } from './assets.js';

const altitude = 3300;
const line = altitude + 155;
const sun = [0.72, 0.36, -0.6];
const grid = 1025;
const datum = 2000;
const firKey = 'library:subalpine-fir';
const youngFirKey = 'library:young-fir';
const timberlineFirKey = 'library:timberline-fir';

const start = [-500, 3374.12, -500];
const TALUS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** The talus scans at about 0.42 of their photographed size (the biome's size draw scales them again), three levels each. */
async function talusMeshes(signal) {
  const entries = await Promise.all(
    TALUS.map(async (name) => {
      const parts = await libraryParts(
        ['near', 'middle', 'far'].map((level) => libraryAsset(`treeline-rocks/talus/talus-${name}_${level}.gltf`)),
        { kind: 'stone', signal },
      );
      const shrink = (g) => ({ ...g, positions: g.positions.map((v) => v * 0.42) });
      return [
        'library:talus-' + name,
        parts.map((part) => ({
          ...part,
          geometry: Array.isArray(part.geometry) ? part.geometry.map(shrink) : shrink(part.geometry),
        })),
      ];
    }),
  );
  return Object.fromEntries(entries);
}
function flight(t) {
  // One continuous retreat and climb. Early height gain is small enough to keep the grass in frame.
  const p = ramp(t, 0, 90);
  const near = ramp(t, 0, 7);
  const x = start[0] + 784 * p ** 1.43 + 1.88 * near;
  const z = start[2] - 405 * p ** 1.38 - 0.93 * near;
  const y = start[1] + 267 * p ** 1.42 + 0.54 * near;
  const gazeX = mix(-517, -1220, p ** 0.86);
  const gazeZ = mix(-480, 447, p ** 0.86);
  const gazeY = mix(start[1] + 1.5, 3548, p ** 0.84);
  return { position: [x, y, z], target: [gazeX, gazeY, gazeZ], fov: mix(37, 44, ramp(t, 10, 68)) };
}

// The aerial half: poses at these seconds (position, gaze), joined by Hermite curves with Catmull-Rom tangents, the
// first three on the opening retreat so the hand-over at 40 s keeps its speed. From 48 s the camera arcs at a steady
// 35 m/s around the summit dome (centre about -900, 300), climbing: along the tree line, across the east face, level
// with the plateau, then over the valley looking west to the far range.
const AERIAL = [
  [32, flight(32)],
  [40, flight(40)],
  [48, flight(48)],
  [58, { position: [42, 3560, -360], target: [-1000, 3490, 150] }],
  [68, { position: [127, 3640, -34], target: [-950, 3560, 320] }],
  [78, { position: [100, 3760, 300], target: [-1250, 3650, 450] }],
  [88, { position: [29, 3880, 498], target: [-2300, 3660, 950] }],
  [98, { position: [-78, 3960, 666], target: [-2700, 3650, 1150] }],
  [108, { position: [-204, 4020, 805], target: [-2900, 3650, 1300] }],
];
function hermite(key, t) {
  let i = 1;
  while (i < AERIAL.length - 2 && t > AERIAL[i + 1][0]) i++;
  const [t0, a] = AERIAL[i - 1],
    [t1, b] = AERIAL[i],
    [t2, c] = AERIAL[i + 1],
    [t3, d] = AERIAL[i + 2],
    h = t2 - t1,
    s = Math.min(1, Math.max(0, (t - t1) / h)),
    s2 = s * s,
    s3 = s2 * s;
  return b[key].map((v, k) => {
    const m1 = ((c[key][k] - a[key][k]) / (t2 - t0)) * h,
      m2 = ((d[key][k] - b[key][k]) / (t3 - t1)) * h;
    return (2 * s3 - 3 * s2 + 1) * v + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * c[key][k] + (s3 - s2) * m2;
  });
}
/** The camera at `t` seconds: position, gaze target and vertical field of view in degrees. */
export function camera(t) {
  if (t <= 40) return flight(t);
  return { position: hermite('position', t), target: hermite('target', t), fov: mix(37, 44, ramp(t, 10, 68)) };
}

export const ridgeCamera = { ...flight(0), near: 0.11, far: 30000 };
export const ridgeLook = {
  direction: [...sun, 3.18],
  radiance: [1, 0.86, 0.67, 0.36],
  ambient: [0.75, 0.87, 1],
  exposure: 0.16,
  contrast: 1.05,
  environment: 0.43,
  bloom: 0.11,
  shadows: { distance: 270, resolution: 2048, normalBias: 0.059, lightSize: 0.48 },
};

function boundaryBiomes() {
  const plant = (id, mesh, density, radius, max, heights) => ({
    id,
    mesh,
    density,
    radius,
    size: { kind: 'reverse-j', q: 1.42, max },
    suitability: { height: heights, slope: [null, 42] },
    sink: 0.27,
    lod: [39, 141, 1710],
    color: { hue: 0.035, value: 0.15 },
  });
  const fir = { ...plant('fir', firKey, 345, 3, 1.33, [altitude - 65, line + 130]), canopyKind: 'conifer' };
  const youngFir = {
    ...plant('young-fir', youngFirKey, 180, 2.4, 1.16, [altitude - 65, line + 130]),
    canopyKind: 'conifer',
  };
  const scrub = plant('wind-stunted-fir', timberlineFirKey, 135, 1.6, 0.91, [line - 110, line + 135]);
  // Talus from eight photographed granite blocks (treeline-rocks/talus in the asset library), so no two stones match.
  const stones = (density) =>
    TALUS.map((name) => ({
      id: 'talus-' + name,
      mesh: 'library:talus-' + name,
      density: density / TALUS.length,
      radius: 0.3,
      size: { kind: 'reverse-j', q: 1.7, max: 1.32 },
      alignToGround: 0.65,
      sink: 0.22,
      lod: [27, 69, 320],
      color: { hue: 0.02, value: 0.12 },
    }));
  // Fallen blocks of 1 to 4 m from the same scans, few and far apart, so the slopes show boulders from 100 m and more.
  const blocks = (density) =>
    TALUS.map((name) => ({
      id: 'block-' + name,
      mesh: 'library:talus-' + name,
      density: density / TALUS.length,
      radius: 2.2,
      size: { kind: 'reverse-j', q: 1.5, max: 6.5 },
      alignToGround: 0.5,
      sink: 0.3,
      lod: [60, 180, 700],
      color: { hue: 0.02, value: 0.14 },
    }));
  return [
    defineBiome({
      id: 'subalpine-fir',
      climate: { height: [altitude - 125, line + 125], slope: [null, 43] },
      weight: 1.8,
      ground: [
        { material: 'needles', weight: 1.14 },
        { material: 'moss', moisture: [0.47, null] },
        { material: 'rock', slope: [28, null], weight: 1.8 },
      ],
      plants: [
        // Closed subalpine fir and spruce below the line, in clumps with glades between (stands of 55 to 70 m).
        { ...fir, density: 560, stands: { scale: 55, cover: 0.93 } },
        { ...youngFir, density: 300, stands: { scale: 70, cover: 0.84 } },
      ],
      rocks: stones(51),
      wind: { strength: 0.28, detail: 0.54 },
    }),
    defineBiome({
      id: 'upper-meadow',
      climate: { height: [altitude + 7, line + 123], slope: [null, 32] },
      weight: 1.05,
      // Turf with cured grass on the dry spurs, gravel breaking through it and rock on the steeper banks; the view's
      // patches draw them side by side.
      ground: [
        { material: 'grass', weight: 1.1 },
        { material: 'dry-grass', moisture: [null, 0.55] },
        { material: 'gravel', weight: 0.16 },
        { material: 'rock', slope: [26, null], weight: 1.7 },
      ],
      plants: [{ ...scrub, stands: { scale: 52, cover: 0.57 } }],
      rocks: [...stones(84), ...blocks(1.6)],
      wind: { strength: 0.59, detail: 0.62 },
      details: [{ id: 'meadow-bunchgrass', mesh: 'procedural:grass', density: 18, light: [0.44, 1], blades: true }],
    }),
    defineBiome({
      id: 'exposed-scree',
      climate: { height: [line - 48, null] },
      weight: 3.1,
      ground: [
        { material: 'rock', weight: 1.2 },
        { material: 'gravel', slope: [9, 37], weight: 0.85 },
        { material: 'grass', slope: [null, 21], height: [null, line + 38], weight: 1.2 },
        { material: 'dry-grass', slope: [null, 26], weight: 0.45 },
      ],
      rocks: [...stones(145), ...blocks(4.5)],
    }),
  ];
}

export async function buildRidge(engine, shop, _cluster, shadows) {
  const sky = Sky.attach(engine, {
    sunDirection: sun,
    hours: 7.35,
    timeScale: 0,
    turbidity: 2.8,
    exposure: -0.64,
    fog: { density: 0.00019, start: 145, falloff: 'exp', color: [0.31, 0.45, 0.61] },
  });
  const cloudDeck = VolumetricClouds.attach(engine, {
    sky,
    coverage: 0.47,
    bottom: 4520,
    top: 5790,
    scale: 14100,
    density: 0.024,
    wind: [4.7, -1.4],
    steps: 54,
    lightSteps: 5,
    maxDistance: 26000,
    groundAlbedo: 0.19,
    dimLight: false,
    temporal: false,
  });
  const response = await fetch(new URL(libraryAsset('continental-divide-dem.u16')), {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Cannot load the USGS elevation grid');
  const packed = new DataView(await response.arrayBuffer());
  if (packed.byteLength !== grid * grid * 2) throw new Error('Elevation grid does not have the expected dimensions');
  const samples = Float32Array.from({ length: grid * grid }, (_, i) => datum + packed.getUint16(i * 2, true) * 0.1);
  const world = await BiomeWorld.create({
    seed: 294876,
    size: [8192, 8192],
    origin: [-4096, -4096],
    resolution: 4,
    tileSize: 256,
    workers: false,
    height: { samples, width: grid, depth: grid },
    climate: { latitude: 40.314, rainfall: 775 },
    biomes: boundaryBiomes(),
  });
  const view = await BiomeView.attach(engine, world, {
    clipmap: { resolution: 128, levels: 8 },
    graph: alpineTreelineGraph({
      elevation: line,
      width: 148,
      patchSize: 172,
      seed: 154726,
      mature: ['subalpine-fir/fir'],
      young: ['subalpine-fir/young-fir'],
      stunted: ['upper-meadow/wind-stunted-fir'],
    }),
    textureResolution: 4,
    radius: 1250,
    nearRadius: 700,
    patches: { size: 23, contrast: 0.6, warp: 0.65 },
    // Front Range granite and gneiss: no sedimentary beds, but sheeting joints that step the faces into ragged
    // ledges, jointed blocks and buttresses, couloirs down the drainage and talus fans of the same granite below.
    rock: { debris: 'gravel', slope: [30, 46], strata: 11, dip: [0.12, -0.07], ledges: 0.55, facets: 16, relief: 0.5, gullies: 14, tone: 0.34 },
    canopy: 0.35,
    maxSteps: Infinity,
    lookahead: 0,
    sky,
    shadows,
    water: false,
    meshes: {
      ...(await ridgeTrees(firKey, youngFirKey, timberlineFirKey)),
      ...(await talusMeshes(AbortSignal.timeout(20000))),
    },
    materials: {
      rock: { color: [0.38, 0.36, 0.33], detail: 0.68, bump: 0.53, macro: 0.61 },
      gravel: { color: [0.47, 0.414, 0.344], detail: 0.68, bump: 0.55, macro: 0.42 },
      moss: { color: [0.245, 0.266, 0.146], detail: 0.45, bump: 0.27 },
      needles: { color: [0.274, 0.252, 0.179], detail: 0.57, bump: 0.34 },
      grass: { color: [0.335, 0.382, 0.22], detail: 0.62, bump: 0.25, macro: 0.4 },
      'dry-grass': { color: [0.45, 0.414, 0.234], detail: 0.69, bump: 0.27, macro: 0.31 },
    },
    exclusions: [
      {
        kind: 'polygon',
        points: [
          [-514, -515],
          [-490, -515],
          [-490, -487],
          [-514, -487],
        ],
      },
    ],
    detailBudget: 48 * 1024 ** 2,
  });
  await view.ready;

  // Fine tussock shapes in the first few metres, rooted in the same height field as the wider biome.
  const center = [-505, 0, -497],
    area = [38, 44];
  const fine = TerrainHeightmap.attach(engine, (x, z) => world.heightAt(x, z), {
    size: area,
    origin: [center[0] - 19, center[2] - 22],
    resolution: 128,
  });
  const random = rng(9112);
  const heroes = [
    ['granite-a', -507, -495, 0.82, 0.4],
    ['granite-e', -505.2, -499, 0.5, 2.1],
    ['granite-b', -515, -486, 0.7, 4.0],
    ['granite-c', -501.7, -496.7, 0.42, 5.3],
  ];
  const cobbles = [];
  for (let i = 0; i < 85; i++) cobbles.push([-526 + random() * 41, -517 + random() * 43, 0.06 + random() ** 3 * 0.28]);
  // Soil, litter and contact shade on the ground round each stone's foot (TerrainGroundContact, the view's own).
  view.groundContact?.set('hero-stones', [
    ...heroes.flatMap(([, x, z, scale]) => [x, z, 0.8 * scale, 1]),
    ...cobbles.flatMap(([x, z, r]) => [x, z, r, 1]),
  ]);
  // Grass thins toward each stone: none under it, full cover a little way out, where rain shed off the rock and its
  // shade let the sward close again (Scatter clearings).
  const clearings = [
    ...heroes.map(([, x, z, scale]) => ({ center: [x, z], radius: 0.62 * scale, falloff: 0.3 + 0.55 * scale })),
    ...cobbles.map(([x, z, r]) => ({ center: [x, z], radius: 0.7 * r, falloff: 1.6 * r + 0.05 })),
  ];
  const fineBounds = [center[0] - 19, center[2] - 22, center[0] + 19, center[2] + 22];
  // A closed subalpine sward (Festuca and Deschampsia bunchgrass, 60 to 90 percent cover): a short dense undercoat that
  // hides the soil, green tussocks through it, and cured straw from last season standing in the tussocks.
  // Each blade differs in hue, some yellow, tips die back and the low sun glows through them (measured leaf colour and
  // transmittance, GrassShape hue, yellow, tipBrown and transmittance); living leaves have a waxy sheen.
  const grasses = [
    { color: '#5f6a3a', count: 90000, height: 0.2, width: 0.011, radius: 0.09, seed: 113, blades: 12, dry: 0.15, gloss: 0.5 },
    { color: '#737847', count: 12500, height: 0.56, width: 0.016, radius: 0.11, seed: 279, blades: 14, dry: 0.2, gloss: 0.52 },
    { color: '#ac9060', count: 4200, height: 0.7, width: 0.012, radius: 0.13, seed: 721, blades: 10, dry: 0.55, gloss: 0.7 },
  ];
  for (const { color, count, height, width, radius, seed, blades, dry, gloss } of grasses) {
    GrassScatter.attach(engine, {
      center,
      area,
      count,
      seed,
      heightmap: () => fine.texture,
      lod: [8, 19, 59],
      lodFade: 2,
      edgeShrink: 4,
      sink: 0.042,
      scale: [0.53, 1.07],
      wind: [0.76, -0.43, 0.54, 8.8],
      maxSlope: 31,
      material: new PbrMaterial({ color, roughness: gloss, doubleSided: true }),
      blades: { rootShade: 0.56, translucency: 0.56, widen: 0.65 },
      variation: { hue: 0.036, value: 0.29 },
      clearings,
      grass: {
        height,
        width,
        radius,
        blades,
        dry,
        lean: 0.49,
        heightVariance: 0.53,
        segments: [6, 3, 1],
        hue: 0.03,
        yellow: 0.2,
        tipBrown: 0.35,
      },
    });
  }
  // Litter: last season's cured leaves lying in mats between the tussocks and dead flowering stalks standing in them.
  const dead = [
    { count: 9000, seed: 433, grass: { height: 0.32, width: 0.009, blades: 12, radius: 0.13, lean: 0.93, tussock: 0.15 } },
    { count: 2600, seed: 571, grass: { height: 0.45, width: 0.0035, blades: 3, radius: 0.05, lean: 0.14, tussock: 0 } },
  ];
  for (const { count, seed, grass } of dead)
    GrassScatter.attach(engine, {
      center,
      area,
      count,
      seed,
      heightmap: () => fine.texture,
      lod: [8, 19, 59],
      lodFade: 2,
      edgeShrink: 4,
      sink: 0.02,
      scale: [0.6, 1.2],
      wind: [0.76, -0.43, 0.3, 8.8],
      maxSlope: 31,
      clearings,
      clumps: { size: 1.7, cover: 0.48 },
      material: new PbrMaterial({ color: [...SURFACES.dryGrass.color], roughness: 0.75, doubleSided: true }),
      blades: { rootShade: 0.45, translucency: 0.35, widen: 0.65 },
      variation: { hue: 0.02, value: 0.25 },
      grass: { ...grass, dry: 1, tipBrown: 0, yellow: 0, heightVariance: 0.5, segments: [5, 3, 1] },
    });
  // Gravel and small stones through the turf, laid along the slope and half buried: three broken shapes, each a few
  // fracture cells across so they read as angular granite, not river-rounded ovals.
  for (const [k, seed] of [4242, 5171, 6093].entries())
    Scatter.attach(
      engine,
      buildBoulder({ kind: 'boulder', position: [0, 0, 0], radius: 0.12, cliff: 0 }, { seed, cell: 0.05, embed: 0.3 }).geometry,
      {
        center,
        area,
        count: 800,
        seed: 905 + k,
        heightmap: () => fine.texture,
        lod: [9, 20, 45],
        lodFade: 2,
        scale: [0.15, 0.7],
        alignToGround: 0.85,
        sink: 0.012,
        maxSlope: 35,
        clumps: { size: 2.3, cover: 0.42 },
        material: new PbrMaterial({ color: SURFACES.granite.color.map((v) => v * 0.5), roughness: 0.86 }),
        variation: { hue: 0.03, value: 0.3 },
      },
    );
  // Moss and dark crumbs of soil gathered at each boulder's base, thinning outward (inside clearings), so the stones
  // sit in the ground.
  const moss = forb('campion', { heads: 0, seed: 7, scale: 0.42 }).parts[0];
  for (const [i, [, x, z, scale]] of heroes.entries())
    Scatter.attach(engine, moss.rings.map((g) => new Geometry(g.positions, g.normals, g.indices)), {
      center: [x, 0, z],
      area: [3.4 * scale + 1, 3.4 * scale + 1],
      bounds: fineBounds,
      heightmap: () => fine.texture,
      count: 420,
      seed: 61 + i,
      lod: [9, 20, 45],
      lodFade: 2,
      scale: [0.5, 1.3],
      alignToGround: 0.7,
      sink: 0.015,
      clearings: [{ center: [x, z], radius: 0.6 * scale, falloff: 0.55 * scale + 0.25, inside: true }],
      clumps: { size: 0.5, cover: 0.62 },
      material: new PbrMaterial({ color: FORB_COLORS.leaf.map((v) => v * 0.7), roughness: 0.8 }),
      variation: { hue: 0.05, value: 0.35 },
    });

  // Alpine wildflowers over the meadow, each kind in its own drifts (procedural forbs, measured petal colours): American
  // bistort, heartleaf arnica, alpine aster, Parry's gentian and moss campion cushions.
  const fieldBounds = [-650, -585, -410, -345];
  const field = TerrainHeightmap.attach(engine, (x, z) => world.heightAt(x, z), {
    size: [fieldBounds[2] - fieldBounds[0], fieldBounds[3] - fieldBounds[1]],
    origin: [fieldBounds[0], fieldBounds[1]],
    resolution: 768,
  });
  const flowers = [
    ['bistort', 160000, 31, { size: 11, cover: 0.55 }],
    ['arnica', 110000, 32, { size: 7, cover: 0.45 }],
    ['aster', 90000, 33, { size: 6, cover: 0.42 }],
    ['gentian', 60000, 34, { size: 9, cover: 0.4 }],
    ['campion', 40000, 35, { size: 5, cover: 0.38 }],
  ];
  for (const [species, count, seed, clumps] of flowers) {
    // Moss campion in full bloom: twice the species' flowers, so a cushion reads pink.
    const plant = forb(species, { seed, ...(species === 'campion' ? { heads: 220 } : {}) });
    for (const part of plant.parts)
      Scatter.attach(
        engine,
        part.rings.map((g) => new Geometry(g.positions, g.normals, g.indices)),
        {
          center: [(fieldBounds[0] + fieldBounds[2]) / 2, 0, (fieldBounds[1] + fieldBounds[3]) / 2],
          area: [fieldBounds[2] - fieldBounds[0], fieldBounds[3] - fieldBounds[1]],
          bounds: fieldBounds,
          heightmap: () => field.texture,
          count,
          seed,
          clumps,
          clearings,
          minHeight: altitude + 8,
          maxHeight: line + 110,
          maxSlope: 30,
          // The far ring keeps each flower's coloured area to 230 m (procedural forbs), thinning out over the last
          // 80 m one plant at a time, so drifts stay coloured in the middle shots.
          lod: [12, 40, 230],
          lodFade: 2,
          edgeThin: 80,
          scale: [1.1, 1.7],
          sink: 0.01,
          reach: plant.reach,
          sway: { height: plant.top },
          wind: [0.76, -0.43, 0.3, 8.8],
          material: new PbrMaterial({ color: [...part.color], roughness: part.roughness, doubleSided: true }),
          variation: { hue: part.name === 'foliage' ? 0.03 : 0.015, value: 0.18 },
        },
      );
  }

  // Fallen granite: the four large blocks are photographed boulders (treeline-rocks/hero in the asset library, about
  // 11,000 to 27,000 triangles each with their 2k maps); the cobbles around them are closed fracture-cell meshes shaded
  // per pixel as granite with lichen on top.
  const signal = AbortSignal.timeout(30000);
  const boulders = await Promise.all(
    heroes.map(async ([name, x, z, scale, turn]) => {
      const model = await loadGLTF(engine, libraryAsset(`treeline-rocks/hero/${name}.glb`), { signal });
      model.root
        .setPosition([x, world.heightAt(x, z) - 0.22 * scale, z])
        .setRotation([0, turn, 0])
        .setScale([scale, scale, scale]);
      return model;
    }),
  );
  const stoneSurface = RockSurface.attach(engine, {
    moss: 0.45,
    mossColor: [0.27, 0.26, 0.19],
    cracks: 0.45,
    scale: 0.9,
  });
  for (const [i, [x, z, r]] of cobbles.entries()) {
    const block = buildBoulder(
      { kind: 'boulder', position: [x, world.heightAt(x, z), z], radius: r, cliff: 0 },
      { seed: 9112 + i, cell: Math.max(0.02, r / 18), embed: 0.35 },
    );
    const mesh = engine
      .createMesh()
      .setGeometry(block.geometry)
      .setPosition(block.position)
      .setMaterial(new PbrMaterial({ color: '#808080', roughness: 0.9 }));
    stoneSurface.add(mesh, { type: 'granite', seed: i });
  }
  // Contact shade where the boulders, cobbles and tussocks meet the ground and each other (GTAO, Jimenez et al. 2016).
  const occlusion = new GTAO({ radius: 0.7, slices: 2, steps: 6 });
  for (const model of boulders) occlusion.add(model);
  const lens = new DOF({ focalLength: 0.044, focalDistance: 2.1, aperture: 7.1, maxRadius: 8 });
  const cues = [
    [0.2, 4.65, 'Why do the trees stop here?'],
    [15.1, 20.7, 'Wind runs across the meadow.'],
    [33.3, 39.2, 'The forest thins on the exposed slope.'],
    // Over the tree line at 44 to 51 s the stunted firs stand in pockets up the slope (the edge still); from the
    // summit at 79 s they are too far below to see, so its line comes here.
    [44.2, 50.9, 'In sheltered pockets, stunted firs grow higher.'],
    [55.5, 61.5, 'Low trees give way to grass and loose rock.'],
  ];
  return {
    apply(time) {
      const view = camera(time);
      const opening = ramp(time, 64, 80);
      cloudDeck.options.coverage = mix(0.47, 0.38, opening);
      engine.lighting.direction[3] = mix(3.18, 4.45, opening);
      engine.lighting.radiance[1] = mix(0.86, 0.82, opening);
      engine.lighting.radiance[2] = mix(0.67, 0.6, opening);
      lens.options.focalDistance = 2.1 + 480 * ramp(time, 2.8, 16.2);
      lens.options.maxRadius = mix(7.6, 1, ramp(time, 4, 18));
      lens.options.enabled = time < 18;
      return view;
    },
    effects: [occlusion, lens],
    cues,
    dispose() {
      world.dispose();
      stoneSurface.dispose();
      for (const model of boulders) model.dispose?.();
    },
  };
}

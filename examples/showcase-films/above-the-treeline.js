import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { alpineTreelineGraph } from '@margoengine/biomes/treeline';
import { PbrMaterial } from '@margoengine/core';
import { DOF } from '@margoengine/dof';
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

export const ridgeCamera = { ...flight(0), near: 0.11, far: 6100 };
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
  const stone = {
    id: 'talus',
    mesh: 'procedural:rock',
    density: 145,
    radius: 0.3,
    size: { kind: 'reverse-j', q: 1.7, max: 1.32 },
    alignToGround: 0.65,
    sink: 0.26,
    lod: [27, 69, 320],
    color: { hue: 0.02, value: 0.18 },
  };
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
        { ...fir, stands: { scale: 62, cover: 0.86 } },
        { ...youngFir, stands: { scale: 85, cover: 0.76 } },
      ],
      rocks: [{ ...stone, density: 51 }],
      wind: { strength: 0.28, detail: 0.54 },
    }),
    defineBiome({
      id: 'upper-meadow',
      climate: { height: [altitude + 7, line + 123], slope: [null, 32] },
      weight: 1.05,
      ground: [
        { material: 'grass', weight: 1.1 },
        { material: 'dry-grass', moisture: [null, 0.55] },
        { material: 'rock', slope: [27, null], weight: 2.1 },
      ],
      plants: [{ ...scrub, stands: { scale: 52, cover: 0.57 } }],
      rocks: [{ ...stone, density: 84 }],
      wind: { strength: 0.59, detail: 0.62 },
      details: [{ id: 'meadow-bunchgrass', mesh: 'procedural:grass', density: 18, light: [0.44, 1], blades: true }],
    }),
    defineBiome({
      id: 'exposed-scree',
      climate: { height: [line - 48, null] },
      weight: 3.1,
      ground: [
        { material: 'rock', weight: 1.2 },
        { material: 'gravel', slope: [9, 37], weight: 0.42 },
        { material: 'grass', slope: [null, 21], height: [null, line + 38], weight: 1.2 },
      ],
      rocks: [stone],
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
    maxSteps: Infinity,
    lookahead: 0,
    sky,
    shadows,
    water: false,
    meshes: await ridgeTrees(firKey, youngFirKey, timberlineFirKey),
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
  const grasses = [
    { color: '#737847', count: 7900, height: 0.59, width: 0.019, radius: 0.104, seed: 279 },
    { color: '#ac9060', count: 3400, height: 0.72, width: 0.013, radius: 0.142, seed: 721 },
  ];
  for (const { color, count, height, width, radius, seed } of grasses) {
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
      material: new PbrMaterial({ color, roughness: 0.84, doubleSided: true }),
      blades: { rootShade: 0.56, translucency: 0.56, widen: 0.65 },
      variation: { hue: 0.036, value: 0.29 },
      grass: { height, width, radius, blades: 8, lean: 0.49, heightVariance: 0.53, segments: [6, 3, 1] },
    });
  }

  // Fallen granite blocks: closed fracture-cell meshes shaded per pixel as weathered granite with lichen on top.
  const stoneSurface = RockSurface.attach(engine, { moss: 0.45, mossColor: [0.27, 0.26, 0.19], cracks: 0.45, scale: 0.9 });
  const random = rng(9112);
  const rocks = [
    [-507, -495, 1.42],
    [-505.2, -499, 0.54],
    [-515, -486, 1.18],
    [-501.7, -496.7, 0.71],
  ];
  for (let i = 0; i < 85; i++) rocks.push([-526 + random() * 41, -517 + random() * 43, 0.091 + random() ** 3 * 0.65]);
  for (const [i, [x, z, r]] of rocks.entries()) {
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
  const lens = new DOF({ focalLength: 0.044, focalDistance: 2.1, aperture: 7.1, maxRadius: 8 });
  const cues = [
    [0.2, 4.65, 'Why do the trees stop here?'],
    [15.1, 20.7, 'Wind runs across the meadow.'],
    [33.3, 39.2, 'The forest thins on the exposed slope.'],
    [55.5, 61.5, 'Low trees give way to grass and loose rock.'],
    [73.0, 80.8, 'In sheltered pockets, stunted firs grow higher.'],
  ];
  return {
    apply(time) {
      const view = flight(time);
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
    effects: [lens],
    cues,
    dispose() {
      world.dispose();
      stoneSurface.dispose();
    },
  };
}

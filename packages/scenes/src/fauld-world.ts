/// <reference lib="esnext.disposable" preserve="true" />
// Fauld, Staffordshire, the ground shared by `@margoengine/scenes/fauld-countryside` and `/fauld-crater`: the real hills
// from Ordnance Survey OS Terrain 50 (tiles SK12, SK13, SK22, SK23; Open Government Licence v3.0, "Contains OS data
// (c) Crown copyright and database right"), resampled to 5 m, with the 1944 or today crater stamped in from its own
// model; the English lowland farm quilt of @margoengine/biomes/farmland over it (hedged fields, hedge trees, lanes ending
// at junctions, the edge or gates); hedgerows, hedge trees and woods grown by the biome view from library models
// (Blender, Sapling Tree Gen) with Poly Haven bark maps (CC0); fields, lanes, mud and woodland floor from Poly Haven
// ground scans (CC0) at their own repeats; an overcast late-November sky, clouds and weather calibrated to photographs
// of the area; slots for the buildings and cattle that come later (Tripo), drawn as nothing until they exist.
// Layout: x east, z south, y up, metres; the origin is the crater's centre, OS grid SK 18225 27725 (E 418225,
// N 327725). Places from the Fauld reference bible (channel-films Docs/fauld-reference-bible.md): Hanbury's church on its
// hill about 1.2 km west, the crater where Upper Castle Hayes Farm stood, Ford's works and its reservoir down the slope
// to the north, the Dove valley beyond.
import type { EngineKernel, Mesh, Vec3 } from '@margoengine/core';
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import '@margoengine/biomes/splines';
import {
  FARMLAND_MATERIALS,
  FARMLAND_PAINT,
  farmlandEdits,
  layoutFarmland,
  lowlandFarmWorld,
  type Farmland,
} from '@margoengine/biomes/farmland';
import { BiomeView, type BiomeViewOptions, type GroundImage, type MaterialLook } from '@margoengine/biomes/view';
import { DAY_PRESETS } from '@margoengine/sky/day-presets';
import { PresetScene, SCENE_PRESETS } from '@margoengine/sky/scenes';
import { degrees, sunPath } from '@margoengine/sky/sun';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { WeatherMachine, WEATHER_PRESETS, type WeatherState } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { Shadows } from '@margoengine/shadows';
import { GTAO } from '@margoengine/post/gtao';
import { libraryMesh, type LibraryMeshPart } from './library-mesh.js';
import { libraryParts } from './library-parts.js';

/** World size, metres. */
export const FAULD_SIZE = 6400;
/** The world's centre (the crater) on the OS grid, metres. */
export const FAULD_CENTRE = Object.freeze({ easting: 418225, northing: 327725 });
/** Height samples, metres apart. */
export const FAULD_STEP = 5;

/** Places on the ground, `[x, z]` metres from the crater. */
export const FAULD_PLACES = Object.freeze({
  crater: [0, 0] as const,
  farm: [0, 10] as const,
  hanbury: [-1225, -175] as const,
  church: [-1190, -190] as const,
  inn: [-1120, -120] as const,
  works: [120, -780] as const,
  reservoir: [210, -430] as const,
  dove: [-300, -2600] as const,
  tutbury: [3100, -1300] as const,
});

/** Tripo models that come later: where each stands; nothing is drawn until a model is given. */
export const FAULD_SLOTS = Object.freeze({
  church: { at: FAULD_PLACES.church, turn: 0 },
  inn: { at: FAULD_PLACES.inn, turn: 0.3 },
  cottages: { at: [-1260, -90] as const, turn: 0.1 },
  farmhouse: { at: FAULD_PLACES.farm, turn: 0.2 },
  kilnWorks: { at: FAULD_PLACES.works, turn: -0.4 },
  guardHut: { at: [150, 120] as const, turn: 0 },
  cattle: { at: [-160, 220] as const, turn: 0 },
});

/** The era of the ground: the farm before the explosion, the fresh 1944 crater, or the wooded crater today. */
export type FauldEra = 'before' | '1944' | 'today';
/** Sky and weather of a shot. */
export type FauldSky = 'dawn' | 'lowSun' | 'overcast' | 'grey' | 'dusk' | 'night' | 'snow' | 'rain' | 'mist';

/** Settings shared by both places. */
export interface FauldWorldSettings {
  readonly era?: FauldEra;
  readonly sky?: FauldSky;
  /** Local solar time, hours. Default by `sky`. */
  readonly hour?: number;
  /** The shot's subject, `[x, z]` metres (kept for the shot files; the view draws round the camera). Default the crater. */
  readonly focus?: readonly [number, number];
  /** How far round the camera the view grows plants (hedges, trees, woods), metres, 200 to 3,000. Default 2,500. */
  readonly radius?: number;
  /** URL of the height grid (`fauld_sk12_sk23.f32` with its `.json` beside it). Default under `library`. */
  readonly dem?: string;
  /** URL of the asset library root. Default `/asset-library/`. */
  readonly library?: string;
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

/** The world handle. */
export interface FauldWorld extends Disposable {
  readonly era: FauldEra;
  readonly world: BiomeWorld;
  readonly farm: Farmland;
  readonly view: BiomeView;
  readonly preset: PresetScene;
  readonly clouds: VolumetricClouds;
  readonly weather: WeatherMachine;
  readonly shadows: Shadows;
  readonly meshes: readonly Mesh[];
  height(x: number, z: number): number;
  /** Puts the camera at a position looking at a target (field of view in degrees). */
  look(position: Vec3, target: Vec3, fov?: number): void;
  advanceTime(seconds: number): void;
  settle(): Promise<void>;
  dispose(): void;
}

// Late November at Fauld (52.84 N), calibrated to photographs of the area (channel-films References/fauld/places):
// mostly overcast, cool grey-green, low contrast, visibility about 8 to 15 km, morning mist in the Dove valley. Fog is
// the weather's thickness (0.0002 x 100^fog per metre): 0.12 is about 11 km, 0.25 about 6 km, 0.4 about 3 km.
const SKY: Readonly<
  Record<
    FauldSky,
    {
      hour: number;
      weather: Partial<WeatherState>;
      preset: 'dawn' | 'goldenHour' | 'noon' | 'overcast';
      clouds: 'stratus' | 'cumulus';
    }
  >
> = {
  dawn: {
    hour: 8.7,
    weather: { cloud: 0.85, fog: 0.25, humidity: 0.92, temperature: -1, wind: 1.5 },
    preset: 'overcast',
    clouds: 'stratus',
  },
  lowSun: {
    hour: 11.5,
    weather: { cloud: 0.6, fog: 0.12, humidity: 0.75, temperature: 4, wind: 3 },
    preset: 'noon',
    clouds: 'cumulus',
  },
  overcast: {
    hour: 11.2,
    weather: { ...WEATHER_PRESETS.overcast, cloud: 0.9, fog: 0.14, temperature: 5 },
    preset: 'overcast',
    clouds: 'stratus',
  },
  grey: {
    hour: 12.5,
    weather: { ...WEATHER_PRESETS.overcast, cloud: 0.95, fog: 0.22, temperature: 4 },
    preset: 'overcast',
    clouds: 'stratus',
  },
  dusk: {
    hour: 15.9,
    weather: { cloud: 0.7, fog: 0.18, humidity: 0.85, temperature: 1, wind: 2 },
    preset: 'goldenHour',
    clouds: 'stratus',
  },
  night: {
    hour: 19,
    weather: { cloud: 0.8, fog: 0.2, humidity: 0.9, temperature: 0, wind: 1 },
    preset: 'overcast',
    clouds: 'stratus',
  },
  snow: { hour: 12, weather: { ...WEATHER_PRESETS.snow }, preset: 'overcast', clouds: 'stratus' },
  rain: { hour: 12, weather: { ...WEATHER_PRESETS.rain, wind: 5 }, preset: 'overcast', clouds: 'stratus' },
  mist: { hour: 8.6, weather: { ...WEATHER_PRESETS.fog, fog: 0.4 }, preset: 'overcast', clouds: 'stratus' },
};

/** Hedge shrubs and hedge trees by library file. */
const MODELS: Readonly<Record<string, string>> = {
  oak: 'trees/oak',
  ash: 'trees/ash',
  birch: 'trees/birch',
  holly: 'trees/holly',
  hazel: 'hedges/hawthorn_b',
  hawthorn: 'hedges/hawthorn_a',
  blackthorn: 'hedges/blackthorn_a',
};

/** Ground scans (Poly Haven, CC0) under `margo-library/fauld/ground/`, the repeat in metres and the winter colour. */
const GROUND: Readonly<Record<string, { file: string; repeat: number; color: readonly [number, number, number] }>> = {
  'winter-pasture': { file: 'grass_ground', repeat: 3, color: [0.3, 0.38, 0.19] },
  'rough-meadow': { file: 'sparse_grass', repeat: 3, color: [0.36, 0.36, 0.22] },
  plough: { file: 'brown_mud_dry', repeat: 2.5, color: [0.36, 0.25, 0.18] },
  stubble: { file: 'withered_grass', repeat: 2.5, color: [0.55, 0.48, 0.33] },
  'lane-gravel': { file: 'gravel_road', repeat: 3, color: [0.42, 0.37, 0.31] },
  mud: { file: 'mud_forest', repeat: 2.5, color: [0.27, 0.21, 0.15] },
  'leaf-litter': { file: 'leaves_forest_ground', repeat: 2.5, color: [0.34, 0.26, 0.18] },
  moss: { file: 'forest_leaves_02', repeat: 2.5, color: [0.27, 0.29, 0.16] },
  'crater-marl': { file: 'brown_mud_dry', repeat: 3, color: [0.55, 0.5, 0.44] },
};

/** A ground scan decoded to 1,024 texels a side (the view's layer size). */
async function groundImage(url: string, signal?: AbortSignal): Promise<GroundImage> {
  const blob = await (await fetch(url, signal ? { signal } : {})).blob(),
    size = 1024,
    bitmap = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' }),
    canvas = new OffscreenCanvas(size, size),
    context = canvas.getContext('2d');
  if (!context) throw new Error('fauld: no 2D canvas to decode the ground scans');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: size, height: size, data: context.getImageData(0, 0, size, size).data };
}

const join = (root: string, path: string) => (root.endsWith('/') ? root : root + '/') + path;

/** The OS Terrain 50 grid: float32 metres, row 0 the northmost (see its .json). */
async function loadDem(url: string, signal?: AbortSignal) {
  const meta = (await (await fetch(url.replace(/\.f32$/, '.json'), signal ? { signal } : {})).json()) as {
      width: number;
      depth: number;
      cellsize_m: number;
      xll_easting: number;
      ytop_northing: number;
    },
    bytes = await (await fetch(url, signal ? { signal } : {})).arrayBuffer(),
    data = new Float32Array(bytes);
  if (data.length !== meta.width * meta.depth)
    throw new RangeError(
      `fauld: ${url} holds ${data.length} heights, not ${meta.width} x ${meta.depth}; regenerate the grid and its .json together.`,
    );
  // Height at OS (easting, northing), bilinear between sample centres.
  return (e: number, n: number) => {
    const fx = (e - meta.xll_easting - meta.cellsize_m / 2) / meta.cellsize_m,
      fz = (meta.ytop_northing - meta.cellsize_m / 2 - n) / meta.cellsize_m,
      i = Math.max(0, Math.min(meta.width - 2, Math.floor(fx))),
      j = Math.max(0, Math.min(meta.depth - 2, Math.floor(fz))),
      u = Math.max(0, Math.min(1, fx - i)),
      v = Math.max(0, Math.min(1, fz - j)),
      at = (a: number, b: number) => data[b * meta.width + a];
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

/** A crater model's heights binned on a 2 m grid (the highest vertex in each bin), centred on the origin. */
function craterHeights(part: LibraryMeshPart): { at(x: number, z: number): number | undefined; half: number } {
  const p = part.geometry.positions,
    half = 260,
    bin = 2,
    n = (2 * half) / bin + 1,
    grid = new Float32Array(n * n).fill(Number.NaN);
  for (let i = 0; i < p.length; i += 3) {
    const a = Math.round((p[i] + half) / bin),
      b = Math.round((p[i + 2] + half) / bin);
    if (a < 0 || b < 0 || a >= n || b >= n) continue;
    const k = b * n + a;
    if (!(grid[k] >= p[i + 1])) grid[k] = p[i + 1];
  }
  return {
    half,
    at(x, z) {
      const a = Math.round((x + half) / bin),
        b = Math.round((z + half) / bin);
      if (a < 0 || b < 0 || a >= n || b >= n) return undefined;
      const v = grid[b * n + a];
      return Number.isNaN(v) ? undefined : v;
    },
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The 1944 crater's bare marl and gypsum (painted over the bowl and its lip; no plants). */
const CRATER_SPOIL = defineBiome({
  id: 'crater-spoil',
  climate: { height: [100000, null] },
  ground: [{ material: 'crater-marl' }, { material: 'mud', moisture: [0.85, null] }],
});

/** Builds the shared Fauld ground, farmland, sky and weather into `engine`. */
export async function attachFauldWorld(engine: EngineKernel, settings: FauldWorldSettings = {}): Promise<FauldWorld> {
  const era = settings.era ?? 'before',
    skyName = settings.sky ?? 'lowSun',
    sky = SKY[skyName],
    seed = settings.seed ?? 1944,
    library = settings.library ?? '/asset-library/',
    radius = settings.radius ?? 2500,
    signal = settings.signal,
    disposers: (() => void)[] = [],
    meshes: Mesh[] = [];
  if (!SKY[skyName]) throw new RangeError(`fauld: unknown sky ${skyName}; pass one of ${Object.keys(SKY).join(', ')}.`);
  if (!['before', '1944', 'today'].includes(era))
    throw new RangeError(`fauld: unknown era ${era}; pass 'before', '1944' or 'today'.`);
  if (!(radius >= 200 && radius <= 3000))
    throw new RangeError(`fauld: radius ${radius} is outside 200 to 3,000 metres.`);
  try {
    const demAt = await loadDem(settings.dem ?? join(library, 'dem/os-terrain-50/fauld_sk12_sk23.f32'), signal),
      // The crater model gives only its heights (the terrain draws the crater, textured like the ground round it).
      crater =
        era === 'before'
          ? undefined
          : await libraryMesh(
              join(library, `margo-library/fauld/crater/crater_inner_${era === '1944' ? '1944' : 'today'}.gltf`),
              {
                kind: 'stone',
                color: [0.5, 0.5, 0.5],
                maxTriangles: 600000,
                ...(signal ? { signal } : {}),
              },
            ),
      bowl = crater ? craterHeights(crater) : undefined;
    // The rim height the crater model's edge meets: the ground's mean round a 250 m circle.
    let rim = 0;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * 2 * Math.PI;
      rim += demAt(FAULD_CENTRE.easting + 250 * Math.cos(a), FAULD_CENTRE.northing - 250 * Math.sin(a)) / 32;
    }
    const lift = bowl ? rim - 44.9 : 0,
      n = FAULD_SIZE / FAULD_STEP + 1,
      samples = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = -FAULD_SIZE / 2 + i * FAULD_STEP,
          z = -FAULD_SIZE / 2 + j * FAULD_STEP;
        let h = demAt(FAULD_CENTRE.easting + x, FAULD_CENTRE.northing - z);
        if (bowl) {
          const c = bowl.at(x, z),
            w = 1 - smooth(150, 200, Math.hypot(x, z));
          // The crater's own heights inside, easing into the real ground from 150 to 200 m out (no mesh edge, no band).
          if (c !== undefined) h = h * (1 - w) + (c + lift) * w;
        }
        samples[j * n + i] = h;
      }
    const world = await BiomeWorld.create({
      seed,
      origin: [-FAULD_SIZE / 2, -FAULD_SIZE / 2],
      size: [FAULD_SIZE, FAULD_SIZE],
      climate: lowlandFarmWorld.climate,
      height: { samples, width: n, depth: n, unit: 'm' },
      biomes: [...lowlandFarmWorld.biomes, CRATER_SPOIL],
      paint: [...FARMLAND_PAINT, { biome: CRATER_SPOIL.id }],
      ...(signal ? { signal } : {}),
    });
    disposers.push(() => world.dispose());
    const ring = (c: readonly [number, number], r: number, k = 24) =>
        Array.from(
          { length: k },
          (_, i) =>
            [c[0] + r * Math.cos((i / k) * 2 * Math.PI), c[1] + r * Math.sin((i / k) * 2 * Math.PI)] as [
              number,
              number,
            ],
        ),
      keep = [
        ring(FAULD_PLACES.hanbury, 260),
        ring(FAULD_PLACES.works, 110),
        ring(FAULD_PLACES.reservoir, 70),
        era === 'before' ? ring(FAULD_PLACES.farm, 45) : ring(FAULD_PLACES.crater, 230),
      ],
      E = FAULD_SIZE / 2,
      farm = layoutFarmland(world, {
        seed,
        fieldSize: 42000,
        keep,
        connect: [
          [-E, 260],
          FAULD_PLACES.hanbury,
          era === 'before' ? FAULD_PLACES.farm : [0, 260],
          FAULD_PLACES.works,
          [E, -900],
          [-420, -E],
          [-900, E],
        ],
      }),
      editor = BiomeEditor.attach(world);
    for (const edit of farmlandEdits(farm, {}, [
      ring([380, -620], 230),
      ...(era === 'today' ? [ring(FAULD_PLACES.crater, 200)] : []),
    ]))
      editor.apply(edit);
    // The fresh crater: bare marl and gypsum thrown out over its bowl and lip (about 230 m across in the RAF survey).
    if (era === '1944') editor.polygon(CRATER_SPOIL.id, ring(FAULD_PLACES.crater, 175, 48));
    const sun = sunPath({ latitude: degrees(52.84), dayOfYear: 332, hour: settings.hour ?? sky.hour }),
      preset = PresetScene.attach(engine, {
        ...SCENE_PRESETS[sky.preset],
        day: {
          ...DAY_PRESETS[sky.preset === 'dawn' ? 'overcast' : sky.preset],
          azimuth: sun.azimuth.degrees,
          elevation: Math.max(skyName === 'night' ? -12 : 1, sun.elevation.degrees),
        },
        fog:
          3.912 /
          (skyName === 'mist' ? 2500 : skyName === 'grey' || skyName === 'rain' || skyName === 'snow' ? 6000 : 16000),
      });
    disposers.push(() => preset.dispose());
    preset.post.addEffect(new GTAO({ radius: 2, slices: 3, steps: 8 }), 0);
    const shadows = Shadows.attach(engine, {
      resolution: 4096,
      distance: 1200,
      lambda: 0.8,
      lightSize: 0.02,
      normalBias: 0.2,
      casterMargin: 300,
    });
    disposers.push(() => shadows.dispose());
    // Woods, hedgerows and hedge trees: the biomes' species from the library models with their bark maps.
    const registry: Record<string, NonNullable<BiomeViewOptions['meshes']>[string]> = {};
    for (const [key, file] of Object.entries(MODELS))
      registry[`library:${key}`] = await libraryParts(join(library, `margo-library/fauld/${file}.gltf`), {
        maxTriangles: 250000,
        kind: 'bark',
        ...(signal ? { signal } : {}),
      });
    // Bracken dead and brown by late November (the fern's own colour only, never its green summer fronds).
    registry['library:fern'] = [
      {
        geometry: (
          await libraryMesh(join(library, 'big-burn-1910/plants/fern_02/fern_02_2k.gltf'), {
            kind: 'foliage',
            color: [0.2, 0.12, 0.06],
            maxTriangles: 60000,
            ...(signal ? { signal } : {}),
          })
        ).geometry,
        color: [0.2, 0.12, 0.06],
        kind: 'foliage',
      },
    ];
    const materials: Record<string, MaterialLook> = { ...FARMLAND_MATERIALS };
    for (const [key, g] of Object.entries(GROUND))
      materials[key] = {
        ...(FARMLAND_MATERIALS[key] ?? { detail: 0.4, bump: 0.4, macro: 0.35 }),
        color: g.color,
        image: await groundImage(join(library, `margo-library/fauld/ground/${g.file}_diff_2k.jpg`), signal),
        repeat: g.repeat,
      };
    const view = await BiomeView.attach(engine, world, {
      sky: preset.sky,
      shadows,
      materials,
      exclusions: [
        ...farm.exclusions,
        ...(era === '1944' ? [{ kind: 'polygon' as const, points: ring(FAULD_PLACES.crater, 205) }] : []),
      ],
      radius,
      meshes: registry,
      ...(signal ? { signal } : {}),
    });
    disposers.push(() => view.dispose());
    const height = (x: number, z: number) => {
      const g = world.heightAt(x, z),
        c = bowl && Math.hypot(x, z) < 150 ? bowl.at(x, z) : undefined;
      // Inside the crater the model's finer heights (a camera or prop never sits under a slump the terrain smooths).
      return c === undefined ? g : Math.max(g, c + lift);
    };
    const clouds = VolumetricClouds.attach(engine, {
      sky: preset.sky as never,
      type: sky.clouds,
      coverage: Math.min(0.95, (sky.weather.cloud ?? 0.4) + 0.05),
    });
    disposers.push(() => clouds.dispose());
    const weather = new WeatherMachine(
      { ...WEATHER_PRESETS.clear, ...sky.weather, windDirection: 0.6 } as WeatherState,
      { seed },
    );
    disposers.push(() => weather.dispose());
    const drive = WeatherDrive.attach(engine, { weather, listener: engine.camera, clouds });
    disposers.push(() => drive.dispose?.());
    const handle: FauldWorld = {
      era,
      world,
      farm,
      view,
      preset,
      clouds,
      weather,
      shadows,
      meshes,
      height,
      look(position, target, fov = 45) {
        engine.camera.position = [...position] as Vec3;
        engine.camera.target = [...target] as Vec3;
        engine.camera.fov = fov;
      },
      advanceTime(seconds) {
        drive.advanceTime(seconds);
        preset.sky.advanceTime?.(seconds);
      },
      settle: () => view.whenIdle(),
      dispose() {
        for (const d of disposers.reverse()) d();
        disposers.length = 0;
        for (const m of meshes) m.dispose?.();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    return handle;
  } catch (error) {
    for (const d of disposers.reverse()) d();
    throw error;
  }
}

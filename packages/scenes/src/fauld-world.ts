/// <reference lib="esnext.disposable" preserve="true" />
// Fauld, Staffordshire, the ground shared by `@margoengine/scenes/fauld-countryside` and `/fauld-crater`: the real hills
// from Ordnance Survey OS Terrain 50 (tiles SK12, SK13, SK22, SK23; Open Government Licence v3.0, "Contains OS data
// (c) Crown copyright and database right"), resampled to 5 m, with the 1944 or today crater stamped in from its own
// model; the English lowland farm quilt of @margoengine/biomes/farmland over it (hedged fields, hedge trees, lanes ending
// at junctions, the edge or gates); hedges and hedge trees drawn from library models (Blender, Sapling Tree Gen) as
// instances round the shot's focus; woods of the same models through the biome mesh registry; a winter sky, clouds and
// weather; slots for the buildings and cattle that come later (Tripo), drawn as nothing until they exist.
// Layout: x east, z south, y up, metres; the origin is the crater's centre, OS grid SK 18225 27725 (E 418225,
// N 327725). Places from the Fauld reference bible (channel-films Docs/fauld-reference-bible.md): Hanbury's church on its
// hill about 1.2 km west, the crater where Upper Castle Hayes Farm stood, Ford's works and its reservoir down the slope
// to the north, the Dove valley beyond.
import { PbrMaterial, type EngineKernel, type Mesh, type Vec3 } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { BiomeWorld } from '@margoengine/biomes';
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
import { BiomeView, type BiomeViewOptions } from '@margoengine/biomes/view';
import { ScatterInstances, type ScatterBatch } from '@margoengine/scatter';
import { pbrVertexStream } from '@margoengine/geometry';
import { DAY_PRESETS } from '@margoengine/sky/day-presets';
import { PresetScene, SCENE_PRESETS } from '@margoengine/sky/scenes';
import { degrees, sunPath } from '@margoengine/sky/sun';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { WeatherMachine, WEATHER_PRESETS, type WeatherState } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { Shadows } from '@margoengine/shadows';
import { GTAO } from '@margoengine/post/gtao';
import { libraryMesh, type LibraryMeshPart } from './library-mesh.js';

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
  /** Where hedges and hedge trees are drawn round, `[x, z]` metres. Default the crater. */
  readonly focus?: readonly [number, number];
  /** Radius of hedges and hedge trees round the focus, metres, 200 to 3,000. Default 1,200. */
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

const SKY: Readonly<
  Record<
    FauldSky,
    { hour: number; weather: Partial<WeatherState>; preset: 'dawn' | 'goldenHour' | 'noon' | 'overcast' }
  >
> = {
  dawn: { hour: 8.3, weather: { cloud: 0.35, fog: 0.06, humidity: 0.9, temperature: -2, wind: 1.5 }, preset: 'dawn' },
  lowSun: { hour: 11.5, weather: { cloud: 0.3, humidity: 0.7, temperature: 3, wind: 3 }, preset: 'goldenHour' },
  overcast: { hour: 11.2, weather: { ...WEATHER_PRESETS.overcast, fog: 0.04, temperature: 4 }, preset: 'overcast' },
  grey: { hour: 12.5, weather: { ...WEATHER_PRESETS.overcast, fog: 0.1, temperature: 4 }, preset: 'overcast' },
  dusk: {
    hour: 15.9,
    weather: { cloud: 0.5, fog: 0.06, humidity: 0.85, temperature: 1, wind: 2 },
    preset: 'goldenHour',
  },
  night: { hour: 19, weather: { cloud: 0.8, fog: 0.1, humidity: 0.9, temperature: 0, wind: 1 }, preset: 'overcast' },
  snow: { hour: 12, weather: { ...WEATHER_PRESETS.snow }, preset: 'overcast' },
  rain: { hour: 12, weather: { ...WEATHER_PRESETS.rain, wind: 5 }, preset: 'overcast' },
  mist: { hour: 8.4, weather: { ...WEATHER_PRESETS.fog, fog: 0.3 }, preset: 'dawn' },
};

/** Hedge shrubs and hedge trees by library file. */
const MODELS = {
  hedge: ['hawthorn_a', 'hawthorn_b', 'blackthorn_a'],
  oak: 'oak',
  ash: 'ash',
  birch: 'birch',
  holly: 'holly',
} as const;

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
    throw new RangeError(`fauld: ${url} holds ${data.length} heights, not ${meta.width} x ${meta.depth}; regenerate the grid and its .json together.`);
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

/** Builds the shared Fauld ground, farmland, sky and weather into `engine`. */
export async function attachFauldWorld(engine: EngineKernel, settings: FauldWorldSettings = {}): Promise<FauldWorld> {
  const era = settings.era ?? 'before',
    skyName = settings.sky ?? 'lowSun',
    sky = SKY[skyName],
    seed = settings.seed ?? 1944,
    library = settings.library ?? '/asset-library/',
    radius = settings.radius ?? 1200,
    focus = settings.focus ?? [0, 0],
    signal = settings.signal,
    disposers: (() => void)[] = [],
    meshes: Mesh[] = [];
  if (!SKY[skyName]) throw new RangeError(`fauld: unknown sky ${skyName}; pass one of ${Object.keys(SKY).join(', ')}.`);
  if (!['before', '1944', 'today'].includes(era)) throw new RangeError(`fauld: unknown era ${era}; pass 'before', '1944' or 'today'.`);
  try {
    const demAt = await loadDem(settings.dem ?? join(library, 'dem/os-terrain-50/fauld_sk12_sk23.f32'), signal),
      fetchPart = (file: string, maxTriangles = 250000) =>
        libraryMesh(join(library, file), { kind: 'bark', maxTriangles, ...(signal ? { signal } : {}) }),
      crater =
        era === 'before'
          ? undefined
          : await fetchPart(
              `margo-library/fauld/crater/crater_inner_${era === '1944' ? '1944' : 'today'}.gltf`,
              600000,
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
          // Inside, the ground sits 1.5 m under the model (the model draws the crater's detail); at the edge it meets
          // the real ground.
          if (c !== undefined) h = h * (1 - w) + (c + lift - 1.5) * w;
        }
        samples[j * n + i] = h;
      }
    const world = await BiomeWorld.create({
      seed,
      origin: [-FAULD_SIZE / 2, -FAULD_SIZE / 2],
      size: [FAULD_SIZE, FAULD_SIZE],
      climate: lowlandFarmWorld.climate,
      height: { samples, width: n, depth: n, unit: 'm' },
      biomes: lowlandFarmWorld.biomes,
      paint: FARMLAND_PAINT,
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
    const sun = sunPath({ latitude: degrees(52.84), dayOfYear: 332, hour: settings.hour ?? sky.hour }),
      preset = PresetScene.attach(engine, {
        ...SCENE_PRESETS[sky.preset],
        day: {
          ...(sky.preset === 'overcast' ? DAY_PRESETS.noon : DAY_PRESETS.goldenHour),
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
    // Woods: the farm-wood biome's species drawn from the library models (never the procedural stand-ins).
    const parts: Record<string, LibraryMeshPart> = {};
    for (const [key, file] of [
      ['oak', MODELS.oak],
      ['ash', MODELS.ash],
      ['birch', MODELS.birch],
      ['holly', MODELS.holly],
      ['hazel', MODELS.hedge[0]],
    ] as const)
      parts[key] = await fetchPart(`margo-library/fauld/${key === 'hazel' ? 'hedges' : 'trees'}/${file}.gltf`);
    const tint: Record<string, readonly [number, number, number]> = {
      oak: [0.11, 0.09, 0.075],
      ash: [0.2, 0.19, 0.17],
      birch: [0.6, 0.58, 0.55],
      holly: [0.03, 0.07, 0.03],
      hazel: [0.13, 0.1, 0.08],
    };
    const registry = Object.fromEntries(
      Object.entries(parts).map(([k, p]) => [
        `library:${k}`,
        [{ geometry: p.geometry, color: tint[k], kind: k === 'holly' ? 'foliage' : 'bark' }],
      ]),
    ) as Record<string, NonNullable<BiomeViewOptions['meshes']>[string]>;
    registry['library:fern'] = [
      {
        geometry: (await fetchPart('blender-library/big-burn-1910/plants/fern_02/fern_02_2k.gltf', 60000)).geometry,
        color: [0.16, 0.13, 0.07],
        kind: 'foliage',
      },
    ];
    const view = await BiomeView.attach(engine, world, {
      sky: preset.sky,
      shadows,
      materials: FARMLAND_MATERIALS,
      exclusions: [
        ...farm.exclusions,
        ...(era === '1944' ? [{ kind: 'polygon' as const, points: ring(FAULD_PLACES.crater, 205) }] : []),
      ],
      radius: 2000,
      meshes: registry,
      ...(signal ? { signal } : {}),
    });
    disposers.push(() => view.dispose());
    const height = (x: number, z: number) => {
      const g = world.heightAt(x, z),
        c = bowl && Math.hypot(x, z) < 150 ? bowl.at(x, z) : undefined;
      return c === undefined ? g : Math.max(g, c + lift);
    };
    // The crater model, lifted onto the ground and blended into it at its square edge.
    if (crater && bowl) {
      const p = crater.geometry.positions.slice();
      for (let i = 0; i < p.length; i += 3) {
        const w = smooth(150, 200, Math.hypot(p[i], p[i + 2]));
        p[i + 1] = (p[i + 1] + lift) * (1 - w) + (height(p[i], p[i + 2]) + 0.05) * w;
      }
      const src = crater.geometry.indices,
        keepTri: number[] = [];
      for (let t = 0; t < src.length; t += 3)
        if ([src[t], src[t + 1], src[t + 2]].every((v) => Math.hypot(p[v * 3], p[v * 3 + 2]) < 205))
          keepTri.push(src[t], src[t + 1], src[t + 2]);
      const indices = new Uint32Array(keepTri),
        uvs = new Float32Array((p.length / 3) * 2),
        mesh = engine
          .createMesh()
          .setGeometry(toGeometry({ positions: p, normals: crater.geometry.normals, uvs, indices }))
          .setMaterial(
            new PbrMaterial({ color: era === '1944' ? [0.36, 0.33, 0.29] : [0.2, 0.18, 0.12], roughness: 0.95 }),
          );
      mesh.name = 'fauld-crater';
      meshes.push(mesh);
      shadows.add(mesh, { static: true });
    }
    // Hedges and hedge trees round the focus, as instances of the library models.
    const near = (p: readonly [number, number]) => Math.hypot(p[0] - focus[0], p[1] - focus[1]) < radius,
      shrubs = await Promise.all(MODELS.hedge.map((m) => fetchPart(`margo-library/fauld/hedges/${m}.gltf`))),
      stream = (part: LibraryMeshPart) => {
        const count = part.geometry.positions.length / 3,
          tangents = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) tangents[i * 4] = tangents[i * 4 + 3] = 1;
        return pbrVertexStream({
          positions: part.geometry.positions,
          normals: part.geometry.normals,
          uvs: new Float32Array(count * 2),
          tangents,
          indices: part.geometry.indices,
        } as never);
      },
      matrix = (x: number, z: number, turn: number, s: number, sy = s): number[] => {
        const c = Math.cos(turn),
          sn = Math.sin(turn);
        return [c * s, 0, -sn * s, 0, 0, sy, 0, 0, sn * s, 0, c * s, 0, x, height(x, z) - 0.15, z, 1];
      },
      shrubAt: number[][][] = shrubs.map(() => []),
      treeAt: Record<string, number[][]> = { oak: [], ash: [], holly: [] };
    let k = 0;
    for (const h of farm.hedges)
      for (let i = 1; i < h.points.length; i++) {
        const [ax, az] = h.points[i - 1],
          [bx, bz] = h.points[i],
          l = Math.hypot(bx - ax, bz - az);
        if (!near([ax, az]) && !near([bx, bz])) continue;
        for (let s = 0; s < l; s += 2.6) {
          const x = ax + ((bx - ax) * s) / l,
            z = az + ((bz - az) * s) / l;
          k++;
          shrubAt[k % shrubs.length].push(
            matrix(x, z, (k * 2.399) % (2 * Math.PI), 0.9 + ((k * 37) % 11) / 30, h.height / 2.6),
          );
        }
      }
    for (const t of farm.trees)
      if (near(t.at))
        treeAt[t.species].push(
          matrix(t.at[0], t.at[1], t.turn, t.height / (t.species === 'oak' ? 17 : t.species === 'ash' ? 15 : 6.5)),
        );
    const bark = (c: readonly [number, number, number]) =>
        new PbrMaterial({ color: [c[0], c[1], c[2]], roughness: 0.92 }),
      batches = (): ScatterBatch[] =>
        [
          ...shrubs.map((p, i) => ({
            name: `fauld-hedge-${i}`,
            vertices: stream(p),
            indices: p.geometry.indices,
            transforms: new Float32Array(shrubAt[i].flat()),
            material: bark(i === 2 ? [0.06, 0.05, 0.05] : [0.13, 0.1, 0.08]),
            wind: [1, 0, 0.15] as [number, number, number],
          })),
          ...(['oak', 'ash', 'holly'] as const).map((sp) => ({
            name: `fauld-hedge-${sp}`,
            vertices: stream(parts[sp]),
            indices: parts[sp].geometry.indices,
            transforms: new Float32Array(treeAt[sp].flat()),
            material: bark(tint[sp]),
            wind: [1, 0, 0.08] as [number, number, number],
          })),
        ].filter((b) => b.transforms.length > 0) as ScatterBatch[];
    const instances = ScatterInstances.attach(engine, batches);
    shadows.add(instances as never, { static: true });
    disposers.push(() => instances.dispose());
    const clouds = VolumetricClouds.attach(engine, {
      sky: preset.sky as never,
      type: sky.preset === 'overcast' ? 'stratus' : 'cumulus',
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

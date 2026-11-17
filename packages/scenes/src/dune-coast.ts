// Dune coast: a winter barrier-island coast in one call, built from the engine's packages at their best settings. The
// default is Kill Devil Hills, North Carolina, on 17 December 1903 at 10:35, the morning of the first powered flight:
// a bare sand flat, low hummocks with sparse grass, the big dune to the south, the camp's two board sheds, the 60 ft
// launch rail, the foredune and the winter Atlantic surf to the east, under a grey sky with a north wind.
// Layout (Library of Congress Wright Brothers negatives LC-W86-15, -21, -35, -38, LC-W85-110 and LC-W86-120, public
// domain; USGS 3DEP 1 m bare-earth heights for the distances between hill, flat and shore): x east, z south, y up,
// metres, sea level at y = 0, the rail's south end at x = 0, z = 0.
import { PbrMaterial, type EngineKernel, type Mesh, type Vec3 } from '@margoengine/core';
import { applyMatrix4, toGeometry, type GeometryData } from '@margoengine/geometry';
import { Noise } from '@margoengine/procedural/noise';
import { generateLaunchRail, generatePlankShed } from '@margoengine/procedural/sheds';
import { weatheredWood } from '@margoengine/materials/presets';
import { heightfieldGeometry, TerrainColors, TerrainHeightmap } from '@margoengine/terrain';
import { duneField, duneHill } from '@margoengine/terrain/dunes';
import { DAY_PRESETS } from '@margoengine/sky/day-presets';
import { PresetScene, SCENE_PRESETS } from '@margoengine/sky/scenes';
import { degrees, sunPath } from '@margoengine/sky/sun';
import { Water, type Wave } from '@margoengine/water';
import { GrassScatter } from '@margoengine/scatter/grass';
import { Shadows } from '@margoengine/shadows';
import { GTAO } from '@margoengine/post/gtao';
import type { BlownSand, BlownSandOptions } from '@margoengine/vfx/blown-sand';
import { duneCoastInfo } from './dune-coast-info.js';

/** Heights to build the ground from, such as a USGS 3DEP bare-earth grid: metres, row by row along x (east). */
export interface DuneCoastHeights {
  readonly samples: Float32Array;
  readonly width: number;
  readonly depth: number;
  /** Metres between samples. Default 1. */
  readonly cellSize?: number;
  /** World x and z of the first sample (its north-west corner). Default: the grid centred on the rail. */
  readonly origin?: readonly [number, number];
  /** Heights at or below this are sea and are lowered under the water (3DEP reads the sea as 0). Default 0.05. */
  readonly sea?: number;
}

/** Settings of {@link attach}. Every one has a default; the defaults are 17 December 1903 at Kill Devil Hills. */
export interface DuneCoastSettings {
  /** Calendar date, `YYYY-MM-DD`. Default `1903-12-17`. */
  readonly date?: string;
  /** Local solar time, hours. Default 10.6 (10:35 eastern time at 75.67 W). */
  readonly hour?: number;
  /** Latitude, degrees north. Default 36.02. */
  readonly latitude?: number;
  /** `overcast` (the photographs' grey sky, diffuse light) or `clear` (sun and broken cloud). Default `overcast`. */
  readonly weather?: 'overcast' | 'clear';
  /** Distance at which the air hides 98 percent of the far view, metres, 500 to 50,000. Default 6,000 (sea haze). */
  readonly visibility?: number;
  /** Wind speed, m/s, 0 to 25. Default 11 (the 1903 morning: 20 to 27 mph from the north). */
  readonly wind?: number;
  /** Compass direction the wind blows FROM, degrees (0 north, 90 east). Default 0. */
  readonly windFrom?: number;
  /** Dry sand albedo, linear RGB. Default [0.52, 0.46, 0.35]: pale quartz sand with shell. */
  readonly sand?: Vec3;
  /** Share of the ground in dune grass patches, most on the hummocks, 0 (none) to 1. Default 0.5 (see `grassCover`). */
  readonly grass?: number;
  /** Albedo of the dune grass, linear RGB 0 to 1. Default [0.36, 0.31, 0.16]: winter straw with olive bases. */
  readonly grassColor?: Vec3;
  /** Tallest dune grass leaf, metres, 0.2 to 2. Default 0.8 (winter Ammophila, 0.4 to 0.9 m). */
  readonly grassHeight?: number;
  /** Leaves to a grass clump, an integer 4 to 64. Default 30. */
  readonly grassBlades?: number;
  /** Hue spread between grass clumps, 0 (all one colour) to 0.2: straw and olive clumps side by side. Default 0.035. */
  readonly grassVariety?: number;
  /** Sunlight seen through the grass leaves, 0 to 1 (GrassScatter `blades.translucency`). Default 0. */
  readonly grassTranslucency?: number;
  /** Grass leaf width at the root, metres, 0.004 to 0.05. Default 0.016 (inrolled Ammophila leaves). */
  readonly grassWidth?: number;
  /** Height of the big dune's crest above the flat, metres, 0 (none) to 40. Default 30 (about 100 ft in 1903). */
  readonly hill?: number;
  /**
   * How sharp the wind makes the big dune's brink, 0 to 1. Default 0: rounded over a third of its height (an old,
   * settled crest); 1 rounds it over a twentieth, the sharp brink of a crest the wind is still building.
   */
  readonly crest?: number;
  /** Broad scour bands along the wind on the sand, 0 to 1 (the terrain's `sandSurface.broad`). Default 0. */
  readonly sandBands?: number;
  /** Significant height of the swell at the beach, metres, 0 to 3. Default 1.2 (4 ft winter surf). */
  readonly surf?: number;
  /** Builds the camp sheds and the launch rail. Default true. */
  readonly camp?: boolean;
  /**
   * Albedo of the sheds' wall boards and the rail's timber, linear RGB 0 to 1. Default [0.258, 0.205, 0.147], the
   * `weatheredWood` preset of @margoengine/materials. A film sets its own (silver-grey sun-bleached boards are lighter
   * and cooler).
   */
  readonly boards?: Vec3;
  /** Albedo of the sheds' roof boards, linear RGB 0 to 1. Default [0.258, 0.205, 0.147], as `boards`. */
  readonly roof?: Vec3;
  /** Roof overhang past the sheds' walls, metres, 0 to 1. Default 0.2. */
  readonly shedOverhang?: number;
  /** How weathered the shed boards are, 0 to 1: tilts, uneven ends and gaps that catch the light. Default 0.5. */
  readonly shedWeathering?: number;
  /** Windows: two in the hangar's back wall and one in each shed's end wall. Default false (the photographs' fronts only). */
  readonly shedWindows?: boolean;
  /**
   * Reach of the ambient occlusion, metres, 0 (none) to 10. Default 1.5: the grey sky's light is shut out inside the
   * sheds, under the eaves and the rail, and where a model or the grass meets the sand. Ground-truth ambient occlusion
   * (`GTAO` of @margoengine/post, Jimenez et al. 2016), first in the post stack. A gltf/pbr model is seen and darkened
   * once registered: `scene.parts.occlusion?.add(model)`.
   */
  readonly occlusion?: number;
  /** Real ground heights in place of the built landform. */
  readonly heights?: DuneCoastHeights;
  /**
   * Wind-blown sand (`BlownSand` from @margoengine/vfx/blown-sand), 0 (none) to 1: streaks of sand drifting low over
   * the dry sand, spindrift off the dune crests and the haze sheet near the ground, wherever `wind` with its gusts is
   * over the threshold of 0.25 mm sand (6.6 m/s at 10 m); none on the wet beach or in the grass. Default 0.
   */
  readonly blownSand?: number;
  /** `film` (finest ground and grass) or `preview` (a quarter of the ground cells, a third of the grass). Default `film`. */
  readonly quality?: 'film' | 'preview';
  /** Seed of the hummocks and small dunes. Default 1903. */
  readonly seed?: number;
}

/** A named place in the scene: where to stand and where to look, metres. */
export interface Anchor {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly about: string;
}

/** The scene handle from {@link attach}. */
export interface DuneCoastScene extends Disposable {
  /** The settings in use, every default filled in. */
  readonly settings: Readonly<Required<Omit<DuneCoastSettings, 'heights'>>> & { readonly heights?: DuneCoastHeights };
  /** Ground height at world (x, z), metres (sea level 0). */
  height(x: number, z: number): number;
  /** Named places: `rail`, `camp`, `flightLine`, `bigHill`, `beach`, and the photographs' views (see `views`). */
  readonly anchors: Readonly<Record<string, Anchor>>;
  /** The six reference photographs' camera views, by name, the coast view and the big dune's crest seen side on. */
  readonly views: readonly string[];
  /** Puts the engine camera at an anchor (and a field of view, degrees; default 50). */
  view(name: string, fov?: number): void;
  /** Moves the scene's own time on (water, sky, grass sway): use for film frames instead of wall-clock time. */
  advanceTime(seconds: number): void;
  /**
   * Settles when every part is in the scene. The wind-blown sand (`blownSand` above 0) loads its package on demand, so
   * a scene without it never downloads it; await this before the first frame you keep. Its clock counts every frame
   * delta and `advanceTime` call from `attach` on, so the sand is the same whenever it arrives. Resolves at once when
   * nothing loads; rejects if a part fails to load.
   */
  readonly ready: Promise<void>;
  /** The parts, for settings past these: the sky and post stack, the water, the shadows, the grass. */
  readonly parts: {
    readonly preset: PresetScene;
    readonly water?: Water;
    readonly shadows: Shadows;
    readonly grass?: GrassScatter;
    /** The ambient occlusion pass, first in `preset.post`; absent when `occlusion` is 0. */
    readonly occlusion?: GTAO;
    /** The wind-blown sand, when `blownSand` is above 0, once `ready` has settled. */
    readonly blownSand?: BlownSand;
  };
  dispose(): void;
}

/** The catalogue entry of this scene. */
export const info = duneCoastInfo;

let clockId = 0;
const SHORE_X = 900;
const GROUND = { origin: [-900, -800] as const, size: [2200, 2000] as const };

function check(settings: DuneCoastSettings): DuneCoastScene['settings'] {
  if (typeof settings !== 'object' || settings === null) throw new TypeError('dune-coast: pass settings as an object.');
  const s = {
    ...(Object.fromEntries(Object.entries(info.settings).map(([k, v]) => [k, v.default])) as object),
    ...settings,
  } as DuneCoastScene['settings'];
  for (const [key, spec] of Object.entries(info.settings)) {
    const value = (s as Record<string, unknown>)[key];
    if (spec.range && !(typeof value === 'number' && value >= spec.range[0] && value <= spec.range[1]))
      throw new RangeError(`dune-coast: ${key} is out of range; pass ${spec.range[0]} to ${spec.range[1]}.`);
    if (spec.options && !spec.options.includes(value as string))
      throw new RangeError(`dune-coast: unknown ${key}; pass ${spec.options.join(' or ')}.`);
  }
  for (const key of ['sand', 'boards', 'roof', 'grassColor'] as const) {
    const c = s[key] as unknown as ArrayLike<unknown>;
    if (!c || c.length !== 3 || !Array.from(c).every((v) => typeof v === 'number' && v >= 0 && v <= 1))
      throw new RangeError(`dune-coast: ${key} is not a colour; pass three linear RGB values from 0 to 1.`);
  }
  if (!Number.isInteger(s.grassBlades))
    throw new RangeError('dune-coast: grassBlades is not a whole number; pass 4 to 64.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(s.date)))
    throw new RangeError('dune-coast: date is not a date; pass YYYY-MM-DD.');
  return s;
}

/** Day of the year 1 to 366 of a `YYYY-MM-DD` date. */
function dayOfYear(date: string): number {
  const t = Date.parse(date + 'T12:00:00Z'),
    start = Date.UTC(Number(date.slice(0, 4)), 0, 1, 12);
  return Math.round((t - start) / 86400000) + 1;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The ground's height function: real heights, or the built landform. */
function landform(s: DuneCoastScene['settings']): (x: number, z: number) => number {
  if (s.heights) {
    const { samples, width, depth } = s.heights,
      cell = s.heights.cellSize ?? 1,
      [ox, oz] = s.heights.origin ?? [(-width * cell) / 2, (-depth * cell) / 2],
      sea = s.heights.sea ?? 0.05;
    if (samples.length !== width * depth)
      throw new RangeError('dune-coast: heights.samples must hold width * depth values.');
    const at = (i: number, j: number) => {
      const v = samples[Math.min(depth - 1, Math.max(0, j)) * width + Math.min(width - 1, Math.max(0, i))];
      return v <= sea ? -1.5 : v;
    };
    return (x, z) => {
      const fx = (x - ox) / cell,
        fz = (z - oz) / cell,
        i = Math.floor(fx),
        j = Math.floor(fz),
        tx = fx - i,
        tz = fz - j;
      return (
        (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz
      );
    };
  }
  // The flat stands 2.5 m above the sea (3DEP: 2.1 to 3.5 m across the camp flat). Hummocks of under a metre cover it
  // away from the camp and launch flat; small dunes and the big hill stand on it; the foredune and beach run north to
  // south along x = SHORE_X.
  const cell = 2,
    width = GROUND.size[0] / cell + 1,
    depth = GROUND.size[1] / cell + 1,
    // duneField's wind is degrees from +x toward +z; compass FROM north (0) blows toward +z (south), 90 there.
    wind = (((s.windFrom + 180) % 360) - 90 + 360) % 360,
    field = duneField({
      width,
      depth,
      cellSize: cell,
      origin: GROUND.origin,
      type: 'transverse',
      height: 0.8,
      spacing: 16,
      stoss: 10,
      lee: 28,
      irregularity: 0.9,
      round: 4,
      wind,
      seed: s.seed,
      amount: (x, z) => smooth(90, 220, Math.hypot(x + 10, z - 10)) * (1 - smooth(SHORE_X - 260, SHORE_X - 180, x)),
    });
  const hills = [
    {
      crest: [-40, 430] as const,
      height: s.hill,
      wind,
      stoss: 12,
      lee: 30,
      round: (s.hill / 3) * (1 - 0.85 * s.crest),
    },
    { crest: [-560, 260] as const, height: 11, wind, stoss: 11, lee: 30, halfWidth: 70 },
    { crest: [260, 520] as const, height: 7, wind, stoss: 10, lee: 28, halfWidth: 45 },
  ].filter((h) => h.height > 0);
  return (x, z) => {
    const fx = (x - GROUND.origin[0]) / cell,
      fz = (z - GROUND.origin[1]) / cell,
      i = Math.min(width - 2, Math.max(0, Math.floor(fx))),
      j = Math.min(depth - 2, Math.max(0, Math.floor(fz))),
      tx = Math.min(1, Math.max(0, fx - i)),
      tz = Math.min(1, Math.max(0, fz - j)),
      hum =
        (field[j * width + i] * (1 - tx) + field[j * width + i + 1] * tx) * (1 - tz) +
        (field[(j + 1) * width + i] * (1 - tx) + field[(j + 1) * width + i + 1] * tx) * tz;
    // The hummocks are the flat's: the big dunes are bare, moving sand (LC-W86-120, LC-W85-110), so the hummock field
    // fades out as a dune rises under it. Laid over the dunes, its regular rows read as terraces across their faces.
    let dunes = 0;
    for (const h of hills) dunes += duneHill(x, z, h);
    const inland = 2.5 + hum * (1 - smooth(0.5, 4, dunes)) + dunes;
    // Beach: 1 in 28 above the waterline, 1 in 50 below it; the foredune ridge 110 m inland of the waterline.
    const beach = x < SHORE_X ? (SHORE_X - x) / 28 : (SHORE_X - x) / 50,
      w = smooth(SHORE_X - 170, SHORE_X - 70, x),
      ridge = 3.2 * Math.exp(-(((x - (SHORE_X - 115)) / 28) ** 2)) * (0.8 + 0.2 * Math.sin(z / 37 + Math.sin(z / 91)));
    return (1 - w) * inland + w * beach + ridge;
  };
}

/**
 * The ground height function of the scene for `settings`, with no engine: metres above sea level at world (x, z),
 * the same heights `attach` builds. For placing subjects and cameras before or without a GPU.
 * @throws TypeError or RangeError for a bad setting.
 */
export function ground(settings: DuneCoastSettings = {}): (x: number, z: number) => number {
  return landform(check(settings));
}

/**
 * The landform sampled once on the ground mesh's vertex grid (`cells` cells over the ground), read back bilinearly:
 * exact at the vertices, so the mesh, the grass heights and the grass cover share one evaluation of each height.
 */
function sampled(height: (x: number, z: number) => number, cells: number): (x: number, z: number) => number {
  const n = cells + 1,
    cx = GROUND.size[0] / cells,
    cz = GROUND.size[1] / cells,
    grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) grid[j * n + i] = height(GROUND.origin[0] + i * cx, GROUND.origin[1] + j * cz);
  return (x, z) => {
    const fx = Math.min(cells, Math.max(0, (x - GROUND.origin[0]) / cx)),
      fz = Math.min(cells, Math.max(0, (z - GROUND.origin[1]) / cz)),
      i = Math.min(cells - 1, Math.floor(fx)),
      j = Math.min(cells - 1, Math.floor(fz)),
      tx = fx - i,
      tz = fz - j,
      a = grid[j * n + i],
      b = grid[j * n + i + 1],
      c = grid[(j + 1) * n + i],
      d = grid[(j + 1) * n + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

/**
 * Dune grass cover 0 to 1 over the ground. American beachgrass (Ammophila breviligulata) grows where blown sand
 * buries it and spreads by rhizomes in clumps; the sand it traps builds the hummocks (nebkhas), so hummock tops carry
 * the most and the hollows between them the least (Hesp 2002, "Foredunes and blowouts: initiation, geomorphology and
 * dynamics", Geomorphology 48; Maun 2009, "The Biology of Coastal Sand Dunes", ch. 9). None below 1.2 m (the beach and
 * the wet band) and none on the upper dunes above about 9 m, which were bare, moving sand in 1903 (LC-W86-120,
 * LC-W85-110). Clumps stand in patches 3 to 10 m across, in larger groups; `grass` sets the share of ground in patches.
 * The camp yard is bare, trodden sand: the hangar, the shed and a metre round them (x -98 to -60.5, z 26 to 34, eased
 * over 1.5 m), whether the scene builds the camp or a film stands its own buildings there, so no grass grows indoors.
 */
function coverOf(s: DuneCoastScene['settings'], height: (x: number, z: number) => number) {
  const noise = new Noise(s.seed + 7),
    threshold = 0.9 - 1.2 * s.grass;
  return (x: number, z: number): number => {
    const h = height(x, z),
      habitat = smooth(1.2, 2, h) * (1 - smooth(7, 11, h));
    if (!(habitat > 0) || s.grass <= 0) return 0;
    // Mound tops take more of the ground in patches; inside a patch the clumps stand close and merge into tussocks.
    const ring = (height(x + 6, z) + height(x - 6, z) + height(x, z + 6) + height(x, z - 6)) / 4,
      edge = threshold - 0.5 * smooth(-0.05, 0.35, h - ring),
      field =
        0.65 * noise.simplex2(x / 8, z / 8) +
        0.3 * noise.simplex2(x / 2.5 - 9, z / 2.5 + 4) +
        0.5 * noise.simplex2(x / 30 + 31, z / 30 - 17);
    // Patches 3 to 10 m across in groups, a lone clump here and there between them.
    const yard = smooth(-98, -96.5, x) * (1 - smooth(-62, -60.5, x)) * smooth(26, 27.5, z) * (1 - smooth(32.5, 34, z));
    return habitat * Math.max(0.03, 0.95 * smooth(edge, edge + 0.15, field)) * (1 - yard);
  };
}

/**
 * Where the scene's dune grass grows: ground cover 0 (bare sand) to 1 (full clump) at world (x, z) for `settings`,
 * with no engine. `attach` places its grass clumps by this map, so subjects can be kept out of the grass or put in it.
 * @throws TypeError or RangeError for a bad setting.
 */
export function grassCover(settings: DuneCoastSettings = {}): (x: number, z: number) => number {
  const s = check(settings);
  return coverOf(s, landform(s));
}

/** Puts geometry data at (x, y, z), turned by `yaw` radians about +y. */
function place(data: GeometryData, x: number, y: number, z: number, yaw = 0): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return applyMatrix4(data, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}

/**
 * Builds the dune coast in `engine`: ground, sky and post, sea and surf, grass, camp and rail. One call; every look
 * value is a setting (see {@link DuneCoastSettings}) or a part's own option (`scene.parts`).
 * @throws TypeError or RangeError for a bad setting.
 */
export function attach(engine: EngineKernel, settings: DuneCoastSettings = {}): DuneCoastScene {
  const s = check(settings),
    film = s.quality === 'film',
    height = landform(s),
    meshes: Mesh[] = [],
    disposers: (() => void)[] = [];
  // Sun for the date and hour, then the sky preset of the weather with that sun.
  const sun = sunPath({ latitude: degrees(s.latitude), dayOfYear: dayOfYear(s.date), hour: s.hour }),
    base = s.weather === 'overcast' ? SCENE_PRESETS.overcast : SCENE_PRESETS.noon,
    preset = PresetScene.attach(engine, {
      ...base,
      day: {
        ...(s.weather === 'overcast' ? DAY_PRESETS.overcast : DAY_PRESETS.noon),
        azimuth: sun.azimuth.degrees,
        elevation: Math.max(1, sun.elevation.degrees),
        clouds: s.weather === 'overcast' ? 1 : 0.35,
      },
      fog: 3.912 / s.visibility,
    });
  disposers.push(() => preset.dispose());
  // Without occlusion the sky light reaches a shed's inside and a model's foot as fully as the open sand, so a building
  // reads as a lit cut-out pasted on the ground.
  const occlusion =
    s.occlusion > 0 ? new GTAO({ radius: s.occlusion, slices: film ? 3 : 2, steps: film ? 8 : 6 }) : undefined;
  if (occlusion) preset.post.addEffect(occlusion, 0);
  const shadows = Shadows.attach(engine, {
    resolution: film ? 4096 : 2048,
    distance: 220,
    lambda: 0.75,
    // Overcast light comes from the whole sky: wide, faint penumbras; a clear sun gives crisp ones.
    lightSize: s.weather === 'overcast' ? 0.08 : 0.02,
    normalBias: 0.06,
    casterMargin: 80,
  });
  disposers.push(() => shadows.dispose());
  // Ground: one mesh over the whole island, sand everywhere (no meadow band), wet near the water line.
  // One height grid on the ground mesh's vertices feeds the mesh, the grass heights and the grass cover.
  // 1,023 cells: the grass grids hold one texel per vertex, and a TerrainHeightmap holds at most 1,024 a side.
  const cells = film ? 1023 : 511,
    gridded = sampled(height, cells);
  const ground = engine
    .createMesh()
    .setGeometry(
      toGeometry(heightfieldGeometry(gridded, { size: GROUND.size, origin: GROUND.origin, resolution: cells })),
    )
    .setMaterial(new PbrMaterial({ color: [s.sand[0], s.sand[1], s.sand[2]], roughness: 0.92 }));
  ground.name = 'dune-coast ground';
  meshes.push(ground);
  shadows.add(ground, { static: true });
  const shoreMap = TerrainHeightmap.attach(engine, height, {
    origin: [SHORE_X - 240, GROUND.origin[1]],
    size: [400, GROUND.size[1]],
    resolution: 512,
  });
  disposers.push(() => shoreMap.dispose());
  let water: Water | undefined;
  TerrainColors.attach(engine, ground, {
    sand: s.sand,
    // Everything up to 80 m is sand: no meadow band, no rock on the 30 degree lee faces.
    shore: [80, 90],
    stoneNormal: [0.2, 0.25],
    wetHeight: [-0.1, 0.9],
    wetDarkening: 0.58,
    variation: 0.08,
    detail: 1,
    // Ripples across the wind, streaks along it, pale slip faces on the lee (south) sides.
    sandSurface: {
      wind: [Math.sin(((s.windFrom + 180) * Math.PI) / 180), -Math.cos(((s.windFrom + 180) * Math.PI) / 180)],
      broad: s.sandBands,
    },
    wetness: {
      texture: () => water?.coastalDepthTexture,
      origin: [SHORE_X - 240, GROUND.origin[1]],
      size: [400, GROUND.size[1]],
    },
  });
  // The winter Atlantic: a long swell from the east-north-east, a shorter one, and the north wind's sea and chop.
  if (s.surf > 0) {
    const a = s.surf / 2,
      to = ((s.windFrom + 180) * Math.PI) / 180,
      windDir: [number, number] = [Math.sin(to), -Math.cos(to)],
      waves: Wave[] = [
        { direction: [-0.97, 0.24], amplitude: a * 0.75, wavelength: 72, steepness: 0.45, phase: 0.4 },
        { direction: [-0.88, -0.47], amplitude: a * 0.4, wavelength: 41, steepness: 0.45, phase: 2.2 },
        { direction: windDir, amplitude: Math.min(0.35, 0.025 * s.wind), wavelength: 11, steepness: 0.3, phase: 4.1 },
        {
          direction: [windDir[0] * 0.8 - 0.2, windDir[1]],
          amplitude: Math.min(0.12, 0.01 * s.wind),
          wavelength: 5,
          steepness: 0.35,
          phase: 1.3,
        },
      ];
    water = Water.attach(engine, {
      size: [1200, 1200],
      segments: film ? 512 : 256,
      horizon: true,
      height: 0,
      // Grey-green winter shelf water, lighter and greener than open ocean (suspended sand near a surf beach).
      color: [0.018, 0.04, 0.036],
      foamDistance: 3,
      spray: true,
      whitecaps: Math.min(1, s.wind / 18),
      chop: Math.min(1, s.wind / 16),
      depth: () => preset.post.depthTexture,
      sceneColor: () => preset.post.sceneTexture,
      reflection: () => preset.sky.reflectionTexture,
      lights: preset.sky.lights,
      shadows,
      terrain: {
        heightmap: () => shoreMap.texture,
        origin: [SHORE_X - 240, GROUND.origin[1]],
        size: [400, GROUND.size[1]],
      },
      waves,
    });
    disposers.push(() => water?.dispose());
  }
  // Dune grass: winter clumps of American beachgrass where `grassCover` puts them, on a grid that follows the camera.
  // The height and cover grids span the whole ground with their texel centres on the ground mesh's vertices (a texel
  // holds the value at its centre), so every clump stands on the triangles the ground draws.
  let grass: GrassScatter | undefined;
  if (s.grass > 0) {
    const n = cells + 1,
      cx = GROUND.size[0] / cells,
      cz = GROUND.size[1] / cells,
      origin: [number, number] = [GROUND.origin[0] - cx / 2, GROUND.origin[1] - cz / 2],
      size: [number, number] = [GROUND.size[0] + cx, GROUND.size[1] + cz],
      grid = { origin, size, resolution: n },
      heights = TerrainHeightmap.attach(engine, gridded, grid),
      cover = TerrainHeightmap.attach(engine, coverOf(s, gridded), grid),
      to = ((s.windFrom + 180) * Math.PI) / 180;
    disposers.push(
      () => heights.dispose(),
      () => cover.dispose(),
    );
    grass = GrassScatter.attach(engine, {
      count: film ? 240_000 : 80_000,
      area: [480, 480],
      follow: true,
      bounds: [origin[0], origin[1], origin[0] + size[0], origin[1] + size[1]],
      heightmap: () => heights.texture,
      densityMap: () => cover.texture,
      maxSlope: 32,
      scale: [0.7, 1.25],
      lod: [30, 90, 230],
      edgeShrink: 40,
      // Winter Ammophila breviligulata: narrow inrolled leaves 0.4 to 0.9 m, arching, 30 or more to a clump.
      grass: {
        height: s.grassHeight,
        heightVariance: 0.5,
        width: s.grassWidth,
        blades: s.grassBlades,
        radius: 0.25,
        lean: 0.65,
        round: 0.4,
      },
      blades: { rootShade: 0.5, widen: 1, translucency: s.grassTranslucency },
      // Straw leaves with olive bases and live shoots: a hue turn either way and a brightness spread per clump.
      variation: { hue: s.grassVariety, value: 0.25 },
      material: new PbrMaterial({
        color: [s.grassColor[0], s.grassColor[1], s.grassColor[2]],
        roughness: 0.85,
        doubleSided: true,
      }),
      wind: [Math.sin(to), -Math.cos(to), Math.min(1, s.wind / 15)],
      sink: 0.04,
      seed: s.seed,
    });
    disposers.push(() => grass?.dispose());
  }
  // Wind-blown sand where the dry sand is bare: none on the wet beach (below 1.2 m) or under the grass, which holds it.
  // Its package loads on demand, so a scene without sand never fetches it. Until it arrives a clock plugin keeps every
  // frame delta and advanceTime call in order; the sand replays them, so its clock is the one it would have had.
  let blownSand: BlownSand | undefined,
    disposed = false,
    ready: Promise<void> = Promise.resolve();
  const early: number[] = [],
    clock = `dune-coast-clock:${clockId++}`;
  if (s.blownSand > 0) {
    const cover = s.grass > 0 ? coverOf(s, gridded) : () => 0,
      // Compass FROM to the direction it blows toward, as BlownSand reads it (0 toward +z, pi/2 toward +x).
      to = ((s.windFrom + 180) * Math.PI) / 180,
      options: BlownSandOptions = {
        ground: gridded,
        wind: { speed: s.wind, direction: Math.atan2(Math.sin(to), -Math.cos(to)), gust: 0.35 },
        mask: (x, z) => smooth(1.2, 2.2, gridded(x, z)) * (1 - cover(x, z)),
        amount: s.blownSand,
        color: s.sand,
        fog: 3.912 / s.visibility,
        depth: () => preset.post.depthTexture,
        softness: 0.2,
        sky: preset.sky,
        seed: s.seed,
      };
    // The sand joins the scene the clock was attached to, even if another scene is active when it arrives.
    const timer = { name: clock, setup() {}, onPreUpdate: (delta: number) => early.push(delta) },
      stop = () => engine.sceneOf(timer)?.removePlugin(clock);
    engine.use(timer);
    ready = import('@margoengine/vfx/blown-sand').then(
      ({ BlownSand }) => {
        const home = engine.sceneOf(timer);
        if (disposed || !home) return;
        home.removePlugin(clock);
        const sand = new BlownSand(options);
        home.use(sand);
        for (const delta of early) sand.advanceTime(delta);
        early.length = 0;
        blownSand = sand;
      },
      (error: unknown) => {
        if (!disposed) stop();
        throw error;
      },
    );
    disposers.push(() => {
      disposed = true;
      if (blownSand) blownSand.dispose();
      else stop();
    });
  }
  // The camp: the 1903 hangar (44 by 16 ft, horizontal boards, awning doors) and the 1901 shed (25 by 16 ft, vertical
  // boards, steeper roof) side by side 70 m west of the rail; the rail runs north from (0, 0) into the wind.
  if (s.camp) {
    const wood = new PbrMaterial({
        color: [s.boards[0], s.boards[1], s.boards[2]],
        roughness: weatheredWood.roughness,
        metalness: weatheredWood.metalness,
      }),
      roofing = new PbrMaterial({
        color: [s.roof[0], s.roof[1], s.roof[2]],
        roughness: weatheredWood.roughness,
        metalness: weatheredWood.metalness,
      }),
      board = (part: string) => (part === 'trim' ? dark : part === 'roof' ? roofing : wood),
      dark = new PbrMaterial({ color: [0.2, 0.17, 0.13], roughness: 0.9 }),
      metal = new PbrMaterial({ color: [0.35, 0.34, 0.33], roughness: 0.6, metalness: 0.8 }),
      add = (data: GeometryData, material: PbrMaterial, name: string) => {
        const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(material);
        mesh.name = name;
        meshes.push(mesh);
        shadows.add(mesh, { static: true });
      };
    const windows = (wall: 'back' | 'left', at: number[]) =>
        s.shedWindows
          ? at.map((x) => ({ wall, at: x, width: 0.8, height: 0.7, bottom: 1.0, leaf: 'none' as const }))
          : [],
      hangar = generatePlankShed({
        overhang: s.shedOverhang,
        weathering: s.shedWeathering,
        openings: [
          { wall: 'front', width: 3.6, height: 2.1, leaf: 'awning' },
          ...windows('back', [-3.5, 3.5]),
          ...windows('left', [0]),
        ],
        seed: 3,
      }),
      shed = generatePlankShed({
        overhang: s.shedOverhang,
        weathering: s.shedWeathering,
        length: 7.6,
        width: 4.9,
        eaves: 2.3,
        pitch: 30,
        siding: 'vertical',
        board: 0.2,
        openings: [
          { wall: 'front', at: -1.6, width: 0.9, height: 1.95, leaf: 'closed' },
          { wall: 'front', at: 1.5, width: 0.8, height: 0.7, bottom: 1.0, leaf: 'none' },
          ...windows('left', [0]),
        ],
        seed: 4,
      }),
      // Both face north toward the rail (front, +z, turned to -z).
      hx = -70,
      hz = 30,
      sx = -88.5,
      gy = (x: number, z: number) => height(x, z) - 0.05;
    for (const [part, data] of Object.entries(hangar.parts))
      add(place(data, hx, gy(hx, hz), hz, Math.PI), board(part), `hangar ${part}`);
    for (const [part, data] of Object.entries(shed.parts))
      add(place(data, sx, gy(sx, hz), hz, Math.PI), board(part), `shed ${part}`);
    const rail = generateLaunchRail({ ground: (x) => height(0, -x) });
    // The rail's +x runs north (-z): turn it a quarter turn.
    add(place(rail.parts.wood, 0, 0, 0, Math.PI / 2), wood, 'rail');
    if (rail.parts.metal) add(place(rail.parts.metal, 0, 0, 0, Math.PI / 2), metal, 'rail strip');
  }
  const eye = (x: number, z: number, up: number): Vec3 => [x, height(x, z) + up, z];
  const anchors: Record<string, Anchor> = {
    rail: { position: eye(6, 4, 1.6), target: eye(0, -18, 0.3), about: 'the launch rail, its south end at the origin' },
    camp: {
      position: eye(-60, -25, 1.7),
      target: eye(-78, 30, 2),
      about: 'the hangar and the shed, seen from the north',
    },
    flightLine: {
      position: eye(0, -18.3, 1.5),
      target: eye(0, -60, 1.5),
      about: 'north along the first flight, 120 ft',
    },
    bigHill: {
      position: eye(-40, 430, 1.7),
      target: eye(-40, -50, 2),
      about: 'the big dune crest, looking back at the camp',
    },
    beach: {
      position: eye(SHORE_X - 120, 0, 1.7),
      target: [SHORE_X + 200, 1, 40],
      about: 'the foredune crest over the surf',
    },
    // The reference photographs (approximate camera places, from the photographs and the layout).
    'first-flight': {
      position: eye(14, -14, 1.3),
      target: eye(-60, -40, 0.4),
      about: 'LC-W861-35, the first flight launch, looking west',
    },
    'camp-buildings': {
      position: eye(-40, -12, 1.6),
      target: eye(-80, 30, 1.6),
      about: 'LC-W86-15, the camp from the north-east',
    },
    'killdevil-from-flat': {
      position: eye(10, -60, 1.6),
      target: eye(-40, 430, 14),
      about: 'LC-W86-120, the big dune across the flat',
    },
    'flyer-on-rail': {
      position: eye(-75, 300, 1.6),
      target: eye(-25, 330, 1),
      about: 'LC-W86-21, on the windward slope, the slope rising right',
    },
    'killdevil-back': {
      position: eye(-40, 640, 1.6),
      target: eye(-40, 430, 10),
      about: 'LC-W85-110, the lee side of the big dune',
    },
    'landing-rail-view': {
      position: eye(-4, -48, 1.2),
      target: eye(0, 0, 0.2),
      about: 'LC-W86-38, back south along the flight line',
    },
    surf: {
      position: eye(SHORE_X - 40, -30, 1.7),
      target: [SHORE_X + 60, 0.5, 10],
      about: 'the beach and the surf, looking east',
    },
    crest: {
      position: eye(-75, 424, 1.6),
      target: eye(-30, 432, 0.5),
      about: 'the big dune crest seen side on, the wind blowing across the view from left to right',
    },
  };
  return {
    settings: s,
    height,
    anchors,
    views: info.views,
    view(name, fov = 50) {
      const a = anchors[name];
      if (!a) throw new RangeError(`dune-coast: no anchor ${name}; pass one of ${Object.keys(anchors).join(', ')}.`);
      engine.camera.position = [...a.position] as Vec3;
      engine.camera.target = [...a.target] as Vec3;
      engine.camera.fov = fov;
    },
    advanceTime(seconds) {
      preset.sky.advanceTime?.(seconds);
      water?.advanceTime(seconds);
      grass?.advanceTime(seconds);
      if (blownSand) blownSand.advanceTime(seconds);
      else if (s.blownSand > 0) early.push(seconds);
    },
    ready,
    parts: {
      preset,
      water,
      shadows,
      grass,
      occlusion,
      get blownSand() {
        return blownSand;
      },
    },
    dispose() {
      for (const m of meshes) m.dispose?.();
      for (const d of disposers.reverse()) d();
      meshes.length = 0;
      disposers.length = 0;
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
}

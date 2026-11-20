/// <reference lib="esnext.disposable" preserve="true" />
// Timber valley: a northern Rockies mountain valley in the 1910 fires, in one call, built from the engine's packages. The
// default is the afternoon of 20 August 1910 round Wallace, Idaho: a level floor 870 m up with the South Fork's creek and
// the rail grade on it, walls of about 30 degrees cut into side gulches, western white pine, larch, red cedar, Douglas-fir
// and grand fir on them (`rockiesValleyWorld` of @margoengine/biomes), a mining and railway town laid out as lots along
// the line, and a fire (`FireFront` of @margoengine/vfx) running by wind, slope and fuel under the south-west gale of the
// blowup, with smoke columns, flames and embers, under a sky, clouds and smoke haze that follow one weather.
// Layout: x east, z south, y up, metres; the valley drains west out of the world's west edge.
// Sources: Pyne, "Year of the Fires: The Story of the Great Fires of 1910", 2001 (the blowup of 20 and 21 August, the
// south-west gale, Wallace burned in part); Koch, "History of the 1910 forest fires in Idaho and western Montana", USDA
// Forest Service, 1942; the presets' habitat and fuel sources are in @margoengine/biomes docs/fuel.md.
import type { EngineKernel, Vec3 } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { rockiesValleyWorld } from '@margoengine/biomes/presets';
import { createRelief } from '@margoengine/biomes/relief';
import '@margoengine/biomes/valley';
import { fuelMap, type FuelMap } from '@margoengine/biomes/fuel';
import { layoutSettlements, type Settlements } from '@margoengine/biomes/settlements';
import { pathExclusions } from '@margoengine/biomes/splines';
import { BiomeView, type BiomeViewOptions } from '@margoengine/biomes/view';
import { DAY_PRESETS } from '@margoengine/sky/day-presets';
import { PresetScene, SCENE_PRESETS } from '@margoengine/sky/scenes';
import { degrees, sunPath } from '@margoengine/sky/sun';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { applySkySettings, SKY_SETTINGS } from '@margoengine/sky/settings';
import { WeatherMachine, WEATHER_PRESETS, type WeatherState } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { applyWeatherSettings, WEATHER_LOOKS, WEATHER_SETTINGS } from '@margoengine/weather/settings';
import { FireFront } from '@margoengine/vfx/fire-front';
import { applyFireSettings, FIRE_SETTINGS } from '@margoengine/vfx/settings';
import { Shadows } from '@margoengine/shadows';
import { GTAO } from '@margoengine/post/gtao';
import { applyLookFamily, type LookFamilyName } from './look-family.js';
import type { SceneShot } from './index.js';
import { timberValleyInfo } from './timber-valley-info.js';

/** Settings of {@link attach}. Every one has a default; the defaults are the blowup afternoon of 20 August 1910. */
export interface TimberValleySettings {
  /** Calendar date, `YYYY-MM-DD`. Default `1910-08-20`. */
  readonly date?: string;
  /** Local solar time, hours. Default 16. */
  readonly hour?: number;
  /** Latitude, degrees north. Default 47.47 (Wallace, Idaho). */
  readonly latitude?: number;
  /** Look family (`@margoengine/scenes/look-family`). Default `animatedFeature`. */
  readonly look?: LookFamilyName;
  /**
   * `calm` (a clear August day, 2 m/s), `redFlag` (32 C, 15 percent humidity, 9 m/s), `blowup` (the gale of 20 August:
   * 20 m/s gusting, 12 percent humidity) or `smoke` (a day under thick smoke). Default `blowup`.
   */
  readonly weather?: 'calm' | 'redFlag' | 'blowup' | 'smoke';
  /** Compass direction the wind blows FROM, degrees (0 north, 90 east). Default 225 (the south-west gale). */
  readonly windFrom?: number;
  /** `none`, `running` (burning for `fireTime` seconds) or `burnt` (run until nothing burns). Default `running`. */
  readonly fire?: 'none' | 'running' | 'burnt';
  /** Seconds the fire has burned when the scene opens, 0 to 21,600. Default 1,800. */
  readonly fireTime?: number;
  /** Town lots along the rail line, 0 to 256. They are fuel and fire obstacles; no building is drawn. Default 48. */
  readonly houses?: number;
  /**
   * Meshes by species key for the forest (`BiomeViewOptions.meshes`): library models drawn in place of the procedural
   * ones (`libraryMesh` of `@margoengine/scenes/library` loads one from glTF). Default none.
   */
  readonly meshes?: BiomeViewOptions['meshes'];
  /** `film` (2 km of objects, 4,096 shadows, 4 m fire cells) or `preview` (1 km, 2,048, 8 m). Default `film`. */
  readonly quality?: 'film' | 'preview';
  /** Seed of the valley, the forest, the town and the embers. Default 1910. */
  readonly seed?: number;
  /** Aborts loading. */
  readonly signal?: AbortSignal;
}

type Filled = Readonly<Required<Omit<TimberValleySettings, 'meshes' | 'signal'>>> & Pick<TimberValleySettings, 'meshes'>;

/** A named place in the scene: where to stand and where to look, metres. */
export interface Anchor {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly about: string;
}

/** The valley's lines in metres (`[x, z]` points, outlet first) and the town, from {@link layout}. */
export interface TimberValleyLayout {
  readonly creek: readonly (readonly [number, number])[];
  readonly rail: readonly (readonly [number, number])[];
  readonly axis: readonly (readonly [number, number])[];
  /** The town's lots, streets and exclusions (`layoutSettlements`, grid pattern). */
  readonly town: Settlements;
  /** Every lot as a fire structure (`FireFront` `structures`). */
  readonly structures: readonly { readonly at: [number, number]; readonly radius: number }[];
  /** Where and when the fire starts. */
  readonly ignitions: readonly { readonly at: [number, number]; readonly time: number }[];
}

/** One camera key track of a shot, as `tools/shot` cutscene files hold it. */
export interface ShotTrack {
  readonly type: 'camera';
  readonly id: 'camera';
  readonly path: 'linear';
  readonly keys: readonly { time: number; position: Vec3; target: Vec3; fov: number; ease?: 'smoothstep' }[];
}

/** The scene handle from {@link attach}. */
export interface TimberValleyScene extends Disposable {
  /** The settings in use, every default filled in. */
  readonly settings: Filled;
  /** Ground height at world (x, z), metres. */
  height(x: number, z: number): number;
  readonly anchors: Readonly<Record<string, Anchor>>;
  readonly views: readonly string[];
  /** Puts the engine camera at an anchor (and a field of view, degrees; default 50). */
  view(name: string, fov?: number): void;
  readonly shots: readonly SceneShot[];
  /** Camera tracks per shot name, from each shot's first to its last camera key, for `shotFilesFromScene`. */
  readonly tracks: Readonly<Record<string, readonly ShotTrack[]>>;
  /** Target name to package settings entry (`info.targets`). */
  readonly targets: Readonly<Record<string, string>>;
  /** The valley lines, the town and the fire's starts. */
  readonly layout: TimberValleyLayout;
  /** Applies a look family to every part. */
  applyLook(name: LookFamilyName): void;
  /** Writes per-shot rows: `{weather: {...}, sky: {...}, fire: {...}}`, each through its package's apply function. */
  applySettings(values: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void;
  /** Moves the scene's own time on (fire, sky): use for film frames instead of wall-clock time. */
  advanceTime(seconds: number): void;
  /** Waits for the forest tiles to stream in around the camera. */
  settle(): Promise<void>;
  readonly parts: {
    readonly world: BiomeWorld;
    readonly view: BiomeView;
    readonly preset: PresetScene;
    readonly clouds: VolumetricClouds;
    readonly weather: WeatherMachine;
    readonly drive: WeatherDrive;
    readonly shadows: Shadows;
    readonly occlusion: GTAO;
    readonly fuel: FuelMap;
    readonly fireFront?: FireFront;
  };
  dispose(): void;
}

/** The catalogue entry of this scene. */
export const info = timberValleyInfo;

const SIZE = 4096;
const ORIGIN: [number, number] = [-SIZE / 2, -SIZE / 2];

/** Fills defaults and checks every setting. @throws TypeError, RangeError. */
export function check(settings: TimberValleySettings): Filled {
  if (typeof settings !== 'object' || settings === null)
    throw new TypeError('timber-valley: pass settings as an object.');
  const { signal: _signal, ...rest } = settings;
  const s = {
    ...(Object.fromEntries(Object.entries(info.settings).map(([k, v]) => [k, v.default])) as object),
    ...rest,
  } as Filled;
  for (const [key, spec] of Object.entries(info.settings)) {
    const value = (s as Record<string, unknown>)[key];
    if (spec.range && !(typeof value === 'number' && value >= spec.range[0] && value <= spec.range[1]))
      throw new RangeError(`timber-valley: ${key} is out of range; pass ${spec.range[0]} to ${spec.range[1]}.`);
    if (spec.options && !spec.options.includes(value as string))
      throw new RangeError(`timber-valley: unknown ${key}; pass ${spec.options.join(' or ')}.`);
  }
  if (!Number.isInteger(s.houses)) throw new RangeError('timber-valley: houses is not a whole number; pass 0 to 256.');
  if (!Number.isInteger(s.seed) || s.seed < 0) throw new RangeError('timber-valley: seed must be a whole number 0 or more.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(s.date)))
    throw new RangeError('timber-valley: date is not a date; pass YYYY-MM-DD.');
  if (s.meshes !== undefined && (typeof s.meshes !== 'object' || s.meshes === null))
    throw new TypeError('timber-valley: meshes must be an object of mesh parts by key.');
  return s;
}

/** Day of the year 1 to 366 of a `YYYY-MM-DD` date. */
function dayOfYear(date: string): number {
  const t = Date.parse(date + 'T12:00:00Z'),
    start = Date.UTC(Number(date.slice(0, 4)), 0, 1, 12);
  return Math.round((t - start) / 86400000) + 1;
}

/** The weather state of a `weather` setting with the wind from `windFrom` (compass, degrees). */
export function weatherState(weather: Filled['weather'], windFrom: number): WeatherState {
  const toward = ((windFrom + 180) * Math.PI) / 180,
    // WeatherState's direction: radians toward, 0 is +z (south) and pi/2 is +x (east).
    windDirection = Math.atan2(Math.sin(toward), -Math.cos(toward)),
    base: Partial<WeatherState> =
      weather === 'calm'
        ? { wind: 2, gust: 0.15, cloud: 0.2, humidity: 0.35, temperature: 27 }
        : weather === 'redFlag'
          ? (({ storm: _storm, ...rest }) => rest)(WEATHER_LOOKS.redFlag)
          : weather === 'blowup'
            ? // 20 August 1910: a dry south-west gale (rangers' accounts of a hurricane-force wind); a 20 m/s mean
              // gusting, 12 percent humidity and 30 C.
              { wind: 20, gust: 0.8, humidity: 0.12, temperature: 30, cloud: 0.15 }
            : { wind: 6, gust: 0.3, smoke: 0.6, cloud: 0.3, humidity: 0.3, temperature: 22 };
  return { ...WEATHER_PRESETS.clear, ...base, windDirection } as WeatherState;
}

/** The valley's lines and the town, from the same relief the world is built on. CPU only. */
export function layout(world: BiomeWorld, settings: TimberValleySettings = {}): TimberValleyLayout {
  const s = check(settings),
    relief = createRelief({ seed: s.seed, origin: ORIGIN, size: [SIZE, SIZE], ...rockiesValleyWorld.relief }),
    valley = relief.mountainValley!,
    line = (mm: Int32Array | null) => {
      const out: [number, number][] = [];
      if (mm) for (let i = 0; i + 1 < mm.length; i += 2) out.push([mm[i] / 1000, mm[i + 1] / 1000]);
      return out;
    },
    axis = line(valley.axis),
    rail = line(valley.rail),
    creek = line(valley.creek),
    // The town 700 m in from the outlet, centred between the rail and the floor's edge on the rail's side; a mining
    // camp 2.6 km up the valley. Their main streets run along the valley.
    at = (along: number): [number, number] => axis[Math.min(axis.length - 1, Math.round(along / 16))],
    railAt = (along: number): [number, number] => rail[Math.min(rail.length - 1, Math.round(along / 16))] ?? at(along),
    side = (along: number): [number, number] => {
      const a = at(along),
        r = railAt(along),
        dx = r[0] - a[0],
        dz = r[1] - a[1],
        d = Math.hypot(dx, dz) || 1;
      return [Math.round(r[0] + (dx / d) * 40), Math.round(r[1] + (dz / d) * 40)];
    },
    dir = (along: number): [number, number] => {
      const a = at(along - 64),
        b = at(along + 64),
        d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    },
    railPath = { points: rail, width: 10, edge: 2 },
    creekPath = { points: creek, width: 14, edge: 2 },
    town =
      s.houses > 0
        ? layoutSettlements(world, {
            seed: s.seed,
            sites: [side(700), side(2600)],
            villages: 2,
            spacing: 400,
            houses: Math.ceil(s.houses / 2),
            pattern: 'grid',
            grid: { toward: dir(700), block: [64, 32], lot: 12, street: 10 },
            siteGrade: 0.2,
            avoid: pathExclusions([railPath, creekPath]),
          })
        : { villages: [], roads: [], lanes: [], paths: [], exclusions: [] },
    structures = town.villages.flatMap((v) =>
      v.houses.map((h) => ({ at: [h.centre[0], h.centre[1]] as [number, number], radius: Math.max(h.size[0], h.size[1]) / 2 })),
    ),
    // The fire starts low on the south wall west of the town, in timber, and the gale drives it.
    start = at(250),
    ignitions = [{ at: [start[0] + 60, start[1] + 380] as [number, number], time: 0 }];
  return {
    creek,
    rail,
    axis,
    town: { ...town, exclusions: [...town.exclusions, ...pathExclusions([railPath, creekPath])] } as Settlements,
    structures,
    ignitions,
  };
}

/** The scene's world on the CPU (heights, climate, biomes), for placing subjects and cameras. */
export async function world(settings: TimberValleySettings = {}): Promise<BiomeWorld> {
  const s = check(settings);
  return BiomeWorld.create({
    seed: s.seed,
    origin: ORIGIN,
    size: [SIZE, SIZE],
    climate: rockiesValleyWorld.climate,
    height: { relief: rockiesValleyWorld.relief },
    biomes: rockiesValleyWorld.biomes,
    ...(settings.signal ? { signal: settings.signal } : {}),
  });
}

/**
 * Builds the scene into `engine`: sky, clouds, weather, the valley and its forest, the town lots, and the fire.
 * @throws TypeError or RangeError for bad settings, before anything is built.
 * @example
 * const scene = await attach(engine, { weather: 'redFlag', fireTime: 600 });
 * scene.view('ridge');
 */
export async function attach(engine: EngineKernel, settings: TimberValleySettings = {}): Promise<TimberValleyScene> {
  const s = check(settings),
    film = s.quality === 'film',
    disposers: (() => void)[] = [];
  const fail = (error: unknown) => {
    for (const d of disposers.reverse()) d();
    throw error;
  };
  const w = await world(settings);
  disposers.push(() => w.dispose());
  try {
    const plan = layout(w, s),
      height = (x: number, z: number) => w.heightAt(x, z);
    // Sun for the date and hour; a clear late-summer sky (the weather drive thickens it with cloud and smoke).
    const sun = sunPath({ latitude: degrees(s.latitude), dayOfYear: dayOfYear(s.date), hour: s.hour }),
      low = sun.elevation.degrees < 20,
      preset = PresetScene.attach(engine, {
        ...(low ? SCENE_PRESETS.goldenHour : SCENE_PRESETS.noon),
        day: {
          ...(low ? DAY_PRESETS.goldenHour : DAY_PRESETS.noon),
          azimuth: sun.azimuth.degrees,
          elevation: Math.max(1, sun.elevation.degrees),
        },
        fog: 3.912 / 40000,
      });
    disposers.push(() => preset.dispose());
    const occlusion = new GTAO({ radius: 2, slices: film ? 3 : 2, steps: film ? 8 : 6 });
    preset.post.addEffect(occlusion, 0);
    const shadows = Shadows.attach(engine, {
      resolution: film ? 4096 : 2048,
      distance: 900,
      lambda: 0.8,
      lightSize: 0.02,
      normalBias: 0.2,
      casterMargin: 300,
    });
    disposers.push(() => shadows.dispose());
    const view = await BiomeView.attach(engine, w, {
      sky: preset.sky,
      shadows,
      water: { rivers: 'auto' },
      exclusions: plan.town.exclusions,
      radius: film ? 2000 : 1000,
      ...(s.meshes ? { meshes: s.meshes } : {}),
      ...(settings.signal ? { signal: settings.signal } : {}),
    });
    disposers.push(() => view.dispose());
    const clouds = VolumetricClouds.attach(engine, { sky: preset.sky as never, type: 'cumulus', coverage: 0.2 });
    disposers.push(() => clouds.dispose());
    // Fuel: the forest's own fuel models, cleared on the rail, the creek, the streets and the lots (the lots burn as
    // structures).
    const fuel = fuelMap(w, { step: film ? 8 : 16, bare: plan.town.exclusions });
    const weather = new WeatherMachine(weatherState(s.weather, s.windFrom), { seed: s.seed });
    disposers.push(() => weather.dispose());
    let fireFront: FireFront | undefined;
    if (s.fire !== 'none') {
      fireFront = FireFront.attach(engine, {
        ground: height,
        size: [SIZE, SIZE],
        origin: ORIGIN,
        cell: film ? 4 : 8,
        fuel: (x, z) => fuel.at(x, z),
        structures: plan.structures,
        ignitions: plan.ignitions,
        seed: s.seed,
        columns: film ? 12 : 6,
        flames: film ? 24 : 12,
      });
      disposers.push(() => fireFront?.dispose());
    }
    const drive = WeatherDrive.attach(engine, { weather, listener: engine.camera, clouds, ...(fireFront ? { fires: fireFront } : {}) });
    disposers.push(() => drive.dispose?.());
    if (fireFront) {
      rollFire(drive, fireFront, s.fireTime);
      if (s.fire === 'burnt') await fireFront.settle(86400, settings.signal);
    }
    const look = (name: LookFamilyName) =>
      applyLookFamily(name, {
        sky: { sky: preset.sky, clouds, tonemap: preset.tonemap },
        ...(fireFront ? { fire: fireFront as never, smoke: fireFront } : {}),
      });
    look(s.look);
    const anchors = anchorsOf(plan, height);
    const tracks: Record<string, ShotTrack[]> = {};
    for (const shot of info.shots ?? []) {
      const a = anchors[shot.camera[0]],
        b = anchors[shot.camera[shot.camera.length - 1]];
      tracks[shot.name] = [
        {
          type: 'camera',
          id: 'camera',
          path: 'linear',
          keys: [
            { time: 0, position: [...a.position] as Vec3, target: [...a.target] as Vec3, fov: 45 },
            { time: shot.seconds, position: [...b.position] as Vec3, target: [...b.target] as Vec3, fov: 45, ease: 'smoothstep' },
          ],
        },
      ];
    }
    const handle: TimberValleyScene = {
      settings: s,
      height,
      anchors,
      views: info.views,
      view(name, fov = 50) {
        const a = anchors[name];
        if (!a) throw new RangeError(`timber-valley: no anchor ${name}; pass one of ${Object.keys(anchors).join(', ')}.`);
        engine.camera.position = [...a.position] as Vec3;
        engine.camera.target = [...a.target] as Vec3;
        engine.camera.fov = fov;
      },
      shots: info.shots ?? [],
      tracks,
      targets: info.targets ?? {},
      layout: plan,
      applyLook: look,
      applySettings(values) {
        for (const [target, rows] of Object.entries(values)) {
          if (target === 'weather') applyWeatherSettings(weather, { ...weatherRows(weather), ...rows } as never);
          else if (target === 'sky') applySkySettings({ sky: preset.sky, clouds, tonemap: preset.tonemap }, rows as never);
          else if (target === 'fire') {
            if (fireFront) applyFireSettings(fireFront as never, rows as never);
          } else throw new RangeError(`timber-valley: no settings target ${target}; pass weather, sky or fire.`);
        }
      },
      advanceTime(seconds) {
        drive.advanceTime(seconds);
        preset.sky.advanceTime?.(seconds);
        fireFront?.advanceTime(seconds);
      },
      settle: () => view.whenIdle(),
      parts: { world: w, view, preset, clouds, weather, drive, shadows, occlusion, fuel, fireFront },
      dispose() {
        for (const d of disposers.reverse()) d();
        disposers.length = 0;
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    return handle;
  } catch (error) {
    return fail(error);
  }
}

/**
 * Runs a fire's past `seconds` with its weather: the drive and the front step together in 10 s steps, so the front has
 * the weather's wind and the fuel dried by its humidity and temperature from its first second (stepped alone, a front
 * reads no wind until the drive's first frame and burns its past in still air).
 */
export function rollFire(
  drive: { update(delta?: number): unknown; advanceTime(seconds: number): void },
  fire: { advanceTime(seconds: number): void },
  seconds: number,
): void {
  drive.update(0);
  for (let t = 0; t < seconds; t += 10) {
    const step = Math.min(10, seconds - t);
    drive.advanceTime(step);
    fire.advanceTime(step);
  }
}

/** The weather's current state as settings rows, so a shot that keys one row keeps the others. */
function weatherRows(weather: WeatherMachine): Record<string, unknown> {
  const state = weather.state as unknown as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (const row of WEATHER_SETTINGS) if (row.name in state) out[row.name] = state[row.name];
  return out;
}

/** The scene's camera places, from the valley lines and the ground. */
function anchorsOf(plan: TimberValleyLayout, height: (x: number, z: number) => number): Record<string, Anchor> {
  const at = (along: number) => plan.axis[Math.max(0, Math.min(plan.axis.length - 1, Math.round(along / 16)))],
    rail = (along: number) => plan.rail[Math.max(0, Math.min(plan.rail.length - 1, Math.round(along / 16)))] ?? at(along),
    creek = (along: number) => plan.creek[Math.max(0, Math.min(plan.creek.length - 1, Math.round(along / 16)))],
    eye = (p: readonly [number, number], up: number, dx = 0, dz = 0): Vec3 => [
      p[0] + dx,
      Math.max(height(p[0] + dx, p[1] + dz), 0) + up,
      p[1] + dz,
    ],
    fire = plan.ignitions[0].at,
    town = plan.structures[0]?.at ?? rail(700),
    a = (position: Vec3, target: Vec3, about: string): Anchor => ({ position, target, about });
  return {
    'aerial-west': a(eye(at(0), 260), eye(at(1400), 60), 'high over the valley mouth, looking up the valley'),
    'aerial-east': a(eye(at(900), 220), eye(at(2400), 40), 'over the town, looking up the valley'),
    town: a(eye(town, 1.7, -40, 0), eye(town, 2, 60, 0), 'eye level by the town lots, looking up the street'),
    'town-up': a(eye(town, 1.7, 40, 0), eye(town, 30, 160, 300), 'the lots, turning toward the south ridge'),
    rail: a(eye(rail(400), 1.2), eye(rail(800), 1.5), 'on the rail grade, looking up the line'),
    'rail-far': a(eye(rail(600), 1.2), eye(rail(1000), 1.5), 'up the rail grade'),
    creek: a(eye(creek(1200), 1.0, 0, 6), eye(creek(1500), 0.5), 'on the creek bank'),
    'creek-up': a(eye(creek(1300), 1.0, 0, 6), eye(creek(1600), 0.5), 'up the creek'),
    ridge: a(eye(at(1200), 600, 0, -900), eye(at(900), 300, 0, 900), 'the north ridge, across the valley to the south wall'),
    'ridge-pan': a(eye(at(1300), 600, 0, -900), eye(at(500), 300, 0, 600), 'the north ridge, panning toward the fire'),
    'fire-line': a(eye(fire, 80, 500, -200), eye(fire, 40, 0, -100), 'side on to the front on the south wall'),
    'fire-line-near': a(eye(fire, 60, 400, -100), eye(fire, 40, 0, -150), 'closer on the front'),
    blowup: a(eye(town, 3, 120, -40), eye(fire, 200, 0, -200), 'from the valley floor by the town toward the fire'),
    'blowup-push': a(eye(town, 3, 40, -20), eye(fire, 250, 0, -250), 'pushing in toward the fire'),
    aftermath: a(eye(at(500), 40), eye(at(500), 250, 0, 700), 'the burned south wall from the floor'),
    'aftermath-crane': a(eye(at(500), 260), eye(at(700), 120, 0, 700), 'craned up over the burned walls'),
  };
}

/// <reference lib="esnext.disposable" preserve="true" />
// Seasons of a biome world (entry `@margoengine/biomes/seasons`, B9): a per-cell state for one day of the year, read from
// the tile layers a world already makes, in integers, so the same world and day give the same bytes everywhere. Sources:
// the year as a sinusoid between the coldest and warmest month, and degree days as its integral above a base, McMaster
// and Wilhelm 1997 ("Growing degree-days: one equation, two interpretations", the same closed form as climate.ts, here
// clipped to part of the year); snow melt from thaw degree days, Hock 2003 ("Temperature index melt modelling in
// mountain areas", degree-day factors of 2.5 to 6 mm per C day for snow). Our own code from those descriptions.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { degreeDays } from './climate.js';
import { clampInt, divFloor, ONE, qacos, qdiv, qmul, qsqrt, sincos, TURN } from './fixed.js';
import type { RasterLayer } from './layers.js';
import type { BiomeSample } from './sample.js';
import type { BiomeTile, BiomeWorld } from './world.js';

/** pi and 2 pi in Q16 radians (the same pi as climate.ts). */
const PI = 205887,
  TWO_PI = 2 * PI;
/** Mean of the cosine over a month centred on its peak, Q16: warmest = mean + half x MONTH (fields.ts). */
const MONTH = 64790;
/** Growing degree days above 5 C from the spring crossing that give full green-up (255). */
const GREEN_FULL = 200;
/** Melt per thaw degree day: 3 mm of snow water per C day (Hock 2003), in hundredths of a mm. */
const MELT = 300;
/** Snow water in hundredths of a mm that covers the ground fully (255): 50 mm. */
const SNOW_FULL = 5000;
/** Warmest day of the year north and south of the equator (the same days climate.ts uses). */
const WARMEST_NORTH = 201,
  WARMEST_SOUTH = 19;

/** Q16 radians to a 32-bit binary angle (2^32 / 2 pi, Q16). */
const toAngle = (r: number) => Math.floor((r * 683565276) / ONE) | 0;
/** A 32-bit binary angle to Q16 radians (2 pi 2^16 / 2^32). */
const toRadians = (a: number) => Math.floor((a * 411775) / TURN);
const pair = [0, 0];
const sinOf = (angle: number) => sincos(angle, pair)[1];

/**
 * Degree days above `base` (C day) of a sinusoidal year with mean `mean` and half swing `half` (all cK), counted from the
 * coldest day up to `phase`: Q16 radians from the warmest day, -pi (the coldest day) to pi (the coldest day a year on).
 * The integral of `mean + half cos t` clipped to where it is above `base`, in closed form. At `phase` pi it equals the
 * full-year `degreeDays` of the climate maths exactly, and it is 0 before the spring crossing.
 * @example const sinceWinter = degreeDaysSince(1000, 1200, 500, 0); // to the warmest day
 */
export function degreeDaysSince(mean: number, half: number, base: number, phase: number): number {
  const over = mean - base,
    p = clampInt(phase, -PI, PI);
  if (half <= 0 || over >= half || -over >= half) {
    if (!(over > 0 && (half <= 0 || over >= half))) return 0;
    // Above the base all year: over (p + pi) + half sin p.
    const s = half > 0 && p !== PI && p !== -PI ? half * sinOf(toAngle(p)) : 0;
    return Math.max(0, divFloor((over * (p + PI) + s) * 365, TWO_PI * 100));
  }
  // Above the base for |t| < theta: the spring crossing is -theta, the autumn one theta.
  const x = qdiv(-over, half),
    s = qsqrt(ONE - qmul(x, x)),
    theta = qacos(x);
  if (p <= -theta) return 0;
  const end = p >= theta,
    q = end ? theta : p,
    sq = end ? s : sinOf(toAngle(q));
  return Math.max(0, divFloor((over * (q + theta) + half * (sq + s)) * 365, TWO_PI * 100));
}

/** Weather of a season state. Every value is documented with its default. */
export interface SeasonWeather {
  /** Share of the cold season's precipitation that falls and lies as snow, 0..1. Default 1. */
  readonly snowfall?: number;
  /** Rain now, 0 (dry) to 1 (soaked ground): wetness rises from the soil moisture toward 255. Default 0. */
  readonly rain?: number;
}

/** Settings of {@link BiomeSeasons.attach} and {@link BiomeSeasons.set}. */
export interface BiomeSeasonsOptions {
  /** Day of the year, an integer 1..365 (1 is 1 January). Required by `attach`. */
  readonly dayOfYear?: number;
  /** Weather; see {@link SeasonWeather} for the defaults. */
  readonly weather?: SeasonWeather;
}

/** Validates a weather share and quantises it to Q16. */
function share(value: unknown, name: string, fallback: number): number {
  const v = value ?? fallback;
  if (!(typeof v === 'number' && v >= 0 && v <= 1))
    throw rangeError(`BiomeSeasons weather ${name} must be a number from 0 to 1`, 'biomes');
  return Math.round(v * ONE);
}

/**
 * Writes the season state of one cell to `out[k..k+3]`: green-up, senescence, snow and wetness, each 0..255. Inputs are
 * the stored layer values: mean and warmest-month temperature (cK), rainfall (mm per year), soil moisture (0..255), the
 * day's binary angle from the warmest day, and the snowfall and rain shares (Q16).
 */
function cellState(
  mean: number,
  warm: number,
  rain: number,
  moist: number,
  angle: number,
  snowfall: number,
  wet: number,
  out: Uint8Array,
  k: number,
): void {
  const half = Math.max(0, divFloor((warm - mean) * ONE, MONTH)),
    phase = toRadians(angle),
    sin = sinOf(angle),
    over5 = mean - 500;
  // Green-up from the spring crossing of 5 C; senescence from the warmest day to the autumn crossing, as the share of
  // the cooling degree days (half (t - sin t)) between them; bare outside the season.
  let green = 0,
    brown = 0;
  if (half <= 0 || over5 >= half || -over5 >= half) green = over5 > 0 ? 255 : 0;
  else {
    const theta = qacos(qdiv(-over5, half));
    if (phase < -theta || phase > theta) brown = 255;
    else {
      green = Math.min(255, divFloor(degreeDaysSince(mean, half, 500, phase) * 255, GREEN_FULL));
      if (phase > 0)
        brown = clampInt(divFloor((phase - sin) * 255, Math.max(1, theta - sinOf(toAngle(theta)))), 0, 255);
    }
  }
  // Snow water (hundredths of a mm): the precipitation of the days below 0 C since the autumn crossing, then melted by
  // the thaw degree days since the spring crossing. What the summer cannot melt stays as a floor all year, and below
  // 0 C all year the year's precipitation lies. Cover is that water over SNOW_FULL, so a dry cold cell stays thin.
  let water = 0;
  if (snowfall > 0 && rain > 0) {
    if (half <= 0 ? mean <= 0 : mean <= -half) water = Math.floor((rain * 100 * snowfall) / ONE);
    else if (mean < half) {
      const theta = qacos(qdiv(-mean, half)),
        lying = Math.floor((divFloor(rain * (TWO_PI - 2 * theta) * 100, TWO_PI) * snowfall) / ONE);
      water = Math.max(
        lying - MELT * degreeDays(mean, half, 0, pair)[0],
        phase > theta || phase < -theta
          ? Math.floor(
              (divFloor(rain * (phase > theta ? phase - theta : phase + TWO_PI - theta) * 100, TWO_PI) * snowfall) /
                ONE,
            )
          : lying - MELT * degreeDaysSince(mean, half, 0, phase),
        0,
      );
    }
  }
  const snow = Math.min(255, divFloor(water * 255, SNOW_FULL));
  out[k] = green;
  out[k + 1] = brown;
  out[k + 2] = snow;
  out[k + 3] = moist + ((((255 - moist) * wet) / ONE) | 0);
}

const LAYERS_READ = ['temperature', 'warmest', 'rainfall', 'moisture'] as const;

/**
 * The seasons of a biome world for one day: a state per cell, 4 bytes (an `rgba8` raster): R green-up (leaf-out since the
 * spring crossing of 5 C, 255 at 200 C day), G senescence (255 at the autumn crossing and through the dormant season), B
 * snow (255 at 50 mm of snow water) and A wetness (soil moisture raised by `weather.rain`). Counted from the season
 * crossings, so 31 December runs into 1 January without a step; southern-hemisphere worlds are half a year on. It reads
 * the tile layers the world makes and adds none: tiles, placement and their digests are unchanged. Integer maths, so the
 * bytes are the same everywhere.
 * @example
 * using seasons = BiomeSeasons.attach(world, { dayOfYear: 300, weather: { rain: 0.5 } });
 * const state = await seasons.tile(0, 0); // state.data[4 * cell] is the green-up of a cell
 */
export class BiomeSeasons implements Disposable {
  /** The world the states are of. */
  readonly world: BiomeWorld;
  #day = 1;
  #snowfall = ONE;
  #rain = 0;
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #sample?: BiomeSample;

  private constructor(world: BiomeWorld) {
    this.world = world;
  }

  /**
   * Seasons over a world for `dayOfYear`. Synchronous; states are made when read.
   * @throws TypeError without a world or options; RangeError for a day outside 1..365 or a weather share outside 0..1.
   */
  static attach(world: BiomeWorld, options: BiomeSeasonsOptions): BiomeSeasons {
    if (!world || typeof world.tile !== 'function' || typeof options !== 'object' || options === null)
      throw typeError('BiomeSeasons.attach takes a BiomeWorld and { dayOfYear, weather? }', 'biomes');
    const seasons = new BiomeSeasons(world);
    seasons.#apply({ weather: {}, ...options }, true);
    return seasons;
  }

  #apply(options: BiomeSeasonsOptions, needDay: boolean): void {
    const day = options.dayOfYear ?? (needDay ? undefined : this.#day);
    if (!(Number.isInteger(day) && day! >= 1 && day! <= 365))
      throw rangeError('BiomeSeasons dayOfYear must be an integer from 1 to 365', 'biomes');
    const w = options.weather;
    if (w !== undefined && (typeof w !== 'object' || w === null))
      throw typeError('BiomeSeasons weather must be an object such as { snowfall: 1, rain: 0 }', 'biomes');
    const snowfall = w ? share(w.snowfall, 'snowfall', 1) : this.#snowfall,
      rain = w ? share(w.rain, 'rain', 0) : this.#rain;
    this.#day = day!;
    this.#snowfall = snowfall;
    this.#rain = rain;
  }

  #live(): void {
    if (this.#disposed) throw fault('disposed', 'BiomeSeasons is disposed; attach a new one', 'biomes');
  }

  /** Day of the year, 1..365. */
  get dayOfYear(): number {
    return this.#day;
  }

  /** The weather in force, defaults filled in (shares as quantised, 0..1). */
  get weather(): Required<SeasonWeather> {
    return { snowfall: this.#snowfall / ONE, rain: this.#rain / ONE };
  }

  /**
   * Changes the day or the weather; an option left out keeps its value (a `weather` object given resets the shares it
   * leaves out to their defaults). Calls every `onChange` listener.
   * @throws RangeError for a day outside 1..365 or a weather share outside 0..1; nothing changes then.
   */
  set(options: BiomeSeasonsOptions): void {
    this.#live();
    if (typeof options !== 'object' || options === null)
      throw typeError('BiomeSeasons set takes { dayOfYear?, weather? }', 'biomes');
    this.#apply(options, false);
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Calls `listener` after each {@link set}, until the returned function is called or the seasons are disposed.
   * @throws TypeError when `listener` is not a function.
   */
  onChange(listener: () => void): () => void {
    this.#live();
    if (typeof listener !== 'function') throw typeError('BiomeSeasons onChange takes a function', 'biomes');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The day's binary angle from this world's warmest day. */
  #angle(): number {
    const warmest = this.world.climate.latitude < 0 ? WARMEST_SOUTH : WARMEST_NORTH;
    return Math.floor(((this.#day - warmest) * TURN) / 365) | 0;
  }

  /**
   * The state of every cell of a tile the world made: an `rgba8` raster named `'seasons'`, `cells` x `cells`, one texel
   * per cell, rows of increasing z.
   * @throws RangeError when the tile lacks a layer the seasons read (temperature, warmest, rainfall, moisture).
   */
  stateOf(tile: BiomeTile): RasterLayer {
    this.#live();
    const read = LAYERS_READ.map((name) => tile?.layer?.(name)?.data);
    if (read.some((data) => !data))
      throw rangeError(
        'BiomeSeasons reads the temperature, warmest, rainfall and moisture layers; request the tile with them',
        'biomes',
      );
    const [mean, warm, rain, moist] = read as ArrayLike<number>[],
      n = tile.cells * tile.cells,
      data = new Uint8Array(n * 4),
      angle = this.#angle();
    for (let i = 0; i < n; i++)
      cellState(mean[i], warm[i], rain[i], moist[i], angle, this.#snowfall, this.#rain, data, 4 * i);
    return Object.freeze({
      name: 'seasons',
      format: 'rgba8',
      width: tile.cells,
      depth: tile.cells,
      data,
      scale: 1 / 255,
      unit: '0..1',
    }) as RasterLayer;
  }

  /**
   * The state of tile (x, z), made by the world on first use ({@link stateOf} of `world.tile(x, z)`).
   * Rejects with the signal's reason when aborted.
   */
  async tile(x: number, z: number, options: { readonly signal?: AbortSignal } = {}): Promise<RasterLayer> {
    this.#live();
    const tile = await this.world.tile(x, z, { signal: options.signal });
    return this.stateOf(tile);
  }

  /**
   * The state at world (x, z) in metres, synchronous, from the world's region fields (`sampleRegion`, so the same
   * whatever tiles were made): 4 bytes, green-up, senescence, snow and wetness.
   * @throws RangeError for a non-finite x or z.
   */
  at(x: number, z: number, out: Uint8Array = new Uint8Array(4)): Uint8Array {
    this.#live();
    return this.#state(this.world.sampleRegion(x, z), out);
  }

  /** The state of a region sample into `out`. */
  #state(s: BiomeSample, out: Uint8Array): Uint8Array {
    cellState(
      Math.round(s.temperature * 100),
      Math.round(s.warmest * 100),
      Math.round(s.rainfall),
      Math.round(s.moisture * 255),
      this.#angle(),
      this.#snowfall,
      this.#rain,
      out,
      0,
    );
    return out;
  }

  /**
   * {@link seasonalColor} of `base` under the state at world (x, z): how `BiomeView` and `BiomeObjects` tint seasonal
   * ground and foliage.
   */
  colorAt(base: readonly [number, number, number], x: number, z: number): [number, number, number] {
    return seasonalColor(base, this.at(x, z));
  }

  /**
   * The ground tint at world (x, z), 4 bytes for an `rgba8unorm-srgb` texel: RGB is the linear colour of
   * {@link seasonalMix} there, each channel encoded with the sRGB transfer function and rounded to a byte, and A is the
   * linear amount times 255. A texture of these decodes to that linear colour, so mixing a decoded linear colour toward
   * it by the amount gives {@link seasonalColor} of that colour under the state there. The amount is scaled by the share
   * of the biomes there with `tint.seasonal`, so it is 0 where no biome follows the seasons. `BiomeView` draws plant
   * cover ground through a texture of these.
   * @throws RangeError for a non-finite x or z.
   */
  tintAt(x: number, z: number, out: Uint8Array = new Uint8Array(4)): Uint8Array {
    this.#live();
    const s = (this.#sample = this.world.sampleRegion(x, z, this.#sample)),
      mix = seasonalMix(this.#state(s, out));
    let share = 0;
    s.biomes.forEach((id, i) => {
      if (this.isSeasonal(id)) share += s.weights[i];
    });
    for (let c = 0; c < 3; c++) {
      const v = mix[c];
      out[c] = Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
    }
    out[3] = Math.round(mix[3] * Math.min(1, share) * 255);
    return out;
  }

  /**
   * Whether a biome of the world follows the seasons: the biome itself (`tint.seasonal`), or, given a species id, that
   * species (`color.seasonal`) or its biome. False for an id the world does not hold.
   */
  isSeasonal(biome: string, species?: string): boolean {
    const b = this.world.biomes.find((d) => d.id === biome);
    if (!b) return false;
    if (b.tint?.seasonal) return true;
    if (species === undefined) return false;
    return !![...(b.plants ?? []), ...(b.rocks ?? []), ...(b.props ?? [])].find((s) => s.id === species)?.color
      ?.seasonal;
  }

  /** Stops the listeners; later calls throw MargoError `'disposed'`. Safe to call twice. */
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  /** Same as {@link dispose}, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Colours a season state moves toward (linear RGB): autumn leaves, dormant straw and bark, and snow. */
const AUTUMN = [0.62, 0.33, 0.1],
  DORMANT = [0.42, 0.35, 0.24],
  SNOW = [0.95, 0.96, 0.99];

/**
 * A base colour (linear RGB, 0..1) under a season state (4 bytes at `offset`, as {@link BiomeSeasons}
 * makes): senescence turns it toward autumn orange, the leafless share (255 minus green-up) toward dormant straw, ground
 * wetter than one half darkens it by up to 30 %, and snow whitens it. Full green-up with no senescence, snow or extra
 * wetness gives the base back. Species with `color.seasonal` and biomes with `tint.seasonal` are drawn through it.
 * @example const leaf = seasonalColor([0.14, 0.3, 0.05], seasons.at(0, 0));
 */
export function seasonalColor(
  base: readonly [number, number, number],
  state: ArrayLike<number>,
  offset = 0,
): [number, number, number] {
  const green = state[offset] / 255,
    brown = state[offset + 1] / 255,
    snow = state[offset + 2] / 255,
    dark = 1 - 0.3 * Math.max(0, (state[offset + 3] - 128) / 127);
  return [0, 1, 2].map((c) => {
    const leaf = base[c] + (AUTUMN[c] - base[c]) * brown,
      plant = DORMANT[c] + (leaf - DORMANT[c]) * green,
      wet = plant * dark;
    return wet + (SNOW[c] - wet) * snow;
  }) as [number, number, number];
}

/**
 * {@link seasonalColor} as one mix for any base: `[r, g, b, amount]` such that `base + (rgb - base) * amount` is
 * `seasonalColor(base, state, offset)`, so a shader can apply a season state to every texel of a texture. All in linear
 * RGB: the colour is a blend of the autumn, dormant and snow colours and black (wet darkening), each 0..1; amount 0
 * gives black and keeps the base. Mix in linear light, as the terrain does with decoded sRGB textures.
 * @example const [r, g, b, amount] = seasonalMix(seasons.at(0, 0));
 */
export function seasonalMix(state: ArrayLike<number>, offset = 0): [number, number, number, number] {
  const green = state[offset] / 255,
    brown = state[offset + 1] / 255,
    snow = state[offset + 2] / 255,
    dark = 1 - 0.3 * Math.max(0, (state[offset + 3] - 128) / 127),
    amount = 1 - (1 - brown) * green * dark * (1 - snow);
  return [
    ...[0, 1, 2].map((c) =>
      amount > 0
        ? ((AUTUMN[c] * brown * green + DORMANT[c] * (1 - green)) * dark * (1 - snow) + SNOW[c] * snow) / amount // float division: material colour only
        : 0,
    ),
    amount,
  ] as [number, number, number, number];
}

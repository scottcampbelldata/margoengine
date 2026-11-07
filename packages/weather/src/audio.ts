/// <reference lib="esnext.disposable" preserve="true" />
// Weather you can hear: a rain layer, a wind layer and thunder, as sounds of `@margoengine/audio` that follow a weather
// state. Rain and wind are looping noise shaped by filters (or your own recordings), their volume and colour set from
// the state every update; thunder is a one-shot rumble per strike, as loud and as long as the strike says. The noise
// is generated in code, so the layers work with no audio files at all.
import { Audio, type AudioListener } from '@margoengine/audio';
import { MargoError } from '@margoengine/math/errors';
import type { WeatherState } from './state.js';

/** What the sounds follow: a `WeatherMachine` (its `state`), or any object with one. */
export interface AudioWeatherSource {
  /** The weather now. */
  readonly state: WeatherState;
}

/** A strike to hear: `@margoengine/sky`'s `Weather.onThunder` passes one. */
export interface ThunderStrike {
  /** 0 to 1: how loud it arrives (falls with distance). */
  readonly loudness: number;
  /** Seconds the rumble lasts. */
  readonly rumble: number;
}

/** {@link WeatherAudio} settings, read at every update from `sounds.options`. */
export interface WeatherAudioOptions {
  /** The weather to follow. */
  weather: AudioWeatherSource;
  /** Overall volume, 0 to 4. Default 1. */
  volume?: number;
  /** Volume of the rain at full rain, 0 to 4. Default 0.6. */
  rain?: number;
  /** Volume of the wind at 25 m/s, 0 to 4. Default 0.5. */
  wind?: number;
  /** Volume of a thunder strike at loudness 1, 0 to 4. Default 1. */
  thunder?: number;
  /** Your own looping recordings to use instead of the generated noise. Default none. */
  buffers?: { rain?: AudioBuffer; wind?: AudioBuffer; thunder?: AudioBuffer };
  /** Seed of the generated noise. Default 1. */
  seed?: number;
}

const RANGES: Record<string, readonly [number, number]> = {
  volume: [0, 4],
  rain: [0, 4],
  wind: [0, 4],
  thunder: [0, 4],
  seed: [0, 4294967295],
};

/** Throws for any invalid field of `o`. */
export function validateWeatherAudio(o: WeatherAudioOptions): void {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('WeatherAudio options must be an object; pass {weather: machine}');
  if (typeof o.weather !== 'object' || o.weather === null || typeof o.weather.state !== 'object')
    throw new TypeError('WeatherAudio weather needs a state; pass a WeatherMachine');
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = (o as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new RangeError(`WeatherAudio ${key} must be a number from ${min} to ${max}; pass a finite value in range`);
  }
}

/** The levels and filter settings the layers take from a state; exported so you can drive your own sounds the same way. */
export interface WeatherAudioMix {
  /** Rain layer gain, 0 and up. */
  rain: number;
  /** Rain low-pass cutoff in hertz: brighter and harder with hail. */
  rainCutoff: number;
  /** Wind layer gain, 0 and up. */
  wind: number;
  /** Wind band-pass centre in hertz: higher as the wind rises. */
  windCentre: number;
}

/**
 * The mix for a state. Rain: its volume times rain to the power 0.7 (loudness grows faster than intensity at first,
 * as the patter of a drizzle is already heard), hail adding half its share; the cutoff rises from 2.5 to 8 kHz with
 * the hail. Wind: its volume times (speed / 25) to the power 1.5, gusts lifting it by up to a third, capped at twice
 * the volume; the band centre rises from 250 Hz with 30 Hz per m/s.
 */
export function weatherAudioMix(state: WeatherState, o: Partial<WeatherAudioOptions> = {}): WeatherAudioMix {
  const all = o.volume ?? 1,
    wet = Math.min(1, state.rain + 0.5 * state.hail),
    blow = state.wind / 25;
  return {
    rain: all * (o.rain ?? 0.6) * wet ** 0.7,
    rainCutoff: 2500 + 5500 * state.hail,
    wind: all * (o.wind ?? 0.5) * Math.min(2, blow ** 1.5 * (1 + state.gust / 3)),
    windCentre: 250 + 30 * state.wind,
  };
}

/** Uniform random numbers in -1..1 from a seed (a 32-bit linear congruential generator). */
function noise(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 2147483648 - 1;
  }
  return out;
}

/**
 * The generated sounds, as sample arrays at `rate`: two seconds of rain hiss that loops without a seam (white noise; the
 * layer's filter colours it), two seconds of wind (brown noise, leaky-integrated white noise, normalised) and a
 * thunder rumble `seconds` long (brown noise under a fast attack and an exponential fall, with a crack at the start).
 */
export function weatherNoise(
  rate: number,
  seed = 1,
  seconds = 6,
): { rain: Float32Array; wind: Float32Array; thunder: Float32Array } {
  const n = Math.round(rate * 2),
    rain = noise(n, seed),
    white = noise(n, seed + 1),
    wind = new Float32Array(n);
  // Brown noise for the wind, made periodic by removing the drift between the ends so it loops cleanly.
  let level = 0,
    peak = 0;
  for (let i = 0; i < n; i++) wind[i] = level = level * 0.995 + white[i] * 0.1;
  const drift = (wind[n - 1] - wind[0]) / (n - 1);
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((wind[i] -= drift * i)));
  for (let i = 0; i < n; i++) wind[i] /= peak || 1;
  const m = Math.round(rate * seconds),
    thunder = new Float32Array(m),
    source = noise(m, seed + 2);
  level = 0;
  peak = 0;
  for (let i = 0; i < m; i++) {
    const t = i / rate;
    level = level * 0.998 + source[i] * 0.06;
    const envelope = Math.min(1, t / 0.02) * Math.exp((-3 * t) / seconds);
    thunder[i] = (level + (t < 0.15 ? source[i] * (1 - t / 0.15) : 0)) * envelope;
    peak = Math.max(peak, Math.abs(thunder[i]));
  }
  for (let i = 0; i < m; i++) thunder[i] /= peak || 1;
  return { rain, wind, thunder };
}

/**
 * Rain, wind and thunder that follow a weather state, through `@margoengine/audio`. `WeatherAudio.attach(engine,
 * listener, options)` follows the weather every frame; without an engine call `update()` yourself. Call
 * `thunder(strike)` from the sky Weather's `onThunder`.
 * @throws TypeError / RangeError on invalid options; MargoError `'disposed'` after `dispose()`.
 * @example
 * const sounds = new WeatherAudio(listener, {weather: machine});
 * weather.onThunder((strike) => sounds.thunder(strike));
 */
export class WeatherAudio {
  readonly name: string = 'weather-audio';
  /** The rain layer: an `Audio` you may filter or route further. */
  readonly rainSound: Audio;
  /** The wind layer. */
  readonly windSound: Audio;
  private readonly rainFilter: BiquadFilterNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly rumbles = new Set<Audio>();
  private thunderBuffer?: AudioBuffer;
  private disposed = false;

  constructor(
    readonly listener: AudioListener,
    readonly options: WeatherAudioOptions,
  ) {
    validateWeatherAudio(options);
    const context = listener.context,
      made = options.buffers?.rain && options.buffers.wind ? undefined : weatherNoise(context.sampleRate, options.seed);
    const buffer = (data: Float32Array): AudioBuffer => {
      const b = context.createBuffer(1, data.length, context.sampleRate);
      b.getChannelData(0).set(data);
      return b;
    };
    this.rainFilter = context.createBiquadFilter();
    this.rainFilter.type = 'lowpass';
    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.8;
    this.rainSound = new Audio(listener, { loop: true, volume: 0, filters: [this.rainFilter] }).setBuffer(
      options.buffers?.rain ?? buffer(made!.rain),
    );
    this.windSound = new Audio(listener, { loop: true, volume: 0, filters: [this.windFilter] }).setBuffer(
      options.buffers?.wind ?? buffer(made!.wind),
    );
    this.thunderBuffer = options.buffers?.thunder;
    this.update();
    this.rainSound.play();
    this.windSound.play();
  }

  /** Makes the sounds and adds them to an engine (anything with `use`), so the layers follow the weather every frame. */
  static attach(
    engine: { use(plugin: WeatherAudio): unknown },
    listener: AudioListener,
    options: WeatherAudioOptions,
  ): WeatherAudio {
    const sounds = new WeatherAudio(listener, options);
    engine.use(sounds);
    return sounds;
  }

  /** Sets the layers from the weather's state now. */
  update(): WeatherAudioMix {
    if (this.disposed) throw new MargoError('disposed', 'WeatherAudio is disposed; create a new WeatherAudio');
    validateWeatherAudio(this.options);
    const mix = weatherAudioMix(this.options.weather.state, this.options);
    this.rainSound.volume = mix.rain;
    this.windSound.volume = mix.wind;
    this.rainFilter.frequency.value = mix.rainCutoff;
    this.windFilter.frequency.value = mix.windCentre;
    return mix;
  }

  /** Engine plugin hooks: attach with `engine.use(sounds)` and the layers follow the weather every frame. */
  setup(): void {}
  onPreUpdate(): void {
    this.update();
  }

  /**
   * Plays one thunder rumble: `strike.loudness` times the thunder volume, `strike.rumble` seconds long (your thunder
   * recording plays at a rate that fits it to that length). Returns the sound, which disposes itself at its end.
   */
  thunder(strike: ThunderStrike): Audio {
    if (this.disposed) throw new MargoError('disposed', 'WeatherAudio is disposed; create a new WeatherAudio');
    if (
      typeof strike !== 'object' ||
      strike === null ||
      !Number.isFinite(strike.loudness) ||
      !Number.isFinite(strike.rumble) ||
      strike.rumble <= 0
    )
      throw new RangeError(
        'WeatherAudio thunder needs {loudness, rumble} with a rumble of more than 0 seconds; pass the sky Weather strike',
      );
    const context = this.listener.context,
      seconds = Math.min(30, strike.rumble);
    let buffer = this.thunderBuffer,
      rate = 1;
    if (buffer) rate = Math.min(4, Math.max(0.25, buffer.duration / seconds));
    else {
      const data = weatherNoise(context.sampleRate, (this.options.seed ?? 1) + this.rumbles.size + 7, seconds).thunder;
      buffer = context.createBuffer(1, data.length, context.sampleRate);
      buffer.getChannelData(0).set(data);
    }
    const all = this.options.volume ?? 1,
      sound = new Audio(this.listener, {
        volume: all * (this.options.thunder ?? 1) * Math.min(1, Math.max(0, strike.loudness)),
        playbackRate: rate,
        onEnded: (a) => {
          this.rumbles.delete(a);
          a.dispose();
        },
      }).setBuffer(buffer);
    this.rumbles.add(sound);
    return sound.play();
  }

  /** Rumbles still sounding. */
  get playing(): number {
    return this.rumbles.size;
  }

  /** Stops and disposes every sound. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sound of this.rumbles) sound.dispose();
    this.rumbles.clear();
    this.rainSound.dispose();
    this.windSound.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

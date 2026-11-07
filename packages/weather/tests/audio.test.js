// WeatherAudio through @margoengine/audio on the audio package's own Web Audio stand-in: layers follow the state, the
// mix formulas, thunder one-shots that dispose themselves, and the generated noise. A real OfflineAudioContext renders
// the layers in browser-check.mjs audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '@margoengine/audio';
import { FakeAudioContext, FakeParam } from '../../audio/tests/fake-web-audio.js';
import { WeatherAudio, validateWeatherAudio, weatherAudioMix, weatherNoise } from '../dist/audio.js';
import { WEATHER_PRESETS } from '../dist/index.js';

// The stand-in records graphs; filters here also need Q, and buffers their samples.
class Context extends FakeAudioContext {
  constructor() {
    super({ state: 'running' });
  }
  createBiquadFilter() {
    const node = super.createBiquadFilter();
    node.Q = new FakeParam(1);
    node.type = 'lowpass';
    return node;
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { ...super.createBuffer(channels, length, sampleRate), getChannelData: () => data };
  }
}
const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);

test('the mix: rain to the power 0.7 with hail, wind to the power 1.5 with gusts, brighter and higher as they grow', () => {
  const calm = weatherAudioMix(WEATHER_PRESETS.clear);
  assert.equal(calm.rain, 0);
  near(calm.wind, 0.5 * (2 / 25) ** 1.5 * (1 + 0.1 / 3));
  const storm = weatherAudioMix(WEATHER_PRESETS.hail, { volume: 2, rain: 1 });
  near(storm.rain, 2 * Math.min(1, 0.3 + 0.4) ** 0.7);
  near(storm.rainCutoff, 2500 + 5500 * 0.8);
  near(storm.windCentre, 250 + 30 * 14);
  assert.ok(weatherAudioMix(WEATHER_PRESETS.blizzard).wind <= 2 * 0.5, 'wind is capped at twice its volume');
  assert.ok(weatherAudioMix(WEATHER_PRESETS.drizzle).rain > 0.6 * 0.2, 'a drizzle is heard above its share');
});

test('the layers follow the state through @margoengine/audio sounds', () => {
  const context = new Context(),
    listener = new AudioListener({ context, smoothing: 0 }),
    weather = { state: { ...WEATHER_PRESETS.clear } },
    sounds = new WeatherAudio(listener, { weather });
  assert.equal(sounds.rainSound.isPlaying, true);
  assert.equal(sounds.windSound.isPlaying, true);
  assert.equal(sounds.rainSound.loop, true);
  assert.equal(sounds.rainSound.volume, 0);
  weather.state = { ...WEATHER_PRESETS.storm };
  const mix = sounds.update();
  near(sounds.rainSound.volume, mix.rain);
  near(sounds.windSound.volume, mix.wind);
  assert.equal(mix.rain, weatherAudioMix(WEATHER_PRESETS.storm).rain);
  sounds.options.volume = 0;
  sounds.onPreUpdate();
  assert.equal(sounds.rainSound.volume, 0);
  sounds.dispose();
  assert.throws(
    () => sounds.update(),
    (e) => e.code === 'disposed',
  );
});

test('thunder plays one rumble a strike, as loud as the strike, and disposes it at its end', () => {
  const context = new Context(),
    listener = new AudioListener({ context, smoothing: 0 }),
    sounds = new WeatherAudio(listener, { weather: { state: WEATHER_PRESETS.thunderstorm }, thunder: 0.8 });
  const a = sounds.thunder({ loudness: 0.5, rumble: 3 });
  sounds.thunder({ loudness: 2, rumble: 1 });
  assert.equal(sounds.playing, 2);
  near(a.volume, 0.4);
  assert.equal(a.isPlaying, true);
  assert.throws(() => sounds.thunder({ loudness: 1, rumble: 0 }), RangeError);
  assert.throws(() => sounds.thunder(null), RangeError);
  // The stand-in's sources end when told to: the rumble disposes itself.
  for (const source of context.bufferSources) source.onended?.();
  assert.equal(sounds.playing, 0);
  sounds.dispose();
});

test('the generated noise: seeded, bounded, the rain and wind loop, the thunder falls away', () => {
  const a = weatherNoise(8000, 3),
    b = weatherNoise(8000, 3),
    c = weatherNoise(8000, 4);
  assert.deepEqual(a.rain, b.rain);
  assert.notDeepEqual(a.rain, c.rain);
  assert.equal(a.rain.length, 16000);
  for (const x of [...a.rain, ...a.wind, ...a.thunder]) assert.ok(x >= -1 && x <= 1);
  // A seamless loop: the jump from the last sample to the first is no larger than a step inside the wind.
  let step = 0;
  for (let i = 1; i < a.wind.length; i++) step = Math.max(step, Math.abs(a.wind[i] - a.wind[i - 1]));
  assert.ok(Math.abs(a.wind[0] - a.wind.at(-1)) <= step);
  const rms = (x, from, to) => Math.sqrt(x.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));
  assert.ok(
    rms(a.thunder, 0, 4000) > 4 * rms(a.thunder, a.thunder.length - 4000, a.thunder.length),
    'the rumble dies away',
  );
});

test('options are checked by name and range', () => {
  const weather = { state: WEATHER_PRESETS.clear };
  validateWeatherAudio({ weather });
  assert.throws(() => validateWeatherAudio({}), /weather needs a state/);
  assert.throws(() => validateWeatherAudio({ weather, volume: 5 }), /volume must be a number from 0 to 4/);
  assert.throws(() => validateWeatherAudio(null), TypeError);
});

test('attach adds the sounds to an engine, whose frames update them', () => {
  const used = [],
    weather = { state: { ...WEATHER_PRESETS.clear } };
  const sounds = WeatherAudio.attach(
    { use: (p) => used.push(p) },
    new AudioListener({ context: new Context(), smoothing: 0 }),
    { weather },
  );
  assert.deepEqual(used, [sounds]);
  weather.state = { ...WEATHER_PRESETS.rain };
  used[0].onPreUpdate();
  near(sounds.rainSound.volume, weatherAudioMix(WEATHER_PRESETS.rain).rain);
  sounds.dispose();
});

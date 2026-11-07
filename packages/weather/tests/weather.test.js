// The weather state machine, presets, blending, schedule and random walk, ground wetness and snow, the wind field,
// surface formulas, the helpers that drive the sky, and Hail without a GPU. Property and fuzz tests included.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_FIELDS,
  TEMPERATE,
  WEATHER_PRESETS,
  WeatherMachine,
  WindField,
  applyWetness,
  assertState,
  blendStates,
  fogDensity,
  hailSettings,
  resolveState,
  settledGround,
  skyWeather,
  snowWeight,
  surfaceResponse,
  surfaceWGSL,
  valueNoise,
  wetColor,
  wetRoughness,
  windAt,
} from '../dist/index.js';
import { Hail, hailCycle, validateHail } from '../dist/hail.js';

const near = (a, b, tolerance = 1e-9, message = '') =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message} ${a} vs ${b}`);
const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const inRange = (state) => {
  for (const [key, [min, max]] of Object.entries(STATE_FIELDS)) {
    assert.ok(Number.isFinite(state[key]) && state[key] >= min && state[key] <= max, `${key} = ${state[key]}`);
  }
};

test('every preset is a complete valid state', () => {
  const names = Object.keys(WEATHER_PRESETS);
  assert.ok(names.length >= 12);
  for (const name of names) {
    assertState(WEATHER_PRESETS[name], name);
    assert.ok(Object.isFrozen(WEATHER_PRESETS[name]));
  }
  assert.equal(WEATHER_PRESETS.clear.rain, 0);
  assert.ok(WEATHER_PRESETS.thunderstorm.lightning > 0.5);
  assert.ok(WEATHER_PRESETS.hail.hail > 0.5);
  assert.ok(WEATHER_PRESETS.blizzard.wind > WEATHER_PRESETS.snow.wind);
  // The default chain only names presets that exist.
  for (const [from, row] of Object.entries(TEMPERATE)) {
    assert.ok(from in WEATHER_PRESETS);
    for (const to of Object.keys(row)) assert.ok(to in WEATHER_PRESETS, `${from} -> ${to}`);
  }
});

test('resolveState and assertState name the field and the fix', () => {
  assert.deepEqual(resolveState('rain'), { ...WEATHER_PRESETS.rain });
  assert.deepEqual(resolveState({ rain: 0.5 }, WEATHER_PRESETS.snow), { ...WEATHER_PRESETS.snow, rain: 0.5 });
  assert.throws(() => resolveState('sunny'), {
    name: 'TypeError',
    message: /Unknown weather preset "sunny"; use one of/,
  });
  assert.throws(() => resolveState({ rain: 2 }), {
    name: 'RangeError',
    message: /rain must be a finite number from 0 to 1/,
  });
  assert.throws(() => resolveState({ rain: NaN }), RangeError);
  assert.throws(() => resolveState({ drizzle: 1 }), { name: 'TypeError', message: /Unknown weather field "drizzle"/ });
  assert.throws(() => resolveState(null), TypeError);
  assert.throws(() => resolveState(5), TypeError);
  assert.throws(() => assertState({ ...WEATHER_PRESETS.rain, wind: '5' }), TypeError);
  assert.throws(() => assertState({ ...WEATHER_PRESETS.rain, wind: 61 }), RangeError);
});

test('blend: endpoints, smoothstep midpoint, linear, clamping, shortest wind turn', () => {
  const a = WEATHER_PRESETS.clear,
    b = WEATHER_PRESETS.storm;
  assert.deepEqual(blendStates(a, b, 0), { ...a });
  assert.deepEqual(blendStates(a, b, 1), { ...b });
  near(blendStates(a, b, 0.5).rain, b.rain / 2);
  near(blendStates(a, b, 0.25, 'linear').rain, b.rain * 0.25);
  near(blendStates(a, b, 0.25).rain, b.rain * (0.0625 * (3 - 0.5)));
  assert.deepEqual(blendStates(a, b, -3), { ...a });
  assert.deepEqual(blendStates(a, b, 9), { ...b });
  assert.deepEqual(blendStates(a, b, NaN), { ...a });
  const west = { ...a, windDirection: 3.0 },
    east = { ...a, windDirection: -3.0 };
  // From 3.0 to -3.0 the short way crosses pi (a turn of 0.28 rad), not through 0.
  const mid = blendStates(west, east, 0.5, 'linear').windDirection;
  near(Math.abs(Math.abs(mid) - Math.PI), 0, 0.01);
});

test('transitionTo blends over time and reports start and arrive once each', () => {
  const machine = new WeatherMachine('clear'),
    events = [];
  machine.on((e) => events.push([e.type, e.preset]));
  machine.transitionTo('rain', { seconds: 10 });
  assert.deepEqual(events, [['start', 'rain']]);
  assert.equal(machine.transitioning, true);
  machine.update(5);
  near(machine.state.rain, WEATHER_PRESETS.rain.rain / 2, 1e-9);
  near(machine.progress, 0.5);
  machine.update(4.99);
  assert.equal(events.length, 1);
  machine.update(0.02);
  assert.deepEqual(events, [
    ['start', 'rain'],
    ['arrive', 'rain'],
  ]);
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.rain });
  assert.equal(machine.transitioning, false);
  machine.update(100);
  assert.equal(events.length, 2);
});

test('an interrupted transition continues from where the weather is (no jump)', () => {
  const machine = new WeatherMachine('clear');
  machine.transitionTo('storm', { seconds: 20 });
  machine.update(8);
  const before = machine.state;
  machine.transitionTo('snow', { seconds: 20 });
  assert.deepEqual(machine.state, before, 'state unchanged at the moment of interruption');
  machine.update(1e-6);
  near(machine.state.rain, before.rain, 1e-6);
  machine.update(20);
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.snow });
});

test('a partial target keeps the other fields; seconds 0 jumps and still fires both events', () => {
  const machine = new WeatherMachine('rain'),
    types = [];
  machine.on((e) => types.push(e.type));
  machine.transitionTo({ wind: 30 }, { seconds: 0 });
  assert.deepEqual(types, ['start', 'arrive']);
  assert.equal(machine.state.wind, 30);
  assert.equal(machine.state.rain, WEATHER_PRESETS.rain.rain);
  machine.set('fog');
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.fog });
  assert.equal(machine.transitioning, false);
});

test('a long delta equals the same time in small steps', () => {
  const a = new WeatherMachine('clear'),
    b = new WeatherMachine('clear');
  for (const m of [a, b]) m.transitionTo('blizzard', { seconds: 40 });
  a.update(137);
  for (let i = 0; i < 137 * 10; i++) b.update(0.1);
  for (const key of Object.keys(STATE_FIELDS)) near(a.state[key], b.state[key], 1e-6, key);
  // The ground follows the state in steps of at most 5 s, so it matches fine steps to about 1 percent.
  near(a.snowCover, b.snowCover, 0.02);
  near(a.wetness, b.wetness, 0.02);
});

test('wetness rises under rain and hail, dries after; snow cover builds and melts; both stay in 0..1', () => {
  const machine = new WeatherMachine('rain');
  let last = 0;
  for (let i = 0; i < 60; i++) {
    machine.update(1);
    assert.ok(machine.wetness >= last - 1e-12);
    last = machine.wetness;
  }
  assert.ok(machine.wetness > 0.8 && machine.wetness <= 0.9, `wet after a minute of rain: ${machine.wetness}`);
  machine.set('clear');
  machine.update(30);
  const drying = machine.wetness;
  assert.ok(drying < 0.8 && drying > 0.4, `dries slowly: ${drying}`);
  machine.update(600);
  assert.ok(machine.wetness < 0.01);
  const hail = new WeatherMachine('hail');
  hail.update(120);
  assert.ok(hail.wetness > 0.9);
  const snow = new WeatherMachine('snow');
  snow.update(300);
  const covered = snow.snowCover;
  assert.ok(covered > 0.4 && covered <= WEATHER_PRESETS.snow.snow, `snow cover ${covered}`);
  snow.set('clear');
  snow.update(1500);
  assert.ok(snow.snowCover < covered / 10);
  assert.equal(snow.update(0).rain, 0);
});

test('schedule runs steps in order with holds, loops, and stops at the end', () => {
  const machine = new WeatherMachine('clear'),
    arrived = [];
  machine.on((e) => e.type === 'arrive' && arrived.push([e.preset, Math.round(machine.time)]));
  machine.schedule(
    [
      { to: 'rain', seconds: 10, hold: 20 },
      { to: 'snow', seconds: 5, hold: 10 },
    ],
    { loop: false },
  );
  machine.update(200);
  assert.deepEqual(arrived, [
    ['rain', 10],
    ['snow', 35],
  ]);
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.snow });
  const looped = new WeatherMachine('clear'),
    seen = [];
  looped.on((e) => e.type === 'arrive' && seen.push(e.preset));
  looped.schedule(
    [
      { to: 'rain', seconds: 1, hold: 1 },
      { to: 'fog', seconds: 1, hold: 1 },
    ],
    { loop: true },
  );
  looped.update(9.5);
  assert.deepEqual(seen, ['rain', 'fog', 'rain', 'fog', 'rain']);
  looped.stop();
  looped.update(100);
  assert.equal(seen.length, 5);
});

test('schedule and transitions are validated before anything changes', () => {
  const machine = new WeatherMachine('clear');
  assert.throws(() => machine.schedule([]), RangeError);
  assert.throws(() => machine.schedule([{ to: 'nope' }]), TypeError);
  assert.throws(() => machine.schedule([{ to: 'rain', hold: -1 }]), RangeError);
  assert.throws(() => machine.schedule([{ to: 'rain', seconds: 0, hold: 0 }], { loop: true }), RangeError);
  assert.throws(() => machine.transitionTo('rain', { seconds: -1 }), RangeError);
  assert.throws(() => machine.transitionTo('rain', { ease: 'bounce' }), TypeError);
  assert.throws(() => machine.update(-1), RangeError);
  assert.throws(() => machine.update(NaN), RangeError);
  assert.throws(() => machine.on(5), TypeError);
  assert.equal(machine.transitioning, false, 'a refused call starts nothing');
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.clear });
});

test('a listener cannot change the weather it is called from', () => {
  const machine = new WeatherMachine('clear');
  machine.on(() => machine.transitionTo('rain'));
  assert.throws(() => machine.transitionTo('snow'), { name: 'MargoError', code: 'state' });
});

test('random walk follows the chain, is deterministic for a seed, and different for another', () => {
  const run = (seed) => {
    const machine = new WeatherMachine('clear'),
      path = [];
    machine.on((e) => e.type === 'arrive' && path.push(e.preset));
    machine.randomWalk('clear', { seed, hold: [10, 30], blend: [5, 10] });
    machine.update(20000);
    return path;
  };
  const a = run(7),
    b = run(7),
    c = run(8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.length > 100);
  assert.equal(a[0], 'clear');
  for (let i = 1; i < a.length; i++)
    assert.ok(a[i] in TEMPERATE[a[i - 1]], `${a[i - 1]} -> ${a[i]} is not in the chain`);
  assert.ok(new Set(a).size >= 6, 'it visits a variety of weather');
});

test('a walk that reaches a preset with no way out stops there', () => {
  const machine = new WeatherMachine('clear');
  machine.randomWalk('clear', { chain: { clear: { fog: 1 } }, hold: [1, 1], blend: [1, 1] });
  machine.update(100);
  assert.deepEqual(machine.state, { ...WEATHER_PRESETS.fog });
  assert.equal(machine.transitioning, false);
});

test('randomWalk validates its settings', () => {
  const machine = new WeatherMachine();
  assert.throws(() => machine.randomWalk('sunny'), TypeError);
  assert.throws(() => machine.randomWalk('clear', { hold: [5, 1] }), RangeError);
  assert.throws(() => machine.randomWalk('clear', { hold: [0, 0], blend: [0, 0] }), RangeError);
  assert.throws(() => machine.randomWalk('clear', { chain: { clear: { fog: -1 } } }), RangeError);
  assert.throws(() => machine.randomWalk('clear', { chain: { clear: { monsoon: 1 } } }), TypeError);
});

test('dispose ends the machine; use after it throws code disposed; using disposes', () => {
  let machine;
  {
    using m = new WeatherMachine('rain');
    machine = m;
    m.update(1);
  }
  assert.throws(() => machine.update(1), { code: 'disposed' });
  assert.throws(() => machine.transitionTo('clear'), { code: 'disposed' });
  machine.dispose();
});

test('property: any sequence of operations keeps every field in range and the ground in 0..1', () => {
  const rnd = random(4242),
    names = Object.keys(WEATHER_PRESETS);
  for (let round = 0; round < 60; round++) {
    const machine = new WeatherMachine(names[Math.floor(rnd() * names.length)], { seed: round });
    for (let step = 0; step < 80; step++) {
      const op = Math.floor(rnd() * 6);
      if (op === 0) machine.transitionTo(names[Math.floor(rnd() * names.length)], { seconds: rnd() * 60 });
      else if (op === 1)
        machine.transitionTo(
          { rain: rnd(), wind: rnd() * 60, windDirection: (rnd() - 0.5) * 20 },
          { seconds: rnd() * 30, ease: rnd() < 0.5 ? 'linear' : 'smoothstep' },
        );
      else if (op === 2) machine.set(names[Math.floor(rnd() * names.length)]);
      else if (op === 3)
        machine.randomWalk(names[Math.floor(rnd() * names.length)], { seed: step, hold: [0, 20], blend: [0, 20] });
      else if (op === 4)
        machine.schedule(
          [
            { to: 'rain', seconds: rnd() * 5, hold: rnd() * 5 },
            { to: 'snow', seconds: rnd() * 5, hold: rnd() * 5 + 0.1 },
          ],
          { loop: true },
        );
      machine.update(rnd() * 12);
      inRange(machine.state);
      assert.ok(machine.wetness >= 0 && machine.wetness <= 1 && machine.snowCover >= 0 && machine.snowCover <= 1);
      assert.ok(Math.abs(machine.state.windDirection) <= Math.PI + 1e-9);
    }
  }
});

test('fuzz: bad targets and numbers only ever throw TypeError, RangeError or MargoError', () => {
  const rnd = random(77),
    wild = [
      NaN,
      Infinity,
      -1,
      2,
      '',
      'rain',
      'sunny',
      null,
      undefined,
      {},
      [],
      { rain: 0.3 },
      { rain: 'x' },
      { nope: 1 },
      5,
      true,
    ];
  const pick = () => wild[Math.floor(rnd() * wild.length)];
  const machine = new WeatherMachine('clear');
  let accepted = 0;
  for (let n = 0; n < 3000; n++) {
    try {
      const op = n % 4;
      if (op === 0) machine.transitionTo(pick(), { seconds: pick(), ease: pick() });
      else if (op === 1) machine.set(pick());
      else if (op === 2) machine.update(pick());
      else machine.schedule([{ to: pick(), hold: pick(), seconds: pick() }]);
      accepted++;
      inRange(machine.state);
    } catch (error) {
      assert.ok(
        error instanceof TypeError || error instanceof RangeError || error.name === 'MargoError',
        String(error),
      );
    }
  }
  assert.ok(accepted > 100);
});

test('valueNoise is smooth, bounded in -1..1 and deterministic', () => {
  const rnd = random(3);
  let seen = 0;
  for (let n = 0; n < 2000; n++) {
    const x = rnd() * 100 - 50,
      y = rnd() * 100 - 50,
      z = rnd() * 100 - 50,
      w = rnd() * 100;
    const v = valueNoise(x, y, z, w, 5);
    assert.ok(v >= -1 && v <= 1);
    assert.equal(v, valueNoise(x, y, z, w, 5));
    assert.ok(Math.abs(valueNoise(x + 1e-4, y, z, w, 5) - v) < 2e-3, 'continuous');
    seen += Math.abs(v);
  }
  assert.ok(seen / 2000 > 0.2, 'the noise is not flat');
  assert.notEqual(valueNoise(1.5, 2.5, 3.5, 4.5, 1), valueNoise(1.5, 2.5, 3.5, 4.5, 2));
});

test('WindField: deterministic, bounded, continuous, mean speed and direction, calm when speed is 0', () => {
  const field = new WindField({ speed: 10, direction: Math.PI / 2, gust: 0.5, turbulence: 0.3, seed: 9 });
  const again = new WindField({ speed: 10, direction: Math.PI / 2, gust: 0.5, turbulence: 0.3, seed: 9 });
  const rnd = random(11);
  let sx = 0,
    sz = 0;
  const bound = 10 * (1 + 0.5 + 0.3);
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const x = rnd() * 500,
      y = rnd() * 50,
      z = rnd() * 500,
      t = rnd() * 3000;
    const v = field.sample(x, y, z, t);
    assert.deepEqual(v, again.sample(x, y, z, t));
    assert.ok(Math.hypot(...v) <= bound + 1e-9, `${Math.hypot(...v)} within ${bound}`);
    const step = field.sample(x + 0.01, y, z, t + 0.001);
    assert.ok(Math.hypot(step[0] - v[0], step[1] - v[1], step[2] - v[2]) < 0.2, 'continuous in space and time');
    sx += v[0];
    sz += v[2];
  }
  // Blowing toward +X: the long-run mean is mostly +X, near the set speed.
  assert.ok(sx / n > 7 && sx / n < 13, `mean x ${sx / n}`);
  assert.ok(Math.abs(sz / n) < 3, `mean z ${sz / n}`);
  const calm = new WindField({ speed: 0 });
  assert.ok(calm.sample(3, 4, 5, 6).every((c) => c === 0));
  const gusts = Array.from({ length: 400 }, (_, i) => field.gustFactor(i * 0.5));
  assert.ok(Math.min(...gusts) >= 0.5 - 1e-9 && Math.max(...gusts) <= 1.5 + 1e-9);
  assert.ok(Math.max(...gusts) - Math.min(...gusts) > 0.4, 'it actually gusts');
  const steady = new WindField({ speed: 8, gust: 0, turbulence: 0 });
  assert.equal(steady.gustFactor(123), 1);
  assert.equal(steady.directionAt(77), 0);
  near(steady.sample(1, 2, 3, 4)[2], 8);
});

test('WindField.set validates, keeps the old settings on failure, and a different seed gives a different wind', () => {
  const field = new WindField({ speed: 5 });
  assert.throws(() => field.set({ speed: 99 }), RangeError);
  assert.throws(() => field.set({ gust: NaN }), RangeError);
  assert.throws(() => new WindField({ scale: 0 }), RangeError);
  assert.throws(() => new WindField({ gustPeriod: 'x' }), RangeError);
  assert.equal(field.options.speed, 5);
  assert.equal(field.set({ speed: 7 }).options.speed, 7);
  const a = new WindField({ seed: 1 }).sample(5, 5, 5, 5),
    b = new WindField({ seed: 2 }).sample(5, 5, 5, 5);
  assert.notDeepEqual(a, b);
});

test('the machine keeps its wind field in step with the state', () => {
  const machine = new WeatherMachine('clear');
  assert.equal(machine.wind.options.speed, WEATHER_PRESETS.clear.wind);
  machine.transitionTo('blizzard', { seconds: 10 });
  machine.update(10);
  assert.equal(machine.wind.options.speed, WEATHER_PRESETS.blizzard.wind);
  assert.equal(machine.wind.options.gust, WEATHER_PRESETS.blizzard.gust);
  const [x, z] = windAt(machine.wind, 0, 2, 0, machine.time);
  assert.ok(Math.hypot(x, z) > 5);
});

test('surface formulas: wet is darker and shinier, snow covers up-facing surfaces first', () => {
  near(wetRoughness(0.8, 0), 0.8);
  near(wetRoughness(0.8, 1), 0.8 * 0.35);
  assert.ok(wetRoughness(0.8, 0.5) < 0.8 && wetRoughness(0.8, 0.5) > wetRoughness(0.8, 1));
  assert.deepEqual(wetColor([0.4, 0.4, 0.4], 0), [0.4, 0.4, 0.4]);
  near(wetColor([0.4, 0.2, 0.1], 1)[0], 0.3);
  assert.equal(snowWeight(1, 0), 0);
  assert.equal(snowWeight(0, 0.3), 0);
  assert.equal(snowWeight(1, 1), 1);
  assert.equal(snowWeight(0.5, 1), 1);
  assert.equal(snowWeight(-1, 1), 0, 'a ceiling stays bare');
  assert.ok(snowWeight(0.9, 0.5) > snowWeight(0.4, 0.5));
  const base = { roughness: 0.6, color: [0.3, 0.25, 0.2] };
  const dry = surfaceResponse(base, 1, 0, 0);
  near(dry.roughness, 0.6);
  assert.deepEqual(dry.color, [0.3, 0.25, 0.2]);
  const covered = surfaceResponse(base, 1, 0.5, 1);
  near(covered.roughness, 0.85);
  near(covered.color[0], 0.9);
  const material = { roughness: 0.9 };
  applyWetness(material, 0.9, 1);
  near(material.roughness, 0.9 * 0.35);
  assert.deepEqual(settledGround({ rain: 0.4, hail: 0, snow: 0 }), { wetness: 0.6000000000000001, snowCover: 0 });
  assert.deepEqual(settledGround({ rain: 1, hail: 0, snow: 0.5 }), { wetness: 1, snowCover: 0.5 });
});

test('property: surface formulas stay in range and are monotone in wetness and snow cover', () => {
  const rnd = random(99);
  for (let i = 0; i < 500; i++) {
    const rough = rnd(),
      ny = rnd() * 2 - 1,
      w1 = rnd(),
      w2 = Math.min(1, w1 + rnd() * 0.3),
      s1 = rnd(),
      s2 = Math.min(1, s1 + rnd() * 0.3);
    assert.ok(wetRoughness(rough, w2) <= wetRoughness(rough, w1) + 1e-12);
    assert.ok(snowWeight(ny, s2) >= snowWeight(ny, s1) - 1e-12);
    const weight = snowWeight(ny, s1);
    assert.ok(weight >= 0 && weight <= 1);
    const r = surfaceResponse({ roughness: rough, color: [rnd(), rnd(), rnd()] }, ny, w1, s1);
    assert.ok(r.roughness >= 0 && r.roughness <= 1);
    for (const c of r.color) assert.ok(c >= 0 && c <= 1);
  }
});

test('the WGSL surface functions are named as documented and use the same constants', () => {
  for (const name of ['weather_wet_roughness', 'weather_wet_color', 'weather_snow_weight', 'weather_surface'])
    assert.ok(surfaceWGSL.includes(`fn ${name}(`), name);
  assert.ok(surfaceWGSL.includes('0.65') && surfaceWGSL.includes('0.25') && surfaceWGSL.includes('0.8*cover'));
});

test('skyWeather maps a state to the sky Weather settings', () => {
  const rain = skyWeather(WEATHER_PRESETS.rain);
  assert.equal(rain.precipitation, 'rain');
  assert.equal(rain.intensity, WEATHER_PRESETS.rain.rain);
  assert.equal(rain.fadeSeconds, 0);
  assert.equal(rain.lightning, undefined);
  near(Math.hypot(...rain.wind), WEATHER_PRESETS.rain.wind);
  const storm = skyWeather(WEATHER_PRESETS.thunderstorm);
  assert.ok(storm.lightning.rate > 6 && storm.lightning.threshold === 0);
  assert.equal(skyWeather(WEATHER_PRESETS.snow).precipitation, 'snow');
  assert.equal(skyWeather(WEATHER_PRESETS.clear).precipitation, 'none');
  // Sleet falls as both: the sky Weather draws each with its share, here half and half of 0.8 in all.
  const sleet = skyWeather(WEATHER_PRESETS.sleet);
  assert.deepEqual([sleet.precipitation, sleet.snowShare, sleet.intensity], ['sleet', 0.5, 0.8]);
  assert.equal(rain.snowShare, 0);
  assert.equal(skyWeather(WEATHER_PRESETS.snow).snowShare, 1);
  assert.deepEqual(skyWeather(WEATHER_PRESETS.rain, [3, -4]).wind, [3, -4]);
  // Wind blowing toward +X (direction pi/2) gives positive x and about zero z.
  const east = skyWeather({ ...WEATHER_PRESETS.rain, windDirection: Math.PI / 2, wind: 10 }).wind;
  near(east[0], 10);
  near(east[1], 0, 1e-9);
  assert.deepEqual(hailSettings(WEATHER_PRESETS.hail).intensity, WEATHER_PRESETS.hail.hail);
  assert.equal(fogDensity(WEATHER_PRESETS.clear) < fogDensity(WEATHER_PRESETS.fog), true);
  near(fogDensity({ ...WEATHER_PRESETS.clear, fog: 0, rain: 0 }), 0.0002, 1e-12);
  near(fogDensity({ ...WEATHER_PRESETS.clear, fog: 1, rain: 0 }), 0.02, 1e-12);
});

test('Hail validates options, eases its amount without a GPU, and refuses a non-GPU engine', () => {
  const hail = new Hail({ intensity: 1, fadeSeconds: 2, particles: 100 });
  assert.equal(hail.amount, 0);
  hail.update(1);
  near(hail.amount, 0.5);
  assert.equal(hail.count, 50);
  hail.update(5);
  assert.equal(hail.amount, 1);
  hail.options.intensity = 0;
  hail.update(10);
  assert.equal(hail.amount, 0);
  assert.equal(new Hail({ intensity: 0.4, fadeSeconds: 0 }).update(0), undefined);
  for (const bad of [
    { intensity: 2 },
    { radius: 1 },
    { height: 500 },
    { particles: -1 },
    { fallSpeed: 1 },
    { restitution: 1 },
    { stoneRadius: 0 },
    { opacity: 2 },
    { wind: [1, 200] },
    { color: [1, 1, -1] },
  ])
    assert.throws(() => new Hail(bad), RangeError, JSON.stringify(bad));
  for (const bad of [{ wind: [1] }, { color: [1, 1] }, null])
    assert.throws(() => new Hail(bad), TypeError, JSON.stringify(bad));
  assert.throws(() => hail.update(-1), RangeError);
  assert.throws(() => hail.setup({ gpu: undefined }), { code: 'unsupported' });
  hail.dispose();
  assert.throws(() => hail.update(1), { code: 'disposed' });
  assert.doesNotThrow(() => validateHail({}));
  // One stone: it falls 30 m at 18 m/s, then two bounces and a short rest.
  near(hailCycle({}), 30 / 18 + (2 * 0.2 * 18) / 9.81 + (2 * 0.04 * 18) / 9.81 + 0.25, 1e-12);
});

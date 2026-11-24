// The settings table of @margoengine/sky/settings: every look and atmosphere option has a row, every row default is
// what the sky, Tonemap or Grade does without the option, defaults written change nothing the GPU receives, ranges
// are enforced and the named looks are only row values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Sky } from '@margoengine/sky';
import { look } from '@margoengine/sky/look';
import {
  SKY_LIVE_SETTINGS,
  SKY_LOOKS,
  SKY_SETTINGS,
  applySkySettings,
  skySettingDefaults,
} from '@margoengine/sky/settings';
import { Tonemap } from '@margoengine/tonemap';
import { Grade } from '@margoengine/tonemap/grade';
import { fingerprint } from './defaults-fingerprint.js';

const byName = new Map(SKY_SETTINGS.map((s) => [s.name, s]));
const recorded = JSON.parse(await readFile(new URL('./fixtures/defaults-fingerprint.json', import.meta.url), 'utf8'));
// The fields of an interface in src/base.ts, by parsing its source.
const base = await readFile(new URL('../src/base.ts', import.meta.url), 'utf8');
function fields(name) {
  const body = base.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))[1];
  return [...body.matchAll(/^ {2}([a-zA-Z]+)\?:/gm)].map((m) => m[1]);
}
// The 72-float block look.write gives for these options.
function block(options) {
  const air = new Float32Array(9),
    out = new Float32Array(72);
  look.air(options, air);
  look.write(out, options, air);
  return out;
}

test('every row is well formed and names are unique', () => {
  assert.equal(byName.size, SKY_SETTINGS.length);
  assert.equal(SKY_SETTINGS.length, 169);
  for (const s of SKY_SETTINGS) {
    assert.ok(typeof s.about === 'string' && s.about.length > 10, s.name);
    assert.ok(['number', 'color', 'choice', 'gradient'].includes(s.kind), s.name);
    if (s.kind === 'choice') assert.ok(s.choices.includes(s.default), s.name);
    if (s.kind === 'number' && s.default === null)
      // A row the weather drives: null follows the weather's cloud, wind or wind direction. The two hurricane rows whose
      // default comes from maxWindRadius, and the tornado's four derived rows, are nullable with no weather: null leaves
      // them to the storm.
      assert.ok(
        s.nullable === true &&
          (['cloud', 'wind', 'windDirection', 'lightning'].includes(s.weather) ||
            (s.weather === undefined &&
              [
                'hurricane.eyeRadius',
                'hurricane.bandStart',
                'tornado.debrisHeight',
                'tornado.updraft',
                'tornado.touchdown',
                'tornado.liftoff',
              ].includes(s.name))) &&
          s.min < s.max &&
          s.step > 0,
        s.name,
      );
    else if (s.kind === 'number') {
      assert.ok(s.min <= s.default && s.default <= s.max && s.step > 0, s.name);
    }
    if (s.kind === 'color' && s.default !== null)
      assert.ok(
        s.default.every((x) => x >= s.min && x <= s.max),
        s.name,
      );
  }
});

test('every look and atmosphere field has a row, and each row default is what the sky uses without it', () => {
  const plain = block({});
  for (const [key, iface] of [
    ['look', 'SkyLookOptions'],
    ['atmosphere', 'SkyAtmosphereOptions'],
  ]) {
    const names = fields(iface);
    assert.ok(names.length >= 8, iface);
    for (const field of names) {
      const row = byName.get(`${key}.${field}`);
      assert.ok(row, `${key}.${field} has a row`);
      // The field set to its row default writes exactly the block it writes absent.
      assert.deepEqual(block({ [key]: { [field]: row.default } }), plain, `${key}.${field} default`);
    }
  }
  for (const field of fields('SkyCloudOptions')) assert.ok(byName.has(`clouds.${field}`), `clouds.${field}`);
  for (const field of fields('SkyFogOptions').filter((f) => f !== 'depth'))
    assert.ok(byName.has(`fog.${field}`), `fog.${field}`);
  for (const field of ['hours', 'timeScale', 'turbidity', 'exposure', 'model', 'groundAlbedo'])
    assert.ok(byName.has(field), field);
  // Clouds and fog defaults are the options' own documented defaults (coverage 0 is the sheet removed).
  assert.equal(byName.get('clouds.speed').default, 8);
  assert.equal(byName.get('clouds.height').default, 1500);
  assert.equal(byName.get('fog.density').default, 0.01);
  assert.equal(byName.get('fog.start').default, 40);
});

test('the defaults applied leave the sky unset and send the GPU what a plain sky sends', () => {
  const sky = new Sky({});
  applySkySettings({ sky }, skySettingDefaults());
  assert.deepEqual(Object.keys(sky.options), []);
  applySkySettings({ sky });
  assert.deepEqual(Object.keys(sky.options), []);
  assert.equal(
    fingerprint(() => {
      const s = new Sky({});
      applySkySettings({ sky: s }, skySettingDefaults());
      return s;
    }),
    recorded.default,
  );
  // A look then the defaults again: back to a plain sky.
  applySkySettings({ sky }, SKY_LOOKS.storm);
  assert.ok(sky.options.look && sky.options.atmosphere && sky.options.clouds && sky.options.sunDirection);
  applySkySettings({ sky }, {});
  assert.deepEqual(Object.keys(sky.options), []);
});

test('Tonemap and Grade at the written defaults stay on their default programs', () => {
  const tonemap = new Tonemap(),
    grade = new Grade();
  applySkySettings({ sky: new Sky({}), tonemap, grade });
  assert.deepEqual(tonemap.options, { exposure: 0, temperature: 6500, tint: 0, contrast: 1 });
  assert.deepEqual(grade.options, { saturation: 1, lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });
  assert.equal(grade.key, 'grade');
  applySkySettings({ sky: new Sky({}), tonemap, grade }, { 'grade.saturation': 0.5, 'tonemap.exposure': 1 });
  assert.equal(grade.key, 'grade:tone');
  assert.equal(tonemap.options.exposure, 1);
});

test('values are checked against their rows: unknown names throw TypeError, out of range RangeError', () => {
  const sky = new Sky({});
  assert.throws(() => applySkySettings({ sky }, { 'look.nope': 1 }), TypeError);
  for (const s of SKY_SETTINGS) {
    if (s.kind === 'number') {
      assert.doesNotThrow(() => applySkySettings({ sky }, { [s.name]: s.min }), s.name);
      assert.doesNotThrow(() => applySkySettings({ sky }, { [s.name]: s.max }), s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: s.max + 1 }), RangeError, s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: s.min - 1 }), RangeError, s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: 'x' }), RangeError, s.name);
    } else if (s.kind === 'color') {
      assert.doesNotThrow(() => applySkySettings({ sky }, { [s.name]: [s.max, s.min, s.max] }), s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: [s.max + 1, 0, 0] }), RangeError, s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: [0, 0] }), RangeError, s.name);
      if (s.nullable) assert.doesNotThrow(() => applySkySettings({ sky }, { [s.name]: null }));
      else assert.throws(() => applySkySettings({ sky }, { [s.name]: null }), RangeError, s.name);
    } else if (s.kind === 'choice') {
      for (const v of s.choices) assert.doesNotThrow(() => applySkySettings({ sky }, { [s.name]: v }), s.name);
      assert.throws(() => applySkySettings({ sky }, { [s.name]: 'other' }), RangeError, s.name);
    } else {
      assert.throws(() => applySkySettings({ sky }, { [s.name]: [{ elevation: 0, color: [1, 1, 1] }] }), RangeError);
      assert.throws(
        () =>
          applySkySettings(
            { sky },
            {
              [s.name]: [
                { elevation: 10, color: [1, 1, 1] },
                { elevation: 0, color: [1, 1, 1] },
              ],
            },
          ),
        RangeError,
      );
    }
  }
});

test('values land on the options they name', () => {
  const sky = new Sky({ fog: { depth: () => undefined, density: 0.05 } }),
    tonemap = new Tonemap(),
    grade = new Grade();
  applySkySettings(
    { sky, tonemap, grade },
    {
      'sun.mode': 'angles',
      'sun.azimuth': 90,
      'sun.elevation': 0,
      'atmosphere.rayleigh': 2,
      'look.glowStrength': 3,
      'clouds.coverage': 0.5,
      'fog.color': [1, 0, 1],
      turbidity: 4,
      'grade.gain': [2, 1, 1],
    },
  );
  const o = sky.options;
  assert.deepEqual(
    [...o.sunDirection].map((x) => Math.round(x * 1e6) / 1e6),
    [1, 0, 0],
  );
  assert.deepEqual(o.atmosphere, { rayleigh: 2 });
  assert.deepEqual(o.look, { glowStrength: 3 });
  assert.deepEqual(o.clouds, { coverage: 0.5 });
  assert.equal(typeof o.fog.depth, 'function');
  assert.deepEqual(o.fog.color, [1, 0, 1]);
  assert.equal(o.fog.density, undefined, 'fog.density back to its default');
  assert.equal(o.turbidity, 4);
  assert.deepEqual(grade.options.gain, [2, 1, 1]);
  // The values are copied: editing the panel state later does not move the sky.
  const values = { 'look.glowColor': [1, 0, 0] };
  applySkySettings({ sky }, values);
  values['look.glowColor'][1] = 1;
  assert.deepEqual(sky.options.look.glowColor, [1, 0, 0]);
  // A sky without fog ignores fog values.
  const clear = new Sky({});
  applySkySettings({ sky: clear }, { 'fog.density': 0.2 });
  assert.equal(clear.options.fog, undefined);
});

test("the named looks are only row values, all in range, and each passes the sky's own checks", () => {
  const names = Object.keys(SKY_LOOKS);
  assert.deepEqual(names, [
    'natural',
    'clearNoon',
    'overcast',
    'sunrise',
    'sunset',
    'dusk',
    'storm',
    'haze',
    'greenSky',
    'yellowSky',
    'redSky',
    'purpleSky',
    'animatedFeature',
  ]);
  for (const name of names) {
    const values = SKY_LOOKS[name];
    for (const key of Object.keys(values)) assert.ok(byName.has(key), `${name}: ${key} is a row`);
    const sky = new Sky({});
    assert.doesNotThrow(() => applySkySettings({ sky }, values), name);
    // The sky itself accepts the result (its own checks run on these options).
    assert.doesNotThrow(() => look.validate(sky.options), name);
  }
});

test('every row says whether it can change every frame: only the model rebuilds', () => {
  for (const s of SKY_SETTINGS) assert.equal(typeof s.live, 'boolean', s.name);
  assert.deepEqual(
    SKY_SETTINGS.filter((s) => !s.live).map((s) => s.name),
    ['model'],
  );
  assert.deepEqual(
    SKY_LIVE_SETTINGS.map((s) => s.name),
    SKY_SETTINGS.filter((s) => s.name !== 'model').map((s) => s.name),
  );
});
test('the messages name the sky and its entry', () => {
  const sky = new Sky({});
  assert.throws(
    () => applySkySettings({ sky }, { nope: 1 }),
    /Unknown sky setting nope; use a name from SKY_SETTINGS in @margoengine\/sky\/settings/,
  );
  assert.throws(
    () => applySkySettings({ sky }, { turbidity: 99 }),
    /Invalid sky setting turbidity; use a number from 1 to 10/,
  );
});

test('the volumetric rows write the clouds options: null and defaults unset them, the weather ones follow it', async () => {
  const { VolumetricClouds } = await import('@margoengine/sky/volumetric-clouds'),
    sky = new Sky(),
    clouds = new VolumetricClouds({ sky, weather: { cloud: 1 } }),
    rows = SKY_SETTINGS.filter((s) => s.group === 'volumetric');
  assert.deepEqual(
    rows.map((s) => s.name.slice(11)),
    [
      'coverage',
      'bottom',
      'top',
      'density',
      'type',
      'windSpeed',
      'windDirection',
      'steps',
      'lightSteps',
      'erosion',
      'stepCap',
      'scale',
      'evolution',
      'maxDistance',
      'sunIntensity',
      'groundAlbedo',
      'temporal',
      'dimLight',
    ],
  );
  // Every row default other than the weather's is the plugin's own default, read from its source.
  const source = await readFile(new URL('../src/volumetric-clouds.ts', import.meta.url), 'utf8'),
    table = source.match(/const defaults = \{([\s\S]*?)\} as const;/)[1],
    plain = Object.fromEntries([...table.matchAll(/(\w+): ([\d.]+),/g)].map((m) => [m[1], Number(m[2])]));
  for (const key of [
    'steps',
    'lightSteps',
    'stepCap',
    'scale',
    'evolution',
    'maxDistance',
    'sunIntensity',
    'groundAlbedo',
  ])
    assert.equal(byName.get(`volumetric.${key}`).default, plain[key], key);
  for (const key of ['coverage', 'bottom', 'top', 'density']) assert.ok(plain[key] > 0, key);
  applySkySettings({ sky, clouds }, {});
  assert.deepEqual(Object.keys(clouds.options).sort(), ['sky', 'weather'], 'defaults leave the options unset');
  applySkySettings(
    { sky, clouds },
    {
      'volumetric.coverage': 0.8,
      'volumetric.stepCap': 300,
      'volumetric.temporal': 'on',
      'volumetric.dimLight': 'off',
    },
  );
  assert.equal(clouds.options.coverage, 0.8);
  assert.equal(clouds.options.stepCap, 300);
  assert.equal(clouds.options.temporal, true);
  assert.equal(clouds.options.dimLight, false);
  applySkySettings({ sky, clouds }, { 'volumetric.steps': 100.6, 'volumetric.lightSteps': 3.2 });
  assert.equal(clouds.options.steps, 101, 'a keyed step count takes the nearer whole count');
  assert.equal(clouds.options.lightSteps, 3);
  applySkySettings({ sky, clouds }, { 'volumetric.temporal': 'off', 'volumetric.coverage': null });
  assert.equal(clouds.options.temporal, false);
  assert.equal('coverage' in clouds.options, false, 'null follows the weather');
  assert.equal('stepCap' in clouds.options, false);
  applySkySettings({ sky, clouds }, { 'volumetric.temporal': 'auto' });
  assert.equal('temporal' in clouds.options, false, "'auto' is the default: unset");
  assert.throws(() => applySkySettings({ sky, clouds }, { 'volumetric.stepCap': 5 }), RangeError);
  assert.throws(() => applySkySettings({ sky, clouds }, { 'volumetric.temporal': 'yes' }), RangeError);
  // The type row forces a type whatever the weather says; 'weather' (the default) unsets it.
  applySkySettings({ sky, clouds }, { 'volumetric.type': 'storm' });
  assert.equal(clouds.options.type, 'storm');
  applySkySettings({ sky, clouds }, { 'volumetric.type': 'weather' });
  assert.equal('type' in clouds.options, false);
  assert.throws(() => applySkySettings({ sky, clouds }, { 'volumetric.type': 'cirrus' }), RangeError);
  // The wind rows write options.wind: direction 0 is +Z, 90 is +X; a null part keeps the other's held value.
  applySkySettings({ sky, clouds }, { 'volumetric.windSpeed': 20, 'volumetric.windDirection': 90 });
  assert.ok(
    Math.abs(clouds.options.wind[0] - 20) < 1e-9 && Math.abs(clouds.options.wind[1]) < 1e-9,
    JSON.stringify(clouds.options.wind),
  );
  applySkySettings({ sky, clouds }, { 'volumetric.windSpeed': 5, 'volumetric.windDirection': null });
  assert.ok(Math.abs(clouds.options.wind[0] - 5) < 1e-9, 'a null direction keeps the held direction');
  clouds.options.wind = [0, 8];
  applySkySettings({ sky, clouds }, { 'volumetric.windDirection': 90 });
  assert.ok(
    Math.abs(clouds.options.wind[0] - 8) < 1e-9 && Math.abs(clouds.options.wind[1]) < 1e-9,
    'a null speed keeps the held speed',
  );
  applySkySettings({ sky, clouds }, {});
  assert.equal('wind' in clouds.options, false, 'both null unset the wind: it is the weather drive\x27s again');
  // Without a clouds target the rows write nothing and the sky is unchanged.
  applySkySettings({ sky }, { 'volumetric.coverage': 0.3 });
  assert.equal('volumetric' in sky.options, false);
  sky.dispose();
});

test("the lightning rows write the weather's lightning option: defaults and null leave it unset, the weather rows are held until handed back", async () => {
  const { Weather, LIGHTNING_COLOR } = await import('@margoengine/sky/weather'),
    { heldFromWeather } = await import('../../shared/settings.js'),
    sky = new Sky(),
    weather = new Weather({ intensity: 0 }),
    rows = SKY_SETTINGS.filter((s) => s.group === 'lightning'),
    names = rows.map((s) => s.name.slice(10));
  assert.deepEqual(names, [
    'rate',
    'threshold',
    'minDistance',
    'maxDistance',
    'strength',
    'color',
    'light.scale',
    'light.height',
    'light.color',
    'light.shadow',
    'light.line',
    'light.segments',
    'bolt.scale',
    'bolt.width',
    'bolt.glow',
    'bolt.fade',
    'bolt.branching',
    'bolt.spread',
    'bolt.detail',
    'bolt.top',
    'cloud.scale',
    'cloud.base',
    'cloud.radius',
    'link.clouds',
    'link.fog',
    'link.lights',
    'hold',
    'seed',
  ]);
  // The weather rows follow the weather (null); every other default is the package's own, read from its source.
  assert.equal(byName.get('lightning.rate').default, null);
  assert.equal(byName.get('lightning.rate').weather, 'lightning');
  assert.equal(byName.get('lightning.cloud.base').weather, 'cloud');
  assert.deepEqual(byName.get('lightning.light.color').default, [...LIGHTNING_COLOR]);
  const source = await readFile(new URL('../src/weather.ts', import.meta.url), 'utf8'),
    table = source.match(/const lightningDefaults = \{([\s\S]*?)\};/)[1],
    plain = Object.fromEntries([...table.matchAll(/(\w+): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  for (const key of ['minDistance', 'maxDistance', 'strength', 'seed'])
    assert.equal(byName.get(`lightning.${key}`).default, plain[key], key);
  assert.equal(plain.rate, 6, "an unset rate is the package's 6 a minute");
  assert.deepEqual(byName.get('lightning.color').default, [
    ...source
      .match(/const flashColor: Vec3 = \[([^\]]+)\]/)[1]
      .split(',')
      .map(Number),
  ]);
  // Defaults write nothing: a weather with no lightning stays without storms.
  applySkySettings({ sky, weather }, {});
  assert.equal('lightning' in weather.options, false);
  applySkySettings(
    { sky, weather },
    {
      'lightning.strength': 0.5,
      'lightning.light.scale': 3,
      'lightning.cloud.radius': 400,
      'lightning.link.fog': 'off',
      'lightning.light.shadow': 'off',
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(weather.options.lightning)), {
    strength: 0.5,
    light: { scale: 3, shadow: false },
    cloud: { radius: 400 },
    link: { fog: false },
  });
  weather.onPreUpdate(0.01);
  // A rate set by hand is an override the weather drive never writes; null hands it back.
  applySkySettings({ sky, weather }, { 'lightning.rate': 9, 'lightning.threshold': 0.2 });
  assert.equal(weather.options.lightning.rate, 9);
  assert.equal(heldFromWeather(weather.options.lightning, 'rate'), true);
  assert.equal(heldFromWeather(weather.options.lightning, 'threshold'), true);
  applySkySettings({ sky, weather }, {});
  assert.equal('rate' in weather.options.lightning, false, 'null hands the held rate back');
  assert.equal(heldFromWeather(weather.options.lightning, 'rate'), false);
  weather.options.lightning.rate = 4; // what the drive writes
  applySkySettings({ sky, weather }, {});
  assert.equal(weather.options.lightning.rate, 4, "a null row leaves the drive's value");
  applySkySettings({ sky, weather }, { 'lightning.hold': 0.5 });
  assert.equal(weather.options.lightning.hold, 0.5);
  applySkySettings({ sky, weather }, {});
  assert.equal('hold' in weather.options.lightning, false, 'null releases the hold');
  weather.onPreUpdate(0.01);
  for (const bad of [
    { 'lightning.light.scale': -1 },
    { 'lightning.cloud.radius': 0 },
    { 'lightning.link.fog': 'yes' },
    { 'lightning.light.shadow': true },
    { 'lightning.light.color': [0, 0, 0] },
  ])
    assert.throws(() => applySkySettings({ sky, weather }, bad), RangeError, JSON.stringify(bad));
  // Without a weather target the rows write nothing.
  applySkySettings({ sky }, { 'lightning.strength': 2 });
});

test('KB-SCENES-NIGHTSUN1: the animatedFeature family holds no clock and no sun, so a scene keeps its hour', () => {
  for (const row of ['hours', 'timeScale', 'sun.mode', 'sun.azimuth', 'sun.elevation'])
    assert.equal(row in SKY_LOOKS.animatedFeature, false, row);
  assert.equal(SKY_LOOKS.animatedFeature.model, 'bruneton');
});

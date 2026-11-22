// The smoke column settings table: the rows and their live flag, every row at both ends of its range builds a Smoke,
// values read back as written, the looks build, and with the wind rows at null one weather wind slider bends the
// column (the drive writes its puffs' wind) while a value on the row overrides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Smoke, plumeRise, buoyancyFlux } from '../dist/smoke.js';
import {
  SMOKE_LIVE_SETTINGS,
  SMOKE_LOOKS,
  SMOKE_SETTINGS,
  applySmokeSettings,
  smokeSettingDefaults,
  smokeSettingValues,
} from '../dist/settings.js';
import { WeatherDrive } from '../../weather/dist/drive.js';
import { WeatherMachine } from '../../weather/dist/index.js';
import { applyWeatherSettings } from '../../weather/dist/settings.js';
import { optionalGPU as harness } from '../../../tests/support/optional-gpu.js';

const optionalGPU = () => {
  const h = harness();
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  return h;
};

test('the rows: lifetime is read at attach, the rest are live; the wind follows the weather at null', () => {
  assert.deepEqual(
    SMOKE_SETTINGS.filter((r) => !r.live).map((r) => r.name),
    ['lifetime'],
  );
  assert.equal(SMOKE_LIVE_SETTINGS.length, SMOKE_SETTINGS.length - 1);
  for (const row of SMOKE_SETTINGS) assert.ok(row.about.length > 15 && row.max > row.min, row.name);
  assert.deepEqual(
    SMOKE_SETTINGS.filter((r) => r.weather).map((r) => [r.name, r.weather]),
    [
      ['wind.x', 'wind'],
      ['wind.z', 'wind'],
    ],
  );
  assert.throws(() => applySmokeSettings({ options: {} }, { nope: 1 }), TypeError);
  assert.throws(() => applySmokeSettings({ options: {} }, { opacity: 2 }), RangeError);
});

test('every row at both ends of its range builds a Smoke and reads back; the defaults are an unconfigured column', () => {
  const h = optionalGPU();
  for (const row of SMOKE_SETTINGS) {
    if (row.kind === 'color') continue;
    for (const end of [row.min, row.max]) {
      const o = { position: [0, 0, 0], prewarm: false, lifetime: 2 };
      applySmokeSettings({ options: o }, { lifetime: 2, rate: 1, [row.name]: end });
      const smoke = Smoke.attach(h.engine, o);
      h.frame();
      assert.equal(smokeSettingValues(smoke)[row.name], end, row.name);
      smoke.dispose();
    }
  }
  const o = { position: [0, 0, 0] };
  applySmokeSettings({ options: o }, {});
  assert.equal('wind' in o, false);
  assert.deepEqual(smokeSettingValues({ options: o }), smokeSettingDefaults());
  const plain = Smoke.attach(h.engine, { position: [0, 0, 0], prewarm: false }),
    set = Smoke.attach(h.engine, { ...o, prewarm: false });
  h.frame();
  for (const key of ['velocity', 'size', 'color', 'rate', 'turbulence', 'emissionExtent', 'lifetime', 'capacity'])
    assert.deepEqual(set.effect.options[key], plain.effect.options[key], key);
  assert.deepEqual([...set.effect.options.overLife.speed], [...plain.effect.options.overLife.speed]);
  for (const look of Object.values(SMOKE_LOOKS)) {
    const p = { position: [0, 0, 0], prewarm: false };
    applySmokeSettings({ options: p }, look);
    Smoke.attach(h.engine, p).dispose();
  }
});

test('with the wind rows at null one weather wind slider bends the column; a value on the row overrides it', () => {
  const h = optionalGPU(),
    machine = new WeatherMachine('clear', { seed: 6 }),
    smoke = Smoke.attach(h.engine, { position: [0, 0, 0], prewarm: false }),
    own = Smoke.attach(h.engine, { position: [5, 0, 0], prewarm: false });
  applySmokeSettings(smoke, {});
  applySmokeSettings(own, { 'wind.x': 3, 'wind.z': 0 });
  const drive = WeatherDrive.attach(h.engine, { weather: machine, advance: false });
  // The drive writes the wind field at the listener (the state's mean wind with the field's local swirl, about 6%
  // here), so the puffs' speed follows the slider within 10% and grows with it.
  let last = 0;
  for (const speed of [2, 9, 21]) {
    applyWeatherSettings(machine, { wind: speed, windDirection: 90, gust: 0 });
    h.frame();
    h.frame();
    const [x, z] = smoke.effect.options.wind;
    const U = Math.hypot(x, z);
    assert.ok(Math.abs(U - speed) < 0.1 * speed && U > last, `puffs take ${speed} m/s: ${x} ${z}`);
    last = U;
    assert.ok(
      Math.abs(smoke.column(30).rise - plumeRise(30, buoyancyFlux(5e6), U, 2).rise) < 1e-9,
      'the column bends in it',
    );
    assert.deepEqual(own.effect.options.wind, [3, 0], 'its own wind stays');
  }
  applySmokeSettings(own, {});
  h.frame();
  h.frame();
  assert.notDeepEqual(own.effect.options.wind, [3, 0], 'back to the weather');
  drive.dispose();
});

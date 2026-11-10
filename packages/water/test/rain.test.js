import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { WaterRain } from '../dist/rain.js';

test('rain validates every setting and the splash field', () => {
  const surface = new Water();
  for (const settings of [
    { rain: -0.1 },
    { rain: 1.5 },
    { rain: NaN },
    { cell: 0.01 },
    { cell: 6 },
    { lifetime: 0 },
    { lifetime: 11 },
    { strength: -1 },
    { strength: 2 },
    { weather: 1 },
    { weather: null },
  ])
    assert.throws(() => new WaterRain({ surface, ...settings }), /rain/);
  assert.throws(() => new WaterRain({}), /surface/);
  assert.throws(() => new WaterRain({ surface, splashes: {} }), /Ripples/);
  const field = { disturb() {} };
  for (const splash of [{ rate: -1 }, { rate: 1001 }, { area: 0 }, { radius: 0 }, { depth: 11 }, { depth: NaN }])
    assert.throws(() => new WaterRain({ surface, splashes: { field, ...splash } }), /splash/);
  surface.dispose();
});

test('rain follows a weather rain value, clamped, and falls back to its own value', () => {
  const surface = new Water();
  const weather = { rain: 0.4 };
  const followed = new WaterRain({ surface, weather, rain: 0.9 });
  assert.equal(followed.rain, 0.4);
  weather.rain = 3;
  assert.equal(followed.rain, 1);
  weather.rain = -2;
  assert.equal(followed.rain, 0);
  weather.rain = NaN;
  assert.equal(followed.rain, 0);
  // A WeatherMachine exposes its intensity as state.rain.
  const machine = { state: { rain: 0.6 } };
  const fromMachine = new WaterRain({ surface, weather: machine });
  assert.equal(fromMachine.rain, 0.6);
  machine.state = { rain: 0.1 };
  assert.equal(fromMachine.rain, 0.1);
  assert.equal(new WaterRain({ surface, weather: {} }).rain, 0);
  fromMachine.dispose();
  const own = new WaterRain({ surface });
  assert.equal(own.rain, 1);
  own.rain = 0.25;
  assert.equal(own.rain, 0.25);
  assert.throws(() => {
    own.rain = 2;
  }, /rain/);
  assert.equal(own.rain, 0.25);
  followed.dispose();
  own.dispose();
  surface.dispose();
});

test('rain time is settable, checked, and dispose is final and repeatable', () => {
  const surface = new Water();
  const rain = new WaterRain({ surface });
  assert.equal(rain.setTime(2.5), rain);
  assert.throws(() => rain.setTime(-1), /time/);
  assert.throws(() => rain.setTime(Infinity), /time/);
  rain.onPreUpdate(0.5);
  rain.onPreUpdate(-1);
  rain.dispose();
  rain.dispose();
  assert.throws(() => rain.setTime(0), { code: 'disposed' });
  assert.throws(
    () => {
      rain.rain = 0.5;
    },
    { code: 'disposed' },
  );
  surface.dispose();
});

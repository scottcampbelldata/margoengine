// synopticDrive turns the synoptic solver's column at the observer into the weather state WeatherDrive draws: rain and
// snow rates, cloud cover from the liquid water path, relative humidity, temperature and wind.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld } from '@margoengine/physics/world';
import { rainRate } from '@margoengine/weather';
import { synopticDrive } from '@margoengine/weather/synoptic';

const near = (actual, expected, bound, what) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected} ± ${bound}`);

// Saturated vapour column for scale height `height`: Clausius-Clapeyron over water, then the ideal gas law.
const saturatedColumn = (kelvin, height) =>
  (height * 611.2 * Math.exp((2.5e6 / 461.5) * (1 / 273.15 - 1 / kelvin))) / (461.5 * kelvin);

function column(values) {
  const asked = [];
  return {
    asked,
    sample: (x, z) => (asked.push([x, z]), values),
    wind: { sample: (x, y, z) => (asked.push([x, y, z]), { temperature: values.temperature }) },
  };
}

test('a column becomes rain, cloud, humidity and wind at the observer', () => {
  const values = {
    temperature: 283.15,
    precipitation: 10 / 3600,
    vapour: saturatedColumn(283.15, 2400) / 2,
    cloud: 0.01,
    wind: [3, 4],
  };
  const weather = column(values);
  let at = [100, 20, -50];
  const drive = synopticDrive(weather, () => at);
  const state = drive.state;
  assert.deepEqual(weather.asked, [
    [100, -50],
    [100, 20, -50],
  ]);
  near(rainRate(state), 10, 1e-3, 'rain mm/h');
  assert.ok(state.snow < 0.04, `almost no snow at 10 °C: ${state.snow}`);
  near(state.cloud, 1 - Math.exp(-1.5), 1e-12, 'cloud cover of 10 g/m² in 10 μm droplets');
  near(state.humidity, 0.5, 1e-12, 'relative humidity');
  near(state.temperature, 10, 1e-9, 'Celsius');
  near(state.wind, 5, 1e-12, 'wind speed');
  near(state.windDirection, Math.atan2(3, 4), 1e-12, 'wind direction');
  assert.equal(state.gust, 0);
  at = [7, 1, 8];
  drive.state;
  assert.deepEqual(weather.asked.at(-2), [7, 8], 'the position is read again each time');
});

test('cold columns snow, and out-of-range values are held to the state bounds', () => {
  const cold = synopticDrive(
    column({ temperature: 150, precipitation: 1, vapour: 1000, cloud: 1000, wind: [300, 0] }),
    () => [0, 0, 0],
  ).state;
  assert.deepEqual(
    [cold.rain, cold.snow, cold.cloud, cold.humidity, cold.wind, cold.temperature],
    [0, 1, 1, 1, 60, -80],
  );
  const coarse = synopticDrive(
    column({ temperature: 283.15, precipitation: 0, vapour: saturatedColumn(283.15, 1000), cloud: 0.01, wind: [0, 0] }),
    () => [0, 0, 0],
    { dropletRadius: 2e-5, moistureHeight: 1000 },
  ).state;
  near(coarse.cloud, 1 - Math.exp(-0.75), 1e-12, 'larger droplets shade less');
  near(coarse.humidity, 1, 1e-12, 'saturated at the given scale height');
  assert.equal(coarse.rain, 0);
  for (const options of [{ dropletRadius: 0 }, { moistureHeight: -1 }, { moistureHeight: Infinity }])
    assert.throws(() => synopticDrive(column({}), () => [0, 0, 0], options), {
      code: 'state',
      message: /finite positive cloud radii and moisture heights.*#synoptic/,
    });
});

test('the adapter reads a running synoptic solver', async () => {
  const solver = await SynopticWeather.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, {
    spacing: [20_000, 20_000],
    cells: [16, 8],
    meanWind: [10, 0],
    streamfunction: 0,
    beta: 0,
  });
  world.advance(10);
  const state = synopticDrive(solver, () => [0, 20, 0]).state;
  near(state.wind, 10, 1e-9, 'the mean wind');
  near(state.windDirection, Math.PI / 2, 1e-9, 'towards +x');
  near(state.temperature, solver.wind.sample(0, 20, 0, 0).temperature - 273.15, 1e-12, 'air temperature');
  for (const name of ['cloud', 'humidity', 'rain', 'snow'])
    assert.ok(state[name] >= 0 && state[name] <= 1, `${name} ${state[name]}`);
});

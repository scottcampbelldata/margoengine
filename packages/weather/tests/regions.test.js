// Weather regions: fronts sweep across the map at their speed, cells drift and fade at their edge and over their life,
// and the blend is continuous, in range and deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherRegions } from '../dist/regions.js';
import { STATE_FIELDS, WEATHER_PRESETS, WeatherMachine, assertState } from '../dist/index.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
// A blend at weight 1 is a + (b - a), equal to b within a rounding.
const same = (a, b) => {
  for (const key of Object.keys(STATE_FIELDS)) near(a[key], b[key], 1e-12);
};

test('a front reaches a place after distance / speed seconds and leaves its weather behind', () => {
  // Moving toward +X at 10 m/s from x = -1000.
  const front = { origin: [-1000, 0], direction: Math.PI / 2, speed: 10, width: 200, behind: 'rain' };
  const map = new WeatherRegions({ base: 'clear', fronts: [front] });
  near(map.arrival(front, 0, 0), 100);
  near(map.arrival(front, 0, 5000), 100, 1e-6);
  same(map.stateAt(0, 0), WEATHER_PRESETS.clear);
  map.update(100 - 10); // 100 m (half the width) before arrival: still clear
  assert.equal(map.stateAt(0, 0).rain, 0);
  map.update(10); // the front is here: half way
  near(map.stateAt(0, 0).rain, WEATHER_PRESETS.rain.rain / 2);
  map.update(10); // past by half the width: all rain
  same(map.stateAt(0, 0), WEATHER_PRESETS.rain);
  // A place further on is still clear, one behind is wet.
  assert.equal(map.stateAt(2000, 0).rain, 0);
  assert.equal(map.stateAt(-2000, 0).rain, WEATHER_PRESETS.rain.rain);
  near(map.arrival(front, 0, 0), -10);
});

test('a squall line rides on the front, and fronts apply in order', () => {
  const map = new WeatherRegions({
    base: 'clear',
    fronts: [
      { origin: [0, 0], direction: 0, speed: 0, width: 100, behind: 'overcast', along: 'thunderstorm' },
      { origin: [0, -500], direction: 0, speed: 0, width: 100, behind: { fog: 1 } },
    ],
  });
  // Moving toward +Z, so behind is z < 0. On the first line: the squall; far behind both: the second front's fog.
  same(map.stateAt(0, 0), WEATHER_PRESETS.thunderstorm);
  assert.equal(map.stateAt(0, 300).lightning, 0);
  near(map.stateAt(0, -300).cloud, WEATHER_PRESETS.overcast.cloud, 1e-12);
  near(map.stateAt(0, -1000).fog, 1, 1e-12);
  // The second front's partial weather fills its missing fields from the base, as resolveState does.
  near(map.stateAt(0, -1000).cloud, WEATHER_PRESETS.clear.cloud, 1e-12);
});

test('a cell drifts with its velocity, fades over its falloff and its life', () => {
  const cell = { center: [0, 0], radius: 100, falloff: 50, weather: 'snow', velocity: [5, 0], life: [0, 1000] };
  const map = new WeatherRegions({ base: 'clear', cells: [cell] });
  map.time = 500;
  // Centre now at x = 2500.
  assert.equal(map.stateAt(2500, 0).snow, WEATHER_PRESETS.snow.snow);
  assert.equal(map.stateAt(2600, 0).snow, WEATHER_PRESETS.snow.snow, 'whole up to the radius');
  near(map.stateAt(2625, 0).snow, WEATHER_PRESETS.snow.snow / 2);
  assert.equal(map.stateAt(2650, 0).snow, 0, 'gone past radius + falloff');
  assert.equal(map.stateAt(0, 0).snow, 0, 'it left where it started');
  // Life: grows in over the first 100 s, fades out over the last.
  assert.equal(map.stateAt(0, 0, 0).snow, 0);
  near(map.stateAt(250, 0, 50).snow, WEATHER_PRESETS.snow.snow / 2);
  assert.equal(map.stateAt(5000, 0, 1000).snow, 0);
  assert.equal(map.stateAt(5000, 0, 2000).snow, 0);
});

test('property: states stay in range and change smoothly across space and time', () => {
  const map = new WeatherRegions({
    base: 'partlyCloudy',
    fronts: [{ origin: [-3000, 0], direction: 1.1, speed: 12, width: 800, behind: 'storm', along: 'thunderstorm' }],
    cells: [
      { center: [500, 500], radius: 300, weather: 'fog', velocity: [-2, 1] },
      { center: [-800, 200], radius: 400, falloff: 0, weather: 'hail' },
    ],
  });
  for (let t = 0; t < 600; t += 37)
    for (let x = -4000; x < 4000; x += 311)
      for (let z = -4000; z < 4000; z += 433) {
        const s = map.stateAt(x, z, t);
        assertState(s);
        // Away from the hard-edged hail cell, a metre's move changes no field by more than the blends allow together:
        // smoothstep's slope is at most 1.5 / width, so 0.005 of a field's range per metre over the fog cell's 300 m
        // falloff plus 0.0019 for each of the front's two 800 m blends.
        if (Math.hypot(x + 800, z - 200) > 420) {
          const n = map.stateAt(x + 1, z, t);
          for (const key of Object.keys(STATE_FIELDS)) {
            if (key === 'windDirection') continue;
            const range = STATE_FIELDS[key][1] - STATE_FIELDS[key][0];
            assert.ok(Math.abs(n[key] - s[key]) <= 0.0089 * range, `${key} at ${x},${z},${t}`);
          }
        }
      }
});

test('apply sets a machine to the local weather; its ground follows the place', () => {
  const map = new WeatherRegions({ base: 'clear', cells: [{ center: [0, 0], radius: 50, weather: 'rain' }] });
  const machine = new WeatherMachine('clear');
  for (let i = 0; i < 60; i++) {
    map.apply(machine, 0, 0);
    machine.update(0.5);
  }
  assert.equal(machine.state.rain, WEATHER_PRESETS.rain.rain);
  assert.ok(machine.wetness > 0.5, `ground wet after 30 s in the rain: ${machine.wetness}`);
  const dry = new WeatherMachine('clear');
  for (let i = 0; i < 60; i++) {
    map.apply(dry, 1000, 0);
    dry.update(0.5);
  }
  assert.equal(dry.wetness, 0);
});

test('bad fronts, cells and inputs throw by name; removers and dispose work', () => {
  assert.throws(() => new WeatherRegions({ base: 'monsoon' }), /Unknown weather preset/);
  const map = new WeatherRegions();
  assert.throws(() => map.addFront({ origin: [0], direction: 0, behind: 'rain' }), TypeError);
  assert.throws(() => map.addFront({ origin: [0, 0], direction: 0, speed: 500, behind: 'rain' }), /front speed/);
  assert.throws(() => map.addFront({ origin: [0, 0], direction: 0, behind: { rain: 2 } }), RangeError);
  assert.throws(() => map.addCell({ center: [0, 0], radius: 0, weather: 'fog' }), /cell radius/);
  assert.throws(() => map.addCell({ center: [0, 0], radius: 10, weather: 'fog', life: [5, 5] }), /life must end/);
  assert.throws(() => map.stateAt(Number.NaN, 0), RangeError);
  assert.throws(() => map.update(-1), RangeError);
  assert.equal(map.fronts.length, 0, 'a bad front changes nothing');
  const remove = map.addCell({ center: [0, 0], radius: 10, weather: 'fog' });
  assert.equal(map.stateAt(0, 0).fog, WEATHER_PRESETS.fog.fog);
  remove();
  assert.equal(map.stateAt(0, 0).fog, 0);
  map.base = 'overcast';
  assert.equal(map.base.cloud, WEATHER_PRESETS.overcast.cloud);
  map.dispose();
  assert.throws(
    () => map.stateAt(0, 0),
    (e) => e.code === 'disposed',
  );
  {
    using scoped = new WeatherRegions();
    assert.equal(scoped.stateAt(0, 0).rain, 0);
  }
});

test('a new base refills the missing fields of partial fronts and cells; removers still work', () => {
  const map = new WeatherRegions({
    base: 'clear',
    fronts: [{ origin: [0, 0], direction: 0, speed: 0, width: 100, behind: { fog: 1 } }],
    cells: [{ center: [0, 5000], radius: 100, weather: { lightning: 1 } }],
  });
  const removeFront = map.addFront({ origin: [0, -3000], direction: 0, speed: 0, width: 100, behind: { hail: 1 } });
  map.base = 'snow';
  // Behind the first front: its fog over the new base's snow, not over the clear base it was added with.
  near(map.stateAt(0, -1000).fog, 1, 1e-12);
  near(map.stateAt(0, -1000).snow, WEATHER_PRESETS.snow.snow, 1e-12);
  near(map.stateAt(0, -1000).cloud, WEATHER_PRESETS.snow.cloud, 1e-12);
  near(map.stateAt(0, 5000).snow, WEATHER_PRESETS.snow.snow, 1e-12);
  near(map.stateAt(0, 5000).lightning, 1, 1e-12);
  near(map.stateAt(0, -5000).snow, WEATHER_PRESETS.snow.snow, 1e-12);
  // A bad base changes nothing; the remover of a front added before the change still removes it.
  assert.throws(() => (map.base = { rain: 2 }), RangeError);
  near(map.stateAt(0, -5000).hail, 1, 1e-12);
  removeFront();
  assert.equal(map.fronts.length, 1);
  near(map.stateAt(0, -5000).hail, 0, 1e-12);
});

test('a storm varies across itself: its weather is blended over the map by its weight, read live', () => {
  // A ring storm: calm inside 10 km, a 40 m/s gale with rain from 10 to 30 km, gone past 50 km.
  const storm = {
    weatherAt(x, z) {
      const r = Math.hypot(x, z);
      if (r < 10000) return { weight: 1, wind: 0, gust: 0, rain: 0 };
      if (r < 30000) return { weight: 1, wind: 80, gust: 1, rain: 0.9, windDirection: 1 };
      return { weight: Math.max(0, 1 - (r - 30000) / 20000), wind: 20, rain: 0.3 };
    },
  };
  const map = new WeatherRegions({ base: { ...WEATHER_PRESETS.partlyCloudy, wind: 5 }, storms: [storm] });
  assert.deepEqual(map.storms, [storm]);
  const eye = map.stateAt(0, 0),
    wall = map.stateAt(20000, 0),
    edge = map.stateAt(40000, 0),
    out = map.stateAt(60000, 0);
  assert.equal(eye.wind, 0);
  assert.equal(eye.rain, 0);
  assert.equal(wall.wind, 60, 'a storm wind over 60 m/s counts as 60');
  assert.equal(wall.gust, 1);
  assert.equal(wall.windDirection, 1);
  assert.equal(wall.cloud, WEATHER_PRESETS.partlyCloudy.cloud, 'fields left out keep the weather beneath');
  assert.equal(edge.wind, 12.5, 'half the storm blended over the base');
  assert.equal(out.wind, 5);
  assertState(wall);
  const remove = map.addStorm({ weatherAt: () => ({ weight: 1, fog: 1 }) });
  assert.equal(map.stateAt(20000, 0).fog, 1, 'storms apply in order');
  remove();
  assert.equal(map.storms.length, 1);
  assert.throws(() => map.addStorm({}), TypeError);
  assert.throws(() => new WeatherRegions({ storms: [{ weatherAt: () => ({ weight: 2 }) }] }).stateAt(0, 0), RangeError);
  map.dispose();
});

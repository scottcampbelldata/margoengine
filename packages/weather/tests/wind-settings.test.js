// One wind for the things that bend with it: scatter and creative grass take the weather's wind field through the
// drive; their direction is the field's within 5 degrees and their bend grows with the square of the speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive } from '../dist/drive.js';
import { VFX } from '../../vfx/dist/index.js';
import { WIND_BEND_FULL, WeatherMachine, grassWind, scatterWind, windBend } from '../dist/index.js';

const angle = (x, z) => Math.atan2(x, z),
  off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (180 / Math.PI);
const sceneWith = (...plugins) => {
  const engine = {
    plugins: new Map(plugins.map((p) => [p.name, p])),
    use: (p) => (engine.plugins.set(p.name, p), p.setup(engine)),
    removePlugin: () => {},
  };
  return engine;
};

test('bend grows with the square of the wind, from 0 to a full bend at 20 m/s', () => {
  assert.equal(windBend(0), 0);
  assert.equal(windBend(WIND_BEND_FULL), 1);
  assert.equal(windBend(40), 1);
  assert.ok(Math.abs(windBend(10) / windBend(5) - 4) < 1e-12, 'twice the wind, four times the bend');
  assert.ok(Math.abs(windBend(10) - 0.25) < 1e-12);
  assert.throws(() => windBend(-1), RangeError);
  assert.throws(() => windBend(NaN), RangeError);
});

test('scatterWind and grassWind give the direction the wind blows toward, and keep it in dead calm', () => {
  const s = scatterWind([3, 4]);
  assert.deepEqual(
    s.slice(0, 2).map((v) => +v.toFixed(12)),
    [0.6, 0.8],
  );
  assert.ok(Math.abs(s[2] - windBend(5)) < 1e-12);
  assert.equal(s[3], 5, 'the speed rides along for the thrash clock');
  assert.equal(scatterWind([300, 0])[3], 100, 'capped at the 100 m/s scatter takes');
  assert.deepEqual(scatterWind([0, 0], [0, -1]), [0, -1, 0, 0]);
  const g = grassWind([0, 10]);
  assert.deepEqual(g.windDirection, [0, 1]);
  assert.ok(Math.abs(g.windStrength - 0.5) < 1e-12 && Math.abs(g.windSpeed - 1.5) < 1e-12);
  assert.ok(grassWind([20, 0]).windStrength === 2 && grassWind([300, 0]).windSpeed <= 100);
  assert.deepEqual(grassWind([0, 0], [0.6, 0.8]), { windDirection: [0.6, 0.8], windStrength: 0, windSpeed: 0 });
});

test('vane: scatter and grass lean within 5 degrees of the wind field, and harder in a gale than a breeze', () => {
  for (const name of ['storm', 'drizzle']) {
    const weather = new WeatherMachine(name, { seed: 7 }),
      scatter = { name: 'scatter:1', options: { wind: [1, 0, 0.2] } },
      still = { name: 'scatter:2', options: {} },
      grass = { name: 'grass-field:1', windDirection: [1, 0.35], windStrength: 0.45, windSpeed: 1.2 },
      engine = sceneWith(scatter, still, grass);
    const drive = WeatherDrive.attach(engine, { weather });
    for (let i = 0; i < 12; i++) drive.update(0.5);
    const w = weather.wind.sample(0, 0, 0, weather.time),
      heading = angle(w[0], w[2]);
    assert.ok(off(angle(scatter.options.wind[0], scatter.options.wind[1]), heading) < 5, `${name} scatter`);
    assert.ok(off(angle(...grass.windDirection), heading) < 5, `${name} grass`);
    assert.ok(Math.abs(Math.hypot(scatter.options.wind[0], scatter.options.wind[1]) - 1) < 1e-9, 'unit direction');
    assert.ok(
      off(angle(still.options.wind[0], still.options.wind[1]), heading) < 5,
      `${name} a scatter built without a wind option is driven too`,
    );
    assert.deepEqual(still.options.wind, scatter.options.wind, 'the same wind as the one built with it');
    assert.ok(Math.abs(scatter.options.wind[2] - windBend(Math.hypot(w[0], w[2]))) < 1e-9);
    assert.ok(Math.abs(scatter.options.wind[3] - Math.hypot(w[0], w[2])) < 1e-9, 'the speed for the thrash clock');
    (globalThis.__bend ??= {})[name] = [scatter.options.wind[2], grass.windStrength];
  }
  assert.ok(
    globalThis.__bend.storm[0] > globalThis.__bend.drizzle[0] &&
      globalThis.__bend.storm[1] > globalThis.__bend.drizzle[1],
  );
});

test('targets handed in win over discovery, and auto false leaves the scene alone', () => {
  const weather = new WeatherMachine('storm', { seed: 7 }),
    found = { name: 'grass-field:1', windDirection: [1, 0], windStrength: 0.45, windSpeed: 1.2 },
    given = { windDirection: [1, 0], windStrength: 0.45, windSpeed: 1.2 },
    engine = sceneWith(found);
  WeatherDrive.attach(engine, { weather, grass: given }).update(1);
  assert.ok(given.windStrength !== 0.45 && found.windStrength === 0.45);
  const off1 = { name: 'grass-field:2', windDirection: [1, 0], windStrength: 0.45, windSpeed: 1.2 };
  WeatherDrive.attach(sceneWith(off1), { weather, auto: false }).update(1);
  assert.equal(off1.windStrength, 0.45);
});

test('vane: smoke and fire particles lean within 5 degrees of the wind field and move with its speed', () => {
  for (const name of ['storm', 'drizzle']) {
    const weather = new WeatherMachine(name, { seed: 7 }),
      smoke = new VFX({ capacity: 8, velocity: [0, 3, 0], wind: [0, 0] }),
      flames = new VFX({ capacity: 8, velocity: [0, 5, 0] }),
      engine = sceneWith(smoke, flames, { name: 'vfx-fire:0', particles: {} });
    const drive = WeatherDrive.attach(engine, { weather });
    for (let i = 0; i < 12; i++) drive.update(0.5);
    const w = weather.wind.sample(0, 0, 0, weather.time),
      heading = angle(w[0], w[2]);
    for (const effect of [smoke, flames]) {
      const [x, z] = effect.options.wind;
      assert.ok(off(angle(x, z), heading) < 5, `${name} ${effect.name}`);
      assert.ok(Math.abs(Math.hypot(x, z) - Math.hypot(w[0], w[2])) < 1e-9, 'the speed of the field');
    }
  }
  const effect = new VFX({ capacity: 8 }),
    given = new VFX({ capacity: 8 }),
    weather = new WeatherMachine('storm', { seed: 7 });
  WeatherDrive.attach(sceneWith(effect), { weather, vfx: given }).update(1);
  assert.ok(given.options.wind && effect.options.wind === undefined, 'a target handed in wins over discovery');
  WeatherDrive.attach(sceneWith(effect), { weather, auto: false }).update(1);
  assert.equal(effect.options.wind, undefined, 'auto false leaves the scene alone');
});

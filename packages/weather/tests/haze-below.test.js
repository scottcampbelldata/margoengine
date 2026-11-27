// KB-SKY-HAZEBELOW1: the drive gives the sky's fog the rate its haze's light falls below the eye (fog.lightDecay), the
// two-stream diffusion exponent of the load's albedo and asymmetry (Meador and Weaver 1980), so a far ground the haze
// hides fully darkens with the angle it is seen at instead of taking the horizon's one colour. It gives back what the fog
// had when the load leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherMachine, hazeLightDecay, smokeExtinction } from '../dist/index.js';
import { WeatherDrive } from '../dist/drive.js';
import { applyWeatherSettings } from '../dist/settings.js';

const engineOf = (...plugins) => ({
  plugins: new Map(plugins.map((p) => [p.name, p])),
  use: () => {},
  removePlugin: () => {},
});
// The two-stream exponent of one scatterer, by hand: g1 = 2 - w (1 + g), g2 = w (1 - g), k = sqrt(g1^2 - g2^2).
const k = (w, g) => Math.sqrt((2 - w * (1 + g)) ** 2 - (w * (1 - g)) ** 2);

test('smoke alone: the exponent of its albedo 0.89, 0.87, 0.84 and asymmetry 0.62, redder light deeper', () => {
  const d = hazeLightDecay({ smoke: 0.5 });
  [0.89, 0.87, 0.84].forEach((w, i) => assert.ok(Math.abs(d[i] - k(w, 0.62)) < 1e-12, `${d[i]} vs ${k(w, 0.62)}`));
  // About 0.49 at 550 nm: the light halves every 1.4 of vertical optical depth. Blue goes faster than red.
  assert.ok(d[1] > 0.45 && d[1] < 0.55, String(d[1]));
  assert.ok(d[0] < d[1] && d[1] < d[2], String(d));
});

test('no load gives 0, clean air in the mix slows the fall, sea spray barely absorbs', () => {
  assert.deepEqual(hazeLightDecay({}), [0, 0, 0]);
  const e = smokeExtinction(0.5),
    alone = hazeLightDecay({ smoke: 0.5 }, e),
    mixed = hazeLightDecay({ smoke: 0.5 }, 2 * e);
  assert.deepEqual(alone, hazeLightDecay({ smoke: 0.5 }));
  for (let i = 0; i < 3; i++) assert.ok(mixed[i] < alone[i] && mixed[i] > 0, `${mixed} vs ${alone}`);
  for (const v of hazeLightDecay({ spray: 0.6 })) assert.ok(v < 0.1, String(v));
});

test('the drive writes the fog its lightDecay under a load and gives back what it had after', () => {
  for (const decay of [undefined, [0.1, 0.1, 0.1]]) {
    const fog = { density: 0.01, falloff: 'exp', ...(decay ? { lightDecay: decay } : {}) },
      sky = { name: 'sky', zenithSun: 4 * Math.PI * 0.55, options: { fog, atmosphere: {} } },
      machine = new WeatherMachine('clear', { seed: 8 }),
      engine = engineOf(sky),
      drive = WeatherDrive.attach(engine, { weather: machine });
    drive.setup(engine);
    applyWeatherSettings(machine, { smoke: 0.5 });
    drive.update(0.5);
    const written = sky.options.fog.lightDecay;
    assert.equal(written.length, 3);
    for (const v of written) assert.ok(v > 0.2 && v < 0.6, String(written));
    applyWeatherSettings(machine, {});
    drive.update(0.5);
    assert.deepEqual(sky.options.fog.lightDecay, decay);
    assert.equal('lightDecay' in sky.options.fog, decay !== undefined);
  }
});

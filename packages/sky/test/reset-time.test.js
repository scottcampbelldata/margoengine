// GAP-FILM-RESET: every sky clock's `resetTime()` leaves it as a fresh one with the same options, before and after a
// seek. Sky and HillaireSky move `options.hours` as they run (the harness leaves options out), so their start hours are
// checked on their own; AstroSky consumes `options.date` and must go back to the moment it was built with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '@margoengine/sky';
import { AstroSky } from '@margoengine/sky/astro';
import { Aurora } from '@margoengine/sky/aurora';
import { HillaireSky } from '@margoengine/sky/hillaire';
import { degrees } from '@margoengine/sky/sun';
import { TornadoCloud } from '@margoengine/sky/tornado';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Weather } from '@margoengine/sky/weather';
import { assertResetLikeFresh, usedDeltas } from '../../../tests/support/clock-reset.js';

const hoursAfterReset = (make) => {
  const fresh = make(),
    used = make();
  for (const d of usedDeltas) used.advanceTime(d * 600);
  assert.notEqual(used.options.hours, fresh.options.hours, 'the run moved the hours');
  used.resetTime();
  assert.equal(used.options.hours, fresh.options.hours, 'hours back to the start');
  for (let i = 0; i < 90; i++) {
    fresh.advanceTime(1 / 60);
    used.advanceTime(1 / 60);
  }
  assert.equal(used.options.hours, fresh.options.hours, 'hours after a seek');
};

test('Sky.resetTime puts its clocks and its start hours back (GAP-FILM-RESET)', () => {
  const make = () => new Sky({ hours: 18.2, timeScale: 120 / 3600, clouds: { coverage: 0.5, speed: 30 } });
  assertResetLikeFresh(make, { label: 'Sky' });
  hoursAfterReset(make);
  // Built without hours: they go back to unset (12), as a fresh sky has them.
  hoursAfterReset(() => new Sky({ timeScale: 1 }));
});

test('HillaireSky.resetTime puts its clock, its start hours and its sun back (GAP-FILM-RESET)', () => {
  const make = () => new HillaireSky({ hours: 6.5, timeScale: 90 / 3600 });
  assertResetLikeFresh(make, { label: 'HillaireSky' });
  hoursAfterReset(make);
});

test('AstroSky.resetTime goes back to the moment it was built with (GAP-FILM-RESET)', () => {
  const make = () =>
    new AstroSky({
      latitude: degrees(52),
      longitude: degrees(0),
      date: new Date('2026-06-21T20:30:00Z'),
      timeScale: 30,
    });
  assertResetLikeFresh(make, { label: 'AstroSky' });
  const astro = make();
  for (const d of usedDeltas) astro.advanceTime(d);
  astro.resetTime();
  assert.equal(astro.date.getTime(), Date.parse('2026-06-21T20:30:00Z'));
});

test('Aurora, TornadoCloud and VolumetricClouds reset as fresh ones (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Aurora({ speed: 2 }), { label: 'Aurora' });
  assertResetLikeFresh(() => new TornadoCloud({ tornado: {} }), { label: 'TornadoCloud' });
  assertResetLikeFresh(() => new VolumetricClouds({ temporal: true, wind: [4, 1] }), { label: 'VolumetricClouds' });
});

test('Weather.resetTime clears the fade, the ground and the strikes, and replays the same strikes (GAP-FILM-RESET)', () => {
  const make = () =>
    new Weather({
      precipitation: 'sleet',
      intensity: 1,
      fadeSeconds: 3,
      wind: [4, 1],
      lightning: { seed: 7, rate: 600, threshold: 0 },
    });
  assertResetLikeFresh(make, { label: 'Weather', steps: 600 });
  // Listeners stay through a reset and hear the same strikes again.
  const weather = make(),
    heard = [];
  weather.onLightning((s) => heard.push(s.id));
  for (let i = 0; i < 300; i++) weather.onPreUpdate(1 / 60);
  const first = [...heard];
  assert.ok(first.length > 0, 'the run struck');
  weather.resetTime();
  heard.length = 0;
  for (let i = 0; i < 300; i++) weather.onPreUpdate(1 / 60);
  assert.deepEqual(heard, first);
});

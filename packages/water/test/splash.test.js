// Shot splashes (@margoengine/water/splash): the CPU half. Birkhoff's pressure law against Johnson and Reid's critical
// ricochet angle, the drop-limited height (Gunn and Kinzer 1949), the deep seal (Glasheen and McMahon 1996), the
// cavity-running path (May 1975), the plan of skips then an entry, and the ShotSplash class: emitters driven at each
// splash on the film clock, the column from the deep seal on, the foam rings and their CPU twin, the settings rows and
// a seek. The GPU half (the drawn foam on WebGPU and the WebGL2 layer) is splash.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAVITY_DRAG,
  COLUMN_DROP_FALL,
  CROWN_DROP_FALL,
  SPLASH_EMITTERS,
  ShotSplash,
  birkhoffContact,
  cavitySeal,
  dragLimitedHeight,
  entryDepth,
  planSplashes,
  ricochetAngle,
  skipFlight,
  sphereDragCoefficient,
} from '../dist/splash.js';
import { SPLASH_LOOKS, SPLASH_SETTINGS, applySplashSettings } from '../dist/settings.js';

const deg = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('Birkhoff contact gives the critical ricochet angle of Johnson and Reid within 6 percent', () => {
  for (const sigma of [2, 4, 7.02]) {
    const density = sigma * 1025;
    let lo = 0.5,
      hi = 40;
    for (let i = 0; i < 16; i++) {
      const m = (lo + hi) / 2,
        c = birkhoffContact([200 * Math.cos(m * deg), -200 * Math.sin(m * deg), 0], 0.08, density);
      if (c.ricochet) lo = m;
      else hi = m;
    }
    const jr = ricochetAngle(density) / deg;
    near(lo, jr, 0.06 * jr, `sigma ${sigma}`);
  }
  near(ricochetAngle(7200) / deg, 18 / Math.sqrt(7200 / 1025), 1e-12, '18 / sqrt(sigma)');
});

test('a skip leaves slower than it came and keeps its heading', () => {
  const v = [300 * Math.cos(3 * deg), -300 * Math.sin(3 * deg), 0],
    c = birkhoffContact(v, 0.0783, 7200);
  assert.equal(c.ricochet, true);
  assert.ok(Math.hypot(...c.velocity) < 300 && Math.hypot(...c.velocity) > 200);
  assert.ok(c.velocity[1] > 0 && Math.abs(c.velocity[2]) < 1e-9);
  const steep = birkhoffContact([300 * Math.cos(30 * deg), -300 * Math.sin(30 * deg), 0], 0.0783, 7200);
  assert.equal(steep.ricochet, false, 'a steep shot goes in');
});

test('the drop-limited height, the deep seal and the cavity-running path', () => {
  near(dragLimitedHeight(100, 6.5), (6.5 ** 2 / (2 * 9.81)) * Math.log(1 + (100 / 6.5) ** 2), 1e-12, 'quadratic drag rise');
  near(dragLimitedHeight(0.5, 6.5), 0.5 ** 2 / (2 * 9.81), 1e-4, 'slow drops rise ballistically');
  near(cavitySeal(0.08), 2.3 * Math.sqrt(0.08 / 9.81), 1e-12, 'deep seal');
  const l = (8 * 0.08 * 7200) / (3 * 1025 * CAVITY_DRAG);
  near(entryDepth(300, 0.08, 7200, 0.2), l * Math.log(1 + (300 * 0.2) / l), 1e-12, 'path');
  assert.ok(CROWN_DROP_FALL < COLUMN_DROP_FALL);
});

test('a grazing shot plans skips then an entry; a steep one goes straight in', () => {
  const graze = planSplashes({ time: 2, position: [768, 0, 0], velocity: [288, -10.9, 0], radius: 0.0783, density: 7200 }, { maxSkips: 3 });
  assert.deepEqual(graze.map((e) => e.kind), ['skip', 'skip', 'skip', 'entry']);
  for (let i = 1; i < graze.length; i++) {
    assert.ok(graze[i].time > graze[i - 1].time && graze[i].position[0] > graze[i - 1].position[0], 'onward');
    assert.ok(graze[i].speed < graze[i - 1].speed, 'slower each skip');
  }
  const steep = planSplashes({ time: 0, position: [0, 0, 0], velocity: [200, -200, 0], radius: 0.0783, density: 7200 });
  assert.equal(steep.length, 1);
  const e = steep[0];
  assert.equal(e.kind, 'entry');
  near(e.columnDelay, cavitySeal(0.0783), 1e-12, 'the column waits for the seal');
  near(e.columnSpeed, Math.sqrt(2 * 9.81 * 0.5 * entryDepth(e.speed, 0.0783, 7200, e.columnDelay)), 1e-9, 'jet from the pinch depth');
  near(e.crownSpeed, e.speed * Math.sqrt(CAVITY_DRAG / 2) * Math.sqrt(Math.sin(45 * deg)), 1e-9, 'Logvinovich sheet speed');
  near(e.crownHeight, dragLimitedHeight(e.crownSpeed, CROWN_DROP_FALL), 1e-12, 'crown height');
});

const emitter = () => ({ options: {}, bursts: [], burst(n) { this.bursts.push(n); } });

test('ShotSplash drives each splash on the film clock and runs the column from the deep seal', () => {
  const impact = { time: 1, position: [10, 0.5, 20], velocity: [100, -150, 0], radius: 0.0783, density: 7200 };
  const made = [];
  const splash = new ShotSplash({ source: [impact], particles: (kind, slot) => { const e = emitter(); made.push([kind, slot]); return e; }, slots: 2 });
  assert.equal(made.length, 6);
  for (let i = 0; i < 29; i++) splash.advanceTime(1 / 30);
  assert.equal(splash.active().length, 0);
  splash.advanceTime(1 / 30);
  splash.advanceTime(1 / 30);
  const [a] = splash.active(),
    slot = splash.slots[a.slot];
  assert.equal(a.event.kind, 'entry');
  assert.ok(slot.crown.bursts[0] > 0 && slot.mist.bursts[0] > 0);
  near(slot.crown.options.velocity[1], Math.sqrt(2 * 9.81 * a.event.crownHeight), 1e-9, 'launched to the crown height');
  assert.deepEqual(slot.crown.options.position.slice(0, 1), [10]);
  assert.equal(slot.column.options.rate, 0, 'no column before the seal');
  while (splash.time < 1 + a.event.columnDelay + 0.01) splash.advanceTime(1 / 60);
  assert.ok(slot.column.options.rate > 0, 'the column runs after the seal');
  near(slot.column.options.velocity[1], Math.sqrt(2 * 9.81 * a.event.columnHeight), 1e-9, 'launched to the jet height');
  for (let i = 0; i < 60; i++) splash.advanceTime(1 / 30);
  assert.equal(slot.column.options.rate, 0, 'and stops');
});

test('foam rings spread and fade, and sample is the drawn foam', () => {
  const splash = new ShotSplash({ source: [{ time: 0, position: [0, 0, 0], velocity: [0, -200, 0], radius: 0.08, density: 7200 }], particles: emitter });
  splash.advanceTime(0.5);
  const [r0] = splash.rings();
  assert.ok(splash.sample(0, 0) > 0.3 && splash.sample(r0[2] * 2, 0) < 1e-3);
  splash.advanceTime(20);
  const [r1] = splash.rings();
  assert.ok(r1[2] > r0[2] && r1[3] < r0[3], 'wider and fainter');
  const v = splash.build();
  assert.equal(v[0], 1);
  assert.deepEqual([...v.slice(4, 8)], [...new Float32Array(r1)]);
  splash.setLook({ foamWidth: 0 });
  assert.equal(splash.rings().length, 0);
});

test('the same frames give the same splashes, whatever the frame steps (a seek)', () => {
  const run = (dt, n) => {
    const s = new ShotSplash({ source: [{ time: 0.3, position: [0, 0, 0], velocity: [250, -15, 0], radius: 0.0783, density: 7200 }], particles: emitter });
    for (let i = 0; i < n; i++) s.advanceTime(dt);
    return s.events.map((e) => [e.kind, e.time]).concat(s.rings().map((r) => r.map((x) => x.toFixed(9))));
  };
  assert.deepEqual(run(1 / 30, 300), run(1 / 30, 300));
  assert.deepEqual(run(1 / 30, 300).slice(0, 4), run(1 / 60, 600).slice(0, 4));
});

test('settings rows: all live, the looks apply, null wind follows the weather', () => {
  for (const row of SPLASH_SETTINGS) assert.equal(row.live, true, row.name);
  assert.ok(SPLASH_SETTINGS.some((r) => r.name === 'waveLift'));
  const splash = new ShotSplash({ particles: emitter, slots: 2 });
  applySplashSettings(splash, SPLASH_LOOKS.gale);
  assert.equal(splash.look.mist, 1.6);
  assert.equal(splash.slots[0].mist.options.wind, undefined);
  applySplashSettings(splash, { 'wind.z': -4 });
  assert.deepEqual(splash.slots[1].crown.options.wind, [0, -4]);
  assert.equal(splash.look.mist, 1, 'left-out rows return to their defaults');
  assert.throws(() => applySplashSettings(splash, { crown: -1 }), RangeError);
  assert.throws(() => applySplashSettings(splash, { foo: 1 }), TypeError);
  assert.ok(SPLASH_EMITTERS.crown.capacity > 0);
});

test('between skips the ball flies against air drag: the quadratic-drag range in closed form', () => {
  // A flat skip at a fixed drag coefficient: the horizontal speed falls as u0 / (1 + k u0 t), so the range is
  // ln(1 + k u0 T) / k with k = rho_air Cd A / (2 m) (the vertical speed is a twentieth of u0, so |v| is u within 0.13%).
  const radius = 0.0783,
    density = 7200,
    mass = (density * 4 * Math.PI * radius ** 3) / 3,
    k = (0.5 * 1.225 * 0.47 * Math.PI * radius ** 2) / mass;
  const land = skipFlight([0, 0, 0], [100, 5, 0], radius, density, { drag: 0.47 });
  near(land.position[0], Math.log(1 + k * 100 * land.time) / k, 2e-4 * land.position[0], 'range against Poncelet quadratic drag');
  const vacuum = skipFlight([0, 0, 0], [100, 5, 0], radius, density, { drag: false });
  near(vacuum.time, (2 * 5) / 9.81, 2e-3, 'no drag: the vacuum flight time');
  near(vacuum.position[0], 100 * vacuum.time, 1e-6, 'and range');
  assert.ok(land.position[0] < vacuum.position[0] - 1, 'drag shortens the skip');
  // Hoerner's sphere: 0.47 subsonic, 0.92 supersonic.
  assert.equal(sphereDragCoefficient(0.2), 0.47 + (0.03 * 0.2) / 0.6);
  assert.equal(sphereDragCoefficient(3), 0.92);
});

test('a crosswind moves a skipping ball by the lag-time rule (McCoy 1999)', () => {
  const W = 10,
    land = skipFlight([0, 0, 0], [300, 12, 0], 0.0783, 7200, { wind: [0, W] }),
    lag = W * (land.time - land.position[0] / 300);
  near(land.position[2], lag, 0.03 * lag, 'deflection W (T - X / u0)');
  // A wind field is read along the path.
  const field = skipFlight([0, 0, 0], [300, 12, 0], 0.0783, 7200, { wind: { sample: () => [0, 0, W] } });
  near(field.position[2], land.position[2], 1e-9, 'a field of the same wind');
  // planSplashes and ShotSplash fly their skips in it.
  const impact = { time: 0, position: [0, 0, 0], velocity: [250, -15, 0], radius: 0.0783, density: 7200 };
  const calm = planSplashes(impact),
    windy = planSplashes(impact, { wind: [0, W] });
  assert.ok(calm.length >= 2 && Math.abs(calm[1].position[2]) < 1e-9);
  assert.ok(windy[1].position[2] > 0.5, `the second graze is blown downwind: ${windy[1].position[2]}`);
  const splash = new ShotSplash({ source: [impact], particles: emitter, wind: [0, W] });
  splash.advanceTime(0.01);
  near(splash.events[1].position[2], windy[1].position[2], 1e-9, 'ShotSplash takes its wind');
  const weather = new ShotSplash({ source: [impact], particles: () => Object.assign(emitter(), { options: { wind: [0, W] } }) });
  weather.advanceTime(0.01);
  near(weather.events[1].position[2], windy[1].position[2], 1e-9, 'and else the wind the weather wrote on its spray');
});

test('the spray rides the waves: the surface height and velocity of the water', () => {
  let h = 1.3;
  const water = { sample: () => ({ height: h, velocity: [0.5, 2, -1] }) };
  const impact = { time: 0, position: [4, 0, 2], velocity: [0, -200, 0], radius: 0.0783, density: 7200 };
  const splash = new ShotSplash({ source: [impact], particles: emitter, water, slots: 1 });
  splash.advanceTime(1 / 30);
  const [a] = splash.active(),
    slot = splash.slots[0],
    up = Math.sqrt(2 * 9.81 * a.event.crownHeight);
  near(slot.crown.options.position[1], 1.35, 1e-9, 'the crown rises from the wave');
  near(slot.crown.options.velocity[1], up + 2, 1e-9, 'and carries its surface velocity');
  near(slot.crown.options.velocity[2], -1, 1e-9, 'sideways too');
  near(slot.mist.options.velocity[0], 1.5 + 0.5, 1e-9, 'the mist drifts with it');
  h = -0.8;
  while (splash.time < a.event.columnDelay + 0.02) splash.advanceTime(1 / 60);
  assert.ok(slot.column.options.rate > 0);
  near(slot.column.options.position[1], -0.7, 1e-9, 'the column rides the wave as it falls');
  near(slot.column.options.velocity[1], Math.sqrt(2 * 9.81 * a.event.columnHeight) + 2, 1e-9, 'jet plus the surface');
  splash.setLook({ waveLift: 0 });
  splash.advanceTime(1 / 60);
  near(slot.column.options.position[1], 0.1, 1e-9, 'waveLift 0: the impact at rest');
  near(slot.column.options.velocity[0], 0, 1e-12, 'with no surface velocity');
  assert.deepEqual(splash.surface([0, 0.25, 0]), [0.25, [0, 0, 0]]);
  splash.setLook({ waveLift: 0.5 });
  assert.deepEqual(splash.surface([0, 0, 0]), [-0.4, [0.25, 1, -0.5]]);
});

test('bad options throw', () => {
  assert.throws(() => new ShotSplash({}), TypeError);
  assert.throws(() => new ShotSplash({ particles: () => ({}) }), TypeError);
  assert.throws(() => birkhoffContact([1, 1, 0], 0.08, 7200), RangeError);
  assert.throws(() => planSplashes(null), TypeError);
});

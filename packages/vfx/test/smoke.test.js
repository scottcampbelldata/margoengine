// Smoke (@margoengine/vfx/smoke): a smoke column that rises by the plume law. The CPU half: the buoyancy flux of a
// heat release, the calm plume of Morton, Taylor and Turner 1956, the bent-over "2/3 law" plume and the stable final
// rises of Briggs 1969, the curves a Smoke writes for its particles (rewritten in place, never reallocated), the wind
// rule it shares with Fire, and option errors. The GPU half (puffs read back on WebGPU and the WebGL2 layer: rise,
// lean, the same bytes twice, no GPU object over 60 frames) is smoke-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Smoke,
  airStability,
  buoyancyFlux,
  plumeRise,
  PLUME_ENTRAINMENT,
  TWO_THIRDS_LAW,
  BENT_PLUME_RADIUS,
  RADIANT_FRACTION,
  SMOKE_FADE_IN,
  smokeAlphaCurve,
} from '../dist/smoke.js';
import { evaluateNodes } from '../dist/nodes.js';
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

const near = (got, want, rel, label) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${label}: ${got} against ${want} (within ${rel * 100}%)`);

test('buoyancy flux: Briggs eq. 4.20, F = g Q / (pi c_p rho T): about 8.8 m^4/s^3 a megawatt at 15 C', () => {
  near(buoyancyFlux(1e6), 8.8, 0.005, '1 MW');
  near(buoyancyFlux(5e6) / buoyancyFlux(1e6), 5, 1e-12, 'linear in the heat');
  near(buoyancyFlux(1e6, 300) / buoyancyFlux(1e6), 288.15 / 300, 1e-12, 'over the air temperature');
  assert.equal(buoyancyFlux(0), 0);
  assert.throws(() => buoyancyFlux(-1), RangeError);
  assert.throws(() => buoyancyFlux(1e6, 0), RangeError);
  near(airStability(0.0098), 3.34e-4, 0.01, 'isothermal air');
});

test('calm plume: MTT 1956 similarity: radius (6/5) alpha z, speed falling as z^(-1/3), rise t^(3/4)', () => {
  const F = buoyancyFlux(5e6),
    a = PLUME_ENTRAINMENT,
    W = Math.cbrt((25 * F) / (48 * a * a));
  // Far above a small source the plume forgets it: rise^(4/3) = (4/3) W t, the closed form of dz/dt = W z^(-1/3).
  const p = plumeRise(600, F, 0, 0.01);
  near(p.rise, ((4 / 3) * W * 600) ** 0.75, 0.002, 'rise at 600 s');
  near(p.speed, W / Math.cbrt(p.rise), 0.002, 'speed');
  near(p.radius, 1.2 * a * p.rise, 0.002, 'radius');
  assert.equal(p.bent, false);
  // MTT's fluxes: with b = (6/5) alpha z and w = W z^(-1/3), the buoyancy flux b^2 w g' is F at every height when
  // d(b^2 w^2)/dz = b^2 g' (the momentum equation), so (4/3) b^2 w^2 / z = F / w.
  for (const t of [10, 100, 1000]) {
    const q = plumeRise(t, F, 0, 0.001),
      z = q.rise;
    near(((4 / 3) * q.radius ** 2 * q.speed ** 3) / z, F, 0.01, `buoyancy flux at ${t} s`);
  }
  // A source of radius r0 starts the column at that width (the virtual origin lies r0 / (1.2 alpha) below it).
  const s = plumeRise(0, F, 0, 2);
  assert.equal(s.rise, 0);
  near(s.radius, 2, 1e-9, 'source radius');
});

test('bent-over plume: Briggs eq. 4.31, rise 1.6 F^(1/3) x^(2/3) / U downwind, radius 0.5 z', () => {
  const F = buoyancyFlux(5e6);
  for (const U of [2, 5, 15]) {
    const t = 300,
      p = plumeRise(t, F, U, 0.001);
    assert.equal(p.bent, true, `bent at ${U} m/s`);
    near(p.rise, (TWO_THIRDS_LAW * Math.cbrt(F) * (U * t) ** (2 / 3)) / U, 0.01, `rise at ${U} m/s`);
    near(p.radius, BENT_PLUME_RADIUS * p.rise, 0.01, `radius at ${U} m/s`);
    // Dividing the wind by 8 doubles the rise at a given time (U^(-1/3)) and multiplies it by 4 at a given distance.
    near(plumeRise(t, F, U / 8, 0.001).rise / p.rise, 2, 0.02, 'U^(-1/3) at a time');
  }
  // The column always follows the lower plume, so wind never lifts it: the calm column bounds every bent one.
  for (const t of [0.5, 5, 50]) assert.ok(plumeRise(t, F, 3, 2).rise <= plumeRise(t, F, 0, 2).rise + 1e-9);
});

test('stable air: the column levels off at Briggs eq. 4.25 (calm) and eq. 5.7 (wind) and stops rising', () => {
  const F = buoyancyFlux(5e6),
    s = airStability(0.0098);
  const calm = plumeRise(3600, F, 0, 2, s);
  assert.equal(calm.level, true);
  near(calm.rise, 5.0 * F ** 0.25 * s ** -0.375, 1e-12, 'calm final rise');
  assert.equal(calm.speed, 0);
  const windy = plumeRise(3600, F, 5, 2, s);
  near(windy.rise, 2.9 * Math.cbrt(F / (5 * s)), 1e-12, 'windy final rise');
  assert.equal(plumeRise(1, F, 5, 2, s).level, false, 'below the ceiling it still rises');
  assert.equal(plumeRise(3600, F, 0, 2, 0).level, false, 'neutral air has no ceiling');
});

// The curve the GPU follows: a particle's velocity is w0 times the piecewise-linear speed curve at its age (the
// overLife edit of the simulation), stepped at 1/60 s. Its height stays within 7% of the law after the first second
// and its top within 4% (the 32 samples cannot follow the kink where a column bends over; measured 5.9% at 2 m/s).
const climb = (smoke, frames, dt) => {
  const { speed } = smoke.effect.options.overLife,
    w0 = smoke.effect.options.velocity[1],
    L = smoke.effect.options.lifetime[0],
    n = speed.length,
    at = (a) => {
      const x = Math.min(1, Math.max(0, a)) * (n - 1),
        k = Math.min(Math.floor(x), n - 2);
      return speed[k] + (speed[k + 1] - speed[k]) * (x - k);
    };
  let v = w0 * speed[0],
    z = 0;
  const heights = [];
  for (let i = 1; i <= frames; i++) {
    v += w0 * (at((i * dt) / L) - at(((i - 1) * dt) / L));
    z += v * dt;
    heights.push(z);
  }
  return heights;
};

test('Smoke writes the plume as its puffs\' speed and size curves, within 7% of the law and 4% at the top', () => {
  for (const U of [0, 2, 5, 15]) {
    const h = optionalGPU(),
      smoke = Smoke.attach(h.engine, { position: [0, 0, 0], heat: 5e6, prewarm: false, ...(U ? { wind: [U, 0] } : {}) });
    h.frame();
    const heights = climb(smoke, 3600, 1 / 60);
    let worst = 0;
    for (let i = 59; i < heights.length; i++) worst = Math.max(worst, Math.abs(heights[i] / smoke.column((i + 1) / 60).rise - 1));
    assert.ok(worst <= 0.07, `${U} m/s: worst ${worst}`);
    near(heights.at(-1), smoke.column(60).rise, 0.04, `${U} m/s top`);
    // The size curve is the column's radius over the source radius.
    const { size } = smoke.effect.options.overLife;
    near(size.at(-1), smoke.column(60).radius / 2, 1e-9, 'size at the top');
    assert.equal(smoke.effect.options.size, 4, 'born at the source width');
    smoke.dispose();
  }
});

test('Smoke rewrites its curves in place when the wind or heat changes, and makes no GPU object after attach', () => {
  const h = optionalGPU(),
    smoke = Smoke.attach(h.engine, { position: [0, 2, 0], prewarm: false });
  h.frame();
  const { speed, size } = smoke.effect.options.overLife,
    before = [...speed],
    made = h.resources.length;
  for (let f = 0; f < 60; f++) {
    smoke.setWind([1 + f / 10, -f / 20]);
    smoke.options.heat = 1e6 + f * 1e5;
    smoke.options.color = [0.2 + f / 200, 0.2, 0.2];
    smoke.options.opacity = 0.3 + f / 200;
    smoke.options.turbulence = f / 30;
    h.frame();
  }
  assert.equal(h.resources.length, made, 'no buffer or texture made over 60 frames');
  assert.equal(smoke.effect.options.overLife.speed, speed, 'the same array');
  assert.equal(smoke.effect.options.overLife.size, size, 'the same array');
  assert.notDeepEqual([...speed], before, 'the wind bent the column');
  assert.deepEqual(smoke.effect.options.color.map((c) => +c.toFixed(6)), [0.495, 0.2, 0.2, 0.595]);
  smoke.dispose();
});

test('Smoke follows the wind rule of Fire: its own wind stays, without one it takes the fire\'s, and calm is upright', () => {
  const h = optionalGPU();
  const own = Smoke.attach(h.engine, { position: [0, 0, 0], wind: [4, 0], prewarm: false });
  h.frame();
  assert.deepEqual(own.effect.options.wind, [4, 0]);
  near(own.column(30).rise, plumeRise(30, buoyancyFlux(5e6), 4, 2).rise, 1e-12, 'the column bends in its own wind');
  own.setWind(undefined);
  h.frame();
  assert.equal(own.effect.options.wind, undefined, 'given back to the weather');
  near(own.column(30).rise, plumeRise(30, buoyancyFlux(5e6), 0, 2).rise, 1e-12, 'upright in calm air');
  // A fire's flames carry the wind (its own, or the drive's): the smoke over it takes that wind each frame.
  const flames = { options: { position: [1, 0.5, 2], wind: [3, 4] } },
    fed = Smoke.attach(h.engine, { fire: { particles: { flames } }, prewarm: false });
  h.frame();
  assert.deepEqual(fed.effect.options.position, [1, 0.5, 2], 'stands on the flames');
  assert.deepEqual(fed.effect.options.wind, [3, 4]);
  near(fed.column(10).rise, plumeRise(10, buoyancyFlux(20000), 5, 0.3).rise, 1e-12, 'a hearth fire in the fire\'s wind');
  flames.options.wind = [0, 1];
  h.frame();
  assert.deepEqual(fed.effect.options.wind, [0, 1], 'follows the fire');
  own.dispose();
  fed.dispose();
});

test('Smoke in calm air drags its puffs toward rest as a wind would toward itself (KB-FIRE-SMOKEVEIL1)', () => {
  // Without a wind the curl churn (an acceleration) had nothing to hold it: over a minute's life it walked puffs
  // hundreds of metres, along the ground and over the camera, a dark veil over a fire. A puff now feels the 0.25 s drag
  // of the wind rule toward rest; a wind takes the drag over (toward itself) and the still-air term goes to 0.
  const h = optionalGPU();
  const sample = { position: [0, 0, 0], velocity: [3, 5, -2], size: 1, color: [1, 1, 1], life: 1, age: 0 };
  const calm = Smoke.attach(h.engine, { position: [0, 0, 0], prewarm: false });
  h.frame();
  const graph = calm.effect.options.nodes.graph;
  assert.deepEqual(evaluateNodes(graph, sample), [-12, 0, 8], 'horizontal drag 4/s toward rest; the rise is left alone');
  calm.setWind([0, 0]);
  h.frame();
  assert.deepEqual(evaluateNodes(graph, sample), [-12, 0, 8], '[0, 0] is calm air too');
  calm.setWind([5, 0]);
  h.frame();
  assert.deepEqual(evaluateNodes(graph, sample).map(Math.abs), [0, 0, 0], 'a wind does the dragging itself');
  calm.setWind({ sample: () => [0, 0, 0] });
  h.frame();
  assert.deepEqual(evaluateNodes(graph, sample), [-12, 0, 8], 'a field that is calm at the column');
  const flames = { options: { position: [1, 0.5, 2], wind: [3, 4] } },
    fed = Smoke.attach(h.engine, { fire: { particles: { flames } }, prewarm: false });
  assert.deepEqual(evaluateNodes(fed.effect.options.nodes.graph, sample).map(Math.abs), [0, 0, 0], "in the fire's wind from attach");
  calm.dispose();
  fed.dispose();
});

test('Smoke options: bad values name the fix', () => {
  const h = optionalGPU();
  assert.throws(() => Smoke.attach(h.engine, {}), /position/);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0] }), TypeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], heat: -1 }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], radius: 0 }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], lifetime: 0 }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], opacity: 2 }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], color: [2, 0, 0] }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], stability: -1 }), RangeError);
  assert.throws(() => Smoke.attach(h.engine, { fire: {} }), /Fire/);
  assert.throws(() => Smoke.attach(h.engine, null), TypeError);
});

// KB-VFX-SMOKEROPE1: a fire front's columns were a thin grey rope (2 m source, 60 s life, standing on the ground in
// neutral air), new puffs took a fifth of their life (12 s) to show, and at night nothing lit them.
test('a puff shows within a second whatever its lifetime; the column keeps its fade at the top', () => {
  for (const life of [6, 60, 300]) {
    const a = smokeAlphaCurve(life),
      at = (sec) => {
        const x = (sec / life) * (a.length - 1),
          i = Math.min(a.length - 2, Math.floor(x));
        return a[i] + (a[i + 1] - a[i]) * (x - i);
      };
    assert.equal(a.length, 32);
    // The old curve [0, 1, 1, 0.85, 0.5, 0] showed 0.083 at 1 s of a 60 s life and 0.017 of a 300 s life.
    assert.ok(at(SMOKE_FADE_IN) >= 0.7, `${life} s life: alpha ${at(SMOKE_FADE_IN)} at 1 s`);
    assert.ok(at(2 * SMOKE_FADE_IN) >= 0.9, `${life} s life: alpha ${at(2 * SMOKE_FADE_IN)} at 2 s`);
    assert.equal(a.at(-1), 0, 'gone at the end');
    near(at(0.8 * life), 0.5, 0.02, `${life} s life at 0.8 of its life`);
  }
  const h = optionalGPU(),
    smoke = Smoke.attach(h.engine, { position: [0, 0, 0], prewarm: false, lifetime: 60 });
  assert.deepEqual(smoke.effect.options.curves.alpha, smokeAlphaCurve(60));
  smoke.dispose();
});

test('the column glows from below: a point at its source radiating 0.3 of the release lights the puffs; glow: 0 turns it off', () => {
  const h = optionalGPU(),
    smoke = Smoke.attach(h.engine, { position: [5, 10, -3], heat: 7e6, radius: 4, prewarm: false });
  h.frame();
  const g = smoke.effect.options.lit.glow;
  assert.deepEqual([...g.position], [5, 10, -3]);
  near(g.power, (RADIANT_FRACTION / 0.7) * 7e6, 1e-12, 'radiant power');
  assert.equal(g.radius, 4);
  smoke.setHeat(14e6);
  smoke.options.position = [6, 11, -2];
  h.frame();
  near(smoke.effect.options.lit.glow.power, 6e6, 1e-12, 'follows the heat');
  assert.deepEqual([...smoke.effect.options.lit.glow.position], [6, 11, -2]);
  smoke.options.glow = 2;
  h.frame();
  near(smoke.effect.options.lit.glow.power, 12e6, 1e-12, 'glow scales the power');
  smoke.options.glow = 0;
  h.frame();
  assert.equal(smoke.effect.options.lit.glow, undefined, 'glow 0 is off');
  smoke.options.glow = 11;
  assert.throws(() => h.frame(), RangeError);
  smoke.options.glow = 1;
  assert.throws(() => Smoke.attach(h.engine, { position: [0, 0, 0], glow: 'yes' }), RangeError);
  smoke.dispose();
});

test('refill empties the column and fills it again for its new place on the next frame', () => {
  const h = optionalGPU(),
    smoke = Smoke.attach(h.engine, { position: [0, 0, 0], heat: 1e6, lifetime: 10, prewarm: false });
  for (let f = 0; f < 30; f++) h.frame();
  assert.ok(smoke.effect.seconds > 0);
  smoke.refill();
  assert.equal(smoke.effect.seconds, 0, 'back to its start, prewarm pending');
  smoke.dispose();
});

test('a fire front stands its columns on the flames: source as wide as the burning ground, a 300 s life that levels into a pall', async () => {
  const { FireFront } = await import('../dist/fire-front.js'),
    h = optionalGPU(),
    front = FireFront.attach(h.engine, {
      size: [600, 300], cell: 8, fuel: 'FM10', moisture: 0.05, wind: [12, 0], spotting: 0, columns: 2, flames: 0, buildingFlames: 0,
      ignitions: [{ at: [-250, 0], radius: 40 }],
    });
  await front.ready;
  front.advanceTime(60);
  const col = front.smokeColumns[0],
    seg = front.segments()[0];
  assert.ok(seg.flameLength > 5, `flame ${seg.flameLength}`);
  assert.deepEqual([...col.effect.options.lifetime], [300, 300]);
  assert.equal(col.options.stability, 1.5e-4);
  near(col.options.position[1], seg.y + seg.flameLength, 1e-9, 'the column leaves the flame tops');
  near(col.options.radius, Math.min(60, Math.sqrt((seg.cells * 64) / Math.PI)), 1e-9, 'source radius of the burning ground');
  assert.ok(col.options.radius > 2, `radius ${col.options.radius}`);
  // In the pall's stable air the column levels off at Briggs' final rise, a few hundred metres up.
  const top = col.column(300);
  assert.ok(top.level && top.rise > 150 && top.rise < 2000, `levels at ${top.rise} m`);
  front.dispose();
  const own = FireFront.attach(h.engine, { size: [200, 200], columns: 1, flames: 0, buildingFlames: 0, smoke: { radius: 5, lifetime: 40 }, ignitions: [{ at: [0, 0], radius: 20 }] });
  await own.ready;
  own.advanceTime(5);
  assert.equal(own.smokeColumns[0].options.radius, 5, 'a radius the scene gave stays');
  assert.deepEqual([...own.smokeColumns[0].effect.options.lifetime], [40, 40]);
  own.dispose();
});

test('KB-VFX-FRONTSMOKE-LOOK1: a smoke look reaches a fire front\'s columns, made before or after, and keeps their per-column heat and radius', async () => {
  const [{ FireFront }, { applySmokeSettings, SMOKE_LOOKS }] = await Promise.all([import('../dist/fire-front.js'), import('../dist/settings.js')]),
    h = optionalGPU(),
    opts = {
      size: [600, 300], cell: 8, fuel: 'FM10', moisture: 0.05, wind: [12, 0], spotting: 0, columns: 2, flames: 0, buildingFlames: 0,
      ignitions: [{ at: [-250, 0], radius: 40 }],
    },
    front = FireFront.attach(h.engine, opts);
  // Given before the columns exist: the front writes it onto them as it makes them.
  applySmokeSettings(front, SMOKE_LOOKS.animatedFeature);
  await front.ready;
  front.advanceTime(60);
  const col = front.smokeColumns[0],
    seg = front.segments()[0],
    radius = Math.min(60, Math.sqrt((seg.cells * 64) / Math.PI));
  assert.deepEqual(col.options.color, [...SMOKE_LOOKS.animatedFeature.color]);
  assert.equal(col.options.opacity, SMOKE_LOOKS.animatedFeature.opacity);
  assert.equal(col.options.rate, SMOKE_LOOKS.animatedFeature.rate);
  assert.equal(col.options.lifetime, 300, 'a row the look leaves out keeps what the front built');
  assert.equal(col.options.stability, 1.5e-4);
  near(col.options.radius, radius, 1e-9, 'the radius still follows the segment');
  near(col.options.heat, seg.heat, 1e-9, 'the heat still follows the segment');
  // Given after: written now, without resetting the per-column sizes or heat, and never onto the front's own options.
  applySmokeSettings(front, SMOKE_LOOKS.houseFire);
  assert.deepEqual(col.options.color, [...SMOKE_LOOKS.houseFire.color]);
  assert.equal(col.options.opacity, SMOKE_LOOKS.houseFire.opacity);
  near(col.options.radius, radius, 1e-9, 'a look radius does not reset the column');
  near(col.options.heat, seg.heat, 1e-9, 'a look heat does not reset the column');
  assert.ok(!('color' in front.options) && !('heat' in front.options) && !('opacity' in front.options), 'the front options stay clean');
  // natural gives back what the front built the column with.
  applySmokeSettings(front, SMOKE_LOOKS.natural);
  assert.deepEqual(col.options.color, [0.24, 0.22, 0.2]);
  assert.equal(col.options.opacity, 0.6);
  assert.equal(col.options.rate, 16);
  front.dispose();
  // A radius the scene gave stays under a look.
  const own = FireFront.attach(h.engine, { ...opts, columns: 1, smoke: { radius: 5 } });
  await own.ready;
  own.advanceTime(5);
  applySmokeSettings(own, SMOKE_LOOKS.wildfire);
  own.advanceTime(1);
  assert.equal(own.smokeColumns[0].options.radius, 5);
  assert.deepEqual(own.smokeColumns[0].options.color, [...SMOKE_LOOKS.wildfire.color]);
  own.dispose();
});

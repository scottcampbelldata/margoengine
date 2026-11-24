// BlastCloud of @margoengine/weather/eruption: the instantaneous source of Morton, Taylor and Turner (1956) measured
// against its similarity laws, determinism over film time, and the puffs it draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlastCloud, airStability, thermalTop } from '../dist/eruption.js';

test('in still uniform air the thermal spreads as b = b0 + alpha z and rises as z^2 = A^2 t (Scorer 1957)', () => {
  const alpha = 0.25,
    k = 0.5;
  const c = new BlastCloud({
    sources: [{ tnt: 1e6, radius: 5 }],
    stability: 0,
    entrainment: alpha,
    addedMass: k,
    horizon: 900,
  });
  const [a] = c.thermals(600),
    [b] = c.thermals(900);
  assert.ok(Math.abs(b.radius - (5 + alpha * b.height)) < 1e-6 * b.height, 'b - b0 = alpha z');
  // d/dt((1 + k) b^3 w) = B with b = alpha z gives z = A t^(1/2), A^4 = 2 B / ((1 + k) alpha^3).
  const A2 = Math.sqrt((2 * b.sourceBuoyancy) / ((1 + k) * alpha ** 3)),
    slope = (b.height ** 2 - a.height ** 2) / 300;
  assert.ok(Math.abs(slope / A2 - 1) < 0.02, `z^2 grows at ${slope}, the law ${A2}`);
  assert.ok(Math.abs(b.buoyancy * b.radius ** 3 - b.sourceBuoyancy) / b.sourceBuoyancy < 1e-9, 'buoyancy is conserved');
});

test('in stable air the thermal stops at a height scaling as B^(1/4) N^(-1/2) (Morton et al. 1956)', () => {
  const N2 = 1e-4,
    B = 1e7,
    h = thermalTop(B, N2, 0.25, 0.5, 1);
  assert.ok(
    Math.abs(thermalTop(16 * B, N2, 0.25, 0.5, 1) / h - 2) < 0.03,
    'sixteen times the buoyancy rises twice as high',
  );
  assert.ok(Math.abs(thermalTop(B, N2 / 16, 0.25, 0.5, 1) / h - 2) < 0.03, 'a quarter of N rises twice as high');
  // ICAO troposphere: N^2 = g / T (dT/dz + g / c_p) = 9.80665 / 288.15 (-0.0065 + 0.009758).
  assert.ok(Math.abs(airStability(0) - (9.80665 / 288.15) * (-0.0065 + 9.80665 / 1005)) < 1e-6);
  assert.ok(airStability(15000) > 3 * airStability(0), 'the stratosphere is far more stable');
});

test('the cloud is a function of film time: seeks in any order, and update, give the same thermals', () => {
  const make = () =>
    new BlastCloud({
      sources: [
        { at: 0, tnt: 1.6e6, speed: 40 },
        { at: 2, tnt: 5e5, position: [60, 0, 10], speed: 30 },
      ],
      wind: 6,
    });
  const a = make(),
    b = make();
  a.seek(37.3);
  b.seek(200);
  b.seek(3);
  for (let i = 0; i < 343; i++) b.update(0.1);
  assert.deepEqual(a.thermals(), b.thermals(37.3));
  const [, second] = a.thermals(1.5);
  assert.equal(second.height, 0, 'the second source has not gone off');
  assert.equal(second.fire, 0);
  const [first] = a.thermals(37.3);
  assert.ok(first.centre[2] > 0, 'the wind drifts the cap toward +Z');
  assert.ok(first.height > 300 && first.radius > first.height * 0.2, 'a rising mushroom cap');
});

test('draw lays out one cap, one stem and one fire cloud for all sources, and takes the fire out when it burns down', () => {
  const made = (log) => ({
    add(o) {
      const c = { options: { ...o }, matrix: new Float32Array(16) };
      log.push(c);
      return c;
    },
    remove(c) {
      log.splice(log.indexOf(c), 1);
      return true;
    },
  });
  const smoke = [],
    fire = [];
  const c = new BlastCloud({
    sources: [
      { tnt: 1e6, speed: 40 },
      { at: 2, tnt: 1e6, position: [50, 0, 0], speed: 40 },
    ],
    fireDuration: 4,
  });
  c.seek(1);
  c.draw(made(smoke), made(fire), { cap: 20, stem: 16, fire: 8 });
  assert.equal(smoke.length, 2, 'cap and stem');
  assert.equal(smoke[0].options.segments, 20, 'one source so far');
  assert.equal(fire.length, 1);
  c.seek(3);
  c.draw(made(smoke), made(fire), { cap: 20, stem: 16, fire: 8 });
  assert.equal(smoke[0].options.segments, 40, 'both sources in one cap cloud');
  const placed = [];
  for (let i = 0; i < 40; i++) placed.push(smoke[0].options.distribute(i, Math.random).point);
  assert.ok(
    placed.flat().every((v) => v >= -1 - 1e-9 && v <= 1 + 1e-9),
    'puffs lie in the box',
  );
  c.seek(10);
  c.draw(made(smoke), made(fire), { cap: 20, stem: 16, fire: 8 });
  assert.equal(fire.length, 0, 'the fire is out');
  assert.ok(smoke[0].matrix[13] > 0, 'the cap is above the ground');
  c.clear();
});

test('validation', () => {
  assert.throws(() => new BlastCloud({ entrainment: 0.9 }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [] }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [{ tnt: 0 }] }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [{ speed: -1 }] }), RangeError);
  assert.throws(() => new BlastCloud({ color: [2, 0, 0] }), RangeError);
  assert.throws(() => new BlastCloud({ seed: 1.5 }), RangeError);
  assert.doesNotThrow(() => new BlastCloud({ stability: null }));
  const c = new BlastCloud();
  assert.throws(() => c.seek(-1), RangeError);
  assert.throws(() => c.draw({ add() {}, remove() {} }, undefined, { cap: 2 }), RangeError);
});

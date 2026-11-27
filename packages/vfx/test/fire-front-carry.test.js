// KB-VFX-BURNOUTWORK1: a burn-out of timber-valley's fire on the 8 m grid stepped 760.8 million cells over 2.7 days of
// fire time, 99 percent of them cells past their flames that only carry the front on to their neighbours, and each
// step worked out every one's wind, Rothermel behaviour, canopy and crown again from inputs that had not changed. The
// front keeps those cells' rates while the wind, the moistures and the step hold; the burn must come out bit for bit
// the same as when nothing is kept (a wind field, sampled each step).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FireFront } from '../dist/fire-front.js';

const run = (wind, count) => {
  const front = FireFront.create({
    size: [640, 640],
    cell: 8,
    fuel: (x, z) => (Math.hypot(x - 120, z + 80) < 90 ? null : x < -40 ? 'FM10' : z > 100 ? 'FM2' : 'FM8'),
    ground: (x, z) => 0.18 * x + 25 * Math.sin(z / 70),
    canopy: (x) => (x < -40 ? { baseHeight: 2, bulkDensity: 0.2, height: 18 } : null),
    moisture: 0.05,
    ignitions: [
      { at: [-200, -150], radius: 8 },
      { at: [150, 200], radius: 8, time: 600 },
    ],
    spotting: 0.05,
    seed: 7,
    wind,
  });
  // A work count: the step samples the wind once for each cell it works out in full.
  const windAt = Object.getPrototypeOf(front).windAt;
  let calls = 0;
  front.windAt = function (...args) {
    calls++;
    return windAt.apply(this, args);
  };
  return { front, calls: () => calls };
};

test('a cell past its flames carries the front on at kept rates: the same burn, cell for cell, with far less work', async () => {
  const kept = run([6, -3]),
    field = run({ sample: () => [6, 0, -3] });
  const [a, b] = [await kept.front.settle(5 * 86400), await field.front.settle(5 * 86400)];
  assert.equal(kept.front.active, false, 'the fire went out');
  assert.equal(a, b, 'the same fire time');
  const ra = kept.front.read(),
    rb = field.front.read();
  let burnt = 0;
  for (let i = 0; i < ra.length; i++) {
    assert.ok(Object.is(ra[i], rb[i]), `cell value ${i}: ${ra[i]} against ${rb[i]}`);
    if (i % 4 === 3 && ra[i] === 2) burnt++;
  }
  for (let z = -316; z < 320; z += 8)
    for (let x = -316; x < 320; x += 8) assert.equal(kept.front.crownFraction(x, z), field.front.crownFraction(x, z));
  assert.ok(burnt > 2000, `a real burn: ${burnt} cells`);
  assert.ok(kept.front.crowningCells === field.front.crowningCells);
  // The work: one wind sample per cell visit when nothing is kept, about one per flaming cell when the rates are.
  assert.ok(kept.calls() * 5 < field.calls(), `${kept.calls()} wind samples against ${field.calls()}`);
});

test('a change of wind or moisture works the kept rates out again', async () => {
  const same = run([6, -3]);
  await same.front.settle(3600);
  same.front.setWind([-4, 5]);
  same.front.options.moisture = 0.08;
  // A reference that never kept anything: the same history with a field for the wind.
  const reference = run({ sample: () => [6, 0, -3] });
  await reference.front.settle(3600);
  reference.front.setWind({ sample: () => [-4, 0, 5] });
  reference.front.options.moisture = 0.08;
  const t = [await same.front.settle(86400 * 3), await reference.front.settle(86400 * 3)];
  assert.equal(t[0], t[1]);
  const ra = same.front.read(),
    rb = reference.front.read();
  for (let i = 0; i < ra.length; i++) assert.ok(Object.is(ra[i], rb[i]), `cell value ${i}: ${ra[i]} against ${rb[i]}`);
});

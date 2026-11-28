// KB-SCENES-BURNTSLOW1: timber-valley's `fire: 'burnt'` settles its fire until it goes out, days of fire time, and the
// aftermath shot took 193 s to load against the shot tool's 180 s wait. 99 percent of the cells a burn-out stepped were
// cells past their flames carrying the front on to neighbours their slow backing fire takes days to reach, visited
// every 0.5 s step. `settle` now leaves such a cell out of the steps until the one its kept travel, added up in float32
// as the steps add it, reaches a neighbour. The burn must come out bit for bit the burn `advanceTime` steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FireFront } from '../dist/fire-front.js';

const make = (wind = [6, -3]) => {
  const front = FireFront.create({
    size: [640, 640],
    cell: 8,
    fuel: (x, z) =>
      Math.hypot(x - 120, z + 80) < 90 ? null : Math.abs(x - 200) < 20 && Math.abs(z - 220) < 20 ? 'STRUCTURE' : x < -40 ? 'FM10' : z > 100 ? 'FM2' : 'FM8',
    ground: (x, z) => 0.18 * x + 25 * Math.sin(z / 70),
    canopy: (x) => (x < -40 ? { baseHeight: 2, bulkDensity: 0.2, height: 18 } : null),
    structures: [{ at: [200, 220], radius: 12 }],
    moisture: 0.05,
    ignitions: [
      { at: [-200, -150], radius: 8 },
      { at: [150, 200], radius: 8, time: 600 },
      { at: [250, -250], radius: 0, time: 30000 },
    ],
    spotting: 0.05,
    seed: 7,
    wind,
  });
  // The work: a visit to a cell past its flames (carryOn) adds its kept travel for one step.
  const carryOn = Object.getPrototypeOf(front).carryOn;
  let carried = 0;
  front.carryOn = function (...args) {
    carried++;
    return carryOn.apply(this, args);
  };
  return { front, carried: () => carried };
};
// The reference: the same fire stepped one step at a time, every cell in `burning` visited every step.
const stepped = (front, seconds) => {
  const end = front.time + seconds;
  while (front.active && front.time < end) front.advanceTime(front.options.step ?? 0.5);
  return front.time;
};
const same = (a, b, what) => {
  assert.equal(a.time, b.time, `${what}: fire time`);
  assert.equal(a.active, b.active, `${what}: still burning`);
  assert.equal(a.burningCells, b.burningCells, `${what}: burning cells`);
  assert.equal(a.crowningCells, b.crowningCells, `${what}: crowning cells`);
  assert.equal(a.embers, b.embers, `${what}: embers`);
  assert.equal(a.spots, b.spots, `${what}: spot fires`);
  const ra = a.read(),
    rb = b.read();
  for (let i = 0; i < ra.length; i++) assert.ok(Object.is(ra[i], rb[i]), `${what}: cell value ${i}: ${ra[i]} against ${rb[i]}`);
  for (let z = -316; z < 320; z += 8)
    for (let x = -316; x < 320; x += 8) assert.equal(a.crownFraction(x, z), b.crownFraction(x, z), `${what}: crown at ${x}, ${z}`);
};

test('settle burns a fire out cell for cell as the steps do, without stepping the cells past their flames', async () => {
  const lazy = make(),
    ref = make();
  const t = await lazy.front.settle(5 * 86400);
  assert.equal(t, stepped(ref.front, 5 * 86400));
  assert.equal(lazy.front.active, false, 'the fire went out');
  same(lazy.front, ref.front, 'burnt out');
  const burnt = lazy.front.read().filter((v, k) => k % 4 === 3 && v === 2).length;
  assert.ok(burnt > 2000, `a real burn: ${burnt} cells`);
  assert.ok(lazy.front.spots > 0, 'embers started spot fires');
  // Fails without the fix: settle visited each carrying cell every step, as many visits as the stepped reference.
  assert.ok(lazy.carried() * 20 < ref.carried(), `${lazy.carried()} carrying visits against ${ref.carried()}`);
});

test('a settle stopped mid-burn leaves the fire as the steps would, to go on with a new wind and moisture', async () => {
  const lazy = make(),
    ref = make();
  for (const seconds of [1, 777, 3600, 5000.5]) {
    await lazy.front.settle(seconds);
    stepped(ref.front, seconds);
    same(lazy.front, ref.front, `after ${seconds} s more`);
  }
  // Stepping on from a stopped settle, and settling again, with the rates kept before changed under it.
  for (let k = 0; k < 600; k++) {
    lazy.front.advanceTime(0.5);
    ref.front.advanceTime(0.5);
  }
  same(lazy.front, ref.front, 'stepped on');
  lazy.front.setWind([-4, 5]);
  ref.front.setWind([-4, 5]);
  lazy.front.options.moisture = ref.front.options.moisture = 0.08;
  await lazy.front.settle(3 * 86400);
  stepped(ref.front, 3 * 86400);
  same(lazy.front, ref.front, 'after the change');
  assert.equal(lazy.front.active, false);
});

test('an aborted settle leaves every cell in the steps, and a reset fire settles the same again', async () => {
  const lazy = make(),
    ref = make();
  const ac = new AbortController();
  const run = lazy.front.settle(86400, ac.signal);
  await Promise.resolve();
  ac.abort();
  await assert.rejects(run, { name: 'AbortError' });
  // It stopped at a 4,096-step yield: the reference steps to the same time.
  stepped(ref.front, lazy.front.time);
  same(lazy.front, ref.front, 'aborted');
  lazy.front.resetTime();
  ref.front.resetTime();
  await lazy.front.settle(2 * 86400);
  stepped(ref.front, 2 * 86400);
  same(lazy.front, ref.front, 'reset and settled');
});

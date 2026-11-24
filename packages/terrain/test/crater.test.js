// The 'crater' ground event of `@margoengine/terrain/ground-change`: the heave dome's ballistic rise, the crater's
// paraboloid bowl, the McGetchin et al. (1973) ejecta blanket and its volume, and determinism over film time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroundChange, resolveEvent } from '../dist/ground-change.js';

const grid = (size, resolution) => ({ size: [size, size], origin: [-size / 2, -size / 2], resolution });
const crater = { kind: 'crater', center: [0, 0], radius: 30, depth: 10, heave: 8, duration: 6, roughness: 0 };

test('the heave dome rises ballistically to its height at sqrt(2 H / g), then the crater opens', () => {
  const change = new GroundChange({ grid: grid(400, 200), events: [crater] }),
    T = Math.sqrt((2 * 8) / 9.80665);
  assert.equal(resolveEvent(crater, 0, 0).o.heaveTime, T);
  assert.equal(change.sample(0, 0, 0).change, 0, 'nothing before it starts');
  // h = H (1 - (1 - t / T)^2): the surface thrown up at sqrt(2 g H), slowing at g.
  for (const f of [0.25, 0.5, 1])
    assert.ok(Math.abs(change.sample(0, 0, f * T).change - 8 * (1 - (1 - f) ** 2)) < 1e-9, `dome at ${f} T`);
  assert.ok(change.sample(35, 0, T).change > 0, 'the dome is wider than the crater');
  assert.ok(Math.abs(change.sample(0, 0, T + 1e-9).change - 8) < 1e-6, 'the vent starts from the dome, no jump');
  assert.ok(Math.abs(change.sample(0, 0, T + 6).change + 10) < 1e-9, 'the bowl reaches its depth');
  assert.ok(Math.abs(change.sample(0, 0, T + 600).change + 10) < 1e-9, 'and stays');
});

test('the finished crater: a paraboloid bowl, a lip at the rim and an ejecta blanket thinning as (r / R)^-3', () => {
  const change = new GroundChange({ grid: grid(400, 200), events: [crater] }),
    end = 1000,
    rim = resolveEvent(crater, 0, 0).o.rim;
  // Lip height from the blanket's volume: 0.7 of the bowl's pi R^2 D / 2 over the blanket's 2 pi R^2 (0.8 - 0.096) / 0.992.
  assert.ok(Math.abs(rim - (0.7 * 10) / (4 * (0.704 / 0.992))) < 1e-12);
  assert.ok(Math.abs(change.sample(15, 0, end).change - -10 * 0.75) < 1e-9, 'bowl at half the radius');
  const at = (r) => change.sample(r, 0, end).change,
    want = (r) => (rim * ((r / 30) ** -3 - 1 / 125)) / (1 - 1 / 125);
  for (const r of [31, 45, 60, 90]) assert.ok(Math.abs(at(r) - want(r)) < 1e-9, `blanket at ${r} m`);
  assert.ok(at(60) < at(31) / 6, 'thins steeply away from the rim');
  assert.equal(at(151), 0, 'nothing past 5 R');
  assert.ok(change.sample(10, 0, end).soil > 0.9, 'fresh soil in the crater');
});

test('the ejecta blanket holds its share of the bowl volume', () => {
  const change = new GroundChange({ grid: grid(400, 800), events: [crater] });
  change.setTime(1000);
  change.update();
  const d = change.change,
    side = change.side,
    cell = (400 / (side - 1)) ** 2;
  let cut = 0,
    fill = 0;
  for (let k = 0; k < d.length; k++) {
    const i = k % side,
      j = Math.floor(k / side),
      r = Math.hypot(-200 + (i * 400) / (side - 1), -200 + (j * 400) / (side - 1));
    if (r > 30) fill += d[k] * cell;
    else cut += d[k] * cell;
  }
  const bowl = (Math.PI * 30 * 30 * 10) / 2;
  // Inside the rim: the bowl less the lip ramp; outside: 0.7 of the bowl.
  assert.ok(Math.abs(fill / (0.7 * bowl) - 1) < 0.03, `blanket ${fill.toFixed(0)} m^3 of ${(0.7 * bowl).toFixed(0)}`);
  assert.ok(cut < -0.85 * bowl, `bowl ${cut.toFixed(0)} m^3`);
});

test('the crater is a function of film time: any seek order gives the same ground', () => {
  const a = new GroundChange({ grid: grid(200, 100), events: [{ ...crater, roughness: 0.3, seed: 4 }] }),
    b = new GroundChange({ grid: grid(200, 100), events: [{ ...crater, roughness: 0.3, seed: 4 }] });
  for (const t of [0.5, 3, 9]) {
    a.setTime(t);
    a.update();
  }
  b.setTime(9);
  b.update();
  assert.deepEqual(Array.from(a.change), Array.from(b.change));
  assert.throws(() => new GroundChange({ grid: grid(100, 10), events: [{ kind: 'crater' }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(100, 10), events: [{ ...crater, domeSpread: 5 }] }), RangeError);
});

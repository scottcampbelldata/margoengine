// Gunfire, sheet row 26 part two (@margoengine/vfx/gunfire): the shot's flight in the wind (McCoy 1999's lag-time
// rule), burning powder grains (Piobert burn-out at about 1 cm/s, Conkling and Mocella 2019, and their quadratic-drag
// stopping), strikes on ships by Poncelet's law with the oak of the Wood Handbook (ricochet, through, lodged) and the
// holes they leave in a hull mask, the hull's char at the EN 1995-1-2 rate from the fire's spread, and masts that
// topple as falling chimneys (Varieschi and Kamiya 2003). The GPU half is gunfire-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Battery,
  HullFire,
  OAK,
  POWDER_BURN_RATE,
  hullMaskImage,
  hullMaskUVs,
  mastTopple,
  powderGrains,
  shotPath,
  woodExitSpeed,
  woodPenetration,
} from '../dist/gunfire.js';
import {
  GUNFIRE_SETTINGS,
  HULL_FIRE_SETTINGS,
  applyGunfireSettings,
  applyHullFireSettings,
  hullFireSettingValues,
} from '../dist/settings.js';
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
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const gun = { position: [0, 3, 0], direction: [1, 0, 0] };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test('the wind moves the shot: drag on the velocity relative to the air, the lag-time rule (McCoy 1999)', () => {
  const W = 10,
    calm = shotPath([0, 3, 0], [1, 0.03, 0], 490),
    windy = shotPath([0, 3, 0], [1, 0.03, 0], 490, {}, { wind: [0, W] }),
    i = windy.impact,
    lag = W * (i.time - i.position[0] / (490 / Math.hypot(1, 0.03)));
  assert.ok(Math.abs(calm.impact.position[2]) < 1e-9);
  near(i.position[2], lag, 0.03 * lag, 'crosswind deflection W (T - X / u0)');
  // A head wind shortens the range; a wind field is read along the path.
  assert.ok(shotPath([0, 3, 0], [1, 0.03, 0], 490, {}, { wind: [-W, 0] }).impact.position[0] < calm.impact.position[0]);
  near(
    shotPath([0, 3, 0], [1, 0.03, 0], 490, {}, { wind: { sample: () => [0, 0, W] } }).impact.position[2],
    i.position[2],
    1e-9,
    'field',
  );
  // The battery flies its shots in its wind (its own, or the weather's on its flashes).
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, {
    guns: [{ position: [0, 3, 0], direction: [1, 0.03, 0] }],
    shots: [{ gun: 0, time: 0 }],
    wind: [0, W],
  });
  b.advanceTime(1 / 30);
  near(b.impacts()[0].position[2], i.position[2], 1e-9, 'Battery shot in the wind');
  b.dispose();
});

test('burning powder grains: Piobert burn-out and the drag that stops them', () => {
  const g = powderGrains(4.5, 0.003, 490),
    m1 = (Math.PI / 6) * 0.003 ** 3 * 1750;
  near(g.burnTime, 0.003 / (2 * POWDER_BURN_RATE), 1e-12, 'burns out in d / (2 r)');
  near(g.count, (0.02 * 4.5) / m1, 1e-9, 'two percent of the charge');
  near(g.stopping, ((4 / 3) * 0.003 * 1750) / (1.225 * 0.47), 1e-9, 'stopping length');
  // Subsonic the drag is nearly Hoerner's 0.47: the quadratic-drag closed forms hold within 2 percent.
  const slow = powderGrains(4.5, 0.003, 100),
    closed = slow.stopping * Math.log(1 + (100 * slow.burnTime) / slow.stopping);
  near(slow.reach, closed, 0.02 * closed, 'reach lambda ln(1 + v0 T / lambda)');
  near(slow.speeds[31], 1 / (1 + (100 * slow.burnTime) / slow.stopping), 0.02, 'speed v0 / (1 + v0 T / lambda)');
  assert.equal(g.speeds.length, 32);
  assert.ok(g.reach < g.stopping * Math.log(1 + (490 * g.burnTime) / g.stopping), 'supersonic drag stops them sooner');
  assert.ok(g.reach > 5 && g.reach < 40, `sparks reach tens of metres: ${g.reach}`);
  // The battery throws them with the flash.
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, {
    guns: [gun],
    shots: [
      { gun: 0, time: 0 },
      { gun: 0, time: 1 },
    ],
  });
  const bursts = [];
  b.sparks[0].burst = (n) => bursts.push(n);
  b.advanceTime(1 / 30);
  const so = b.sparks[0].options;
  assert.deepEqual(bursts, [Math.round(Math.min(2048, g.count))]);
  assert.deepEqual(so.lifetime, [0.7 * g.burnTime, 1.3 * g.burnTime]);
  assert.deepEqual(so.overLife.speed, g.speeds);
  near(so.velocity[0], 490, 1e-9, 'at the shot speed');
  assert.equal(so.intensity, 30);
  b.options.sparks = 0;
  while (b.time < 1.02) b.advanceTime(1 / 30);
  assert.equal(bursts.length, 1, 'sparks 0 throws none');
  b.dispose();
});

test('Poncelet penetration into oak and the three outcomes of a strike', () => {
  const r = Math.cbrt((3 * 14.5) / (4 * Math.PI * 7200)),
    A = Math.PI * r * r;
  // The closed form against the law's own ODE m v dv/dx = -A (R + rho v^2 / 2), stepped finely.
  let v = 400,
    x = 0;
  const dx = 1e-5;
  while (v > 1) {
    v -= (dx * A * (OAK.strength + 0.5 * OAK.density * v * v)) / (14.5 * v);
    x += dx;
  }
  near(woodPenetration(400, r, 14.5), x, 2e-3 * x, 'stopping depth');
  const q = OAK.strength / (0.5 * OAK.density);
  near(
    woodExitSpeed(400, r, 14.5, 0.3) ** 2,
    (q + 400 ** 2) * Math.exp((-OAK.density * A * 0.3) / 14.5) - q,
    1e-6,
    'exit speed',
  );
  assert.equal(woodExitSpeed(400, r, 14.5, woodPenetration(400, r, 14.5) + 0.01), 0);
  // A ship broadside on at 60 m: holed through both sides, the ball going on to the sea.
  const ship = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 60, 0, 0, 1];
  const through = shotPath([0, 3, 0], [1, 0, 0], 490, {}, { targets: [{ ship }] });
  assert.deepEqual(
    through.hits.map((h) => h.kind),
    ['through', 'exit'],
  );
  const [h0, h1] = through.hits;
  near(h0.position[0], 60 - 6.5, 0.02, 'strikes the near side');
  near(h1.position[0], 60 + 6.5, 0.6, 'leaves the far side');
  const vn = Math.abs(h0.velocity.reduce((s, x, i) => s + x * h0.normal[i], 0));
  near(
    Math.hypot(...h0.after) / Math.hypot(...h0.velocity),
    woodExitSpeed(vn, r, 14.5, 0.5) / vn,
    1e-9,
    'Poncelet exit speed of the part into the side',
  );
  assert.ok(through.impact && through.impact.position[0] > 67, 'and goes on to the water');
  assert.ok(h0.splinters > 50, `splinters ${h0.splinters}`);
  // A side thicker than its reach stops it: lodged, no impact.
  const lodged = shotPath([0, 3, 0], [1, 0, 0], 490, {}, { targets: [{ ship, thickness: 5 }] });
  assert.deepEqual(
    lodged.hits.map((h) => h.kind),
    ['lodged'],
  );
  assert.equal(lodged.impact, undefined);
  // A slow ball meeting the bow at a glance cannot bite a radius in: it glances off and flies on.
  const glance = shotPath([-40, 3, 24.6], [1, 0, 0], 60, {}, { targets: [{ ship: identity() }] });
  assert.equal(glance.hits[0]?.kind, 'ricochet', JSON.stringify(glance.hits));
  assert.ok(glance.hits[0].depth < r);
  assert.ok(Math.hypot(...glance.hits[0].after) < Math.hypot(...glance.hits[0].velocity), 'slower after');
  assert.ok(glance.impact, 'it reaches the water');
});

test('the battery strikes its targets on the clock: splinters and holes in the target mask', () => {
  const { engine } = optionalGPU();
  const image = hullMaskImage(64, 16);
  let updates = 0;
  const mask = { source: image, update: () => updates++ };
  const ship = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 60, 0, 0, 1];
  const b = Battery.attach(engine, { guns: [gun], shots: [{ gun: 0, time: 0 }], targets: [{ ship, mask }] });
  const bursts = [];
  b.splinters.burst = (n) => bursts.push([n, [...b.splinters.options.position]]);
  b.advanceTime(1 / 30);
  assert.equal(b.hits().length, 0, 'not yet: the ball is in the air');
  assert.equal(b.fired[0].hits.length, 2);
  while (b.time < 0.5) b.advanceTime(1 / 30);
  assert.deepEqual(
    b.hits().map((h) => h.kind),
    ['through', 'exit'],
  );
  assert.equal(bursts.length, 2);
  near(bursts[0][1][0], 53.5, 0.05, 'splinters at the strike');
  assert.ok(updates >= 2);
  // The near side is starboard (-X, the left half of the image), the far side port; both at mid-length, 3 m up.
  const col = 16,
    row = Math.floor(((3 + 5) / 11) * 16);
  assert.equal(image.data[(row * 64 + col) * 4 + 2], 255, 'starboard hole');
  assert.equal(image.data[(row * 64 + col + 32) * 4 + 2], 255, 'port hole');
  assert.equal(image.data[col * 4 + 2], 0, 'none at the keel');
  b.dispose();
});

test('the hull chars at the Eurocode rate where the fire has burnt, and the mask shows it', () => {
  const { engine } = optionalGPU();
  const image = hullMaskImage(48, 12);
  let updates = 0;
  const fire = HullFire.attach(engine, {
    ship: identity(),
    spread: 0.5,
    burnTime: 7200,
    ports: [{ position: [6.5, 3, 0] }],
    mask: { source: image, update: () => updates++ },
  });
  while (fire.time < 2160 - 1e-6) fire.advanceTime(1 / 2);
  // 2,160 s after ignition: 360 s of growth (half counts) then full burn: 1,980 s, so 16.5 mm at 0.5 mm/min.
  near(fire.exposure(0), 180 + 1800, 1e-6, 'exposure');
  near(fire.charDepth([6.5, 5.5, 0]), (0.5 * 1980) / 60, 1e-9, 'EN 1995-1-2 beta_0 0.5 mm/min');
  near(fire.charDepth([6.5, 3.5, 0]), (0.5 * 1980) / 60, 1e-9, 'above the port, in its flame');
  assert.equal(fire.charDepth([-6.5, 3.5, 0]), 0, 'not on the other side at port height');
  assert.equal(fire.charDepth([6.5, -3, 0]), 0, 'not below the waterline');
  assert.equal(fire.charDepth([6.5, 5.5, 2000]), 0, 'not where the fire has not reached');
  fire.options.charRate = 0.65;
  near(fire.charDepth([6.5, 5.5, 0]), (0.65 * 1980) / 60, 1e-9, 'softwood');
  fire.options.charRate = 0.5;
  fire.advanceTime(1 / 2);
  const top = 11,
    mid = 24 + 12;
  assert.ok(image.data[(top * 48 + mid) * 4] > 250, 'the deck edge is black');
  assert.ok(image.data[(top * 48 + mid) * 4 + 1] > 0, 'and glows');
  assert.equal(image.data[mid * 4], 0, 'the keel is clean');
  assert.ok(updates > 0);
  fire.dispose();
  // A seek: the same clock in other steps paints the same mask.
  const paint = (dt) => {
    const img = hullMaskImage(48, 12),
      f = HullFire.attach(optionalGPU().engine, {
        ship: identity(),
        spread: 0.5,
        burnTime: 120,
        ports: [{ position: [6.5, 3, 0] }],
        mask: { source: img, update() {} },
      });
    for (let i = 0; i < Math.round(90 / dt); i++) f.advanceTime(dt);
    f.dispose();
    return [...img.data];
  };
  assert.deepEqual(paint(1 / 32), paint(1 / 8));
  // The mesh's UV set: starboard left half, port right half, keel to deck.
  assert.deepEqual(
    [...hullMaskUVs([-6, -5, -25, 6, 6, 0])].map((v) => +v.toFixed(4)),
    [0, 0, +(0.5 + 0.25 * 0.999).toFixed(4), 1],
  );
});

test('a mast topples on its foot as a falling chimney (Varieschi and Kamiya 2003)', () => {
  const L = 40,
    th0 = 0.02;
  for (const t of [1, 3, 4]) {
    const m = mastTopple(L, t, 6);
    if (m.down) continue;
    near(
      m.rate,
      Math.sqrt((3 * 9.81 * (Math.cos(th0) - Math.cos(m.angle))) / L),
      1e-6 * Math.max(1, m.rate),
      `energy at ${t} s`,
    );
  }
  // Time to horizontal: the integral of dtheta / omega from 0.02 to pi/2 (Simpson in u, theta = th0 + u^2).
  const omega = (th) => Math.sqrt((3 * 9.81 * (Math.cos(th0) - Math.cos(th))) / L);
  const f = (u) => (u === 0 ? 2 / Math.sqrt((3 * 9.81 * Math.sin(th0)) / L) : (2 * u) / omega(th0 + u * u));
  let T = 0;
  const n = 20000,
    U = Math.sqrt(Math.PI / 2 - th0);
  for (let i = 0; i < n; i++) {
    const u0 = (i * U) / n,
      u1 = ((i + 1) * U) / n;
    T += ((u1 - u0) / 6) * (f(u0) + 4 * f((u0 + u1) / 2) + f(u1));
  }
  near(mastTopple(L, T, 6).angle, Math.PI / 2, 2e-3, 'horizontal at the quadrature time');
  const down = mastTopple(L, 60, 6);
  assert.ok(down.down);
  near(down.angle, Math.acos(-6 / L), 1e-12, 'lies with its top in the water');
  // On a burning hull: it stands until the fire has reached it and burnt its stays, then falls to port with its yards.
  const { engine } = optionalGPU();
  const pose = identity();
  const fire = HullFire.attach(engine, {
    ship: { matrix: () => pose },
    spread: 0.5,
    mastFall: 5,
    masts: [{ position: [0, 6, 10], height: L, yards: [{ at: 30, length: 20 }] }],
  });
  near(fire.mastFallTime(0), 25, 1e-9, 'reach 20 s plus 5 s');
  while (fire.time < 24.9) fire.advanceTime(1 / 10);
  let [mast, yard] = fire.rigging();
  assert.equal(mast.angle, 0);
  assert.deepEqual([...mast.matrix.slice(4, 7)], [0, 1, 0]);
  near(yard.matrix[13], 36, 1e-6, 'yard 30 m up');
  while (fire.time < 85) fire.advanceTime(1 / 10);
  [mast, yard] = fire.rigging();
  near(mast.angle, Math.acos(-6 / L), 1e-9, 'down');
  assert.ok(mast.matrix[4] > 0.9, 'fallen to port');
  near(yard.matrix[12], 30 * Math.sin(mast.angle), 1e-4, 'the yard rides it');
  pose[14] = 7;
  near(fire.rigging()[0].matrix[14], 17, 1e-6, 'rides the ship');
  fire.dispose();
});

test('the new rows are live and write the battery and the hull', () => {
  const rows = [...GUNFIRE_SETTINGS, ...HULL_FIRE_SETTINGS],
    names = new Set(rows.map((r) => r.name));
  for (const n of ['sparks', 'sparkRadiance', 'grain', 'splinters', 'charRate', 'mastFall'])
    assert.ok(names.has(n) && rows.find((r) => r.name === n).live, n);
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, { guns: [gun] });
  applyGunfireSettings(b, { sparks: 2, grain: 0.005 });
  assert.equal(b.options.sparks, 2);
  assert.equal(b.options.splinters, 1);
  assert.throws(() => applyGunfireSettings(b, { grain: 1 }), RangeError);
  const fire = HullFire.attach(engine, { ship: identity() });
  applyHullFireSettings(fire, { charRate: 0.65 });
  assert.equal(fire.options.charRate, 0.65);
  assert.equal(hullFireSettingValues(fire).mastFall, 600);
  assert.throws(() => HullFire.attach(engine, { ship: identity(), mask: { source: {}, update() {} } }), TypeError);
  b.dispose();
  fire.dispose();
});

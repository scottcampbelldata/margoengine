// @margoengine/sky/tornado on the CPU: the vortex's wind and pressure against their closed forms, the condensation
// funnel against the deficit it is drawn from, rope against wedge, the debris cloud, the path, the spin-up, the
// weather it makes, the damage path and its ground scar, and the settings rows. The GPU draw of the same funnel is
// proved by features-check.mjs tornado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BURGERS_PEAK_RADIUS,
  BURGERS_PEAK_WIND,
  EF0_GUST,
  Tornado,
  TornadoCloud,
  debrisRadius,
  expIntegral,
  funnelBottom,
  funnelProfile,
  funnelRadius,
  resolveTornado,
  tornadoCenter,
  tornadoDeficit,
  tornadoPeakWind,
  tornadoWind,
} from '@margoengine/sky/tornado';
import { SKY_SETTINGS, applySkySettings } from '@margoengine/sky/settings';
import { WeatherRegions } from '@margoengine/weather/regions';

const G = 9.80665;
const close = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} against ${b}`);
const peakOf = (s) => {
  let best = 0,
    at = 0;
  for (let r = 0.5; r < 20 * s.rc; r += s.rc / 2000) {
    const v = tornadoWind(r, s);
    if (v > best) [best, at] = [v, r];
  }
  return { best, at };
};

test('E1 matches its tabulated values (Abramowitz and Stegun table 5.1)', () => {
  close(expIntegral(0.5), 0.5597735947761608, 1e-12, 'E1(0.5)');
  close(expIntegral(1), 0.21938393439552029, 1e-12, 'E1(1)');
  close(expIntegral(2), 0.04890051070806112, 1e-12, 'E1(2)');
  close(expIntegral(10), 4.156968929685324e-6, 1e-10, 'E1(10)');
});

test('the Burgers-Rott wind peaks at the core radius, 1.12091 r0, at 0.638173 G / (2 pi r0)', () => {
  const s = resolveTornado({ coreRadius: 200, pressureDrop: 60 }),
    { best, at } = peakOf(s);
  close(at, 200, 0.002, 'radius of maximum wind');
  close(best, tornadoPeakWind(s), 1e-5, 'peak wind');
  // The peak against the central deficit: dp0 = rho (G / 2 pi r0)^2 ln 2 (the pressure integral's F(0) = 2 ln 2).
  const circulation = best / BURGERS_PEAK_WIND;
  close(tornadoDeficit(0, s), s.rho * circulation ** 2 * Math.LN2, 1e-9, 'central deficit');
  close(tornadoDeficit(0, s), 6000, 1e-9, 'the deficit asked for');
  // 80 hPa in 1.15 kg/m3 air: about 64 m/s, an EF3 (WSEC 2006).
  close(tornadoPeakWind(resolveTornado({})), 63.94, 0.002, 'default peak');
  close(BURGERS_PEAK_RADIUS, 1.12091, 1e-5, 'r0 to the peak');
  close(BURGERS_PEAK_WIND, 0.638173, 1e-6, 'the peak over G / (2 pi r0)');
});

test('the modified Rankine wind falls as r^-decay outside the core, and its deficit is rho Vm^2 (1/2 + 1/(2a))', () => {
  for (const decay of [0.5, 0.6, 1]) {
    const s = resolveTornado({ profile: 'rankine', decay, coreRadius: 100 }),
      vm = tornadoPeakWind(s);
    close(tornadoWind(100, s), vm, 1e-12, 'peak at the core radius');
    close(tornadoWind(50, s), vm / 2, 1e-12, 'solid turning inside');
    close(tornadoWind(400, s) / tornadoWind(200, s), 2 ** -decay, 1e-12, `decay ${decay}`);
    close(tornadoDeficit(0, s), s.rho * vm * vm * (0.5 + 0.5 / decay), 1e-12, 'central deficit');
  }
  close(
    tornadoPeakWind(resolveTornado({ profile: 'rankine', decay: 1 })),
    Math.sqrt(8000 / 1.15),
    1e-12,
    'Rankine 1858',
  );
});

test('the pressure is in cyclostrophic balance with the wind, dp/dr = rho v^2 / r, for both profiles', () => {
  for (const profile of ['burgers-rott', 'rankine']) {
    const s = resolveTornado({ profile, coreRadius: 120 });
    for (const r of [20, 60, 119, 121, 200, 500, 2000]) {
      const h = 1e-3 * r,
        slope = (tornadoDeficit(r - h, s) - tornadoDeficit(r + h, s)) / (2 * h),
        v = tornadoWind(r, s);
      close(slope, (s.rho * v * v) / r, 2e-5, `${profile} at ${r} m`);
    }
  }
});

test('the funnel edge is the surface where the deficit lifts the air to its condensation level', () => {
  const s = resolveTornado({ pressureDrop: 90, coreRadius: 150, cloudBase: 1000, wallCloudDrop: 400 });
  for (const z of [0, 100, 300, 550]) {
    const r = funnelRadius(z, s);
    assert.ok(r > 0, `a funnel at ${z} m`);
    close(tornadoDeficit(r, s), s.rho * G * (s.wallBase - z), 1e-9, `deficit at the edge, ${z} m`);
  }
  // It widens with height toward the wall cloud.
  assert.ok(funnelRadius(500, s) > funnelRadius(300, s) && funnelRadius(300, s) > funnelRadius(0, s));
  // It reaches down to where the core's deficit equals rho g (wallBase - z), and no lower.
  const weak = resolveTornado({ pressureDrop: 40, cloudBase: 1000, wallCloudDrop: 400 }),
    bottom = funnelBottom(weak);
  close(bottom, 600 - 4000 / (weak.rho * G), 1e-12, 'funnel bottom');
  assert.ok(
    funnelRadius(bottom + 5, weak) > 0 && funnelRadius(bottom - 5, weak) === 0,
    'a funnel aloft, not on the ground',
  );
  assert.equal(funnelBottom(s), 0, '90 hPa under a 600 m wall base reaches the ground');
  const table = funnelProfile(s, 1);
  assert.equal(table.length, 32);
  close(table[31], funnelRadius(599.5, s), 1e-5, 'the table top');
});

test('a narrow core with a modest deficit makes a rope, a wide one with a deep deficit a wedge', () => {
  const rope = resolveTornado({ coreRadius: 30, pressureDrop: 75, cloudBase: 900, wallCloudDrop: 300 }),
    wedge = resolveTornado({ coreRadius: 600, pressureDrop: 110, cloudBase: 900, wallCloudDrop: 300 });
  const ratio = (s) => (2 * funnelRadius(0, s)) / s.wallBase;
  assert.ok(ratio(rope) > 0 && ratio(rope) < 0.08, `rope width over height ${ratio(rope)}`);
  assert.ok(ratio(wedge) > 1, `wedge width over height ${ratio(wedge)}`);
});

test('the debris cloud reaches out to where the surface wind lofts debris', () => {
  const s = resolveTornado({ debrisWind: 40 }),
    r = debrisRadius(s);
  close(tornadoWind(r, s), 40, 1e-6, 'wind at the debris edge');
  assert.ok(r > s.rc);
  assert.equal(debrisRadius(resolveTornado({ pressureDrop: 10 })), 0, 'too weak to loft debris');
});

test('the path is followed through its keys, and the tornado stands still outside them', () => {
  const s = resolveTornado({
    path: [
      [0, 0, 0],
      [10, 100, 0],
      [20, 100, 100],
      [30, 0, 100],
    ],
  });
  assert.deepEqual(tornadoCenter(s, 10), [100, 0]);
  assert.deepEqual(tornadoCenter(s, 20), [100, 100]);
  assert.deepEqual(tornadoCenter(s, -5), [0, 0]);
  assert.deepEqual(tornadoCenter(s, 99), [0, 100]);
  const mid = tornadoCenter(s, 15);
  assert.ok(mid[0] > 100 && mid[1] > 0 && mid[1] < 100, `between the keys, bowed out: ${mid}`);
  assert.deepEqual(new Tornado({ center: [5, 6], velocity: [2, -1] }).centerAt(10), [25, -4]);
  assert.throws(() => new Tornado({ path: [[0, 0, 0]] }), TypeError);
  assert.throws(
    () =>
      new Tornado({
        path: [
          [5, 0, 0],
          [5, 1, 1],
        ],
      }),
    TypeError,
  );
});

test('the funnel lowers as the vortex spins up after touchdown, and rises after liftoff', () => {
  const t = new Tornado({ touchdown: 10, spinUp: 60, liftoff: 200, pressureDrop: 90 });
  assert.equal(t.strengthAt(5), 0);
  assert.equal(t.funnelBottomAt(5), t.resolved.wallBase, 'no funnel before touchdown');
  const a = t.funnelBottomAt(30),
    b = t.funnelBottomAt(50);
  assert.ok(a > b, `lowering: ${a} then ${b}`);
  assert.equal(t.funnelBottomAt(100), 0, 'on the ground at full strength');
  assert.ok(t.funnelBottomAt(240) > 0, 'lifting after liftoff');
  assert.equal(t.strengthAt(300), 0);
});

test('the wind turns in near the ground, rises in the core and carries the storm motion', () => {
  const t = new Tornado({ velocity: [10, 0], updraft: 50 }),
    s = t.resolved;
  const [vx, vy, vz] = t.velocityAt(0, 2, s.rc, 0);
  // At (0, rc) the cyclonic turn blows toward +X with an inflow toward -Z.
  assert.ok(vx > 10 && vz < 0, `turned in: ${[vx, vz]}`);
  close(Math.atan2(-vz, vx - 10), s.inflow * Math.exp(-2 / s.rc), 1e-9, 'inflow angle near the ground');
  const aloft = t.velocityAt(0, 2000, s.rc, 0);
  assert.ok(Math.abs(aloft[2]) < 1e-3 * Math.abs(aloft[0]), 'no inflow aloft');
  assert.ok(t.velocityAt(0, 500, 0, 0)[1] > 45, 'the core updraft');
  const wind = t.windAt(0, s.rc, 0);
  close(wind.gust, wind.speed * 1.3, 1e-12, 'gust factor');
  assert.ok(t.pressureAt(0, 0, 0) < 1013.25 - 79.9, 'the central pressure');
  // The anticyclonic tornado turns the other way.
  const anti = new Tornado({ rotation: 'anticyclonic', inflow: 0 }).velocityAt(0, 2, 150, 0);
  assert.ok(anti[0] < 0, 'clockwise');
});

test('the weather follows the vortex in WeatherRegions: wind in the core, rain on the rear flank', () => {
  const t = new Tornado({ velocity: [15, 0] }),
    s = t.resolved,
    map = new WeatherRegions({ base: 'overcast', storms: [t] });
  assert.equal(map.stateAt(0, s.rc).wind, 60, 'the weather caps the core wind at its 60 m/s');
  const rear = map.stateAt(-2 * s.wallRadius, 0),
    front = map.stateAt(2 * s.wallRadius, 0);
  assert.ok(rear.rain > front.rain + 0.1, `rain behind the motion: ${rear.rain} against ${front.rain}`);
  assert.equal(t.weatherAt(1e6, 0).weight, 0, 'outside the storm');
  assert.equal(t.regionAt(0, 0), 'funnel');
  assert.equal(t.regionAt(-2 * s.wallRadius, 0), 'rearFlank');
  assert.equal(t.regionAt(1e6, 0), 'outside');
});

test('the damage path is as wide as the EF0 gust reaches, wider on the right of the motion', () => {
  const t = new Tornado({ velocity: [15, 0] }),
    s = t.resolved,
    [p] = t.damagePath(100, 101, 2);
  // Across the track: the gust (turn plus or minus the motion) times the gust factor reaches 29 m/s at each edge.
  const edge = (sign) => {
    let r = s.rc;
    while ((tornadoWind(r, s) + sign * 15) * s.gust >= EF0_GUST) r += 0.05;
    return r;
  };
  close(p.width, edge(1) + edge(-1), 1e-3, 'path width');
  assert.ok(edge(1) > edge(-1));
  const scar = t.groundScar(0, 120);
  assert.equal(scar.kind, 'gully');
  assert.ok(scar.path.length > 2 && scar.width > 0 && scar.duration > 0);
  assert.equal(new Tornado({ pressureDrop: 2 }).groundScar(0, 60), null, 'no damage, no scar');
});

test('options are checked', () => {
  assert.throws(() => new Tornado({ pressureDrop: 200 }), RangeError);
  assert.throws(() => new Tornado({ cloudBase: 500, wallCloudDrop: 600 }), RangeError);
  assert.throws(() => new Tornado({ profile: 'vortex' }), RangeError);
  assert.throws(() => new Tornado({ debrisColor: [2, 0, 0] }), TypeError);
  assert.throws(() => new Tornado({ touchdown: 10, liftoff: 5 }), RangeError);
  assert.throws(() => new TornadoCloud({}), TypeError);
  assert.throws(() => new TornadoCloud({ tornado: {}, steps: 4 }), RangeError);
  assert.ok(new TornadoCloud({ tornado: { coreRadius: 300 } }).tornado instanceof Tornado);
});

test('the tornado rows write the options, a default or null leaving the key unset', () => {
  const rows = SKY_SETTINGS.filter((s) => s.group === 'tornado');
  assert.equal(rows.length, 32);
  for (const r of rows) assert.equal(r.live, true, r.name);
  const sky = { options: {} },
    t = new Tornado();
  applySkySettings(
    { sky, tornado: t },
    {
      'tornado.speed': 10,
      'tornado.heading': 90,
      'tornado.coreRadius': 400,
      'tornado.profile': 'rankine',
      'tornado.tiltX': 200,
    },
  );
  close(t.options.velocity[0], 10, 1e-12, 'heading 90 is +X');
  assert.equal(t.options.coreRadius, 400);
  assert.equal(t.options.profile, 'rankine');
  assert.deepEqual(t.options.tilt, [200, 0]);
  applySkySettings({ sky, tornado: new TornadoCloud({ tornado: t }) }, { 'tornado.updraft': null });
  assert.deepEqual(Object.keys(t.options), [], 'defaults leave nothing set');
});

test('GAP-FILM-TIME: a TornadoCloud seeked by @margoengine/cutscene/seek is where a continuous run has it, bit for bit', async () => {
  const { seekSync } = await import('../../cutscene/dist/seek.js'),
    options = () => ({
      tornado: {
        path: [
          [0, -400, 0],
          [120, 300, 200],
        ],
        touchdown: 5,
        liftoff: 100,
      },
    }),
    live = new TornadoCloud(options()),
    cut = new TornadoCloud(options()),
    fps = 24,
    n = 2400;
  for (let step = 0; step <= n; step++) live.advanceTime(1 / fps);
  seekSync({ scene: { plugins: new Map([[cut.name, cut]]) } }, n / fps, { fps });
  cut.advanceTime(1 / fps);
  assert.ok(Object.is(cut.time, live.time));
  for (const read of ['strengthAt', 'centerAt', 'motionAt', 'funnelBottomAt'])
    assert.deepEqual(cut.tornado[read](cut.time), live.tornado[read](live.time), read);
});

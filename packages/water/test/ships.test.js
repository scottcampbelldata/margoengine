// Ships riding the sea, on the CPU: the wake's measured bounds (Kelvin's 19.47 degrees, Rabaud and Moisy's narrowing above
// Fr 0.49), the bow wave of Noblesse et al., the Floater's least-squares ride and its damped response, the flood surface
// and Ochi's slam threshold. The GPU check (ships.browser.mjs) holds the drawn surface to these same numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KELVIN_ANGLE,
  KELVIN_MACH_FROUDE,
  ShipWakes,
  Floater,
  ShipSplash,
  bowWave,
  floodSurface,
  hullFroude,
  rollPeriod,
  wakeAngle,
} from '../dist/ships.js';
import { SHIP_SETTINGS, SHIP_LOOKS, applyShipSettings, shipSettingDefaults } from '../dist/settings.js';

const deg = (r) => (r * 180) / Math.PI;
const fakeWater = () => ({ onDispose: () => () => {} });

test('the wake angle is Kelvin 19.47 degrees up to Fr 0.49, then Rabaud and Moisy eq. 3, 1 / (2 sqrt(2 pi) Fr) at high Fr', () => {
  assert.ok(Math.abs(deg(KELVIN_ANGLE) - 19.4712) < 1e-3);
  assert.ok(Math.abs(KELVIN_MACH_FROUDE - 0.4886) < 1e-4);
  assert.equal(wakeAngle(0.2), KELVIN_ANGLE);
  assert.ok(Math.abs(deg(wakeAngle(1)) - 11.243) < 0.01, `Fr 1: ${deg(wakeAngle(1))}`);
  // Continuous at the transition.
  assert.ok(Math.abs(wakeAngle(KELVIN_MACH_FROUDE + 1e-9) - KELVIN_ANGLE) < 1e-6);
  const asymptote = 1 / (2 * Math.sqrt(2 * Math.PI));
  assert.ok(Math.abs(wakeAngle(5) * 5 - asymptote) / asymptote < 0.01);
  assert.ok(Math.abs(hullFroude(9.81, 9.81) - 1) < 1e-12);
});

// The angle of the brightest ray of the drawn wake: the RMS height over a band of radii around r, per angle.
function brightestAngle(froude, length = 20) {
  const g = 9.81,
    speed = froude * Math.sqrt(g * length);
  const wakes = new ShipWakes({
    surface: fakeWater(),
    trail: 200,
    look: { sternWaves: 0, bowWave: 0, wakeLife: 3600, turbulentWake: 0, waterlineFoam: 0 },
    ships: [{ hull: { length, beam: 4, draft: 1 }, path: (t) => [0, speed * t] }],
  });
  wakes.setTime(400);
  const bowZ = speed * 400 + length / 2,
    r = 60 * length,
    lambda = (2 * Math.PI) / Math.max(g / (speed * speed), (2 * Math.PI) / length);
  let best = 0,
    at = 0;
  const energy = [];
  for (let a = 0.5; a <= 30; a += 0.1) {
    const rad = (a * Math.PI) / 180;
    let sum = 0,
      n = 0;
    for (let k = -40; k <= 40; k++) {
      const rr = r + (k / 40) * 2 * lambda;
      const h = wakes.sample(rr * Math.sin(rad), bowZ - rr * Math.cos(rad)).height;
      sum += h * h;
      n++;
    }
    const rms = Math.sqrt(sum / n);
    energy.push([a, rms]);
    if (rms > best) (best = rms), (at = a);
  }
  return { at, best, energy };
}

test('the drawn wake is brightest on the Kelvin ray at low Froude numbers and quiet outside it', () => {
  for (const fr of [0.2, 0.35]) {
    const { at, best, energy } = brightestAngle(fr);
    assert.ok(Math.abs(at - 19.47) < 0.6, `Fr ${fr}: brightest at ${at} degrees`);
    const outside = Math.max(...energy.filter(([a]) => a > 23).map(([, e]) => e));
    assert.ok(outside < best * 0.05, `Fr ${fr}: ${outside} outside the cusp against ${best}`);
  }
});

test('the Kelvin cusp uses the coalesced stationary phase on both sides of a long hull', () => {
  const speed = 4.5;
  const hull = { length: 128, beam: 15.85, draft: 5.42 };
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { sternWaves: 0, bowWave: 0, waterlineFoam: 0, turbulentWake: 0 },
    ships: [{ hull, pose: { position: [0, 0, 0], heading: 0, speed } }],
  });
  // At the cusp the two wavenumbers coincide at 3 kg / 2. The phase
  // k · r gives kg * x * sqrt(3/2) * (1 - 1/4), with x measured aft.
  const kg = 9.81 / speed ** 2;
  const aft = (20 * Math.PI) / (kg * Math.sqrt(1.5) * 0.75);
  const side = aft * Math.tan(KELVIN_ANGLE);
  const radius = Math.hypot(aft, side);
  const amplitude =
    0.5 *
    bowWave(speed, hull).height *
    Math.sqrt(hull.length / Math.max(radius, hull.length)) *
    (kg * radius) ** (1 / 6) *
    Math.exp((-kg * hull.draft) / 4);
  for (const x of [-side, side]) {
    const observed = wakes.sample(x, hull.length / 2 - aft).height;
    assert.ok(Math.abs(observed - amplitude) < 1e-7, `cusp height ${observed}, expected ${amplitude}`);
  }
});

test('the drawn wake narrows as Rabaud and Moisy measured above Fr 0.49 (the hull excites no k below 2 pi / L)', () => {
  for (const fr of [0.8, 1, 1.5, 2]) {
    const { at } = brightestAngle(fr);
    const expected = deg(wakeAngle(fr));
    assert.ok(
      Math.abs(at - expected) < Math.max(0.8, expected * 0.08),
      `Fr ${fr}: brightest at ${at}, eq. 3 gives ${expected}`,
    );
  }
  // Mach-like: doubling the speed halves the angle (within 15%).
  const one = brightestAngle(1).at,
    two = brightestAngle(2).at;
  assert.ok(Math.abs(one / two - 2) < 0.3, `Fr 1 ${one} / Fr 2 ${two}`);
});

test('the bow wave is Noblesse et al. (2008), never above the stagnation head U^2 / 2g, and the drawn crest stands there', () => {
  const hull = { length: 60, beam: 10, draft: 3, entrance: 20 };
  for (const u of [2, 5, 8, 15]) {
    const { height, crest } = bowWave(u, hull);
    const e = (20 * Math.PI) / 180,
      fd = u / Math.sqrt(9.81 * 3);
    const z = Math.min(0.5, (2.2 * Math.tan(e)) / Math.cos(e) / (1 + fd));
    assert.ok(Math.abs(height - (z * u * u) / 9.81) < 1e-9);
    assert.ok(height <= (u * u) / (2 * 9.81) + 1e-12);
    // The parabola tau (1 - tau / 2) reaches the crest height at the crest.
    const tau = (crest * 9.81) / (u * u);
    assert.ok(Math.abs(tau * (1 - tau / 2) - z) < 1e-9);
  }
  // A blunt bow at speed meets the cap.
  assert.ok(Math.abs(bowWave(10, { length: 20, beam: 8, draft: 3, entrance: 55 }).height - 100 / 19.62) < 1e-9);
  assert.deepEqual(bowWave(0, hull), { height: 0, crest: 0 });
  const speed = 6,
    { height, crest } = bowWave(speed, hull);
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { wakeHeight: 0 },
    ships: [{ hull, pose: { position: [0, 0, 0], heading: 0, speed } }],
  });
  // Beside the hull side at the crest: the bow is at z = 30 heading +Z, the side at x = half beam * reach.
  const reach = Math.min(1, (crest * Math.tan((20 * Math.PI) / 180)) / 10);
  const side = 5 * reach * (2 - reach);
  const drawn = wakes.sample(side, 30 - crest).height;
  assert.ok(Math.abs(drawn - height) < 1e-3, `drawn ${drawn}, Noblesse ${height}`);
});

test('the bow crest sweeps aft off the hull and its foam ends before it becomes a crosswise stripe', () => {
  const hull = { length: 68, beam: 15.5, draft: 7, entrance: 28 };
  const speed = 3;
  const { height, crest } = bowWave(speed, hull);
  const reach = (crest * Math.tan((hull.entrance * Math.PI) / 180)) / hull.beam;
  const atHull = hull.beam * 0.5 * reach * (2 - reach);
  const overhang = atHull + 0.11 * hull.beam;
  const outer = atHull + 0.27 * hull.beam;
  const stem = hull.length * 0.5;
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { wakeHeight: 0, waterlineFoam: 0, turbulentWake: 0 },
    ships: [{ hull, pose: { position: [0, 0, 0], heading: 0, speed } }],
  });
  const at = (x, aft) => wakes.sample(x, stem - aft);
  assert.ok(Math.abs(at(atHull, crest).height - height) < 0.001);
  let peak = { aft: crest, height: at(overhang, crest).height };
  for (let aft = crest; aft < crest + 4; aft += 0.025) {
    const next = at(overhang, aft);
    if (next.height > peak.height) peak = { aft, height: next.height };
  }
  assert.ok(peak.aft > crest + 0.45, 'the outboard crest stays on the transverse ridge');
  assert.ok(peak.height > 0.4 * height, 'the swept crest is missing');
  assert.ok(at(overhang, crest).height < 0.65 * peak.height, 'the original crosswise line is still too strong');
  assert.equal(at(outer, crest).foam, 0);
  assert.ok(Math.abs(at(-overhang, peak.aft).height - peak.height) < 1e-7);
});

test('a moving hull lifts water at its shoulders on both sides, with drawdown just outboard', () => {
  const hull = { length: 68, beam: 15.5, draft: 7, entrance: 28 };
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { wakeHeight: 0, waterlineFoam: 0, turbulentWake: 0 },
    ships: [{ hull, pose: { position: [0, 0, 0], heading: 0, speed: 3 } }],
  });
  const at = (aft, off, side = 1) => {
    const reach = Math.min(1, (aft * Math.tan((hull.entrance * Math.PI) / 180)) / hull.beam);
    const x = (hull.beam * 0.5 * reach * (2 - reach) + off) * side;
    return wakes.sample(x, hull.length * 0.5 - aft).height;
  };
  const shoulder = at(18, 0.25);
  assert.ok(shoulder > 0.07, 'the bow wave leaves no lift beside the hull');
  assert.ok(Math.abs(shoulder - at(18, 0.25, -1)) < 1e-7);
  assert.ok(at(18, 1.3) < -0.03, 'the surface has no drawdown outside the shoulder');
  assert.ok(at(34, 0.25) > 0.03 && at(34, 0.25) < shoulder);
  assert.equal(at(18, 4), 0);
  assert.equal(at(69, 0.25), 0);

  wakes.ships[0].setPose({ position: [0, 0, 0], heading: 0, speed: 1.5 });
  wakes.setTime(1);
  assert.ok(at(18, 0.25) > 0 && at(18, 0.25) < 0.35 * shoulder);
  wakes.ships[0].setPose({ position: [0, 0, 0], heading: 0, speed: 0 });
  wakes.setTime(2);
  assert.equal(at(18, 0.25), 0);
});

test('a slow vessel retains a resolvable bow and positive side wash', () => {
  const hull = { length: 68, beam: 15.5, draft: 7, entrance: 28 };
  const speed = 1.5;
  const { height } = bowWave(speed, hull);
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { wakeHeight: 0, waterlineFoam: 0, turbulentWake: 0 },
    ships: [{ hull, pose: { position: [0, 0, -34], heading: 0, speed } }],
  });
  const stem = wakes.sample(0.125, 0).height;
  assert.ok(stem > 0.065 && stem <= height, `unresolved stem rise ${stem}`);
  assert.ok(wakes.sample(0, 0.25).height > 0.018, 'the leading face needs support ahead of the stem');
  assert.ok(wakes.sample(7.375, -18).height > 0.008, 'the side rise is too narrow beside a slow vessel');
  assert.ok(wakes.sample(-7.375, -18).height > 0.008, 'the opposite side lost its rise');
  assert.equal(wakes.sample(11.5, -18).height, 0);
  wakes.ships[0].setPose({ position: [0, 0, -34], heading: 0, speed: 0 });
  wakes.setTime(1);
  assert.equal(wakes.sample(0.125, 0).height, 0);
  assert.equal(wakes.sample(7.375, -18).height, 0);
});

test('stern foam remains visible at harbor speed and decays on the existing clock', () => {
  const speed = 1.5;
  const wakes = new ShipWakes({
    surface: fakeWater(),
    look: { wakeHeight: 0, bowWave: 0, waterlineFoam: 0, foamLife: 9.5 },
    ships: [{ hull: { length: 68, beam: 15.5, draft: 7 }, path: (time) => [0, speed * time] }],
  });
  wakes.setTime(60);
  const stern = 60 * speed - 34;
  const fresh = wakes.sample(0, stern - 0.25).foam;
  const aged = wakes.sample(0, stern - 12).foam;
  assert.ok(fresh > 0.56 && aged > 0.23, `foam disappeared at harbor speed ${fresh}/${aged}`);
  assert.ok(Math.abs(aged / fresh - Math.exp(-(12 - 0.25) / speed / 9.5)) < 1e-5);
  assert.equal(wakes.sample(0, stern + 1).foam, 0);
  assert.equal(wakes.sample(20, stern - 12).foam, 0);
});

test('the wake fades with age, follows a turning ship, and draws foam on the waterline and in the turbulent wake', () => {
  const hull = { length: 30, beam: 6, draft: 2 };
  const turn = (t) => [100 * Math.sin(t / 20), 100 * (1 - Math.cos(t / 20))];
  const wakes = new ShipWakes({ surface: fakeWater(), trail: 20, ships: [{ hull, path: turn }] });
  wakes.setTime(40);
  // Behind the stern along the curved track the turbulent wake is white; well off it, none.
  const back = turn(40 - 50 / 5);
  assert.ok(wakes.sample(back[0], back[1]).foam > 0.3, 'no turbulent wake on the curved track');
  assert.equal(wakes.sample(back[0] + 300, back[1] + 300).foam, 0);
  // The heading follows the path: at t = 40 it is tangent to the circle.
  const pose = wakes.ships[0].pose;
  assert.ok(Math.abs(pose.heading - deg(Math.atan2(Math.cos(2), Math.sin(2)))) < 0.5);
  assert.ok(Math.abs(pose.speed - 5) < 0.01);
  // A seek draws the same wake as playing there.
  const seek = wakes.sample(back[0] + 8, back[1]).height;
  wakes.setTime(10);
  wakes.sample(0, 0);
  for (let i = 0; i < 30; i++) wakes.onPreUpdate(1);
  assert.equal(wakes.sample(back[0] + 8, back[1]).height, seek);
  // Recorded trail (no path): a ship moved frame by frame leaves a wake behind it.
  const free = new ShipWakes({ surface: fakeWater(), ships: [{ hull }] });
  const ship = free.ships[0];
  for (let t = 0; t <= 60; t++) {
    ship.setPose({ position: [0, 0, t * 5], heading: 0, speed: 5 });
    free.setTime(t);
    free.build();
  }
  assert.ok(free.sample(0, 300 - 15 - 60).foam > 0.3, 'recorded trail has no turbulent wake');
  assert.ok(Math.abs(free.sample(12, 300 - 15 - 100).height) > 1e-4, 'recorded trail has no Kelvin waves');
  // Waterline band.
  assert.ok(free.sample(3.2, 300).foam > 0.3);
  // Older waves are lower.
  const young = new ShipWakes({
    surface: fakeWater(),
    look: { wakeLife: 1e3 },
    ships: [{ hull, path: (t) => [0, 5 * t] }],
  });
  const old = new ShipWakes({
    surface: fakeWater(),
    look: { wakeLife: 10 },
    ships: [{ hull, path: (t) => [0, 5 * t] }],
  });
  young.setTime(100);
  old.setTime(100);
  let y = 0,
    o = 0;
  for (let k = 0; k < 200; k++) {
    y += young.sample(20, 500 - 150 - k * 0.5).height ** 2;
    o += old.sample(20, 500 - 150 - k * 0.5).height ** 2;
  }
  assert.ok(o < y * 0.2, `old ${o} young ${y}`);
});

test('stern foam has age zero where it is created and fades at the same rate for long and short hulls', () => {
  const wakeAt = (length) => {
    const wakes = new ShipWakes({
      surface: fakeWater(),
      look: { waterlineFoam: 0, bowWave: 0, turbulentWake: 0.8, foamLife: 4 },
      ships: [{ hull: { length, beam: 8, draft: 4 }, path: (t) => [0, Math.max(0, t) * 3] }],
    });
    wakes.setTime(12);
    const stern = 36 - length / 2;
    assert.equal(wakes.sample(0, stern + 0.2).foam, 0);
    assert.equal(wakes.sample(0, stern - 37).foam, 0, 'no foam behind the start of the journey');
    return [wakes.sample(0, stern - 0.3).foam, wakes.sample(0, stern - 12).foam];
  };
  const expected = [0.8 * Math.exp(-0.1 / 4), 0.8 * Math.exp(-1)];
  for (const length of [18, 72]) {
    for (const [i, foam] of wakeAt(length).entries()) assert.ok(Math.abs(foam - expected[i]) < 1e-6);
  }
});

test('stationary path history cannot rotate the stern away from the starting berth', () => {
  const wakes = new ShipWakes({
    surface: fakeWater(),
    trail: 2,
    ships: [{ hull: { length: 72, beam: 8, draft: 4 }, path: (t) => [Math.max(0, t) * 3, 0] }],
  });
  const last = wakes.ships[0].trail(12, 144).at(-1);
  assert.equal(last.sternX, -36);
  assert.ok(Math.abs(last.sternZ) < 1e-10);
  wakes.setTime(12);
  assert.equal(wakes.sample(-18, -18).foam, 0);
});

test('lamps ride the ship: rolled and pitched with it', () => {
  const wakes = new ShipWakes({
    surface: fakeWater(),
    lamps: [{ position: [5, 10, 5] }],
    ships: [
      {
        hull: { length: 30, beam: 6, draft: 2 },
        lamps: [{ position: [0, 10, 0] }, { position: [0, 0, 10] }],
        pose: { position: [1, 0, 2], heading: 90, speed: 0, roll: Math.PI / 2 },
      },
    ],
  });
  const [mast, bow, fixed] = wakes.lampPositions();
  // Rolled 90 degrees starboard down, the masthead lies over to starboard; heading 90 (+X) puts starboard at +Z.
  assert.ok(Math.abs(mast[1]) < 1e-6 && Math.abs(mast[2] - (2 + 10)) < 1e-6, String(mast));
  assert.ok(Math.abs(bow[0] - 11) < 1e-6, String(bow));
  assert.deepEqual(fixed, [5, 10, 5]);
});

// A sinusoidal sea along +Z: height A sin(k z), with its vertical surface velocity.
const sea = (amplitude, wavelength) => ({
  sample: (x, z) => ({ height: amplitude * Math.sin(((2 * Math.PI) / wavelength) * z), velocity: [0, 0, 0] }),
});

test('the Floater fits the water plane by least squares: a long wave pitches it by its slope, a short one averages out', () => {
  const hull = { length: 40, beam: 8, draft: 2 };
  const instant = { period: 0 };
  const long = new Floater({ hull, points: [32, 1], heave: instant, pitch: instant, roll: instant });
  long.update(sea(1, 4000), 0);
  // At z = 0 the long wave's slope is A k.
  assert.ok(Math.abs(long.pitch - Math.atan((2 * Math.PI) / 4000)) < 1e-3 * Math.atan((2 * Math.PI) / 4000) + 1e-9);
  // A wave of one hull length: the least-squares slope of the 32 points over 90% of the length, sum x h / sum x^2,
  // which tends to 3 A (sin ka - ka cos ka) / (k^2 a^3) (a = 0.45 L) as the points get dense.
  const k = (2 * Math.PI) / 40;
  let sxh = 0,
    sxx = 0;
  for (let i = 0; i < 32; i++) {
    const x = (i / 31 - 0.5) * 36;
    sxh += x * Math.sin(k * x);
    sxx += x * x;
  }
  const expected = sxh / sxx;
  const short = new Floater({ hull, points: [32, 1], heave: instant, pitch: instant, roll: instant });
  short.update(sea(1, 40), 0);
  assert.ok(Math.abs(Math.tan(short.pitch) - expected) < 1e-9, `${Math.tan(short.pitch)} against ${expected}`);
  assert.ok(
    Math.abs(Math.tan(short.pitch)) < 0.45 * k,
    'a one-length wave should pitch the hull less than half its slope',
  );
  // Across: a beam sea rolls it starboard-down when port (+X at heading 0) is higher.
  const beam = new Floater({ hull, heave: instant, pitch: instant, roll: instant });
  beam.update({ sample: (x) => ({ height: 0.1 * x }) }, 0);
  assert.ok(Math.abs(beam.roll - Math.atan(0.1)) < 1e-9 && Math.abs(beam.pitch) < 1e-9);
  // Flat water: level at the water line.
  const flat = new Floater({ hull });
  for (let i = 0; i < 100; i++) flat.update({ sample: () => ({ height: 2.5 }) }, 0.05);
  assert.equal(flat.position[1], 2.5);
  assert.equal(flat.pitch, 0);
  // The matrix is a rotation whose forward axis is the heading, pitched.
  const m = Array.from(new Floater({ hull, heading: 90 }).update(sea(0, 1), 0).matrix());
  assert.ok(Math.abs(m[8] - 1) < 1e-9 && Math.abs(m[10]) < 1e-9);
  // The quaternion turns +Z (forward) onto the matrix's forward column, pitched and rolled.
  const tilted = new Floater({ hull, heading: 30, heave: instant, pitch: instant, roll: instant }).update(
    { sample: (x, z) => ({ height: 0.1 * x + 0.05 * z }) },
    0,
  );
  const [qx, qy, qz, qw] = tilted.quaternion(),
    mm = tilted.matrix(new Array(16));
  assert.ok(Math.abs(Math.hypot(qx, qy, qz, qw) - 1) < 1e-12);
  // Rotating (0, 0, 1) by q: 2 (q.x q.z + q.w q.y), 2 (q.y q.z - q.w q.x), 1 - 2 (q.x^2 + q.y^2).
  const fwd = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(fwd[i] - mm[8 + i]) < 1e-9);
});

test('the Floater response is a damped oscillator: overshoot exp(-zeta pi / sqrt(1 - zeta^2)), period T / sqrt(1 - zeta^2)', () => {
  const zeta = 0.3,
    period = 6;
  const f = new Floater({ hull: { length: 40, beam: 8, draft: 2 }, heave: { period, damping: zeta } });
  f.update({ sample: () => ({ height: 0 }) }, 0);
  let peak = 0,
    peakAt = 0;
  const dt = 0.001;
  for (let t = dt; t < 12; t += dt) {
    f.update({ sample: () => ({ height: 1 }) }, dt);
    if (f.position[1] > peak) (peak = f.position[1]), (peakAt = t);
  }
  const overshoot = Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
  assert.ok(Math.abs(peak - 1 - overshoot) < 0.01, `overshoot ${peak - 1}, theory ${overshoot}`);
  assert.ok(Math.abs(peakAt - period / Math.sqrt(1 - zeta * zeta) / 2) < 0.02, `first peak ${peakAt}`);
  // IMO roll period: 2 C B / sqrt(GM).
  const c = 0.373 + (0.023 * 8) / 2 - (0.043 * 40) / 100;
  assert.ok(Math.abs(rollPeriod({ length: 40, beam: 8, draft: 2 }, 0.4) - (2 * c * 8) / Math.sqrt(0.4)) < 1e-12);
});

test('film time: a seek replays advanceTime on the wake clock and the Floater, landing where playing frames does (KB-SHIPS-FILMTIME1)', () => {
  // The wakes: frames through onPreUpdate and a seek's advanceTime calls reach the same clock and the same wake.
  const hull = { length: 30, beam: 6, draft: 2 };
  const path = (t) => [5 * t, 0];
  const played = new ShipWakes({ surface: fakeWater(), ships: [{ hull, path }] }),
    sought = new ShipWakes({ surface: fakeWater(), ships: [{ hull, path }] });
  for (let i = 0; i < 90; i++) played.onPreUpdate(1 / 30);
  for (let i = 0; i < 90; i++) sought.advanceTime(1 / 30);
  assert.ok(Math.abs(sought.time - 3) < 1e-9 && sought.time === played.time);
  assert.equal(sought.sample(-10, 4).height, played.sample(-10, 4).height);
  sought.advanceTime(-1);
  sought.advanceTime(NaN);
  assert.equal(sought.time, played.time, 'a negative or NaN delta leaves the clock');
  // The Floater drifts on a current: advanceTime rides on the water last given to update, as stepping update does.
  const current = { sample: (x, z) => ({ height: 0.5 * Math.sin(0.1 * x + 0.05 * z), velocity: [1.5, 0, -0.5] }) };
  const options = { hull: { length: 20, beam: 5, draft: 1 }, drift: 1 };
  const stepped = new Floater(options),
    replayed = new Floater(options),
    idle = new Floater(options);
  stepped.update(current, 0);
  replayed.update(current, 0);
  idle.advanceTime(1);
  assert.deepEqual(idle.position, [0, 0, 0], 'no water given yet: advanceTime does nothing');
  for (let i = 0; i < 60; i++) stepped.update(current, 1 / 30);
  for (let i = 0; i < 60; i++) replayed.advanceTime(1 / 30);
  assert.ok(
    Math.abs(replayed.position[0] - 3) < 1e-9 && Math.abs(replayed.position[2] + 1) < 1e-9,
    `${replayed.position}`,
  );
  assert.deepEqual(replayed.position, stepped.position);
  assert.equal(replayed.pitch, stepped.pitch);
  assert.equal(replayed.roll, stepped.roll);
});

test('floodSurface: bed plus depth between cell centres, dry and off-map undefined, and a Floater rides it', () => {
  const width = 8,
    height = 4,
    n = width * height;
  const depth = new Float32Array(n).fill(1),
    bed = new Float32Array(n),
    velocity = new Float32Array(n * 2);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      bed[j * width + i] = 0.5 * i;
      velocity[(j * width + i) * 2] = 2;
    }
  depth[0] = 0;
  depth[1] = 0;
  depth[width] = 0;
  depth[width + 1] = 0;
  const source = floodSurface({ width, height, depth, bed, velocity }, { origin: [0, 0], size: [80, 40] });
  // Cell centres at 5, 15, ...: x = 50 is halfway between cells 4 and 5, beds 2 and 2.5, each 1 m deep.
  assert.ok(Math.abs(source.sample(50, 25).height - 3.25) < 1e-6);
  assert.deepEqual(source.sample(50, 25).velocity, [2, 0, 0]);
  assert.equal(source.sample(5, 5), undefined);
  assert.equal(source.sample(-10, 5), undefined);
  // Riding the sloped surface: pitch atan(0.05) heading +X, drifting with the flow.
  const f = new Floater({
    hull: { length: 20, beam: 4, draft: 1 },
    heading: 90,
    position: [50, 0, 25],
    drift: 1,
    heave: { period: 0 },
    pitch: { period: 0 },
    roll: { period: 0 },
  });
  f.update(source, 0.5);
  assert.ok(Math.abs(f.pitch - Math.atan(0.05)) < 1e-6, String(f.pitch));
  assert.equal(f.position[0], 51);
  assert.equal(f.aground, false);
  // Driven onto the dry corner it is aground and holds its last pose.
  const before = f.position[1];
  f.update(source, 0.1, { position: [6, 0, 6] });
  assert.equal(f.aground, true);
  assert.equal(f.position[1], before);
});

test("ShipSplash: a slam bursts when the bow re-enters faster than Ochi's 0.093 sqrt(g L), not slower; spray where the bow wave breaks", () => {
  const hull = { length: 40, beam: 8, draft: 2, entrance: 30 };
  const threshold = 0.093 * Math.sqrt(9.81 * 40);
  const run = (rise) => {
    const slow = { period: 120, damping: 4 };
    const f = new Floater({ hull, heave: slow, pitch: slow, roll: slow });
    const particles = {
      options: {},
      bursts: [],
      burst(n) {
        this.bursts.push(n);
      },
    };
    const splash = new ShipSplash({ floater: f, particles });
    let water = { height: 0, velocity: [0, 0, 0] };
    const source = { sample: () => water };
    f.update(source, 0);
    water = { height: -2, velocity: [0, 0, 0] };
    for (let i = 0; i < 5; i++) f.update(source, 0.02), splash.update(0);
    water = { height: 0.5, velocity: [0, rise, 0] };
    f.update(source, 0.02);
    const state = splash.update(0);
    return { state, bursts: particles.bursts };
  };
  const above = run(threshold * 1.2),
    below = run(threshold * 0.8);
  assert.equal(above.state.slam, true);
  assert.ok(Math.abs(above.bursts[0] - Math.round(400 * (above.state.relativeVelocity / threshold) ** 2)) <= 1);
  assert.equal(below.state.slam, false);
  assert.deepEqual(below.bursts, []);
  // Spray: full rate once g Zb / U^2 reaches 0.48 (a blunt bow at speed), none at a crawl (no sheet to break up).
  const f = new Floater({ hull: { length: 20, beam: 8, draft: 3, entrance: 55 } });
  const particles = { options: {}, burst() {} };
  const splash = new ShipSplash({ floater: f, particles });
  f.update({ sample: () => ({ height: 0 }) }, 0);
  assert.equal(splash.update(10).rate, 2000);
  assert.ok(particles.options.velocity[1] > 0 && Math.abs(particles.options.position[2] - 10) < 1e-9);
  assert.equal(splash.update(0.2).rate, 0);
});

test('ship settings: rows on the shared shape, lampRoughness follows the weather when null, applied to wakes and splash', () => {
  for (const row of SHIP_SETTINGS) {
    assert.ok(['wake', 'foam', 'lamps', 'splash'].includes(row.group));
    assert.equal(row.live, true);
    assert.ok(row.default === null || (row.default >= row.min && row.default <= row.max));
  }
  const rough = SHIP_SETTINGS.find((r) => r.name === 'lampRoughness');
  assert.equal(rough.default, null);
  assert.equal(rough.nullable, true);
  assert.equal(rough.weather, 'wind');
  const wakes = new ShipWakes({ surface: fakeWater() });
  const splash = { sprayRate: 0, slamBurst: 0, slamThreshold: 0 };
  applyShipSettings(wakes, SHIP_LOOKS.heavyWeather, splash);
  assert.equal(wakes.look.wakeLife, 30);
  assert.equal(splash.sprayRate, 6000);
  assert.equal(wakes.look.lampRoughness, null);
  applyShipSettings(wakes, { lampRoughness: 0.1 });
  assert.equal(wakes.look.lampRoughness, 0.1);
  assert.equal(wakes.look.wakeLife, 120);
  assert.throws(() => applyShipSettings(wakes, { nope: 1 }), TypeError);
  assert.throws(() => applyShipSettings(wakes, { wakeHeight: 9 }), RangeError);
  assert.equal(Object.keys(shipSettingDefaults()).length, SHIP_SETTINGS.length);
});

test('ships reject bad input with coded errors', () => {
  assert.throws(
    () => new ShipWakes({ surface: fakeWater(), ships: [{ hull: { length: 0, beam: 1, draft: 1 } }] }),
    RangeError,
  );
  assert.throws(
    () => new ShipWakes({ surface: fakeWater(), ships: Array(9).fill({ hull: { length: 10, beam: 2, draft: 1 } }) }),
    RangeError,
  );
  assert.throws(() => new ShipWakes({}), /surface/);
  assert.throws(() => new Floater({ hull: { length: 10, beam: 2, draft: 1 }, points: [1, 1] }), RangeError);
  assert.throws(() => new ShipSplash({ floater: {}, particles: {} }), TypeError);
});

// The CPU model of `@margoengine/terrain/ground-change`: each event's law measured against its paper's number, volume
// kept where material moves, determinism across seeks, partial updates equal to a full one, and the settings rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GroundChange,
  crustThickness,
  gullyVolume,
  lengthToBreadth,
  resolveEvent,
  runoutProgress,
  scourProgress,
  slideVolume,
} from '../dist/ground-change.js';
import {
  GROUND_CHANGE_SETTINGS,
  applyGroundChangeSettings,
  groundChangeSettingDefaults,
} from '../dist/ground-change-settings.js';
import { heldFromWeather } from '../../shared/settings.js';

const grid = (size, resolution) => ({ size: [size, size], origin: [-size / 2, -size / 2], resolution });
/** Sum of the change times the cell area, the volume moved. */
function volume(change, which = (d) => d) {
  const d = change.change,
    cell = (change.size[0] / (change.side - 1)) * (change.size[1] / (change.side - 1));
  let v = 0;
  for (let k = 0; k < d.length; k++) v += which(d[k]) * cell;
  return v;
}
const at = (change, t) => {
  change.setTime(t);
  change.update();
  return change;
};

test('scour deepens as Sumer et al. (1992): S(1 - exp(-t/T)), reaching its depth at the end', () => {
  const change = new GroundChange({
    grid: grid(40, 160),
    events: [{ kind: 'scour', center: [0, 0], radius: 5, depth: 2, duration: 50, roughness: 0 }],
  });
  for (const t of [5, 10, 25, 50, 80]) {
    const p = Math.min(t / 50, 1),
      want = 2 * scourProgress(p);
    assert.ok(Math.abs(change.sample(0, 0, t).change + want) < 1e-9, `depth at ${t} s`);
  }
  assert.ok(Math.abs(scourProgress(0.2) - (1 - Math.exp(-1)) / (1 - Math.exp(-5))) < 1e-12);
  assert.equal(change.sample(0, 0, 0).change, 0, 'no scour before it starts');
  assert.ok(Math.abs(change.sample(0, 0, 50).change + 2) < 1e-12);
});

test('a scour with a flow leaves `deposit` of its volume as a mound downstream', () => {
  const change = at(
    new GroundChange({
      grid: grid(60, 480),
      events: [{ kind: 'scour', center: [0, 0], radius: 5, depth: 2, flow: [1, 0], deposit: 0.5, roughness: 0 }],
    }),
    1000,
  );
  const cut = -volume(change, (d) => Math.min(d, 0)),
    mound = volume(change, (d) => Math.max(d, 0)),
    bowl = (Math.PI * 25 * 2) / 2.5;
  assert.ok(Math.abs(cut - bowl) / bowl < 0.02, `bowl ${cut} against ${bowl}`);
  assert.ok(Math.abs(mound - 0.5 * cut) / cut < 0.03, `mound ${mound} against half of ${cut}`);
  assert.ok(change.sample(8, 0).change > 0 && change.sample(-8, 0).change === 0, 'the mound is downstream only');
});

test('a gully cuts back from its mouth at a steady rate and fans out `deposit` of its volume', () => {
  const path = [
      [-30, 0],
      [30, 0],
    ],
    change = new GroundChange({
      grid: grid(100, 400),
      events: [{ kind: 'gully', path, width: 4, depth: 1.5, deposit: 0.6, duration: 60, roughness: 0 }],
    });
  // Headward erosion: at half time the head is half way up, the upper half untouched.
  assert.ok(change.sample(-20, 0, 30).change < -0.5, 'the lower half is cut at half time');
  assert.equal(change.sample(10, 0, 30).change, 0, 'the upper half is not cut yet');
  assert.ok(change.sample(25, 0, 60).change < -0.4, 'the whole length is cut at the end');
  // Full section at the mouth at the end: the full depth on the centre line.
  assert.ok(Math.abs(change.sample(-29.5, 0, 60).change + 1.5) < 0.05);
  at(change, 60);
  const e = resolveEvent({ kind: 'gully', path, width: 4, depth: 1.5, roughness: 0 }, 0, 0),
    eroded = -volume(change, (d) => Math.min(d, 0)),
    fan = volume(change, (d) => Math.max(d, 0)),
    expected = gullyVolume(e, 1);
  assert.ok(Math.abs(eroded - expected) / expected < 0.04, `eroded ${eroded} against ${expected}`);
  assert.ok(Math.abs(fan - 0.6 * expected) / expected < 0.04, `fan ${fan} against 0.6 of ${expected}`);
  assert.ok(change.sample(-35, 0).change > 0 && change.sample(-25, 8).change === 0, 'the fan lies below the mouth');
});

test('a cut bank retreats steadily (Ikeda et al. 1981) with its face at the given angle down to the bed', () => {
  const change = new GroundChange({
    grid: grid(80, 320),
    base: () => 3,
    events: [
      { kind: 'bank', path: [[-40, 0], [40, 0]], river: 'left', retreat: 10, bed: 0, face: 45, duration: 100, roughness: 0 },
    ],
  });
  // Travel along +x: the left is -z (river), the land is +z.
  for (const t of [25, 50, 100]) {
    const edge = 10 * (t / 100);
    assert.ok(Math.abs(change.sample(0, edge - 0.01, t).height - 0) < 0.02, `bed reached at the edge, ${t} s`);
    // On a 45 degree face the height rises one metre per metre into the land, up to the old ground.
    assert.ok(Math.abs(change.sample(0, edge + 1.5, t).height - 1.5) < 1e-9, `face at ${t} s`);
    assert.equal(change.sample(0, edge + 3.5, t).change, 0, `land past the face untouched at ${t} s`);
  }
  assert.equal(change.sample(0, -5, 100).change, 0, 'the river side is not cut');
  assert.ok(change.sample(0, 2, 100).soil > 0.9, 'the cut shows fresh soil');
});

test('a slide fails, runs out as a block under friction and lays down its volume times its bulking', () => {
  const ev = { kind: 'slide', from: [-30, 0], to: [30, 0], width: 16, depth: 3, length: 20, bulking: 1.2, duration: 12, roughness: 0 },
    change = new GroundChange({ grid: grid(90, 450), events: [ev] });
  assert.ok(Math.abs(runoutProgress(0.5) - 0.75) < 1e-12);
  at(change, 12);
  const r = resolveEvent(ev, 0, 0),
    scar = -volume(change, (d) => Math.min(d, 0)),
    lobe = volume(change, (d) => Math.max(d, 0)),
    want = slideVolume(r, 1);
  assert.ok(Math.abs(want - (2 / 3) * Math.PI * 10 * 8 * 3) < 1e-9);
  // The lobe overlaps the scar's lower end, so the net there is shared; the totals still balance.
  assert.ok(Math.abs(lobe - scar - (1.2 - 1) * want) / want < 0.05, `lobe ${lobe}, scar ${scar}, scar volume ${want}`);
  assert.ok(change.sample(28, 0).change > 0, 'the lobe reaches the toe');
  assert.ok(change.sample(-20, 0).change < -2, 'the scar is cut');
  // Half way through the front has run 3/4 of the way (s = L(1 - (1 - t)^2)).
  assert.ok(change.sample(24, 0, 6).change === 0 && change.sample(14, 0, 6).change > 0);
});

test('flood mud thins landward exponentially (Goto 2011; Abe et al. 2012) and dries after the water passes', () => {
  const change = new GroundChange({
    grid: grid(400, 200),
    events: [
      { kind: 'mud', shore: [[-200, -150], [200, -150]], land: 'right', reach: 300, thickness: 0.3, decay: 100, duration: 90, drying: 600, roughness: 0 },
    ],
  });
  // Travel along +x: right is +z, the land.
  for (const d of [20, 100, 200]) {
    const got = change.sample(0, -150 + d, 90).change,
      want = 0.3 * Math.exp(-d / 100);
    assert.ok(Math.abs(got - want) < 1e-9, `thickness ${d} m inland: ${got} against ${want}`);
  }
  assert.equal(change.sample(0, -150 - 10, 90).change, 0, 'the sea side gets no mud');
  assert.equal(change.sample(0, -150 + 299, 30).change, 0, 'the front has not reached far inland a third of the way in');
  assert.equal(change.sample(0, -100, 90).wet, 1);
  assert.ok(Math.abs(change.sample(0, -100, 690).wet - Math.exp(-1)) < 0.002, 'dries by e in `drying` seconds');
  assert.ok(change.sample(0, -100, 90).mud > 0.99);
});

test('ash thins as Pyle (1989): halving every `half` metres crosswind, stretched downwind, falling steadily', () => {
  const change = new GroundChange({
    grid: grid(4000, 100),
    events: [{ kind: 'ash', vent: [0, 0], thickness: 0.2, half: 300, wind: [10, 0], elongation: 3, duration: 100, roughness: 0 }],
  });
  // Through each isopach's centre, (e - 1) b downwind of the vent, its crosswind half width is b.
  for (const b of [0, 300, 600]) {
    const want = 0.2 * Math.pow(2, -b / 300);
    assert.ok(Math.abs(change.sample(2 * b, b, 100).change - want) < 1e-9, `crosswind ${b} m`);
  }
  // Downwind the isopach of crosswind size b reaches (2e - 1) b: 3 times as far (e = 3 gives 5b from b upwind).
  const up = change.sample(-300, 0, 100).change,
    down = change.sample(1500, 0, 100).change;
  assert.ok(Math.abs(up - 0.1) < 1e-9 && Math.abs(down - 0.1) < 1e-9, `upwind ${up}, downwind ${down}`);
  assert.ok(Math.abs(change.sample(0, 0, 50).change - 0.1) < 1e-9, 'half the fall at half time');
});

test('a lava flow advances, stands between levees and loses its glow as its crust thickens (Hon et al. 1994)', () => {
  assert.ok(Math.abs(crustThickness(3600) - 0.0779) < 1e-12);
  const change = new GroundChange({
    grid: grid(200, 400),
    events: [
      { kind: 'lava', path: [[-90, 0], [90, 0]], width: 12, thickness: 2, levee: 0.35, duration: 100, cooling: 60, glowCrust: 0.03, roughness: 0 },
    ],
  });
  assert.ok(Math.abs(change.sample(0, 0, 100).change - 2) < 1e-6, 'the sheet is the given thickness');
  assert.ok(change.sample(0, 4.9, 100).change > 2.4, 'the levee stands above the sheet');
  assert.equal(change.sample(0, 8, 100).change, 0, 'nothing beyond the flow');
  // The front reaches s = L (1 - (1 - p)^1.5): a quarter of the way in, 1 - 0.75^1.5 = 35 percent.
  assert.ok(change.sample(-90 + 180 * 0.3, 0, 25).change > 1.9 && change.sample(-90 + 180 * 0.45, 0, 25).change === 0);
  const fresh = change.sample(-90 + 180 * (1 - Math.pow(0.5, 1.5)) - 0.5, 0, 50).heat,
    age = 100 * 60,
    later = change.sample(-80, 0, 200),
    reached = 100 * (1 - Math.pow(1 - 10 / 180, 1 / 1.5)),
    want = Math.exp(-crustThickness((200 - reached) * 60) / 0.03);
  assert.ok(fresh > 0.8, `the front glows (${fresh})`);
  assert.ok(Math.abs(later.heat - want) < 1e-9, `cooled heat ${later.heat} against ${want}`);
  assert.ok(age > 0 && later.lava > 0.99);
});

test('a burn scar spreads as a wind ellipse with Alexander (1985) length to breadth, then whitens', () => {
  // 30 km/h: LB = 1 + 8.729 (1 - e^-0.9)^2.155.
  assert.ok(Math.abs(lengthToBreadth(30 / 3.6) - (1 + 8.729 * Math.pow(1 - Math.exp(-0.9), 2.155))) < 1e-12);
  const lb = lengthToBreadth(30 / 3.6),
    change = at(
      new GroundChange({
        grid: grid(600, 600),
        events: [{ kind: 'burn', ignition: [-200, 0], wind: [30 / 3.6, 0], rate: 1, duration: 300, ashing: 900, roughness: 0 }],
      }),
      300,
    );
  // Measure the burned area's length (along the wind) and breadth from the char share.
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  const n = change.side,
    surface = change.covers.surface;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      if (surface[(j * n + i) * 4 + 2] > 127) {
        const x = -300 + i,
          z = -300 + j;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
  const ratio = (x1 - x0) / (z1 - z0);
  assert.ok(Math.abs(ratio - lb) / lb < 0.03, `length to breadth ${ratio} against ${lb}`);
  assert.ok(Math.abs(x1 - (-200 + 300)) <= 1.5, 'the head runs rate x duration');
  const fresh = change.sample(90, 0, 300),
    old = change.sample(-190, 0, 1300);
  assert.ok(fresh.char > 0.9 && fresh.ashen < 0.05, 'fresh char is black');
  assert.ok(old.ashen > 0.6, 'old char has whitened');
  assert.ok(Math.abs(change.sample(0, 0, 300).change + 0.03) < 1e-9, 'litter burned off');
});

test('the ground at a time is the same however it is reached, and a partial update equals a full one', () => {
  const events = [
      { kind: 'gully', path: [[-20, -10], [10, 15]], width: 3, depth: 1, duration: 40 },
      { kind: 'lava', path: [[20, -20], [-10, 20]], start: 10, duration: 50, cooling: 30 },
      { kind: 'ash', vent: [0, 0], half: 20, wind: [3, 2], start: 5, duration: 30 },
      { kind: 'burn', ignition: [-15, 15], wind: [4, -1], rate: 0.5, start: 20, duration: 40, ashing: 30 },
      { kind: 'mud', shore: [[-25, -25], [25, -25]], land: 'right', reach: 30, duration: 20, drying: 20 },
      { kind: 'scour', center: [10, -10], flow: [0, 1], duration: 20 },
      { kind: 'slide', from: [-20, 20], to: [-5, 5], width: 8, depth: 2, start: 30 },
    ],
    stepped = new GroundChange({ grid: grid(60, 120), base: (x, z) => 0.1 * x + 0.05 * z, events }),
    jumped = new GroundChange({ grid: grid(60, 120), base: (x, z) => 0.1 * x + 0.05 * z, events });
  for (let t = 0; t <= 75; t += 0.5) at(stepped, t);
  at(jumped, 120);
  at(jumped, 3);
  at(jumped, 75);
  assert.deepEqual(stepped.change, jumped.change);
  assert.deepEqual(stepped.covers.surface, jumped.covers.surface);
  assert.deepEqual(stepped.covers.state, jumped.covers.state);
  // The grid agrees with the exact sample at its vertices.
  for (const [i, j] of [[30, 40], [80, 60], [100, 20]]) {
    const x = -30 + i * 0.5,
      z = -30 + j * 0.5;
    assert.ok(Math.abs(jumped.change[j * 121 + i] - jumped.sample(x, z).change) < 1e-6);
  }
  // Nothing recomputes when the time has not moved, and after every event settles.
  assert.equal(jumped.update(), undefined);
  at(jumped, 1e6);
  jumped.setTime(1e6 + 10);
  assert.equal(jumped.update(), undefined);
});

test('removing an event gives its ground back; options and events are checked', () => {
  const change = new GroundChange({ grid: grid(20, 40) }),
    id = change.add({ kind: 'scour', center: [0, 0] });
  at(change, 100);
  assert.ok(change.change.some((d) => d < 0));
  assert.equal(change.remove(id), true);
  change.update();
  assert.ok(change.change.every((d) => d === 0));
  assert.equal(change.remove(id), false);
  assert.throws(() => new GroundChange({ grid: { size: [0, 1] } }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(10, 10), base: new Float32Array(3) }), RangeError);
  assert.throws(() => change.add({ kind: 'quake' }), TypeError);
  assert.throws(() => change.add({ kind: 'gully', path: [[0, 0]] }), RangeError);
  assert.throws(() => change.add({ kind: 'bank', path: [[0, 0], [1, 0]] }), /bed/);
  assert.throws(() => change.add({ kind: 'scour', center: [0, 0], depth: -1 }), RangeError);
  assert.throws(() => change.add({ kind: 'burn', ignition: [0, 0], severity: 2 }), RangeError);
  assert.throws(() => change.setTime(-1), RangeError);
  assert.throws(() => change.setLook({ glow: 101 }), RangeError);
  change.dispose();
  assert.throws(() => change.add({ kind: 'scour', center: [0, 0] }), /disposed/);
});

test('settings rows: the shared shape, every row live, rain follows the weather until set', () => {
  for (const row of GROUND_CHANGE_SETTINGS) {
    assert.equal(row.live, true, row.name);
    assert.ok(row.about.length > 10, row.name);
  }
  const rain = GROUND_CHANGE_SETTINGS.find((r) => r.name === 'wet.rain');
  assert.equal(rain.default, null);
  assert.equal(rain.nullable, true);
  assert.equal(rain.weather, 'rainRate');
  const change = new GroundChange({ grid: grid(10, 10) }),
    defaults = groundChangeSettingDefaults();
  applyGroundChangeSettings(change, defaults);
  assert.deepEqual(change.look.soil, [0.3, 0.21, 0.13]);
  assert.equal(heldFromWeather(change.look, 'rain'), false);
  applyGroundChangeSettings(change, { 'wet.rain': 0.4, 'lava.glow': 20, 'ash.color': [0.5, 0.5, 0.5] });
  assert.equal(change.look.rain, 0.4);
  assert.equal(change.look.glow, 20);
  assert.equal(heldFromWeather(change.look, 'rain'), true);
  applyGroundChangeSettings(change, { 'wet.rain': null });
  assert.equal(heldFromWeather(change.look, 'rain'), false);
  assert.throws(() => applyGroundChangeSettings(change, { nope: 1 }), TypeError);
  assert.throws(() => applyGroundChangeSettings(change, { 'lava.glow': 1000 }), RangeError);
});

test('GAP-FILM-TIME: a ground change seeked by @margoengine/cutscene/seek equals a continuous run, bit for bit', async () => {
  const { seekSync } = await import('../../cutscene/dist/seek.js'),
    events = [
      { kind: 'gully', path: [[-20, -10], [10, 15]], width: 3, depth: 1, duration: 40 },
      { kind: 'lava', path: [[20, -20], [-10, 20]], start: 10, duration: 50, cooling: 30 },
      { kind: 'burn', ignition: [-15, 15], wind: [4, -1], rate: 0.5, start: 20, duration: 40, ashing: 30 },
      { kind: 'slide', from: [-20, 20], to: [-5, 5], width: 8, depth: 2, start: 30 },
    ],
    make = () => new GroundChange({ grid: grid(60, 120), base: (x, z) => 0.1 * x + 0.05 * z, events }),
    live = make(),
    cut = make(),
    fps = 30,
    n = 1500;
  // A continuous run: one frame update and one grid update a frame, as the plugin's frame does.
  for (let step = 0; step <= n; step++) {
    live.advanceTime(1 / fps);
    live.update();
  }
  seekSync({ scene: { plugins: new Map() } }, n / fps, { fps, extra: [cut] });
  cut.advanceTime(1 / fps);
  cut.update();
  assert.ok(Object.is(cut.time, live.time));
  assert.deepEqual(cut.change, live.change);
  assert.deepEqual(cut.covers.surface, live.covers.surface);
  assert.deepEqual(cut.covers.state, live.covers.state);
});

test('a lava flow driven by arrival times stops where they stop, with its width, thickness and glow per point', () => {
  const change = new GroundChange({
    grid: grid(200, 400),
    events: [
      {
        kind: 'lava',
        path: [[-90, 0], [0, 0], [60, 0]],
        arrival: [10, 40, 100],
        widths: [10, 20, 20],
        thicknesses: [1, 3, 3],
        glows: [1, 0.5, 0.5],
        cooling: 60,
        glowCrust: 0.03,
        roughness: 0,
      },
    ],
  });
  assert.equal(change.sample(-80, 0, 9).change, 0, 'nothing before the first arrival');
  // At 25 s the front is half way from -90 to 0.
  assert.ok(change.sample(-50, 0, 25).change > 0.9 && change.sample(-35, 0, 25).change === 0, 'the front follows the arrival times');
  assert.ok(Math.abs(change.sample(0, 0, 200).change - 3) < 1e-6, 'the thickness per point');
  assert.ok(change.sample(0, 9.5, 200).change > 0 && change.sample(-90, 7, 200).change === 0, 'the width per point');
  assert.equal(change.sample(70, 0, 1e6).change, 0, 'the flow stops at the end of its path');
  const cooled = change.sample(0, 0, 400).heat,
    want = 0.5 * Math.exp(-crustThickness((400 - 40) * 60) / 0.03);
  assert.ok(Math.abs(cooled - want) < 1e-9, `heat from the arrival time and the glow: ${cooled} against ${want}`);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], arrival: [5, 2] }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], widths: [5] }] }), RangeError);
});

test('a lava pond spreads as Huppert (1982), keeps the volume fed into it to 1 percent, holds after its feed and glows by age', () => {
  const G = 9.80665,
    pond = { center: [0, 0], start: 100, end: 700, flux: 10, viscosity: 1000, density: 2600 },
    change = new GroundChange({
      grid: grid(200, 200),
      events: [{ kind: 'lava', path: [[-90, -90], [-89, -90]], arrival: [0, 1], cooling: 60, glowCrust: 0.03, roughness: 0, pond }],
    }),
    K = 0.715 * Math.pow((G * 1000) / (3 * (1000 / 2600)), 1 / 8),
    volume = (t, step = 0.5) => {
      const R = K * Math.sqrt(Math.min(t, pond.end) - pond.start) + 1;
      let v = 0;
      for (let x = -R + step / 2; x < R; x += step) for (let z = -R + step / 2; z < R; z += step) v += change.sample(x, z, t).change;
      return v * step * step;
    };
  assert.equal(change.sample(0, 0, 100).change, 0, 'nothing before the pond starts');
  for (const t of [400, 700]) {
    const R = K * Math.sqrt(t - 100),
      v = volume(t);
    assert.ok(Math.abs(v - 10 * (t - 100)) / (10 * (t - 100)) < 0.01, `volume ${v} against ${10 * (t - 100)} at ${t} s`);
    assert.ok(change.sample(R * 0.99, 0, t).change > 0 && change.sample(R * 1.01, 0, t).change === 0, `edge at R = ${R} at ${t} s`);
    const H = (10 * (t - 100)) / (0.75 * Math.PI * R * R);
    assert.ok(Math.abs(change.sample(0, 0, t).change - H) < 1e-9 * H, 'the centre is H');
    assert.ok(Math.abs(change.sample(R / 2, 0, t).change - H * Math.cbrt(0.75)) < 1e-9 * H, 'the cap (1 - (r/R)^2)^(1/3)');
  }
  assert.equal(change.sample(0, 0, 5000).change, change.sample(0, 0, 700).change, 'the pond holds after its feed');
  // The surface at r was reached at start + (r / K)^2; its glow fades with the crust grown since.
  const r = 30,
    passed = 100 + (r / K) ** 2,
    want = Math.exp(-crustThickness((700 - passed) * 60) / 0.03);
  assert.ok(Math.abs(change.sample(r, 0, 700).heat - want) < 1e-9, `pond heat ${change.sample(r, 0, 700).heat} against ${want}`);
  assert.ok(change.sample(K * Math.sqrt(599) - 0.5, 0, 700).heat > change.sample(5, 0, 700).heat, 'the fresh edge glows brighter than the old middle');
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], pond: { center: [0, 0], start: 5, end: 2, flux: 1, viscosity: 1 } }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], pond: { center: [0], start: 0, end: 2, flux: 1, viscosity: 1 } }] }), RangeError);
});

test('a lava tube roofs over: a crust grows in from the levees to their crests and hides the glow (Peterson et al. 1994)', () => {
  const event = (roofs) => ({
      kind: 'lava',
      path: [[-90, 0], [0, 0], [60, 0]],
      arrival: [0, 100, 200],
      widths: [20, 20, 20],
      thicknesses: [2, 2, 2],
      levees: [0.3, 0.3, 0.3],
      cooling: 0.001,
      glowCrust: 0.03,
      roughness: 0,
      skylights: 0,
      ...(roofs ? { roofs } : {}),
    }),
    open = new GroundChange({ grid: grid(200, 400), events: [event()] }),
    tube = new GroundChange({ grid: grid(200, 400), events: [event([1000, 1e9, 1e9])] });
  // Before the front and away from the roofed segment, nothing changes.
  for (const [x, z, t] of [[-45, 0, 40], [-45, 5, 40], [30, 0, 1500], [30, 9, 1500], [-45, 0, 50]])
    assert.deepEqual(tube.sample(x, z, t), open.sample(x, z, t), `(${x}, ${z}) at ${t}`);
  // Closed: the channel is level with the levee crests (2 (1 + 0.3) m) and dark; the margins keep their levees.
  const closed = tube.sample(-45, 0, 1000);
  assert.ok(Math.abs(closed.change - 2.6) < 1e-6 && closed.heat === 0 && closed.lava > 0.99, JSON.stringify(closed));
  assert.ok(open.sample(-45, 0, 1000).heat > 0.5 && Math.abs(open.sample(-45, 0, 1000).change - 2) < 1e-6, 'the open channel still glows');
  assert.equal(tube.sample(-45, 9.5, 1000).change, open.sample(-45, 9.5, 1000).change, 'outside the crest the shape is the levee');
  assert.equal(tube.sample(-45, 9.5, 1000).heat, 0, 'and the roofed flow shows no glow');
  // Half way the crust has grown in from the margins over part of the channel; the middle still glows.
  const mid = (1000 + 50) / 2,
    middle = tube.sample(-45, 0, mid),
    margin = tube.sample(-45, 7.5, mid);
  assert.ok(middle.heat > 0.5 && margin.heat === 0, `the crust closes from the margins: ${middle.heat} in the middle, ${margin.heat} at 7.5 m`);
  // Roof times are checked like the other per-point lists.
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], roofs: [5] }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], roofs: [-1, 5] }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], drains: [5] }] }), RangeError);
  assert.throws(() => new GroundChange({ grid: grid(50, 50), events: [{ kind: 'lava', path: [[0, 0], [9, 0]], skylights: -1 }] }), RangeError);
});
test('a roofed tube has skylights: holes showing the fresh stream until the tube drains (Kauahikaua et al. 1998)', () => {
  const event = (skylights) => ({
      kind: 'lava',
      path: [[0, 0], [2000, 0]],
      arrival: [0, 200],
      widths: [20, 20],
      thicknesses: [2, 2],
      levees: [0.3, 0.3],
      roofs: [1000, 1000],
      drains: [5000, 5000],
      cooling: 60,
      glowCrust: 0.03,
      roughness: 0,
      ...(skylights === undefined ? {} : { skylights }),
    }),
    holes = (change, t) => {
      // Runs of glowing centre-line metres: [start, end] each.
      const runs = [];
      for (let x = 0; x <= 2000; x += 0.5) {
        const glow = change.sample(x, 0, t).heat > 0.9;
        if (glow && (!runs.length || runs.at(-1)[1] < x - 0.5)) runs.push([x, x]);
        else if (glow) runs.at(-1)[1] = x;
      }
      return runs;
    },
    sky = new GroundChange({ grid: grid(200, 400), events: [event()] }),
    none = new GroundChange({ grid: grid(200, 400), events: [event(0)] }),
    found = holes(sky, 2000);
  // The open channel has crusted dark by now (hours of cooling at 60 real seconds per film second); the roof is closed.
  assert.equal(holes(none, 2000).length, 0, 'no skylights: the whole tube is dark');
  // Default spacing 200 m: three of four 200 m stretches hold one, so 10 stretches give about 7.5.
  assert.ok(found.length >= 4 && found.length <= 10, `skylights along 2 km: ${JSON.stringify(found)}`);
  for (const [a, b] of found) {
    assert.ok(b - a <= 16 && b - a >= 12, `a skylight is 0.8 widths long: ${a} to ${b}`);
    const mid = (a + b) / 2;
    assert.ok(Math.abs(sky.sample(mid, 0, 2000).change - 2 * 0.5) < 1e-6, 'the stream shows half a sheet down');
    assert.equal(sky.sample(mid, 7.5, 2000).heat, 0, 'the roof spans the channel beside the hole');
    assert.ok(sky.sample(mid, 0, 5300).heat < 0.1, `once the tube drains the stream crusts over: ${sky.sample(mid, 0, 5300).heat}`);
    assert.equal(sky.sample(mid, 0, 900).heat < 0.9, true, 'before the roof closes the hole is open channel, crusting with age');
  }
  // Seeded: another seed puts them elsewhere; the same seed in the same place.
  const again = holes(new GroundChange({ grid: grid(200, 400), events: [event()] }), 2000),
    other = holes(new GroundChange({ grid: grid(200, 400), events: [{ ...event(), seed: 9 }] }), 2000);
  assert.deepEqual(again, found);
  assert.notDeepEqual(other, found);
});

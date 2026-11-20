import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Avalanche, voellmySpeed, voellmyRunout, validateAvalanche } from '../dist/avalanche.js';
import { SnowDrift } from '../dist/snow-drift.js';

const rad = (d) => (d * Math.PI) / 180;
// A slope of `deg` degrees falling toward +z, `flatFrom` metres on flat ground below it, `across` samples wide.
function slope({ deg = 35, length = 2000, cell = 4, across = 3, flatFrom = Infinity, gully = 0 } = {}) {
  const depth = Math.round(length / cell) + 1,
    ground = new Float32Array(across * depth);
  for (let j = 0; j < depth; j++) {
    const z = j * cell,
      h = -Math.tan(rad(deg)) * Math.min(z, flatFrom);
    for (let i = 0; i < across; i++) ground[j * across + i] = h + gully * cell * Math.abs(i - (across - 1) / 2);
  }
  return { width: across, depth, cellSize: cell, ground };
}
const sum = (a) => a.reduce((s, v) => s + v, 0);

test('Voellmy steady speed and Voellmy-Salm run-out formulas', () => {
  // sqrt(2000 x 1 x (sin 35 - 0.2 cos 35)) = 28.63 m/s.
  assert.ok(Math.abs(voellmySpeed(35, 1, 0.2, 2000) - 28.63) < 0.01);
  assert.equal(voellmySpeed(10, 1, 0.2, 2000), 0, 'friction holds on a slope under atan(mu)');
  // (xi h / 2 g) ln(1 + U0^2 / (mu xi h)) for 30 m/s, 1 m: 101.94 x ln(3.25) = 120.15 m.
  assert.ok(Math.abs(voellmyRunout(30, 1, 0.2, 2000) - 120.15) < 0.05);
});

test('a uniform layer on a uniform slope reaches Voellmy steady speed', () => {
  for (const [deg, mu, xi] of [[35, 0.2, 2000], [30, 0.25, 1000]]) {
    const a = new Avalanche({ ...slope({ deg }), cover: 1, coverDensity: 300, density: 300, release: { at: [4, 300], size: [100, 250] },
      releaseDepth: 1, friction: mu, turbulence: xi, entrainment: 0, cloud: false });
    a.seek(30);
    const h = a.flowDepth(),
      u = a.flowSpeed();
    // The middle of the flow by mass, on the centre line: far from the front and the tail, the layer is uniform.
    let m = 0,
      mz = 0;
    for (let k = 1; k < h.length; k += 3) {
      m += h[k];
      mz += h[k] * k;
    }
    const mid = Math.round(mz / m / 3) * 3 + 1,
      core = [u[mid - 3], u[mid], u[mid + 3]],
      measured = u[mid],
      // The flow is a vertical thickness: its bed-normal depth is h cos(theta).
      expected = voellmySpeed(deg, h[mid] * Math.cos(rad(deg)), mu, xi);
    assert.ok(Math.abs(core[0] - core[2]) < 0.01 * measured, `a uniform core: ${core}`);
    assert.ok(Math.abs(measured - expected) / expected < 0.03, `${deg} degrees: ${measured} m/s against Voellmy ${expected}`);
  }
});

test('friction holds a slab on a slope under atan(mu): it stops where it is', () => {
  const a = new Avalanche({ ...slope({ deg: 10, length: 400 }), cover: 1, release: { at: [4, 200], size: [100, 40] }, friction: 0.2, cloud: false });
  a.seek(60);
  assert.ok(a.isStopped);
  // The slab's front slumps under its own pressure (k = 1) until the surface slope plus the ground's is under mu: at
  // most its depth over (mu - tan(theta)) past its edge, with no avalanche running out.
  const slump = a.reach([0, 1], [0, 240]),
    most = 1 / (0.2 - Math.tan(rad(10))) + 4;
  assert.ok(slump > 0 && slump <= most, `the front slumps ${slump} m of at most ${most}`);
});

test('the run-out on the flat lies within the Voellmy-Salm bounds, and the flow stops as deposit', () => {
  const s = slope({ deg: 35, length: 1400, flatFrom: 600 }),
    run = (o = {}) => new Avalanche({ ...s, cover: 0.5, coverDensity: 300, release: { at: [4, 150], size: [100, 100] }, releaseDepth: 1.5, entrainment: 0, cloud: false, ...o });
  const a = run();
  let fastest = 0,
    deepest = 0,
    front = 0,
    frontDepth = 0;
  for (let t = 0.25; t <= 300 && !a.isStopped; t += 0.25) {
    a.seek(t);
    const u = a.flowSpeed(),
      h = a.flowDepth();
    let tip = -1;
    for (let k = 0; k < h.length; k++) {
      if (h[k] > 0.01) tip = k;
      fastest = Math.max(fastest, u[k]);
      deepest = Math.max(deepest, h[k]);
    }
    if (!front && tip >= 0 && Math.floor(tip / 3) * 4 >= 600) {
      front = u[tip];
      for (let k = tip - 60; k <= tip; k++) frontDepth = Math.max(frontDepth, h[k]);
    }
  }
  assert.ok(a.isStopped, 'the avalanche stops');
  // A spreading flow is not one block: its run-out lies between the block arriving at the front's speed and depth and
  // the block arriving at the fastest speed with the deepest flow (Salm et al. 1990).
  const measured = a.reach([0, 1], [0, 600]),
    low = voellmyRunout(front, frontDepth),
    high = voellmyRunout(fastest, deepest);
  assert.ok(measured > low && measured < high, `run-out ${measured} m between ${low} and ${high} m`);
  assert.equal(sum(a.flowDepth()), 0);
  assert.ok(Math.max(...a.depositDepth()) > 0.3, 'a deposit lies in the run-out');
  const slick = run({ friction: 0.15 }),
    smooth = run({ turbulence: 4000 });
  slick.seek(300);
  smooth.seek(300);
  assert.ok(slick.reach([0, 1], [0, 600]) > measured + 10, 'mu 0.15 runs farther than 0.2');
  assert.ok(smooth.reach([0, 1], [0, 600]) > measured + 8, 'xi 4000 runs farther than 2000');
});

test('the core entrains the cover, throws up a powder cloud that grows, and the mass budget closes', () => {
  const a = new Avalanche({ ...slope({ deg: 38, length: 1600, across: 9, flatFrom: 1000 }), cover: 1.2, release: { at: [16, 120], size: [12, 60] }, releaseDepth: 1, wind: 0 });
  a.seek(4);
  const early = a.powderCloud();
  a.seek(14);
  const later = a.powderCloud(),
    b = a.budget();
  assert.ok(b.entrained > b.released, `entrained ${b.entrained} kg over the ${b.released} kg slab (Sovilla et al. 2006: it grows several times)`);
  const total = b.flowing + b.deposited + b.suspended;
  assert.ok(Math.abs(total - b.released - b.entrained) / (b.released + b.entrained) < 1e-9, `budget ${total} against ${b.released + b.entrained}`);
  assert.ok(early.length > 0 && later.length > early.length, `cloud parcels ${early.length} then ${later.length}`);
  const first = later.find((p) => p.id === early[0].id);
  assert.ok(first && first.height > early[0].height + 5, 'a parcel grows as it travels');
  assert.ok(later.every((p) => p.opacity > 0 && p.opacity <= 1 && p.concentration > 0));
  // The scar: the slab's cover is gone, the path is eroded, the cover off the path untouched.
  const cover = a.coverDepth();
  assert.ok(cover[30 * 9 + 4] < 0.01, 'the release scar is bare');
  assert.ok(cover[50 * 9 + 4] < 0.5, 'the track is eroded');
  assert.equal(cover[5 * 9 + 4], Math.fround(1.2), 'the cover above the crown is untouched');
  a.seek(2000);
  assert.ok(a.isStopped);
  const end = a.budget();
  assert.ok(Math.abs(end.deposited - end.released - end.entrained) / end.deposited < 1e-9, 'all of it ends as deposit');
  assert.equal(a.powderCloud().length, 0, 'the cloud has settled out');
});

test('the powder cloud runs with or ahead of the core through the track and overruns it on the run-out', () => {
  // Sovilla, McElwaine and Louge 2015 (C. R. Physique 16, 97-104, open access): the core erupts its snow just behind its
  // front and the dilute front region travels ahead of the denser slide. The cloud's front is its head's leading edge,
  // `cloudAspect` (1.6) times its height past its centre; the core's front is its farthest flowing sample.
  const s = slope({ deg: 38, length: 1600, across: 9, flatFrom: 1000 }),
    a = new Avalanche({ ...s, cover: 1.2, release: { at: [16, 120], size: [12, 60] }, releaseDepth: 1, wind: 0 }),
    fronts = [];
  for (let t = 1; t <= 120; t++) {
    a.seek(t);
    const h = a.flowDepth();
    let core = -1;
    for (let k = 0; k < h.length; k++) if (h[k] > 0.01) core = Math.max(core, Math.floor(k / 9) * 4);
    const powder = Math.max(-1, ...a.powderCloud().map((p) => p.position[2] + 1.6 * p.height));
    fronts.push({ t, core, powder });
  }
  // The track: from the cloud's fifth second (it forms where the core first throws snow up, just behind the core's thin
  // tip, and overtakes it as it gathers the eruption) until the core reaches the flat at z = 1000.
  const born = fronts.find((f) => f.powder >= 0).t,
    track = fronts.filter((f) => f.t >= born + 4 && f.core >= 0 && f.core < 1000);
  assert.ok(track.length >= 30, `${track.length} s of track`);
  for (const f of track) assert.ok(f.powder >= f.core, `at ${f.t} s the cloud's front ${f.powder} m trails the core's ${f.core} m`);
  const first = track[0],
    last = track.at(-1),
    powderSpeed = (last.powder - first.powder) / (last.t - first.t),
    coreSpeed = (last.core - first.core) / (last.t - first.t);
  assert.ok(powderSpeed >= coreSpeed, `the cloud's front ran ${powderSpeed} m/s against the core's ${coreSpeed}`);
  // The run-out: the core stops on the flat; the cloud runs on well past the farthest it got.
  const coreMost = Math.max(...fronts.map((f) => f.core)),
    powderMost = Math.max(...fronts.map((f) => f.powder));
  assert.ok(fronts.at(-1).core < 0, 'the core has stopped');
  assert.ok(powderMost > coreMost + 200, `the cloud reached ${powderMost} m, the core ${coreMost} m`);
});

test('plants bend along the flow before they break, and stand again once it has passed', () => {
  const s = slope({ deg: 38, length: 1200, across: 21, flatFrom: 800, gully: 0.7 }),
    make = (o = {}) => new Avalanche({ ...s, cover: 1, release: { at: [40, 120], size: [10, 60] }, releaseDepth: 1.5, cloud: false, ...o }),
    a = make();
  let bent = 0,
    down = 0,
    beforeBreak = 0;
  const seen = new Set();
  for (let t = 1; t <= 200; t++) {
    a.seek(t);
    const b = a.plantBend(),
      kept = a.plantsKept();
    for (let k = 0; k < kept.length; k++) {
      const amount = Math.hypot(b[2 * k], b[2 * k + 1]);
      assert.ok(amount <= 1 + 1e-6);
      if (amount > 0.05) {
        bent++;
        if (b[2 * k + 1] > 0) down++;
        if (!seen.has(k) && kept[k] === 1) beforeBreak++;
        seen.add(k);
      }
      if (kept[k] === 0) assert.equal(amount, 0, 'a broken plant does not bend');
    }
  }
  assert.ok(bent > 0 && down > 0.95 * bent, `${down} of ${bent} bends point down the slope (the rest spread at the flow's margins)`);
  assert.ok(beforeBreak > 10, `${beforeBreak} samples bent while still whole`);
  assert.ok(a.isStopped);
  const rest = a.plantBend();
  assert.equal(rest.reduce((m, v) => Math.max(m, Math.abs(v)), 0), 0, 'nothing bends once the flow has stopped');
  // A higher bendPressure bends fewer plants; the pushers turn plants along the same bend.
  const stiff = make({ bendPressure: 40000 });
  stiff.seek(20);
  a.seek(20);
  const count = (x) => {
    const b = x.plantBend();
    let c = 0;
    for (let k = 0; k < b.length; k += 2) if (Math.hypot(b[k], b[k + 1]) > 0.05) c++;
    return c;
  };
  assert.ok(count(stiff) < count(a), `${count(stiff)} stiff against ${count(a)}`);
  const pushers = a.plantPushers(50);
  assert.ok(pushers.length > 0 && pushers.length <= 50);
  for (let i = 1; i < pushers.length; i++) assert.ok(pushers[i].strength <= pushers[i - 1].strength);
  assert.ok(pushers.every((p) => p.radius === 4 && p.strength > 0 && p.strength <= 1 && Number.isFinite(p.position[1])));
});

test('trees break where the pressure passes breakPressure; deposit buries; plants beside the path stand', () => {
  const a = new Avalanche({ ...slope({ deg: 38, length: 1200, across: 21, flatFrom: 800, gully: 0.7 }), cover: 1, release: { at: [40, 120], size: [10, 60] }, releaseDepth: 1.5, cloud: false });
  a.seek(200);
  const p = a.peakPressure(),
    kept = a.plantsKept(),
    track = 120 * 21 + 10;
  assert.ok(p[track] > 100000, `the track saw ${p[track]} Pa`);
  assert.equal(kept[track], 0);
  assert.equal(kept[120 * 21 + 0], 1, 'beside the path');
  const deep = a.depositDepth().reduce((b, d, k) => (d > a.depositDepth()[b] ? k : b), 0);
  assert.ok(a.depositDepth()[deep] >= 2 && kept[deep] === 0, 'the deep deposit buries plants');
});

test('deterministic over film time: a seek back replays, steps of any size give the same snow', () => {
  const make = () => new Avalanche({ ...slope({ deg: 36, length: 800, across: 5 }), cover: 1, release: { at: [8, 100], size: [8, 40] }, releaseTime: 1 });
  const a = make(),
    b = make();
  a.seek(9);
  for (let t = 0; t < 9; t += 0.37) b.update(0.37);
  b.seek(9);
  assert.deepEqual(a.fieldData(), b.fieldData());
  assert.deepEqual(a.powderCloud(), b.powderCloud());
  a.seek(3);
  const back = Float32Array.from(a.fieldData());
  const c = make();
  c.seek(3);
  assert.deepEqual(back, c.fieldData());
  const before = make();
  before.seek(0.5);
  assert.ok(!before.isReleased && sum(before.flowDepth()) === 0, 'nothing moves before releaseTime');
});

test('the cloud drifts with the weather wind; a set wind overrides it', () => {
  const weather = { state: { wind: 10, windDirection: Math.PI / 2 } };
  const a = new Avalanche({ ...slope({ deg: 36, length: 600, across: 5 }), cover: 1, release: { at: [8, 100], size: [8, 40] }, weather });
  assert.deepEqual(a.windNow().map((v) => Math.round(v * 1e6) / 1e6), [10, 0]);
  a.options.wind = 0;
  assert.deepEqual(a.windNow(), [0, 0]);
});

test('a SnowDrift slab releases where its stability index is under 1, and its ground and cover carry over', () => {
  const W = 40,
    D = 60,
    ground = new Float32Array(W * D).map((_, k) => -0.8 * Math.floor(k / W));
  // Old snow, a dry spell that makes a weak layer, then 40 mm/h of snow on it (the SnowDrift slide-state case).
  const o = { width: W, depth: D, ground, initialDepth: 0.5, snowfall: 0, temperature: -10, burial: 3600, sintering: 0 };
  const drift = new SnowDrift(o);
  drift.seek(10);
  o.snowfall = 40;
  drift.seek(4 * 3600);
  const slide = drift.slide();
  const a = new Avalanche({ snow: drift, releaseTime: 0, cloud: false });
  a.seek(0);
  const flow = a.flowDepth();
  let released = 0,
    wrong = 0;
  for (let k = 0; k < W * D; k++) {
    if (slide.index[k] < 1) released++;
    if ((flow[k] > 0) !== (slide.index[k] < 1 && slide.slabDepth[k] > 0)) wrong++;
  }
  assert.ok(released > 0, 'the drift has an unstable slab');
  assert.equal(wrong, 0, 'flow starts on exactly the unstable samples');
  assert.equal(a.fieldData()[0], ground[0]);
});

test('drawCloud adds a white cloud per parcel and takes out those gone', () => {
  const added = [],
    target = {
      add(options) {
        const c = { options, matrix: new Float32Array(16) };
        added.push(c);
        return c;
      },
      remove(c) {
        const i = added.indexOf(c);
        if (i >= 0) added.splice(i, 1);
        return i >= 0;
      },
    };
  const a = new Avalanche({ ...slope({ deg: 38, length: 1000, across: 9, flatFrom: 700 }), cover: 1.2, release: { at: [16, 120], size: [12, 60] } });
  a.seek(8);
  a.drawCloud(target);
  assert.equal(added.length, a.powderCloud().length);
  assert.ok(added.every((c) => c.matrix[15] === 1 && c.matrix[5] > 0 && c.options.opacity > 0));
  a.seek(2000);
  a.drawCloud(target);
  assert.equal(added.length, 0);
});

test('validation', () => {
  assert.throws(() => validateAvalanche({ width: 2, depth: 10, release: { at: [0, 0] } }), RangeError);
  assert.throws(() => validateAvalanche({ width: 4, depth: 4 }), RangeError, 'a release or a snow');
  assert.throws(() => validateAvalanche({ width: 4, depth: 4, release: 'unstable' }), RangeError);
  assert.throws(() => validateAvalanche({ width: 4, depth: 4, release: { at: [0, 0] }, friction: 2 }), RangeError);
  assert.throws(() => new Avalanche({ width: 4, depth: 4, release: { at: [0, 0] }, ground: [1, 2] }), RangeError);
  assert.throws(() => new Avalanche({ snow: {}, width: 4, depth: 4 }), TypeError);
  const a = new Avalanche({ width: 4, depth: 4, release: { at: [1, 1] } });
  assert.throws(() => a.seek(-1), RangeError);
});

test('every slider row is read: a value off its default changes the avalanche; null wind rows follow the weather', async () => {
  const { AVALANCHE_SETTINGS, AVALANCHE_LOOKS, applyAvalancheSettings, avalancheSettingDefaults, avalancheSettingValues } = await import('../dist/settings.js');
  const weather = { state: { wind: 6, windDirection: 0 } };
  const make = (values) => {
    const a = new Avalanche({ ...slope({ deg: 38, length: 600, across: 7, flatFrom: 400 }), cover: 1, release: { at: [12, 80], size: [8, 30] }, weather });
    applyAvalancheSettings(a, values);
    a.seek(40);
    return JSON.stringify([Array.from(a.fieldData()), a.powderCloud(), Array.from(a.plantsKept()), Array.from(a.plantBend()), a.windNow()]);
  };
  const base = make({});
  for (const row of AVALANCHE_SETTINGS) {
    const d = row.default ?? row.min,
      v = d === row.max ? row.min : Math.min(row.max, d === 0 ? row.max / 4 : d * (d < row.max / 2 ? 2 : 0.5));
    // The flow rows need a value that matters in 12 s; releaseTime past 12 s keeps it whole.
    const value = row.default === null ? row.max / 4 : row.name === 'releaseTime' ? 5 : row.name === 'releaseDepth' ? 0.5 : row.name === 'stopMomentum' ? 0.45 : row.name === 'breakPressure' ? 5000 : row.name === 'bendPressure' ? 20000 : v;
    assert.notEqual(make({ [row.name]: value }), base, `${row.name} = ${value} changes nothing`);
  }
  assert.ok(Object.keys(avalancheSettingDefaults()).length === AVALANCHE_SETTINGS.length);
  const a = new Avalanche({ width: 4, depth: 4, release: { at: [1, 1] }, weather });
  applyAvalancheSettings(a, AVALANCHE_LOOKS.dryPowder);
  assert.equal(a.options.friction, 0.16);
  assert.deepEqual(a.windNow().map(Math.round), [0, 6], 'null follows the weather');
  applyAvalancheSettings(a, { wind: 2, windDirection: 90 });
  assert.deepEqual(a.windNow().map(Math.round), [2, 0], 'a value overrides it');
  assert.equal(avalancheSettingValues(a).wind, 2);
  assert.throws(() => applyAvalancheSettings(a, { nope: 1 }), TypeError);
  assert.throws(() => applyAvalancheSettings(a, { friction: 5 }), RangeError);
});

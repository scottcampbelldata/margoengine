// @margoengine/weather/lava against its papers' numbers: the glow against Planck and the old candela, the crust against
// Hon et al. (1994), the sheet against Jeffreys (1925) and Hulme (1974), the path against the steepest descent, the stop
// against the Graetz rule (Pinkerton and Wilson 1994), the pond against Huppert (1982), the fountain against Wilson and
// Head (1981), the bombs against ballistics with and without drag (Mastin 2001), determinism over film time, the
// ground cover through GroundChange, and every slider row read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LavaFlow,
  SUN_LUMINANCE,
  airDensity,
  binghamSpeed,
  binghamThickness,
  lavaGlow,
  pondRadius,
  slabCore,
  validateLava,
} from '../dist/lava.js';

const G = 9.80665;
const slope = (grade) => (x, z) => 1000 - grade * z;

test('the glow is a blackbody through the CIE observer: the 2042 K candela and illuminant A', () => {
  // The 1948 to 1979 candela: a blackbody at the freezing point of platinum (2042 K) is 60 cd/cm^2.
  const L = lavaGlow(2042)[3];
  assert.ok(Math.abs(L - 600000) / 600000 < 0.01, `2042 K luminance ${L} cd/m^2`);
  // CIE illuminant A, a 2856 K blackbody, has chromaticity x 0.4476, y 0.4074.
  const [r, g, b] = lavaGlow(2856),
    X = 0.4124 * r + 0.3576 * g + 0.1805 * b,
    Y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
    Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  assert.ok(Math.abs(X / (X + Y + Z) - 0.4476) < 0.003 && Math.abs(Y / (X + Y + Z) - 0.4074) < 0.003, `illuminant A at ${X / (X + Y + Z)}, ${Y / (X + Y + Z)}`);
  // Hotter lava is brighter and yellower; below 500 K it is dark.
  const cool = lavaGlow(1100),
    hot = lavaGlow(1450);
  assert.ok(hot[3] > 50 * cool[3] && hot[1] / hot[0] > cool[1] / cool[0]);
  assert.deepEqual(lavaGlow(400), [0, 0, 0, 0]);
  assert.ok(Math.abs(SUN_LUMINANCE - 100000 / Math.PI) < 1e-9);
});

test('the crust grows within 30 percent of Hon et al. (1994) from an hour to a day, the Stefan case within 6 percent', () => {
  const lava = new LavaFlow();
  for (const hours of [1, 3, 6, 12, 24]) {
    const hon = 0.0779 * Math.sqrt(hours),
      crust = lava.crustThickness(hours * 3600),
      stefan = lava.stefanCrust(hours * 3600);
    assert.ok(Math.abs(crust - hon) / hon < 0.3, `${hours} h: crust ${crust} m against ${hon}`);
    assert.ok(Math.abs(stefan - hon) / hon < 0.06, `${hours} h: Stefan crust ${stefan} m against ${hon}`);
  }
  // The surface cools within minutes (Keszthelyi and Denlinger 1996): under 1,150 K in a minute, under 800 K in an hour.
  assert.ok(lava.surfaceTemperature(60) < 1150 && lava.surfaceTemperature(3600) < 800 && lava.surfaceTemperature(1) > 1380);
});

test('the sheet flows as Jeffreys (1925) with Hulme (1974) plug correction, and its thickness carries the flux', () => {
  const rho = 2600,
    eta = 500,
    sin = Math.sin(0.05),
    h = 2;
  assert.ok(Math.abs(binghamSpeed(h, sin, rho, eta, 0) - (rho * G * h * h * sin) / (3 * eta)) < 1e-12);
  const hy = 1000 / (rho * G * sin);
  assert.equal(binghamSpeed(hy * 0.99, sin, rho, eta, 1000), 0, 'below the plug thickness it cannot flow');
  const x = hy / h;
  assert.ok(Math.abs(binghamSpeed(h, sin, rho, eta, 1000) - ((rho * G * h * h * sin) / (3 * eta)) * (1 - 1.5 * x + 0.5 * x ** 3)) < 1e-12);
  const q = 3,
    t = binghamThickness(q, sin, rho, eta, 1000);
  assert.ok(Math.abs(t * binghamSpeed(t, sin, rho, eta, 1000) - q) < 1e-9, 'thickness times speed is the flux');
  assert.ok(Math.abs(airDensity(0) - 1.225) < 1e-9 && Math.abs(airDensity(5000) - 0.7364) < 0.001, 'ICAO air density');
});

test('the path runs down the steepest descent: along a valley floor, and outward from a cone', () => {
  const valley = new LavaFlow({ vent: [0, 1000, 0], ground: (x, z) => 1000 - 0.05 * z + 0.2 * Math.abs(x), maxLength: 2000 }),
    p = valley.path();
  assert.ok(p.length > 300);
  for (let i = 1; i < p.length; i++) {
    assert.ok(Math.abs(p[i].position[0]) < 3 * 5, `point ${i} leaves the valley floor: x ${p[i].position[0]}`);
    assert.ok(p[i].position[1] < p[i - 1].position[1] + 0.5, `point ${i} climbs`);
  }
  const cone = new LavaFlow({ vent: [0, 500, 0], ground: (x, z) => 500 - 0.3 * Math.hypot(x - 1, z - 0.5), maxLength: 500, wander: 0 }),
    end = cone.path().at(-1).position;
  const off = Math.abs(Math.atan2(end[2] - 0, end[0] - 0) - Math.atan2(-0.5, -1));
  assert.ok(Math.min(off, 2 * Math.PI - off) < 0.1, `the flow runs straight down the cone: ${off} rad off`);
});

test('a cooling-limited flow stops where its Graetz number reaches 300 (Pinkerton and Wilson 1994); more supply runs further', () => {
  const lengths = [];
  // A low solidus keeps the core liquid, so the Graetz rule decides.
  for (const q of [1, 2, 8]) {
    const lava = new LavaFlow({ ground: slope(0.03), effusionRate: q, maxLength: 200000, step: 20, solidus: 1000 }),
      p = lava.path();
    assert.equal(lava.stop, 'cooled', `${q} m^3/s stops by cooling`);
    assert.ok(p.at(-1).graetz < 300 && p.at(-2).graetz >= 300, `Graetz ${p.at(-2).graetz} then ${p.at(-1).graetz}`);
    // The core cools and stiffens down the channel.
    assert.ok(p.at(-1).temperature < p[0].temperature && p.at(-1).viscosity > p[0].viscosity);
    lengths.push(lava.length);
  }
  assert.ok(lengths[0] < lengths[1] && lengths[1] < lengths[2], `lengths ${lengths}`);
  // With a solidus close to the vent temperature the core freezes first: the flow stops with its core at the solidus.
  const frozen = new LavaFlow({ ground: slope(0.03), effusionRate: 2, maxLength: 200000, step: 20, solidus: 1400 });
  assert.equal(frozen.stop, 'cooled');
  assert.ok(frozen.path().at(-1).temperature <= 1400 && frozen.path().at(-1).graetz >= 300 && frozen.length < lengths[1]);
  const stiff = new LavaFlow({ ground: slope(0.03), yieldStrength: 1e4, yieldRise: 0.2, maxLength: 200000, step: 20 });
  assert.ok(['stalled', 'cooled'].includes(stiff.stop));
});

test('a flow on flat ground ponds and spreads as Huppert (1982): R = 0.715 (g Q^3 / 3 nu)^(1/8) t^(1/2)', () => {
  const lava = new LavaFlow({ vent: [0, 10, 0], effusionRate: 5, rise: 1, wander: 0 });
  assert.equal(lava.stop, 'ponded');
  const eta = lava.path()[0].viscosity;
  lava.seek(1001);
  const r = lava.pondRadius(),
    want = 0.715 * Math.pow((G * 125) / (3 * (eta / 2600)), 1 / 8) * Math.sqrt(lava.supplied());
  assert.ok(Math.abs(r - want) < 1e-9 * want && Math.abs(pondRadius(5, 1000, 2600, eta) * 2 - pondRadius(5, 4000, 2600, eta)) < 1e-9);
  // The ground event of a ponded flow is still valid.
  const ev = lava.lavaEvent();
  assert.ok(ev.path.length >= 2 && ev.arrival.every(Number.isFinite));
});

test('the front follows the supply: it advances while the vent runs and stops when the supply is spent', () => {
  const lava = new LavaFlow({ ground: slope(0.05), effusionRate: 20, rise: 10, duration: 600, wane: 10, maxLength: 100000 });
  assert.equal(lava.front(0).distance, 0);
  const a = lava.front(200),
    b = lava.front(400);
  assert.ok(b.distance > a.distance && a.speed > 0 && a.stop === 'flowing');
  // Half the flux in the rise: Jeffreys' sheet runs at 0.5^(2/3) of its full speed.
  const rising = lava.front(5);
  assert.ok(Math.abs(rising.speed - lava.path()[0].speed * 0.5 ** (2 / 3)) < 1e-12, `rise speed ${rising.speed}`);
  const done = lava.front(lava.end + 10),
    later = lava.front(lava.end + 10000);
  assert.equal(done.distance, later.distance);
  assert.equal(later.stop, 'supply');
  assert.equal(later.speed, 0);
  // The front reaches each point at the film second its travel time of full supply has been delivered.
  const p = lava.path();
  assert.ok(Math.abs(lava.supplied(lava.arrival(50)) - p[50].travel) < 1e-6);
  const ev = lava.lavaEvent();
  assert.ok(ev.arrival.at(-1) <= lava.end && ev.arrival.every((t, i) => i === 0 || t >= ev.arrival[i - 1]));
});

test('the surface glows through cracks that close as it ages (Crisp and Baloga 1990), dark a day after the vent stops', () => {
  const lava = new LavaFlow({ ground: slope(0.05), duration: 600, maxLength: 5000 });
  lava.seek(900);
  const near = lava.radiance(2),
    far = lava.radiance(100);
  assert.ok(near[0] > far[0] && near[0] > 0.01, `the fresh lava near the vent glows brighter: ${near[0]} > ${far[0]}`);
  assert.ok(near[0] >= near[1] && near[1] >= near[2], 'red-orange');
  assert.ok(lava.crackShare(2) > lava.crackShare(100) && lava.crackShare(100) >= 0.05);
  lava.seek(lava.end + 86400);
  assert.ok(lava.radiance(2)[0] < near[0] * 1e-3 && lava.crackShare(2) < 1e-6, 'a day after the vent stops the glow has gone');
  assert.deepEqual(lava.radiance(9999), [0, 0, 0]);
});

test('the fountain rises to U^2 / 2g without drag (Wilson and Head 1981), lower with it', () => {
  const top = (drag) => {
    const lava = new LavaFlow({ fountainHeight: 50, clotRate: 300, rise: 1, drag, bombRate: 0 });
    let best = 0;
    for (let t = 20; t < 30; t += 0.05) for (const c of lava.clots(t)) best = Math.max(best, c.position[1]);
    return best;
  };
  const free = top(0);
  assert.ok(free <= 50 + 1e-6 && free > 50 * 0.97, `fountain top ${free} m`);
  assert.ok(top(1) < free * 0.9, 'drag holds small clots lower');
  const lava = new LavaFlow({ rise: 1 });
  assert.equal(lava.clots(0).length, 0);
  assert.ok(lava.clots(30).length > 100 && lava.fountain(30) === 40);
  assert.ok(lava.clots(30).every((c) => c.temperature > 1000 && c.color[0] > 0));
});

test('bombs fly as ballistics: without drag they land at their launch speed after 2 v / g; with drag near terminal speed (Mastin 2001)', () => {
  const free = new LavaFlow({ bombRate: 6, bombSpread: 0, drag: 0, fountainHeight: 0 }),
    hits = free.impacts(0, 300);
  assert.ok(hits.length > 50);
  for (const h of hits) {
    assert.ok(Math.abs(h.speed - h.launchSpeed) < 1e-6 * h.launchSpeed, `impact ${h.speed} against launch ${h.launchSpeed}`);
    assert.ok(Math.abs(h.time - h.launch - (2 * h.launchSpeed) / G) < 1e-6, 'flight time 2 v / g');
  }
  // Drag: a 0.1 m bomb thrown at 300 m/s comes down near its terminal speed sqrt(2 m g / (rho Cd A)).
  const drag = new LavaFlow({ bombRate: 6, bombSpread: 0, bombSpeed: 300, bombSize: 0.1, drag: 0.8, fountainHeight: 0 });
  for (const h of drag.impacts(0, 600)) {
    const d = Math.cbrt((6 * h.mass) / (Math.PI * 2500)),
      terminal = Math.sqrt((2 * h.mass * G) / (1.225 * 0.8 * (Math.PI * d * d) / 4));
    assert.ok(h.speed < h.launchSpeed && h.speed < terminal * 1.05 && h.speed > terminal * 0.7, `impact ${h.speed}, terminal ${terminal}`);
  }
  const lava = new LavaFlow({ rise: 1 });
  lava.seek(400);
  const bombs = lava.bombs();
  assert.ok(bombs.some((b) => b.landed) && bombs.some((b) => !b.landed));
});

test('the same film time gives the same lava, however it is reached', () => {
  const opts = () => ({ vent: [0, 1000, 0], ground: slope(0.06), rise: 5, wind: 4, windDirection: 30, seed: 7 });
  const stepped = new LavaFlow(opts()),
    jumped = new LavaFlow(opts());
  let impacts = 0;
  for (let k = 0; k < 100; k++) {
    stepped.update(0.5);
    impacts += stepped.takeImpacts().length;
  }
  jumped.seek(500);
  jumped.seek(50);
  const read = (l) => JSON.stringify([l.time, l.front(), l.clots(), l.bombs(), l.glowLights(), l.lavaEvent()]);
  assert.equal(read(stepped), read(jumped));
  assert.equal(impacts, jumped.impacts(0, 50).length, 'the impacts taken frame by frame are the impacts of the span');
  assert.throws(() => jumped.seek(-1), RangeError);
  assert.throws(() => jumped.update(Number.NaN), RangeError);
});

test('glow lights: at most maxLights, over the fountain and along the flow, scaled by glow, written into lights', () => {
  let set = [];
  const lava = new LavaFlow({ ground: slope(0.05), rise: 1, maxLights: 5, lights: { setLights: (l) => (set = l) } });
  lava.seek(900);
  assert.equal(set.length, 5);
  assert.ok(set.every((l) => l.intensity > 0 && l.range === 400 && l.decay === 2 && l.color[0] === 1 && l.color[1] < 0.6));
  assert.ok(Math.abs(set[0].position[1] - 20) < 1e-9, 'the first light is over the 40 m fountain');
  const bright = set.map((l) => l.intensity);
  lava.options.glow = 3;
  lava.seek(900);
  set.forEach((l, i) => assert.ok(Math.abs(l.intensity - 3 * bright[i]) < 1e-9 * bright[i]));
  lava.seek(lava.end + 3 * 86400);
  assert.ok(set.reduce((s, l) => s + l.intensity, 0) < 1e-3 * bright.reduce((s, b) => s + b, 0), 'cooled lava lights almost nothing');
  lava.dispose();
  assert.deepEqual(set, []);
});

test('the flow lays its lava cover on a GroundChange: thick and glowing where reached, nothing past the front', async () => {
  const { GroundChange } = await import('../../terrain/dist/ground-change.js');
  const lava = new LavaFlow({ vent: [0, 1000, -150], ground: slope(0.05), rise: 1, maxLength: 2000 }),
    change = new GroundChange({ grid: { size: [400, 400], origin: [-200, -200], resolution: 201 }, events: [lava.lavaEvent()] });
  lava.seek(120);
  const front = lava.front(),
    behind = lava.path()[Math.floor(front.distance / 5 / 2)].position;
  change.update(120);
  const s = change.sample(behind[0], behind[2], 120);
  assert.ok(s.change > 0.5 && s.heat > 0.3 && s.lava > 0.9, `cover behind the front: ${JSON.stringify(s)}`);
  assert.equal(change.sample(front.position[0], front.position[2] + 40, 120).change, 0, 'nothing past the front');
});

test('every slider row is read: a value off its default changes the lava; null wind rows follow the weather', async () => {
  const { LAVA_SETTINGS, LAVA_LOOKS, applyLavaSettings, lavaSettingDefaults, lavaSettingValues } = await import('../dist/lava-settings.js');
  const weather = { state: { wind: 6, windDirection: 0 } };
  // With breakouts on, for the roof row: when the blocked tube's roof bursts.
  const burst = (l) => new LavaFlow({ ...tubed(l).options, breakoutHeight: l.options.breakoutHeight || 20 }).branches().map((b) => b.path[0].travel);
  const make = (values) => {
    const l = new LavaFlow({ weather, vent: [0, 1000, 0], ground: slope(0.05) });
    applyLavaSettings(l, values);
    l.seek(l.options.start ?? 0);
    l.update(400);
    const p = l.path();
    return JSON.stringify([l.time, l.end, l.length, l.stop, p.length, p[3], p.at(-1), l.front(), l.radiance(3), l.radiance(40), l.clots(), l.bombs(), l.glowLights(), l.crustThickness(3600), l.surfaceTemperature(100), l.coreTemperature(3, l.end + 30 * 86400), l.leveeShare(3), l.tubeTemperatures()[40], l.radiance(2), wedged(l).branches().map((b) => [b.flux, b.path.length]), tubed(l).length, tubed(l).branches().length, l.lavaEvent(8).skylights, isled(l).branches().map((b) => [b.stop, b.path.length]), burst(l)]);
  };
  // The same lava on a wedge it splits round, for the branch rows.
  // And a small flow on gentle ground fed for months, whose front tubes feed on, for the run-on rows.
  const tubed = (l) => new LavaFlow({ ...l.options, ground: slope(Math.tan(Math.PI / 180)), effusionRate: 1, width: 4, maxWidth: 4, rise: 1, duration: 1e7, wander: 0, maxLength: 60000, step: 10 });
  const wedged = (l) => new LavaFlow({ ...l.options, ground: (x, z) => 1000 - 0.05 * z + Math.max(0, 0.3 * (z - 200) - 0.6 * Math.abs(x)), wander: 0 });
  // The flow parting round an island in a valley and meeting below it, for the join row.
  const isled = (l) => new LavaFlow({ ...l.options, vent: [0, diamond(0, 0), 0], ground: diamond, wander: 0, maxLength: 20000 });
  const base = make({});
  for (const row of LAVA_SETTINGS) {
    const d = row.default ?? row.min,
      v = d === row.max ? row.min : Math.min(row.max, d === 0 ? row.max / 4 : d * (d < row.max / 2 ? 2 : 0.5));
    const special = { emissivity: 0.6, stopGraetz: 3000, start: 100, duration: 300, timeScale: 2, airTemperature: 250, maxLength: 800, temperature: 1373, crustTemperature: 1300, solidus: 1200, bombLife: 20, rise: 20, wane: 20, maxWidth: 20, branchShare: 1, maxBranches: 0, tubeTime: 60, tubeSlope: 2, maxRunOns: 0 };
    const value = row.default === null ? row.max / 4 : (special[row.name] ?? v);
    assert.notEqual(make({ [row.name]: value }), base, `${row.name} = ${value} changes nothing`);
  }
  assert.equal(Object.keys(lavaSettingDefaults()).length, LAVA_SETTINGS.length);
  const l = new LavaFlow({ weather });
  applyLavaSettings(l, LAVA_LOOKS.hawaiian);
  assert.equal(l.options.effusionRate, 100);
  assert.deepEqual(l.windNow().map(Math.round), [0, 6], 'null follows the weather');
  applyLavaSettings(l, { wind: 2, windDirection: 90 });
  assert.deepEqual(l.windNow().map(Math.round), [2, 0], 'a value overrides it');
  assert.equal(lavaSettingValues(l).wind, 2);
  assert.throws(() => applyLavaSettings(l, { nope: 1 }), TypeError);
  assert.throws(() => applyLavaSettings(l, { effusionRate: -5 }), RangeError);
  for (const look of Object.values(LAVA_LOOKS)) assert.doesNotThrow(() => applyLavaSettings(new LavaFlow(), look));
});

test('a new ground, or invalidate() after the same ground changed, solves the path again', () => {
  let grade = 0.05;
  const lava = new LavaFlow({ ground: (x, z) => 1000 - grade * z, maxLength: 500 }),
    first = lava.path()[10].speed;
  grade = 0.2;
  assert.equal(lava.path()[10].speed, first, 'cached until told');
  lava.invalidate();
  assert.ok(lava.path()[10].speed > first, 'steeper ground, faster lava');
  lava.options.ground = slope(0.01);
  assert.ok(lava.path()[10].speed < first, 'a new ground function is seen');
});

test('options are checked', () => {
  assert.throws(() => new LavaFlow({ effusionRate: 0 }), RangeError);
  assert.throws(() => new LavaFlow({ vent: [0, 0] }), RangeError);
  assert.throws(() => new LavaFlow({ ground: 5 }), TypeError);
  assert.throws(() => new LavaFlow({ solidus: 1500, temperature: 1400 }), RangeError);
  assert.throws(() => new LavaFlow({ seed: 1.5 }), RangeError);
  assert.throws(() => new LavaFlow({ maxLights: 2.5 }), RangeError);
  assert.throws(() => validateLava(null), TypeError);
  assert.doesNotThrow(() => new LavaFlow({ ground: { height: () => undefined } }));
});

// ---- Row 24 built out: FLOWGO's heat budget, widening, the Graetz number as written, the core after the vent stops. ----
const ground = (degrees) => (x, z) => 1000 - Math.tan((degrees * Math.PI) / 180) * z;

test("flow lengths fit mapped flows: Mauna Loa 1984, Pu'u O'o 1997, Etna 1998 and the Etna length law", () => {
  // Harris and Rowland 2001 (FLOWGO, Bull. Volcanol. 63) give the inputs and mapped lengths of three channels: Mauna Loa
  // 1984 at 400 m^3/s (25 to 27 km), Pu'u O'o 16 May 1997 at about 30 m^3/s (4 km), Etna 1998 at 6 to 8.4 m^3/s (755 m).
  // Literature scatter for one effusion rate is up to 7 times (Harris and Rowland 2009), so each must land within 2 times.
  const mapped = [
    [{ effusionRate: 400, width: 31, temperature: 1413, ground: (x, z) => 1000 - Math.tan(0.105) * Math.min(z, 1e4) - Math.tan(0.061) * Math.max(z - 1e4, 0) }, 26000],
    // 2 to 10 degree slopes (Cashman et al. 1999): 10 degrees off the cone's flank, then 5, then 2.
    [{ effusionRate: 30, width: 8, temperature: 1420, ground: (x, z) => 1000 - 0.176 * Math.min(z, 1000) - 0.087 * Math.min(Math.max(z - 1000, 0), 1000) - 0.035 * Math.max(z - 2000, 0) }, 4000],
    [{ effusionRate: 7, width: 20, temperature: 1360, ground: ground(10) }, 755],
  ];
  for (const [options, metres] of mapped) {
    const lava = new LavaFlow({ ...options, wander: 0, step: 20, maxLength: 80000 });
    assert.equal(lava.stop, 'cooled');
    assert.ok(lava.length > metres / 2 && lava.length < metres * 2, `${options.effusionRate} m^3/s ran ${lava.length} m, mapped ${metres} m`);
  }
  // Calvari and Pinkerton 1998, 17 simple Etna 'a'a flows: L = 10^3.11 TADR^0.47 metres (R^2 0.86).
  const etna = [1, 2.5, 8, 30].map((q, i) => new LavaFlow({ effusionRate: q, width: [3, 5, 10, 20][i], temperature: 1360, viscosity: 1000, ground: ground(5), wander: 0, step: 10, maxLength: 80000 }).length);
  etna.forEach((L, i) => {
    const law = 10 ** 3.11 * [1, 2.5, 8, 30][i] ** 0.47;
    assert.ok(L > law / 2 && L < law * 2, `Etna ${[1, 2.5, 8, 30][i]} m^3/s: ${L} m against ${law} m`);
  });
  const exponent = Math.log(etna[3] / etna[0]) / Math.log(30);
  assert.ok(Math.abs(exponent - 0.47) < 0.1, `length grows as TADR^${exponent}`);
});

test('the channel widens as it slows and keeps its mass: Q = w d u (Harris and Rowland 2001, eq. 1)', () => {
  // 10 degrees for 300 m, then a flat of 1 degree: the sheet keeps its depth and spreads where the slope breaks.
  const broken = (x, z) => 1000 - 0.176 * Math.min(z, 300) - 0.0175 * Math.max(z - 300, 0),
    lava = new LavaFlow({ effusionRate: 20, ground: broken, wander: 0, step: 10 }),
    fixed = new LavaFlow({ effusionRate: 20, ground: broken, wander: 0, step: 10, maxWidth: 12 });
  for (const flow of [lava, fixed])
    for (const p of flow.path().slice(1)) assert.ok(Math.abs(p.width * p.thickness * p.speed - 20) < 0.02, `w d u = ${p.width * p.thickness * p.speed}`);
  const at = (s) => lava.path().find((p) => p.distance >= s);
  assert.ok(at(330).width > 3 * at(270).width, `${at(270).width} m on the steep, ${at(330).width} m on the flat`);
  assert.ok(at(330).thickness === at(270).thickness, 'it keeps its depth');
  assert.ok(fixed.path().every((p) => p.width === 12), 'maxWidth at the vent width keeps one width');
  assert.ok(fixed.path().find((p) => p.distance >= 330).thickness > at(330).thickness, 'one width thickens instead');
  assert.ok(lava.path().every((p) => p.width <= 1000));
});

test('the crust breaks open with speed (FLOWGO eq. 8) and the base conducts heat to the ground', () => {
  // At 2 m/s the crust covers 0.9 exp(-0.32) = 0.65 of the surface, as Flynn and Mouginis-Mark measured (0.4 to 0.8),
  // less the default 5 percent of cracks in it.
  const fast = new LavaFlow({ effusionRate: 300, width: 30, ground: ground(8), wander: 0, crackTime: 1 }),
    i = fast.path().findIndex((p) => p.speed > 1.9 && p.speed < 2.1),
    t = fast.arrival(i) + 600;
  assert.ok(i > 0, 'a point moving at 2 m/s');
  assert.ok(Math.abs(fast.crackShare(i, t) - (1 - 0.95 * 0.9 * Math.exp(-0.16 * fast.path()[i].speed))) < 1e-6);
  assert.ok(fast.crackShare(i, t) > 0.3 && fast.crackShare(i, t) < 0.4);
  // A thicker basal crust insulates the core from the ground: the flow runs further (FLOWGO's Q_cond = k dT / H_b).
  const thin = new LavaFlow({ effusionRate: 10, ground: ground(5), wander: 0, baseCrust: 0.05 }).length,
    thick = new LavaFlow({ effusionRate: 10, ground: ground(5), wander: 0, baseCrust: 0.3 }).length;
  assert.ok(thick > thin, `${thick} m with a thick basal crust, ${thin} m with a thin one`);
  // Without the speed law and the hot offset the core cools less: the old budget ran several times too far.
  const old = new LavaFlow({ effusionRate: 30, width: 20, temperature: 1360, ground: ground(8), wander: 0, crackSpeed: 0, hotOffset: 0, baseCrust: 0.5, maxWidth: 20, step: 20, maxLength: 80000 }).length,
    now = new LavaFlow({ effusionRate: 30, width: 20, temperature: 1360, ground: ground(8), wander: 0, step: 20, maxLength: 80000 }).length;
  assert.ok(old > 1.5 * now, `old budget ${old} m, FLOWGO budget ${now} m`);
});

test('after the vent stops the core cools by conduction to the air and the ground, within the Stefan and Hon bounds', () => {
  const lava = new LavaFlow({ effusionRate: 5, ground: ground(3), wander: 0, duration: 600 }),
    i = 3,
    p = lava.path()[i],
    stopped = lava.end + p.travel;
  assert.equal(lava.coreTemperature(i, stopped), p.temperature, 'fed, the core keeps the path temperature');
  let prev = Infinity;
  for (const day of [0.5, 2, 5, 10, 20, 40]) {
    const T = lava.coreTemperature(i, stopped + day * 86400);
    assert.ok(T <= prev, 'it only cools');
    prev = T;
  }
  // A 2 m sheet: its middle falls below the crust isotherm (1,343 K) no sooner than a crust from the top, its surface
  // held at the air, reaches 1 m (Turcotte and Schubert 4-17, the package's Stefan solver), less 30 percent for the
  // latent heat spread over the melting range; no later than Hon et al. (1994) grow 2 m of crust from the top alone.
  const cross = (o) => {
    let d = 0;
    while (slabCore(o, 1423, 2, d * 86400) > 1343) d += 0.05;
    return d;
  };
  let stefan = 0;
  while (lava.stefanCrust(stefan * 86400) < 1) stefan += 0.05;
  const days = cross({}), hon = (2 / 0.0779) ** 2 / 24;
  assert.ok(days >= 0.7 * stefan && days <= hon, `core below 1,343 K after ${days} days (Stefan ${stefan}, Hon ${hon})`);
  // Ground that conducts better takes the heat faster.
  assert.ok(cross({ groundConductivity: 5 }) < days);
  // The glow follows the core: two weeks after the vent stops the cracks show nothing (the crust has closed).
  assert.ok(lava.radiance(i, stopped + 14 * 86400)[0] < lava.radiance(i, stopped)[0]);
});

test('a flow that ponds fills a pond on the GroundChange: its edge at pondRadius() and its volume what the vent fed', async () => {
  const { GroundChange } = await import('../../terrain/dist/ground-change.js');
  const lava = new LavaFlow({ vent: [0, 10, 0], effusionRate: 5, rise: 1, duration: 3000, wander: 0 }),
    ev = lava.lavaEvent();
  assert.equal(lava.stop, 'ponded');
  assert.ok(ev.pond && ev.pond.flux === 5 && ev.pond.end - ev.pond.start === lava.supplied(Infinity));
  const change = new GroundChange({ grid: { size: [300, 300], origin: [-150, -150], resolution: 151 }, events: [ev] });
  lava.seek(1001);
  const R = lava.pondRadius();
  assert.ok(change.sample(R * 0.98, 0, 1001).change > 0 && change.sample(R * 1.02, 0, 1001).change === 0, `pond edge at ${R} m`);
  assert.ok(change.sample(R * 0.95, 0, 1001).heat > 0.5 && change.sample(R * 0.95, 0, 1001).heat > change.sample(R * 0.2, 0, 1001).heat, 'the pond glows, brightest at its fresh edge');
  // No pond for a flow that runs on down a slope.
  assert.equal(new LavaFlow({ vent: [0, 1000, 0], ground: slope(0.05), rise: 1 }).lavaEvent().pond, undefined);
});

test("levees rise behind the front to Hulme's (1974) yield height of the cooling crust: higher on gentle slopes, never above leveeMax", async () => {
  // A weak crust (yieldRise 0.02) so the levees stand below their cap for a while.
  const opts = { rise: 1, wander: 0, yieldRise: 0.02, yieldStrength: 1, maxLength: 600 },
    gentle = new LavaFlow({ ...opts, vent: [0, 1000, 0], ground: slope(0.03) }),
    steep = new LavaFlow({ ...opts, vent: [0, 1000, 0], ground: slope(0.2) }),
    i = 20,
    ages = [0, 10, 60, 600, 3600, 86400];
  for (const lava of [gentle, steep]) {
    const p = lava.path()[i],
      t0 = lava.arrival(i);
    let last = 0;
    for (const a of ages) {
      const share = lava.leveeShare(i, t0 + a);
      assert.ok(share >= last - 1e-12 && share <= 0.35 + 1e-12, `levee share ${share} at age ${a} s (monotone, at most leveeMax)`);
      last = share;
    }
    // Hulme's h_c at the crust's mean temperature, as a share of the sheet.
    const Tm = 0.5 * (lava.surfaceTemperature(600) + Math.min(1343, p.temperature)),
      want = 0.35 * Math.min(1, lava.rheology(Tm)[1] / (2600 * G * p.slope * p.thickness));
    assert.ok(Math.abs(lava.leveeShare(i, t0 + 600) - want) < 1e-12, 'h_c = tau / (rho g sin)');
    assert.equal(lava.leveeShare(i, t0 - 1), 0, 'no levee before the front');
  }
  const mid = (lava) => lava.leveeShare(i, lava.arrival(i) + 600);
  assert.ok(mid(gentle) > mid(steep) * 1.5, `higher on a gentle slope: ${mid(gentle)} against ${mid(steep)}`);
  assert.ok(gentle.leveeShare(i, gentle.arrival(i) + 86400 * 30) > 0.3, 'a month on, the levee is near its cap');
  assert.throws(() => new LavaFlow({ leveeMax: 1.5 }), RangeError);
  // The event carries the levees as they stand, and GroundChange stands them over the sheet.
  const { GroundChange } = await import('../../terrain/dist/ground-change.js');
  const t = gentle.arrival(i) + 600,
    ev = gentle.lavaEvent(256, t);
  assert.ok(ev.levees.length === ev.path.length && Math.abs(ev.levees[i] - mid(gentle)) < 1e-12);
  const p = gentle.path()[i],
    ground = new GroundChange({ grid: { size: [200, 800], origin: [-100, -50], resolution: 401 }, events: [{ ...ev, roughness: 0 }] }),
    rim = ground.sample(p.position[0] + 0.82 * p.width / 2, p.position[2], t).change,
    middle = ground.sample(p.position[0], p.position[2], t).change;
  // At the levee crest (0.82 of the half width) the flat-topped sheet has fallen by 0.82^16 of its thickness.
  const want = (ev.levees[i] - 0.82 ** 16) * p.thickness;
  assert.ok(Math.abs(rim - middle - want) < 1e-3 * p.thickness, `levee ${rim - middle} m over the sheet, ${want} wanted`);
});

test('a ridge splits a flow (Dietterich and Cashman 2014): two arms either side, fluxes shared by the drops and summing to Q', () => {
  // A slope down +z with a wedge rising from z = 200 that the flow cannot overtop.
  const wedge = (x, z) => 1000 - 0.05 * z + Math.max(0, 0.3 * (z - 200) - 0.6 * Math.abs(x)),
    lava = new LavaFlow({ vent: [0, 1000, 0], ground: wedge, rise: 1, wander: 0, maxLength: 1500 }),
    arms = lava.branches();
  assert.ok(arms.length >= 2, `the flow splits: ${arms.length} arms`);
  const [trunk, arm] = arms,
    split = trunk.path[arm.at].position;
  assert.equal(arm.parent, 0);
  assert.ok(Math.abs(split[0]) < 6 && split[2] > 180 && split[2] < 215, `it splits at the wedge's tip: ${split}`);
  // By symmetry the drops either side are equal: half the flux each way.
  assert.ok(Math.abs(arm.flux - 10) < 1e-9, `the branch carries ${arm.flux} of 20 m^3/s`);
  const ends = (k) => arms.reduce((f, b) => (b.parent === k ? f - b.flux : f), arms[k].flux),
    total = arms.reduce((sum, _, k) => sum + ends(k), 0);
  assert.ok(Math.abs(total - 20) < 1e-9, `the arms' fluxes sum to Q: ${total}`);
  const sideOf = (b) => Math.sign(b.path[b.path.length - 1].position[0]);
  assert.ok(sideOf(trunk) * sideOf(arm) < 0, 'the arms run down either side of the wedge');
  // Each arm is its own ground event; a split flow runs shorter than a single channel (Dietterich and Cashman 2014).
  const events = lava.lavaEvents();
  assert.equal(events.length, arms.length);
  assert.ok(events[1].arrival[0] >= events[0].arrival[0] && events[1].path.length >= 2);
  const single = new LavaFlow({ ...lava.options, branchShare: 1 });
  assert.equal(single.branches().length, 1, 'branchShare 1 keeps one channel');
  assert.equal(new LavaFlow({ ...lava.options, maxBranches: 0 }).branches().length, 1, 'maxBranches 0 keeps one channel');
  // An even slope and a cone never split.
  assert.equal(new LavaFlow({ vent: [0, 1000, 0], ground: slope(0.05), rise: 1 }).branches().length, 1);
  assert.equal(new LavaFlow({ vent: [0, 1000, 0], ground: (x, z) => 1000 - 0.1 * Math.hypot(x, z), rise: 1, maxLength: 3000 }).branches().length, 1);
  assert.throws(() => new LavaFlow({ maxBranches: 1.5 }), RangeError);
});

test("a channel on gentle ground roofs into a tube: about 1 K/km inside (Keszthelyi 1995; Helz et al. 2003), several in the open", () => {
  // Kupaianaha-like: 4 m^3/s down 3 degrees, a 4 m channel, fed for months.
  const grade = Math.tan((3 * Math.PI) / 180),
    lava = new LavaFlow({ vent: [0, 1000, 0], ground: slope(grade), effusionRate: 4, width: 4, maxWidth: 4, rise: 1, duration: 1e7, wander: 0, maxLength: 12000 }),
    p = lava.path(),
    tube = lava.tubeTemperatures(),
    km = (i, j) => (p[j].distance - p[i].distance) / 1000,
    i0 = Math.floor(p.length * 0.2),
    i1 = p.length - 1;
  assert.ok(km(i0, i1) > 1, `a long enough path: ${km(i0, i1)} km`);
  const inside = (tube[i0] - tube[i1]) / km(i0, i1),
    open = (p[i0].temperature - p[i1].temperature) / km(i0, i1);
  assert.ok(inside > 0.3 && inside < 2, `tube cooling ${inside} K/km (Helz et al. 0.6, Keszthelyi about 1)`);
  assert.ok(open > 3 * inside, `the open channel cools faster: ${open} against ${inside} K/km`);
  // The roof closes tubeTime after the front passes and only while fed; the core inside is the tube's.
  const i = Math.floor(p.length / 2),
    roof = lava.roofTime(i);
  assert.ok(Math.abs(roof - (lava.arrival(i) + 86400)) < 1e-6, `roofed a day after the front: ${roof}`);
  assert.equal(lava.tubed(i, roof - 1), false);
  assert.ok(lava.tubed(i, roof) && lava.crackShare(i, roof) === 0, 'roofed over: no hot cracks show');
  assert.equal(lava.coreTemperature(i, roof + 10), tube[i]);
  assert.ok(lava.coreTemperature(i, roof + 10) > lava.coreTemperature(i, roof - 10), 'the tube keeps the core hotter');
  // Steep ground or tubeSlope 0 never roofs; a vent that stops before tubeTime never roofs.
  assert.equal(new LavaFlow({ ...lava.options, tubeSlope: 0 }).roofTime(i), Infinity);
  assert.equal(new LavaFlow({ ...lava.options, tubeSlope: 2 }).roofTime(i), Infinity);
  assert.equal(new LavaFlow({ ...lava.options, duration: 3600 }).roofTime(i), Infinity);
  assert.throws(() => new LavaFlow({ tubeTime: 10 }), RangeError);
});

test('a tube-fed front runs on past where the open channel stopped (Keszthelyi 1995; Calvari and Pinkerton 1998)', () => {
  // 1 m^3/s down 1 degree in a 4 m channel, fed for months: the open channel cools to a stop in about 7 km.
  const options = { vent: [0, 1000, 0], ground: slope(Math.tan(Math.PI / 180)), effusionRate: 1, width: 4, maxWidth: 4, rise: 1, duration: 1e7, wander: 0, maxLength: 60000, step: 10 },
    lava = new LavaFlow(options),
    open = new LavaFlow({ ...options, tubeSlope: 0 }),
    p = lava.path(),
    q = open.path();
  assert.equal(open.stop, 'cooled');
  assert.ok(lava.length > 3 * open.length, `tube-fed ${lava.length} m against open ${open.length} m`);
  // The first leg is the open channel's own; the front waits at its stop until the last roof behind it closes.
  const j = p.findIndex((x, i) => i > 0 && x.distance === p[i - 1].distance);
  assert.equal(j, q.length, 'the run-on starts at the open channel stop');
  for (let i = 0; i < j; i++) assert.equal(p[i].temperature, q[i].temperature);
  let roofed = j - 1;
  while (lava.roofTime(roofed) === Infinity) roofed--;
  assert.ok(Math.abs(lava.arrival(j) - lava.roofTime(roofed)) < 1e-6, `it waits for the roof: ${lava.arrival(j)} against ${lava.roofTime(roofed)}`);
  const waiting = lava.front((lava.arrival(j - 1) + lava.arrival(j)) / 2);
  assert.ok(waiting.distance === p[j].distance && waiting.speed === 0 && waiting.stop === 'cooled', JSON.stringify(waiting));
  assert.ok(lava.front(lava.arrival(j) + 3600).distance > p[j].distance + 100, 'then it flows on');
  // The tube's lava comes out at the tube's temperature, hotter than the open channel brought it, with a fresh surface.
  const tube = lava.tubeTemperatures();
  assert.equal(p[j].temperature, tube[j - 1]);
  assert.ok(p[j].temperature > q[j - 1].temperature + 20 && p[j].opened === p[j].travel && p[j].wait > 0);
  assert.equal(lava.surfaceAge(j, lava.arrival(j)), 0, 'the lava out of the tube is fresh');
  // Each leg out of a mouth is no longer than the open channel from the vent, hotter lava and all.
  const mouths = [0, ...p.flatMap((x, i) => (i > 0 && x.wait !== p[i - 1].wait ? [i] : [])), p.length];
  assert.ok(mouths.length > 3, `several run-ons: ${mouths.length - 2}`);
  for (let k = 0; k + 1 < mouths.length; k++) {
    const leg = p[mouths[k + 1] - 1].distance - p[mouths[k]].distance;
    assert.ok(leg <= open.length + 10, `leg ${k}: ${leg} m`);
  }
  // A vent that stops before the roofs close never feeds it on, nor does maxRunOns 0; seek and steps agree.
  assert.equal(new LavaFlow({ ...options, duration: 86400 }).length, open.length);
  assert.equal(new LavaFlow({ ...options, maxRunOns: 0 }).length, open.length);
  assert.equal(new LavaFlow({ ...options, maxRunOns: 1 }).path().length, mouths[2]);
  assert.throws(() => new LavaFlow({ maxRunOns: 1.5 }), RangeError);
  const stepped = new LavaFlow(options),
    t = lava.arrival(j) + 7200;
  for (let k = 0; k < 40; k++) stepped.update(t / 40);
  stepped.seek(t);
  lava.seek(t);
  assert.equal(JSON.stringify([stepped.front(), stepped.lavaEvents(64)]), JSON.stringify([lava.front(), lava.lavaEvents(64)]));
  const event = lava.lavaEvent(64),
    at = event.path.findIndex((x, i) => i > 0 && x[0] === event.path[i - 1][0] && x[1] === event.path[i - 1][1]);
  assert.ok(at > 0 && event.arrival[at] > event.arrival[at - 1], 'the ground event holds the stop while the front waits');
});

test('the ground event carries the tube roofs, when each tube drains and the skylight spacing (Kauahikaua et al. 1998)', async () => {
  const { GroundChange } = await import('../../terrain/dist/ground-change.js');
  const grade = Math.tan((3 * Math.PI) / 180),
    lava = new LavaFlow({ vent: [0, 1000, 0], ground: slope(grade), effusionRate: 4, width: 4, maxWidth: 4, rise: 1, duration: 1e6, wane: 300, wander: 0, maxLength: 6000 }),
    p = lava.path(),
    event = lava.lavaEvent(p.length + 1);
  assert.equal(event.roofs.length, event.path.length);
  assert.equal(event.drains.length, event.path.length);
  assert.equal(event.skylights, 200);
  for (let i = 0; i < event.path.length; i++) {
    assert.equal(event.roofs[i], Math.min(lava.roofTime(i), 1e9));
    assert.ok(Math.abs(event.drains[i] - (lava.end + p[i].travel - p[i].wait)) < 1e-6, `drains at ${i}`);
  }
  const i = Math.floor(p.length / 2);
  assert.ok(event.roofs[i] < 1e9 && event.drains[i] > event.roofs[i], 'mid-path roofs while fed, and drains after');
  assert.equal(new LavaFlow({ ...lava.options, skylightSpacing: 0 }).lavaEvent(8).skylights, 0);
  assert.throws(() => new LavaFlow({ skylightSpacing: -1 }), RangeError);
  // The ground draws it: dark under the closed roof, fresh through a skylight, crusted once drained.
  const change = new GroundChange({ grid: { size: [100, 100], origin: [-50, -50], resolution: 8 }, events: [event] }),
    roofed = event.roofs[i],
    z = p[i].position[2];
  let open = 0,
    dark = 0;
  for (let s = z - 400; s < z + 400; s += 1) {
    const heat = change.sample(0, s, roofed + 3600).heat;
    if (heat > 0.5) open++;
    else if (heat === 0) dark++;
  }
  assert.ok(dark > 600 && open > 3, `a roofed tube: ${dark} m dark, ${open} m under skylights`);
  let after = 0;
  for (let s = z - 400; s < z + 400; s += 1) after = Math.max(after, change.sample(0, s, event.drains[i] + 1e5).heat);
  assert.ok(after < 0.05, `drained skylights crust over: ${after}`);
});

// A diamond island in a shallow valley: the flow parts round its upper tip and the valley brings the arms back together
// below its lower tip.
const diamond = (x, z) => 1000 - 0.05 * z + 0.03 * Math.abs(x) + Math.max(0, 30 - 0.4 * (Math.abs(x) + Math.abs(z - 300)));
test('arms that part round an island run together again below it (Dietterich and Cashman 2014)', () => {
  const options = { vent: [0, diamond(0, 0), 0], ground: diamond, wander: 0, maxLength: 20000, duration: 7200 },
    lava = new LavaFlow(options),
    apart = new LavaFlow({ ...options, joinDistance: 0 }),
    arms = lava.branches(),
    joined = arms.filter((b) => b.stop === 'joined');
  assert.ok(apart.branches().length >= 2 && apart.branches().every((b) => b.stop !== 'joined'), 'joinDistance 0: the arms never meet');
  assert.ok(joined.length >= 1, `an arm runs into the other: ${JSON.stringify(arms.map((b) => [b.parent, b.at, b.stop, b.joins]))}`);
  for (const b of joined) {
    const into = arms[b.joins.arm].path[b.joins.at],
      end = b.path.at(-1);
    assert.ok(into.position[2] > 300 + 75 - 1, `they meet below the island: z ${into.position[2]}`);
    assert.ok(Math.hypot(into.position[0] - end.position[0], into.position[2] - end.position[2]) <= (into.width + end.width) / 2 + 1e-9, 'within their half-widths summed');
  }
  // The arm that carries both runs on further than either arm apart, and thicker or wider with both fluxes.
  const longest = (f) => Math.max(...f.branches().map((b) => b.path.at(-1).distance));
  assert.ok(longest(lava) > longest(apart), `merged ${longest(lava)} m against ${longest(apart)} m apart`);
  // Every drop of lava ends somewhere: the arms that do not join carry the effusion rate between them.
  const q = lava.options.effusionRate ?? 20,
    ends = arms.flatMap((b, k) => (b.stop === 'joined' ? [] : [lava.endFlux(k)]));
  assert.ok(Math.abs(ends.reduce((a, b) => a + b, 0) - q) < 1e-9 * q, `end fluxes ${ends} sum to ${q}`);
  assert.equal(apart.branches().reduce((f, _, k) => f + apart.endFlux(k), 0).toFixed(9), q.toFixed(9));
  // The lava past the join is the mix: its flux both arms', its temperature between theirs, weighted by flux.
  const [b] = joined,
    receiver = arms[b.joins.arm],
    at = receiver.path[b.joins.at];
  assert.ok(at.temperature <= Math.max(b.path.at(-1).temperature, receiver.path[b.joins.at - 1].temperature) + 1e-9);
  // A seek and steps give the same lava; the ground events stay valid.
  const stepped = new LavaFlow(options),
    t = 5400;
  for (let k = 0; k < 30; k++) stepped.update(t / 30);
  stepped.seek(t);
  lava.seek(t);
  assert.equal(JSON.stringify([stepped.branches(), stepped.lavaEvents(64)]), JSON.stringify([lava.branches(), lava.lavaEvents(64)]));
  assert.throws(() => new LavaFlow({ joinDistance: 5 }), RangeError);
  assert.throws(() => lava.endFlux(99), RangeError);
});

test('arms that come alongside each other under their levees run side by side, braided (Dietterich and Cashman 2014)', () => {
  // A ridge parts the flow into two valleys that close in below z = 300 to two troughs 11 m apart, narrower than the
  // 12 m channels: the arms come alongside each other at a shallow angle.
  const c = (z) => (z < 300 ? 60 : Math.max(5.5, 60 - 0.15 * (z - 300))),
    ground = (x, z) => 1000 - 0.05 * z + 0.1 * Math.abs(Math.abs(x) - c(z)),
    options = { vent: [0, ground(0, 0), 0], ground, wander: 0, width: 12, maxWidth: 12, maxLength: 2500, duration: 7200 },
    lava = new LavaFlow(options),
    arms = lava.branches(),
    bare = new LavaFlow({ ...options, leveeMax: 0 }).branches();
  // Without levees the second arm runs into the first and ends there; with them both run on to the end.
  assert.ok(bare.some((b) => b.stop === 'joined'), `no levees: ${bare.map((b) => b.stop)}`);
  assert.equal(arms.length, 2);
  assert.ok(arms.every((b) => b.stop !== 'joined' && b.path.at(-1).distance > 2400), `braided: ${arms.map((b) => [b.stop, b.path.at(-1).distance])}`);
  // Side by side: over more than a kilometre the second arm's edge stays within 2 m of the first's, never more than
  // half a step over it.
  const [a, b] = arms,
    gap = (p) => Math.min(...a.path.map((q) => Math.hypot(q.position[0] - p.position[0], q.position[2] - p.position[2]) - (q.width + p.width) / 2)),
    beside = b.path.filter((p) => p.position[2] > 800).map(gap);
  assert.ok(beside.length * 5 > 1000 && beside.every((g) => g > -0.6 && g < 2), `edges ${Math.min(...beside)} to ${Math.max(...beside)} m apart`);
  assert.ok(Math.sign(a.path.at(-1).position[0]) * Math.sign(b.path.at(-1).position[0]) < 0, 'each in its own trough');
  // Each carries its own lava to its end: the end fluxes sum to the effusion rate.
  assert.ok(Math.abs(lava.endFlux(0) + lava.endFlux(1) - 20) < 1e-9);
});

test('a stalled, still-fed front inflates and breaks out through its levee as a new arm (Hon et al. 1994)', () => {
  // 1 m^3/s down 1 degree in a 4 m channel, the ground falling away to +x across it, no tubes: the open channel cools
  // to a stop in about 7 km while the vent feeds it for months.
  const ground = (x, z) => 1000 - Math.tan(Math.PI / 180) * z - 0.02 * x,
    options = { vent: [0, ground(0, 0), 0], ground, effusionRate: 1, width: 4, maxWidth: 4, rise: 1, duration: 1e7, wander: 0, maxLength: 60000, step: 10, tubeSlope: 0 },
    still = new LavaFlow(options),
    lava = new LavaFlow({ ...options, breakoutHeight: 2 }),
    arms = lava.branches(),
    trunk = arms[0],
    out = arms.findIndex((b) => b.breakout);
  assert.equal(still.branches().length, 1, 'breakoutHeight 0: the front just stops');
  assert.deepEqual(trunk.path, still.path(), 'the stalled arm is the same lava up to its stop');
  assert.equal(trunk.stop, 'cooled');
  assert.ok(out > 0 && arms[out].parent === 0, `a breakout arm: ${JSON.stringify(arms.map((b) => [b.parent, b.at, b.stop, b.breakout]))}`);
  const b = arms[out],
    p = trunk.path,
    start = b.path[0],
    at = p[b.at];
  // It leaves on the low side, one width out, from the sluggish stretch behind the front.
  const [sx, , sz] = start.position,
    [ax, , az] = at.position;
  assert.ok(Math.abs(Math.hypot(sx - ax, sz - az) - at.width) < 1e-9, 'one width out');
  assert.ok(ground(sx, sz) < ground(2 * ax - sx, 2 * az - sz), `on the low side: ${ground(sx, sz)} against ${ground(2 * ax - sx, 2 * az - sz)}`);
  assert.ok(at.graetz < 2 * 300, `from the stalled stretch: Graetz ${at.graetz}`);
  // When: the supply lifting the stalled stretch by 2 m (Q t / area), after the front stopped.
  let m = p.length - 1;
  while (m > 0 && p[m - 1].graetz < 600) m--;
  let area = 0;
  for (let i = m; i + 1 < p.length; i++) area += 0.5 * (p[i].width + p[i + 1].width) * (p[i + 1].distance - p[i].distance);
  const end = p.at(-1);
  assert.ok(Math.abs(start.travel - (end.travel + (2 * area) / 1)) < 1e-6, `opens after ${start.travel - end.travel} s of inflation`);
  assert.ok(Math.abs(lava.arrival(p.length - 1, 0) - still.arrival(p.length - 1)) < 1e-9);
  // Its lava is the fluid core fed under the inflated crust (Hon et al. 1994), not the stalled lava: hotter than the
  // stalled core where it leaves, no hotter than the channel's core at the head of the stretch, and losing far less per
  // km under the crust than the open channel did (a tube-like path: Keszthelyi 1995 about 1 K/km, Helz et al. 2003 0.6
  // K/km at several m^3/s; at 1 m^3/s more, but well under the open channel's).
  const head = p[m],
    openLoss = (p[0].temperature - end.temperature) / (end.distance / 1000),
    coveredLoss = (head.temperature - start.temperature) / ((at.distance - head.distance) / 1000);
  assert.ok(start.temperature > at.temperature + 5, `breakout core ${start.temperature} K against the stalled ${at.temperature} K`);
  assert.ok(start.temperature <= head.temperature, `no hotter than the head of the stretch, ${head.temperature} K`);
  assert.ok(coveredLoss >= 0 && coveredLoss < 0.5 * openLoss, `under the crust ${coveredLoss} K/km against ${openLoss} K/km open`);
  // It runs as far as published breakout lobes: on Kilauea's June 27th flow a lobe that broke out 700 m behind the
  // stalled tip advanced about 350 m in two days and about 45 m a day for a week more before it stalled, some 0.7 to
  // 0.8 km (USGS HVO, January 2015; Poland et al. 2016); inflated sheet lobes run hundreds of metres (Hon et al.
  // 1994). The stalled core alone ran 450 m.
  const lobe = b.path.at(-1).distance - start.distance;
  assert.ok(lobe >= 500 && lobe <= 2500, `the breakout runs ${lobe} m`);
  assert.ok(Math.abs(lava.endFlux(0)) < 1e-12 && Math.abs(lava.endFlux(out) - 1) < 1e-12, 'the stalled arm passes nothing on');
  // The tube feeds the front on first when it roofs sooner than the flow inflates (roofs closing two hours after the
  // front passes); a taller breakout waits longer.
  const tubed = new LavaFlow({ ...options, tubeSlope: 4, tubeTime: 7200, breakoutHeight: 20 }),
    open = new LavaFlow({ ...options, tubeSlope: 4, tubeTime: 7200 });
  // A tube that roofs first wins: the run-ons as before, past the open channel's stop (a later stall, its core still
  // fed hot under the crust, may break out before the next roof closes).
  const tp = tubed.path();
  assert.equal(JSON.stringify(tp), JSON.stringify(open.path().slice(0, tp.length)), 'the run-on as before');
  assert.ok(tp.at(-1).distance > p.at(-1).distance + 1000, `tube-fed on to ${tp.at(-1).distance} m`);
  assert.ok(tubed.branches().every((x) => !x.breakout || x.path[0].travel > end.travel), 'no breakout before the run-on');
  assert.ok(new LavaFlow({ ...options, breakoutHeight: 4 }).branches().find((x) => x.breakout).path[0].travel > start.travel);
  // A seek and steps agree; the events stay valid.
  const stepped = new LavaFlow({ ...options, breakoutHeight: 2 }),
    t = lava.supplyTime(start.travel) + 3600;
  for (let k = 0; k < 40; k++) stepped.update(t / 40);
  stepped.seek(t);
  lava.seek(t);
  assert.equal(JSON.stringify([stepped.branches(), stepped.lavaEvents(64)]), JSON.stringify([lava.branches(), lava.lavaEvents(64)]));
  assert.throws(() => new LavaFlow({ breakoutHeight: 21 }), RangeError);
});

test('a stalled front blocks the tube behind it: the backed-up lava bursts a roof upstream (Kauahikaua et al. 1998)', () => {
  // The same flow with its gentle stretches roofing into tubes and a levee that holds 20 m: when the front stalls, the
  // supply backs up the tube; the level rises over the front's top as the sluggish stretch lifts, and the first closed
  // roof whose weight and strength (rho g d + 2 sigma d^2 / w^2) the lava's head beats bursts.
  const ground = (x, z) => 1000 - Math.tan(Math.PI / 180) * z - 0.02 * x,
    options = { vent: [0, 1000, 0], ground, effusionRate: 1, width: 4, maxWidth: 4, rise: 1, duration: 1e7, wander: 0, maxLength: 60000, step: 10, breakoutHeight: 20 },
    lava = new LavaFlow(options),
    arms = lava.branches(),
    p = arms[0].path,
    end = p.at(-1),
    b = arms[1],
    at = p[b.at],
    start = b.path[0];
  assert.ok(b.breakout && b.parent === 0, `a breakout off the stalled trunk: ${JSON.stringify(arms.map((a) => [a.parent, a.at, a.breakout]))}`);
  // Through a roof closed by then, upstream of the front: on Kilauea's June 27th flow lobes broke out 0.7 and 2 km
  // behind the stalled tip (USGS HVO, January 2015).
  const burst = lava.supplyTime(start.travel);
  assert.ok(lava.roofTime(b.at) <= burst, `roofed at ${lava.roofTime(b.at)} s, burst at ${burst} s`);
  const behind = end.distance - at.distance;
  assert.ok(behind >= 100 && behind <= 2000, `${behind} m behind the front`);
  // Its lava is the tube's, far hotter than the stalled front's, and it runs on as a lobe of kilometres.
  assert.equal(start.temperature, lava.tubeTemperatures(0)[b.at]);
  assert.ok(start.temperature > end.temperature + 50, `${start.temperature} K against ${end.temperature} K`);
  assert.ok(b.path.at(-1).distance - start.distance > 1000);
  // When: the lava's head over the roof equals what the roof holds, before the levee's 20 m.
  let m = p.length - 1;
  while (m > 0 && p[m - 1].graetz < 600) m--;
  let area = 0;
  for (let i = m; i + 1 < p.length; i++) area += 0.5 * (p[i].width + p[i + 1].width) * (p[i + 1].distance - p[i].distance);
  const rho = 2600,
    rise = ((start.travel - end.travel) * 1) / Math.max(area, end.width * end.width),
    pressure = rho * G * (end.position[1] + end.thickness + rise - (at.position[1] + at.thickness * 1.35)),
    d = lava.crustThickness(start.travel - at.travel),
    hold = rho * G * d + (2 * 1e6 * d * d) / (at.width * at.width);
  assert.ok(rise < 20, `the levee would hold to 20 m; the roof burst at ${rise} m`);
  assert.ok(Math.abs(pressure - hold) < 1e-6 * hold, `overpressure ${pressure} Pa against the roof's ${hold} Pa`);
  // Under the 0.2 to 1 MPa that bursts the thicker crusts of tumuli (Rossi and Gudmundsson 1996): a day-old roof.
  assert.ok(pressure > 1e3 && pressure < 1e6, `${pressure} Pa`);
  // A stronger roof holds longer; without breakouts the tube feeds the front on as before.
  const strong = new LavaFlow({ ...options, roofStrength: 1e7 }).branches()[1];
  assert.ok(strong.path[0].travel > start.travel, 'a stronger roof bursts later');
  assert.equal(JSON.stringify(new LavaFlow({ ...options, breakoutHeight: 0 }).path()), JSON.stringify(new LavaFlow({ ...options, breakoutHeight: 0, roofStrength: 1e5 }).path()));
  assert.throws(() => new LavaFlow({ roofStrength: 1e3 }), RangeError);
});

// EARTH-06: the crater a buried charge digs, against measured craters, and the CraterSolver's crater, rim and ejecta on the
// terrain bed: the bed's volume balances to rounding, the blanket spreads as Sedan's did, Fauld's crater and throw.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CRATER_GROUNDS, CraterSolver, craterSize } from '../dist/crater.js';
import { bedVertexAreas, bedVolume, TerrainBed } from '../dist/earth.js';
import { ExplosionSolver } from '../dist/explosive.js';
import { PhysicsWorld } from '../dist/world.js';

const TNT = 4.184e6,
  ft = 0.3048,
  lb = 0.4536,
  kt = 1e6;

test("a buried charge's crater by Holsapple and Housen's scaling and the burial fitted to Nevada's alluvium, against craters not fitted", () => {
  // [name, ground, W kg TNT, depth m, radius m, depth m] (Nordyke 1961, App. A and Table III; Nordyke and Williamson 1965;
  // Toman 1970, Table IV; Fielder and Guest 1968, Waltham 2001). The burial curves were fitted to the alluvium HE shots.
  const fitted = [
    ['256 lb at the surface', 'drySoil', 256 * lb, 0, 8.57 * ft, 2.49 * ft],
    ['Stagecoach 2', 'drySoil', 40000 * lb, 17.1 * ft, 50.5 * ft, 23.6 * ft],
    ['Stagecoach 3', 'drySoil', 40000 * lb, 34.2 * ft, 58.6 * ft, 29.2 * ft],
    ['Scooter', 'drySoil', 1e6 * lb, 125 * ft, 153.8 * ft, 74.5 * ft],
  ];
  // Not fitted: nuclear shots in alluvium (their radii 10 to 20 percent under an equal chemical charge's, Nordyke and
  // Williamson 1965), HE and nuclear shots in basalt and tuff, and Fauld's bomb store in mudstone (its radius the mean of
  // Fielder and Guest's 220 by 270 m survey).
  const held = [
    ['Jangle U', 'drySoil', 1.2 * kt, 17 * ft, 130 * ft],
    ['Teapot ESS', 'drySoil', 1.2 * kt, 67 * ft, 146 * ft],
    ['Sedan', 'drySoil', 100 * kt, 193.5, 185.3],
    ['Buckboard 11', 'hardRock', 40000 * lb, 25.5 * ft, 44.6 * ft],
    ['Buckboard 12', 'hardRock', 40000 * lb, 42.7 * ft, 57 * ft],
    ['Danny Boy', 'hardRock', 0.42 * kt, 33.5, 32.6],
    ['Schooner', 'hardRock', 31 * kt, 108, 130],
    ['Fauld', 'softRock', 2.42e6, 35, 122],
  ];
  // The tolerance: identical shots scatter by a factor of 2 in volume (H. F. Cooper 1976, section 1.2), 2^(1/3), 26
  // percent, in a length.
  for (const [name, ground, W, d, R, D] of fitted) {
    const c = craterSize(W * TNT, d, CRATER_GROUNDS[ground], 9.81);
    assert.ok(
      Math.abs(c.radius / R - 1) < 0.26 && Math.abs(c.depth / D - 1) < 0.26,
      `${name}: ${c.radius}, ${c.depth}`,
    );
  }
  for (const [name, ground, W, d, R] of held) {
    const c = craterSize(W * TNT, d, CRATER_GROUNDS[ground], 9.81);
    assert.ok(Math.abs(c.radius / R - 1) < 0.26, `${name}: radius ${c.radius} against ${R}`);
  }
  // Too deep, a mound and no crater (the 256 lb series made none past 26 ft, 1.63 m/kg^(1/3)).
  assert.equal(craterSize(256 * lb * TNT, 27 * ft, CRATER_GROUNDS.drySoil).volume, 0);
  // Gravity scaling: on the Moon the same charge digs wider, as the gravity regime of the scaling says.
  const earth = craterSize(1e6 * lb * TNT, 0, CRATER_GROUNDS.drySand, 9.81),
    moon = craterSize(1e6 * lb * TNT, 0, CRATER_GROUNDS.drySand, 1.62);
  assert.ok(moon.radius / earth.radius > 1.1, `${moon.radius} against ${earth.radius}`);
  // A paraboloid's volume, and the formation time 0.8 sqrt(V^(1/3) / g).
  const s = craterSize(1e6 * lb * TNT, 125 * ft, CRATER_GROUNDS.drySoil, 9.81);
  assert.ok(Math.abs(s.volume - (Math.PI * s.radius ** 2 * s.depth) / 2) < 1e-6 * s.volume);
  assert.ok(Math.abs(s.formation - 0.8 * Math.sqrt(Math.cbrt(s.volume) / 9.81)) < 1e-9);
  for (const bad of [
    () => craterSize(0, 1, CRATER_GROUNDS.drySoil),
    () => craterSize(1e9, -1, CRATER_GROUNDS.drySoil),
    () => craterSize(1e9, 1, { ...CRATER_GROUNDS.drySoil, mu: 1.2 }),
    () => craterSize(1e9, 1, { ...CRATER_GROUNDS.drySoil, ejected: 0.8, compaction: 0.4 }),
  ])
    assert.throws(bad, (e) => e.code === 'unsupported' && /errors#craters/.test(e.message));
});

/** A world with one charge, the terrain bed and the crater solver; runs until the crater is done. */
function blast({ mass, depth, shape, ground = CRATER_GROUNDS.drySoil, shells = 32 }) {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }),
    explosions = new ExplosionSolver(),
    bed = new TerrainBed(),
    crater = new CraterSolver();
  world.add(explosions, { charges: [{ position: [0, 0, 0], time: 0.1, mass, depth }] });
  world.add(bed, { ...shape, elevations: () => 0 });
  world.add(crater, { bed: shape, ground, shells });
  let frame = 0;
  while (crater.crater(0).state !== 'done' && frame < 60 * 300) world.advance((frame += 60));
  return { crater, bed, explosions, shape };
}

test('a crater solver digs the bowl, lifts the rim and lands the ejecta on the terrain bed, its volume balanced to rounding', () => {
  // Scooter: 1,000,000 lb of TNT 125 ft down in alluvium (measured 74,800 m^3, radius 46.9 m, depth 22.7 m).
  const { crater, bed, explosions, shape } = blast({
      mass: 1e6 * lb,
      depth: 125 * ft,
      shape: { columns: 160, rows: 160, width: 800, depth: 800, centre: [0, 0] },
    }),
    c = crater.crater(0),
    l = crater.ledgerTotals(),
    e = bed.elevations();
  assert.equal(c.state, 'done');
  assert.ok(Math.abs(c.volumes.dug / 74800 - 1) < 0.26, `dug ${c.volumes.dug}`);
  // dug = lifted + compacted + launched; launched = landed + left the bed; the bed's change = -dug + lifted + landed bulk.
  assert.ok(Math.abs(l.dug - (l.lifted + l.compacted + l.launched)) < 1e-9 * l.dug);
  assert.ok(Math.abs(l.launched - (l.landed + l.offBed)) < 1e-9 * l.dug);
  assert.ok(Math.abs(bedVolume(shape, e) - (-l.dug + l.lifted + l.landedBulk)) < 1e-9 * l.dug);
  // The bowl's deepest point is the crater's depth below the surface, and the rim stands above it.
  const centre = 80 + 161 * 80;
  assert.ok(Math.abs(-e[centre] / c.depth - 1) < 0.01, `${e[centre]} against ${c.depth}`);
  const rim = 80 + 161 * (80 + Math.ceil(c.radius / 5));
  assert.ok(e[rim] > 0, `rim ${e[rim]}`);
  // The ejecta's kinetic energy is a few percent of the ground's share of the charge's energy, never more.
  const share = c.kinetic / explosions.charge(0).ground;
  assert.ok(share > 0.005 && share < 0.1, `${share}`);
  // A charge in the air digs nothing.
  const air = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }),
    none = new CraterSolver();
  air.add(new ExplosionSolver(), { charges: [{ position: [0, 5, 0], time: 0.1, mass: 1000 }] });
  air.add(new TerrainBed(), { ...shape, elevations: () => 0 });
  air.add(none, { bed: shape });
  air.advance(60);
  assert.equal(none.crater(0).state, 'done');
  assert.equal(none.crater(0).volumes.dug, 0);
});

test("the ejecta blanket spreads as Sedan's did, and Fauld's crater throws over a million tonnes", () => {
  // Sedan: 100 kt at 193.5 m in alluvium. Measured (Nordyke and Williamson 1965): 50 percent of the ejecta within 2 crater
  // radii (the launch speed's calibration), 80 within 3 and 97 within 10. With the rim lifted by nothing (compaction 0.4),
  // what lies outside the crater is ejecta.
  const { crater, bed, shape } = blast({
      mass: 100 * kt,
      depth: 193.5,
      shape: { columns: 300, rows: 300, width: 6000, depth: 6000, centre: [0, 0] },
      ground: { ...CRATER_GROUNDS.drySoil, compaction: 0.4 },
      shells: 64,
    }),
    c = crater.crater(0),
    e = bed.elevations(),
    a = bedVertexAreas(shape),
    within = [0, 0, 0];
  let total = c.volumes.offBed;
  for (let col = 0; col <= 300; col++)
    for (let row = 0; row <= 300; row++) {
      const i = row + 301 * col,
        d = Math.hypot(-3000 + 20 * col, -3000 + 20 * row);
      if (d < c.radius || !(e[i] > 0)) continue;
      total += e[i] * a[i];
      [2, 3, 10].forEach((k, j) => {
        if (d < k * c.radius) within[j] += e[i] * a[i];
      });
    }
  const shares = within.map((w) => w / total);
  assert.ok(Math.abs(shares[0] - 0.5) < 0.05, `within 2 R: ${shares}`);
  assert.ok(Math.abs(shares[1] - 0.8) < 0.1 && Math.abs(shares[2] - 0.97) < 0.1, `within 3 and 10 R: ${shares}`);
  // Fauld (27 November 1944): 2,420 t of TNT about 35 m down in mudstone (Fielder and Guest; Waltham): "well over a
  // million tonnes" thrown out.
  const fauld = craterSize(2.42e6 * TNT, 35, CRATER_GROUNDS.softRock, 9.81),
    thrown = 0.6 * fauld.volume * CRATER_GROUNDS.softRock.density;
  assert.ok(thrown > 1e9 && thrown < 2e9, `${thrown / 1000} t`);
});

test('a crater solver refuses what it cannot dig in, coded', () => {
  const shape = { columns: 8, rows: 8, width: 80, depth: 80, centre: [0, 0] };
  for (const params of [
    {},
    { bed: shape, shells: 2 },
    { bed: shape, size: 20 },
    { bed: shape, ground: { ...CRATER_GROUNDS.drySoil, bulking: 0.5 } },
  ]) {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
    world.add(new ExplosionSolver(), { charges: [{ position: [0, 0, 0], mass: 10, depth: 1 }] });
    world.add(new TerrainBed(), { ...shape, elevations: () => 0 });
    assert.throws(
      () => world.add(new CraterSolver(), params),
      (e) => e.code === 'unsupported' && /errors#craters/.test(e.message),
    );
  }
});

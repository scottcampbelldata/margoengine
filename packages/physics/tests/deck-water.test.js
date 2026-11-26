// Green water on a hull's deck (FLUID-03, DeckWaterSolver): the water in a box riding a body. At rest on a level deck it
// loads the hull with its own weight, the hull solver's simplified quasi-static load, within the bound the grid sets;
// on a hull held heeled its surface lies level in the world, not in the box; the sea's inflow from the `deckInflow`
// port becomes the volume its flux brings; water over an open side goes to the sea as `seaSources()`; it claims its hull
// in `deckClaims`, so an exceedance solver that honours the claim leaves its own deck load out and the hull carries one
// load, not two. Slack water keeps its free surface: heeled, it moves to the low side and cuts the righting moment by
// rho g i tan(theta) (the free-surface correction of GM), and it sloshes at the tank's natural period.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { DeckWaterSolver } from '../dist/flip.js';
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_WORDS,
  DECK_CLAIMS_FIELD,
  DECK_INFLOW_FIELD,
  DECK_INFLOW_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  RigidSolver,
} from '../dist/world.js';

await Physics.load();
const G = 9.81,
  RHO = 1000;

/** A stand-in for the hull's exceedance solver: writes `deckInflow` and, unless a deck volume claims the hull, its own
 * simplified deck load (the weight of `held` m^3 of water), as the lane that owns it will. */
class Exceedance {
  // `claims`: whether a deck volume shares the world, so it reads `deckClaims` (a field must have its writer).
  constructor(records = () => [], held = 0, claims = true, row = 0) {
    this.id = 'exceedance';
    this.records = records;
    this.held = held;
    this.claims = claims;
    this.row = row;
  }
  describe() {
    return {
      id: this.id,
      fields: [
        { field: DECK_INFLOW_FIELD, access: 'write' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
        ...(this.claims ? [{ field: DECK_CLAIMS_FIELD, access: 'read' }] : []),
      ],
      rate: 0,
      stableRate: () => 0,
    };
  }
  init(host) {
    this.host = host;
    this.port = host.allocate('inflow', (1 + 8 * DECK_INFLOW_WORDS) * 8, 'f64', 1);
    this.forces = host.allocate('forces', (this.row + 1) * FORCE_WORDS * 8, 'f64', 1);
  }
  step(context) {
    const t = (context.tick + 0.5) / 60,
      rec = new Float64Array(this.host.memory.buffer, this.port.byteOffset, this.port.byteLength / 8),
      list = this.records(t);
    rec.fill(0);
    rec[0] = list.length;
    list.forEach((r, i) => rec.set([this.row, ...r, context.tick], 1 + i * DECK_INFLOW_WORDS));
    const claims = context.inputs.get(DECK_CLAIMS_FIELD.name),
      claimed =
        claims &&
        new Float64Array(this.host.memory.buffer, claims.region.byteOffset, claims.region.byteLength / 8)[this.row] ===
          1,
      out = new Float64Array(this.host.memory.buffer, this.forces.byteOffset, this.forces.byteLength / 8);
    out.fill(0);
    const held = typeof this.held === 'function' ? this.held() : this.held;
    if (!claimed) out[this.row * FORCE_WORDS + 1] = -RHO * G * held;
    this.claimed = claimed;
    this.load = out[this.row * FORCE_WORDS + 1];
  }
  exportPorts(tick) {
    return [
      { field: DECK_INFLOW_FIELD.name, region: this.port, tick, cell: [0, 0, 0] },
      { field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: [0, 0, 0] },
    ];
  }
  importPorts() {}
  stateRegions() {
    return [];
  }
  extraState() {
    return [];
  }
}

/** A fixed hull (no mass to move) with a 2 m by 1 m by 1 m deck box on it, cells of 0.1 m. */
function hull({ rotation = [0, 0, 0, 1], initial, exceedance, open, inflow = true } = {}) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    body = physics.addBody(null, {
      type: 'fixed',
      position: [0, 0, 0],
      rotation,
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5] },
    }),
    deck = new DeckWaterSolver('deckWater', { inflow }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(new RigidSolver(), { physics });
  if (exceedance) world.add(exceedance);
  world.add(deck, {
    row: body.row,
    offset: [-1, -0.5, -0.5],
    cells: [20, 10, 10],
    cellSize: 0.1,
    initial,
    ...(open ? { open } : {}),
  });
  return { physics, body, deck, world };
}

test("still water on a level deck loads the hull with its weight, the simplified load, within the grid's bound", () => {
  const depth = 0.3,
    { deck, world } = hull({ initial: (x, y) => y < depth, inflow: false });
  world.advance(90);
  const forces = deck['words'](deck['forcesRegion']),
    weight = (RHO * G * deck.count * 0.1 ** 3) / 8;
  // The weight the particles carry, and the load the pressure puts on the deck: equal to within the free surface's
  // place, half a cell of water over the deck's area.
  assert.ok(
    Math.abs(forces[1] + weight) <= RHO * G * 2 * 1 * 0.05,
    `load ${forces[1]} N against the weight ${-weight} N`,
  );
  assert.ok(Math.abs(forces[0]) < 1e-6 * weight && Math.abs(forces[2]) < 1e-6 * weight, 'no sideways load at rest');
});

test('on a hull held heeled 10 degrees the water lies level in the world', () => {
  const a = (10 * Math.PI) / 180,
    { deck, world } = hull({
      rotation: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)],
      initial: (x, y) => y < 0.4,
      inflow: false,
    });
  world.advance(240);
  // The surface's world height across the box (along z, which the heel tilts): the highest particle in each band.
  const pos = deck.positions(),
    bands = [-0.35, 0.35].map((zc) => {
      let top = -Infinity;
      for (let q = 0; q < pos.length; q += 3)
        if (Math.abs(pos[q + 2] - zc) < 0.1 && Math.abs(pos[q]) < 0.8) top = Math.max(top, pos[q + 1]);
      return top;
    });
  assert.ok(Math.abs(bands[0] - bands[1]) < 0.06, `the surface at ${bands} m, level to a cell or so`);
});

test("the sea's inflow becomes the volume its flux brings, and water over an open side goes to the sea", () => {
  // A 1 m segment along the deck's -z edge, 0.1 m of water coming in at 1 m/s: 0.1 m^3/s for the first second.
  const exceedance = new Exceedance((t) =>
      t < 1 ? [[-0.5, 0.05, -0.45, 0.5, 0.05, -0.45, 0, 0, 1, 0.1, 0, 0, 1, 0.1]] : [],
    ),
    { deck, world } = hull({ exceedance, open: ['+z'] });
  world.advance(30);
  // The deck reads the inflow a tick after it is written (each reads the other's field, so the coupling is staggered):
  // 29 of the 30 steps' inflow, to a particle.
  const inHalf = (deck.count * 0.1 ** 3) / 8;
  assert.ok(Math.abs(inHalf - (0.1 * 29) / 60) <= 0.1 ** 3 / 8 + 1e-12, `half a second brings ${inHalf} m^3`);
  let out = 0;
  for (let f = 31; f <= 240; f++) {
    world.advance(f);
    out += deck.seaSources().reduce((s, x) => s + x.volume, 0);
  }
  const left = (deck.count * 0.1 ** 3) / 8;
  assert.ok(out > 0, 'water went over the side');
  assert.ok(Math.abs(left + out - 0.1) <= (2 * 0.1 ** 3) / 8, `${left} m^3 on deck and ${out} gone, of 0.1`);
});

test('the deck volume claims its hull, so the hull carries one deck load, not two, and the same load', () => {
  // The exceedance solver's simplified quasi-static load is the weight of the water on deck. With the deck volume it
  // sees the claim and leaves its own out, and the deck volume's load is that weight within the grid's bound; without the
  // deck volume it carries the load itself.
  let water = 0;
  const withDeck = new Exceedance(
      () => [],
      () => water,
    ),
    a = hull({ exceedance: withDeck, initial: (x, y) => y < 0.3 });
  water = (a.deck.count * 0.1 ** 3) / 8;
  a.world.advance(90);
  const deckLoad = a.deck['words'](a.deck['forcesRegion'])[1];
  assert.equal(withDeck.claimed, true);
  assert.equal(withDeck.load, 0, 'the exceedance solver leaves its load out');
  assert.ok(
    Math.abs(deckLoad + RHO * G * water) <= RHO * G * 2 * 1 * 0.05,
    `deck load ${deckLoad} N, simplified ${-RHO * G * water} N`,
  );
  const alone = new Exceedance(() => [], water, false),
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5] } });
  const w = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
    .add(new RigidSolver(), { physics })
    .add(alone);
  w.advance(30);
  assert.notEqual(alone.claimed, true);
  assert.equal(alone.load, -RHO * G * water, 'alone, it carries the load');
});

test('a snapshot restores the deck water bit for bit', () => {
  const make = () =>
    hull({ rotation: [Math.sin(0.05), 0, 0, Math.cos(0.05)], initial: (x, y, z) => y < 0.3 && x < 1, inflow: false });
  const a = make();
  a.world.advance(20);
  const saved = a.world.takeSnapshot();
  a.world.advance(40);
  const hash = a.world.hash();
  a.world.restoreSnapshot(saved.bytes);
  a.world.advance(40);
  assert.equal(a.world.hash(), hash);
});

void BODIES_FIELD;
void BODY_WORDS;

test('a light hull carrying three times its mass of water falls freely at g and stays bounded (no added-mass blow-up)', () => {
  // 200 kg of hull with 0.6 m^3 of water on deck, let go in the air. The water's load fed back as it stood diverged in a
  // few steps (thousands of km/s, the added-mass instability); carried as added mass the pair falls together at g.
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    hull = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 200 },
    }),
    deck = new DeckWaterSolver('deckWater', { inflow: false }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(deck, {
        row: hull.row,
        offset: [-1, 0.5, -0.5],
        cells: [10, 6, 5],
        cellSize: 0.2,
        initial: (x, y) => y < 0.3,
      })
      .couple(['deckWater', 'rigid'], 'staggered');
  world.advance(60);
  const v = hull.linearVelocity[1];
  assert.ok(Math.abs(v + G) < 0.05 * G, `after 1 s the hull falls at ${v} m/s, against ${-G}`);
});

test("slack deck water cuts the righting moment by the free surface's rho g i tan(theta) (the free-surface effect)", () => {
  // A deck tank 2 m long and 1 m across (z), 0.2 m of water, on a hull held heeled 8 degrees about x. At rest the water's
  // surface lies level, so its centre moves to the low side by B^2 tan(theta) / (12 d) across the tank (i / V, i = L B^3 / 12
  // the free surface's second moment), and up by B^2 tan^2(theta) / (24 d): its moment about the hull's centre is
  // m g (y_c sin(theta) + z_c cos(theta)), against m g y0 sin(theta) for the same water held rigid. The difference is the
  // free-surface effect, which takes rho i g tan(theta) off the righting moment (the free-surface correction of GM).
  const theta = (8 * Math.PI) / 180,
    B = 1,
    d = 0.2,
    h = 0.05,
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    hull = physics.addBody(null, {
      type: 'fixed',
      rotation: [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)],
      colliders: { shape: 'box', halfExtents: [1, 0.3, 0.5] },
    }),
    deck = new DeckWaterSolver('deckWater', { inflow: false }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(deck, {
        row: hull.row,
        offset: [-1, -0.3, -0.5],
        cells: [40, 12, 20],
        cellSize: h,
        initial: (x, y) => y < d,
      });
  world.advance(240);
  const m = (RHO * deck.count * h ** 3) / 8,
    torque = deck['words'](deck['forcesRegion'])[3],
    y0 = -0.3 + d / 2,
    yc = y0 + (B * B * Math.tan(theta) ** 2) / (24 * d),
    zc = (B * B * Math.tan(theta)) / (12 * d),
    // Rotating about x by theta takes body (y, z) to world z = y sin + z cos; the weight -m g y on a lever z gives
    // tau_x = r_y F_z - r_z F_y = m g z_world.
    slack = m * G * (yc * Math.sin(theta) + zc * Math.cos(theta)),
    rigid = m * G * y0 * Math.sin(theta),
    // The grid places the surface within half a cell: the centre within h / 2 across, so the moment within m g h / 2.
    bound = (m * G * h) / 2;
  assert.ok(Math.abs(slack - rigid) > 2 * bound, 'the effect is larger than the bound, so the check can tell');
  assert.ok(
    Math.abs(torque - slack) <= bound,
    `moment ${torque} N m against ${slack} (rigid water would give ${rigid})`,
  );
});

test("deck water sloshes at the tank's natural period, sqrt(g k tanh(k d)) with k = pi / L", () => {
  // 2 m long, 0.2 m deep, the first mode started as a surface 0.02 m up at one end and down at the other.
  const L = 2,
    d = 0.2,
    a = 0.025,
    h = 0.025,
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    hull = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 0.3, 0.0125] } }),
    deck = new DeckWaterSolver('deckWater', { inflow: false }),
    world = new PhysicsWorld({ rate: { num: 120, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(deck, {
        row: hull.row,
        offset: [-1, -0.3, -0.0125],
        cells: [80, 24, 1],
        cellSize: h,
        initial: (x, y) => y < d + a * Math.cos((Math.PI * x) / L),
        rate: 1,
      });
  const k = Math.PI / L,
    period = (2 * Math.PI) / Math.sqrt(G * k * Math.tanh(k * d)),
    ends = [];
  for (let f = 1; f <= Math.round(3.2 * period * 120); f++) {
    world.advance(f);
    // The surface's height at the left end: its highest particle within the first cell.
    const p = deck.positions();
    let top = -Infinity;
    for (let i = 0; i < p.length; i += 3) if (p[i] < -1 + h) top = Math.max(top, p[i + 1]);
    ends.push(top);
  }
  // The period from the main crests at the left end: the highest point of each run of the surface above half-way from
  // its mean to its top (the steeper secondary waves riding on the slosh stay below that), spread over the crests seen.
  const mean = ends.reduce((s, v) => s + v, 0) / ends.length,
    high = mean + 0.5 * (Math.max(...ends) - mean),
    crests = [];
  for (let i = 0, run = -1; i <= ends.length; i++) {
    const up = i < ends.length && ends[i] > high;
    if (up && run < 0) run = i;
    if (!up && run >= 0) {
      let best = run;
      for (let k = run; k < i; k++) if (ends[k] > ends[best]) best = k;
      if (crests.length === 0 || (best - crests.at(-1)) / 120 > 0.5 * period) crests.push(best);
      else if (ends[best] > ends[crests.at(-1)]) crests[crests.length - 1] = best;
      run = -1;
    }
  }
  const measured = (crests.at(-1) - crests[0]) / (crests.length - 1) / 120;
  assert.ok(crests.length >= 3, `crests at ${crests.map((c) => c / 120)}`);
  assert.ok(Math.abs(measured - period) <= 0.05 * period, `period ${measured} s against ${period} s`);
});

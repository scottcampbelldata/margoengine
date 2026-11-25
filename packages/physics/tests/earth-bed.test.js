// The terrain bed (PA-37): one grid of elevations every ground writer adds to and every reader samples. A kernel ray, a
// contact and `Bed.sample` see one surface; contributions add up in the same bits whatever order their solvers were added;
// the bedrock refuses what would cut below it and the ledger accounts for every cubic metre; the collider follows edits in
// place, allocating nothing, and a ball resting on ground that a crater opens under falls into it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BED_CHANGE_FIELD, BedChange, BedCollider, TerrainBed, bedSurface, bedVolume } from '../dist/earth.js';
import { Physics } from '../dist/index.js';
import { PhysicsWorld } from '../dist/world.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const shape = { columns: 16, rows: 12, width: 32, depth: 24, centre: [3, -2] };
const hills = (x, z) => 2 + 0.8 * Math.sin(0.3 * x) * Math.cos(0.25 * z) + 0.05 * x;
const count = (shape.columns + 1) * (shape.rows + 1);
/** The elevations of `f` at the grid's vertices, in its layout, rounded to f32 as the kernel holds them. */
function heightsOf(f) {
  const out = new Float32Array(count);
  for (let c = 0; c <= shape.columns; c++)
    for (let r = 0; r <= shape.rows; r++)
      out[r + (shape.rows + 1) * c] = f(
        shape.centre[0] - shape.width / 2 + (shape.width * c) / shape.columns,
        shape.centre[1] - shape.depth / 2 + (shape.depth * r) / shape.rows,
      );
  return out;
}

test('a kernel ray straight down lands where Bed.sample says, on either triangle of every cell', () => {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
    heights = heightsOf(hills),
    bed = bedSurface(shape, heights, [0, 0, 0]),
    ground = new BedCollider(physics, bed);
  physics.step();
  let worst = 0,
    checked = 0;
  for (let i = 0; i <= 40; i++)
    for (let j = 0; j <= 40; j++) {
      // Inside the grid, on cell interiors, diagonals and edges alike.
      const x = shape.centre[0] - shape.width / 2 + (shape.width * (i + 0.37)) / 41.5,
        z = shape.centre[1] - shape.depth / 2 + (shape.depth * (j + 0.61)) / 41.5,
        hit = physics.raycast([x, 50, z], [0, -1, 0]),
        sample = bed.sample(x, z);
      assert.ok(hit, `a ray at ${x}, ${z} hits the ground`);
      worst = Math.max(worst, Math.abs(50 - hit.distance - sample.elevation));
      // The hit's normal is the triangle's: the sample's.
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(hit.normal[k] - sample.normal[k]) < 1e-4, `normal at ${x}, ${z}`);
      checked++;
    }
  // f32 coordinates of a few tens of metres: a few ulps.
  assert.ok(worst < 2e-5, `the ray and the sample differ by ${worst} m`);
  assert.equal(checked, 41 * 41);
  assert.equal(ground.collider.shape, 'heightfield');
  physics.dispose();
});

/** A contributor of `bedChange`: each tick it adds `rule(i)` metres to vertex i. */
function writer(id, rule) {
  let change, host;
  return {
    describe: () => ({
      id,
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: BED_CHANGE_FIELD, access: 'accumulate' }],
    }),
    init(h) {
      host = h;
      change = new BedChange(host, shape);
    },
    step() {
      const d = change.deltas;
      for (let i = 0; i < d.length; i++) d[i] = rule(i);
    },
    iterate() {
      this.step();
    },
    exportPorts: (tick) => [change.port(tick)],
    importPorts() {},
    stateRegions: () => [change.state],
    extraState: () => [],
  };
}

const erode = (i) => -0.001 * ((i * 7919) % 13) - 1e-7 / 3;
const deposit = (i) => 0.0004 * ((i * 104729) % 11) + 1 / 3e5;

function bedWorld(order, bedrock) {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }),
    owner = new TerrainBed();
  world.add(owner, { ...shape, elevations: hills, bedrock });
  for (const [id, rule] of order) world.add(writer(id, rule), {});
  return { world, owner };
}

test('contributions sum by contributor id, then vertex: the same bits whatever order the writers were added in', () => {
  const ab = bedWorld([
      ['slide', deposit],
      ['erosion', erode],
    ]),
    ba = bedWorld([
      ['erosion', erode],
      ['slide', deposit],
    ]);
  ab.world.advance(30);
  ba.world.advance(30);
  const one = ab.owner.elevations(),
    two = ba.owner.elevations();
  assert.deepEqual(Array.from(one), Array.from(two), 'every elevation the same f64');
  assert.equal(ab.world.hash(), ba.world.hash());
  // And the bed moved: each vertex by its writers' sum each tick.
  const start = heightsOf(hills);
  let moved = 0;
  for (let i = 0; i < count; i++) moved = Math.max(moved, Math.abs(one[i] - start[i]));
  assert.ok(moved > 0.1, `the bed moved ${moved} m`);
});

test('the bedrock refuses what would cut below it, and the ledger accounts for every cubic metre', () => {
  const floor = (x, z) => hills(x, z) - 0.05;
  const { world, owner } = bedWorld([['erosion', erode]], floor);
  const before = owner.volume();
  world.advance(240);
  const e = owner.elevations();
  let atRock = 0;
  for (let i = 0; i < count; i++) {
    // The bedrock as the bed evaluated it, in f64: never below it, and the eroded vertices on it exactly.
    const rock = floor(...xz(i));
    assert.ok(e[i] >= rock, `vertex ${i} is ${rock - e[i]} m below its bedrock`);
    if (e[i] === rock) atRock++;
  }
  assert.ok(atRock > count / 2, `${atRock} of ${count} vertices reached the bedrock`);
  assert.ok(owner.refusedVolume() > 0, 'some erosion was refused');
  const change = owner.volume() - before,
    accounted = owner.requestedVolume() + owner.refusedVolume();
  assert.ok(
    Math.abs(change - accounted) < 1e-9 * Math.abs(owner.requestedVolume()),
    `${change} m^3 against ${accounted}`,
  );
  assert.equal(owner.revisions(), 240, 'every step changed the bed');
});

function xz(i) {
  const c = Math.floor(i / (shape.rows + 1)),
    r = i % (shape.rows + 1);
  return [
    shape.centre[0] - shape.width / 2 + (shape.width * c) / shape.columns,
    shape.centre[1] - shape.depth / 2 + (shape.depth * r) / shape.rows,
  ];
}

test('a ball resting on the ground falls into the crater that opens under it, and the edits allocate nothing', () => {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
    flat = new Float32Array(count),
    ground = new BedCollider(physics, bedSurface(shape, flat)),
    [x, z] = xz(8 + (shape.rows + 1) * 8),
    ball = physics.addBody(null, { position: [x, 0.5, z], colliders: { shape: 'sphere', radius: 0.5 } });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 0.5) < 2e-3, `rests on the flat ground at ${ball.position[1]}`);
  assert.ok(ball.sleeping, 'and falls asleep');
  const memory = physics.kernel.memory.buffer.byteLength,
    rows = physics.kernel.columns.meshVertices.length;
  // A crater 2 m deep, 6 m across, centred under the ball: opened a little each step for a second.
  for (let step = 1; step <= 60; step++) {
    const now = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const [vx, vz] = xz(i),
        d = Math.hypot(vx - x, vz - z);
      now[i] = d < 3 ? (-2 * (step / 60) * (3 - d)) / 3 : 0;
    }
    ground.sync(bedSurface(shape, now));
    physics.step();
  }
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(ball.position[1] < -1.2, `the ball fell into the crater, to ${ball.position[1]}`);
  assert.equal(physics.kernel.memory.buffer.byteLength, memory, 'no memory grew');
  assert.equal(physics.kernel.columns.meshVertices.length, rows, 'no mesh rows were added');
  assert.equal(
    ground.sync(
      bedSurface(
        shape,
        flat.fill(0).map((_, i) => ground.collider.heightfieldHeights()[i]),
      ),
    ),
    0,
  );
  physics.dispose();
});

test('a bed of another grid, or a ragged one, is refused by name', () => {
  const physics = new Physics(null),
    ground = new BedCollider(physics, bedSurface(shape, new Float32Array(count)));
  assert.throws(() => ground.sync(bedSurface({ ...shape, columns: 15 }, new Float32Array(16 * 13))), /another grid/);
  assert.throws(() => bedSurface(shape, new Float32Array(3)), /vertices/);
  assert.throws(() => ground.collider.setHeights([Number.NaN]), /finite/);
  assert.throws(() => ground.collider.setHeights([0], count), /points 0 to/);
  physics.dispose();
  void bedVolume;
});

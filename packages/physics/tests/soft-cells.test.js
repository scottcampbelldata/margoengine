// Tetrahedral soft bodies on the soft kernel: a cantilever against Euler-Bernoulli, volume of a near-incompressible rubber,
// plastic set, tearing, clusters, removal and replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../dist/soft.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const create = async (gravity = [0, -9.81, 0], substeps = 20, iterations = 20) => {
  const physics = new Physics(null, { gravity });
  const soft = await SoftBodies.attach(physics, { substeps, iterations });
  return { physics, soft };
};
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
const rubber = (props = {}) => Object.assign(new CellMaterial(), props);
/** The particles on the plane where `axis` is at `value` (to a thousandth of a cell). */
const plane = (desc, axis, value) => {
  const out = [];
  for (let i = 0; i < desc.particleCount; i++) if (Math.abs(desc.positions[i * 3 + axis] - value) < 1e-6) out.push(i);
  return out;
};
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

test('a cantilever sags by the Euler-Bernoulli deflection as its mesh is refined', async () => {
  const side = 0.25,
    e = 3e6,
    rho = 1000;
  // rho g A L^4 / (8 E I), with L = 1 and I = side^4 / 12.
  const expected = (rho * 9.81 * side * side) / (8 * e * (side ** 4 / 12));
  const sag = async (cells) => {
    const { physics, soft } = await create();
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [1, side, side],
      [cells, cells / 4, cells / 4],
      rubber({ youngsModulus: e, density: rho }),
    );
    desc.setPinnedParticles(plane(desc, 0, 0)).setLinearDamping(4);
    soft.cellDamping = 20;
    const body = soft.create(desc);
    steps(physics, 360);
    const far = plane(desc, 0, 1);
    return side / 2 - far.reduce((sum, i) => sum + body.particlePosition(i)[1], 0) / far.length;
  };
  const coarse = await sag(8),
    fine = await sag(12);
  assert.ok(coarse > 0.45 * expected && coarse < fine, `a coarse mesh locks: ${coarse} against ${fine}`);
  assert.ok(fine > 0.8 * expected && fine < 1.05 * expected, `tip sag ${fine} against Euler-Bernoulli ${expected}`);
});

test('a near-incompressible rubber keeps its volume when stretched and a compressible one does not', async () => {
  const stretched = async (poissonRatio) => {
    const { physics, soft } = await create([0, 0, 0]);
    const desc = SoftBodyDesc.box([0, 0, 0], [0.6, 0.2, 0.2], [6, 2, 2], rubber({ youngsModulus: 5e4, poissonRatio }));
    const left = plane(desc, 0, 0),
      right = plane(desc, 0, 0.6);
    desc.setPinnedParticles([...left, ...right]).setLinearDamping(6);
    soft.cellDamping = 20;
    const body = soft.create(desc),
      rest = body.volume();
    for (let step = 0; step < 300; step++) {
      const t = Math.min(step / 120, 1);
      for (const i of right) {
        const p = desc.positions;
        body.setParticleKinematicTarget(i, [0.6 * (1 + 0.3 * t), p[i * 3 + 1], p[i * 3 + 2]]);
      }
      physics.step();
    }
    return body.volume() / rest;
  };
  near(await stretched(0.49), 1, 0.03, 'nu 0.49 volume ratio');
  const foam = await stretched(0.05);
  assert.ok(foam > 1.15, `a foam grows with the stretch, ${foam}`);
});

test('a plastic cantilever keeps a set after its load goes and an elastic one comes back', async () => {
  const after = async (yieldStrain) => {
    const { physics, soft } = await create([0, -49.05, 0], 20, 8);
    const desc = SoftBodyDesc.box([0, 0, 0], [1, 0.25, 0.25], [8, 2, 2], rubber({ youngsModulus: 3e6, yieldStrain }));
    desc.setPinnedParticles(plane(desc, 0, 0)).setLinearDamping(4);
    soft.cellDamping = 20;
    const body = soft.create(desc),
      far = plane(desc, 0, 1),
      tip = () => 0.125 - far.reduce((sum, i) => sum + body.particlePosition(i)[1], 0) / far.length;
    steps(physics, 240);
    const loaded = tip();
    physics.gravity = [0, 0, 0];
    steps(physics, 360);
    return [loaded, tip()];
  };
  const [loaded, back] = await after(0);
  assert.ok(loaded > 0.1, `the beam sags ${loaded}`);
  assert.ok(Math.abs(back) < 0.05 * loaded, `an elastic beam returns: ${back} of ${loaded}`);
  const [bent, set] = await after(0.02);
  assert.ok(bent > 0.1 && set > 0.3 * bent, `a plastic beam keeps ${set} of its ${bent}`);
});

test('a bar tears at its strain threshold in two pieces and says which cells; a lesser stretch holds', async () => {
  const pulled = async (stretch) => {
    const { physics, soft } = await create([0, 0, 0], 20, 4);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.6, 0.1, 0.1],
      [6, 1, 1],
      rubber({ youngsModulus: 5e4, tearStrain: 0.6 }),
    );
    const right = plane(desc, 0, 0.6);
    desc.setPinnedParticles([...plane(desc, 0, 0), ...right]).setLinearDamping(4);
    const body = soft.create(desc),
      events = [];
    soft.onTear((event) => events.push(event));
    for (let step = 0; step < 180; step++) {
      const t = Math.min(step / 60, 1);
      for (const i of right)
        body.setParticleKinematicTarget(i, [
          0.6 * (1 + (stretch - 1) * t),
          desc.positions[i * 3 + 1],
          desc.positions[i * 3 + 2],
        ]);
      physics.step();
    }
    return { body, events };
  };
  const held = await pulled(1.3);
  assert.equal(held.body.tornCells().length, 0, 'a 30 percent stretch holds');
  assert.equal(held.events.length, 0);
  const torn = await pulled(2.2);
  assert.ok(torn.body.tornCells().length > 0, 'a 120 percent stretch tears');
  const reported = torn.events.flatMap((event) => event.cells);
  assert.deepEqual(
    [...reported].sort((a, b) => a - b),
    torn.body.tornCells(),
    'every torn cell is reported once',
  );
  assert.ok(torn.body.isCellTorn(reported[0]));
  assert.ok(torn.body.restVolume() < 0.6 * 0.1 * 0.1 - 1e-9, 'the torn cells no longer count in the volume');
  assert.ok(torn.body.volume() > 0);
  // Particles joined by the cells that are left: a bar torn clean through is two pieces, a whole one is one.
  const pieces = (body) => {
    const parent = Array.from({ length: body.numParticles() }, (_, i) => i),
      find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i]))),
      cells = body.cells(),
      alive = new Set(Array.from({ length: body.numCells() }, (_, t) => t).filter((t) => !body.isCellTorn(t)));
    for (const t of alive) for (let k = 1; k < 4; k++) parent[find(cells[t * 4 + k])] = find(cells[t * 4]);
    const used = new Set();
    for (const t of alive) for (let k = 0; k < 4; k++) used.add(find(cells[t * 4 + k]));
    return used.size;
  };
  assert.equal(pieces(held.body), 1);
  assert.equal(pieces(torn.body), 2, 'the bar is torn in two');
});

test('a block with shape matching clusters keeps its overall shape when its cells are soft', async () => {
  const flop = async (clusters) => {
    const { physics, soft } = await create([0, -9.81, 0], 8, 4);
    const desc = SoftBodyDesc.box(
      [0, 0.5, 0],
      [0.4, 0.4, 0.4],
      [4, 4, 4],
      rubber({ youngsModulus: 2e3 }),
    ).setLinearDamping(1);
    if (clusters) desc.setClusters([Array.from({ length: desc.particleCount }, (_, i) => i)], 30);
    soft.cellDamping = 10;
    const body = soft.create(desc);
    // A twist: the far half is turned about the vertical, then the body is let go.
    for (let i = 0; i < desc.particleCount; i++) {
      const [x, y, z] = [desc.positions[i * 3], desc.positions[i * 3 + 1], desc.positions[i * 3 + 2]],
        angle = x > 0.2 ? 0.6 : 0,
        c = Math.cos(angle),
        s = Math.sin(angle);
      body.setParticlePosition(i, [0.2 + (x - 0.2) * c - (z - 0.2) * s, y, 0.2 + (x - 0.2) * s + (z - 0.2) * c]);
    }
    physics.gravity = [0, 0, 0];
    steps(physics, 300);
    // How far the particles are from the rest block, after the best move of it: the spread of their distances from the centre.
    const p = body.particlePositions();
    let worst = 0;
    const c = body.centerOfMass();
    for (let i = 0; i < desc.particleCount; i++) {
      const rest = Math.hypot(
          desc.positions[i * 3] - 0.2,
          desc.positions[i * 3 + 1] - 0.7,
          desc.positions[i * 3 + 2] - 0.2,
        ),
        now = Math.hypot(p[i * 3] - c[0], p[i * 3 + 1] - c[1], p[i * 3 + 2] - c[2]);
      worst = Math.max(worst, Math.abs(now - rest));
    }
    return worst;
  };
  const without = await flop(false),
    held = await flop(true);
  assert.ok(held < 1e-3, `a cluster holds the shape: ${held}`);
  assert.ok(without > 0.02, `soft cells alone leave the twist in: ${without}`);
});

test('a rubber block dropped on a floor with the default settings settles on it with its volume kept', async () => {
  const physics = new Physics(null);
  const soft = await SoftBodies.attach(physics);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5], friction: 1 },
  });
  const body = soft.create(
    SoftBodyDesc.box([0, 1, 0], [0.4, 0.4, 0.4], [4, 4, 4], rubber({ youngsModulus: 2e5, poissonRatio: 0.45 })),
  );
  steps(physics, 480);
  const low = Math.min(...body.particlePositions().filter((_, k) => k % 3 === 1));
  near(low, 0.1, 0.12, 'the block rests on the floor at its particle radius');
  const speed = Math.max(...Array.from(body.particleVelocities(), Math.abs));
  assert.ok(speed < 0.2, `it has settled: ${speed}`);
  near(body.volume() / body.restVolume(), 1, 0.1, 'it kept its volume');
});

test('two runs of the same scene with cells, plastic flow, tearing and a cluster end in the same state', async () => {
  const run = async () => {
    const { physics, soft } = await create([0, -9.81, 0], 8, 2);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.5, 0.25, 0.25],
      [4, 2, 2],
      rubber({ youngsModulus: 2e4, yieldStrain: 0.05, tearStrain: 3, model: 'corotated' }),
    );
    desc
      .setPinnedParticles(plane(desc, 0, 0))
      .setClusters([Array.from({ length: desc.particleCount }, (_, i) => i)], 5);
    soft.create(desc);
    steps(physics, 120);
    return soft.hash();
  };
  assert.equal(await run(), await run());
});

test('removing a body with cells and clusters leaves the others as they were', async () => {
  const build = (x) =>
    SoftBodyDesc.box([x, 0, 0], [0.4, 0.2, 0.2], [4, 2, 2], rubber({ youngsModulus: 5e4 }))
      .setClusters([[0, 1, 2, 3, 4, 5, 6, 7]], 10)
      .setLinearDamping(1);
  const alone = await create([0, -9.81, 0], 8, 2);
  const first = alone.soft.create(build(3));
  steps(alone.physics, 60);
  const expected = [...first.particlePositions()];
  const both = await create([0, -9.81, 0], 8, 2);
  const gone = both.soft.create(build(0));
  const kept = both.soft.create(build(3));
  both.soft.remove(gone);
  assert.equal(kept.handle, 0);
  assert.equal(kept.numCells(), first.numCells());
  steps(both.physics, 60);
  assert.deepEqual([...kept.particlePositions()], expected, 'the survivor moves as it would have alone');
  assert.deepEqual([...kept.cells()], [...first.cells()]);
});

test('the cell builders and setters check what they are given', async () => {
  const { soft } = await create();
  assert.throws(() => SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [2, 2, 3]), RangeError, 'cells are cubes');
  const flat = new SoftBodyDesc([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  assert.throws(() => flat.setCells([0, 1, 2, 3]), /flat/);
  assert.throws(() => flat.setCells([0, 1, 2, 9]), /not a particle/);
  assert.throws(() => flat.setCells([0, 1, 2]), /four/);
  assert.throws(() => SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [1, 1, 1], rubber({ poissonRatio: 0.5 })), RangeError);
  assert.throws(() => SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [1, 1, 1], rubber({ youngsModulus: 0 })), RangeError);
  assert.throws(() => SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [1, 1, 1]).setClusters([[0, 1]], 5), RangeError);
  assert.throws(() => SoftBodyDesc.solid([0, 0, 0], 0.1, [2, 2, 2], () => false), /no cells/);
  const body = soft.create(SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [1, 1, 1]));
  assert.throws(() => body.isCellTorn(6), RangeError);
  assert.equal(body.numCells(), 6);
  near(body.restVolume(), 1, 1e-5, 'six cells make a cube');
});

test('a solid carved from the grid fills the shape it was carved to and weighs its density', async () => {
  const { soft } = await create();
  const r = 0.5,
    desc = SoftBodyDesc.solid(
      [-r, -r, -r],
      0.05,
      [20, 20, 20],
      (x, y, z) => x * x + y * y + z * z < r * r,
      rubber({ density: 1000 }),
    );
  const body = soft.create(desc);
  near(body.restVolume(), (4 / 3) * Math.PI * r ** 3, 0.08 * ((4 / 3) * Math.PI * r ** 3), 'the ball is near a ball');
  near(body.mass(), 1000 * body.restVolume(), 1e-3, 'it weighs its density');
  assert.ok(body.numCells() < 20 * 20 * 20 * 6, 'the corners are gone');
});

test('a body can be given a new cell material and a cell can be torn by hand', async () => {
  const { physics, soft } = await create([0, 0, 0]);
  const body = soft.create(SoftBodyDesc.box([0, 0, 0], [0.2, 0.2, 0.2], [2, 2, 2]));
  const events = [];
  soft.onTear((event) => events.push(event));
  body.setCellMaterial(rubber({ youngsModulus: 1e6, tearStrain: 0.5 }));
  assert.equal(body.getCellMaterial().youngsModulus, 1e6);
  body.tearCell(3);
  assert.equal(body.isCellTorn(3), true);
  steps(physics, 1);
  assert.deepEqual(
    events.map((e) => e.cells),
    [[3]],
  );
  assert.deepEqual(body.tornCells(), [3]);
});

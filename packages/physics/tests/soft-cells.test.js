// Tetrahedral soft bodies on the soft kernel: a cantilever against Euler-Bernoulli, volume of a near-incompressible rubber,
// plastic set, tearing, clusters, removal and replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc, SoftBodyMaterial } from '../dist/soft.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const create = async (gravity = [0, -9.81, 0], substeps = 20, iterations = 20) => {
  const physics = new Physics(null, { gravity });
  const soft = await SoftBodies.attach(physics, { substeps, iterations });
  // The tests that read a torn body keep it in one piece; those of splitting turn it on.
  soft.splitOnTear = 'never';
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

test('a volume cell holds its volume and the edges hold the shape', async () => {
  const squeezed = async (model) => {
    const { physics, soft } = await create([0, 0, 0], 8, 8);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.4, 0.4, 0.4],
      [4, 4, 4],
      rubber({ model, youngsModulus: 5e4 }),
    ).addCellEdges();
    desc.setEdges(desc.edgePairs);
    desc.setSoftness(model === 'volume' ? 4 : 0, 1);
    const body = soft.create(desc);
    // Press the top face down by a quarter.
    for (let i = 0; i < desc.particleCount; i++)
      if (desc.positions[i * 3 + 1] > 0.39)
        body.setParticleKinematicTarget(i, [desc.positions[i * 3], 0.3, desc.positions[i * 3 + 2]]);
    for (let i = 0; i < desc.particleCount; i++) if (desc.positions[i * 3 + 1] < 0.01) body.setParticlePinned(i, true);
    steps(physics, 240);
    return body.volume() / body.restVolume();
  };
  const volume = await squeezed('volume');
  assert.ok(Math.abs(volume - 0.75) < 0.12 || volume > 0.7, `the volume cells keep some of their volume: ${volume}`);
});

test('a cell material damps by its damping ratio and by its deformation damping', async () => {
  const ring = async (props) => {
    const { physics, soft } = await create([0, 0, 0], 8, 4);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.4, 0.1, 0.1],
      [8, 2, 2],
      rubber({ youngsModulus: 2e5, deformationDamping: 0, ...props }),
    );
    desc.setPinnedParticles(plane(desc, 0, 0));
    const body = soft.create(desc);
    for (let i = 0; i < desc.particleCount; i++) body.setParticleVelocity(i, [0, desc.positions[i * 3] * 6, 0]);
    steps(physics, 90);
    return Math.max(...Array.from(body.particleVelocities(), Math.abs));
  };
  const free = await ring({}),
    byRatio = await ring({ elasticDampingRatio: 1 }),
    byRate = await ring({ deformationDamping: 40 });
  assert.ok(byRatio < free * 0.6, `a damping ratio calms the ring: ${byRatio} against ${free}`);
  assert.ok(byRate < free * 0.6, `a deformation damping calms the ring: ${byRate} against ${free}`);
});

test('plastic max caps the set, and resetPlasticity takes it back', async () => {
  const bend = async (plasticMax) => {
    const { physics, soft } = await create([0, -49.05, 0], 20, 8);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [1, 0.25, 0.25],
      [8, 2, 2],
      rubber({ youngsModulus: 3e6, yieldStrain: 0.02, plasticMax }),
    );
    desc.setPinnedParticles(plane(desc, 0, 0)).setLinearDamping(4);
    soft.cellDamping = 20;
    const body = soft.create(desc),
      far = plane(desc, 0, 1),
      tip = () => 0.125 - far.reduce((sum, i) => sum + body.particlePosition(i)[1], 0) / far.length;
    steps(physics, 240);
    physics.gravity = [0, 0, 0];
    steps(physics, 360);
    const set = tip();
    body.resetPlasticity();
    steps(physics, 360);
    return [set, tip()];
  };
  const [free] = await bend(0),
    [capped, back] = await bend(0.002);
  assert.ok(free > 0.1, `an uncapped beam keeps a set: ${free}`);
  assert.ok(capped > 0.002 && capped < free * 0.01, `a capped one keeps less: ${capped} against ${free}`);
  assert.ok(Math.abs(back) < 0.5 * capped, `after resetPlasticity the beam springs back: ${back} of ${capped}`);
});

test('edges flow plastically past their yield, in the way asked, and reset', async () => {
  // A rope pulled to 1.8 times its length, then let go at its far end: it keeps the length its edges flowed to, or draws back.
  const span = async (edgePlasticFlow, reset) => {
    const { physics, soft } = await create([0, 0, 0], 8, 4);
    const material = new SoftBodyMaterial();
    material.edgeSoftness = { naturalFrequency: 20, dampingRatio: 1 };
    material.edgePlasticYield = 0.05;
    material.edgePlasticFlow = edgePlasticFlow;
    const body = soft.create(
      SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 11, { bending: false })
        .setMaterial(material)
        .setPinnedParticles([0, 10])
        .setLinearDamping(2),
    );
    body.setParticleKinematicTarget(10, [1.8, 0, 0]);
    steps(physics, 240);
    body.setParticleVelocity(10, [0, 0, 0]).setParticlePinned(10, false);
    if (reset) {
      // Elastic again, and its edges given their first lengths back: the rope draws in to where it began.
      const elastic = body.getMaterial();
      elastic.edgePlasticYield = 0;
      body.setMaterial(elastic).resetPlasticity();
    }
    steps(physics, 360);
    return body.particlePosition(10)[0];
  };
  const both = await span('both', false),
    stretch = await span('stretch', false),
    squeeze = await span('compression', false),
    reset = await span('both', true);
  assert.ok(both > 1.7, `a rope that flows when stretched keeps its length: ${both}`);
  assert.ok(stretch > 1.7, `so does one that flows only when stretched: ${stretch}`);
  assert.ok(squeeze < 1.05, `one that flows only when squeezed keeps no stretch: ${squeeze}`);
  near(reset, 1, 0.1, 'resetPlasticity gives the lengths back and the rope draws in');
});

// A bar of 6 by 1 by 1 cubes held at both ends and drawn out over a second to `stretch` times its length.
const drawn = async (material, stretch, { counts = [6, 1, 1], size = [0.6, 0.1, 0.1], settings } = {}) => {
  const { physics, soft } = await create([0, 0, 0], 20, 4);
  const desc = SoftBodyDesc.box([0, 0, 0], size, counts, material);
  const right = plane(desc, 0, size[0]);
  desc.setPinnedParticles([...plane(desc, 0, 0), ...right]).setLinearDamping(4);
  if (settings) desc.setMaterial(settings);
  const body = soft.create(desc),
    perStep = [];
  let before = 0;
  for (let step = 0; step < 180; step++) {
    const t = Math.min(step / 60, 1);
    for (const i of right)
      body.setParticleKinematicTarget(i, [
        size[0] * (1 + (stretch - 1) * t),
        desc.positions[i * 3 + 1],
        desc.positions[i * 3 + 2],
      ]);
    physics.step();
    const torn = body.tornCells().length;
    perStep.push(torn - before);
    before = torn;
  }
  return { body, perStep, desc };
};

test('a tear waits for the smallest piece it may split off and goes ahead when the pieces are big enough', async () => {
  const material = () => rubber({ youngsModulus: 5e4, tearStrain: 0.6 });
  const least = (minPiece) => Object.assign(new SoftBodyMaterial(), { minPiece });
  const free = await drawn(material(), 1.7),
    small = await drawn(material(), 1.7, { settings: least(10) }),
    big = await drawn(material(), 1.7, { settings: least(30) });
  assert.equal(pieces(free.body), 2, 'the bar tears in two');
  assert.equal(pieces(small.body), 2, 'pieces of 18 cells are over the least of 10');
  assert.equal(pieces(big.body), 1, 'a piece of 18 cells is under the least of 30, so the last tear waits');
  assert.ok(big.body.tornCells().length > 0, 'the cells that do not split it still tear');
});

test('a body tears at most maxTearsPerStep elements a step, the most loaded first', async () => {
  const material = rubber({ youngsModulus: 5e4, tearStrain: 0.5 });
  const any = await drawn(material, 1.7, { counts: [6, 2, 2], size: [0.6, 0.2, 0.2] }),
    one = await drawn(material, 1.7, {
      counts: [6, 2, 2],
      size: [0.6, 0.2, 0.2],
      settings: Object.assign(new SoftBodyMaterial(), { maxTearsPerStep: 1 }),
    });
  assert.ok(Math.max(...any.perStep) > 1, `without a limit many cells tear in a step: ${Math.max(...any.perStep)}`);
  assert.ok(one.body.tornCells().length > 0, 'a limited body still tears');
  assert.ok(Math.max(...one.perStep) <= 1, `one a step: ${Math.max(...one.perStep)}`);
});

test('a load that is smoothed over time does not tear on a spike, and the interior holds longer than the surface', async () => {
  const spike = async (tearSmoothing) => {
    const { physics, soft } = await create([0, 0, 0], 20, 4);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.6, 0.1, 0.1],
      [6, 1, 1],
      rubber({ youngsModulus: 5e4, tearStrain: 0.6, tearSmoothing }),
    );
    const right = plane(desc, 0, 0.6);
    desc.setPinnedParticles([...plane(desc, 0, 0), ...right]);
    const body = soft.create(desc);
    for (let step = 0; step < 90; step++) {
      // Pulled to 1.7 times its length for three steps only.
      const out = step >= 30 && step < 33 ? 1.7 : 1;
      for (const i of right)
        body.setParticleKinematicTarget(i, [0.6 * out, desc.positions[i * 3 + 1], desc.positions[i * 3 + 2]]);
      physics.step();
    }
    return body.tornCells().length;
  };
  assert.ok((await spike(0)) > 0, 'a spike tears an unsmoothed bar');
  assert.equal(await spike(0.5), 0, 'a smoothed load rides it out');
  // Cells with no outside face are tougher by `interiorStrength` until a neighbour tears: the block that is tougher inside tears less.
  const blockTorn = async (interiorStrength) =>
    (
      await drawn(rubber({ youngsModulus: 5e4, tearStrain: 0.6, interiorStrength }), 1.6, {
        counts: [4, 4, 4],
        size: [0.4, 0.4, 0.4],
      })
    ).body.tornCells().length;
  const [plain, tough] = [await blockTorn(1), await blockTorn(6)];
  assert.ok(plain > 0 && tough < plain, `an interior that holds tears fewer cells: ${tough} against ${plain}`);
});

test('an edge pulled with more than its tear force tears and one pulled with less holds', async () => {
  const hang = async (tearForce) => {
    const { physics, soft } = await create();
    const material = new SoftBodyMaterial();
    material.tearForce = tearForce;
    const body = soft.create(
      SoftBodyDesc.rope([0, 3, 0], [0, 1, 0], 6, { bending: false })
        .setMaterial(material)
        .setPinnedParticles([0])
        .setParticleMass(2),
    );
    steps(physics, 120);
    return (
      body.edges().length / 2 -
      (() => {
        let held = 0;
        for (let e = 0; e < body.edges().length / 2; e++) if (!body.isEdgeTorn(e)) held++;
        return held;
      })()
    );
  };
  assert.equal(await hang(1000), 0, 'a rope of 10 kg on a 1,000 N edge holds');
  assert.ok((await hang(40)) > 0, 'a rope of 10 kg on a 40 N edge tears (98 N hangs from the top)');
});

test('a body torn clean through becomes two bodies, each with its share of the mass and its own fall', async () => {
  const { physics, soft } = await create([0, -9.81, 0], 8, 4);
  soft.splitOnTear = 'cells';
  const desc = SoftBodyDesc.box([0, 0, 0], [0.6, 0.1, 0.1], [6, 1, 1], rubber({ youngsModulus: 2e5 }));
  desc.setPinnedParticles(plane(desc, 0, 0));
  const body = soft.create(desc),
    mass = body.mass(),
    events = [];
  soft.onTear((event) => events.push(event));
  // The cells whose centre is past x = 0.3 and before 0.3 + a cell: the layer of cells across the middle.
  const cells = body.cells(),
    p = body.particlePositions(),
    layer = [];
  for (let t = 0; t < body.numCells(); t++) {
    const x = [0, 1, 2, 3].reduce((sum, k) => sum + p[cells[t * 4 + k] * 3], 0) / 4;
    if (x > 0.25 && x < 0.35) layer.push(t);
  }
  const event = soft.tear(body, { cells: layer });
  assert.equal(event.pieces.length, 2, 'two pieces');
  assert.equal(body.valid, false, 'the old body is gone');
  assert.deepEqual(events, [event], 'the listener was told once');
  assert.equal(soft.list().length, 2);
  const [near, far] =
    event.pieces[0].isParticlePinned(0) || event.pieces[0].particlePosition(0)[0] < 0.1
      ? event.pieces
      : [event.pieces[1], event.pieces[0]];
  assert.ok(
    near.mass() + far.mass() <= mass + 1e-4 && near.mass() + far.mass() > 0.9 * mass,
    `the mass is shared: ${near.mass() + far.mass()} of ${mass}`,
  );
  // Every particle that a cell still holds went to a piece.
  let gone = 0;
  for (let i = 0; i < body.numParticles(); i++) if (event.destination(i).length === 0) gone++;
  assert.ok(gone < body.numParticles() / 2, `most particles went to a piece, ${gone} did not`);
  const before = far.centerOfMass()[1];
  steps(physics, 120);
  assert.ok(far.centerOfMass()[1] < before - 0.5, 'the far piece falls');
  assert.ok(near.centerOfMass()[1] > -0.05, 'the held piece stays up');
});

test('a tear that cracks a body without parting it duplicates the particles along the crack and keeps one body', async () => {
  const { soft } = await create([0, 0, 0], 8, 4);
  soft.splitOnTear = 'cells';
  const desc = SoftBodyDesc.box([0, 0, 0], [0.4, 0.4, 0.4], [4, 4, 4], rubber({ youngsModulus: 2e5 }));
  const body = soft.create(desc),
    particles = body.numParticles(),
    volume = body.restVolume();
  // A blade across half of the block, from its middle out to a side: a crack with the other half still joining the sides.
  const event = soft.cut(body, [
    [0.2 + 1e-3, -1, -1],
    [0.2 + 1e-3, 2, -1],
    [0.2 + 1e-3, 0.5, 0.2],
  ]);
  assert.equal(event.pieces.length, 1, 'one body, rebuilt with the crack');
  const [piece] = event.pieces;
  assert.ok(
    piece.numParticles() > particles,
    `particles were duplicated: ${piece.numParticles()} against ${particles}`,
  );
  near(piece.restVolume(), volume, 1e-6, 'no material was removed');
});

test('a blade through a block makes two pieces whose volumes add to the block', async () => {
  const { soft } = await create([0, 0, 0], 8, 4);
  soft.splitOnTear = 'cells';
  const desc = SoftBodyDesc.box([0, 0, 0], [0.4, 0.4, 0.4], [4, 4, 4], rubber({ youngsModulus: 2e5 }));
  const body = soft.create(desc),
    volume = body.restVolume();
  const event = soft.cut(body, [
    [0.2 + 1e-3, -1, -1],
    [0.2 + 1e-3, 3, -1],
    [0.2 + 1e-3, -1, 3],
  ]);
  assert.equal(event.pieces.length, 2);
  near(event.pieces[0].restVolume() + event.pieces[1].restVolume(), volume, 1e-6, 'the pieces add up to the block');
  near(event.pieces[0].restVolume(), volume / 2, 1e-6, 'a cut across the middle halves it');
  assert.ok(event.pieces[0].mass() + event.pieces[1].mass() > 0);
});

test('a rope torn through becomes two ropes when asked to split edges too', async () => {
  const { soft } = await create([0, 0, 0], 8, 4);
  soft.splitOnTear = 'all';
  const rope = soft.create(SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 11, { bending: false }));
  const event = soft.tear(rope, { edges: [4] });
  assert.equal(event.pieces.length, 2);
  assert.deepEqual(event.pieces.map((piece) => piece.numParticles()).sort(), [5, 6]);
  assert.equal(event.destination(4)[0].body, event.pieces[0]);
});

// A closed, outward mesh of a box [0,1] x [0,0.5] x [0,0.5], twelve triangles.
const boxMesh = (sx = 1, sy = 0.5, sz = 0.5) => {
  const v = [];
  for (const x of [0, sx]) for (const y of [0, sy]) for (const z of [0, sz]) v.push(x, y, z);
  // Corner index: x * 4 + y * 2 + z.
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const i = [];
  for (const [a, b, c, d] of quads) i.push(a, b, c, a, c, d);
  return { vertices: v, indices: i };
};

test('volumetric fills a closed mesh with cells that hold it, and a skin rides in them', async () => {
  const { physics, soft } = await create([0, 0, 0], 8, 4);
  const { vertices, indices } = boxMesh();
  const desc = SoftBodyDesc.volumetric(vertices, indices, 0.25, true);
  const body = soft.create(desc);
  // The cells hold the mesh: their volume is the box's, to the lattice's size.
  assert.ok(body.restVolume() >= 0.25 - 1e-6, `the cells contain the box: ${body.restVolume()}`);
  assert.ok(body.restVolume() < 0.25 * 2, `and not much more: ${body.restVolume()}`);
  const skin = body.meshVertices();
  assert.equal(skin.length, vertices.length);
  for (let i = 0; i < skin.length; i++) near(skin[i], vertices[i], 1e-5, `skin vertex ${i} starts where the mesh is`);
  assert.deepEqual([...body.meshIndices()], indices);
  // The skin follows the cells: shifting every particle by a metre moves the skin by a metre.
  for (let i = 0; i < body.numParticles(); i++)
    body.setParticlePosition(i, [
      body.particlePosition(i)[0] + 1,
      body.particlePosition(i)[1],
      body.particlePosition(i)[2],
    ]);
  const moved = body.meshVertices();
  for (let i = 0; i < moved.length; i += 3) near(moved[i], vertices[i] + 1, 1e-4, `skin vertex ${i / 3} follows`);
  steps(physics, 1);
});

test('volumetric and cuboid are checked, and a cuboid is a box', async () => {
  const { vertices, indices } = boxMesh();
  assert.throws(() => SoftBodyDesc.volumetric(vertices, [0, 1], 0.2), RangeError);
  assert.throws(() => SoftBodyDesc.volumetric(vertices, indices, 0), RangeError);
  assert.throws(() => SoftBodyDesc.volumetric(vertices, [0, 1, 99], 0.2), RangeError);
  const { soft } = await create();
  const a = soft.create(SoftBodyDesc.cuboid([0, 0, 0], [0.2, 0.1, 0.1], [2, 1, 1]));
  near(a.restVolume(), 0.4 * 0.2 * 0.2, 1e-6, 'a cuboid of half extents fills them');
  assert.throws(() => new SoftBodyDesc([0, 0, 0]).setSkin(vertices, indices), RangeError);
});

const all = (body) => Array.from({ length: body.numParticles() }, (_, i) => i);

test('a cluster has a rigid proxy that follows it and, joined to the world, holds it up', async () => {
  const hang = async (joined) => {
    const { physics, soft } = await create([0, -9.81, 0], 8, 4);
    const body = soft.create(
      SoftBodyDesc.box([-0.2, 1.8, -0.2], [0.4, 0.4, 0.4], [2, 2, 2], rubber({ youngsModulus: 1e5 })),
    );
    const cluster = body.addCluster(all(body), 20);
    assert.equal(cluster, 0);
    assert.equal(body.numClusters(), 1);
    const proxy = body.clusterProxy(cluster);
    assert.equal(body.clusterProxy(cluster), proxy, 'the same proxy every time');
    near(proxy.mass, body.mass(), 1e-4, 'the proxy weighs what the cluster does');
    if (joined) {
      const anchor = physics.addBody(null, { type: 'fixed', position: [0, 2, 0] });
      physics.addJoint(anchor, proxy, { type: 'spherical', anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
    }
    steps(physics, 120);
    return { body, proxy };
  };
  const free = await hang(false),
    held = await hang(true);
  near(free.proxy.position[1], free.body.centerOfMass()[1], 0.05, 'the proxy stands at the cluster');
  assert.ok(free.body.centerOfMass()[1] < 1.2, `the body falls: ${free.body.centerOfMass()[1]}`);
  assert.ok(
    Math.abs(held.body.centerOfMass()[1] - 2) < 0.3,
    `a joint to the proxy holds the body up: ${held.body.centerOfMass()[1]}`,
  );
});

test('cluster settings reach the cells and edges inside the cluster', async () => {
  const sag = async (scale) => {
    const { physics, soft } = await create([0, -9.81, 0], 20, 8);
    const desc = SoftBodyDesc.box([0, 0, 0], [1, 0.25, 0.25], [8, 2, 2], rubber({ youngsModulus: 3e5 }));
    desc.setPinnedParticles(plane(desc, 0, 0)).setLinearDamping(4);
    soft.cellDamping = 20;
    const body = soft.create(desc);
    body.setClusterStiffnessScale(body.addCluster(all(body)), scale);
    steps(physics, 240);
    const far = plane(desc, 0, 1);
    return 0.125 - far.reduce((sum, i) => sum + body.particlePosition(i)[1], 0) / far.length;
  };
  const soft1 = await sag(1),
    stiff = await sag(10);
  assert.ok(
    soft1 / stiff > 5 && soft1 / stiff < 20,
    `ten times the stiffness sags about a tenth: ${soft1} against ${stiff}`,
  );
  const tears = async (resistance) => {
    const { physics, soft } = await create([0, 0, 0], 20, 4);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [0.6, 0.1, 0.1],
      [6, 1, 1],
      rubber({ youngsModulus: 5e4, tearStrain: 0.6 }),
    );
    const right = plane(desc, 0, 0.6);
    desc.setPinnedParticles([...plane(desc, 0, 0), ...right]);
    const body = soft.create(desc);
    body.setClusterTearResistance(body.addCluster(all(body)), resistance);
    for (let step = 0; step < 180; step++) {
      const t = Math.min(step / 60, 1);
      for (const i of right)
        body.setParticleKinematicTarget(i, [0.6 * (1 + 0.7 * t), desc.positions[i * 3 + 1], desc.positions[i * 3 + 2]]);
      physics.step();
    }
    return body.tornCells().length;
  };
  assert.ok(
    (await tears(1)) > 0 && (await tears(10)) === 0,
    'a cluster that is ten times as tough holds where the body tears',
  );
  const { physics, soft } = await create([0, -9.81, 0], 8, 4);
  const rope = soft.create(SoftBodyDesc.rope([0, 3, 0], [0, 1, 0], 11, { bending: false }).setPinnedParticles([0]));
  const loose = rope.addCluster(all(rope));
  rope.setClusterEdgeSoftness(loose, { naturalFrequency: 4, dampingRatio: 1 });
  steps(physics, 240);
  assert.ok(
    rope.particlePosition(10)[1] < 0.9,
    `soft edges in the cluster let the rope stretch: ${rope.particlePosition(10)[1]}`,
  );
  rope.setClusterEdgeSoftness(loose, null);
});

test('a cluster is pinned, driven to a pose, given a spring and removed', async () => {
  const { physics, soft } = await create([0, 0, 0], 8, 4);
  const desc = SoftBodyDesc.box([0, 0, 0], [0.4, 0.4, 0.4], [2, 2, 2], rubber({ youngsModulus: 1e5 }));
  const body = soft.create(desc),
    cluster = body.addCluster(all(body));
  body.setClusterKinematicTarget(cluster, [1, 2, 3], [0, 0, 0, 1]);
  steps(physics, 2);
  const centre = body.centerOfMass();
  near(centre[0], 1, 1e-3, 'the cluster went to the target x');
  near(centre[1], 2, 1e-3, 'y');
  near(centre[2], 3, 1e-3, 'and z');
  assert.ok(body.isParticlePinned(0), 'it stays pinned there');
  body.setClusterPinned(cluster, false);
  assert.ok(!body.isParticlePinned(0));
  const proxy = body.clusterProxy(cluster);
  body.removeCluster(cluster);
  assert.equal(body.numClusters(), 0);
  assert.equal(proxy.valid, false, 'the proxy goes with the cluster');
  assert.throws(() => body.clusterProxy(0), RangeError);
  // The root body is the cluster of everything, once.
  const root = body.rootBody();
  assert.equal(body.rootBody(), root);
  assert.equal(body.numClusters(), 1);
  soft.remove(body);
  assert.equal(root.valid, false, 'removing the body removes its root body');
});

test('a cluster spring that is switched on pulls a twisted body back to its shape', async () => {
  const twisted = async (on) => {
    const { physics, soft } = await create([0, 0, 0], 8, 4);
    const desc = SoftBodyDesc.box(
      [0, 0.5, 0],
      [0.4, 0.4, 0.4],
      [4, 4, 4],
      rubber({ youngsModulus: 2e3 }),
    ).setLinearDamping(1);
    const body = soft.create(desc),
      cluster = body.addCluster(all(body), 30);
    body.enableClusterShapeMatching(cluster, on);
    for (let i = 0; i < desc.particleCount; i++) {
      const [x, y, z] = [desc.positions[i * 3], desc.positions[i * 3 + 1], desc.positions[i * 3 + 2]],
        angle = x > 0.2 ? 0.6 : 0,
        c = Math.cos(angle),
        s = Math.sin(angle);
      body.setParticlePosition(i, [0.2 + (x - 0.2) * c - (z - 0.2) * s, y, 0.2 + (x - 0.2) * s + (z - 0.2) * c]);
    }
    steps(physics, 300);
    const p = body.particlePositions(),
      centre = body.centerOfMass();
    let worst = 0;
    for (let i = 0; i < desc.particleCount; i++)
      worst = Math.max(
        worst,
        Math.abs(
          Math.hypot(p[i * 3] - centre[0], p[i * 3 + 1] - centre[1], p[i * 3 + 2] - centre[2]) -
            Math.hypot(desc.positions[i * 3] - 0.2, desc.positions[i * 3 + 1] - 0.7, desc.positions[i * 3 + 2] - 0.2),
        ),
      );
    return worst;
  };
  assert.ok((await twisted(true)) < 1e-3, 'the spring holds the shape');
  assert.ok((await twisted(false)) > 0.02, 'without it the twist stays');
});

test('the fem solver gives a stiffness that does not depend on the passes, and holds a very stiff material', async () => {
  const side = 0.25;
  const sag = async (solver, substeps, iterations, youngsModulus = 3e6, cells = 12) => {
    const { physics, soft } = await create([0, -9.81, 0], substeps, iterations);
    const desc = SoftBodyDesc.box(
      [0, 0, 0],
      [1, side, side],
      [cells, cells / 4, cells / 4],
      rubber({ youngsModulus, density: 1000 }),
    );
    desc
      .setPinnedParticles(plane(desc, 0, 0))
      .setLinearDamping(4)
      .setSolver(solver);
    soft.cellDamping = 20;
    const body = soft.create(desc);
    steps(physics, 360);
    const far = plane(desc, 0, 1);
    assert.equal(body.solver, solver);
    return side / 2 - far.reduce((sum, i) => sum + body.particlePosition(i)[1], 0) / far.length;
  };
  const expected = (1000 * 9.81 * side * side) / (8 * 3e6 * (side ** 4 / 12));
  const [one, many] = [await sag('fem', 1, 1), await sag('fem', 8, 4)];
  assert.ok(Math.abs(one - many) < 0.03 * many, `one pass: ${one}, many: ${many}`);
  assert.ok(many > 0.8 * expected && many < 1.05 * expected, `tip sag ${many} against Euler-Bernoulli ${expected}`);
  const constraints = await sag('constraints', 1, 1);
  assert.ok(constraints > 2 * many, `the constraints with one pass sag far more: ${constraints} against ${many}`);
  // Steel-like stiffness and one substep: the implicit step does not blow up, and the beam hardly bends.
  const steel = await sag('fem', 1, 1, 2e9, 8);
  assert.ok(Number.isFinite(steel) && steel < 0.001, `a stiff beam hardly sags: ${steel}`);
});

test('the fem solver is switched by body, checked and carried to pieces', async () => {
  const { soft } = await create();
  assert.throws(() => SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [1, 1, 1]).setSolver('newton'), RangeError);
  const body = soft.create(SoftBodyDesc.box([0, 0, 0], [0.4, 0.4, 0.4], [2, 2, 2]).setSolver('fem'));
  assert.equal(body.solver, 'fem');
  body.setSolver('constraints');
  assert.equal(body.solver, 'constraints');
  assert.throws(() => body.setSolver('x'), RangeError);
  soft.splitOnTear = 'cells';
  const event = soft.cut(body.setSolver('fem'), [
    [0.2, -1, -1],
    [0.2, 3, -1],
    [0.2, -1, 3],
  ]);
  assert.equal(event.pieces.length, 2);
  assert.ok(event.pieces.every((piece) => piece.solver === 'fem'));
});

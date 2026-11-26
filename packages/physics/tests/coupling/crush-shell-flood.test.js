import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushShellSolver, SHELL_APERTURE_WORDS } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { HULL_BREACHES_FIELD, HULL_BREACH_WORDS, HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const gravity = [0, -9.81, 0];
const step = 1 / 60;
const discharge = 0.6;
const cell = [1, -1, 1];
const widthOfCell = 2;
const half = 0.5;
const mesh = {
  vertices: Float64Array.from(
    [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    (value) => value * half,
  ),
  indices: Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  ]),
};

function near(got, want, bound = 2e-12) {
  assert.ok(Math.abs(got - want) <= bound, `expected ${want}, got ${got}, tolerance ${bound}`);
}

async function setup({
  speed,
  wet = true,
  link = 0,
  pressure = false,
  pinned = [],
  fixed = pressure,
  vented = false,
  reverse = false,
}) {
  await Physics.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false), gravity });
  const physics = new Physics(null, { gravity, arena: world.arena, fixedTimestep: step });
  const body = physics.addBody(null, {
    ...(fixed ? { type: 'fixed' } : {}),
    colliders: { shape: 'box', halfExtents: [half, half, half], mass: 500, sensor: true },
  });
  const shell = pressure
    ? await CrushShellSolver.loadWithAperturePressure()
    : await CrushShellSolver.loadWithApertures();
  const options = { cellSize: widthOfCell };
  const hull = pressure
    ? HullSolver.withShellPressure(shell.apertureField, shell.aperturePressureField, options)
    : wet
      ? HullSolver.withShellApertures(shell.apertureField, options)
      : new HullSolver();
  const worldPositions = [
    [-0.3, -0.4, half],
    [0, -0.4, half],
    [0, -0.2, half],
    [0, -0.4, half],
    [0.3, -0.4, half],
    [0, -0.2, half],
  ];
  world.add(new RigidSolver(), { physics, capacity: physics.kernel.capacity });
  world.add(
    shell,
    {
      positions: worldPositions.map((p) => p.map((coordinate, axis) => coordinate - cell[axis] * widthOfCell)),
      triangles: [
        [0, 1, 2],
        [3, 4, 5],
      ],
      velocities: worldPositions.map((_, index) => [pinned.includes(index) ? 0 : index < 3 ? -speed : speed, 0, 0]),
      pinned,
      cellSize: widthOfCell,
      pressurePatches: pressure ? [{ seam: 0, faces: [0, 1] }] : undefined,
      material: { thickness: 0.015, density: 7800, youngModulus: 200e6, poissonRatio: 0.3, yieldStress: 350e3 },
      seams: [
        {
          sides: [
            [1, 2],
            [3, 5],
          ],
          stiffness: 4e5,
          peakTraction: 12e3,
          toughness: 600,
        },
      ],
    },
    cell,
  );
  world.add(hull, {
    hulls: [
      {
        row: body.row,
        mesh,
        compartments: [{ mesh, permeability: 1 }],
        openings: [
          {
            from: 0,
            to: 'outside',
            centre: [0, -0.25, half],
            normal: [0, 0, 1],
            width: 0.001,
            height: 0.001,
            discharge,
            shellSeam: wet ? link : undefined,
            opens: wet ? undefined : Infinity,
          },
          ...(vented
            ? [
                {
                  from: 0,
                  to: 'outside',
                  centre: [0, 0.4, half],
                  normal: [0, 0, 1],
                  width: 0.4,
                  height: 0.1,
                  discharge,
                },
              ]
            : []),
        ],
      },
    ],
    sea: { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) },
    gravity,
    addedMass: false,
    radiation: false,
    drag: false,
    rollDamping: false,
  });
  world.couple(reverse ? [hull.id, shell.id, 'rigid'] : [shell.id, hull.id, 'rigid'], 'staggered');
  const opening = () => {
    const p = world.fields.port(HULL_BREACHES_FIELD.name);
    const words = regionWords(world.memory, p.region);
    assert.equal(words[0], vented ? 2 : 1);
    return Array.from(words.slice(1, 1 + HULL_BREACH_WORDS));
  };
  const aperture = () => {
    const p = world.fields.port(shell.apertureField.name);
    assert.deepEqual(p.cell, cell);
    const words = regionWords(world.memory, p.region);
    assert.equal(words.length, SHELL_APERTURE_WORDS);
    return Array.from(words);
  };
  const readPressure = () => {
    const port = world.fields.port(shell.aperturePressureField.name);
    return Array.from(regionWords(world.memory, port.region));
  };
  return { world, physics, body, shell, opening, aperture, readPressure };
}

test('live released shell polygon determines SEA-10 inflow, area and receiver motion', async (t) => {
  const wet = await setup({ speed: 1.2 });
  using _wet = wet.physics;
  const dry = await setup({ speed: 1.2, wet: false });
  using _dry = dry.physics;
  wet.world.advance(1);
  const checkpoint = wet.world.takeSnapshot();
  const drive = () => {
    let frame = 1;
    while (!wet.shell.readSeam(0).broken && frame < 16) {
      assert.equal(wet.opening()[8], 0);
      assert.equal(wet.opening()[9], 0);
      wet.world.advance(++frame);
    }
    const breach = wet.opening();
    const edges = wet.aperture();
    const area = wet.shell.readSeam(0).openingArea;
    assert.ok(area > 0.015 && frame < 16);
    near(breach[8], area);
    near(edges[0], area);
    near(breach[4], half);
    near(breach[7], 1);
    const depths = [2, 5, 8, 11].map((index) => -(edges[index] + cell[1] * widthOfCell));
    const upperHead = Math.max(...depths);
    const upperFlux = discharge * area * Math.sqrt(2 * -gravity[1] * upperHead);
    const maxVolume = upperFlux * step;
    const waterHead = maxVolume;
    const airHead = (101325 * maxVolume) / (9810 * (1 - maxVolume));
    const lowerHead = Math.min(...depths) - waterHead - airHead;
    assert.ok(lowerHead > 0);
    const lowerFlux = discharge * area * Math.sqrt(2 * -gravity[1] * lowerHead);
    assert.ok(
      -breach[9] >= lowerFlux && -breach[9] <= upperFlux,
      `expected ${lowerFlux} to ${upperFlux}, got ${-breach[9]}`,
    );
    wet.world.advance(15);
    assert.ok(wet.opening()[8] > area);
    return { breach, position: wet.body.position, velocity: wet.body.linearVelocity, hash: wet.world.hash() };
  };
  const first = drive();
  t.diagnostic(`First shell opening ${first.breach[8].toFixed(6)} m², inflow ${(-first.breach[9]).toFixed(6)} m³/s.`);
  wet.world.restoreSnapshot(checkpoint.bytes);
  assert.deepEqual(drive(), first);
  dry.world.advance(15);
  assert.equal(dry.opening()[9], 0);
  assert.equal(dry.shell.readSeam(0).broken, true);
  assert.ok(wet.body.position[1] < dry.body.position[1] - 1e-4);
});

test('softening without complete rupture publishes no opening or water source', async () => {
  const scene = await setup({ speed: 0.55 });
  using _physics = scene.physics;
  scene.world.advance(12);
  const seam = scene.shell.readSeam(0);
  assert.equal(seam.broken, false);
  assert.ok(seam.fractureWork > 0);
  assert.equal(scene.aperture()[0], 0);
  assert.equal(scene.opening()[8], 0);
  assert.equal(scene.opening()[9], 0);
});

test('shell-linked hull rejects a missing aperture row by name', async () => {
  const scene = await setup({ speed: 0.55, link: 1 });
  using _physics = scene.physics;
  assert.throws(() => scene.world.advance(1), {
    code: 'state',
    message: /Choose a shellSeam within the aperture port/,
  });
});

test('SEA-10 returns two-sided hydrostatic head to an intact shell across cells', async () => {
  const scene = await setup({ speed: 0, pressure: true, pinned: [0, 1, 2, 3, 4, 5] });
  using _physics = scene.physics;
  scene.world.advance(1);
  assert.equal(scene.shell.supportReaction(0)[2], 0);
  const [active, outside, inside, air, weight] = scene.readPressure();
  assert.equal(active, 1);
  near(outside, 0);
  near(inside, -half);
  near(air, 0);
  near(weight, 9810);
  scene.world.advance(2);
  const reactions = Array.from({ length: 6 }, (_, vertex) => scene.shell.supportReaction(vertex)[2]);
  const total = reactions.reduce((sum, value) => sum + value, 0);
  const centroid = (0.4 + 0.4 + 0.2) / 3;
  near(total, 9810 * 0.06 * centroid, 1e-10);
  near(reactions[2], (9810 * 0.03 * (centroid + 0.2 / 3)) / 4, 1e-10);
  assert.equal(scene.shell.readSeam(0).broken, false);
  assert.equal(scene.opening()[9], 0);
});

test('shell pressure rejects a moving hull while stationary supports own the pressure load', async () => {
  const scene = await setup({ speed: 0, pressure: true, fixed: false });
  using _physics = scene.physics;
  assert.throws(() => scene.world.advance(1), {
    code: 'state',
    message: /Use a live, stationary fixed hull/,
  });
});

test('shell pressure rejects a reversed staggered order', async () => {
  const scene = await setup({ speed: 0, pressure: true, reverse: true });
  using _physics = scene.physics;
  assert.throws(() => scene.world.advance(1), {
    code: 'state',
    message: /Use the same rate and the order shell, hull, rigid/,
  });
});

test('live shell rupture fills the fixed hull and its new head changes shell motion on the following tick', async (t) => {
  const scene = await setup({ speed: 1.6, pressure: true, pinned: [0, 4] });
  using _physics = scene.physics;
  const vented = await setup({ speed: 1.6, pressure: true, pinned: [0, 4], vented: true });
  using _control = vented.physics;
  scene.world.advance(1);
  vented.world.advance(1);
  const saved = scene.world.takeSnapshot();
  const drive = (model) => {
    let frame = 1;
    while (!model.shell.readSeam(0).broken && frame < 16) model.world.advance(++frame);
    assert.ok(model.shell.readSeam(0).broken && frame < 16);
    const first = model.opening();
    const pressure = model.readPressure();
    assert.ok(first[8] > 0 && first[9] < 0);
    assert.ok(pressure[2] > -half);
    const before = model.shell.readMesh().positions;
    model.world.advance(frame + 1);
    return {
      first,
      pressure,
      before,
      z: model.shell.readMesh().positions[8],
      support: model.shell.supportReaction(0),
      hash: model.world.hash(),
    };
  };
  const result = drive(scene);
  const control = drive(vented);
  near(result.first[8], control.first[8], 1e-11);
  assert.deepEqual(result.before, control.before);
  assert.ok(result.pressure[3] > control.pressure[3] + 20);
  assert.ok(result.z > control.z + 1e-6);
  scene.world.restoreSnapshot(saved.bytes);
  assert.deepEqual(drive(scene), result);
  t.diagnostic(
    `First aperture ${result.first[8].toFixed(5)} m²; gauge pressure ${result.pressure[3].toFixed(3)} vs ${control.pressure[3].toFixed(3)} Pa vented. Following tick shell position differs by ${(1e6 * (result.z - control.z)).toFixed(2)} µm.`,
  );
});

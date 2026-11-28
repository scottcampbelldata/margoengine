import { Physics } from '@margoengine/physics';
import {
  Flooding,
  HULL_BREACHES_FIELD,
  HullSolver,
  loadFloodVolumeKernel,
  SEA_WATER,
} from '@margoengine/physics/seakeeping';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

export function floodBox([x0, y0, z0], [x1, y1, z1]) {
  return {
    vertices: Float64Array.of(
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ),
    indices: Uint32Array.of(
      0,
      3,
      2,
      0,
      2,
      1,
      4,
      5,
      6,
      4,
      6,
      7,
      0,
      1,
      5,
      0,
      5,
      4,
      3,
      7,
      6,
      3,
      6,
      2,
      0,
      4,
      7,
      0,
      7,
      3,
      1,
      2,
      6,
      1,
      6,
      5,
    ),
  };
}

export function refineFloodMesh(mesh, passes) {
  const midpoint = (a, b) => a.map((x, i) => (x + b[i]) / 2);
  let triangles = [];
  for (let i = 0; i < mesh.indices.length; i += 3)
    triangles.push(
      Array.from(mesh.indices.subarray(i, i + 3), (at) => Array.from(mesh.vertices.subarray(3 * at, 3 * at + 3))),
    );
  for (let i = 0; i < passes; i++) {
    triangles = triangles.flatMap(([a, b, c]) => {
      const ab = midpoint(a, b),
        bc = midpoint(b, c),
        ca = midpoint(c, a);
      return [
        [a, ab, ca],
        [ab, b, bc],
        [bc, c, ca],
        [ab, bc, ca],
      ];
    });
  }
  return {
    vertices: Float64Array.from(triangles.flat(2)),
    indices: Uint32Array.from({ length: 3 * triangles.length }, (_, i) => i),
  };
}

export function equalFloodWords(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

const compartments = [
  { mesh: floodBox([-3.5, -1.5, -1.9], [-0.25, 1.5, 2]), water: 7.2, permeability: 0.8 },
  { mesh: floodBox([0.25, -1.5, -1.9], [3.5, 1.5, 2]), water: 2.4, permeability: 0.9 },
];
const openings = [
  { from: 0, to: 'outside', centre: [-2, -1.25, 2], normal: [0, 0, 1], width: 0.45, height: 0.36 },
  { from: 0, to: 1, centre: [0, -0.7, 0.5], normal: [1, 0, 0], width: 0.35, height: 0.4 },
  { from: 1, to: 'outside', centre: [2, 1.45, 2], normal: [0, 0, 1], width: 0.2, height: 0.1 },
];

export function standaloneFlood(kernel) {
  const flood = new Flooding(compartments, openings, kernel);
  const state = new Float64Array(flood.words);
  flood.initialise(state);
  const sea = { elevation: () => 0, density: SEA_WATER };
  for (let tick = 0; tick < 5; tick++) {
    const roll = 0.15 + tick * 0.02;
    flood.step(
      state,
      { position: [0, -0.5, 0], rotation: [Math.sin(roll), 0, 0, Math.cos(roll)] },
      sea,
      (tick + 0.5) / 60,
      1 / 60,
      SEA_WATER,
      9.81,
    );
  }
  const previousBatches = kernel?.workCounts().batches;
  const sameRoll = 0.15 + 4 * 0.02;
  flood.step(
    state,
    { position: [0, -0.375, 0], rotation: [Math.sin(sameRoll), 0, 0, Math.cos(sameRoll)] },
    sea,
    5.5 / 60,
    1 / 60,
    SEA_WATER,
    9.81,
  );
  const cacheSkipped = kernel?.workCounts().batches === previousBatches;
  return {
    state,
    levels: flood.result.level.slice(),
    water: flood.result.water.slice(),
    air: flood.result.air.slice(),
    cacheSkipped,
  };
}

export async function followFlood(threads) {
  using kernel = threads === undefined ? undefined : await loadFloodVolumeKernel({ threads });
  await Physics.load();
  const signed = [1_170_000_000, -1_070_000_000, 2_000_000_000];
  const delta = [4_100_000, -21_500_000, 17_300_000];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false), cellSize: 1 });
  using physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const body = physics.addBody(null, {
    position: [0, -0.38, 0],
    rotation: [Math.sin(0.16), 0, 0, Math.cos(0.16)],
    angularVelocity: [0.2, 0, 0],
    colliders: { shape: 'box', halfExtents: [4, 1.7, 2], mass: 62_000 },
  });
  const hull = new HullSolver();
  const sea = { elevation: () => 0, density: SEA_WATER, cell: signed };
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh: floodBox([-4, -1.7, -2], [4, 1.7, 2]), compartments, openings }],
      sea,
      originCellSize: 1,
      stations: 8,
      floodVolumeKernel: kernel,
      slamming: false,
      addedMass: false,
      radiation: false,
      drag: false,
      greenWater: false,
      diffraction: false,
      rollDamping: false,
    })
    .couple(['hull', 'rigid'], 'staggered');
  world.setCell('hull', signed).setCell('rigid', signed);
  world.advance(4);
  const start = world.takeSnapshot();
  function run() {
    kernel?.resetWork();
    world.shiftOrigin(delta);
    sea.cell = signed.map((cell, axis) => cell - delta[axis]);
    world.advance(16);
    const port = hull.exportPorts(15).find(({ field }) => field === HULL_BREACHES_FIELD.name);
    const breaches = regionWords(world.memory, port.region).slice();
    return {
      accepted: world.takeSnapshot(),
      breaches,
      cell: Array.from(world.cellOf('hull')),
      compartments: hull.floodedCompartments(body.row),
      work: kernel?.workCounts(),
    };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  return {
    ...result,
    start,
    replay,
    exact:
      equalFloodWords(result.accepted.bytes, replay.accepted.bytes) &&
      equalFloodWords(result.breaches, replay.breaches),
  };
}

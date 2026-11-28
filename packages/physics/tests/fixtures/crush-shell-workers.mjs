import { CrushShellSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const material = {
  thickness: 0.015,
  density: 7800,
  youngModulus: 200e6,
  poissonRatio: 0.3,
  yieldStress: 350e3,
  hardeningModulus: 1.2e6,
};
const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const delta = [4_100_000, -21_500_000, 17_300_000];

export const rebasedCell = signedCell.map((value, axis) => value - delta[axis]);

export function equalShellWords(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export function shellSheet(columns, rows) {
  const stride = columns + 1;
  const positions = [];
  const triangles = [];
  const pinned = [];
  for (let y = 0; y <= rows; y++) {
    pinned.push(positions.length);
    for (let x = 0; x <= columns; x++) positions.push([0.2 * x, -0.6 + 0.18 * y, 0]);
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const a = y * stride + x;
      triangles.push([a, a + 1, a + stride + 1], [a, a + stride + 1, a + stride]);
    }
  }
  triangles.pop();
  const velocities = positions.map(([x, y]) => [0.625 * x, 0.12 * x * y, 0.07 * x]);
  return { positions, triangles, pinned, velocities };
}

function connectPressure(world, shell, params) {
  const first = params.positions.length;
  params.positions.push([-1.3, -0.4, 0], [-1, -0.4, 0], [-1, -0.2, 0], [-1, -0.4, 0], [-0.7, -0.4, 0], [-1, -0.2, 0]);
  params.triangles.push([first, first + 1, first + 2], [first + 3, first + 4, first + 5]);
  for (let i = 0; i < 6; i++) {
    params.pinned.push(first + i);
    params.velocities.push([0, 0, 0]);
  }
  params.seams = [
    {
      sides: [
        [first + 1, first + 2],
        [first + 3, first + 5],
      ],
      stiffness: 4e5,
      peakTraction: 12e3,
      toughness: 600,
    },
  ];
  const faces = params.triangles.map((_, face) => face).filter((face) => face % 3 === 0);
  params.pressurePatches = [{ seam: 0, faces }];

  const field = shell.aperturePressureField;
  const id = 'panel-pressure-control';
  let pressure;
  const provider = {
    describe: () => ({ id, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(host) {
      pressure = host.allocate('head-and-air-pressure', 40, 'f64', 1);
      regionWords(host.memory, pressure).set([1, 0.14, -0.4, 270, 9810]);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region: pressure, tick, cell: [0, 0, 0] }],
    stateRegions: () => [pressure],
    extraState: () => [],
  };
  world.add(shell, params).setCell(shell.id, signedCell).add(provider, {}).setCell(id, signedCell);
  world.couple([shell.id, id], 'staggered');
  return faces.length;
}

export async function followCrushShell(threads = 1, shared = threads > 1, withPressure = false) {
  const id = 'signed-shell-panel';
  using shell = withPressure
    ? await CrushShellSolver.loadWithAperturePressure({ id, threads })
    : await CrushShellSolver.load({ id, threads });
  const params = {
    ...(withPressure ? shellSheet(15, 7) : shellSheet(11, 5)),
    material: withPressure
      ? { ...material, anisotropy: { rollingDirection: [1, 0.2, 0], r0: 0.68, r45: 0.55, r90: 0.93 } }
      : material,
    cellSize: 1,
    recordWork: true,
  };
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 1,
    gravity: [0, 0, 0],
  });
  let pressureFaceCount = 0;
  if (withPressure) pressureFaceCount = connectPressure(world, shell, params);
  else world.add(shell, params).setCell(id, signedCell);
  world.advance(2);
  const start = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    const receipts = [];
    for (let tick = 3; tick <= 6; tick++) {
      world.advance(tick);
      receipts.push(shell.readNativeWork());
    }
    const port = world.fields.port(shell.positionField.name);
    return {
      accepted: world.takeSnapshot(),
      positions: regionWords(world.memory, port.region).slice(),
      budget: shell.readBudget(),
      work: shell.readWork(),
      cell: Array.from(port.cell),
      receipts,
    };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  return { ...result, replay, faceCount: params.triangles.length, pressureFaceCount };
}

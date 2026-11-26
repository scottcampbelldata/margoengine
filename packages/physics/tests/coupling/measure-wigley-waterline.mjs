// Compare SEA-08 advance displacement with an independent tow-tank waterline.
// Run after a Physics build with the cell size, 0.05 or 0.025 m.
import { Physics } from '../../dist/index.js';
import { WakeSolver } from '../../dist/sea.js';
import { HullSolver, volumeBelow } from '../../dist/seakeeping.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

const length = 2.5;
const beam = 0.25;
const draft = 0.156;
const tankDepth = 2.35;
const gravity = 9.8;
const density = 1000;
const frame = 240;
const cellSize = Number(process.argv[2] ?? 0.05);
if (cellSize !== 0.05 && cellSize !== 0.025) throw new RangeError('Pass a cell size of 0.05 or 0.025 metres.');
const cells = [12 / cellSize, 4 / cellSize];

/** Kajitani et al. (1983), section 1: the reported parabolic surface below the waterline. */
function wigleyMesh(stations, levels) {
  const side = Array.from({ length: levels }, (_, j) => {
    const y = (-draft * (levels - j - 1)) / levels;
    return [y, 1 - (y / draft) ** 2];
  });
  // A vertical closure above the reference waterline gives a closed hull and contributes no displaced area.
  const profile = [[-draft, 0], ...side, [0.1, 1], [0.1, -1], ...side.map(([y, z]) => [y, -z]).reverse()];
  const stride = profile.length;
  const vertices = new Float64Array(3 * (stations + 1) * stride);
  const indices = [];
  for (let i = 0; i <= stations; i++) {
    const x = length * (i / stations - 0.5);
    const halfBeam = (beam / 2) * (1 - ((2 * x) / length) ** 2);
    for (let j = 0; j < stride; j++) {
      const [y, width] = profile[j];
      const a = i * stride + j;
      vertices.set([x, y, halfBeam * width], 3 * a);
      if (i === stations) continue;
      const b = a + stride;
      const d = i * stride + ((j + 1) % stride);
      indices.push(a, b, d + stride, a, d + stride, d);
    }
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

// The observed g*zeta/U^2 values are Table I's University of Tokyo fixed-trim/fixed-sinkage profiles, printed to 0.001.
// The paper's 2x/L axis runs from bow to stern. The data are read only after the independent predictions.
const positions = [-1, -0.95, -0.9, -0.85, -0.8, -0.75, -0.7, -0.6, -0.5, -0.4, 0, 1];
const cases = [
  {
    froude: 0.267,
    observed: [0.246, 0.358, 0.336, 0.224, 0.101, -0.011, -0.09, -0.168, -0.157, -0.112, -0.022, 0.157],
  },
  { froude: 0.316, observed: [0.16, 0.312, 0.328, 0.264, 0.192, 0.104, 0.024, -0.088, -0.144, -0.16, -0.048, 0.024] },
];

await Physics.load();
const mesh = wigleyMesh(48, 24);
const mass = density * volumeBelow(mesh, [0, 1, 0], 0);
for (const { froude, observed } of cases) {
  const speed = froude * Math.sqrt(gravity * length);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, substeps: 1 });
  const body = physics.addBody(null, {
    position: [-3.5, 0, 0],
    linearVelocity: [speed, 0, 0],
    enabledTranslations: [true, false, false],
    enabledRotations: [false, false, false],
    colliders: { shape: 'box', halfExtents: [length / 2, draft, beam / 2], mass },
  });
  const hull = new HullSolver('hull', { minimumRadius: cellSize / Math.sqrt(2), advance: true });
  const wake = new WakeSolver('wake', hull.wakeSourceField);
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh }],
      sea: { density, elevation: () => 0 },
      drag: false,
      radiation: false,
      rollDamping: false,
      greenWater: false,
      slamming: false,
    })
    .add(wake, { cells, cellSize, depth: tankDepth, sponge: 5, density })
    .couple(['hull', 'wake', 'rigid'], 'staggered');
  world.advance(frame);
  const [origin] = body.position;
  const predicted = positions.map((p) => {
    const x = (-p * length) / 2;
    const z = (beam / 2) * (1 - p * p);
    return (wake.sample(origin + x, z).height * gravity) / (speed * speed);
  });
  const round = (value) => Number(value.toFixed(4));
  console.log(JSON.stringify({ froude, cellSize, speed, frame }));
  console.table(
    positions.map((p, i) => ({
      '2x/L': p,
      observed: observed[i],
      predicted: round(predicted[i]),
      residual: round(predicted[i] - observed[i]),
    })),
  );
}

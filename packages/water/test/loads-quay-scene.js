// Fixed component fixture for FW-6 and CY-9. Concrete wharf and timber fender proportions
// follow the visible arrangement in the Port of Seattle Salmon Bay Marina condition report.
// https://www.portseattle.org/sites/default/files/2025-09/Salmon%20Bay%20Marina%20Docks%20A%2C%20B%2C%20C%20Closure%20%20-%20Supporting%20Documents%20V3.pdf
import { EngineKernel, Geometry, PbrMaterial, box } from '/packages/core/dist/index.js';
import { Physics } from '/packages/physics/dist/index.js';
import { LoadSolver, QuayWall } from '/packages/physics/dist/loads.js';
import { SpectralSea, WakeSolver } from '/packages/physics/dist/sea.js';
import { HullSolver } from '/packages/physics/dist/seakeeping.js';
import { jonswap } from '/packages/physics/dist/waves.js';
import { PhysicsWorld, RigidSolver } from '/packages/physics/dist/world.js';
import { Water } from '/packages/water/dist/index.js';
import { WaveQuery } from '/packages/water/dist/query.js';
import { WaterWake } from '/packages/water/dist/wake.js';

const RATE = 60;
const DT = 1 / RATE;
const END = 96;
const REPLAY_START = 16;
const DEPTH = 3.4;
const DENSITY = 1025;
const WALL = -2.8;

// Closed hull section in metres, shared by the renderer, collider and wet-surface integrator.
function sectionMesh(stations, low, high, breadth) {
  const points = [],
    triangles = [],
    sides = 8;
  for (const [x, width] of stations) {
    const b = width * breadth;
    for (const [y, z] of [
      [low, -0.78 * b],
      [low, 0.78 * b],
      [low + 0.11, b],
      [high - 0.08, b],
      [high, 0.87 * b],
      [high, -0.87 * b],
      [high - 0.08, -b],
      [low + 0.11, -b],
    ])
      points.push(x, y, z);
  }
  for (let k = 0; k < stations.length - 1; k++) {
    for (let i = 0; i < sides; i++) {
      const a = k * sides + i,
        b = k * sides + ((i + 1) % sides);
      triangles.push(a, b + sides, b, a, a + sides, b + sides);
    }
  }
  const last = (stations.length - 1) * sides;
  for (let i = 1; i < sides - 1; i++) triangles.push(0, i, i + 1, last, last + i + 1, last + i);
  return { vertices: new Float64Array(points), indices: new Uint32Array(triangles) };
}

function flatGeometry({ vertices, indices }) {
  const positions = [],
    normals = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertices.subarray(3 * indices[i], 3 * indices[i] + 3);
    const b = vertices.subarray(3 * indices[i + 1], 3 * indices[i + 1] + 3);
    const c = vertices.subarray(3 * indices[i + 2], 3 * indices[i + 2] + 3);
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const size = Math.hypot(...n);
    positions.push(...a, ...b, ...c);
    for (let j = 0; j < 3; j++) normals.push(n[0] / size, n[1] / size, n[2] / size);
  }
  return new Geometry(
    positions,
    normals,
    Array.from({ length: positions.length / 3 }, (_, i) => i),
  );
}

const workboat = sectionMesh(
  [
    [-1.95, 0.78],
    [-1.68, 1],
    [0.65, 1],
    [1.5, 0.68],
    [1.95, 0.16],
  ],
  -0.53,
  0.42,
  0.79,
);
const salvage = sectionMesh(
  [
    [-0.81, 0.88],
    [-0.72, 1],
    [0.72, 1],
    [0.81, 0.88],
  ],
  -0.24,
  0.24,
  0.5,
);

function spectrum() {
  const nf = 10,
    nd = 12;
  const waves = {
    frequencies: Float64Array.from({ length: nf }, (_, i) => 0.2 * 9 ** (i / (nf - 1))),
    directions: Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
    energy: new Float64Array(nf * nd),
    depth: DEPTH,
    density: DENSITY,
  };
  jonswap({ height: 0.18, period: 1.7, direction: -Math.PI / 2 }, waves);
  return waves;
}

function makePhysics(active) {
  const world = new PhysicsWorld({ rate: { num: RATE, den: 1 } });
  const physics = new Physics(null, { fixedTimestep: DT, arena: world.arena });
  const hull = new HullSolver('hull', { minimumRadius: 0.42, advance: true });
  const wake = new WakeSolver('wake', active ? hull.wakeSourceField : undefined);
  const waves = spectrum();
  const sea = new SpectralSea({ waves, seed: 17, patches: [wake] });
  const berth = new QuayWall({ from: [-6, WALL], to: [4, WALL], freeboard: 0.31, points: 20 });
  const boat = physics.addBody(null, {
    position: [-3.6, 0.1, -1.65],
    linearVelocity: [2.7, 0, 0],
    enabledTranslations: [true, true, false],
    enabledRotations: [false, false, false],
    colliders: { shape: 'convexHull', points: workboat.vertices, mass: 2050 },
  });
  const raft = physics.addBody(null, {
    position: [-1.8, 0.09, 0.07],
    rotation: [Math.sin(Math.PI / 16), 0, 0, Math.cos(Math.PI / 16)],
    colliders: { shape: 'convexHull', points: salvage.vertices, mass: 250 },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [-1, -0.8, WALL - 0.7],
    colliders: { shape: 'box', halfExtents: [5, 1.1, 0.7] },
  });
  world.add(new RigidSolver(), { physics });
  world.add(hull, {
    hulls: [{ row: boat.row, mesh: workboat }],
    sea,
    addedMass: false,
    drift: false,
    radiation: false,
    rollDamping: false,
    greenWater: false,
    slamming: false,
  });
  world.add(wake, { cells: [64, 48], cellSize: 0.3, depth: DEPTH, density: DENSITY, sponge: 4, waterBelow: true });
  world.add(new LoadSolver(), {
    sea,
    bodies: [{ row: raft.row, shape: { mesh: salvage }, pressureModel: 'surface', addedMass: [0, 0, 0] }],
  });
  world.couple(['hull', 'wake', 'loads', 'rigid'], 'staggered');
  return { world, physics, wake, sea, berth, boat, raft };
}

function advance(run, summarize = false) {
  const { world, berth, sea, boat, raft } = run;
  const rollAngle = () => {
    const [x, y, z, w] = raft.rotation;
    return Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  };
  let nearFace = { crest: -Infinity, wash: 0 };
  let minY = raft.position[1],
    maxY = minY;
  let minRoll = rollAngle(),
    maxRoll = minRoll;
  for (let frame = REPLAY_START + 1; frame <= END; frame++) {
    world.advance(frame);
    if (summarize && frame % 4 === 0) {
      for (const point of berth.sample(frame * DT, sea, sea.water)) {
        nearFace = { crest: Math.max(nearFace.crest, point.height), wash: Math.max(nearFace.wash, point.wash) };
      }
      minY = Math.min(minY, raft.position[1]);
      maxY = Math.max(maxY, raft.position[1]);
      const roll = rollAngle();
      minRoll = Math.min(minRoll, roll);
      maxRoll = Math.max(maxRoll, roll);
    }
  }
  return {
    boat: boat.position,
    boatVelocity: boat.linearVelocity,
    raft: raft.position,
    rotation: raft.rotation,
    nearFace,
    heave: maxY - minY,
    roll: maxRoll - minRoll,
  };
}

function visualScene(engine) {
  const material = (color, roughness) => new PbrMaterial({ color, roughness });
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const solid = (size, material, position) => part(box(...size), material, position);
  const concrete = material('#96928b', 0.92),
    cap = material('#b6aea4', 0.78);
  const tar = material('#393c3b', 0.91),
    cream = material('#dfdbc7', 0.52),
    rubber = material('#423e3a', 0.8);
  const rust = material('#a43f31', 0.66),
    amber = material('#dbaa49', 0.69),
    glass = material('#35536a', 0.29);
  const hull = part(flatGeometry(workboat), rust, [0, 0, 0]);
  solid([1.3, 0.58, 1.18], cream, [-0.36, 0.71, 0]).setParent(hull);
  solid([0.91, 0.23, 1.2], glass, [-0.21, 0.81, 0]).setParent(hull);
  solid([1.42, 0.1, 1.28], tar, [-0.35, 1.04, 0]).setParent(hull);
  solid([0.09, 0.5, 0.09], tar, [-0.33, 1.32, 0]).setParent(hull);
  const crate = part(flatGeometry(salvage), amber, [0, 0, 0]);
  for (const x of [-0.42, 0.42]) solid([0.11, 0.04, 0.83], tar, [x, 0.26, 0]).setParent(crate);
  solid([10, 2.2, 1.4], concrete, [-1, -0.8, WALL - 0.7]);
  solid([10, 0.16, 1.52], cap, [-1, 0.37, WALL - 0.78]);
  for (const x of [-4.7, -2.3, 0.1, 2.5]) solid([0.25, 1.09, 0.19], rubber, [x, -0.23, WALL + 0.08]);
  solid([0.18, 0.48, 0.26], rust, [0.7, 0.65, WALL - 0.54]);
  return { hull, crate };
}

export async function createLoadsQuayScene(canvas) {
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    capacity: 24,
    camera: { position: [4.6, 3.0, 7.5], target: [-1.05, 0.12, -1.12], fov: 46, near: 0.2, far: 75 },
  });
  engine.gpu.pushErrorScope('validation');
  engine.scene.background = '#a7b6bf';
  engine.lighting.direction.set([0.3, 0.7, 0.38, 2.1]);
  engine.lighting.radiance.set([1, 0.89, 0.75, 0.22]);
  engine.lighting.ambient.set([0.53, 0.62, 0.73]);
  await Physics.load();
  const run = makePhysics(true);
  const control = makePhysics(false);
  control.world.advance(REPLAY_START);
  const expected = advance(control, true);
  control.physics[Symbol.dispose]();
  const props = visualScene(engine);
  const water = Water.attach(engine, { size: [42, 34], segments: 128, sea: run.sea });
  const effect = WaterWake.attach(engine, { surface: water, wake: run.wake });
  const render = (frame) => {
    props.hull.setPosition(run.boat.position).setQuaternion(run.boat.rotation);
    props.crate.setPosition(run.raft.position).setQuaternion(run.raft.rotation);
    water.setTime(frame * DT);
    engine.render({ delta: 0 });
  };
  render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  return {
    async depart() {
      // Initialize the rigid solver's force region before taking the replay snapshot.
      run.world.advance(REPLAY_START);
      const start = run.world.takeSnapshot();
      const actual = advance(run, true);
      const hash = run.world.hash();
      run.world.restoreSnapshot(start.bytes);
      advance(run);
      const replay = run.world.hash();
      render(END);
      await engine.gpu.queue.onSubmittedWorkDone();
      const awake = (await WaveQuery.capture(water)).vertices;
      effect.dispose();
      render(END);
      const noWake = (await WaveQuery.capture(water)).vertices;
      let peakAtQuay = 0,
        worst = 0;
      for (let i = 0; i < awake.length; i += 12) {
        const x = awake[i + 3],
          z = awake[i + 7];
        if (x < -5 || x > 3 || z < WALL || z > WALL + 0.4) continue;
        const wake = run.wake.sample(x, z).height;
        peakAtQuay = Math.max(peakAtQuay, Math.abs(wake));
        worst = Math.max(worst, Math.abs(awake[i + 1] - noWake[i + 1] - wake));
      }
      return { actual, expected, hash, replay, peakAtQuay, worst };
    },
    restoreWake() {
      WaterWake.attach(engine, { surface: water, wake: run.wake });
      render(END);
      return engine.gpu.queue.onSubmittedWorkDone();
    },
    async dispose() {
      const validation = await engine.gpu.popErrorScope();
      water.dispose();
      run.physics[Symbol.dispose]();
      engine.dispose();
      return validation?.message ?? null;
    },
  };
}

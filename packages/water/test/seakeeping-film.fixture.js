import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { computeVertexNormals, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { Physics } from '@margoengine/physics';
import { SpectralSea, WakeSolver } from '@margoengine/physics/sea';
import { HullSolver, wettedLoads } from '@margoengine/physics/seakeeping';
import { bandWidth } from '@margoengine/physics/waves';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaterWake } from '@margoengine/water/wake';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const rate = 60;
const gravity = 9.81;
const density = 1000;
const waveAmplitude = 0.55;
const wavePeriod = 4.5;
const cue = 15;
const duration = 240;
const width = 768;
const height = 456;
const courseSpeed = 1.25;
const camera = { position: [16.3, 7.5, 22.5], target: [1.4, 0.48, 0], fov: 35, near: 0.2, far: 480 };
const still = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function loft() {
  // Local X forward, local Y up. The same closed mesh goes into the pressure solve and the exterior draw.
  const stations = [
    [-8.4, 0.48],
    [-7.9, 0.65],
    [-6.8, 0.86],
    [-5, 0.98],
    [-3, 1],
    [0, 1],
    [3, 0.98],
    [4.85, 0.92],
    [6.25, 0.74],
    [7.42, 0.48],
    [8.08, 0.24],
    [8.4, 0.065],
  ];
  const ring = [
    [1.05, 0],
    [1.05, -1.7],
    [0.49, -1.87],
    [0.14, -1.89],
    [0.035, -1.905],
    [-0.36, -1.88],
    [-0.92, -1.56],
    [-1.34, -0.83],
    [-1.43, 0],
    [-1.34, 0.83],
    [-0.92, 1.56],
    [-0.36, 1.88],
    [0.035, 1.905],
    [0.14, 1.89],
    [0.49, 1.87],
    [1.05, 1.7],
  ];
  const vertices = [];
  const triangles = [];
  const groups = [[], [], [], []];
  const uv = [];
  const n = ring.length;
  for (let index = 0; index < stations.length; index++) {
    const [x, beam] = stations[index];
    for (let k = 0; k < n; k++) {
      const [y, z] = ring[k];
      const bowSheer = (1 - beam) * (x > 0 ? 0.54 : 0.15) * (y < 0 ? (-y / 1.43) * 0.59 : y / 1.05);
      vertices.push(x, y + bowSheer, beam * z);
      uv.push(index / (stations.length - 1), k / n);
      if (index === 0) continue;
      const a = (index - 1) * n + k;
      const b = (index - 1) * n + ((k + 1) % n);
      const finish = k === 0 || k === n - 1 ? 3 : k === 3 || k === 12 ? 1 : k >= 4 && k <= 11 ? 0 : 2;
      groups[finish].push(a, a + n, b, b, a + n, b + n);
      triangles.push(a, a + n, b, b, a + n, b + n);
    }
  }
  for (let side = 0; side < 2; side++) {
    const end = side ? (stations.length - 1) * n : 0;
    const middle = vertices.length / 3;
    const cap = [];
    vertices.push(vertices[3 * end], 0, 0);
    uv.push(0.5, 0.5);
    for (let i = 0; i < n; i++) {
      const a = end + i;
      const b = end + ((i + 1) % n);
      cap.push(...(side ? [a, middle, b] : [a, b, middle]));
    }
    groups[2].push(...cap);
    triangles.push(...cap);
  }
  let signedVolume = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3).map((j) => vertices.slice(3 * j, 3 * j + 3));
    signedVolume +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (signedVolume < 0)
    for (const faces of [triangles, ...groups])
      for (let i = 0; i < faces.length; i += 3) [faces[i + 1], faces[i + 2]] = [faces[i + 2], faces[i + 1]];
  const raw = { vertices: Float64Array.from(vertices), indices: Uint32Array.from(triangles) };
  const buoyancy = wettedLoads(raw, still, { density, elevation: () => 0 }, 0, [0, 0, 0]);
  const balance = buoyancy.torque[2] / buoyancy.force[1];
  for (let i = 0; i < raw.vertices.length; i += 3) raw.vertices[i] -= balance;
  return { mesh: raw, groups, uv, balance, mass: buoyancy.force[1] / gravity };
}

function obliqueSea(windward, wake) {
  const f = 1 / wavePeriod;
  const frequencies = Float64Array.of(f - 0.05, f, f + 0.05);
  const directions = Float64Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6);
  const energy = new Float64Array(frequencies.length * directions.length);
  if (windward) energy[12 + 2] = waveAmplitude ** 2 / (2 * bandWidth(frequencies, 1) * (Math.PI / 6));
  return new SpectralSea({
    waves: { frequencies, directions, energy, depth: 30, density },
    seed: 49,
    ...(wake && { patches: [wake] }),
  });
}

export async function seakeepingWorld(windward, withWake, ship = loft()) {
  await Physics.load();
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity: [0, -gravity, 0], arena: world.arena });
  const body = physics.addBody(null, {
    position: [-1, 0, 0],
    linearVelocity: [courseSpeed, 0, 0],
    colliders: { shape: 'box', halfExtents: [7.7, 0.91, 1.57], mass: ship.mass },
  });
  const hull = new HullSolver('hull', withWake ? { minimumRadius: 0.72, advance: true } : undefined);
  const wake = withWake ? await WakeSolver.load({ sourceField: hull.wakeSourceField }) : undefined;
  const sea = obliqueSea(windward, wake);
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh: ship.mesh, course: { speed: courseSpeed } }],
    sea,
    stations: 16,
    memory: 12,
    greenWater: false,
    slamming: false,
  });
  if (wake) world.add(wake, { cells: [64, 64], cellSize: 0.85, depth: 30, sponge: 6, waterBelow: true });
  world.couple(wake ? ['hull', 'wake', 'rigid'] : ['hull', 'rigid'], 'staggered');
  return { world, physics, hull, wake, sea, body, ship };
}

function angles(rotation) {
  const f = rotateByQuaternion([1, 0, 0], rotation);
  const s = rotateByQuaternion([0, 0, 1], rotation);
  return [(Math.asin(f[1]) * 180) / Math.PI, (Math.asin(s[1]) * 180) / Math.PI];
}

export function seaMotion(take) {
  const { body, world, wake } = take;
  const pose = world.fields.port(BODIES_FIELD.name);
  if (pose?.region.layout !== 2 || pose.region.type !== 'f32') throw new Error('Use the accepted layout-2 hull pose.');
  const view = regionWords(world.memory, pose.region);
  const offset = body.row * BODY_WORDS;
  const position = Array.from(view.subarray(offset, offset + 3));
  const rotation = Array.from(view.subarray(offset + 3, offset + 7));
  const [pitch, roll] = angles(rotation);
  let wakePeak = 0;
  for (const height of wake?.heights() ?? []) wakePeak = Math.max(wakePeak, Math.abs(height));
  return { time: world.time, position, rotation, pitch, roll, wakePeak };
}

function boat(engine, ship) {
  const root = engine.createMesh();
  root.name = 'Lake service freighter';
  const paint = (color, roughness = 0.8) => new PbrMaterial({ color, roughness });
  const oxide = paint('#8e4e42');
  const waterline = paint('#b79266');
  const navy = paint('#254454', 0.69);
  const deck = paint('#716354');
  const ivory = paint('#ded4be', 0.62);
  const glass = paint('#345b63', 0.28);
  const timbers = paint('#9e724b');
  const rail = paint('#ddd2bb', 0.58);
  const iron = paint('#3f4a50', 0.62);
  const positions = Float32Array.from(ship.mesh.vertices);
  const uvs = Float32Array.from(ship.uv);
  const all = computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, ship.mesh.indices));
  [oxide, waterline, navy, deck].forEach((material, i) => {
    const group = geometryData(positions, all.normals, uvs, Uint32Array.from(ship.groups[i]));
    engine.createMesh(root).setGeometry(toGeometry(group)).setMaterial(material);
  });
  function part(geometry, material, x, y, z) {
    return engine
      .createMesh(root)
      .setGeometry(geometry)
      .setMaterial(material)
      .setPosition([x - ship.balance, y, z]);
  }
  function slab([a, b, c], colour, x, y, z, r = 0) {
    const geometry = r > 0 ? toGeometry(roundedBoxGeometry(a, b, c, 2, r)) : box(a, b, c);
    return part(geometry, colour, x, y, z);
  }
  // Cargo covers sit in coamings, the forward deckhouse carries segmented pilot glass,
  // and the aft machinery house keeps separation from the holds.
  for (const x of [-4.25, -2.14, -0.03, 2.08]) {
    slab([1.84, 0.22, 2.48], iron, x, 1.13, 0, 0.03);
    slab([1.72, 0.12, 2.38], timbers, x, 1.28, 0, 0.024);
    for (const rib of [-0.47, 0, 0.47]) slab([0.046, 0.03, 2.26], iron, x + rib, 1.351, 0);
  }
  slab([2.6, 0.73, 2.31], ivory, 4.69, 1.42, 0, 0.052);
  slab([1.66, 0.73, 1.91], ivory, 5.0, 2.124, 0, 0.035);
  slab([1.8, 0.14, 2.03], iron, 4.99, 2.55, 0, 0.04);
  for (const z of [-0.65, -0.23, 0.23, 0.65]) slab([0.024, 0.27, 0.337], glass, 5.834, 2.18, z, 0.008);
  for (const side of [-1, 1])
    for (const x of [4.48, 5.04, 5.52]) slab([0.39, 0.27, 0.024], glass, x, 2.18, side * 0.958, 0.008);
  slab([2.23, 0.55, 2.05], ivory, -5.94, 1.33, 0, 0.049);
  slab([2.13, 0.12, 1.99], iron, -5.94, 1.66, 0, 0.032);
  const tube = (a, b, h) => toGeometry(cylinderGeometry(a, b, h, 12));
  part(tube(0.23, 0.32, 0.75), oxide, -6.08, 2.075, -0.12);
  part(tube(0.24, 0.25, 0.16), iron, -6.08, 2.52, -0.12);
  part(tube(0.043, 0.064, 1.38), rail, 4.38, 3.18, 0);
  slab([0.7, 0.042, 0.047], iron, 4.38, 3.63, 0);
  for (const side of [-1, 1]) {
    const z = side * 1.61;
    const stanchion = tube(0.026, 0.034, 0.48);
    for (const x of [-6.3, -4.25, -2.14, 0, 2.1, 4.45]) part(stanchion, rail, x, 1.29, z);
    slab([10.76, 0.045, 0.045], rail, -0.925, 1.52, z, 0.012);
  }
  for (const [x, z] of [
    [-7.58, -0.73],
    [-7.58, 0.73],
    [6.8, -0.6],
    [6.8, 0.6],
  ])
    part(tube(0.082, 0.098, 0.22), iron, x, 1.23, z);
  return root;
}

export async function setupSeakeepingFilm() {
  const sea = await seakeepingWorld(true, true);
  const calm = await seakeepingWorld(false, true, sea.ship);
  const { world, physics, wake, ship } = sea;
  const initial = world.takeSnapshot();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:768px;height:456px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#8eaaaf';
  engine.lighting.direction.set([0.34, 0.52, 0.79, 2.65]);
  engine.lighting.radiance.set([1, 0.93, 0.87, 1]);
  engine.lighting.ambient.set([0.45, 0.54, 0.65]);
  const water = Water.attach(engine, {
    size: [152, 148],
    segments: 160,
    sea: sea.sea,
    horizon: true,
    whitecaps: 0,
    chop: 0.06,
    foamDistance: 0.015,
    color: [0.028, 0.102, 0.127],
  });
  const wakeSurface = WaterWake.attach(engine, { surface: water, wake });
  const model = boat(engine, ship);
  Tonemap.attach(engine, { exposure: -0.1 });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const draw = () => engine.render({ delta: 0 });
  const settle = () => gpu.queue.onSubmittedWorkDone();

  let frame = 0;
  let checkpoint;
  const snapshots = new Map();
  function project([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }
  function mark(point, position, rotation) {
    return project(rotateByQuaternion(point, rotation).map((value, axis) => value + position[axis]));
  }

  async function at(shotFrame, mode, action) {
    const target = Math.max(0, Math.min(duration, shotFrame - cue));
    if (action === 'restore') {
      world.restoreSnapshot(checkpoint.bytes);
      frame = checkpoint.frame;
    } else if (target < frame) {
      world.restoreSnapshot(initial.bytes);
      frame = 0;
    }
    if (target > frame) world.advance((frame = target));
    const state = world.takeSnapshot();
    const first = snapshots.get(target);
    if (first && (first.length !== state.bytes.length || first.some((byte, i) => byte !== state.bytes[i])))
      throw new Error('Check the coupled hull and wake playback against the accepted snapshot.');
    snapshots.set(target, state.bytes);
    if (action === 'save') checkpoint = { bytes: state.bytes, frame };
    const motion = seaMotion(sea);
    const forward = rotateByQuaternion([1, 0, 0], motion.rotation);
    const yaw = -Math.atan2(forward[2], forward[0]);
    const drawn =
      mode === 'level'
        ? {
            position: [motion.position[0], 0, motion.position[2]],
            rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
          }
        : motion;
    model.setPosition(drawn.position).setQuaternion(drawn.rotation);
    // A cut starts a fresh Water view. Both draws use this exact accepted closed-form surface and wake.
    // Prepopulate the purely visual contact mask at the held pose, like the zero-time slate of each take.
    water.resetTime();
    water.setTime(motion.time);
    draw();
    draw();
    await settle();
    const marks = [
      [5.7 - ship.balance, 2.49, 0],
      [-6.0 - ship.balance, 2.52, 0],
      [0, 1.52, -1.61],
      [0, 1.52, 1.61],
    ];
    return {
      ...motion,
      hash: state.hash,
      marks: marks.map((point) => mark(point, drawn.position, drawn.rotation)),
      surface: [sea.sea.elevation(-2, 4, motion.time), sea.sea.elevation(3, 4, motion.time)],
    };
  }

  async function flatReference(frame) {
    calm.world.advance(frame);
    return seaMotion(calm);
  }

  await at(0, 'active');
  await waitForPipelines(draw);
  return {
    at,
    cue,
    duration,
    flatReference,
    courseSpeed,
    waveAmplitude,
    wavePeriod,
    mass: ship.mass,
    wakeBackend: wake.fftWork().backend,
    async detachWake() {
      wakeSurface.dispose();
      water.resetTime();
      water.setTime(world.time);
      draw();
      draw();
      await settle();
    },
    async dispose() {
      wakeSurface.dispose();
      physics[Symbol.dispose]();
      calm.physics[Symbol.dispose]();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

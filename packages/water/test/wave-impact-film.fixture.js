import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { computeVertexNormals, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { createMesh } from '@margoengine/materials';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { Physics } from '@margoengine/physics';
import { SpectralSea } from '@margoengine/physics/sea';
import { HullSolver, wettedLoads } from '@margoengine/physics/seakeeping';
import { bandWidth } from '@margoengine/physics/waves';
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_WORDS,
  DECK_INFLOW_FIELD,
  DECK_INFLOW_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Water } from '@margoengine/water';
import { BreakingWaveMaterial } from '@margoengine/water/breaking';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const rate = 120;
const gravity = 9.81;
const density = 1000;
const waveHeight = 0.72;
const wavePeriod = 2.9;
const startY = 0.98;
const speedY = 2.55;
const cells = [50, 24];
const cue = 13;
const duration = 310;
const width = 768;
const height = 456;
const camera = { position: [4.1, 3.25, 5.8], target: [0.8, 0.25, 0], fov: 37, near: 0.08, far: 120 };
const still = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

export function launchHull() {
  // A low-freeboard 5.8 m work launch. Shape units are metres; X is forward.
  const lines = [
    [-2.9, 0.7],
    [-2.63, 0.83],
    [-2.2, 0.955],
    [-1.38, 1.0],
    [-0.3, 1.0],
    [0.62, 0.98],
    [1.38, 0.86],
    [2.11, 0.64],
    [2.55, 0.35],
    [2.9, 0.055],
  ];
  const stations = [
    [0.155, 0],
    [0.155, -0.945],
    [0.04, -1.04],
    [-0.1, -1.015],
    [-0.31, -0.68],
    [-0.575, 0],
    [-0.31, 0.68],
    [-0.1, 1.015],
    [0.04, 1.04],
    [0.155, 0.945],
  ];
  const vertices = [];
  const uv = [];
  const indices = [];
  const finish = [[], [], [], []];
  const n = stations.length;
  for (let i = 0; i < lines.length; i++) {
    const [x, beam] = lines[i];
    for (let k = 0; k < n; k++) {
      const [y, z] = stations[k];
      vertices.push(x, y, beam * z);
      uv.push(i / (lines.length - 1), k / n);
      if (i === 0) continue;
      const a = (i - 1) * n + k;
      const b = (i - 1) * n + ((k + 1) % n);
      const strip = [a, a + n, b, b, a + n, b + n];
      const group = k === 0 || k === 9 ? 3 : k === 2 || k === 7 ? 1 : k >= 3 && k <= 6 ? 0 : 2;
      indices.push(...strip);
      finish[group].push(...strip);
    }
  }
  for (let side = 0; side < 2; side++) {
    const end = side ? (lines.length - 1) * n : 0;
    const hub = vertices.length / 3;
    vertices.push(vertices[end * 3], 0, 0);
    uv.push(0.5, 0.5);
    for (let k = 0; k < n; k++) {
      const a = end + k;
      const b = end + ((k + 1) % n);
      const triangle = side ? [a, hub, b] : [a, b, hub];
      finish[2].push(...triangle);
      indices.push(...triangle);
    }
  }
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map((j) => vertices.slice(3 * j, 3 * j + 3));
    volume +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (volume < 0)
    for (const group of [indices, ...finish])
      for (let i = 0; i < group.length; i += 3) [group[i + 1], group[i + 2]] = [group[i + 2], group[i + 1]];
  const mesh = { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
  const load = wettedLoads(mesh, still, { density, elevation: () => 0 }, 0, [0, 0, 0]);
  const centre = load.torque[2] / load.force[1];
  for (let i = 0; i < mesh.vertices.length; i += 3) mesh.vertices[i] -= centre;
  return { mesh, finish, uv, centre, mass: load.force[1] / gravity };
}

export async function impactWorld(enableImpact, boat = launchHull()) {
  await Physics.load();
  const f = 1 / wavePeriod;
  const frequencies = Float64Array.of(f - 0.06, f, f + 0.06);
  const directions = Float64Array.from({ length: 12 }, (_, i) => i * (Math.PI / 6));
  const energy = new Float64Array(36);
  energy[18] = (waveHeight / 2) ** 2 / (2 * bandWidth(frequencies, 1) * (Math.PI / 6));
  const sea = new SpectralSea({ waves: { frequencies, directions, energy, depth: 6, density }, seed: 18 });
  const world = new PhysicsWorld({
    memory: worldMemory(false),
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
  });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate, gravity: [0, -gravity, 0] });
  const body = physics.addBody(null, {
    position: [-0.3, startY, 0],
    linearVelocity: [0.52, -speedY, 0],
    colliders: { shape: 'box', halfExtents: [2.55, 0.3, 0.82], mass: boat.mass },
  });
  const hull = new HullSolver();
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh: boat.mesh }],
      sea,
      level: 1,
      stations: 14,
      memory: 8,
      deckCells: cells,
      slamming: enableImpact,
      greenWater: enableImpact,
      drift: false,
    })
    .couple(['hull', 'rigid'], 'staggered');
  return { world, physics, hull, body, sea, boat };
}

export function hullReceipt(take, frame) {
  const { body, hull, world } = take;
  const accepted = world.fields.port(BODIES_FIELD.name);
  if (accepted?.region.layout !== 2 || accepted.region.type !== 'f32')
    throw new Error('Use the accepted hull pose published by RigidSolver.');
  const values = regionWords(world.memory, accepted.region);
  const row = body.row * BODY_WORDS;
  const position = Array.from(values.subarray(row, row + 3));
  const rotation = Array.from(values.subarray(row + 3, row + 7));
  const ports = hull.exportPorts(frame);
  const forces = ports.find((port) => port.field === BODY_FORCES_FIELD.name);
  const offset = body.row * FORCE_WORDS;
  const forceRows = regionWords(world.memory, forces.region);
  const inflowPort = ports.find((port) => port.field === DECK_INFLOW_FIELD.name);
  const records = regionWords(world.memory, inflowPort.region);
  let inflow = 0;
  let bowInflow = 0;
  for (let i = 0; i < records[0]; i++) {
    const start = 1 + i * DECK_INFLOW_WORDS;
    if (records[start] !== body.row) continue;
    inflow += records[start + 14];
    if ((records[start + 1] + records[start + 4]) / 2 > 0) bowInflow += records[start + 14];
  }
  return {
    position,
    rotation,
    velocity: body.linearVelocity,
    force: Array.from(forceRows.subarray(offset, offset + 6)),
    inflow,
    bowInflow,
  };
}

function drawLaunch(engine, boat) {
  const root = engine.createMesh();
  root.name = 'Low-freeboard workboat';
  const matte = (color, roughness = 0.77) => new PbrMaterial({ color, roughness });
  const keel = matte('#96584e');
  const belt = matte('#e4bc72');
  const topsides = matte('#315562');
  const plates = matte('#758181');
  const cream = matte('#d6d9cf', 0.62);
  const rubber = matte('#424e51');
  const amber = matte('#a16f42');
  const glass = matte('#314755', 0.41);
  const positions = Float32Array.from(boat.mesh.vertices);
  const uvs = Float32Array.from(boat.uv);
  const geometry = computeVertexNormals(
    geometryData(positions, new Float32Array(positions.length), uvs, boat.mesh.indices),
  );
  for (const [i, material] of [keel, belt, topsides, plates].entries())
    engine
      .createMesh(root)
      .setMaterial(material)
      .setGeometry(toGeometry(geometryData(positions, geometry.normals, uvs, Uint32Array.from(boat.finish[i]))));
  const part = (g, material, x, y, z) =>
    engine
      .createMesh(root)
      .setGeometry(g)
      .setMaterial(material)
      .setPosition([x - boat.centre, y, z]);
  function slab([a, b, c], material, x, y, z, round = 0) {
    return part(round > 0 ? toGeometry(roundedBoxGeometry(a, b, c, 2, round)) : box(a, b, c), material, x, y, z);
  }
  const pipe = (a, b, h) => toGeometry(cylinderGeometry(a, b, h, 12));
  // The aft cab and a marked, open working deck keep the overtopping flow in view.
  slab([1.29, 0.54, 1.29], cream, -1.87, 0.433, 0, 0.035);
  slab([1.41, 0.105, 1.385], rubber, -1.865, 0.76, 0, 0.026);
  for (const side of [-1, 1]) {
    for (const x of [-2.2, -1.59]) slab([0.47, 0.208, 0.02], glass, x, 0.509, side * 0.648, 0.008);
    for (const z of [0.204, 0.491]) slab([0.02, 0.208, 0.233], glass, -1.22, 0.509, side * z, 0.008);
  }
  part(pipe(0.018, 0.028, 0.39), rubber, -2.18, 0.94, 0);
  for (const [x, z] of [
    [-2.6, -0.52],
    [-2.6, 0.52],
    [2.27, -0.27],
    [2.27, 0.27],
  ]) {
    part(pipe(0.043, 0.056, 0.12), rubber, x, 0.207, z);
    slab([0.16, 0.032, 0.056], amber, x, 0.267, z, 0.012);
  }
  for (const side of [-1, 1]) {
    const stanchion = pipe(0.014, 0.016, 0.37);
    for (const x of [-0.9, -0.34, 0.22, 0.78]) part(stanchion, cream, x, 0.34, side * 0.868);
    slab([1.7, 0.026, 0.026], cream, -0.06, 0.527, side * 0.868, 0.008);
  }
  return root;
}

/** Reconstruct the free surface of the accepted deck cells, clipping each triangle at the wet front. */
function deckSheet({ nx, nz, x0, z0, dx, dz, height: bed, depth }) {
  const limit = 0.001;
  const positions = [];
  const indices = [];
  const uvs = [];
  const uvs1 = [];
  function sample(index) {
    return [x0 + ((index % nx) + 0.5) * dx, bed[index], z0 + (Math.floor(index / nx) + 0.5) * dz, depth[index]];
  }
  function wetFace(a, b, c) {
    if (![a, b, c].every((index) => Number.isFinite(bed[index]))) return;
    const original = [a, b, c].map(sample);
    const wet = [];
    for (let side = 0; side < 3; side++) {
      const p = original[side];
      const q = original[(side + 1) % 3];
      if (p[3] >= limit) wet.push(p);
      if (p[3] >= limit === q[3] >= limit) continue;
      const t = (limit - p[3]) / (q[3] - p[3]);
      wet.push(p.map((value, axis) => value + (q[axis] - value) * t));
    }
    if (wet.length < 3) return;
    const first = positions.length / 3;
    for (const [x, y, z, h] of wet) {
      positions.push(x, y + h, z);
      uvs.push(x, z);
      // The material's first extra UV is the accepted optical thickness. The second is whitewater fraction.
      uvs1.push(h, 0);
    }
    for (let k = 1; k + 1 < wet.length; k++) indices.push(first, first + k, first + k + 1);
  }
  for (let z = 0; z + 1 < nz; z++)
    for (let x = 0; x + 1 < nx; x++) {
      const a = z * nx + x;
      const b = a + nx;
      wetFace(a, b, a + 1);
      wetFace(a + 1, b, b + 1);
    }
  if (!indices.length) return undefined;
  const vertices = Float32Array.from(positions);
  const data = computeVertexNormals(
    geometryData(vertices, new Float32Array(vertices.length), Float32Array.from(uvs), Uint32Array.from(indices)),
  );
  return { ...data, uvs1: Float32Array.from(uvs1) };
}

function measure(deck) {
  let volume = 0;
  let peak = 0;
  let frontMoment = 0;
  let wet = 0;
  if (deck) {
    const cellArea = deck.dx * deck.dz;
    for (let i = 0; i < deck.depth.length; i++) {
      const h = deck.depth[i];
      if (!Number.isFinite(h) || h < 0 || (h > 0 && !Number.isFinite(deck.height[i])))
        throw new Error('Report finite nonnegative water depth only in accepted deck cells.');
      volume += h * cellArea;
      frontMoment += h * cellArea * (deck.x0 + ((i % deck.nx) + 0.5) * deck.dx);
      peak = Math.max(peak, h);
      if (h > 0.001) wet++;
    }
  }
  return { volume, peak, wet, centroid: volume > 0 ? frontMoment / volume : 0 };
}

export async function setupWaveImpactFilm() {
  const live = await impactWorld(true);
  const unforced = await impactWorld(false, live.boat);
  const { world, sea, physics, boat, hull, body } = live;
  const first = world.takeSnapshot();
  const controlFirst = unforced.world.takeSnapshot();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:768px;height:456px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#86a2a4';
  engine.lighting.direction.set([0.23, 0.71, 0.66, 2.5]);
  engine.lighting.radiance.set([0.96, 0.95, 0.85, 1]);
  engine.lighting.ambient.set([0.52, 0.62, 0.64]);
  const water = Water.attach(engine, {
    sea,
    size: [46, 46],
    segments: 172,
    horizon: true,
    whitecaps: 0,
    chop: 0.035,
    foamDistance: 0.009,
    color: [0.024, 0.112, 0.134],
  });
  const ship = drawLaunch(engine, boat);
  const material = new BreakingWaveMaterial({
    look: {
      scatter: [0.07, 0.3, 0.23],
      transmission: 0.75,
      forward: 0.48,
    },
  });
  let sheet;
  const device = engine.gpu;
  const problems = [];
  engine.onError = (error) => problems.push(String(error));
  device.addEventListener('uncapturederror', (event) => problems.push(event.error.message));
  device.pushErrorScope('validation');

  const draw = () => engine.render({ delta: 0 });
  function refreshWater(time) {
    // This fixed-camera cut uses Water's contact mask for the current pose. Its history is aesthetic, and
    // replay re-creates the view from accepted HullSolver surface/rigid state the same way on each take.
    water.resetTime();
    water.setTime(time);
    draw();
    draw();
  }

  function projection([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }

  let frame = 0;
  let controlFrame = 0;
  let checkpoint;
  const recorded = new Map();
  async function at(shotFrame, mode, action) {
    const next = Math.max(0, Math.min(duration, shotFrame - cue));
    if (action === 'restore') {
      world.restoreSnapshot(checkpoint.bytes);
      frame = checkpoint.frame;
    } else if (next < frame) {
      world.restoreSnapshot(first.bytes);
      frame = 0;
    }
    if (next > frame) world.advance((frame = next));
    const snapshot = world.takeSnapshot();
    const original = recorded.get(next);
    if (
      original &&
      (original.length !== snapshot.bytes.length || original.some((byte, i) => byte !== snapshot.bytes[i]))
    )
      throw new Error('Restore and re-advance the exact wave-impact state bytes.');
    recorded.set(next, snapshot.bytes);
    if (action === 'save') checkpoint = { bytes: snapshot.bytes, frame };
    const reading = hullReceipt(live, frame);
    const deck = hull.deckSurface(body.row);
    const geo = mode === 'active' && deck ? deckSheet(deck) : undefined;
    const drawPose = mode === 'feature-off' ? control(frame) : reading;
    ship.setPosition(drawPose.position).setQuaternion(drawPose.rotation);
    if (geo) {
      if (!sheet) sheet = createMesh(engine, geo, material);
      else sheet.setGeometry(geo);
      sheet.root.setPosition(reading.position).setQuaternion(reading.rotation).visible = true;
    } else if (sheet) sheet.root.visible = false;
    refreshWater(world.time);
    await device.queue.onSubmittedWorkDone();
    const bulk = measure(deck);
    const projectedCentroid = rotateByQuaternion([bulk.centroid, 0.155 + bulk.peak / 2, 0], reading.rotation).map(
      (value, axis) => value + reading.position[axis],
    );
    return {
      ...reading,
      ...bulk,
      time: world.time,
      hash: snapshot.hash,
      surface: [sea.elevation(-0.5, 1.6, world.time), sea.elevation(1.7, 1.6, world.time)],
      onScreen: projection(projectedCentroid),
      faces: (geo?.indices.length ?? 0) / 3,
    };
  }

  function control(time) {
    if (time < controlFrame) {
      unforced.world.restoreSnapshot(controlFirst.bytes);
      controlFrame = 0;
    }
    if (time > controlFrame) unforced.world.advance((controlFrame = time));
    return hullReceipt(unforced, time);
  }
  await at(0, 'active');
  await waitForPipelines(draw);
  return {
    at,
    control,
    cue,
    duration,
    waveHeight,
    wavePeriod,
    mass: boat.mass,
    async dispose() {
      sheet?.destroy();
      physics[Symbol.dispose]();
      unforced.physics[Symbol.dispose]();
      const validation = (await device.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, problems };
    },
  };
}

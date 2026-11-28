import { EngineKernel, Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { FoamSolver, SEA_FOAM_FIELD, SEA_FOAM_LAYOUT } from '@margoengine/physics/foam';
import { Physics } from '@margoengine/physics';
import { HULL_BREACHES_FIELD, HULL_BREACH_WORDS, HullSolver, volumeBelow } from '@margoengine/physics/seakeeping';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Water } from '@margoengine/water';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 456;
const gravity = 9.81;
const rate = 60;
const mass = 1000 * 9 * 3.6 * 0.76;
const cue = 17;
const duration = 570;
const closeAt = 5.2;
const controlClose = 0.65;
const breachOpens = 0.32;
const sheetCells = [40, 28];
const spacing = 0.3;
const camera = { position: [3.7, 4.4, 12.6], target: [0.18, 1.31, 0.05], fov: 35, near: 0.09, far: 150 };

const cubeFaces = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
];

function cuboid([x0, y0, z0], [x1, y1, z1]) {
  const points = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const indices = cubeFaces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { mesh: { vertices: Float64Array.from(points.flat()), indices: Uint32Array.from(indices) }, points };
}

const hullMesh = cuboid([-4.5, -0.76, -1.8], [4.5, 0.79, 1.8]).mesh;
const tanks = [
  { ...cuboid([0.24, -0.7, 0.29], [4.32, 0.69, 1.72]), permeability: 0.95 },
  { ...cuboid([-4.31, -0.68, -1.72], [0.24, 0.69, 0.84]), permeability: 0.85 },
];

const sea = { density: 1000, elevation: () => 0 };
const calm = {
  cell: [0, 0, 0],
  sample: (_x, _z, out) =>
    out ?? {
      frequencies: Float64Array.of(0.1, 0.18, 0.3),
      directions: Float64Array.of(0, Math.PI / 2, Math.PI, Math.PI * 1.5),
      energy: new Float64Array(12),
      depth: 9,
      density: sea.density,
    },
};

export async function floodingWorld(close) {
  await Physics.load();
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity: [0, -gravity, 0], arena: world.arena });
  const body = physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [4.5, 0.775, 1.8], mass },
  });
  const hull = new HullSolver();
  const foam = new FoamSolver();
  const openings = [
    {
      from: 0,
      to: 'outside',
      centre: [2.12, -0.52, 1.8],
      normal: [0, 0, 1],
      width: 1.24,
      height: 0.36,
      opens: breachOpens,
      closes: close,
    },
    {
      from: 0,
      to: 'outside',
      centre: [2.65, -0.12, 1.8],
      normal: [0, 0, 1],
      width: 0.29,
      height: 0.12,
      opens: breachOpens,
      closes: close,
    },
    { from: 1, to: 'outside', centre: [-2.1, 0.69, -0.65], normal: [0, 1, 0], width: 0.34, height: 0.26 },
    { from: 0, to: 1, centre: [0.24, -0.47, 0.56], normal: [-1, 0, 0], width: 0.46, height: 0.19, opens: 3.2 },
  ];
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: body.row, mesh: hullMesh, compartments: tanks, openings }],
      sea,
      slamming: false,
      greenWater: false,
      stations: 12,
      memory: 9,
    })
    .add(foam, { waves: calm, cells: sheetCells, cellSize: spacing, windrows: false, statistics: 8 });
  world.couple(['hull', 'rigid'], 'staggered');
  return { world, physics, body, hull, foam };
}

export function breaches(take) {
  const port = take.hull.exportPorts(take.world.tick).find((p) => p.field === HULL_BREACHES_FIELD.name);
  const reading = regionWords(take.world.memory, port.region);
  return Array.from({ length: reading[0] }, (_, i) => {
    const row = 1 + i * HULL_BREACH_WORDS;
    return Array.from(reading.subarray(row, row + HULL_BREACH_WORDS));
  });
}

function foamRows(take) {
  const port = take.world.fields.port(SEA_FOAM_FIELD.name);
  if (port?.region.layout !== SEA_FOAM_LAYOUT || port.region.type !== 'f32')
    throw new Error('Read accepted breach-driven foam.');
  return regionWords(take.world.memory, port.region);
}

export function floodPose(take) {
  const { world, body } = take;
  const port = world.fields.port(BODIES_FIELD.name);
  if (port?.region.layout !== 2 || port.region.type !== 'f32') throw new Error('Read the accepted layout-2 hull pose.');
  const positions = regionWords(world.memory, port.region);
  const offset = body.row * BODY_WORDS;
  const position = Array.from(positions.subarray(offset, offset + 3));
  const rotation = Array.from(positions.subarray(offset + 3, offset + 7));
  const longitudinal = rotateByQuaternion([1, 0, 0], rotation);
  const transverse = rotateByQuaternion([0, 0, 1], rotation);
  const pitch = (Math.asin(longitudinal[1]) * 180) / Math.PI;
  const roll = (Math.asin(transverse[1]) * 180) / Math.PI;
  let foamArea = 0;
  const rows = foamRows(take);
  for (let i = 0; i < rows.length; i += 2) foamArea += rows[i] * spacing ** 2;
  return { position, rotation, pitch, roll, foamArea };
}

const minus = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = ([a, b, c], [x, y, z]) => [b * z - c * y, c * x - a * z, a * y - b * x];
const unit = (value) => {
  const length = Math.hypot(...value);
  return value.map((v) => v / length);
};

function openTank(engine, parent, tank) {
  const frame = new PbrMaterial({ color: '#c9aa75', roughness: 0.7 });
  const plate = new PbrMaterial({ color: '#374b56', roughness: 0.88 });
  const shell = (dimensions, position, surface) =>
    engine
      .createMesh(parent)
      .setGeometry(box(...dimensions))
      .setPosition(position)
      .setMaterial(surface);
  const [x0, y0, z0] = tank.points[0];
  const [x1, y1, z1] = tank.points[6];
  const centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const span = [x1 - x0, y1 - y0, z1 - z0];
  const edge = 0.036;
  for (const y of [y0, y1]) {
    for (const z of [z0, z1]) shell([span[0] + edge, edge, edge], [centre[0], y, z], frame);
    for (const x of [x0, x1]) shell([edge, edge, span[2] + edge], [x, y, centre[2]], frame);
  }
  for (const x of [x0, x1]) for (const z of [z0, z1]) shell([edge, span[1], edge], [x, centre[1], z], frame);
  shell([span[0], 0.028, span[2]], [centre[0], y0 - 0.018, centre[2]], plate);
  shell([span[0], span[1], 0.025], [centre[0], centre[1], z0 - 0.019], plate);
}

function physicalBarge(engine) {
  const root = engine.createMesh();
  root.name = 'Nine-metre compartment barge';
  const material = (color, roughness = 0.81) => new PbrMaterial({ color, roughness });
  const oxide = material('#9c5644');
  const hull = material('#34566a', 0.72);
  const rail = material('#e8dacc', 0.65);
  const deck = material('#7e8480');
  const graphite = material('#28373e', 0.72);
  const bronze = material('#a08d60');
  const caps = material('#c2b194');
  const part = (geometry, surface, p) =>
    engine.createMesh(root).setGeometry(geometry).setPosition(p).setMaterial(surface);
  const slab = (dims, surface, p, bevel = 0) =>
    part(bevel ? toGeometry(roundedBoxGeometry(...dims, 2, bevel)) : box(...dims), surface, p);
  slab([9, 1.55, 3.6], hull, [0, 0.015, 0]);
  for (const z of [-1.805, 1.805]) {
    slab([8.95, 0.153, 0.036], oxide, [0, -0.091, z], 0.009);
    slab([8.96, 0.06, 0.051], bronze, [0, 0.064, z], 0.014);
  }
  slab([8.95, 0.046, 3.55], deck, [0, 0.8, 0], 0.017);
  for (const x of [-2.11, 2.13]) {
    slab([2.62, 0.16, 2.49], graphite, [x, 0.924, 0], 0.037);
    slab([2.52, 0.1, 2.42], caps, [x, 1.034, 0], 0.029);
    for (const off of [-0.72, 0, 0.72]) slab([0.04, 0.028, 2.29], bronze, [x + off, 1.099, 0]);
  }
  const post = toGeometry(cylinderGeometry(0.032, 0.038, 0.39, 10));
  for (const side of [-1, 1]) {
    const z = side * 1.71;
    for (const x of [-4.14, -2.87, -1.41, 0, 1.41, 2.87, 4.14]) part(post, rail, [x, 1.006, z]);
    slab([8.31, 0.052, 0.05], rail, [0, 1.2, z], 0.013);
    for (const x of [-4.0, 4.0])
      part(toGeometry(cylinderGeometry(0.079, 0.099, 0.193, 12)), graphite, [x, 0.919, side * 1.04]);
  }
  return root;
}

/** Rebuild one horizontal fill surface from the accepted water volume and the actual closed tank. */
function tankFill(tank, normal, waterVolume) {
  if (!(waterVolume > 0)) return;
  const distances = tank.points.map((p) => dot(normal, p));
  let low = Math.min(...distances);
  let high = Math.max(...distances);
  for (let n = 0; n < 48; n++) {
    const middle = (low + high) / 2;
    if (volumeBelow(tank.mesh, normal, middle) * tank.permeability < waterVolume) low = middle;
    else high = middle;
  }
  const level = (low + high) / 2;
  const vertices = [];
  const normals = [];
  const indices = [];
  const rim = [];
  function face(points) {
    if (points.length < 3) return;
    const n = cross(minus(points[1], points[0]), minus(points[2], points[0]));
    if (Math.hypot(...n) < 1e-12) return;
    const outward = unit(n);
    const at = vertices.length / 3;
    for (const point of points) {
      vertices.push(...point);
      normals.push(...outward);
    }
    for (let i = 1; i + 1 < points.length; i++) indices.push(at, at + i, at + i + 1);
  }
  for (const plane of cubeFaces) {
    const region = [];
    for (let e = 0; e < 4; e++) {
      const i = plane[e];
      const j = plane[(e + 1) % 4];
      const a = distances[i] - level;
      const b = distances[j] - level;
      if (a <= 0) region.push(tank.points[i]);
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
        const t = a / (a - b);
        const point = tank.points[i].map((x, k) => x + t * (tank.points[j][k] - x));
        region.push(point);
        if (!rim.some((p) => Math.hypot(...minus(p, point)) < 1e-10)) rim.push(point);
      }
      if (a === 0 && !rim.some((p) => Math.hypot(...minus(p, tank.points[i])) < 1e-10)) rim.push(tank.points[i]);
    }
    face(region);
  }
  const centre = [0, 1, 2].map((i) => rim.reduce((sum, p) => sum + p[i], 0) / rim.length);
  const tangent = unit(cross(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]));
  const later = cross(normal, tangent);
  const angle = (p) => Math.atan2(dot(minus(p, centre), later), dot(minus(p, centre), tangent));
  rim.sort((a, b) => angle(a) - angle(b));
  face(rim);
  const shownVolume = volumeBelow({ vertices, indices }, [0, 1, 0], Infinity) * tank.permeability;
  if (Math.abs(shownVolume - waterVolume) > 1e-10 * Math.max(1, waterVolume))
    throw new Error('The clipped display must hold the accepted permeable tank volume.');
  if (vertices.length === 0) return;
  return { geometry: new Geometry(vertices, normals, indices), volume: shownVolume, level, rim };
}

export async function setupFloodingFilm() {
  const active = await floodingWorld(closeAt);
  const isolated = await floodingWorld(controlClose);
  const takes = { active, isolated };
  let take = active;
  for (const state of [active, isolated]) {
    state.initial = state.world.takeSnapshot();
    state.frame = 0;
    state.ledger = { water: 0, vented: 0 };
    state.records = new Map();
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:768px;height:456px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { exactSize: [width, height], backend: 'webgpu', camera });
  engine.scene.background = '#526970';
  engine.lighting.direction.set([0.42, 0.66, 0.66, 2.35]);
  engine.lighting.radiance.set([0.96, 0.92, 0.85, 0.96]);
  engine.lighting.ambient.set([0.45, 0.54, 0.65]);
  const vessel = physicalBarge(engine);
  const water = Water.attach(engine, {
    size: [82, 82],
    segments: 128,
    horizon: true,
    whitecaps: 0,
    foamDistance: 0.006,
    chop: 0,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
    color: [0.019, 0.083, 0.107],
  });
  const section = engine.createMesh().setScale([0.58, 0.58, 0.58]).setPosition([-0.39, 3.03, -0.46]);
  section.name = 'Raised cutaway of accepted hull compartments';
  for (const tank of tanks) openTank(engine, section, tank);
  const fluidColour = new PbrMaterial({ color: '#48a89d', roughness: 0.37 });
  const empty = new Geometry([], [], []);
  const fluids = tanks.map(() => engine.createMesh(section).setMaterial(fluidColour).setGeometry(empty));
  const labels = TextRenderer.attach(engine);
  const look = unit(minus(camera.target, camera.position));
  const right = unit(cross(look, [0, 1, 0]));
  const up = unit(cross(right, look));
  const board = (x, y) => camera.target.map((p, i) => p + x * right[i] + y * up[i]);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const bodyFont = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, x, y, font, fontSize, color) =>
    labels.add(new Text({ text, font, fontSize, color, billboard: true, onTop: true, position: board(x, y) }));
  label('When a compartment floods', -6.32, 3.66, title, 0.345, '#efe3d3');
  label('Raised section follows the vessel’s actual list and trim', -6.3, 3.23, bodyFont, 0.185, '#b5ceca');
  const bay = label('', 2.8, 3.2, bodyFont, 0.194, '#d5f3eb');
  const timer = label('', -6.28, -3.63, bodyFont, 0.185, '#dce2dd');

  const gpu = engine.gpu;
  const faults = [];
  engine.onError = (error) => faults.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => faults.push(event.error.message));
  gpu.pushErrorScope('validation');
  const draw = () => engine.render({ delta: 0 });
  function project([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }
  function restore(to, snapshot, frame, ledger) {
    to.world.restoreSnapshot(snapshot.bytes);
    to.frame = frame;
    to.ledger = { ...ledger };
  }
  let checkpoint;
  async function at(shotFrame, mode, action) {
    take = takes[mode];
    const goal = Math.max(0, Math.min(duration, shotFrame - cue));
    if (action === 'restore') restore(take, checkpoint.snapshot, checkpoint.frame, checkpoint.ledger);
    else if (goal < take.frame) restore(take, take.initial, 0, { water: 0, vented: 0 });
    while (take.frame < goal) {
      take.world.advance(++take.frame);
      for (const row of breaches(take)) {
        take.ledger.water -= row[9] / rate;
        if (row[14] > 0) take.ledger.vented += Math.max(0, row[10]) / rate;
      }
    }
    const snapshot = take.world.takeSnapshot();
    const earlier = take.records.get(goal);
    if (earlier && (earlier.length !== snapshot.bytes.length || earlier.some((v, i) => v !== snapshot.bytes[i])))
      throw new Error('Replay the same accepted flooded barge, foam and flooded Rigid state bytes.');
    take.records.set(goal, snapshot.bytes);
    if (action === 'save') checkpoint = { snapshot, frame: take.frame, ledger: { ...take.ledger } };
    const pose = floodPose(take);
    const inventory = take.hull.floodedCompartments(take.body.row);
    if (inventory?.length !== tanks.length) throw new Error('Read the accepted flooded volumes for both tank boxes.');
    const [qx, qy, qz, qw] = pose.rotation;
    const normal = unit(rotateByQuaternion([0, 1, 0], [-qx, -qy, -qz, qw]));
    vessel.setPosition(pose.position).setQuaternion(pose.rotation);
    section.setQuaternion(pose.rotation);
    const clipped = tanks.map((tank, i) => {
      const fill = tankFill(tank, normal, inventory[i].waterVolume);
      fluids[i].setGeometry(fill?.geometry ?? empty).visible = !!fill;
      if (!fill) return { volume: 0, level: null, flatness: 0 };
      const heights = fill.rim.map((point) => rotateByQuaternion(point, pose.rotation)[1]);
      return { volume: fill.volume, level: fill.level, flatness: Math.max(...heights) - Math.min(...heights) };
    });
    const time = take.world.time;
    const volumes = inventory.map((tank) => tank.waterVolume);
    bay.text = volumes[0].toFixed(2) + ' m³ breach  /  ' + volumes[1].toFixed(2) + ' m³ transfer';
    timer.text = time.toFixed(2) + ' s';
    water.resetTime();
    water.setTime(time);
    draw();
    draw();
    await gpu.queue.onSubmittedWorkDone();
    const marks = [
      [4.13, 1.2, 1.71],
      [-4.13, 1.2, 1.71],
      [0, 1.2, -1.71],
      [0, 1.2, 1.71],
    ].map((point) => project(rotateByQuaternion(point, pose.rotation).map((value, i) => value + pose.position[i])));
    return { ...pose, time, hash: snapshot.hash, volumes, clipped, inventory, ledger: { ...take.ledger }, marks };
  }
  await at(0, 'active');
  await waitForPipelines(draw);
  return {
    at,
    cue,
    duration,
    rate,
    closeAt,
    controlClose,
    breachOpens,
    mass,
    ports: () => breaches(take),
    async dispose() {
      labels.dispose();
      active.physics[Symbol.dispose]();
      isolated.physics[Symbol.dispose]();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, faults };
    },
  };
}

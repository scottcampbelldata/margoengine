import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { computeVertexNormals, cylinderGeometry, geometryData, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { PbrMaterial as ClothMaterial, createMesh } from '@margoengine/materials';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { Physics } from '@margoengine/physics';
import { SpectralSea } from '@margoengine/physics/sea';
import { SailingSolver } from '@margoengine/physics/ship';
import { FABRICS, SailForce, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import {
  BODIES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  RigidSolver,
  SoftSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Noise, generateRockMesh } from '@margoengine/procedural';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { travellingGust } from '@margoengine/weather/turbulence';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768,
  height = 448;
const fps = 60,
  dt = 1 / fps,
  gravity = 9.80665;
const cue = 12,
  beforeWind = 25,
  filled = 121,
  running = 197,
  end = 282;
const cell = [-4, 1, 7],
  windCell = [-5, 1, 7],
  cellSize = 64;
const preRoll = 4;
const starting = [-1.65, 0, 0];
const nu = 7,
  nv = 9;
const chord = 2.24,
  span = 3.25,
  trim = 0.32;
const across = [Math.sin(trim), 0, Math.cos(trim)];
const normal = [Math.cos(trim), 0, -Math.sin(trim)];
const foot = [-0.38, 0.85, -0.5 * chord * across[2]];
const yard = (j) => [foot[0] + (chord * across[0]) / 2, foot[1] + j * span, 0];
const mass = 610;
const dinghy = {
  length: 5.4,
  beam: 1.66,
  draught: 0.25,
  volume: 0.61,
  waterplane: 5.32,
  lcb: 2.82,
  lcf: 2.75,
  prismatic: 0.52,
  midship: 0.57,
  keel: { draught: 0.84, volume: 0.018, root: 0.65, tip: 0.36, thickness: 0.12, centre: 0.45 },
  rudder: { area: 0.23, chord: 0.31, thickness: 0.12 },
};
const flat = (x) => Math.min(1, Math.max(0, x));
const add = (a, b) => a.map((v, i) => v + b[i]);
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

const still = {
  medium: 'air',
  cell: windCell,
  sample(_x, _y, _z, _t, out) {
    out.velocity.fill(0);
    out.density = 1.225;
    out.temperature = 290;
    return out;
  },
};
const gust = travellingGust(still, {
  origin: [cellSize - 5, 0, 0],
  cellSize,
  start: 0.25,
  direction: 0,
  speed: 8.6,
  length: 22,
  amplitude: [9, 0, 0],
});

function pointAt(i, j) {
  return [
    foot[0] + (chord * across[0] * i) / (nu - 1),
    foot[1] + (span * j) / (nv - 1),
    foot[2] + (chord * across[2] * i) / (nu - 1),
  ];
}

const ties = [...Array(nu)].flatMap((_, i) => [i * nv, i * nv + nv - 1]);
const initialPoints = Array.from({ length: nu * nv }, (_, i) => pointAt(Math.floor(i / nv), i % nv));
const bellyPoint = Math.floor(nu / 2) * nv + Math.floor(nv / 2);

async function makeSail(windy, hasWater) {
  await Physics.load();
  const world = new PhysicsWorld({
    rate: { num: fps, den: 1 },
    gravity: hasWater ? [0, -gravity, 0] : [0, 0, 0],
    cellSize,
    memory: worldMemory(false),
    seed: 9211,
  });
  // The water run holds mean draft and trim, the same constrained degrees used by the compact yacht model.
  const physics = new Physics(null, {
    fixedTimestep: dt,
    gravity: hasWater ? [0, -gravity, 0] : [0, 0, 0],
    arena: world.arena,
  });
  const body = physics.addBody(null, {
    position: starting,
    ...(hasWater ? { enabledTranslations: [true, false, true], enabledRotations: [true, true, false] } : {}),
    colliders: { shape: 'box', halfExtents: [2.65, 0.3, 0.75], mass },
  });
  const soft = await SoftBodies.attach(physics);
  const cloth = soft.create(
    SoftBodyDesc.cloth(add(starting, foot), scale(across, chord / (nu - 1)), [0, span / (nv - 1), 0], nu, nv).setFabric(
      FABRICS.sailcloth,
    ),
  );
  for (const tie of ties) cloth.attachParticle(tie, body);
  const source = windy ? gust : still;
  const config = { wind: source, grid: [nu, nv], chord: 'u', frame: { cell, cellSize } };
  const sail = await SailForce.attachNative(physics, cloth, { ...config, threads: 1 });
  const rigid = new RigidSolver();
  const sailing = hasWater ? new SailingSolver() : undefined;
  world.add(rigid, { physics }, cell).add(new SoftSolver(), { soft }, cell);
  if (sailing) {
    world.add(
      sailing,
      { yachts: [{ row: body.row, hull: dinghy, metacentricHeight: 0.72 }], density: 1000, viscosity: 1.14e-6 },
      cell,
    );
    world.couple(['sailing', 'soft', 'rigid'], 'staggered');
    sailing.control(0).heading = 0;
  } else world.couple(['soft', 'rigid'], 'staggered');
  // Give the cloth coupling its initial contact rows before the director's first snapshot.
  // This pre-roll is in still air on both takes.
  world.advance(preRoll);
  const initial = world.takeSnapshot();
  return {
    world,
    physics,
    body,
    cloth,
    sail,
    sailing,
    rigid,
    initial,
    frame: 0,
    saved: new Map([[0, initial]]),
    visited: new Map(),
  };
}

async function impulseWitness() {
  const take = await makeSail(true, false);
  try {
    const impulse = [0, 0, 0];
    const frames = 108;
    const momentum = () => {
      const velocity = take.cloth.particleVelocities();
      return take.body.linearVelocity.map((v, axis) => {
        let value = mass * v;
        for (let j = 0; j < nu * nv; j++) value += take.cloth.masses[j] * velocity[3 * j + axis];
        return value;
      });
    };
    const before = momentum();
    for (let n = 1; n <= frames; n++) {
      take.world.advance(preRoll + n);
      for (let axis = 0; axis < 3; axis++) impulse[axis] += take.sail.force[axis] * dt;
    }
    return { impulse, momentum: subtract(momentum(), before), hull: take.body.linearVelocity[0] * mass, frames };
  } finally {
    take.physics.dispose();
  }
}

function exact(bytes, checkpoint) {
  if (bytes.length !== checkpoint.length || bytes.some((value, i) => value !== checkpoint[i]))
    throw new Error('Restore all rigid, soft, registry and sail attachment words at the saved film frame.');
}

function seek(take, frame, action) {
  const { world, saved, visited } = take;
  if (action === 'restore') {
    const checkpoint = saved.get(frame);
    world.restoreSnapshot(checkpoint.bytes);
    exact(world.takeSnapshot().bytes, checkpoint.bytes);
  } else {
    if (frame < take.frame) world.restoreSnapshot(saved.get(0).bytes);
    if (frame !== take.frame) world.advance(preRoll + frame);
  }
  take.frame = frame;
  const snapshot = world.takeSnapshot();
  if (visited.has(frame)) exact(snapshot.bytes, visited.get(frame));
  visited.set(frame, snapshot.bytes);
  if (action === 'save') saved.set(frame, snapshot);
  return snapshot.hash;
}

function accepted(take) {
  const { world, body, cloth, rigid, sailing } = take;
  const port = world.fields.port(BODIES_FIELD.name);
  const at = body.row * BODY_WORDS,
    rows = regionWords(world.memory, port.region);
  const position = Array.from(rows.subarray(at, at + 3)),
    rotation = Array.from(rows.subarray(at + 3, at + 7));
  const velocity = Array.from(rows.subarray(at + 10, at + 13)),
    spin = Array.from(rows.subarray(at + 13, at + 16));
  const points = Array.from(cloth.particlePositions());
  const actual = (i) => points.slice(3 * i, 3 * i + 3);
  const pointWorld = (i) => add(position, rotateByQuaternion(initialPoints[i], rotation));
  const camber = dot(subtract(actual(bellyPoint), pointWorld(bellyPoint)), rotateByQuaternion(normal, rotation));
  const tieError = Math.max(...ties.map((i) => Math.hypot(...subtract(actual(i), pointWorld(i)))));
  const attachment = rigid.extraState().find((r) => r.name === 'attachmentState');
  if (!attachment) throw new Error('Archive the native sail attachment with the accepted rigid frame.');
  const loads = Array.from(regionWords(world.memory, attachment));
  const waterRegion = sailing?.extraState().find((r) => r.name === 'forces');
  const waterForce = waterRegion
    ? Array.from(regionWords(world.memory, waterRegion).subarray(body.row * FORCE_WORDS, body.row * FORCE_WORDS + 3))
    : [0, 0, 0];
  const boom = points.slice(0, 3),
    head = points.slice((nv - 1) * 3, (nv - 1) * 3 + 3);
  return {
    position,
    rotation,
    velocity,
    spin,
    points,
    loads,
    camber,
    tieError,
    waterForce,
    cell: port.cell,
    boom,
    head,
    belly: actual(bellyPoint),
  };
}

function dinghyMesh(engine) {
  const root = engine.createMesh();
  root.name = 'Larch sailing dinghy';
  const stations = [
    [-2.85, 0.48],
    [-2.69, 0.65],
    [-2.4, 0.81],
    [-1.43, 0.97],
    [-0.38, 1],
    [0.7, 0.96],
    [1.47, 0.82],
    [2.0, 0.62],
    [2.44, 0.36],
    [2.75, 0.12],
    [2.84, 0.029],
  ];
  const ring = [
    [0.46, 0],
    [0.46, -0.85],
    [0.34, -0.882],
    [0.19, -0.853],
    [0.05, -0.82],
    [-0.024, -0.798],
    [-0.22, -0.55],
    [-0.33, 0],
    [-0.22, 0.55],
    [-0.024, 0.798],
    [0.05, 0.82],
    [0.19, 0.853],
    [0.34, 0.882],
    [0.46, 0.85],
  ];
  const positions = [],
    uv = [],
    groups = [[], [], [], [], []];
  const size = ring.length;
  for (const [i, [x, width]] of stations.entries()) {
    for (const [j, [y, z]] of ring.entries()) {
      const sheer = (1 - width) * (x > 0 ? 0.32 : 0.12);
      positions.push(x, y + sheer * (y > 0 ? 1 : 0.43), width * z);
      uv.push(i / (stations.length - 1), j / size);
      if (i === 0) continue;
      const a = (i - 1) * size + j,
        b = (i - 1) * size + ((j + 1) % size);
      const panel =
        j === 0 || j === 13 ? 4 : j === 1 || j === 12 ? 3 : j === 4 || j === 9 ? 2 : j >= 5 && j <= 8 ? 0 : 1;
      groups[panel].push(a, a + size, b, b, a + size, b + size);
    }
  }
  for (const i of [0, stations.length - 1]) {
    const centre = positions.length / 3;
    positions.push(stations[i][0], 0.17, 0);
    uv.push(0.5, 0.5);
    for (let j = 0; j < size; j++) {
      const a = i * size + j,
        b = i * size + ((j + 1) % size);
      groups[1].push(...(i ? [a, centre, b] : [a, b, centre]));
    }
  }
  const all = groups.flat();
  let signed = 0;
  for (let i = 0; i < all.length; i += 3) {
    const [a, b, c] = all.slice(i, i + 3).map((v) => positions.slice(v * 3, v * 3 + 3));
    signed +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (signed < 0) {
    for (const set of [all, ...groups])
      for (let i = 0; i < set.length; i += 3) [set[i + 1], set[i + 2]] = [set[i + 2], set[i + 1]];
  }
  const profiles = computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uv, all));
  const paint = (color, roughness = 0.72) => new PbrMaterial({ color, roughness });
  const wetOxide = paint('#7a5143'),
    teal = paint('#2b6268', 0.61),
    cream = paint('#c5b69a', 0.58);
  const oak = paint('#a27044', 0.67),
    boards = paint('#987c56'),
    iron = paint('#465159', 0.56);
  [wetOxide, teal, cream, oak, boards].forEach((color, i) =>
    engine
      .createMesh(root)
      .setGeometry(toGeometry(geometryData(positions, profiles.normals, uv, groups[i])))
      .setMaterial(color),
  );
  const piece = (geometry, material, p, q = root) =>
    engine.createMesh(q).setGeometry(toGeometry(geometry)).setMaterial(material).setPosition(p);
  const slab = (dimensions, material, p, radius = 0.02) =>
    piece(roundedBoxGeometry(...dimensions, 2, radius), material, p);
  for (const x of [-1.82, -0.95, 0.98]) slab([0.31, 0.074, 1.18], oak, [x, 0.52, 0], 0.027);
  for (const side of [-1, 1]) {
    slab([1.94, 0.11, 0.05], oak, [-0.44, 0.56, side * 0.58], 0.023);
    for (const x of [-1.67, 1.81]) piece(cylinderGeometry(0.028, 0.035, 0.106, 12), iron, [x, 0.53, side * 0.52]);
  }
  slab([0.67, 0.085, 0.63], oak, [2.05, 0.63, 0], 0.031);
  slab([0.34, 0.11, 0.25], iron, [yard(0)[0], 0.54, 0], 0.022);
  const mastY = foot[1] + span + 0.18;
  piece(cylinderGeometry(0.046, 0.076, mastY - 0.49, 16), oak, [yard(0)[0], 0.5 * (mastY + 0.49), 0]);
  const spin = Math.atan2(across[0], across[2]);
  for (const j of [0, 1]) {
    const y = yard(j)[1];
    slab([0.057, 0.057, chord + 0.18], oak, [yard(j)[0], y, 0], 0.024).setRotation([0, spin, 0]);
    for (const s of [-1, 1])
      piece(cylinderGeometry(0.035, 0.035, 0.061, 10), iron, add(yard(j), scale(across, s * (chord / 2 + 0.055))));
  }
  slab([0.39, 0.56, 0.075], oak, [-2.76, 0.04, 0], 0.029);
  slab([0.58, 0.056, 0.052], oak, [-2.32, 0.59, 0], 0.022);
  return root;
}

function flyingCloth(engine) {
  const uv = [],
    index = [],
    seams = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      uv.push(i / (nu - 1), j / (nv - 1));
      if (i === nu - 1 || j === nv - 1) continue;
      const a = i * nv + j,
        b = a + nv;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const material = new ClothMaterial({ doubleSided: true, roughness: 0.97, vertexColors: true });
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const edging = i === 0 || i === nu - 1 || j === 0 || j === nv - 1;
      const rust = j >= nv - 3;
      const colour = rust ? [0.47, 0.17, 0.097] : [0.72, 0.63, 0.48];
      const scale = edging ? 0.85 : j % 3 === 0 ? 0.94 : 1;
      seams.push(...colour.map((v) => v * scale), 1);
    }
  let mesh;
  return {
    update(points, hidden) {
      const data = computeVertexNormals(geometryData(points, new Float32Array(points.length), uv, index));
      data.colors = Float32Array.from(seams);
      if (mesh) mesh.setGeometry(data);
      else mesh = createMesh(engine, data, material);
      mesh.root.visible = !hidden;
    },
  };
}

function inletShore(engine) {
  const noise = new Noise(927);
  const cols = 96,
    rows = 60,
    position = [],
    uv = [],
    index = [],
    colors = [];
  const base = (x, z) => {
    const shore = -15.5 + 2.6 * noise.simplex(0.085 * x, 3.7, 1.1);
    const inland = shore - z;
    return (
      0.16 * inland +
      flat(inland / 5) *
        (0.45 * noise.simplex(x * 0.18, 2.9, z * 0.21) +
          flat(inland / 16) * (2.5 + 4 * noise.simplex(x * 0.027, 1.9, z * 0.037)))
    );
  };
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) {
      const x = -56 + (i * 112) / cols,
        z = -50 + (j * 74) / rows;
      const y = base(x, z),
        st = flat(y / 3),
        n = 0.03 * noise.simplex(x * 0.44, 0.5, z * 0.41);
      position.push(x, y, z);
      uv.push(i / cols, j / rows);
      colors.push(0.25 - 0.092 * st + n, 0.263 + 0.023 * st + n, 0.217 - 0.035 * st + n, 1);
      if (i < cols && j < rows) {
        const a = i + j * (cols + 1),
          b = a + cols + 1;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  const data = computeVertexNormals(geometryData(position, new Float32Array(position.length), uv, index));
  data.colors = Float32Array.from(colors);
  createMesh(engine, data, new ClothMaterial({ vertexColors: true, roughness: 0.92 }));
  const wetStone = new PbrMaterial({ color: '#717073', roughness: 0.79 });
  for (let i = 0; i < 22; i++) {
    const x = -25 + i * 2.6 + 0.5 * noise.simplex(1.1, i, 0.5),
      z = -16.4 + 2.4 * noise.simplex(0.14 * x, 3.7, 1.1);
    const size = 0.44 + 0.87 * flat(0.64 + noise.simplex(1, i * 0.37, 1));
    engine
      .createMesh()
      .setGeometry(toGeometry(generateRockMesh(143 + i, 'slab', { detail: 1 })))
      .setMaterial(wetStone)
      .setPosition([x, base(x, z), z])
      .setScale([size, 0.7 * size, size]);
  }
}

export async function mountSailFilm() {
  const checks = await impulseWitness();
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-7.1, 4.65, 9.2], target: [-0.3, 1.58, 0], fov: 34, near: 0.12, far: 180 },
  });
  engine.scene.background = '#adbec3';
  engine.lighting.direction.set([0.62, 0.7, 0.39, 1.83]);
  engine.lighting.radiance.set([1, 0.93, 0.77, 1]);
  engine.lighting.ambient.set([0.44, 0.54, 0.67]);
  inletShore(engine);
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.43, 0.57, 0.71),
      directions: Float64Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4),
      energy: new Float64Array(24),
      depth: 18,
      density: 1000,
    },
    seed: 1543,
  });
  const water = Water.attach(engine, {
    size: [146, 142],
    segments: 80,
    sea,
    horizon: true,
    whitecaps: 0,
    chop: 0.013,
    color: [0.028, 0.097, 0.108],
    foamDistance: 0.015,
  });
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.09 });
  const model = dinghyMesh(engine),
    cloth = flyingCloth(engine);
  const takes = await Promise.all([makeSail(true, true), makeSail(false, true)]);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 700 });
  const sub = new Font({ family: 'Arial, sans-serif', weight: 500 });
  labels.add(
    new Text({
      text: 'A gust fills the sail',
      position: [-3.95, 4.68, -0.66],
      font: title,
      fontSize: 0.27,
      color: '#21383e',
      billboard: true,
      onTop: true,
    }),
  );
  const subtitle = labels.add(
    new Text({
      text: 'Sail loading enabled',
      position: [-3.95, 4.41, -0.66],
      font: sub,
      fontSize: 0.124,
      color: '#35525a',
      billboard: true,
      onTop: true,
    }),
  );
  const gpu = engine.gpu,
    errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const target = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const output = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: target } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  await waitForPipelines(draw);
  return {
    cue,
    beforeWind,
    filled,
    running,
    end,
    cell,
    windCell,
    mass,
    dt,
    checks,
    async sample({ editFrame, action, hideCloth = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = [];
      for (const [i, take] of takes.entries()) {
        const hash = seek(take, frame, action),
          state = accepted(take);
        model.setPosition(state.position).setQuaternion(state.rotation);
        cloth.update(state.points, hideCloth);
        subtitle.text = i === 0 ? 'Travelling gust · physical sailcloth' : 'Still air · same boat and water';
        water.resetTime();
        water.setTime(frame * dt);
        await waitForPipelines(draw);
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
        states.push({ hash, ...state, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      for (const { physics } of takes) physics.dispose();
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

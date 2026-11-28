import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { addHorse } from '@margoengine/horses';
import { fitHorseHooves, horseJointTranslation, poseHooves, poseJoints } from '@margoengine/horses/model';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { TerrainBed } from '@margoengine/physics/earth';
import {
  LEGGED_CONTACT_FIELD,
  LEGGED_GAIT_FIELD,
  LEGGED_LAYOUT,
  LEGGED_POSE_FIELD,
  LeggedLocomotion,
} from '@margoengine/physics/legged';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Noise, generateGrassMesh, generateRockMesh } from '@margoengine/procedural';
import { Shadows } from '@margoengine/shadows';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768,
  height = 432;
const rate = { num: 60, den: 1 };
const origin = [-7, 2, 11],
  cellSize = 64;
const seed = 2157;
const cue = 15,
  lead = 65,
  first = 19,
  second = 40,
  end = 81;
const leg = 1.08,
  friction = 0.6;
const bed = { width: 10, depth: 30, columns: 20, rows: 60, centre: [0, 3] };
const grades = [0, 0.13];
const noise = new Noise(seed);
const ground = (grade, z) => grade * (z + 5);
const clamp = (number) => Math.min(1, Math.max(0, number));
const fieldPoint = (grade, x, z) => {
  const edge = clamp((Math.abs(x) - 0.8) / 4);
  const broad = clamp((x - 2) / 11);
  return (
    ground(grade, z) +
    edge * 0.35 * noise.simplex(x * 0.4, 2.6, z * 0.25) +
    broad * (2.6 + 1.7 * noise.simplex(x * 0.14, 1.7, z * 0.11))
  );
};

function hillside(engine, shadows, grade) {
  const nx = 96,
    nz = 120,
    position = [],
    uv = [],
    triangles = [],
    color = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = -16 + (39 * i) / nx,
        z = -24 + (48 * j) / nz;
      position.push(x, fieldPoint(grade, x, z), z);
      uv.push(i / nx, j / nz);
      const trail = 1 - clamp((Math.abs(x + 0.13 * Math.sin(z * 0.78)) - 0.42) / 0.62);
      const fleck = 0.042 * noise.simplex(1.9 * x, 5.3, 2.1 * z) + 0.032 * noise.simplex(0.73 * x, 3, 0.57 * z);
      const distant = clamp((x - 2) / 16);
      color.push(
        0.15 + trail * 0.15 + fleck,
        0.195 + trail * 0.054 + fleck + 0.045 * distant,
        0.085 + trail * 0.098 + fleck + 0.071 * distant,
        1,
      );
      if (i < nx && j < nz) {
        const a = i + j * (nx + 1),
          b = a + nx + 1;
        triangles.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const data = geometryData(position, new Float32Array(position.length), uv, triangles);
  data.colors = Float32Array.from(color);
  const terrain = createMesh(
    engine,
    computeVertexNormals(data),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.91 }),
  );
  shadows.add(terrain, { castShadow: false });
  return terrain;
}

function ridgeDetail(engine, shadows) {
  const grass = toGeometry(generateGrassMesh(5));
  const leaves = ['#8e965e', '#a39f66', '#777f52'].map((color) => new PbrMaterial({ color, roughness: 0.96 }));
  const rocks = new PbrMaterial({ color: '#8d8a77', roughness: 0.89 });
  const detail = [];
  for (let j = 0; j < 15; j++) {
    for (let i = 0; i < 12; i++) {
      const x = -5.8 + i * 0.97 + 0.33 * noise.simplex(i, 0.39, j),
        z = -6.7 + j * 0.97 + 0.39 * noise.simplex(i, 0.96, j);
      if (Math.abs(x) < 1.03) continue;
      const variation = 0.5 + 0.5 * noise.simplex(i, 1.11, j);
      const mesh = engine
        .createMesh()
        .setGeometry(grass)
        .setMaterial(leaves[(i + j) % leaves.length])
        .setRotation([0, (i + j * 0.47) * 2.4, 0])
        .setScale([1, 0.25 + 0.42 * variation, 1]);
      detail.push({ x, z, mesh });
    }
  }
  const stones = [
    [2.1, -3.9, 0.34],
    [2.8, -3.5, 0.51],
    [2.4, -3.2, 0.28],
    [3.6, 1.3, 0.62],
    [3.9, 2.45, 0.44],
    [-2.55, 1.9, 0.36],
    [-3.3, -4.3, 0.25],
  ];
  for (const [i, [x, z, scale]] of stones.entries()) {
    const mesh = engine
      .createMesh()
      .setGeometry(toGeometry(generateRockMesh(seed + i, 'slab', { detail: 1 })))
      .setMaterial(rocks)
      .setScale([scale, scale, scale * 1.16]);
    shadows.add(mesh);
    detail.push({ mesh, x, z });
  }
  return detail;
}

async function establish(grade, skeleton) {
  const [hind, fore] = skeleton.ground;
  const solver = await LeggedLocomotion.load({ bedShape: bed, cellSize });
  const world = new PhysicsWorld({ rate, cellSize, seed, memory: worldMemory(false) })
    .add(new TerrainBed(), { ...bed, elevations: (_x, z) => ground(grade, z) }, origin)
    .add(
      solver,
      {
        bodies: [
          {
            kind: 'quadruped',
            mass: 500,
            friction,
            legLength: leg,
            width: hind[0] + fore[0],
            length: fore[2] - hind[2],
            position: [0, 0.87 * leg, -5],
            velocity: [0, 0, 2.5],
            target: { speed: 3.15, heading: 0 },
          },
        ],
      },
      origin,
    );
  // The shot starts on the approach, already moving. The pre-roll uses the same world, controls and terrain.
  world.advance(lead);
  return { grade, solver, world, frame: 0, saved: new Map([[0, world.takeSnapshot()]]), played: new Map() };
}

function exact(actual, expected) {
  if (actual.byteLength !== expected.byteLength || actual.some((value, index) => value !== expected[index]))
    throw new Error('Restore all accepted animal, terrain and contact snapshot bytes for the saved editor frame.');
}

function seek(take, frame, action) {
  const { world, saved, played } = take;
  if (action === 'restore') {
    const checkpoint = saved.get(frame);
    world.restoreSnapshot(checkpoint.bytes);
    exact(world.takeSnapshot().bytes, checkpoint.bytes);
  } else {
    if (frame < take.frame) world.restoreSnapshot(saved.get(0).bytes);
    if (frame !== take.frame) world.advance(lead + frame);
  }
  take.frame = frame;
  const snapshot = world.takeSnapshot();
  if (played.has(frame)) exact(snapshot.bytes, played.get(frame));
  played.set(frame, snapshot.bytes);
  if (action === 'save') saved.set(frame, snapshot);
  return snapshot.hash;
}

function accepted(take, horse, base) {
  const { world, solver, grade } = take;
  const motion = solver.read(0);
  const names = [LEGGED_POSE_FIELD.name, LEGGED_CONTACT_FIELD.name, LEGGED_GAIT_FIELD.name];
  const ports = names.map((name) => world.fields.port(name));
  if (ports.some((port) => port.region.layout !== LEGGED_LAYOUT || port.region.type !== 'f64'))
    throw new Error('Use the three registered layout-1 f64 legged gait, contact and pose fields.');
  const [body, contacts] = ports.map((port) => regionWords(world.memory, port.region));
  if (motion.position.some((value, i) => value !== body[i]))
    throw new Error('Bind the horse to the position in the accepted legged pose field.');

  // Physics groups front then hind, -X then +X. This actor's skin uses LH, LF, RH, RF (+X is left).
  const hoofData = [3, 1, 2, 0].map((index) => {
    const foot = solver.readContact(0, index);
    const row = [...foot.position, ...foot.axis, ...foot.force, Number(foot.stance), ...foot.couple];
    if (row.some((v, i) => v !== contacts[index * 13 + i]))
      throw new Error('Bind the rendered hoof target to the signed accepted ground contact.');
    return foot;
  });
  const [hind, fore] = horse.skeleton.ground;
  const [x, y, z] = motion.position;
  const root = [x, y - 0.87 * leg, z - (hind[2] + fore[2]) * 0.5];
  const [qx, qy, qz, qw] = motion.rotation;
  const pitch = Math.atan2(2 * (qw * qx - qy * qz), 1 - 2 * (qx * qx + qy * qy));
  const roll = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz));
  const targets = hoofData.map(({ position }) => ({
    point: position.map((value, axis) => value - root[axis]),
    pitch: -Math.atan(grade),
    roll: 0,
  }));
  // The stand pose is only a rest scaffold. Every contact target and trunk angle comes from accepted physics.
  const pose = fitHorseHooves(horse.skeleton, base, targets, pitch, roll);
  pose.rotations.forEach((rotation, i) => {
    if (i > 0) {
      horse.model.nodes[i].setQuaternion(rotation);
      horse.model.nodes[i].setPosition(horseJointTranslation(horse.skeleton, pose, i));
    }
  });
  horse.model.root.setPosition(root);
  const hooves = poseHooves(horse.skeleton, pose).map((position) => position.map((value, i) => value + root[i]));
  const head = poseJoints(horse.skeleton, pose)[horse.skeleton.index('head')].map((value, i) => value + root[i]);
  return {
    motion,
    hooves,
    hoofData,
    pitch,
    cells: ports.map((port) => port.cell),
    grade,
    head,
  };
}

export async function mountLeggedFilm() {
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-6.65, 2.68, 1.44], target: [0, 1.14, 0.2], fov: 39, near: 0.05, far: 105 },
  });
  engine.scene.background = '#bacad1';
  engine.lighting.direction.set([-0.54, 0.77, 0.44, 1.55]);
  engine.lighting.radiance.set([1, 0.91, 0.72, 1]);
  engine.lighting.ambient.set([0.51, 0.57, 0.69]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.03 });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const shadows = Shadows.attach(engine, {
    resolution: 1024,
    filter: 'pcf',
    bounds: { min: [-6, -1, -9], max: [6, 4, 6] },
  });
  const terrain = grades.map((grade) => hillside(engine, shadows, grade));
  const detail = ridgeDetail(engine, shadows);
  const horse = await addHorse(engine, {
    type: 'riding',
    coat: 'bay',
    detail: 2,
    markings: { blaze: true, socks: [0.09, 0, 0.13, 0.07] },
    shadows,
  });
  const rest = horse.pose;
  const takes = await Promise.all(grades.map((grade) => establish(grade, horse.skeleton)));
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const sub = new Font({ family: 'Arial, sans-serif', weight: 400 });
  labels.add(
    new Text({
      text: 'Gait on the incline',
      position: [-0.8, 3.02, -3.34],
      font: title,
      fontSize: 0.19,
      color: '#273737',
      billboard: true,
      onTop: true,
    }),
  );
  const takeLabel = labels.add(
    new Text({
      text: 'Level trail',
      position: [-0.8, 2.83, -3.34],
      font: sub,
      fontSize: 0.105,
      color: '#384844',
      billboard: true,
      onTop: true,
    }),
  );
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
  await shadows.ready;
  await waitForPipelines(draw);
  return {
    cue,
    first,
    second,
    end,
    lead,
    origin,
    leg,
    friction,
    rate: rate.num,
    async sample({ editFrame, action, hideHorse = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = [];
      for (const [i, take] of takes.entries()) {
        const hash = seek(take, frame, action);
        terrain.forEach((mesh, index) => {
          mesh.root.visible = index === i;
        });
        for (const { x, z, mesh } of detail) mesh.setPosition([x, fieldPoint(take.grade, x, z), z]);
        takeLabel.text = i === 0 ? 'Level trail · 0% grade' : 'Uphill trail · 13% grade';
        const physical = accepted(take, horse, rest);
        horse.model.root.visible = !hideHorse;
        await waitForPipelines(draw);
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
        states.push({ hash, ...physical, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      horse.dispose();
      labels.dispose();
      for (const { solver } of takes) solver[Symbol.dispose]();
      output.destroy();
      target.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

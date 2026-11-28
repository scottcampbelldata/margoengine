import { Animation } from '@margoengine/animation';
import { dualQuaternionSkinning } from '@margoengine/animation/dqs';
import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { boxGeometry, toGeometry } from '@margoengine/geometry';
import { loadGLTF } from '@margoengine/gltf/pbr';
import {
  axisAngleToQuaternion,
  conjugateQuaternion,
  multiplyQuaternions,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import { NavMesh } from '@margoengine/navmesh';
import {
  PEDESTRIAN_CONTACT_FIELD,
  PEDESTRIAN_KINEMATICS_FIELD,
  PEDESTRIAN_LAYOUT,
  PedestrianCrowd,
} from '@margoengine/physics/pedestrians';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Shadows } from '@margoengine/shadows';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768,
  height = 432;
const rate = 60,
  cue = 20,
  approach = 84,
  passage = 113,
  end = 226;
const speed = 1.25,
  grade = 0.025,
  shoulder = 0.48,
  depth = 0.31;
const gain = 3,
  decay = 3,
  reaction = 0.15,
  mass = 70;
const stride = 1.36;
const cell = [-6, 1, 8];
const xAxis = [1, 0, 0];
const yAxis = [0, 1, 0];
const floor = (x) => grade * x;
const starts = [
  [-2.2, floor(-2.2), 0],
  [0, 0, -2.61],
];
const goals = [
  [2.4, floor(2.4), 0],
  [0, 0, 2.4],
];
const headings = [
  [1, 0],
  [0, 1],
];

function simulationNavMesh() {
  const vertices = [-5, 0, 5].flatMap((z) => [-5, 0, 5].map((x) => [x, floor(x), z]));
  return new NavMesh(vertices, [
    [0, 1, 4, 3],
    [1, 2, 5, 4],
    [3, 4, 7, 6],
    [4, 5, 8, 7],
  ]);
}

async function establish(anticipation, nav) {
  const route = starts.map((position, i) => nav.route(position, goals[i]));
  const bodies = starts.map((position, i) => ({
    position,
    path: route[i].points,
    speed,
    mass,
    width: shoulder,
    depth,
    heading: headings[i],
    velocity: headings[i].map((value) => value * speed),
    arrivalDistance: 0.1,
  }));
  const solver = await PedestrianCrowd.load();
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    cellSize: 64,
    memory: worldMemory(false),
    seed: 3528,
  }).add(
    solver,
    {
      bodies,
      ground: nav,
      anticipation,
      anticipationDecay: decay,
      reactionSeconds: reaction,
      stiffness: 10000,
      sliding: 6000,
      packingDensity: 0,
    },
    cell,
  );
  return {
    solver,
    world,
    points: route.map((entry) => entry.points),
    frame: 0,
    saved: new Map([[0, world.takeSnapshot()]]),
    visited: new Map(),
  };
}

function readAccepted(take) {
  const { world, solver } = take;
  const vecPort = world.fields.port(PEDESTRIAN_KINEMATICS_FIELD.name);
  const loadPort = world.fields.port(PEDESTRIAN_CONTACT_FIELD.name);
  const poses = regionWords(world.memory, vecPort.region);
  const forces = regionWords(world.memory, loadPort.region);
  if (
    vecPort.region.layout !== PEDESTRIAN_LAYOUT ||
    loadPort.region.layout !== PEDESTRIAN_LAYOUT ||
    poses.length !== 18 ||
    forces.length !== 12
  )
    throw new Error('Use the live two-walker layout-1 f64 kinematics and contact banks.');
  const people = [0, 1].map((i) => {
    const body = solver.read(i);
    const kinematics = [...body.position, ...body.velocity, ...body.heading, body.distanceTravelled];
    const loads = [...body.contactForce, body.normalLoad, body.density, ...body.anticipationForce];
    if (
      kinematics.some((value, j) => value !== poses[i * 9 + j]) ||
      loads.some((value, j) => value !== forces[i * 6 + j])
    )
      throw new Error('Draw the same travel, pose and encounter that the world accepted in its registry.');
    return body;
  });
  return { people, cells: [vecPort.cell, loadPort.cell] };
}

function equalBytes(bytes, checkpoint) {
  if (bytes.length !== checkpoint.length || bytes.some((value, i) => value !== checkpoint[i]))
    throw new Error('Restore every accepted pedestrian and registry byte at the same film frame.');
}

function seek(take, frame, action) {
  const { world, saved, visited } = take;
  if (action === 'restore') {
    const checkpoint = saved.get(frame);
    world.restoreSnapshot(checkpoint.bytes);
    equalBytes(world.takeSnapshot().bytes, checkpoint.bytes);
  } else {
    if (frame < take.frame) world.restoreSnapshot(saved.get(0).bytes);
    if (frame !== take.frame) world.advance(frame);
  }
  take.frame = frame;
  const snapshot = world.takeSnapshot();
  if (visited.has(frame)) equalBytes(snapshot.bytes, visited.get(frame));
  visited.set(frame, snapshot.bytes);
  if (action === 'save') saved.set(frame, snapshot);
  return snapshot.hash;
}

function concourse(engine, shadows) {
  const materials = Object.fromEntries(
    Object.entries({
      stone: ['#9c9b91', 0.84],
      seam: ['#777e7a', 0.83],
      line: ['#527c79', 0.52],
      plaster: ['#aab5ae', 0.88],
      post: ['#526b68', 0.59],
      wood: ['#986d4d', 0.74],
      brass: ['#a2a17a', 0.53],
      fixture: ['#d9d0b1', 0.66],
      glassBack: ['#607a82', 0.57],
    }).map(([key, [color, roughness]]) => [key, new PbrMaterial({ color, roughness })]),
  );
  const box = toGeometry(boxGeometry(1, 1, 1));
  function solid(material, position, size, yaw = 0, slope = 0) {
    return engine
      .createMesh()
      .setGeometry(box)
      .setMaterial(materials[material])
      .setScale(size)
      .setPosition(position)
      .setRotation([0, yaw, slope]);
  }
  const tile = solid('stone', [0, -0.185, 0], [14, 0.37, 14], 0, Math.atan(grade));
  shadows.add(tile, { castShadow: false });
  for (let i = -5; i <= 5; i++) {
    solid('seam', [i, floor(i) + 0.002, 0], [0.008, 0.003, 9.95]);
    solid('seam', [0, 0.002, i], [9.95, 0.003, 0.008], 0, Math.atan(grade));
  }
  for (const side of [-1, 1]) {
    solid('line', [0, 0.006, side * 1.2], [9.75, 0.006, 0.031], 0, Math.atan(grade));
    solid('line', [side * 1.2, floor(side * 1.2) + 0.007, 0], [0.031, 0.006, 9.75]);
  }
  for (const x of [-3.85, 0, 3.85]) {
    const z = 4.36,
      y = floor(x);
    solid('post', [x, y + 1.65, z], [0.21, 3.3, 0.29]);
    solid('brass', [x, y + 0.09, z], [0.27, 0.18, 0.34]);
    solid('fixture', [x, y + 2.8, z - 0.157], [0.112, 0.24, 0.026]);
  }
  solid('post', [0, 3.25, 4.36], [9.6, 0.26, 0.32], 0, Math.atan(grade));
  solid('plaster', [0, 1.15, 4.82], [10, 2.3, 0.19], 0, Math.atan(grade));
  for (const x of [-2.45, 1.88]) {
    const y = floor(x);
    solid('glassBack', [x, y + 1.63, 4.688], [2.36, 1.12, 0.08]);
    for (let i = 0; i < 7; i++) solid('wood', [x - 1.04 + i * 0.35, y + 1.63, 4.59], [0.052, 1.1, 0.11]);
    const bench = solid('wood', [x, y + 0.47, 3.63], [1.92, 0.098, 0.56]);
    shadows.add(bench);
    for (const leg of [-0.72, 0.72]) solid('post', [x + leg, y + 0.23, 3.63], [0.12, 0.46, 0.44]);
  }
  solid('plaster', [4.79, 1.58, 2.77], [0.24, 3.0, 3.9]);
  solid('post', [4.62, 1.98, 0.86], [0.19, 3.72, 0.21]);
  solid('brass', [4.6, 0.13, 0.86], [0.36, 0.17, 0.38]);
}

const source = '/demos/the-stepping-stones/source/walker.glb';

async function surveyor(engine, shadows, i) {
  // Original CC0 MakeHuman asset already hosted by Margo's Stepping Stones demo. The physics/camera scene is new.
  const model = await loadGLTF(engine, source);
  const animation = Animation.attach(model, { skinning: dualQuaternionSkinning });
  animation.play(0);
  animation.seek(0.26);
  animation.playing = false;
  shadows.add(model);
  const { store } = engine;
  const trunk = model.primitives.find((p) => p.material.name.includes('field jacket'));
  if (i === 1) {
    if (!trunk) throw new Error('Use the retained surveyor jacket material to distinguish the two routes.');
    trunk.material.base[0] *= 0.42;
    trunk.material.base[1] *= 0.69;
    trunk.material.base[2] *= 1.03;
  }
  function joint(name) {
    const index = model.asset.doc.nodes.findIndex((n) => n.name?.endsWith(':' + name));
    if (index < 0) throw new Error('Use the named surveyor bone ' + name + '.');
    const node = model.nodes[index];
    const parent = engine.meshes.get(store.parents[node.id]);
    const m = parent.matrix;
    const { qx, qy, qz, qw } = store.transforms;
    const p = rotationToQuaternion(
      m,
      [0, 0, 0, 1],
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    );
    return {
      node,
      axis: rotateByQuaternion(xAxis, conjugateQuaternion(p)),
      rest: [qx[node.id], qy[node.id], qz[node.id], qw[node.id]],
    };
  }
  const legs = ['Left', 'Right'].map((side) => ({
    hip: joint(side + 'UpLeg'),
    knee: joint(side + 'Leg'),
    ankle: joint(side + 'Foot'),
    arm: joint(side + 'Arm'),
  }));
  const turn = ({ node, axis, rest }, angle) =>
    node.setQuaternion(multiplyQuaternions(axisAngleToQuaternion(axis, angle), rest));
  return {
    model,
    animation,
    bind(body) {
      const heading = Math.atan2(...body.heading);
      const pace = Math.min(1, Math.hypot(body.velocity[0], body.velocity[2]) / speed);
      const phase = 2 * Math.PI * (body.distanceTravelled / stride + i * 0.33);
      for (const [j, leg] of legs.entries()) {
        const cycle = phase + j * Math.PI;
        const pendulum = Math.sin(cycle) * pace;
        const recovery = Math.max(0, Math.cos(cycle)) * pace;
        turn(leg.hip, -0.26 * pendulum);
        turn(leg.knee, 0.44 * recovery);
        turn(leg.ankle, -0.14 * recovery);
        turn(leg.arm, 0.21 * pendulum);
      }
      // The stride pose is decorative; translation, slope, facing and cadence come from the accepted crowd row.
      model.root.setPosition(body.position).setQuaternion(axisAngleToQuaternion(yAxis, heading));
      return { phase, heading };
    },
  };
}

export async function mountPedestrianFilm() {
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-6.9, 4.7, 3.5], target: [0, 0.88, 0.08], fov: 39, near: 0.08, far: 52 },
  });
  engine.scene.background = '#b8c9cc';
  engine.lighting.direction.set([-0.57, 0.77, -0.35, 1.65]);
  engine.lighting.radiance.set([1, 0.91, 0.75, 1]);
  engine.lighting.ambient.set([0.48, 0.6, 0.67]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.06 });
  const gpu = engine.gpu,
    errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const shadows = Shadows.attach(engine, {
    resolution: 1024,
    filter: 'pcf',
    bounds: { min: [-5, -0.4, -5], max: [5, 3.4, 5] },
  });
  concourse(engine, shadows);
  const nav = simulationNavMesh();
  const [active, control, one, two] = await Promise.all([
    establish(gain, nav),
    establish(0, nav),
    surveyor(engine, shadows, 0),
    surveyor(engine, shadows, 1),
  ]);
  if (JSON.stringify(active.points) !== JSON.stringify(control.points))
    throw new Error('Use identical real navmesh routes in both takes.');
  const takes = [active, control],
    cast = [one, two];
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 650 });
  const meta = new Font({ family: 'Arial, sans-serif', weight: 450 });
  labels.add(
    new Text({
      text: 'Crossing the concourse',
      position: [-1.9, 3.28, -3.13],
      font: title,
      fontSize: 0.25,
      color: '#263f41',
      billboard: true,
      onTop: true,
    }),
  );
  const subtitle = labels.add(
    new Text({
      text: 'Anticipation enabled',
      position: [-1.9, 3.02, -3.13],
      font: meta,
      fontSize: 0.13,
      color: '#39534e',
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
    rate,
    cue,
    approach,
    passage,
    end,
    stride,
    cell,
    grade,
    shoulder,
    depth,
    gain,
    decay,
    reaction,
    mass,
    paths: active.points,
    scan() {
      return takes.map((take) => {
        const prior = take.world.takeSnapshot();
        take.world.restoreSnapshot(take.saved.get(0).bytes);
        const series = [];
        for (let tick = 0; tick <= end; tick++) {
          take.world.advance(tick);
          series.push(readAccepted(take).people);
        }
        take.world.restoreSnapshot(prior.bytes);
        equalBytes(take.world.takeSnapshot().bytes, prior.bytes);
        return series;
      });
    },
    async sample({ editFrame, action, empty = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = [];
      for (const [i, take] of takes.entries()) {
        const hash = seek(take, frame, action);
        const { people, cells } = readAccepted(take);
        const pose = cast.map((actor, index) => {
          actor.model.root.visible = !empty;
          return actor.bind(people[index]);
        });
        subtitle.text = i === 0 ? 'Anticipation enabled' : 'Contact only';
        await waitForPipelines(draw);
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
        states.push({ hash, people, cells, pose, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      for (const actor of cast) {
        actor.animation.dispose();
        actor.model.dispose();
      }
      for (const { solver } of takes) solver[Symbol.dispose]?.();
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

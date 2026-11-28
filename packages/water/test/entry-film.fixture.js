import { EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { toGeometry } from '/packages/geometry/dist/index.js';
import { geometryData } from '/packages/geometry/dist/utils.js';
import { EntrySolver } from '/packages/physics/dist/entry.js';
import { Physics } from '/packages/physics/dist/index.js';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '/packages/physics/dist/world.js';
import { VFX } from '/packages/vfx/dist/index.js';
import { Water } from '/packages/water/dist/index.js';
import { ShotSplash, SPLASH_EMITTERS } from '/packages/water/dist/splash.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const rate = 240;
const cue = 14;
const duration = 64;
const width = 672;
const height = 416;
const gravity = 9.81;
const radius = 0.062;
const density = 3200;
const initialY = 0.42;
const downSpeed = 5.5;
const stillLevel = 0;
const camera = { position: [0.86, 0.55, 1.37], target: [-0.04, 0.21, -0.055], fov: 33, near: 0.055, far: 12 };

function sphere(r) {
  const around = 28;
  const down = 14;
  const vertices = [];
  const indices = [];
  const enamel = [];
  const normals = [];
  const uvs = [];
  for (let j = 0; j <= down; j++)
    for (let i = 0; i <= around; i++) {
      const t = (Math.PI * j) / down;
      const p = (2 * Math.PI * i) / around;
      const n = [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
      vertices.push(...n.map((x) => r * x));
      normals.push(...n);
      uvs.push(i / around, j / down);
    }
  const at = (i, j) => j * (around + 1) + i;
  for (let j = 0; j < down; j++)
    for (let i = 0; i < around; i++) {
      const colour = j === 5 || j === 6;
      const faces = colour ? enamel : indices;
      if (j > 0) faces.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (j < down - 1) faces.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  return {
    hull: { vertices: Float64Array.from(vertices), indices: Uint32Array.from([...indices, ...enamel]) },
    geometry(faces) {
      return toGeometry(
        geometryData(
          Float32Array.from(vertices),
          Float32Array.from(normals),
          Float32Array.from(uvs),
          Uint32Array.from(faces),
        ),
      );
    },
    finish: indices,
    stripe: enamel,
  };
}

function tank(engine, model) {
  const backdrop = new PbrMaterial({ color: '#596971', roughness: 0.92 });
  const enamel = new PbrMaterial({ color: '#496169', roughness: 0.78 });
  const frame = new PbrMaterial({ color: '#617681', metallic: 1, roughness: 0.43 });
  const graduated = new PbrMaterial({ color: '#adb6b3', roughness: 0.74 });
  const anodized = new PbrMaterial({ color: '#28333a', metallic: 1, roughness: 0.37 });
  const marker = new PbrMaterial({ color: '#ce7f32', roughness: 0.69 });
  function shelf(size, position, material) {
    engine
      .createMesh()
      .setGeometry(box(...size))
      .setMaterial(material)
      .setPosition(position);
  }
  shelf([4, 1.9, 0.16], [0, 0.64, -1.02], backdrop);
  shelf([1.44, 0.16, 1.44], [0, -1.35, 0], enamel);
  for (const side of [-1, 1]) {
    shelf([0.028, 1.25, 1.44], [side * 0.716, -0.65, 0], enamel);
    shelf([1.44, 1.25, 0.028], [0, -0.65, side * 0.716], enamel);
  }
  shelf([0.021, 0.044, 1.42], [-0.71, 0.018, 0], frame);
  shelf([0.021, 0.044, 1.42], [0.71, 0.018, 0], frame);
  shelf([1.43, 0.044, 0.021], [0, 0.018, -0.71], frame);
  shelf([1.43, 0.044, 0.021], [0, 0.018, 0.71], frame);
  // Survey scale behind the tank, 50 mm between marks.
  shelf([0.058, 0.525, 0.011], [-0.295, 0.275, -0.55], enamel);
  for (let i = 0; i <= 10; i++) {
    const major = i % 2 === 0;
    shelf([major ? 0.034 : 0.019, 0.003, 0.003], [-0.299 + (major ? 0 : 0.007), 0.035 + i * 0.05, -0.543], graduated);
  }
  const ball = engine.createMesh();
  engine.createMesh(ball).setGeometry(model.geometry(model.finish)).setMaterial(anodized);
  engine.createMesh(ball).setGeometry(model.geometry(model.stripe)).setMaterial(marker);
  return ball;
}

export async function setupEntryFilm() {
  await Physics.load();
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity: [0, -gravity, 0], arena: world.arena });
  const sphereModel = sphere(radius);
  const body = physics.addBody(null, {
    position: [-0.1, initialY, 0],
    linearVelocity: [0.5, -downSpeed, 0],
    colliders: { shape: 'sphere', radius, mass: density * (4 / 3) * Math.PI * radius ** 3 },
  });
  const entry = await EntrySolver.load({ threads: 1 });
  world
    .add(new RigidSolver(), { physics })
    .add(entry, {
      bodies: [{ row: body.row, mesh: sphereModel.hull, contactAngle: 150 }],
      sea: {
        elevation: () => stillLevel,
      },
      level: 2,
    })
    .couple(['entry', 'rigid'], 'staggered');
  const initial = world.takeSnapshot();

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:672px;height:416px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#4b5e64';
  engine.lighting.direction.set([0.34, 0.74, 0.61, 2.7]);
  engine.lighting.radiance.set([1, 0.91, 0.79, 0.96]);
  engine.lighting.ambient.set([0.4, 0.54, 0.64]);
  const ball = tank(engine, sphereModel);
  const water = Water.attach(engine, {
    size: [1.4, 1.4],
    segments: 62,
    whitecaps: 0,
    chop: 0,
    foamDistance: 0.012,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 0.8 }],
    color: [0.025, 0.2, 0.235],
  });
  const emitters = [];
  let effects = true;
  const particleSize = { crown: 0.017, column: 0.019, mist: 0.072 };
  const splash = ShotSplash.attach(engine, {
    slots: 2,
    surface: water,
    water,
    splashes: { splashes: () => (effects ? entry.splashes() : []) },
    look: { crown: 1.85, column: 0.8, mist: 0.035, height: 1, foamWidth: 0.12, foamLife: 0.5 },
    particles(kind) {
      const emitter = VFX.attach(engine, { ...SPLASH_EMITTERS[kind], size: particleSize[kind] });
      emitters.push(emitter);
      return emitter;
    },
  });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');

  const memento = new Map();
  let frame = 0;
  let checkpoint;
  function pose() {
    const port = world.fields.port(BODIES_FIELD.name);
    const words = port?.region && regionWords(world.memory, port.region);
    if (!words || port.region.layout !== 2 || port.region.type !== 'f32')
      throw new Error('Draw the accepted rigid-body pose from the layout-2 field.');
    const at = body.row * BODY_WORDS;
    const position = Array.from(words.subarray(at, at + 3));
    const rotation = Array.from(words.subarray(at + 3, at + 7));
    ball.setPosition(position).setQuaternion(rotation);
    return position;
  }
  function project([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }
  const draw = (delta = 0) => engine.render({ delta });
  function resetView() {
    splash.resetTime();
    water.resetTime();
    for (const emitter of emitters) emitter.resetTime();
    // The still tank is already present before release. Populate its contact mask at the same
    // zero-time pose on the first take and on a rewind, without stepping physics or spray.
    pose();
    draw();
  }
  function restart() {
    world.restoreSnapshot(initial.bytes);
    frame = 0;
    resetView();
  }
  function simulateTo(target) {
    while (frame < target) {
      world.advance(++frame);
      pose();
      draw(1 / rate);
    }
  }
  async function at(shotFrame, on, action) {
    const target = Math.max(0, Math.min(duration, shotFrame - cue));
    if (target < frame || effects !== on || action === 'restore') restart();
    effects = on;
    if (action === 'restore') {
      simulateTo(checkpoint.frame);
      world.restoreSnapshot(checkpoint.bytes);
    }
    simulateTo(target);
    const accepted = world.takeSnapshot();
    const original = memento.get(target);
    if (
      original &&
      (original.length !== accepted.bytes.length || original.some((byte, at) => byte !== accepted.bytes[at]))
    )
      throw new Error('The accepted trajectory and splash events must repeat byte for byte and ignore artist look.');
    memento.set(target, accepted.bytes);
    if (action === 'save') checkpoint = { bytes: accepted.bytes, frame };
    const position = pose();
    // A hold must draw the very same kinetic scene, with every clock stopped.
    draw();
    await gpu.queue.onSubmittedWorkDone();
    const events = entry.splashes();
    const impact = events.find(({ kind }) => kind === 'entry');
    return {
      hash: accepted.hash,
      time: world.time,
      splashTime: splash.time,
      position,
      velocity: body.linearVelocity,
      phase: entry.bodyState(body.row),
      events,
      source: entry.seaSources(),
      drawn: splash.active().map(({ event }) => event),
      rings: splash.rings(),
      surface: water.sample(0.35, 0.22, world.time).height,
      screen: impact ? project(impact.position) : project([-0.064, stillLevel, 0]),
    };
  }
  pose();
  await waitForPipelines(() => draw());
  resetView();
  return {
    at,
    cue,
    duration,
    rate,
    gravity,
    initialY,
    downSpeed,
    radius,
    async dispose() {
      splash.dispose();
      for (const emitter of emitters) emitter.dispose();
      entry[Symbol.dispose]();
      physics[Symbol.dispose]();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { boxGeometry, computeVertexNormals, toGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { Physics } from '@margoengine/physics';
import { AirSolver, WingForce } from '@margoengine/physics/flight';
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
} from '@margoengine/physics/world';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const width = 720;
const height = 440;
const rate = 120;
const cue = 9;
const lastTick = 27;
const firstDownstroke = 0.11;
const downstrokeDuration = 0.115;
const raisedStroke = 0.56;
const paperScale = 0.165;
const paperMass = 0.3 * 0.3 * 0.08;
const startingPoint = [0, 0.58, -0.56];
const gravity = 9.81;
// Leading/trailing edges of the half-wing in the accepted force calculation and in the render mesh.
const sections = [
  { leadingEdge: [0, 0, 0.25 * paperScale], chord: 0.68 * paperScale },
  { leadingEdge: [0.81 * paperScale, 0.05 * paperScale, 0.33 * paperScale], chord: 0.87 * paperScale },
  { leadingEdge: [1.64 * paperScale, -0.035 * paperScale, -0.38 * paperScale], chord: 0.018 * paperScale },
];

function strokeAt(time, beat) {
  const phase = Math.max(0, Math.min(1, (time - firstDownstroke) / downstrokeDuration));
  return raisedStroke * (beat ? Math.cos(Math.PI * phase) : 1);
}

function attach(engine, geometry, material, parent) {
  return engine.createMesh(parent).setGeometry(geometry).setMaterial(material);
}

function triangle(engine, parent, a, b, c, material) {
  const vertices = new Float32Array([...a, ...b, ...c]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const data = geometryData(vertices, new Float32Array(vertices.length), uvs, indices);
  return attach(engine, toGeometry(computeVertexNormals(data)), material, parent);
}

function crane(engine) {
  // The crown, reverse neck fold and split pointed tail follow the in-repo copper crane's silhouette
  // (examples/showcase-films/the-paper-aviary.js). These wings share stations with WingForce.
  const root = engine.createMesh();
  root.name = 'Copper paper crane';
  const paper = ['#c95c34', '#ea8753', '#a9412b', '#f2a66b'].map(
    (color) => new PbrMaterial({ color, roughness: 0.92, doubleSided: true }),
  );
  const forms = {
    nose: [0, 0.02, 0.44],
    stern: [0, 0.012, -0.57],
    peak: [0, 0.24, -0.015],
    left: [-0.265, 0.014, -0.044],
    right: [0.265, 0.014, -0.044],
    underside: [0, -0.12, -0.032],
    throat: [0, 0.638, 0.74],
    collar: [0, 0.488, 0.46],
    beak: [0, 0.488, 1.04],
    jawLeft: [-0.065, 0.548, 0.73],
    jawRight: [0.065, 0.548, 0.73],
    neckLeft: [-0.13, 0.028, 0.28],
    neckRight: [0.13, 0.028, 0.28],
    tailLeft: [-0.16, 0, -0.33],
    tailRight: [0.16, 0, -0.33],
    tailRidge: [0, 0.2, -0.62],
    tailTip: [0, 0.29, -1.16],
  };
  const faces = [
    ['nose', 'peak', 'right', 1],
    ['peak', 'stern', 'left', 1],
    ['nose', 'left', 'peak', 0],
    ['stern', 'right', 'peak', 0],
    ['nose', 'right', 'underside', 0],
    ['stern', 'left', 'underside', 0],
    ['nose', 'underside', 'left', 2],
    ['stern', 'underside', 'right', 2],
    ['neckLeft', 'collar', 'throat', 0],
    ['neckLeft', 'throat', 'nose', 0],
    ['nose', 'throat', 'neckRight', 1],
    ['neckRight', 'throat', 'collar', 1],
    ['throat', 'jawLeft', 'beak', 3],
    ['throat', 'beak', 'jawRight', 1],
    ['tailLeft', 'tailRidge', 'tailTip', 1],
    ['tailRight', 'tailTip', 'tailRidge', 0],
    ['tailLeft', 'tailTip', 'stern', 0],
    ['tailRight', 'stern', 'tailTip', 2],
  ];
  const local = (point) => forms[point].map((coordinate) => coordinate * paperScale);
  for (const [a, b, c, color] of faces) triangle(engine, root, local(a), local(b), local(c), paper[color]);

  const origin = sections[0].leadingEdge;
  const wings = [-1, 1].map((side) => {
    const hinge = engine.createMesh(root).setPosition(origin);
    hinge.name = side < 0 ? 'Left wing leading-edge hinge' : 'Right wing leading-edge hinge';
    const stations = sections.map(({ leadingEdge: [x, y, z], chord }, i) => [
      [side * x, y, z - origin[2]],
      [side * x, y + (i === 1 ? 0.012 : chord * 0.045), z - origin[2] - 0.46 * chord],
      [side * x, y, z - origin[2] - chord],
    ]);
    for (let j = 1; j < stations.length; j++) {
      const [a, b, c] = stations[j - 1];
      const [d, e, f] = stations[j];
      triangle(engine, hinge, a, b, d, paper[1]);
      triangle(engine, hinge, b, e, d, paper[j === 1 ? 1 : 0]);
      triangle(engine, hinge, b, c, e, paper[0]);
      triangle(engine, hinge, c, f, e, paper[2]);
    }
    return { hinge, side };
  });
  return { root, wings };
}

function makeGallery(engine) {
  const material = (color, roughness = 0.8) => new PbrMaterial({ color, roughness });
  const plaster = material('#68797b');
  const walnut = material('#5d4639');
  const felt = material('#828b81');
  const edge = material('#9a8772', 0.45);
  const box = (dimensions, center, surface) =>
    attach(engine, toGeometry(boxGeometry(...dimensions)), surface).setPosition(center);
  box([0.08, 1.75, 3.6], [-0.62, 0.7, 0], plaster);
  box([1.36, 0.07, 3.6], [0, -0.034, 0], felt);
  box([0.058, 0.062, 3.6], [-0.546, 0.038, 0], walnut);
  box([0.018, 0.012, 3.6], [-0.546, 0.073, 0], edge);
  for (const z of [-0.96, -0.89, 0.87, 0.94]) box([0.028, 1.6, 0.018], [-0.566, 0.82, z], walnut);
  box([0.14, 0.042, 0.63], [-0.438, 0.303, -0.59], walnut);
  box([0.143, 0.006, 0.636], [-0.438, 0.325, -0.59], edge);
}

export async function setupAviaryFlight() {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, -gravity, 0], fixedTimestep: 1 / rate });
  const body = physics.addBody(null, {
    position: startingPoint,
    rotation: [Math.sin(0.05), 0, 0, Math.cos(0.05)],
    linearVelocity: [0, -0.15, 3.5],
    angularDamping: 0.18,
    colliders: { shape: 'box', halfExtents: [0.22, 0.026, 0.111], mass: paperMass },
  });
  let beat = false;
  const wing = new WingForce(physics, body, {
    sections,
    panels: [2, 4],
    density: 1.2,
    separation: 'flapping',
    flap: (time) => ({ stroke: strokeAt(time, beat) }),
  });
  const air = new AirSolver();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } })
    .add(new RigidSolver(), { physics })
    .add(air, { physics })
    .couple(['air', 'rigid'], 'staggered');
  const initial = world.takeSnapshot();
  let checkpoint;
  let tick = 0;
  let impulse = [0, 0, 0];
  let force = [0, 0, 0];

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:720px;height:440px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    exactSize: [width, height],
    backend: 'webgpu',
    camera: { position: [1.42, 0.86, 0.57], target: [0, 0.533, -0.125], fov: 32, near: 0.06, far: 10 },
  });
  engine.scene.background = '#495756';
  engine.lighting.direction.set([0.51, 0.68, 0.49, 2.6]);
  engine.lighting.radiance.set([1, 0.91, 0.79, 0.94]);
  engine.lighting.ambient.set([0.48, 0.55, 0.61]);
  makeGallery(engine);
  const bird = crane(engine);
  const gpu = engine.gpu;
  const gpuErrors = [];
  engine.onError = (error) => gpuErrors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const draw = async () => {
    engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
  };

  function project([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }

  function restore({ snapshot, savedTick, savedImpulse, savedForce }) {
    world.restoreSnapshot(snapshot.bytes);
    tick = savedTick;
    impulse = [...savedImpulse];
    force = [...savedForce];
  }

  const frames = new Map();
  async function render(frame, withBeat, action) {
    const next = Math.max(0, Math.min(lastTick, frame - cue));
    if (action === 'restore' && checkpoint?.beat === withBeat) restore(checkpoint);
    else if (next < tick || withBeat !== beat)
      restore({ snapshot: initial, savedTick: 0, savedImpulse: [0, 0, 0], savedForce: [0, 0, 0] });
    beat = withBeat;

    while (tick < next) {
      world.advance(++tick);
      const port = air.exportPorts(tick).find((field) => field.field === BODY_FORCES_FIELD.name);
      if (!port || port.region.type !== 'f64') throw new Error('The shot requires the accepted AirSolver force.');
      const loads = regionWords(world.memory, port.region);
      const offset = body.row * FORCE_WORDS;
      force = Array.from(loads.subarray(offset, offset + 3));
      if (force.some((value, i) => value !== wing.force[i]))
        throw new Error('The rigid body must receive the active wing force.');
      for (let i = 0; i < 3; i++) impulse[i] += force[i] / rate;
    }

    const snapshot = world.takeSnapshot();
    const key = (beat ? 'beat:' : 'glide:') + next;
    const first = frames.get(key);
    if (!first) frames.set(key, snapshot.bytes);
    else if (first.length !== snapshot.bytes.length || snapshot.bytes.some((value, i) => value !== first[i]))
      throw new Error('The rewound paper body and accepted air loads must repeat byte for byte.');
    if (action === 'save')
      checkpoint = { snapshot, beat, savedTick: tick, savedImpulse: [...impulse], savedForce: [...force] };

    const port = world.fields.port(BODIES_FIELD.name);
    if (!port || port.region.type !== 'f32' || port.region.layout !== 2)
      throw new Error('The rendered origami crane requires the accepted rigid pose.');
    const bodies = regionWords(world.memory, port.region);
    const row = body.row * BODY_WORDS;
    const position = Array.from(bodies.subarray(row, row + 3));
    const rotation = Array.from(bodies.subarray(row + 3, row + 7));
    bird.root.setPosition(position).setQuaternion(rotation);
    const stroke = strokeAt(world.time, beat);
    for (const { hinge, side } of bird.wings) hinge.setRotation([0, 0, side * stroke]);
    await draw();
    return {
      state: snapshot.hash,
      time: world.time,
      position,
      rotation,
      screen: project(position),
      velocity: body.linearVelocity,
      force: [...force],
      impulse: [...impulse],
      stroke,
    };
  }

  await render(0, false);
  await waitForPipelines(draw);
  return {
    cue,
    lastTick,
    gravity,
    paperMass: body.mass,
    render,
    async dispose() {
      wing.remove();
      physics.dispose();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, gpuErrors };
    },
  };
}

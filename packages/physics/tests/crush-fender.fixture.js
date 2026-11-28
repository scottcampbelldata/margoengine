import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { Physics } from '../dist/index.js';
import { CrushShellSolver } from '../dist/crush.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../dist/world.js';

const width = 0.6;
const height = 0.36;
const bottom = 0.34;
const columns = 10;
const rows = 6;
const radius = 0.13;
const mass = 55;
const speed = 0.85;
const cue = 12;
const approach = cue + 7;
const loaded = cue + 16;
const end = cue + 52;
const ticksPerFrame = 4; // A 60 fps cut plays the 480 Hz rig at half speed.

function makeSheet() {
  const positions = [];
  const triangles = [];
  const pinned = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= columns; x++) {
      const row = y * (columns + 1) + x;
      positions.push([(x * width) / columns, bottom + (y * height) / rows, 0]);
      if (x === 0 || y === 0 || x === columns || y === rows) pinned.push(row);
      if (x === columns || y === rows) continue;
      const next = row + columns + 1;
      if ((x + y) % 2) triangles.push([row, row + 1, next], [row + 1, next + 1, next]);
      else triangles.push([row, row + 1, next + 1], [row, next + 1, next]);
    }
  }
  return { positions, triangles, pinned };
}

async function makeRig(sheet) {
  const gravity = [0, 0, 0]; // The fixture supports the carriage and the load is along the guide rails.
  const world = new PhysicsWorld({ rate: { num: 480, den: 1 }, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: 1 / 480, substeps: 4 });
  const carriage = physics.addBody(null, {
    position: [width / 2, bottom + height / 2, radius + 0.08],
    // The shell contact supplies the reaction for this witness geometry.
    colliders: { shape: 'sphere', radius, mass, sensor: true },
  });
  const shell = await CrushShellSolver.loadRigid({ rate: 3 });
  world.add(new RigidSolver(), { physics });
  // Authored test specimen, with the load/deflection/absorbed-work quantities of PIANC WG 211 (2024).
  // https://www.pianc.org/publication/pianc-fender-guidelines-2024/
  world.add(shell, {
    ...sheet,
    material: {
      thickness: 0.012,
      density: 950,
      youngModulus: 200e6,
      poissonRatio: 0.38,
      yieldStress: 450e3,
      hardeningModulus: 1.2e6,
    },
    spheres: [{ body: carriage.row, radius, contactModulus: 17e6 }],
  });
  world.couple([shell.id, 'rigid'], 'staggered');
  world.advance(1);
  return { world, physics, carriage, shell, start: world.takeSnapshot(), tick: 0, impulse: 0, receipts: new Map() };
}

function geometry(positions, triangles) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = 3 * triangles[i];
    const b = 3 * triangles[i + 1];
    const c = 3 * triangles[i + 2];
    const x = positions[b] - positions[a],
      y = positions[b + 1] - positions[a + 1],
      z = positions[b + 2] - positions[a + 2];
    const u = positions[c] - positions[a],
      v = positions[c + 1] - positions[a + 1],
      w = positions[c + 2] - positions[a + 2];
    for (const j of [a, b, c]) {
      normals[j] += y * w - z * v;
      normals[j + 1] += z * u - x * w;
      normals[j + 2] += x * v - y * u;
    }
  }
  for (let j = 0; j < normals.length; j += 3) {
    const length = Math.hypot(normals[j], normals[j + 1], normals[j + 2]);
    normals[j] /= length;
    normals[j + 1] /= length;
    normals[j + 2] /= length;
  }
  return new Geometry(Float32Array.from(positions), normals, triangles);
}

export async function openFender() {
  await Physics.load();
  const sheet = makeSheet();
  const rest = Float64Array.from(sheet.positions.flat());
  const run = await makeRig(sheet);
  const control = await makeRig(sheet);
  const widthPx = 640,
    heightPx = 384;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  document.body.replaceChildren(canvas);
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    exactSize: [widthPx, heightPx],
    antialias: false,
    camera: { position: [-0.69, 0.81, 1.23], target: [0.3, 0.44, 0.18], near: 0.12, far: 6 },
  });
  engine.stop();
  engine.scene.background = '#243840';
  engine.lighting.direction.set([0.66, 0.12, 0.74, 2.2]);
  engine.lighting.radiance.set([1, 0.93, 0.8, 1]);
  engine.lighting.ambient.set([0.5, 0.59, 0.64]);
  const steel = new PbrMaterial({ color: '#506c73', roughness: 0.48, metallic: 0.32 });
  const zinc = new PbrMaterial({ color: '#9caead', roughness: 0.35, metallic: 0.7 });
  const concrete = new PbrMaterial({ color: '#777b75', roughness: 0.85 });
  const rubber = new PbrMaterial({ color: '#26343c', roughness: 0.43 });
  const panelMaterial = new PbrMaterial({ color: '#a8754e', roughness: 0.22 });
  const panel = engine.createMesh().setMaterial(panelMaterial);
  const box = (size, position, material) =>
    engine
      .createMesh()
      .setGeometry(toGeometry(roundedBoxGeometry(...size, Math.min(0.008, ...size.map((v) => v / 6)), 2)))
      .setPosition(position)
      .setMaterial(material);
  box([2.8, 0.13, 2.4], [0.3, -0.065, 0.43], concrete);
  box([0.82, 0.14, 1.17], [0.3, 0.073, 0.37], steel);
  for (const x of [0.085, 0.515]) box([0.028, 0.023, 1.14], [x, 0.152, 0.395], zinc);
  for (const x of [-0.04, 0.64]) {
    box([0.069, 0.65, 0.114], [x, 0.466, -0.072], steel);
    box([0.045, 0.41, 0.044], [x + (x < 0 ? 0.029 : -0.029), 0.52, -0.01], steel);
  }
  for (const y of [0.318, 0.722]) box([0.6, 0.043, 0.044], [0.3, y, -0.01], steel);
  const ball = engine
    .createMesh()
    .setGeometry(toGeometry(sphereGeometry(radius, 32, 20)))
    .setMaterial(rubber);
  const carriageParts = [
    { mesh: ball, offset: [0, 0, 0] },
    { mesh: box([0.09, 0.075, 0.19], [0, 0, 0], zinc), offset: [0, 0, 0.15] },
    { mesh: box([0.19, 0.32, 0.11], [0, 0, 0], steel), offset: [0, -0.145, 0.234] },
    { mesh: box([0.52, 0.04, 0.19], [0, 0, 0], steel), offset: [0, -0.33, 0.225] },
  ];

  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const frame = gpu.createTexture({
    size: [widthPx, heightPx],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const buffer = gpu.createBuffer({
    size: widthPx * heightPx * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: frame } };
  const encoded = document.createElement('canvas');
  encoded.width = widthPx;
  encoded.height = heightPx;
  const output = encoded.getContext('2d');
  let checkpoint;

  function restore(take, { snapshot, tick, impulse }) {
    take.world.restoreSnapshot(snapshot.bytes);
    take.tick = tick;
    take.impulse = impulse;
  }

  async function draw({ shotFrame, parked = false, flatten = false, action }) {
    const take = parked ? control : run;
    const target = ticksPerFrame * Math.max(0, Math.min(end, shotFrame) - cue);
    if (action === 'restore') restore(take, checkpoint);
    if (target < take.tick) restore(take, { snapshot: take.start, tick: 0, impulse: 0 });
    if (target > 0 && take.tick === 0 && !parked) take.carriage.setLinearVelocity([0, 0, -speed]);
    while (take.tick < target) {
      take.world.advance(1 + ++take.tick);
      take.impulse += take.shell.readSphereContact(0).impulse[2];
    }
    const snapshot = take.world.takeSnapshot();
    const earlier = take.receipts.get(take.tick);
    if (earlier && (earlier.length !== snapshot.bytes.length || earlier.some((b, i) => b !== snapshot.bytes[i]))) {
      throw new Error('Replay the accepted shell and carriage snapshots byte for byte.');
    }
    take.receipts.set(take.tick, snapshot.bytes);
    if (action === 'save') checkpoint = { snapshot, tick: take.tick, impulse: take.impulse };
    const { positions, triangles } = take.shell.readMesh();
    const field = take.world.fields.port(take.shell.positionField.name);
    if (!field || field.region.type !== 'f64') throw new Error('Draw the accepted f64 shell positions.');
    const values = regionWords(take.world.memory, field.region);
    if (values.length !== positions.length || values.some((value, i) => value !== positions[i]))
      throw new Error('Read the same shell positions from the registered port and the renderer mesh.');
    for (const p of sheet.pinned) {
      const i = p * 3;
      if (positions[i] !== rest[i] || positions[i + 1] !== rest[i + 1] || positions[i + 2] !== 0)
        throw new Error('Preserve the clamped rim of the mounted fender.');
    }
    panel.setGeometry(geometry(flatten ? rest : positions, triangles));
    const { position, rotation, linearVelocity } = take.carriage;
    for (const { mesh, offset } of carriageParts) {
      mesh.setPosition(rotateByQuaternion(offset, rotation).map((d, i) => d + position[i])).setQuaternion(rotation);
    }
    engine.render({ delta: 0, views: [view] });
    const encoder = gpu.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: frame }, { buffer, bytesPerRow: widthPx * 4 }, [widthPx, heightPx]);
    gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8ClampedArray(buffer.getMappedRange()).slice();
    buffer.unmap();
    output.putImageData(new ImageData(pixels, widthPx, heightPx), 0, 0);
    return {
      image: encoded.toDataURL('image/png').split(',')[1],
      hash: snapshot.hash,
      tick: take.tick,
      position,
      velocity: linearVelocity,
      impulse: take.impulse,
      compression: take.shell.readSphereContact(0).compression,
      plastic: take.shell.readBudget().plasticDissipation,
      inward: Math.max(0, ...positions.filter((_, i) => i % 3 === 2).map((z) => -z)),
      visible: engine.stats.visible,
    };
  }

  return {
    cue,
    approach,
    loaded,
    end,
    mass,
    speed,
    draw,
    async close() {
      const validation = (await gpu.popErrorScope())?.message ?? null;
      frame.destroy();
      buffer.destroy();
      engine.dispose();
      run.physics.dispose();
      control.physics.dispose();
      return { errors, validation };
    },
  };
}

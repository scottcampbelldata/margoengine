import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { DensityVolume } from '@margoengine/environment/density-volume';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import { Physics, Vehicle } from '@margoengine/physics';
import { AirborneParticles } from '@margoengine/physics/airborne';
import { BED_FIELD, BED_LAYOUT, BedCollider, TerrainBed } from '@margoengine/physics/earth';
import {
  SOIL_LAYOUT,
  SOIL_PATCH_WORDS,
  SOIL_RESPONSE_WORDS,
  SOIL_WHEEL_POSE_WORDS,
  SOIL_WHEEL_REACTION_WORDS,
  SoilContactRigidSolver,
  Terramechanics,
  soilPatchField,
  soilWheelPhaseField,
  soilWheelPoseField,
  soilWheelReactionField,
} from '@margoengine/physics/terramechanics';
import { BODIES_FIELD, BODY_WORDS, PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const seed = 0x431f26;
const cue = 18;
const preload = 6;
const checkpoint = 18;
const motorStop = 31;
const end = 52;
const cell = [-6, 3, 14];
const cellSize = 64;
const columns = 48;
const rows = 48;
const span = 1.44;
const dx = span / columns;
const terrain = { columns, rows, width: span, depth: span, centre: [0, 0] };
const vertices = (columns + 1) * (rows + 1);
const radius = 0.16;
const tyreWidth = 0.165;
const lugHeight = 0.012;
const lugWidth = 0.021;
const lugCount = 12;
const bulkDensity = 1600;
const capacity = 4096;
const bodyAt = [0, 0.28, 0];

async function take(powered) {
  const field = soilPatchField();
  const phase = soilWheelPhaseField();
  const wheelPose = soilWheelPoseField();
  const reaction = soilWheelReactionField();
  const soil = await Terramechanics.load({
    tier: 'resolved',
    input: field,
    wheelReaction: reaction,
    wheelPhase: phase,
  });
  const rigid = new SoilContactRigidSolver(field, { terrain, wheelReaction: reaction, wheelPhase: phase, wheelPose });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, cellSize, memory: worldMemory(false) });
  const bed = new TerrainBed();
  world.add(bed, { ...terrain, elevations: () => 0 }, cell);
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate });
  const ground = new BedCollider(physics, bed.bed);
  const chassis = physics.addBody(null, {
    type: 'dynamic',
    position: bodyAt,
    lockRotations: true,
    enabledTranslations: [false, false, false],
    colliders: { shape: 'box', halfExtents: [0.1, 0.05, 0.1], mass: 90 },
  });
  const vehicle = new Vehicle(physics, chassis, {
    maxEngineForce: 420,
    maxBrakeForce: 4000,
    wheels: [
      {
        position: [0, 0, 0],
        radius,
        width: tyreWidth,
        inertia: 0.5,
        suspensionRestLength: 0.3,
        suspensionStiffness: 8,
      },
    ],
    tyre: { forces: () => ({ longitudinal: 0, lateral: 0 }) },
  });
  physics.on('beforestep', () => {
    const run = powered && physics.stepCount >= preload && physics.stepCount < motorStop;
    vehicle.setInput(run ? { throttle: 0.8 } : { brake: 1 });
  });
  world.add(
    rigid,
    { physics, ground, wheels: [{ vehicle, patches: [{ width: tyreWidth, length: 0.16 }], shearRadii: [radius] }] },
    cell,
  );
  world.add(
    soil,
    {
      terrain,
      cellSize,
      inputRows: 1,
      material: { cohesion: 3000, friction: 0.7, compaction: 0.3, dustFraction: 0.001, density: bulkDensity },
      rollingWheels: [
        { radius, lugHeight, lugCount, lugWidth, bermProfile: 'cross-track', grouserFill: 0.6, grouserDig: true },
      ],
    },
    cell,
  );
  const air = await AirborneParticles.load({ terrain: true, dustField: soil.dustField });
  world.add(air, { terrain, cellSize, capacity, dustReleaseHeight: 0.073, dustLiftVelocity: 0.32 }, cell);
  world.couple([rigid.id, soil.id, bed.id], 'staggered');
  world.advance(preload);
  return {
    field,
    wheelPose,
    phase,
    reaction,
    world,
    bed,
    physics,
    chassis,
    vehicle,
    soil,
    air,
    first: world.takeSnapshot(),
    frame: preload,
    records: new Map(),
  };
}

function seek(take, goal, action) {
  const { world } = take;
  if (action === 'restore' || goal < take.frame) {
    const point = action === 'restore' ? take.checkpoint : { frame: preload, snapshot: take.first };
    world.restoreSnapshot(point.snapshot.bytes);
    take.frame = point.frame;
  }
  if (goal > take.frame) {
    world.advance(goal);
    take.frame = goal;
  }
  const snapshot = world.takeSnapshot();
  const prior = take.records.get(goal);
  if (prior && (prior.length !== snapshot.bytes.length || prior.some((value, i) => value !== snapshot.bytes[i])))
    throw new Error('Rewind the native terrain, rigid wheel, soil and mineral parcels to the exact accepted snapshot.');
  take.records.set(goal, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame: goal, snapshot };
  return snapshot.hash;
}

function accepted(take) {
  const { world, bed, chassis, soil, air } = take;
  const read = (field, type, layout, count) => {
    const port = world.fields.port(field.name);
    if (port?.region.type !== type || port.region.layout !== layout || port.cell.some((v, i) => v !== cell[i]))
      throw new Error('Use the accepted soil, wheel and dust fields in a shared nonzero signed cell.');
    const words = regionWords(world.memory, port.region);
    if (count !== undefined && words.length !== count) throw new Error('Publish the matching physical contact shape.');
    return words;
  };
  const sample = soil.read(0);
  const wheel = read(take.wheelPose, 'f64', SOIL_LAYOUT, SOIL_WHEEL_POSE_WORDS);
  const print = read(take.field, 'f64', SOIL_LAYOUT, SOIL_PATCH_WORDS);
  const phase = read(take.phase, 'f64', SOIL_LAYOUT, 1)[0];
  const reaction = Array.from(read(take.reaction, 'f64', SOIL_LAYOUT, SOIL_WHEEL_REACTION_WORDS));
  const result = read(soil.responseField, 'f64', SOIL_LAYOUT, SOIL_RESPONSE_WORDS);
  const groundField = read(BED_FIELD, 'f32', BED_LAYOUT, vertices);
  const terrainHeights = bed.elevations();
  read(air.particleField, 'f64', 1);
  if (groundField.some((h, i) => h !== Math.fround(terrainHeights[i]))) throw new Error('Draw the live bed geometry.');
  if (
    print[6] !== sample.normalForce ||
    wheel[9] !== sample.normalForce ||
    phase !== wheel[8] ||
    result.some((value, i) => value !== [sample.pressure, sample.sinkage, sample.shearStress, sample.normalForce][i])
  )
    throw new Error('Draw the same accepted hub, angle and wheel load read by the soil.');
  const bodies = read(BODIES_FIELD, 'f32', 2);
  const start = BODY_WORDS * chassis.row;
  const orientation = bodies.subarray(start + 3, start + 7);
  const position = rotateByQuaternion(wheel.subarray(0, 3), orientation).map((value, i) => value + bodies[start + i]);
  const quaternion = multiplyQuaternions(orientation, wheel.subarray(3, 7));
  return {
    minimum: Math.min(...terrainHeights),
    maximum: Math.max(...terrainHeights),
    bedVolume: bed.volume(),
    refused: bed.refusedVolume(),
    budget: soil.budget,
    response: sample,
    reaction,
    phase,
    spin: wheel[7],
    speed: Math.hypot(bodies[start + 10], bodies[start + 12]),
    position,
    quaternion,
    dustBudget: air.budget,
  };
}

function groundMesh(bed) {
  const positions = [];
  const colors = [];
  const indices = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const x = i * dx - span / 2;
      const z = j * dx - span / 2;
      const { elevation } = bed.sample(x, z);
      positions.push(x, elevation, z);
      const coarse = 0.94 + 0.08 * Math.cos(91.7 * x + 59.3 * z) * Math.sin(77.1 * x - 44.3 * z);
      const grain = coarse + 0.044 * Math.cos(i * 6.112 + j * 3.849);
      colors.push(0.36 * grain, 0.206 * grain, 0.105 * grain, 1);
      if (i < columns && j < rows) {
        const a = j * (columns + 1) + i;
        const b = a + columns + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const mesh = geometryData(
    positions,
    new Float32Array(positions.length),
    new Float32Array((positions.length * 2) / 3),
    indices,
  );
  mesh.colors = Float32Array.from(colors);
  return computeVertexNormals(mesh);
}

function dynamometer(engine) {
  // Original single wheel rig, informed by NASA Glenn's SLOPE soil bins and TREC load stand.
  // https://www.nasa.gov/glenn/virtual-tours/slope360/
  const rubber = new PbrMaterial({ color: '#393938', roughness: 0.85 });
  const steel = new PbrMaterial({ color: '#919fa4', metallic: 1, roughness: 0.38 });
  const accent = new PbrMaterial({ color: '#c78a37', roughness: 0.44 });
  const dark = new PbrMaterial({ color: '#45505a', metallic: 1, roughness: 0.6 });
  const root = engine.createMesh();
  const stamp = (geometry, material, position, parent = null) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position).setParent(parent);
  const beam = (width, height, depth, bevel, material, position, parent) =>
    stamp(toGeometry(roundedBoxGeometry(width, height, depth, 2, bevel)), material, position, parent);
  const barrel = (r0, r1, length, material, position, parent) =>
    stamp(toGeometry(cylinderGeometry(r0, r1, length, 48)), material, position, parent).setRotation([
      0,
      0,
      -Math.PI / 2,
    ]);

  barrel(radius, radius, tyreWidth - 0.026, rubber, [0, 0, 0], root);
  for (const side of [-1, 1]) {
    barrel(radius - 0.006, radius, 0.014, rubber, [side * (tyreWidth / 2 - 0.013), 0, 0], root);
    barrel(0.097, 0.097, 0.004, steel, [side * (tyreWidth / 2 - 0.005), 0, 0], root);
  }
  barrel(0.085, 0.06, 0.012, accent, [tyreWidth / 2 + 0.002, 0, 0], root);
  barrel(0.035, 0.035, 0.019, dark, [tyreWidth / 2 + 0.017, 0, 0], root);
  const tread = toGeometry(roundedBoxGeometry(tyreWidth - 0.014, lugHeight, lugWidth, 1, 0.002));
  for (let i = 0; i < lugCount; i++) {
    const angle = (i * 2 * Math.PI) / lugCount;
    const r = radius + lugHeight / 2;
    const color = i === 0 ? accent : rubber;
    stamp(tread, color, [0, r * Math.cos(angle), r * Math.sin(angle)], root).setRotation([angle, 0, 0]);
  }
  const bolt = toGeometry(cylinderGeometry(0.006, 0.006, 0.008, 8));
  for (let i = 0; i < 8; i++) {
    const angle = (i * 2 * Math.PI) / 8;
    stamp(bolt, steel, [0.094, 0.062 * Math.cos(angle), 0.062 * Math.sin(angle)], root).setRotation([
      0,
      0,
      -Math.PI / 2,
    ]);
  }
  beam(0.09, 0.57, 0.075, 0.008, dark, [-0.48, 0.24, -0.16]);
  beam(0.69, 0.052, 0.055, 0.009, dark, [-0.25, 0.423, -0.16]);
  beam(0.087, 0.073, 0.16, 0.009, accent, [-0.14, 0.39, -0.1]);
  barrel(0.026, 0.026, 0.13, steel, [-0.12, 0, 0], root);
  const spindle = stamp(box(0.034, 1, 0.032), steel, [-0.175, 0.21, 0]);

  const foundation = new PbrMaterial({ color: '#61574b', roughness: 0.71 });
  beam(span + 0.092, 0.17, span + 0.092, 0.028, foundation, [0, -0.246, 0]);
  beam(span + 0.048, 0.179, 0.045, 0.009, dark, [0, -0.081, 0.737]);
  beam(0.045, 0.179, span + 0.034, 0.009, dark, [0.737, -0.081, 0]);
  engine
    .createMesh()
    .setGeometry(box(7, 0.12, 7))
    .setMaterial(foundation)
    .setPosition([0, -0.414, 0]);
  for (let i = 0; i < 5; i++) {
    const z = 0.17 + 0.0547 * i;
    stamp(box(0.044, 0.006, 0.006), accent, [0.46, 0.006, z]);
  }
  return (reading) => {
    root.setPosition(reading.position).setQuaternion(reading.quaternion);
    spindle.setPosition([-0.175, (reading.position[1] + 0.385) / 2, 0]);
    spindle.setScale([1, 0.385 - reading.position[1], 1]);
  };
}

const sigma = 0.023;
const volume = (Math.sqrt(2 * Math.PI) * sigma) ** 3;

function dustField(dust, air, visible) {
  const positions = [];
  const weights = [];
  let opticalArea = 0;
  let altitude = 0;
  let mass = 0;
  for (const parcel of air.readParticles()) {
    const { kind, position, materialDensity, diameter } = parcel;
    if (kind !== 'mineral-dust' || !(materialDensity > 0) || !(diameter > 0))
      throw new Error('Render only the accepted mineral parcels emitted by the contact.');
    // The geometric-optics extinction limit Qext=2 applies for 20 μm grains in visible light.
    // Each point spreads the resulting parcel cross section over a display Gaussian.
    const area = (3 * parcel.mass) / (materialDensity * diameter);
    positions.push(...position);
    weights.push(area / volume);
    opticalArea += area;
    altitude += parcel.mass * position[1];
    mass += parcel.mass;
  }
  dust.clear();
  if (visible && weights.length) dust.splat(positions, { radius: sigma, weight: weights });
  return { particles: weights.length, opticalArea, altitude: mass ? altitude / mass : 0, mass };
}

export async function mountTerramechanicsFilm() {
  await Physics.load();
  const [motor, parked] = await Promise.all([take(true), take(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0.81, 0.58, 1.0], target: [0, 0.129, 0.04], fov: 43, near: 0.055, far: 8 },
  });
  engine.scene.background = '#26363e';
  engine.lighting.direction.set([-0.64, 0.55, 0.36, 1.72]);
  engine.lighting.radiance.set([1, 0.94, 0.81, 1]);
  engine.lighting.ambient.set([0.43, 0.48, 0.55]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');

  const moveWheel = dynamometer(engine);
  const bed = createMesh(
    engine,
    groundMesh(motor.bed.bed),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.92 }),
  );
  const medium = new DensityVolume({ voxelSize: 0.015, color: [0.73, 0.55, 0.37] });
  const atmosphere = VolumetricFog.attach(engine, {
    density: 0,
    volumes: medium,
    grid: [69, 44, 64],
    range: 2.35,
    ambient: [0.57, 0.62, 0.68],
    anisotropy: 0.45,
    temporal: 0,
  });
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const sub = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, font, fontSize, position) =>
    labels.add(new Text({ text, font, fontSize, position, color: '#efe1c7', billboard: true, onTop: true }));
  label('A driven wheel digs into sand', title, 0.041, [-0.54, 0.52, -0.39]);
  label('Held axle · 32 cm rim diameter · native soil contact', sub, 0.022, [-0.54, 0.47, -0.386]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.05 });

  const rgba = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const output = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: rgba } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  await waitForPipelines(draw);

  return {
    cue,
    rate,
    preload,
    checkpoint,
    motorStop,
    end,
    seed,
    bulkDensity,
    async sample({ editFrame, action, powered = true, dustVisible = true }) {
      const frame = Math.max(preload, Math.min(end, editFrame - cue + preload));
      const take = powered ? motor : parked;
      const hash = seek(take, frame, action);
      const reading = accepted(take);
      moveWheel(reading);
      bed.setGeometry(groundMesh(take.bed.bed));
      const dust = dustField(medium, take.air, dustVisible);
      draw();
      draw();
      const commands = gpu.createCommandEncoder();
      commands.copyTextureToBuffer({ texture: rgba }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([commands.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const rgba8 = new Uint8ClampedArray(output.getMappedRange()).slice();
      output.unmap();
      pixels.putImageData(new ImageData(rgba8, width, height), 0, 0);
      return { frame, hash, ...reading, dust, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      bed.destroy();
      atmosphere.dispose();
      medium.dispose();
      labels.dispose();
      rgba.destroy();
      output.destroy();
      for (const { vehicle, physics, soil, air } of [motor, parked]) {
        vehicle.dispose();
        physics.dispose();
        soil[Symbol.dispose]?.();
        air[Symbol.dispose]?.();
      }
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

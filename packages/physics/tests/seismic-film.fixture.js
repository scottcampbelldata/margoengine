import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { Physics } from '@margoengine/physics';
import { SEISMIC_LAYOUT, SeismicGround, SeismicInertialLoad } from '@margoengine/physics/seismic';
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const countX = 48;
const countDepth = 32;
const spacing = 25;
const surfaceWords = 8;
const siteWords = 6;
const scale = 40;
const sectionSize = [countX * spacing, countDepth * spacing];
const origin = [-sectionSize[0] / 2, 0, 0];
const cell = [-5, 3, 12];
const seed = 0x89c153;
const rate = 120;
const cue = 20;
const pulse = 22;
const checkpoint = 68;
const end = 90;
const station = 25;
const stationX = (station + 0.5) * spacing;
const frequency = 2;
const dampingRatio = 0.08;
const mass = 2;
const locus = [430, 222];
const source = { position: locus, moment: [1.3e10, -1.3e10, 4.5e9], timescale: 0.078, start: 14 / rate };
const layer = 100;
const crust = (_, depth) =>
  depth < layer
    ? { density: 1940, compressionalSpeed: 950, shearSpeed: 490, damping: 0.02 }
    : { density: 2340, compressionalSpeed: 1650, shearSpeed: 910, damping: 0.006 };

async function makeTake(active) {
  const wave = await SeismicGround.load();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, cellSize: 2048, seed, memory: worldMemory(false) });
  world.add(
    wave,
    {
      width: countX,
      depth: countDepth,
      spacing: [spacing, spacing],
      origin,
      material: crust,
      sources: active ? [source] : [],
      sites: [{ x: stationX, frequency, dampingRatio }],
    },
    cell,
  );
  const physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const body = physics.addBody(null, {
    enabledTranslations: [true, false, false],
    lockRotations: true,
    colliders: { shape: 'box', halfExtents: [0.15, 0.05, 0.05], mass, sensor: true },
  });
  const capacity = physics.kernel.capacity;
  const inertialLoad = new SeismicInertialLoad(wave.groundField);
  const rigid = new RigidSolver();
  world.add(rigid, { physics, capacity }, cell);
  world.add(inertialLoad, { bodyCapacity: capacity, supports: [{ body: body.row, column: station }] }, cell);
  world.couple([rigid.id, inertialLoad.id], 'staggered');
  return { world, wave, physics, inertialLoad, body, first: world.takeSnapshot(), frame: 0, records: new Map() };
}

function advance(take, frame, action) {
  const { world } = take;
  if (action === 'restore' || frame < take.frame) {
    const point = action === 'restore' ? take.checkpoint : { frame: 0, snapshot: take.first };
    world.restoreSnapshot(point.snapshot.bytes);
    take.frame = point.frame;
  }
  if (frame > take.frame) {
    world.advance(frame);
    take.frame = frame;
  }
  const snapshot = world.takeSnapshot();
  const past = take.records.get(frame);
  if (past && (past.length !== snapshot.bytes.length || past.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error('Replaying the rupture must restore the full wavefield, site and rigid witness bytes.');
  take.records.set(frame, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame, snapshot };
  return snapshot.hash;
}

function accepted(take) {
  const { world, wave, body, inertialLoad } = take;
  const read = (field, type, layout, length) => {
    const port = world.fields.port(field.name);
    if (
      port?.region.type !== type ||
      port.region.layout !== layout ||
      (length !== undefined && port.region.byteLength !== length * (type === 'f32' ? 4 : 8)) ||
      port.cell.some((value, i) => value !== cell[i])
    )
      throw new Error('Render only the seismic station and rigid witness published in their shared signed cell.');
    return regionWords(world.memory, port.region);
  };
  const surface = read(wave.groundField, 'f64', SEISMIC_LAYOUT, surfaceWords * countX);
  const sites = read(wave.siteField, 'f64', SEISMIC_LAYOUT, siteWords);
  const rigid = read(BODIES_FIELD, 'f32', 2);
  const motion = wave.motion(station);
  const fitted = wave.reading();
  const row = [...motion.position, ...motion.velocity, ...motion.acceleration, motion.peakHorizontalAcceleration];
  const values = [
    fitted.displacement,
    fitted.velocity,
    fitted.relativeAcceleration,
    fitted.absoluteAcceleration,
    fitted.cyclicStress,
    Number(fitted.liquefactionPotential),
  ];
  if (
    row.some((value, i) => value !== surface[station * surfaceWords + i]) ||
    sites.some((value, i) => value !== values[i])
  )
    throw new Error('Match the published surface acceleration and site response exactly.');
  const force = inertialLoad.exportPorts(take.frame).find((port) => port.field === BODY_FORCES_FIELD.name);
  const start = body.row * BODY_WORDS;
  if (take.frame > 0 && force.cell.some((v, i) => v !== cell[i]))
    throw new Error('The inertial load belongs to the station’s signed origin cell.');
  const forces = regionWords(force.region.memory ?? world.memory, force.region);
  return {
    motion,
    site: fitted,
    force: forces[body.row * FORCE_WORDS],
    inverseMass: rigid[start + 16],
    bodyDisplacement: rigid[start],
    bodyVelocity: rigid[start + 10],
  };
}

function geologicalColor(x, depth) {
  const phase = (seed % 4096) / 4096;
  const grain = 0.92 + 0.057 * Math.sin(0.14 * x + phase) * Math.cos(0.152 * x - 0.25 * depth);
  const strata = 0.91 + 0.084 * Math.sin(0.091 * depth + 0.8 * Math.sin(0.011 * x));
  const palette = depth < layer ? [0.34, 0.219, 0.122] : [0.152, 0.163, 0.157];
  return palette.map((value) => value * grain * strata);
}

function section(wave, showWave) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let peakX = 0;
  let peakY = 0;
  let covered = 0;
  for (let j = 0; j <= countDepth + 1; j++)
    for (let i = 0; i <= countX + 1; i++) {
      const x = Math.max(0, Math.min(countX - 1, i - 1));
      const z = Math.max(0, Math.min(countDepth - 1, j - 1));
      const metresX = Math.max(0, Math.min(sectionSize[0], (i - 0.5) * spacing));
      const depth = Math.max(0, Math.min(sectionSize[1], (j - 0.5) * spacing));
      const speed = wave.velocity(x, z);
      const magnitude = Math.hypot(...speed);
      if (i > 0 && i <= countX && j > 0 && j <= countDepth) {
        peakX = Math.max(peakX, Math.abs(speed[0]));
        peakY = Math.max(peakY, Math.abs(speed[1]));
        if (magnitude > 0.005) covered++;
      }
      const intensity = showWave ? 0.78 * (1 - Math.exp(-magnitude / 0.032)) : 0;
      const hue = speed[0] < 0 ? [0.19, 0.66, 0.71] : [0.33, 0.7, 0.69];
      const tone = geologicalColor(metresX, depth).map((value, c) => value * (1 - intensity) + hue[c] * intensity);
      positions.push((origin[0] + metresX) / scale, -depth / scale, 0);
      normals.push(0, 0, 1);
      colors.push(...tone, 1);
      if (i < countX + 1 && j < countDepth + 1) {
        const a = i + j * (countX + 2);
        const b = a + countX + 2;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const shape = geometryData(positions, normals, new Float32Array((positions.length * 2) / 3), indices);
  shape.colors = Float32Array.from(colors);
  return { shape, peakX, peakY, covered };
}

const stationScale = 150; // 5 mm physical station displacement per 0.75 unit in the instrument overlay.

function instruments(engine, text) {
  const tone = new PbrMaterial({ color: '#3e565c', roughness: 0.73 });
  const rails = new PbrMaterial({ color: '#879f9d', roughness: 0.61 });
  const brass = new PbrMaterial({ color: '#cc9b52', roughness: 0.45 });
  const turquoise = new PbrMaterial({ color: '#5a978e', roughness: 0.51 });
  const prop = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const housing = toGeometry(roundedBoxGeometry(5.5, 0.32, 1.8, 2, 0.1));
  const weight = toGeometry(roundedBoxGeometry(0.72, 0.58, 0.78, 2, 0.09));
  const track = box(4.5, 0.08, 0.073);
  const pips = toGeometry(cylinderGeometry(0.05, 0.05, 0.13, 12));
  const rules = [
    [-4.15, 2.05, -1.4],
    [4.15, 2.05, -1.4],
  ];
  const blocks = rules.map(([x, y, z], i) => {
    prop(housing, tone, [x, y, z]);
    for (const side of [-1, 1]) prop(box(0.18, y - 0.1, 0.19), tone, [x + 2 * side, y / 2, z - 0.44]);
    for (const side of [-1, 1]) prop(track, rails, [x, y + 0.23, z + 0.31 * side]);
    for (let j = -3; j <= 3; j++)
      prop(pips, j === 0 ? brass : rails, [x + j * 0.005 * stationScale, y + 0.2, z + 0.57]);
    text(i === 0 ? 'Elastic station · 2 Hz' : 'Rigid witness · 2 kg', [x - 2.3, y + 1.55, z], 0.52);
    return prop(weight, i === 0 ? brass : turquoise, [x, y + 0.55, z]);
  });
  return (siteDisplacement, bodyDisplacement, visible) => {
    for (const [i, d] of [siteDisplacement, bodyDisplacement].entries()) {
      const [x, y, z] = rules[i];
      blocks[i].setPosition([x + stationScale * (visible ? d : 0), y + 0.55, z]);
    }
  };
}

export async function mountSeismicFilm() {
  await Physics.load();
  const [active, still] = await Promise.all([makeTake(true), makeTake(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [7.2, 5.7, 38], target: [0, -5.9, -0.5], fov: 44, near: 0.2, far: 96 },
  });
  engine.scene.background = '#22323b';
  engine.lighting.direction.set([-0.47, 0.65, 0.51, 1.72]);
  engine.lighting.radiance.set([1, 0.93, 0.8, 1]);
  engine.lighting.ambient.set([0.45, 0.52, 0.57]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const rock = new PbrMaterial({ color: '#415451', roughness: 0.87 });
  const gravel = new PbrMaterial({ color: '#9a7850', roughness: 0.93 });
  const foundations = [-sectionSize[1] / scale, sectionSize[0] / scale];
  engine
    .createMesh()
    .setGeometry(box(foundations[1], -foundations[0], 4.68))
    .setMaterial(rock)
    .setPosition([0, foundations[0] / 2, -2.35]);
  engine
    .createMesh()
    .setGeometry(box(foundations[1], 0.22, 4.68))
    .setMaterial(gravel)
    .setPosition([0, 0.09, -2.35]);
  const geology = createMesh(
    engine,
    section(active.wave, true).shape,
    new SurfaceMaterial({ vertexColors: true, roughness: 0.92 }),
  );
  const labels = TextRenderer.attach(engine);
  const noteFont = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const titleFont = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const label = (text, position, fontSize, font = noteFont, color = '#e5ddc5') =>
    labels.add(new Text({ text, position, fontSize, font, color, billboard: true, onTop: true }));
  label('A shallow earthquake through layered ground', [-14.0, 7.2, -0.5], 0.86, titleFont);
  label('1.2 km section · cyan shows rock particle speed', [-14.0, 6.0, -0.5], 0.57);
  label('5 mm per division', [-2.8, 0.88, -0.25], 0.53);
  const scalePaint = new PbrMaterial({ color: '#cfbaa0', roughness: 0.78 });
  for (const d of [200, 400, 600]) {
    const y = -d / scale;
    engine
      .createMesh()
      .setGeometry(box(0.55, 0.04, 0.05))
      .setMaterial(scalePaint)
      .setPosition([origin[0] / scale + 0.31, y, 0.03]);
    label(d + ' m', [origin[0] / scale - 2.1, y, 0.09], 0.55);
  }
  const move = instruments(engine, label);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.12 });

  const rgb = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const output = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: rgb } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  await waitForPipelines(draw);
  return {
    rate,
    cue,
    pulse,
    checkpoint,
    end,
    seed,
    frequency,
    dampingRatio,
    mass,
    async sample({ editFrame, action, rupture = true, showWave = true, showWitnesses = true }) {
      const take = rupture ? active : still;
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hash = advance(take, frame, action);
      const reading = accepted(take);
      const mapped = section(take.wave, showWave);
      geology.setGeometry(mapped.shape);
      move(reading.site.displacement, reading.bodyDisplacement, showWitnesses);
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgb }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
      output.unmap();
      pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
      const { peakX, peakY, covered } = mapped;
      return { frame, hash, ...reading, peakX, peakY, covered, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      geology.destroy();
      labels.dispose();
      rgb.destroy();
      output.destroy();
      for (const { wave, physics } of [active, still]) {
        wave[Symbol.dispose]?.();
        physics.dispose();
      }
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

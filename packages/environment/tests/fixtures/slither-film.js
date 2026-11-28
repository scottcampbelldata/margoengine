import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { planeGeometry, sphereGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { LambertMaterial, PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { BED_FIELD, TerrainBed } from '@margoengine/physics/earth';
import {
  GROUND_CONTACT_FIELD,
  GROUND_LOCOMOTION_LAYOUT,
  GROUND_POSE_FIELD,
  GroundLocomotion,
} from '@margoengine/physics/locomotion';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 24;
const checkpoint = 135;
const end = 480;
const cellSize = 32;
const animalCell = [-5, 2, 7];
const bedCell = [-6, 2, 7];
const offset = (animalCell[0] - bedCell[0]) * cellSize;
const bedShape = { width: 0.48, depth: 0.96, columns: 12, rows: 24, centre: [offset, 0] };
const length = 0.36;
const links = 32;
const mass = 0.0152;
const radius = 0.0044;
const gravity = 9.80665;
const frequency = 0.5;
const startZ = -0.255;

// A gently cambered board. Its shape matters only through the actual signed TerrainBed port.
const elevation = (x, z) => 0.016 + 0.0035 * (x - offset) + 0.00035 * Math.sin(7 * z + 0.82);
const groundAt = (bed, x, z) => bed.sample(x + offset, z).elevation;

async function take(grip) {
  // Hu, Nirody, Scott, Shelley (2009), doi:10.1073/pnas.0812533106, measured the juvenile size, mass,
  // period and cloth friction. Bend and wave count are authored for the reduced model. The control uses equal
  // friction in each direction at the same forward coefficient. The scene is a mechanism check, not a fitted trial.
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    cellSize,
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const terrain = new TerrainBed();
  world.add(terrain, { ...bedShape, elevations: elevation }, bedCell);
  const gait = await GroundLocomotion.load({ bedShape, cellSize });
  world.add(
    gait,
    {
      bodies: [
        {
          kind: 'snake',
          length,
          mass,
          radius,
          links,
          frequency,
          position: [0, groundAt(terrain.bed, 0, startZ) + 0.85 * radius, startZ],
          phase: 0.13,
          waves: 1.6,
          bend: 0.8,
          friction: 0.11,
          reverseFriction: grip ? 0.14 : 0.11,
          lateralFriction: grip ? 0.2 : 0.11,
        },
      ],
    },
    animalCell,
  );
  return { world, terrain, gait, frame: 0, first: world.takeSnapshot(), records: new Map() };
}

function accepted(take) {
  const { world, gait } = take;
  const bed = world.fields.port(BED_FIELD.name);
  if (!bed || bed.cell.some((v, i) => v !== bedCell[i]))
    throw new Error('Place the actual terrain in the adjacent signed cell.');
  function words(field, count) {
    const port = world.fields.port(field.name);
    if (
      port?.region.type !== 'f64' ||
      port.region.layout !== GROUND_LOCOMOTION_LAYOUT ||
      port.region.byteLength !== count * Float64Array.BYTES_PER_ELEMENT ||
      port.cell.some((v, i) => v !== animalCell[i])
    )
      throw new Error('Read the accepted animal geometry and contact data in the signed render cell.');
    return regionWords(world.memory, port.region);
  }
  const pose = gait.read(0);
  const body = [...pose.position, ...pose.velocity, ...pose.rotation, ...pose.angularMomentum, pose.phase];
  if (words(GROUND_POSE_FIELD, 14).some((v, i) => v !== body[i]))
    throw new Error('The animal pose differs from its registered row.');
  const published = words(GROUND_CONTACT_FIELD, 13 * links);
  const contacts = Array.from({ length: gait.contactCount(0) }, (_, i) => {
    const contact = gait.readContact(0, i);
    const row = [...contact.position, ...contact.axis, ...contact.force, Number(contact.stance), ...contact.couple];
    if (row.some((v, j) => v !== published[13 * i + j]))
      throw new Error('Shape the animal using the registered link poses.');
    const [x, , z] = contact.position;
    return { ...contact, ground: groundAt(take.terrain.bed, x, z) };
  });
  return { pose, contacts };
}

const halfLink = length / (2 * links);
const sides = 14;
const steps = 5;
const scaleCount = (links + 1) * steps;
const eyesAt = Math.floor(0.965 * scaleCount);
const plain = [0.59, 0.41, 0.24];
const red = [0.49, 0.079, 0.05];
const dark = [0.041, 0.03, 0.029];

function spline(knots, index) {
  const at = Math.min(knots.length - 2, Math.floor(index / steps));
  const t = index / steps - at;
  const a = knots[Math.max(0, at - 1)];
  const b = knots[at];
  const c = knots[at + 1];
  const d = knots[Math.min(knots.length - 1, at + 2)];
  return b.map(
    (v, i) =>
      v + 0.5 * t * (c[i] - a[i] + t * (2 * a[i] - 5 * v + 4 * c[i] - d[i] + t * (3 * (v - c[i]) + d[i] - a[i]))),
  );
}

function skinColor(u, angle, row, side) {
  // Broad rust and fine charcoal/ivory bands from juvenile milksnake imagery, including Hu et al. Fig. 1.
  // Smithsonian, https://www.si.edu/object/milk-snake%3Anmnheducation_10841849
  const bands = 12.1 * u + 0.12 * Math.cos(angle) + 0.028 * Math.sin(77 * u + angle);
  const mark = bands - Math.floor(bands);
  const belly = Math.sin(angle) < -0.47;
  let base = mark < 0.57 ? red : mark < 0.73 || mark > 0.89 ? dark : plain;
  if (u > 0.94) base = belly || u < 0.958 ? plain : dark;
  const grain = 0.965 + 0.055 * Math.sin(row * 2.41 + side * 4.17) * Math.cos(row * 1.75 - side * 1.9);
  return [...base.map((channel) => channel * grain * (belly ? 0.89 : 1)), 1];
}

function animal(contacts) {
  const first = contacts[0];
  const last = contacts.at(-1);
  const knots = [
    first.position.map((v, i) => v - halfLink * first.axis[i]),
    ...contacts.map((c) => c.position),
    last.position.map((v, i) => v + halfLink * last.axis[i]),
  ];
  const center = Array.from({ length: scaleCount + 1 }, (_, i) => spline(knots, i));
  const positions = [];
  const normals = [];
  const colors = [];
  const triangles = [];
  const eyes = [];
  for (const [i, p] of center.entries()) {
    const before = center[Math.max(0, i - 1)];
    const after = center[Math.min(scaleCount, i + 1)];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const magnitude = Math.hypot(tx, tz);
    const side = [tz / magnitude, 0, -tx / magnitude];
    const u = i / scaleCount;
    const tail = 0.105 + 0.895 * Math.min(1, u / 0.41) ** 0.74;
    const neck = 1 - 0.28 * Math.exp(-((u - 0.905) ** 2) / 0.00033);
    const face =
      u > 0.94 ? 1 + 0.19 * Math.sin((Math.PI * (u - 0.94)) / 0.06) - 0.62 * Math.max(0, (u - 0.978) / 0.022) : 1;
    const r = radius * tail * neck * face;
    if (i === eyesAt)
      for (const sign of [-1, 1])
        eyes.push([p[0] + sign * r * 0.84 * side[0], p[1] + r * 0.44, p[2] + sign * r * 0.84 * side[2]]);
    for (let j = 0; j < sides; j++) {
      const angle = (2 * Math.PI * j) / sides;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      positions.push(p[0] + side[0] * c * r, p[1] + s * r * 0.76, p[2] + side[2] * c * r);
      const norm = Math.hypot(c, s / 0.76);
      normals.push((side[0] * c) / norm, s / (0.76 * norm), (side[2] * c) / norm);
      colors.push(...skinColor(u, angle, i, j));
      if (i === 0) continue;
      const previous = (i - 1) * sides;
      const current = i * sides;
      const next = (j + 1) % sides;
      triangles.push(previous + j, previous + next, current + j, current + j, previous + next, current + next);
    }
  }
  const tip = scaleCount * sides;
  for (let j = 1; j + 1 < sides; j++) triangles.push(0, j + 1, j, tip, tip + j, tip + j + 1);
  const skin = geometryData(
    Float32Array.from(positions),
    Float32Array.from(normals),
    new Float32Array((2 * positions.length) / 3),
    Uint32Array.from(triangles),
  );
  skin.colors = Float32Array.from(colors);
  const anchors = contacts.map((_, i) => center[(i + 1) * steps]);
  return { skin, eyes, anchors, head: center.at(-1), tail: center[0] };
}

function track(engine, bed) {
  const w = bedShape.width;
  const d = bedShape.depth;
  const plane = planeGeometry(w, d, 72, 144);
  const tint = new Float32Array((plane.positions.length / 3) * 4);
  for (let i = 0; i < plane.positions.length; i += 3) {
    const x = plane.positions[i];
    const z = -plane.positions[i + 1];
    const sample = bed.sample(x + offset, z);
    plane.positions.set([x, sample.elevation, z], i);
    plane.normals.set(sample.normal, i);
    const weave = 0.94 + 0.06 * Math.cos(335 * x) * Math.sin(412 * z) + 0.035 * Math.sin(40 * x - 33 * z);
    tint.set([0.155 * weave, 0.173 * weave, 0.154 * weave, 1], (4 * i) / 3);
  }
  plane.colors = tint;
  const surface = createMesh(engine, plane, new LambertMaterial({ vertexColors: true }));
  const frame = new PbrMaterial({ color: '#806b57', roughness: 0.75 });
  const trim = new PbrMaterial({ color: '#c2b596', roughness: 0.68 });
  const part = (geometry, material, pos) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(pos);
  part(toGeometry(roundedBoxGeometry(w + 0.024, 0.028, d + 0.024, 2, 0.009)), frame, [0, 0, 0]);
  const gaugeX = -0.174;
  for (let i = 0; i < 18; i++) {
    const z = -0.425 + 0.05 * i;
    const y = groundAt(bed, gaugeX, z) + 0.0004;
    part(box(i % 2 ? 0.009 : 0.019, 0.0006, 0.00095), trim, [gaugeX, y, z]);
  }
  return surface;
}

export async function mountSlitherFilm() {
  const [grip, uniform] = await Promise.all([take(true), take(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-0.59, 0.86, -0.16], target: [0, 0.016, -0.16], fov: 27, near: 0.018, far: 5 },
  });
  engine.scene.background = '#3a4650';
  engine.lighting.direction.set([-0.41, 0.72, -0.32, 2.15]);
  engine.lighting.radiance.set([0.98, 0.94, 0.84, 1]);
  engine.lighting.ambient.set([0.49, 0.57, 0.64]);
  const terrain = track(engine, grip.terrain.bed);
  const initial = animal(accepted(grip).contacts);
  const scales = createMesh(engine, initial.skin, new SurfaceMaterial({ vertexColors: true, roughness: 0.42 }));
  const lens = toGeometry(sphereGeometry(0.00086, 12, 7));
  const eye = new PbrMaterial({ color: '#383232', roughness: 0.14 });
  const eyes = initial.eyes.map((position) =>
    engine.createMesh().setGeometry(lens).setMaterial(eye).setPosition(position),
  );
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.14 });
  const glyphs = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  glyphs.add(
    new Text({
      text: 'How a snake gains traction',
      font: title,
      fontSize: 0.033,
      color: '#f0e2cc',
      position: [0.14418, 0.15312, -0.53679],
      billboard: true,
      onTop: true,
    }),
  );
  glyphs.add(
    new Text({
      text: '36 cm milksnake · 5 cm divisions',
      font: note,
      fontSize: 0.017,
      color: '#dce2da',
      position: [0.1205, 0.13656, -0.53679],
      billboard: true,
      onTop: true,
    }),
  );
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const rgba = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = gpu.createBuffer({
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

  let saved;
  function seek(take, frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const point = action === 'restore' ? saved : { frame: 0, snapshot: take.first };
      take.world.restoreSnapshot(point.snapshot.bytes);
      take.frame = point.frame;
    }
    if (frame > take.frame) take.world.advance((take.frame = frame));
    const snapshot = take.world.takeSnapshot();
    const prior = take.records.get(frame);
    if (prior && (prior.length !== snapshot.bytes.length || prior.some((x, i) => x !== snapshot.bytes[i])))
      throw new Error('The ground, undulating links, contacts and centre pose must replay byte for byte.');
    take.records.set(frame, snapshot.bytes);
    if (action === 'save') saved = { frame, snapshot };
    return snapshot.hash;
  }

  return {
    cue,
    checkpoint,
    end,
    length,
    mass,
    gravity,
    radius,
    links,
    async sample({ editFrame, action, directional = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const take = directional ? grip : uniform;
      const hash = seek(take, frame, action);
      const state = accepted(take);
      const { skin, eyes: gaze, head, tail, anchors } = animal(state.contacts);
      scales.setGeometry(skin);
      for (const [i, position] of gaze.entries()) eyes[i].setPosition(position);
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      return { frame, hash, ...state, head, tail, anchors, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      scales.destroy();
      terrain.destroy();
      glyphs.dispose();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

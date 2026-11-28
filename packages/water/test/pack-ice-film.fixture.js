import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { computeVertexNormals, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { createInstancedMesh } from '@margoengine/materials';
import { Physics } from '@margoengine/physics';
import { PACK_ICE_LAYOUT, PACK_ICE_WORDS, PackIceSolver } from '@margoengine/physics/pack-ice';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { IceMaterial, SeaIce } from '@margoengine/water/ice';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const dt = 1 / 60;
const cue = 24;
const checkpointFrame = 33;
const end = 238;
const density = 917;
const waterDensity = 1025;
const mass = 3450;
const speed = 2.4;
const beam = 1.94;
const length = 5.46;
const stern = -5.1;
const seed = [
  { position: [0.53, -0.4], radius: 0.91, thickness: 0.32, heading: 0.48 },
  { position: [0.85, 1.26], radius: 0.75, thickness: 0.089, heading: 0.81 },
  { position: [1.06, 2.86], radius: 0.84, thickness: 0.112, heading: -0.71 },
  { position: [2.53, 2.31], radius: 0.66, thickness: 0.104, heading: 1.08 },
  { position: [-0.86, 1.58], radius: 0.86, thickness: 0.23, heading: 1.96 },
];
for (let row = 0; row < 9; row++) {
  for (let column = 0; column < 10; column++) {
    const nonce = ((29 * row + 61 * column + 9 * row * column) % 101) / 101;
    const x = 2.35 * (column - 4.5) + 1.2 * (nonce - 0.5);
    const z = 2.17 * (row - 4) + 1.24 * (nonce - 0.5);
    const radius = 0.43 + 0.7 * nonce;
    if (Math.abs(x) < 1.8 && z < 3.3) continue;
    if (seed.some((floe) => Math.hypot(x - floe.position[0], z - floe.position[1]) < radius + floe.radius + 0.07))
      continue;
    seed.push({ position: [x, z], radius, thickness: 0.135 + 0.27 * nonce, heading: 6 * nonce });
  }
}

export async function packTake(contact) {
  await Physics.load();
  const pack = await PackIceSolver.load({ rigid: contact });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  const physics = new Physics(null, { fixedTimestep: dt, arena: world.arena });
  // A civil survey launch coasting in the horizontal plane. The draught and vertical pose are held for this cutaway.
  const body = physics.addBody(null, {
    position: [0, 0, stern],
    linearVelocity: [0, 0, speed],
    enabledTranslations: [true, false, true],
    enabledRotations: [false, true, false],
    colliders: { shape: 'box', halfExtents: [beam * 0.45, 0.34, length * 0.43], mass },
  });
  world
    .add(pack, {
      floes: seed,
      iceDensity: density,
      waterDensity,
      airSkinDrag: 0,
      airEdgeDrag: 0,
      waterSkinDrag: 0,
      waterEdgeDrag: 0,
      vessels: contact ? [{ bodyRow: body.row, length, beam, draft: 0.48, freeboard: 0.61 }] : [],
    })
    .add(new RigidSolver(), { physics });
  if (contact) world.couple(['pack-ice', 'rigid'], 'staggered');
  return { world, pack, body, contact, impulse: [0, 0, 0], frame: 0, records: new Map(), start: world.takeSnapshot() };
}

export function acceptedPack(take) {
  const { world, pack, body, impulse } = take;
  const rigidPort = world.fields.port(BODIES_FIELD.name);
  const icePort = world.fields.port(pack.floeField.name);
  if (rigidPort?.region.layout !== 2 || rigidPort.region.type !== 'f32')
    throw new Error('Read the accepted rigid pose.');
  if (icePort?.region.layout !== PACK_ICE_LAYOUT || icePort.region.type !== 'f64' || icePort.cell.some(Boolean))
    throw new Error('Use layout-1 pack-ice rows in the vessel’s water cell.');
  const rigid = regionWords(world.memory, rigidPort.region);
  const rows = regionWords(world.memory, icePort.region);
  const start = body.row * BODY_WORDS;
  const position = Array.from(rigid.subarray(start, start + 3));
  const rotation = Array.from(rigid.subarray(start + 3, start + 7));
  const velocity = Array.from(rigid.subarray(start + 10, start + 13));
  const spin = rigid[start + 14];
  const floes = Array.from({ length: pack.count }, (_, i) => {
    const state = pack.sample(i);
    const offset = i * PACK_ICE_WORDS;
    if (
      state.position[0] !== rows[offset] ||
      state.position[1] !== rows[offset + 1] ||
      state.radius !== rows[offset + 6]
    )
      throw new Error('Draw the same accepted floe positions and radii as the registered pack field.');
    return state;
  });
  return { position, rotation, velocity, spin, impulse: impulse.slice(), floes };
}

export function advanceTake(take, frame) {
  while (take.frame < frame) {
    take.world.advance(++take.frame);
    if (take.contact) {
      const { linear, yaw } = take.pack.vesselImpulse(take.body.row);
      take.impulse[0] += linear[0];
      take.impulse[1] += linear[1];
      take.impulse[2] += yaw;
    }
  }
}

function capsuleProfile() {
  const points = [];
  const spine = (length - beam) / 2;
  const radius = beam / 2;
  for (const cap of [-1, 1]) {
    for (let j = 0; j <= 14; j++) {
      const arc = (Math.PI * j) / 14;
      points.push([cap * radius * Math.cos(arc), cap * (spine + radius * Math.sin(arc))]);
    }
  }
  return points.reverse();
}

function loft(profile, rings, sidesOnly = false) {
  const positions = [];
  const indices = [];
  const n = profile.length;
  for (const [j, [y, latitude, longitude]] of rings.entries()) {
    for (const [i, [x, z]] of profile.entries()) {
      positions.push(x * latitude, y, z * longitude);
      if (j > 0) {
        const next = (i + 1) % n;
        const low = (j - 1) * n;
        const high = j * n;
        indices.push(low + i, low + next, high + i, low + next, high + next, high + i);
      }
    }
  }
  if (!sidesOnly) {
    const top = (rings.length - 1) * n;
    const bottomCentre = positions.length / 3;
    positions.push(0, rings[0][0], 0, 0, rings.at(-1)[0], 0);
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      indices.push(bottomCentre, next, i, bottomCentre + 1, top + i, top + next);
    }
  }
  const words = new Float32Array(positions);
  const geo = geometryData(
    words,
    new Float32Array(words.length),
    new Float32Array((2 * words.length) / 3),
    new Uint32Array(indices),
  );
  return computeVertexNormals(geo);
}

function surveyLaunch(engine) {
  // Civil research-ship palette and silhouettes from Amundsen Science photo references, not a replica.
  // https://amundsenscience.com/explore-the-icebreaker/
  const root = engine.createMesh();
  root.name = 'Ice survey launch';
  const paint = (color, roughness = 0.72) => new PbrMaterial({ color, roughness });
  const red = paint('#a54d35');
  const boot = paint('#28383f');
  const trim = paint('#bea475', 0.53);
  const deck = paint('#686d68', 0.89);
  const cabin = paint('#dbdbcc', 0.59);
  const glass = paint('#436574', 0.28);
  const rail = paint('#b9c0b5', 0.49);
  const profile = capsuleProfile();
  const part = (geometry, material, position = [0, 0, 0]) =>
    engine.createMesh(root).setGeometry(geometry).setMaterial(material).setPosition(position);
  const skin = (rings, material, cap) => part(toGeometry(loft(profile, rings, cap)), material);
  skin(
    [
      [-0.47, 0.54, 0.84],
      [-0.12, 0.94, 0.96],
      [-0.04, 0.994, 0.994],
    ],
    boot,
  );
  skin(
    [
      [-0.04, 0.994, 0.994],
      [0, 1, 1],
      [0.16, 1.02, 1.01],
      [0.52, 1.065, 1.03],
    ],
    red,
    true,
  );
  skin(
    [
      [0.52, 1.065, 1.03],
      [0.57, 1.049, 1.011],
      [0.61, 0.99, 0.979],
    ],
    trim,
    true,
  );
  skin(
    [
      [0.61, 0.99, 0.979],
      [0.622, 0.96, 0.963],
    ],
    deck,
  );

  const slab = (x, y, z, material, position, radius = 0) =>
    part(radius ? toGeometry(roundedBoxGeometry(x, y, z, 2, radius)) : box(x, y, z), material, position);
  slab(1.59, 0.8, 1.56, cabin, [0, 1.018, 0.45], 0.097);
  slab(1.69, 0.13, 1.69, boot, [0, 1.452, 0.43], 0.06);
  for (const x of [-0.491, 0, 0.491]) slab(0.39, 0.27, 0.032, glass, [x, 1.186, 1.232], 0.014);
  for (const side of [-1, 1]) {
    for (const z of [0.37, 0.88]) slab(0.029, 0.28, 0.38, glass, [side * 0.794, 1.18, z], 0.012);
    slab(0.059, 0.063, 1.23, rail, [side * 0.931, 0.911, -1.0], 0.02);
    for (const z of [-1.58, -1.04, -0.45]) slab(0.04, 0.29, 0.043, rail, [side * 0.931, 0.765, z]);
    slab(0.09, 0.11, 0.15, side > 0 ? paint('#659386') : red, [side * 0.82, 1.52, 0.97], 0.03);
  }
  slab(0.58, 0.23, 0.65, cabin, [0.11, 0.746, -1.7], 0.04);
  slab(0.43, 0.09, 0.18, boot, [0, 0.686, 1.99], 0.023);
  part(toGeometry(cylinderGeometry(0.04, 0.052, 0.67, 14)), rail, [0, 1.853, 0.54]);
  slab(0.5, 0.061, 0.091, cabin, [0, 2.18, 0.54], 0.017);
  return root;
}

function iceSlab(variant) {
  const corners = 13 + 4 * variant;
  const profile = Array.from({ length: corners }, (_, i) => {
    const angle = (i * Math.PI * 2) / corners;
    const radius = 0.46 + 0.026 * Math.cos((4 + variant) * angle + 1.52) + 0.012 * Math.sin(3 * angle + variant);
    return [radius * Math.cos(angle), -radius * Math.sin(angle)];
  });
  return loft(profile, [
    [-0.5, 0.91, 0.92],
    [-0.33, 1, 1],
    [0.23, 1, 1],
    [0.5, 0.9, 0.93],
  ]);
}

export async function mountPackIceFilm() {
  const [live, unlinked] = await Promise.all([packTake(true), packTake(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-13.4, 18.1, -20.4], target: [0, 0, 0.55], fov: 31, near: 0.2, far: 138 },
  });
  engine.scene.background = '#506f85';
  engine.lighting.direction.set([-0.37, 0.48, 0.79, 2.25]);
  engine.lighting.radiance.set([0.99, 0.91, 0.78, 0.92]);
  engine.lighting.ambient.set([0.42, 0.51, 0.64]);
  const boat = surveyLaunch(engine);
  const water = Water.attach(engine, {
    size: [72, 72],
    segments: 120,
    height: 0,
    chop: 0,
    color: [0.021, 0.071, 0.102],
    whitecaps: 0,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 9 }],
  });
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.13 });
  let take = live;
  const source = { count: live.pack.count, sample: (index) => take.pack.sample(index) };
  const field = new SeaIce({ kind: 'floe', size: [36, 36], floeSource: source, iceDensity: density, waterDensity });
  const floeMeshes = Array.from({ length: 3 }, (_, i) => {
    const first = Math.floor((i * source.count) / 3);
    const count = Math.floor(((i + 1) * source.count) / 3) - first;
    const optics = new IceMaterial({
      notch: false,
      look: {
        wetHeight: 0.045,
        blueIce: 0.2 + 0.11 * i,
        roughness: 0.57 + 0.09 * i,
        scallopDepth: 0.14,
        subsurface: 0.31,
      },
    });
    optics.setWater({ x: 0, z: 0, height: 0 });
    return { mesh: createInstancedMesh(engine, iceSlab(i), optics, count), first, count };
  });
  const flatSurface = { sample: () => ({ height: 0 }) };
  const glyphs = TextRenderer.attach(engine);
  const heading = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const info = new Font({ family: 'Arial, sans-serif', weight: 400 });
  glyphs.add(
    new Text({
      text: 'Through the pack ice',
      font: heading,
      fontSize: 1.05,
      color: '#eee4ce',
      position: [12.876, 5.99, -3.624],
      billboard: true,
      onTop: true,
    }),
  );
  glyphs.add(
    new Text({
      text: 'Horizontal contact study',
      font: info,
      fontSize: 0.56,
      color: '#c6d5d5',
      position: [12.558, 5.18, -4.121],
      billboard: true,
      onTop: true,
    }),
  );

  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const texture = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const buffer = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: texture } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  function stage(state) {
    boat.setPosition(state.position).setQuaternion(state.rotation);
    field.setTime(take.world.time).update(flatSurface, 0);
    for (const { mesh, first, count } of floeMeshes) field.writeInstances(mesh.instances, first, count);
    water.resetTime();
  }
  stage(acceptedPack(take));
  await waitForPipelines(draw);
  let saved;
  function seek(frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const point = action === 'restore' ? saved : { snapshot: take.start, frame: 0, impulse: [0, 0, 0] };
      take.world.restoreSnapshot(point.snapshot.bytes);
      take.frame = point.frame;
      take.impulse = point.impulse.slice();
    }
    advanceTake(take, frame);
    const snapshot = take.world.takeSnapshot();
    const before = take.records.get(frame);
    if (before && (before.length !== snapshot.bytes.length || before.some((x, i) => x !== snapshot.bytes[i])))
      throw new Error('Restore and re-advance the full accepted pack and rigid-body bytes.');
    take.records.set(frame, snapshot.bytes);
    if (action === 'save') saved = { frame, snapshot, impulse: take.impulse.slice() };
    return snapshot.hash;
  }
  return {
    cue,
    checkpointFrame,
    end,
    density,
    waterDensity,
    mass,
    speed,
    async sample({ editFrame, action, linked = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      take = linked ? live : unlinked;
      const hash = seek(frame, action);
      const state = acceptedPack(take);
      stage(state);
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const rgba = new Uint8ClampedArray(buffer.getMappedRange()).slice();
      buffer.unmap();
      pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
      return {
        frame,
        hash,
        ...state,
        drew: floeMeshes.reduce((total, { mesh }) => total + mesh.instances.count, 0),
        matrices: Array.from(field.matrices),
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      for (const { mesh } of floeMeshes) mesh.destroy();
      glyphs.dispose();
      texture.destroy();
      buffer.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

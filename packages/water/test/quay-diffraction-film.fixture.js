import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { boxGeometry, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { FiniteQuayWake } from '@margoengine/physics/loads';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { PostStack } from '@margoengine/post/stack';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { WaterWake } from '@margoengine/water/wake';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768,
  height = 448;
const fps = 60,
  cue = 16,
  incident = 65,
  shelter = 125,
  reflected = 150,
  end = 180;
const nx = 48,
  nz = 40,
  spacing = 0.125,
  origin = [-3, -2.75],
  layers = 4,
  depth = 0.3;
const gravity = 9.81,
  density = 1000,
  cell = [-9, 2, 15];
const length = 2,
  wallHeight = 0.14,
  waveLength = 1.2,
  amplitude = 0.05,
  packetCentre = -1.55,
  sigma = 0.43;
const gauges = [
  [-0.35, 0.38], // Open approach at the left tip.
  [0.22, 0.38], // Near the tip in the geometric shadow.
  [1, 0.38], // Mid-span lee.
  [1.5, 0.38],
  [1, -0.35], // Incident face.
  [1, 0.75], // Further into the harbour.
];
const area = nx * nz;
const rowBelow = Math.round(-origin[1] / spacing) - 1;
const firstFace = rowBelow * nx + nx / 2;
const numClosed = Math.round(length / spacing);

function initialPacket() {
  const increment = 0.2;
  const nominal = (2 * Math.PI) / waveLength;
  const harmonics = Array.from({ length: 90 }, (_, i) => {
    const k = (i + 0.5) * increment;
    const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
    const weight =
      (amplitude * sigma * increment * Math.exp(-0.5 * (sigma * (k - nominal)) ** 2)) / Math.sqrt(2 * Math.PI);
    return { k, omega, weight };
  });
  return Array.from({ length: nz }, (_, j) => {
    const z = origin[1] + (j + 0.5) * spacing;
    let height = 0,
      potential = 0;
    for (const { k, omega, weight } of harmonics) {
      const phase = k * (z - packetCentre);
      height += weight * Math.cos(phase);
      potential += (weight * gravity * Math.sin(phase)) / omega;
    }
    return [height, potential];
  });
}

const packet = initialPacket();
function initial(x, z) {
  const edge = Math.min(
    1,
    Math.max(0, (z - origin[1]) / 0.6),
    Math.max(0, -2 * z),
    Math.max(0, (3 - Math.abs(x)) / 0.55),
  );
  const taper = 0.5 * (1 - Math.cos(Math.PI * edge));
  return packet[Math.floor((z - origin[1]) / spacing)].map((v) => v * taper);
}

function makeTake(screen) {
  const wake = new FiniteQuayWake();
  const openZ = new Float64Array(layers * area).fill(1);
  if (screen)
    for (let layer = 0; layer < layers; layer++) {
      const face = layer * area + firstFace;
      openZ.fill(0, face, face + numClosed);
    }
  const world = new PhysicsWorld({
    rate: { num: fps, den: 1 },
    gravity: [0, -gravity, 0],
    cellSize: 64,
    seed: 4521,
    memory: worldMemory(false),
  }).add(
    wake,
    {
      cells: [nx, nz],
      cellSize: spacing,
      origin,
      depths: Array.from({ length: layers + 1 }, (_, i) => (depth * i) / layers),
      horizontalOrder: 4,
      density,
      initial,
      openZ,
      sponge: { cells: 4, rate: 3 },
    },
    cell,
  );
  const snapshot = world.takeSnapshot();
  return {
    wake,
    world,
    screen,
    frame: 0,
    saved: new Map([[0, snapshot]]),
    visited: new Map(),
    initialEnergy: wake.energy(),
  };
}

function sameBytes(a, b) {
  if (a.length !== b.length || a.some((v, i) => v !== b[i]))
    throw new Error('Restore all accepted wave, potential, absorber ledger and registry bytes at the selected frame.');
}

function seek(take, frame, action) {
  const { world, saved, visited } = take;
  if (action === 'restore') {
    const checkpoint = saved.get(frame);
    world.restoreSnapshot(checkpoint.bytes);
    sameBytes(world.takeSnapshot().bytes, checkpoint.bytes);
  } else {
    if (frame < take.frame) world.restoreSnapshot(saved.get(0).bytes);
    if (frame !== take.frame) world.advance(frame);
  }
  take.frame = frame;
  const snapshot = world.takeSnapshot();
  if (visited.has(frame)) sameBytes(snapshot.bytes, visited.get(frame));
  visited.set(frame, snapshot.bytes);
  if (action === 'save') saved.set(frame, snapshot);
  return snapshot.hash;
}

function accepted(take) {
  const { wake, world, initialEnergy } = take;
  const port = world.fields.port(wake.heightField.name);
  const rows = regionWords(world.memory, port.region);
  const published = wake.heights();
  if (port.region.type !== 'f64' || rows.length !== area || rows.some((v, i) => v !== published[i]))
    throw new Error('Read the accepted finite wake height grid from the same bank used by WaterWake.');
  const energy = wake.energy();
  const absorbed = wake.work().absorbedJoules;
  return { gauges: gauges.map(([x, z]) => wake.elevation(x, z)), energy, absorbed, initialEnergy, cell: port.cell };
}

function actualSurface(water, wake) {
  return WaveQuery.capture(water).then(({ vertices }) => {
    let heights = 0,
      normals = 0,
      count = 0;
    for (let i = 0; i < vertices.length; i += 12) {
      const x = vertices[i + 3],
        z = vertices[i + 7];
      if (
        x <= origin[0] + spacing ||
        x >= origin[0] + (nx - 1) * spacing ||
        z <= origin[1] + spacing ||
        z >= origin[1] + (nz - 1) * spacing
      )
        continue;
      const physical = wake.sample(x, z);
      const [sx, sz] = physical.slope;
      const norm = Math.hypot(1, sx, sz);
      heights = Math.max(heights, Math.abs(vertices[i + 1] - physical.height));
      normals = Math.max(
        normals,
        Math.hypot(vertices[i + 4] + sx / norm, vertices[i + 5] - 1 / norm, vertices[i + 6] + sz / norm),
      );
      count++;
    }
    return { heights, normals, count };
  });
}

function buildBasin(engine) {
  const charcoal = new PbrMaterial({ color: '#3c4d50', roughness: 0.76 });
  const limestone = new PbrMaterial({ color: '#a4afa7', roughness: 0.84 });
  const warm = new PbrMaterial({ color: '#ae9a74', roughness: 0.76 });
  const seams = new PbrMaterial({ color: '#657271', roughness: 0.9 });
  const bright = new PbrMaterial({ color: '#d7c289', roughness: 0.61 });
  const floor = new PbrMaterial({ color: '#354b55', roughness: 0.93 });
  const floorRules = new PbrMaterial({ color: '#c2d0c9', roughness: 0.91 });
  const part = (geometry, material, p, root) =>
    engine.createMesh(root).setGeometry(toGeometry(geometry)).setMaterial(material).setPosition(p);
  const slab = (dimensions, material, p, root, radius = 0.024) =>
    part(roundedBoxGeometry(...dimensions, 2, radius), material, p, root);
  slab([6.12, 0.43, 4.62], charcoal, [0, -0.47, 0], undefined, 0.045);
  slab([5.8, 0.04, 4.3], floor, [0, -depth - 0.02, 0], undefined, 0.013);
  // The regular painted rules under the water expose how the real surface refracts the basin floor.
  for (let i = -8; i <= 8; i++) part(boxGeometry(5.66, 0.003, 0.009), floorRules, [0, -depth + 0.002, i * 0.24]);
  for (let i = -11; i <= 11; i++) part(boxGeometry(0.009, 0.003, 4.24), floorRules, [i * 0.24, -depth + 0.001, 0]);

  for (const side of [-1, 1]) {
    slab([0.18, 0.25, 4.53], limestone, [side * 2.92, -0.018, 0], undefined, 0.022);
    slab([0.215, 0.04, 4.55], warm, [side * 2.92, 0.12, 0], undefined, 0.016);
  }
  for (const side of [-1, 1]) {
    const z = side * 2.18;
    slab([5.7, 0.19, 0.18], limestone, [0, -0.048, z], undefined, 0.023);
    slab([5.74, 0.031, 0.205], warm, [0, 0.06, z], undefined, 0.012);
    for (let x = -2.5; x <= 2.5; x += 0.5) part(boxGeometry(0.012, 0.004, 0.079), seams, [x, 0.078, z + side * 0.043]);
  }
  // The wave solver closes exactly the faces beneath this narrow, demountable quay.
  // Both ends remain connected. The plate is thinner than one model cell.
  const screen = engine.createMesh();
  screen.name = 'Finite concrete training quay';
  slab([length, depth + wallHeight, 0.09], limestone, [length / 2, (wallHeight - depth) / 2, 0], screen, 0.018);
  slab([length + 0.032, 0.036, 0.115], warm, [length / 2, wallHeight + 0.01, 0], screen, 0.013);
  for (let i = 1; i < 8; i++) part(boxGeometry(0.009, 0.093, 0.003), seams, [i * 0.25, 0.061, -0.047], screen);
  for (const x of [0.07, length - 0.07])
    part(cylinderGeometry(0.025, 0.037, 0.067, 16), bright, [x, wallHeight + 0.057, 0], screen);
  return screen;
}

export async function mountQuayFilm() {
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [1.53, 6.85, -6.85], target: [-0.06, -0.07, 0.12], fov: 38, near: 0.12, far: 95 },
  });
  engine.scene.background = '#263e49';
  engine.lighting.direction.set([-0.49, 0.74, 0.48, 1.88]);
  engine.lighting.radiance.set([1, 0.92, 0.76, 1]);
  engine.lighting.ambient.set([0.41, 0.53, 0.66]);
  const stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral', exposure: -0.13 })]);
  const quay = buildBasin(engine);
  const takes = [makeTake(true), makeTake(false)];
  const water = Water.attach(engine, {
    size: [5.8, 4.3],
    segments: 64,
    foamDistance: 0.02,
    color: [0.018, 0.1, 0.145],
    whitecaps: 0,
    chop: 0,
    sea: { waveComponents: () => 0 },
    depth: () => stack.depthTexture,
    sceneColor: () => stack.sceneTexture,
    // Point the basin light near the camera's mirror direction on undisturbed water.
    // Its glint makes the resolved wave slopes visible on both sides of the quay.
    lights: [{ direction: [-0.155, 0.698, 0.698, 1], radiance: [0.78, 1.17, 1.48] }],
  });
  let effect, active;
  function select(take) {
    if (active === take) return;
    effect?.dispose();
    effect = WaterWake.attach(engine, { surface: water, wake: take.wake });
    active = take;
  }
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 700 });
  const meta = new Font({ family: 'Arial, sans-serif', weight: 500 });
  labels.add(
    new Text({
      text: 'A wave packet meets the quay',
      position: [2.84, 1.79, 2.47],
      font: title,
      fontSize: 0.25,
      color: '#e3e9e6',
      billboard: true,
      onTop: true,
    }),
  );
  const subtitle = labels.add(
    new Text({
      text: 'Finite quay · 0.30 m water depth',
      position: [2.84, 1.43, 2.47],
      font: meta,
      fontSize: 0.125,
      color: '#bed0cf',
      billboard: true,
      onTop: true,
    }),
  );
  const receipt = labels.add(
    new Text({
      text: 'Incident → harbour',
      position: [0.64, 0.08, -2.36],
      font: meta,
      fontSize: 0.123,
      color: '#d6e3df',
      billboard: true,
      onTop: true,
    }),
  );
  const gpu = engine.gpu,
    errors = [];
  engine.onError = (error) => errors.push(String(error));
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
  select(takes[0]);
  await waitForPipelines(draw);
  return {
    cue,
    incident,
    shelter,
    reflected,
    end,
    spacing,
    cell,
    gauges,
    fps,
    gravity,
    density,
    depth,
    waveLength,
    amplitude,
    packetCentre,
    faces: takes.map(({ wake }) => Array.from(wake.surfaceMask().subarray(firstFace - 1, firstFace + numClosed + 1))),
    async sample({ editFrame, action, measure = false, showWall = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = [];
      for (const take of takes) {
        const hash = seek(take, frame, action);
        const state = accepted(take);
        select(take);
        quay.visible = take.screen && showWall;
        subtitle.text = take.screen ? 'Finite quay · 0.30 m water depth' : 'Open control · same incident pulse';
        receipt.text = `+${(frame / fps).toFixed(2)} s · Wave basin`;
        water.resetTime();
        water.setTime(frame / fps);
        await waitForPipelines(draw);
        const agreement = measure ? await actualSurface(water, take.wake) : undefined;
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
        states.push({ hash, ...state, agreement, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      effect?.dispose();
      water.dispose();
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { addStrandHorse } from '@margoengine/horses/strands';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { STRAND_LAYOUT, STRAND_WORDS, StrandSolver } from '@margoengine/physics/strands';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Noise, generateGrassMesh, generateRockMesh } from '@margoengine/procedural';
import { Shadows } from '@margoengine/shadows';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { travellingGust } from '@margoengine/weather/turbulence';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const displayRate = 60;
const cue = 18;
const preGust = 18;
const inGust = 51;
const stop = 75;
const end = 133;
const seed = 84263;
const cellSize = 64;
const gustCell = [-1, 0, 0];
const calm = new BoundaryLayerWind({ speed: 0, turbulence: false });
// The horse is authored in its default cell. Wind lives one signed cell west.
const stillWind = {
  medium: 'air',
  cell: gustCell,
  sample: (x, y, z, t, out) => calm.sample(x - cellSize, y, z, t, out),
};
const pulse = travellingGust(stillWind, {
  origin: [cellSize + 1.4, 1.1, -0.2],
  cellSize,
  start: 0.28,
  direction: Math.atan2(-4.8, -12.2),
  speed: 10.2,
  length: 7.0,
  amplitude: [-12.2, 0.7, -4.8],
});

// Bertails, Audoly et al. (2006) on dynamic inextensible hair guides, https://doi.org/10.1145/1179352.1142012.
// Bergou, Wardetzky et al. (2008) on thin rod frames and coupled constraints, https://www.cs.columbia.edu/cg/rods/.
// The separate horizontal-guide probe isolates cross-flow drag and a single exact inextensibility projection;
// the horse keeps the existing authored material coefficients and weighted mesh.
export async function checkCrossflow() {
  const solver = await StrandSolver.load();
  const referenceRate = 240;
  const dt = 1 / referenceRate;
  const length = 0.3;
  const radius = 0.005;
  const dragWidth = 0.04;
  const drag = 1.16;
  const density = 1100;
  const air = 1.224;
  const speed = 13;
  const solverCell = [-3, 1, 4];
  const wind = {
    medium: 'air',
    cell: [-4, 1, 4],
    sample(x, _y, _z, _t, out) {
      out.velocity[0] = Math.abs(x - cellSize) <= 0.03 ? speed : 0;
      out.velocity[1] = out.velocity[2] = 0;
      out.density = air;
      out.temperature = 289;
      return out;
    },
  };
  const world = new PhysicsWorld({
    rate: { num: referenceRate, den: 1 },
    gravity: [0, 0, 0],
    cellSize,
    memory: worldMemory(false),
    seed,
  }).add(
    solver,
    {
      fidelity: 'follow',
      damping: 0,
      followDamping: 0,
      wind,
      cellSize,
      strands: [
        {
          points: [
            [0, 0, 0],
            [0, 0, length],
          ],
          radius,
          dragWidth,
          drag,
          density,
        },
      ],
    },
    solverCell,
  );
  const before = world.takeSnapshot();
  world.advance(1);
  const first = world.takeSnapshot();
  const anchor = solver.sample(0, 0).position;
  const tip = solver.sample(0, 1).position;
  const port = world.fields.port(solver.field.name);
  const row = Array.from(regionWords(world.memory, port.region).slice(STRAND_WORDS, 2 * STRAND_WORDS));
  world.advance(22);
  world.restoreSnapshot(before.bytes);
  world.advance(1);
  const replayed = world.takeSnapshot();
  const exact = first.bytes.length === replayed.bytes.length && first.bytes.every((v, i) => v === replayed.bytes[i]);
  solver[Symbol.dispose]?.();
  return {
    anchor,
    tip,
    row,
    solverCell,
    publishedCell: port.cell,
    exact,
    dt,
    length,
    radius,
    dragWidth,
    drag,
    density,
    air,
    speed,
  };
}

const noise = new Noise(seed);
const interpolate = (a, b, w) => a + (b - a) * w;
const unitClamp = (v) => Math.min(1, Math.max(0, v));
function ground(x, z) {
  const edge = 1 - Math.exp(-0.55 * x * x);
  const far = unitClamp((-z - 6) / 16);
  return (
    0.035 * Math.sin(z * 0.8) +
    edge * 0.19 * noise.simplex(0.47 * x, 2, 0.31 * z) +
    far * ((1.8 + 0.95 * Math.sin(0.22 * x + z * 0.17)) * noise.simplex(0.14 * x, 8, 0.072 * z) + 2.6 * far)
  );
}

function ridge(engine, shadows) {
  const cols = 100;
  const rows = 90;
  const positions = [],
    uvs = [],
    indices = [],
    colors = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) {
      const x = -21 + (42 * i) / cols;
      const z = -31 + (49 * j) / rows;
      positions.push(x, ground(x, z), z);
      uvs.push(i / cols, j / rows);
      const path = unitClamp((Math.abs(x) - 0.61) / 1.04);
      const stipple = noise.simplex(x * 2.02, 3, z * 1.75);
      const soil = noise.simplex(x * 0.83, 6, z * 0.67);
      const haze = unitClamp((-z - 8) / 24);
      colors.push(
        interpolate(0.27, 0.137, path) + 0.02 * stipple + 0.021 * soil + 0.065 * haze,
        interpolate(0.212, 0.171, path) + 0.02 * stipple + 0.02 * soil + 0.08 * haze,
        interpolate(0.147, 0.088, path) + 0.02 * stipple + 0.015 * soil + 0.113 * haze,
        1,
      );
      if (i < cols && j < rows) {
        const a = i + j * (cols + 1);
        const b = a + cols + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const geometry = geometryData(positions, new Float32Array(positions.length), uvs, indices);
  geometry.colors = Float32Array.from(colors);
  const earth = createMesh(
    engine,
    computeVertexNormals(geometry),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.88 }),
  );
  shadows.add(earth, { castShadow: false });
  const grass = toGeometry(generateGrassMesh(5));
  const pastures = ['#8c8c54', '#96905a', '#a09863'].map((color) => new PbrMaterial({ color, roughness: 0.85 }));
  const rock = new PbrMaterial({ color: '#827c68', roughness: 0.88 });
  const sceneRandom = new RandomStream(seed, solverNumber('strand-film-meadow'));
  for (let i = 0; i < 150; i++) {
    const [u, v] = sceneRandom.unitF64(0, i);
    const x = -9 + 18 * u;
    const z = -11 + 17 * v;
    if (Math.abs(x) < 0.99) continue;
    const [q, angle] = sceneRandom.unitF64(0, i, 1);
    engine
      .createMesh()
      .setGeometry(grass)
      .setMaterial(pastures[i % pastures.length])
      .setPosition([x, ground(x, z), z])
      .setRotation([0, angle * 2 * Math.PI, 0])
      .setScale([1.3, 0.36 + 0.48 * q, 1.3]);
  }
  for (const [i, [x, z, scale]] of [
    [-1.5, 1.6, 0.17],
    [-2.0, 1.3, 0.31],
    [-3.6, -3.4, 0.46],
    [2.1, 0.77, 0.32],
    [1.9, 3.0, 0.44],
    [1.7, -3.1, 0.22],
    [3.8, -5.2, 0.49],
  ].entries()) {
    const boulder = engine
      .createMesh()
      .setGeometry(toGeometry(generateRockMesh(seed + i, 'slab', { detail: 1 })))
      .setMaterial(rock)
      .setPosition([x, ground(x, z), z])
      .setScale([scale, scale, scale]);
    shadows.add(boulder, { static: true });
  }
}

async function establish(engine, wind, shadows) {
  const horse = await addStrandHorse(engine, {
    coat: 'bay',
    type: 'riding',
    detail: 2,
    maneLength: 0.27,
    markings: { blaze: true, socks: [0.12, 0.07, 0.08, 0] },
    position: [-0.27, -2.0],
    heading: 0.11,
    acceleration: 4.4,
    ground,
    shadows,
    strands: { wind, cellSize, damping: 5, contactGeometry: 'swept' },
  });
  horse.gait = 'trot';
  horse.speed = 3.2;
  horse.advanceTime(stop / displayRate);
  horse.speed = 0;
  horse.seek(0);
  const before = horse.strandWorld.takeSnapshot();
  return { horse, wind, frame: 0, checkpoints: new Map([[0, before]]), visited: new Map() };
}

function compareSnapshots(actual, expected) {
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
    throw new Error(
      'Restore the complete accepted centreline, material frames and contact history for the saved horse pose.',
    );
}

function seek(take, goal, action) {
  const { horse } = take;
  const world = horse.strandWorld;
  if (action === 'restore') {
    const saved = take.checkpoints.get(goal);
    // Restore the accepted physical bank directly. Then the horse controller replays its separate gait
    // commands to rebind the matching skin pose, and must produce the same exact physical bank.
    world.restoreSnapshot(saved.bytes);
    compareSnapshots(world.takeSnapshot().bytes, saved.bytes);
    horse.seek(goal / displayRate);
  } else if (goal < take.frame) {
    horse.seek(goal / displayRate);
  } else if (goal > take.frame) {
    horse.advanceTime(goal / displayRate - horse.time);
  }
  take.frame = goal;
  const snapshot = world.takeSnapshot();
  const previous = take.visited.get(goal);
  if (previous) compareSnapshots(snapshot.bytes, previous);
  take.visited.set(goal, snapshot.bytes);
  if (action === 'save') take.checkpoints.set(goal, snapshot);
  return snapshot.hash;
}

function accepted(take) {
  const { horse, wind } = take;
  const world = horse.strandWorld;
  const solver = horse.strandSolver;
  const port = world.fields.port(solver.field.name);
  const points = regionWords(world.memory, port.region);
  const chains = horse.skeleton.strandChains;
  if (
    port.region.layout !== STRAND_LAYOUT ||
    port.region.type !== 'f64' ||
    points.length !== chains.flat().length * STRAND_WORDS
  )
    throw new Error('Read the registered f64 strand centreline and material frames for all weighted guides.');
  let index = 0;
  const guides = chains.map((chain, g) =>
    chain.map((joint, i) => {
      const acceptedPoint = solver.sample(g, i);
      const row = points.subarray(index * STRAND_WORDS, ++index * STRAND_WORDS);
      const expected = [
        ...acceptedPoint.position,
        ...acceptedPoint.velocity,
        ...acceptedPoint.rotation,
        ...acceptedPoint.spin,
      ];
      if (expected.some((v, k) => v !== row[k]))
        throw new Error('Use the same accepted position, velocity, frame and twist as the weighted horse.');
      const bone = horse.model.nodes[joint].matrix;
      return { point: acceptedPoint.position, skin: Array.from(bone.slice(12, 15)) };
    }),
  );
  const centre = horse.frame().position;
  const rootFlow = wind.sample(centre[0] + cellSize, centre[1] + 1.4, centre[2], horse.time).velocity;
  return {
    guides,
    portCell: port.cell,
    position: centre,
    speed: horse.currentSpeed,
    gait: horse.currentGait,
    rootFlow,
  };
}

export async function mountStrandFilm() {
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-4.94, 2.4, 2.13], target: [0.05, 1.23, 0.59], fov: 42, near: 0.05, far: 100 },
  });
  engine.scene.background = '#aabcc1';
  engine.lighting.direction.set([-0.48, 0.74, 0.47, 1.6]);
  engine.lighting.radiance.set([1, 0.93, 0.77, 1]);
  engine.lighting.ambient.set([0.47, 0.57, 0.67]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const shadows = Shadows.attach(engine, {
    bounds: { min: [-4, -0.4, -5.0], max: [4, 2.8, 5.8] },
    resolution: 1024,
    filter: 'pcf',
  });
  ridge(engine, shadows);
  const takes = await Promise.all([establish(engine, pulse, shadows), establish(engine, stillWind, shadows)]);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    labels.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('Mane and tail follow the crosswind', [-1.5, 2.49, -1.57], title, 0.17, '#293738');
  label('Weighted horse rig · finite travelling gust', [-1.5, 2.3, -1.57], notes, 0.087, '#3c4947');
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.1 });
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
    preGust,
    inGust,
    stop,
    end,
    seed,
    async sample({ editFrame, action }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const snapshots = takes.map((take) => seek(take, frame, action));
      const states = [];
      for (const [i, take] of takes.entries()) {
        for (const [index, scene] of takes.entries()) scene.horse.model.root.visible = index === i;
        await waitForPipelines(draw);
        const physical = accepted(take);
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const color = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(color, width, height), 0, 0);
        states.push({ hash: snapshots[i], ...physical, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      for (const { horse } of takes) horse.dispose();
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

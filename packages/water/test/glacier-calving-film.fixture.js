import { EngineKernel, PbrMaterial } from '@margoengine/core';
import {
  boxGeometry,
  computeVertexNormals,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
  toGeometry,
} from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { LambertMaterial, createMesh } from '@margoengine/materials';
import { TerrainBed } from '@margoengine/physics/earth';
import { GLACIER_FIELD_LAYOUT, GlacierSolver } from '@margoengine/physics/glacier';
import { IcebergSolver } from '@margoengine/physics/iceberg';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS, WakeSolver } from '@margoengine/physics/sea';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { IceMaterial } from '@margoengine/water/ice';
import { WaveQuery } from '@margoengine/water/query';
import { WaterWake } from '@margoengine/water/wake';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const releaseFrame = 1;
const checkpoint = 30;
const end = 180;
const nx = 11;
const nz = 7;
const dx = 3;
const x0 = -21;
const z0 = -10.5;
const terrainShape = { columns: nx, rows: nz, width: nx * dx, depth: nz * dx, centre: [x0 + (nx * dx) / 2, 0] };
const cells = [128, 96];
const cellSize = 0.5;
const waterSize = [96, 72];
const survey = [
  [5, 0],
  [7, 0],
  [9, 0],
];
const visits = Array.from({ length: nx * nz }, (_, i) => [
  x0 + dx * ((i % nx) + 0.5),
  z0 + dx * (Math.floor(i / nx) + 0.5),
]);
const indexAt = (x, z) => visits.findIndex(([a, b]) => a === x && b === z);
const front = indexAt(-1.5, 0);
const waterFace = indexAt(1.5, 0);
const releaseSites = [
  [-1.5, 0],
  [4.5, 0],
  [1.5, -3],
  [1.5, 3],
].map(([x, z], index) => ({
  sourceCell: indexAt(x, z),
  position: index === 0 ? [1.5, 0] : [x, z],
  shape: [3, 4.05, 3],
}));
const thickness = visits.map(([x, z]) =>
  Math.abs(z) > 6 || x > (Math.abs(z) > 3 ? -4.5 : -1.5)
    ? 0
    : 4.05 + Math.max(0, -1.5 - x) * 0.12 + (0.35 * Math.abs(z)) / 6,
);
const initialVolume = thickness.reduce((sum, value) => sum + value * dx ** 2, 0);

function elevation(x, z) {
  // Authored tidewater shoal. Profile/colour reference: USGS Columbia Glacier terminus field photograph.
  // https://www.usgs.gov/media/images/columbia-glacier-terminus
  const shelves = x <= 0 ? -4.2 - 0.27 * x : -4.2 - 0.46 * x;
  return shelves + 3.4 * (Math.abs(z) / 10.5) ** 3;
}

async function launch(marine) {
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, memory: worldMemory(false) });
  const terrain = new TerrainBed();
  world.add(terrain, { ...terrainShape, elevations: elevation });
  const bed = visits.map(([x, z]) => terrain.bed.sample(x, z).elevation);
  const glacier = await GlacierSolver.load();
  const iceberg = await IcebergSolver.load({ calving: glacier.calvingField });
  const wake = await WakeSolver.load({ id: 'calving-wake', sourceField: iceberg.wakeSourceField });
  const boundary = new Uint8Array(nx * nz);
  if (marine) boundary[waterFace] = 1;
  world
    .add(wake, { cells, cellSize, sponge: 0, depth: 9 })
    .add(iceberg, { releaseSites, current: [0.2, 0, 0] })
    .add(glacier, { nx, nz, dx, bed, thickness, boundary });
  return { world, terrain, glacier, iceberg, wake, bed, frame: 0, first: world.takeSnapshot(), records: new Map() };
}

function state(take) {
  const { world, glacier, iceberg, wake, bed } = take;
  function words(field, layout) {
    const port = world.fields.port(field.name);
    if (port?.region.layout !== layout || port.region.type !== 'f64' || port.cell.some(Boolean))
      throw new Error('Read accepted f64 glacier and downstream water state in the shown cell.');
    return Array.from(regionWords(world.memory, port.region));
  }
  const depths = words(glacier.thicknessField, GLACIER_FIELD_LAYOUT);
  const output = words(glacier.calvingField, GLACIER_FIELD_LAYOUT);
  const admitted = words(iceberg.releaseField, 1);
  const waveSource = words(iceberg.wakeSourceField, WAKE_SOURCE_LAYOUT);
  const ice = Array.from({ length: iceberg.count }, (_, i) => iceberg.sample(i));
  for (const [i, value] of depths.entries()) {
    const read = glacier.sample(i % nx, Math.floor(i / nx));
    if (read.thickness !== value || read.surface !== value + bed[i] || read.calving !== output[i])
      throw new Error('Use the registered accepted glacial roof, boundary and detached volume.');
  }
  let min = Infinity;
  let max = -Infinity;
  let volume = 0;
  for (const value of wake.heights()) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    volume += value * cellSize ** 2;
  }
  return {
    depths,
    output,
    admitted,
    waveSource,
    ice,
    glacierBudget: glacier.budget,
    icebergBudget: iceberg.budget,
    faceBed: bed[front],
    face: depths[front],
    wake: { min, max, volume, levels: survey.map(([x, z]) => wake.sample(x, z).height) },
  };
}

function surfaceGeometry(positions, indices) {
  const xyz = Float32Array.from(positions);
  return computeVertexNormals(
    geometryData(xyz, new Float32Array(xyz.length), new Float32Array((xyz.length * 2) / 3), Uint32Array.from(indices)),
  );
}

function iceTongue(take, field) {
  const bed = take.terrain.bed;
  const positions = [];
  const indices = [];
  const has = (x, z) => x >= 0 && x < nx && z >= 0 && z < nz && field[x + nx * z] > 1e-6;
  function corner(i, j) {
    // The shared roof joins only contiguous ice. Its centre still passes through each exact accepted column top.
    let sum = 0;
    let count = 0;
    for (const x of [i - 1, i])
      for (const z of [j - 1, j])
        if (has(x, z)) {
          const at = x + nx * z;
          count++;
          sum += take.bed[at] + field[at];
        }
    return [x0 + i * dx, sum / count, z0 + j * dx];
  }
  for (const [i, [x, z]] of visits.entries()) {
    const ix = i % nx;
    const iz = Math.floor(i / nx);
    if (!has(ix, iz)) continue;
    const outline = [corner(ix, iz), corner(ix, iz + 1), corner(ix + 1, iz + 1), corner(ix + 1, iz)];
    const start = positions.length / 3;
    positions.push(x, take.bed[i] + field[i], z, ...outline.flat());
    for (const [side, [j, k]] of [
      [ix - 1, iz],
      [ix, iz + 1],
      [ix + 1, iz],
      [ix, iz - 1],
    ].entries()) {
      const next = (side + 1) % outline.length;
      indices.push(start, start + 1 + side, start + 1 + next);
      if (has(j, k)) continue;
      const a = outline[side];
      const b = outline[next];
      const wall = positions.length / 3;
      positions.push(
        a[0],
        bed.sample(a[0], a[2]).elevation,
        a[2],
        b[0],
        bed.sample(b[0], b[2]).elevation,
        b[2],
        ...a,
        ...b,
      );
      indices.push(wall, wall + 1, wall + 2, wall + 1, wall + 3, wall + 2);
    }
  }
  return surfaceGeometry(positions, indices);
}

function terrainArt(engine, bed) {
  const raw = planeGeometry(waterSize[0], waterSize[1], 96, 72);
  const color = new Float32Array((raw.positions.length / 3) * 4);
  for (let i = 0; i < raw.positions.length; i += 3) {
    const x = raw.positions[i];
    const z = -raw.positions[i + 1];
    // Continue the existing profile into the backdrop outside the accepted glacier and terrain tile.
    const bedX = Math.max(x0, Math.min(x0 + terrainShape.width, x));
    const bedZ = Math.max(z0, Math.min(-z0, z));
    const foreshore = 0.48 * Math.max(0, x - bedX) + 0.42 * Math.abs(z - bedZ);
    raw.positions.set([x, bed.sample(bedX, bedZ).elevation - foreshore, z], i);
    const variation = 0.85 + 0.12 * Math.sin(x * 0.8 - 0.58 * z) * Math.sin(x * 0.39 + 0.72 * z);
    color.set([0.17 * variation, 0.195 * variation, 0.183 * variation, 1], (i * 4) / 3);
  }
  raw.colors = color;
  const base = createMesh(engine, computeVertexNormals(raw), new LambertMaterial({ vertexColors: true }));
  const stone = new PbrMaterial({ color: '#535d57', roughness: 0.93 });
  const rubble = toGeometry(sphereGeometry(1, 9, 7));
  for (const [i, [x, z]] of [
    [-15.3, 9.34],
    [-16.9, 8.66],
    [-16.1, 9.6],
    [-17.2, -9.26],
    [-15, -9.5],
    [-13.4, -9.55],
  ].entries()) {
    const r = 0.45 + 0.27 * (i % 3);
    engine
      .createMesh()
      .setGeometry(rubble)
      .setMaterial(stone)
      .setScale([2.2 * r, r, 1.1 * r])
      .setPosition([x, bed.sample(x, z).elevation + r * 0.27, z]);
  }
  return base;
}

export async function mountGlacierCalvingFilm() {
  const [live, closed] = await Promise.all([launch(true), launch(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [16.8, 11.3, 20.7], target: [-2.0, 0.65, 0], fov: 38, near: 0.3, far: 155 },
  });
  engine.scene.background = '#557083';
  engine.lighting.direction.set([-0.59, 0.48, -0.71, 2.35]);
  engine.lighting.radiance.set([0.96, 0.965, 1, 0.92]);
  engine.lighting.ambient.set([0.61, 0.68, 0.76]);
  const ground = terrainArt(engine, live.terrain.bed);
  const cliffMaterial = new IceMaterial({
    notch: false,
    look: { blueIce: 0.43, bandScale: 0.55, wetHeight: 0.17, roughness: 0.57, scatterDepth: 2.1 },
  });
  cliffMaterial.setWater({ x: 0, z: 0, height: 0 });
  const tongue = createMesh(engine, iceTongue(live, thickness), cliffMaterial);
  const blockMaterial = new IceMaterial({
    notch: false,
    look: { blueIce: 0.41, bandScale: 0.44, wetHeight: 0.15, roughness: 0.48, scatterDepth: 2.4 },
  });
  const blockShape = boxGeometry(1, 1, 1);
  const blocks = Array.from({ length: live.iceberg.count }, () => createMesh(engine, blockShape, blockMaterial));
  const marker = toGeometry(cylinderGeometry(0.115, 0.15, 0.065, 12));
  const red = new PbrMaterial({ color: '#ac6847', roughness: 0.57 });
  const gauges = survey.map(([x, z]) =>
    engine.createMesh().setGeometry(marker).setMaterial(red).setPosition([x, 0.0325, z]),
  );
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const info = new Font({ family: 'Arial, sans-serif', weight: 400 });
  labels.add(
    new Text({
      text: 'A tidewater glacier calves',
      font: title,
      fontSize: 1.09,
      color: '#eee6d3',
      position: [-0.957, 8.801, -5.253],
      billboard: true,
      onTop: true,
    }),
  );
  labels.add(
    new Text({
      text: 'A detached ice block drives a wave into the fjord',
      font: info,
      fontSize: 0.54,
      color: '#d4e3e6',
      position: [-0.659, 7.639, -4.926],
      billboard: true,
      onTop: true,
    }),
  );
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.2 });
  const water = Water.attach(engine, {
    size: waterSize,
    segments: 384,
    height: 0,
    whitecaps: 0,
    chop: 0,
    color: [0.021, 0.11, 0.16],
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
  });
  let selected = live;
  let displayWake = live.wake;
  const rendered = WaterWake.attach(engine, {
    surface: water,
    wake: { grid: live.wake.grid, heights: () => displayWake.heights() },
  });
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
  function stage(accepted) {
    tongue.setGeometry(iceTongue(selected, accepted.depths));
    for (const [i, pose] of accepted.ice.entries()) {
      const root = blocks[i].root;
      root.visible = pose.size.every((v) => v > 1e-6);
      if (root.visible) root.setPosition(pose.position).setQuaternion(pose.orientation).setScale(pose.size);
    }
    const [x, , z] = accepted.ice[0].position;
    const wake = displayWake.sample(x, z);
    blockMaterial.setWater({ x, z, height: wake.height, slopeX: wake.slope[0], slopeZ: wake.slope[1] });
    for (const [i, [x, z]] of survey.entries()) gauges[i].setPosition([x, displayWake.sample(x, z).height + 0.0325, z]);
    water.resetTime();
  }
  stage(state(live));
  await waitForPipelines(draw);

  let saved;
  function seek(frame, action) {
    if (action === 'restore' || frame < selected.frame) {
      const point = action === 'restore' ? saved : { frame: 0, snapshot: selected.first };
      selected.world.restoreSnapshot(point.snapshot.bytes);
      selected.frame = point.frame;
    }
    if (frame > selected.frame) selected.world.advance((selected.frame = frame));
    const snapshot = selected.world.takeSnapshot();
    const earlier = selected.records.get(frame);
    if (earlier && (earlier.length !== snapshot.bytes.length || earlier.some((v, i) => v !== snapshot.bytes[i])))
      throw new Error('The accepted terrain, glacier, released body and water must replay together.');
    selected.records.set(frame, snapshot.bytes);
    if (action === 'save') saved = { frame, snapshot };
    return snapshot.hash;
  }
  return {
    cue,
    releaseFrame,
    checkpoint,
    end,
    front,
    dx,
    initialVolume,
    patchWords: WAKE_SOURCE_WORDS,
    async sample({ editFrame, action, mode = 'live', query = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      selected = mode === 'closed' ? closed : live;
      displayWake = mode === 'mute' ? closed.wake : selected.wake;
      const hash = seek(frame, action);
      const accepted = state(selected);
      stage(accepted);
      draw();
      draw();
      const commands = gpu.createCommandEncoder();
      commands.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([commands.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      const read = query ? await WaveQuery.capture(water) : undefined;
      return {
        frame,
        hash,
        ...accepted,
        drawLevels: survey.map((xz) => read?.heightAt(...xz) ?? null),
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      rendered.dispose();
      tongue.destroy();
      ground.destroy();
      for (const block of blocks) block.destroy();
      labels.dispose();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

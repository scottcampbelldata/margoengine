import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { boxGeometry, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { createMesh } from '@margoengine/materials';
import { ICEBERG_BODY_WORDS, ICEBERG_FIELD_LAYOUT, IcebergSolver } from '@margoengine/physics/iceberg';
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
const checkpoint = 150;
const over = 300;
const end = 570;
const cells = [96, 80];
const cellSize = 0.4;
const waterSize = cells.map((n) => n * cellSize);
const size = [1.5, 6.3, 4.5];
const x0 = -2.5;
const heel = 0.1;
const density = 917;
const waterDensity = 1025;
const depth = 8;
const gauges = [
  [2, 0],
  [4, 0],
  [6, 0],
];

async function take(linked) {
  // Cuboid capsize with an initial heel, after Burton et al. (2012), doi:10.1029/2011JF002055.
  // This metre-scale idealization and its initial heel are chosen for the shot. They are not the laboratory setup.
  const ice = await IcebergSolver.load();
  const wake = await WakeSolver.load({ id: 'iceberg-wake', sourceField: linked ? ice.wakeSourceField : undefined });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, memory: worldMemory(false) });
  world.add(wake, { cells, cellSize, depth, sponge: 0, density: waterDensity }).add(ice, {
    iceDensity: density,
    waterDensity,
    bodies: [
      {
        size,
        orientation: [0, 0, Math.sin(heel / 2), Math.cos(heel / 2)],
        position: [x0, size[1] * (0.5 - density / waterDensity), 0],
      },
    ],
  });
  return { ice, wake, world, frame: 0, start: world.takeSnapshot(), records: new Map() };
}

function accepted(take) {
  const { ice, wake, world } = take;
  const bodyPort = world.fields.port(ice.bodyField.name);
  const wavePort = world.fields.port(ice.wakeSourceField.name);
  if (
    bodyPort?.region.layout !== ICEBERG_FIELD_LAYOUT ||
    bodyPort.region.type !== 'f64' ||
    wavePort?.region.layout !== WAKE_SOURCE_LAYOUT ||
    wavePort.region.type !== 'f64' ||
    wavePort.cell.some(Boolean)
  )
    throw new Error('Use the registered f64 iceberg body and signed wave sources in the rendered water cell.');
  const body = ice.sample(0);
  const pose = regionWords(world.memory, bodyPort.region);
  if (
    pose.length !== ICEBERG_BODY_WORDS ||
    [
      ...body.position,
      ...body.orientation,
      ...body.velocity,
      ...body.spin,
      ...body.size,
      body.displaced,
      body.waveVolume,
    ].some((v, i) => v !== pose[i])
  )
    throw new Error('The rendered body pose and accepted registry disagree.');
  const source = Array.from(regionWords(world.memory, wavePort.region));
  if (source.length !== 2 * WAKE_SOURCE_WORDS)
    throw new Error('Expect the paired compact and distributed wake patches.');
  let low = Infinity;
  let high = -Infinity;
  let netVolume = 0;
  for (const value of wake.heights()) {
    netVolume += value * cellSize ** 2;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const heights = gauges.map(([x, z]) => wake.sample(x, z).height);
  return { body, budget: ice.budget, source, wave: { low, high, netVolume, heights } };
}

function basin(engine) {
  const base = new PbrMaterial({ color: '#526066', roughness: 0.86 });
  const face = new PbrMaterial({ color: '#3c4a50', roughness: 0.79 });
  const rim = new PbrMaterial({ color: '#778986', roughness: 0.51 });
  const brass = new PbrMaterial({ color: '#a1875c', roughness: 0.59 });
  const polymer = new PbrMaterial({ color: '#bd694d', roughness: 0.51 });
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const [w, l] = waterSize;
  const sides = [-1, 1];
  for (const side of sides) {
    part(box(w + 1.4, 0.78, 0.7), face, [0, -0.28, side * (l / 2 + 0.34)]);
    part(box(w + 1.4, 0.11, 0.72), rim, [0, 0.15, side * (l / 2 + 0.34)]);
    part(box(0.69, 0.78, l), face, [side * (w / 2 + 0.34), -0.28, 0]);
    part(box(0.7, 0.11, l), rim, [side * (w / 2 + 0.34), 0.15, 0]);
  }
  part(box(w, 0.42, l), base, [0, -depth - 0.21, 0]);
  const disc = toGeometry(cylinderGeometry(0.15, 0.187, 0.09, 16));
  const shaft = toGeometry(cylinderGeometry(0.025, 0.025, 0.75, 10));
  const cap = toGeometry(cylinderGeometry(0.06, 0.06, 0.045, 12));
  return gauges.map(([x, z]) => {
    part(shaft, rim, [x, 0.28, z]);
    part(cap, brass, [x, 0.684, z]);
    return part(disc, polymer, [x, 0.045, z]);
  });
}

export async function mountIcebergFilm() {
  const [linked, mute] = await Promise.all([take(true), take(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [4.6, 6.7, 17], target: [0.5, 0.18, 0], fov: 41, near: 0.17, far: 118 },
  });
  engine.scene.background = '#486775';
  engine.lighting.direction.set([-0.37, 0.51, -0.88, 2.35]);
  engine.lighting.radiance.set([0.94, 0.95, 1, 0.92]);
  engine.lighting.ambient.set([0.61, 0.67, 0.76]);
  const markers = basin(engine);
  const iceMat = new IceMaterial({
    notch: false,
    look: { blueIce: 0.5, bandScale: 0.68, wetHeight: 0.18, roughness: 0.58, scallopDepth: 0.22, scatterDepth: 2.5 },
  });
  // The display is the exact physical cuboid shape. Its colour and grain are from the production glacial-ice material.
  const iceMesh = createMesh(engine, boxGeometry(1, 1, 1), iceMat);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const info = new Font({ family: 'Arial, sans-serif', weight: 400 });
  labels.add(
    new Text({
      text: 'An iceberg rolls',
      font: title,
      fontSize: 0.69,
      color: '#eee5d4',
      position: [-10.849, 5.424, 0.356],
      billboard: true,
      onTop: true,
    }),
  );
  labels.add(
    new Text({
      text: 'Displaced water passes three wave gauges',
      font: info,
      fontSize: 0.35,
      color: '#d9e3e6',
      position: [-10.79, 4.746, 0.602],
      billboard: true,
      onTop: true,
    }),
  );
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.25 });
  const water = Water.attach(engine, {
    size: waterSize,
    segments: 192,
    height: 0,
    whitecaps: 0,
    chop: 0,
    color: [0.025, 0.125, 0.18],
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 12 }],
  });
  let selected = linked;
  const drawWake = WaterWake.attach(engine, {
    surface: water,
    wake: { grid: linked.wake.grid, heights: () => selected.wake.heights() },
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
  function stage(state) {
    const { position, orientation, size } = state.body;
    iceMesh.root.setPosition(position).setQuaternion(orientation).setScale(size);
    const waterline = selected.wake.sample(position[0], position[2]);
    iceMat.setWater({
      x: position[0],
      z: position[2],
      height: waterline.height,
      slopeX: waterline.slope[0],
      slopeZ: waterline.slope[1],
    });
    for (const [i, [x, z]] of gauges.entries()) markers[i].setPosition([x, state.wave.heights[i] + 0.045, z]);
    water.resetTime();
  }
  stage(accepted(linked));
  await waitForPipelines(draw);

  let saved;
  function seek(frame, action) {
    if (action === 'restore' || frame < selected.frame) {
      const point = action === 'restore' ? saved : { frame: 0, snapshot: selected.start };
      selected.world.restoreSnapshot(point.snapshot.bytes);
      selected.frame = point.frame;
    }
    if (frame > selected.frame) selected.world.advance((selected.frame = frame));
    const snapshot = selected.world.takeSnapshot();
    const before = selected.records.get(frame);
    if (before && (before.length !== snapshot.bytes.length || before.some((v, i) => v !== snapshot.bytes[i])))
      throw new Error('The accepted ice and wake bytes must match after restoring and re-advancing.');
    selected.records.set(frame, snapshot.bytes);
    if (action === 'save') saved = { frame, snapshot };
    return snapshot.hash;
  }

  return {
    cue,
    checkpoint,
    over,
    end,
    heel,
    x0,
    density,
    waterDensity,
    N: cells[0] * cells[1],
    async sample({ editFrame, action, connected = true, query = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      selected = connected ? linked : mute;
      const hash = seek(frame, action);
      const state = accepted(selected);
      stage(state);
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      const capture = query ? await WaveQuery.capture(water) : undefined;
      const drawHeights = gauges.map((point) => capture?.heightAt(...point) ?? null);
      return { frame, hash, ...state, drawHeights, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      labels.dispose();
      drawWake.dispose();
      iceMesh.destroy();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

import { EngineKernel, Geometry, PbrMaterial, box } from '@margoengine/core';
import { Environment, EnvironmentLighting } from '@margoengine/environment';
import { studio } from '@margoengine/environment/studio';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import {
  AGEING_EXPOSURE_WORDS,
  AGEING_YEAR,
  MaterialAgeingSolver,
  writeAgeingExposure,
} from '@margoengine/physics/ageing';
import { bedSurface } from '@margoengine/physics/earth';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT, ShallowWaterSolver } from '@margoengine/physics/hydro';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const firstCheckpoint = 19;
const wetCheckpoint = 90;
const drainCheckpoint = 156;
const end = 216;
const seed = 93751;
const cell = [-9, 2, 7];
const bedWidth = 0.456;
const bedDepth = 0.528;
const rows = 6;
const couponStation = 3;
const couponZ = (couponStation + 0.5) * (bedDepth / rows) - bedDepth / 2;
const bands = 8;
const bandHeight = 0.014;
const couponBottom = 0.036;
const couponWidth = 0.278;
const couponThickness = 0.002;
const lanes = [-0.302, 0.302];
const floorY = 0.035;
const retention = 0.68;
const current = 0.018;
const climate = {
  temperature: 293.15,
  relativeHumidity: 0.66,
  sulphurDioxide: 0,
  chloride: 0,
  rainfall: 0,
  larvalSupply: 0,
  corrosionCurrent: current,
};
const scale = AGEING_YEAR;
const portBytes = bands * AGEING_EXPOSURE_WORDS * 8;
// Dorsey and Hanrahan (1996): weathering layers modulate metallic optical response.
// https://graphics.stanford.edu/papers/patina/
// The coupon is deliberately a stack of independent exposure columns. The immersion current and the
// optics in the production solver are authored parameters. No observed rust thickness is fitted here.

class WaterlineExposure {
  constructor(field) {
    this.field = field;
  }

  describe() {
    return {
      id: 'coupon-waterline',
      fields: [
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: this.field, access: 'write' },
      ],
      rate: 0,
      stableRate: () => 0,
    };
  }

  init(host) {
    this.host = host;
    this.exposure = host.allocate('coupon-wet-fractions', portBytes, 'f64', 1);
    this.integrated = host.allocate('coupon-immersed-seconds', bands * 8, 'f64', 1);
    const words = regionWords(host.memory, this.exposure);
    for (let i = 0; i < bands; i++) writeAgeingExposure(words, climate, i);
  }

  step(context, dt) {
    const water = context.inputs.get(SURFACE_WATER_FIELD.name);
    if (
      !water ||
      water.region.type !== 'f32' ||
      water.region.layout !== SURFACE_WATER_LAYOUT ||
      water.region.byteLength !== 3 * rows * 4 ||
      water.cell.some((value, axis) => value !== this.host.cell[axis])
    )
      throw new Error('Use the coupon tray HYDRO-01 depth grid in the exposure producer’s signed cell.');
    const level = regionWords(this.host.memory, water.region)[3 * couponStation];
    const out = regionWords(this.host.memory, this.exposure);
    const dose = regionWords(this.host.memory, this.integrated);
    for (let i = 0; i < bands; i++) {
      const bottom = couponBottom + bandHeight * i;
      const submerged = Math.min(1, Math.max(0, (level - bottom) / bandHeight));
      writeAgeingExposure(out, { ...climate, submerged }, i);
      dose[i] += submerged * (dt * scale);
    }
  }

  exportPorts(tick) {
    return [{ field: this.field.name, region: this.exposure, tick, cell: this.host.cell }];
  }

  importPorts() {}
  stateRegions() {
    return [this.exposure, this.integrated];
  }
  extraState() {
    return [];
  }
}

async function establish(exposed) {
  const water = new ShallowWaterSolver();
  const ageing = await MaterialAgeingSolver.load({ readExposure: true, threads: 1 });
  const exposure = new WaterlineExposure(ageing.exposureField);
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, memory: worldMemory(false), cellSize: 64 });
  const bed = bedSurface(
    { columns: 1, rows, width: bedWidth, depth: bedDepth, centre: [0, 0] },
    new Float64Array(2 * (rows + 1)),
  );
  world.add(
    water,
    {
      bed,
      sides: { maxZ: { level: 0 } },
      roughness: 0.012,
      inflows: [{ position: [0, -0.22], discharge: (time) => (exposed && time >= 0.4 && time < 1.6 ? 0.065 : 0) }],
    },
    cell,
  );
  world.add(exposure, {}, cell);
  world.add(
    ageing,
    {
      patches: Array.from({ length: bands }, () => ({
        material: 'steel',
        thickness: couponThickness,
        coatingRetention: retention,
      })),
      timeScale: scale,
    },
    cell,
  );
  const fresh = Array.from({ length: bands }, (_, i) => ageing.appearance(i));
  return {
    world,
    water,
    ageing,
    exposure,
    fresh,
    frame: 0,
    saved: new Map([[0, { frame: 0, snapshot: world.takeSnapshot() }]]),
    visited: new Map(),
  };
}

function seek(take, goal, action) {
  if (action === 'restore' || goal < take.frame) {
    const saved = take.saved.get(action === 'restore' ? goal : 0);
    take.world.restoreSnapshot(saved.snapshot.bytes);
    take.frame = saved.frame;
  }
  if (goal > take.frame) {
    take.world.advance(goal);
    take.frame = goal;
  }
  const snapshot = take.world.takeSnapshot();
  const previous = take.visited.get(goal);
  if (previous && (snapshot.bytes.length !== previous.length || previous.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error('Restore the same accepted hydraulic, exposure, and oxide histories at the edit mark.');
  take.visited.set(goal, snapshot.bytes);
  if (action === 'save') take.saved.set(goal, { frame: goal, snapshot });
  return snapshot.hash;
}

function strip() {
  return new Geometry(
    [-couponWidth / 2, 0, 0, couponWidth / 2, 0, 0, couponWidth / 2, bandHeight, 0, -couponWidth / 2, bandHeight, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2, 0, 2, 3],
  );
}

function tankSurface(depths, x, shown) {
  const positions = [],
    uvs = [],
    indices = [];
  for (let j = 0; j <= rows; j++) {
    const previous = depths[Math.max(0, j - 1)];
    const next = depths[Math.min(rows - 1, j)];
    const y = shown ? floorY + (previous + next) / 2 + 0.0002 : -1;
    for (const sign of [-1, 1]) {
      positions.push(x + 0.5 * sign * bedWidth, y, (j / rows - 0.5) * bedDepth);
      uvs.push((sign + 1) / 2, j / rows);
    }
    if (j < rows) {
      const i = 2 * j;
      indices.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  return computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices));
}

const wallLength = bedDepth + 0.01;
const backRim = 0.274;
const frontRim = 0.155;

function railWall() {
  const a = 0.013;
  const b = wallLength / 2;
  const base = 0.021;
  const points = [
    [-a, base, -b],
    [a, base, -b],
    [a, base, b],
    [-a, base, b],
    [-a, backRim, -b],
    [a, backRim, -b],
    [a, frontRim, b],
    [-a, frontRim, b],
  ];
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
    [1, 5, 6, 2],
  ];
  const vertices = [],
    uvs = [],
    indices = [];
  for (const face of faces) {
    const start = vertices.length / 3;
    for (const i of face) vertices.push(...points[i]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return toGeometry(computeVertexNormals(geometryData(vertices, new Float32Array(vertices.length), uvs, indices)));
}

function rig(engine) {
  const cabinet = new PbrMaterial({ color: '#4e544e', roughness: 0.62 });
  const tray = new PbrMaterial({ color: '#596966', roughness: 0.43 });
  const edge = new PbrMaterial({ color: '#a0a69c', roughness: 0.55 });
  const rustFloor = new PbrMaterial({ color: '#576b64', roughness: 0.72 });
  const rubber = new PbrMaterial({ color: '#4c4b43', roughness: 0.85 });
  const bolts = new PbrMaterial({ color: '#9e8a6c', roughness: 0.38, metalness: 1 });
  const tubing = new PbrMaterial({ color: '#a48660', roughness: 0.34, metalness: 1 });
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const rounded = (size, bevel, material, position) =>
    part(toGeometry(roundedBoxGeometry(...size, 2, bevel)), material, position);
  part(box(3.4, 0.13, 2.3), cabinet, [0, -0.077, -0.12]);
  rounded([1.21, 0.067, 0.69], 0.015, cabinet, [0, -0.019, 0.01]);
  const v = strip();
  const y = floorY + couponBottom + bands * bandHeight;
  const panelDepth = 0.007;
  const fastener = toGeometry(cylinderGeometry(0.0055, 0.0055, 0.005, 12));
  const pipe = toGeometry(cylinderGeometry(0.016, 0.016, 0.112, 18));
  const mouth = toGeometry(cylinderGeometry(0.023, 0.023, 0.019, 18));
  const sideWall = railWall();
  const rimSlope = Math.atan2(backRim - frontRim, wallLength);
  const rimLength = Math.hypot(wallLength, backRim - frontRim);
  return lanes.map((x) => {
    rounded([bedWidth + 0.04, 0.028, bedDepth + 0.033], 0.009, tray, [x, 0.022, 0]);
    rounded([bedWidth, 0.008, bedDepth], 0.003, rustFloor, [x, floorY - 0.004, 0]);
    for (const sign of [-1, 1]) {
      const railX = x + (sign * (bedWidth + 0.024)) / 2;
      part(sideWall, tray, [railX, 0, 0]);
      rounded([0.031, 0.009, rimLength], 0.003, edge, [railX, (backRim + frontRim) / 2, 0]).setRotation([
        rimSlope,
        0,
        0,
      ]);
    }
    rounded([bedWidth + 0.044, backRim - 0.021, 0.022], 0.008, tray, [x, (backRim + 0.021) / 2, -bedDepth / 2 - 0.016]);
    rounded([bedWidth + 0.02, 0.027, 0.034], 0.004, tray, [x, 0.031, bedDepth / 2 - 0.008]);
    for (let r = -8; r <= 8; r++) part(box(0.003, 0.0016, 0.022), rubber, [x + r * 0.021, 0.045, bedDepth / 2 - 0.009]);
    part(pipe, tubing, [x - 0.103, 0.331, -0.216]);
    part(mouth, edge, [x - 0.103, 0.272, -0.216]);
    rounded([couponWidth + 0.057, 0.022, 0.022], 0.005, edge, [x, y + 0.006, couponZ]);
    const reverse = y - (bands * bandHeight) / 2;
    part(box(couponWidth, bands * bandHeight, panelDepth), edge, [x, reverse, couponZ - panelDepth / 2 - 0.0007]);
    for (const sign of [-1, 1]) {
      rounded([0.017, 0.197, 0.024], 0.0035, tray, [x + (sign * (couponWidth + 0.048)) / 2, 0.128, couponZ - 0.008]);
      part(fastener, bolts, [x + sign * 0.119, y + 0.004, couponZ + 0.011]).setRotation([Math.PI / 2, 0, 0]);
    }
    const materials = Array.from({ length: bands }, (_, i) => {
      const m = new PbrMaterial({ roughness: 0.23, metalness: 1 });
      part(v, m, [x, floorY + couponBottom + bandHeight * i, couponZ]);
      return m;
    });
    const water = createMesh(
      engine,
      tankSurface(new Float32Array(rows), x, false),
      new SurfaceMaterial({ color: '#779a90', roughness: 0.19, opacity: 0.54, transparent: true }),
    );
    return { materials, water };
  });
}

export async function mountAgeingFilm() {
  const takes = await Promise.all([establish(true), establish(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0.08, 0.36, 1], target: [0.009, 0.186, -0.025], fov: 42, near: 0.03, far: 5 },
  });
  engine.scene.background = '#2d4647';
  engine.lighting.direction.set([-0.42, 0.71, 0.56, 1.34]);
  engine.lighting.radiance.set([1, 0.95, 0.85, 1]);
  engine.lighting.ambient.set([0.32, 0.44, 0.5]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const env = await Environment.attach(engine, studio({ width: 128 }), {
    size: 32,
    samples: 24,
    brdfSize: 16,
    brdfSamples: 48,
  });
  EnvironmentLighting.attach(engine, env);
  const drawables = rig(engine);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize) =>
    labels.add(new Text({ text, position, font, fontSize, color: '#eeeadb', billboard: true, onTop: true }));
  label('Steel keeps the waterline', [-0.49, 0.495, -0.18], title, 0.057);
  label('Accelerated exposure · one model year per second', [-0.485, 0.437, -0.18], notes, 0.025);
  label('Immersion tray', [-0.397, 0.008, 0.29], notes, 0.02);
  label('Dry control', [0.214, 0.008, 0.29], notes, 0.02);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.2 });
  const target = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const output = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const camera = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: target } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [camera] });
  await waitForPipelines(draw);
  return {
    cue,
    firstCheckpoint,
    wetCheckpoint,
    drainCheckpoint,
    end,
    rate,
    seed,
    cell,
    scale,
    current,
    retention,
    bands,
    couponBottom,
    bandHeight,
    couponThickness,
    couponStation,
    async sample({ editFrame, action, showWater = true, showWeathering = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = takes.map((take, ix) => {
        const { world, water, ageing, exposure } = take;
        const hash = seek(take, frame, action);
        const ageingPort = world.fields.port(ageing.stateField.name);
        const waterPort = world.fields.port(SURFACE_WATER_FIELD.name);
        const exposurePort = world.fields.port(ageing.exposureField.name);
        const state = Array.from({ length: bands }, (_, i) => ageing.read(i));
        const appearance = Array.from({ length: bands }, (_, i) => ageing.appearance(i));
        const accepted = regionWords(world.memory, waterPort.region);
        const depths = Array.from({ length: rows }, (_, z) => accepted[3 * z]);
        drawables[ix].water.setGeometry(tankSurface(depths, lanes[ix], showWater && Math.max(...depths) > 0.0004));
        for (const [i, material] of drawables[ix].materials.entries())
          material.set(showWeathering ? appearance[i] : take.fresh[i]);
        const published = regionWords(world.memory, exposurePort.region);
        return {
          hash,
          state,
          appearance,
          depths,
          acceptedDepth: water.sample(0, couponZ).depth,
          budget: water.budget,
          stored: water.volume(),
          dose: Array.from(regionWords(world.memory, exposure.integrated)),
          wet: Array.from({ length: bands }, (_, i) => published[i * AGEING_EXPOSURE_WORDS + 4]),
          fields: [ageingPort.cell, waterPort.cell, exposurePort.cell],
        };
      });
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const color = new Uint8ClampedArray(output.getMappedRange()).slice();
      output.unmap();
      pixels.putImageData(new ImageData(color, width, height), 0, 0);
      return { frame, states, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      for (const { ageing } of takes) ageing[Symbol.dispose]?.();
      return { errors, validation };
    },
  };
}

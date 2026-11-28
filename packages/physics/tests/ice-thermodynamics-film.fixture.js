import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { BED_FIELD, BED_LAYOUT, TerrainBed } from '@margoengine/physics/earth';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT, ShallowWaterSolver } from '@margoengine/physics/hydro';
import {
  ICE_FIELD_LAYOUT,
  ICE_GEOMETRY_FIELD,
  ICE_HEAT_ABSORPTION_FIELD,
  ICE_HEAT_FIELD,
  ICE_MELTWATER_FIELD,
  ICE_STEAM_FIELD,
  IceSolver,
} from '@margoengine/physics/ice';
import { LavaSolver } from '@margoengine/physics/lava';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { LavaSurface } from '@margoengine/weather/lava';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 24;
const firstVent = 0.42;
const shutVent = 3.5;
const checkpoint = 540;
const end = 1200;
const seed = 41;
const columns = 16;
const rows = 12;
const spacing = 0.2;
const area = spacing * spacing;
const thickness = 0.017;
const freezing = 273.15;
const iceDensity = 917;
const waterDensity = 1000;
const size = [columns * spacing, rows * spacing];
const origin = size.map((v) => -v / 2);
const terrain = { columns, rows, width: size[0], depth: size[1], centre: [0, 0] };
const cell = [-4, 3, 11];
const cellSize = 64;
const contacts = [
  [7, 3],
  [7, 4],
  [7, 5],
  [8, 3],
  [8, 4],
  [8, 5],
];
const centre = ([x, z]) => [origin[0] + (x + 0.5) * spacing, origin[1] + (z + 0.5) * spacing];
const outlet = centre([11, 9]);
const vents = [3, 4, 5].map((z) => ({ cell: [2, z], flow: 0.011, start: firstVent, end: shutVent, temperature: 1450 }));
const outletVolume = {
  name: 'apronMeltwaterVolume',
  kind: 'scalarSeries',
  quantity: 'volumeFlowRate',
  unit: 'm^3/s',
  centring: 'cell',
};

// Basalt and an ice margin inspired by the natural and experimental sections of Edwards et al. (2013), Fig. 1.
// https://doi.org/10.1130/G34305.1
const elevation = (x, z) =>
  0.19 -
  0.12 * x +
  0.085 * (z + 0.42) ** 2 +
  0.035 * Math.sin(3 * x - 2 * z) -
  0.38 * Math.exp(-(((x - 0.69) / 0.48) ** 2 + ((z - 0.75) / 0.43) ** 2)) +
  0.18 / (1 + Math.exp(14 * (1.06 - x)));

function meltwaterVolume() {
  let host;
  let local;
  return {
    describe: () => ({
      id: 'apron-drain',
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: ICE_MELTWATER_FIELD, access: 'read' },
        { field: outletVolume, access: 'write' },
      ],
    }),
    init(acceptedHost) {
      host = acceptedHost;
      local = host.allocate('liquid', 8 * contacts.length, 'f64', ICE_FIELD_LAYOUT);
    },
    step({ inputs, cell }) {
      const port = inputs.get(ICE_MELTWATER_FIELD.name);
      if (port.cell.some((v, i) => v !== cell[i])) throw new Error('Co-locate the liquid drain with its ice sites.');
      const mass = regionWords(port.region.memory ?? host.memory, port.region);
      const volume = regionWords(host.memory, local);
      for (let i = 0; i < volume.length; i++) volume[i] = mass[i] / waterDensity;
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: outletVolume.name, region: local, tick, cell: host.cell }],
    stateRegions: () => [local],
    extraState: () => [],
  };
}

async function makeTake(exchange) {
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, cellSize, memory: worldMemory(false) });
  const bed = new TerrainBed();
  world.add(bed, { ...terrain, elevations: elevation }, cell);
  const lava = await LavaSolver.load({ terrain, exchangeIce: exchange });
  const ice = await IceSolver.load({ readHeat: exchange, threads: 1 });
  const sites = contacts.map(() => ({ kind: 'sheet', thickness, temperature: freezing, area }));
  world.add(
    lava,
    {
      cells: [columns, rows],
      spacing,
      origin,
      originCell: cell,
      originCellSize: cellSize,
      bed: 0,
      transport: 'terminal',
      viscosity: 115,
      conductivity: 2.8,
      skinDepth: 0.006,
      vents,
      ice: exchange ? contacts.map((cell) => ({ cell, area })) : [],
    },
    cell,
  );
  world.add(ice, { sites }, cell);
  if (exchange) world.couple([lava.describe().id, ice.describe().id], 'staggered');
  world.add(meltwaterVolume(), {}, cell);
  const hydro = new ShallowWaterSolver('floor-pool', {
    field: outletVolume,
    outlets: contacts.map((_, sourceCell) => ({ sourceCell, position: outlet })),
  });
  world.add(hydro, { bed: bed.bed, roughness: 0.034 }, cell);
  return { world, lava, ice, bed, hydro, exchange, frame: 0, first: world.takeSnapshot(), records: new Map() };
}

function seek(take, frame, action) {
  if (action === 'restore' || frame < take.frame) {
    const point = action === 'restore' ? take.checkpoint : { frame: 0, snapshot: take.first };
    take.world.restoreSnapshot(point.snapshot.bytes);
    take.frame = point.frame;
  }
  if (frame > take.frame) {
    take.world.advance(frame);
    take.frame = frame;
  }
  const snapshot = take.world.takeSnapshot();
  const old = take.records.get(frame);
  if (old && (old.length !== snapshot.bytes.length || old.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error('Replaying the contact must restore all accepted lava, ice and pool bytes.');
  take.records.set(frame, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame, snapshot };
  return snapshot.hash;
}

function accepted(take) {
  const { world, lava, ice, hydro } = take;
  const get = (field, length, type = 'f64', layout = ICE_FIELD_LAYOUT) => {
    const port = world.fields.port(field.name);
    if (
      port?.region.type !== type ||
      port.region.layout !== layout ||
      port.region.byteLength !== length * (type === 'f32' ? 4 : 8) ||
      port.cell.some((v, i) => v !== cell[i])
    )
      throw new Error('Render the lava, ice and meltwater from the accepted ports in the same signed cell.');
    return regionWords(world.memory, port.region);
  };
  get(BED_FIELD, (columns + 1) * (rows + 1), 'f32', BED_LAYOUT);
  const count = contacts.length;
  const sizes = get(ICE_GEOMETRY_FIELD, count * 2);
  const liquid = get(ICE_MELTWATER_FIELD, count);
  const steam = get(ICE_STEAM_FIELD, count);
  const absorbed = get(ICE_HEAT_ABSORPTION_FIELD, count);
  const drain = get(outletVolume, count);
  const heat = take.exchange ? get(ICE_HEAT_FIELD, count) : [];
  const magma = get(lava.lavaField, columns * rows * 8);
  const pool = get(SURFACE_WATER_FIELD, columns * rows * 3, 'f32', SURFACE_WATER_LAYOUT);
  const basin = hydro.sample(...outlet);
  if (pool[3 * (11 + 9 * columns)] !== Math.fround(basin.depth)) throw new Error('Read the accepted basin depth.');
  const sites = contacts.map(([x, z], i) => {
    const sample = ice.sample(i);
    if (
      sizes[2 * i] !== sample.thickness ||
      sizes[2 * i + 1] !== 0 ||
      liquid[i] !== sample.meltwater ||
      steam[i] !== sample.steam ||
      absorbed[i] !== sample.heatAbsorbed ||
      drain[i] !== liquid[i] / waterDensity
    )
      throw new Error('The ice surface and returned phase masses must match the producer.');
    const tile = lava.sample(x, z);
    const at = 8 * (x + z * columns);
    if (magma[at] !== tile.depth || magma[at + 2] !== tile.surfaceTemperature)
      throw new Error('The hot surface draw must use the registered lava state.');
    return { ...sample, lavaDepth: tile.depth, skin: tile.surfaceTemperature };
  });
  return { sites, heat: Array.from(heat), lava: lava.budget, water: hydro.volume(), basin, pool: hydro.budget };
}

function basaltRock(bed) {
  const positions = [];
  const colors = [];
  const indices = [];
  const nx = 4 * columns;
  const nz = 4 * rows;
  const phase = seed / 79;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = origin[0] + (i * size[0]) / nx;
      const z = origin[1] + (j * size[1]) / nz;
      const y = bed.sample(x, z).elevation;
      positions.push(x, y, z);
      const fracture = 0.82 + 0.12 * Math.sin(21 * x + 15 * z + phase) * Math.cos(27 * z - 7 * x);
      const stone = 0.7 + 0.18 * Math.cos(8 * x - 6 * z) + 0.15 * Math.sin(33 * x + 30 * z);
      const weathering = 0.03 + 0.042 * Math.max(0, Math.sin(7.3 * x + 7.1 * z));
      colors.push(
        (0.076 + weathering) * fracture * stone,
        (0.083 + 0.45 * weathering) * fracture * stone,
        0.084 * fracture * stone,
        1,
      );
      if (i < nx && j < nz) {
        const a = i + j * (nx + 1);
        const b = a + nx + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  // The cutaway continues to the foundation using the exact physical bed along the four edges.
  const edges = [
    [nx, (t) => [origin[0] + size[0] * t, -origin[1]]],
    [nz, (t) => [-origin[0], -origin[1] - size[1] * t]],
    [nx, (t) => [-origin[0] - size[0] * t, origin[1]]],
    [nz, (t) => [origin[0], origin[1] + size[1] * t]],
  ];
  for (const [count, edge] of edges) {
    const base = positions.length / 3;
    const floor = -0.15;
    for (let i = 0; i <= count; i++) {
      const [x, z] = edge(i / count);
      const top = bed.sample(x, z).elevation;
      const stratum = floor + 0.45 * (top - floor) + 0.014 * Math.sin(13 * x + 9 * z);
      const dark = 0.91 + 0.09 * Math.sin(x * 51 - z * 42);
      for (const [level, shade] of [
        [floor, 0.039],
        [stratum, 0.058],
        [stratum + 0.017, 0.077],
        [top, 0.095],
      ]) {
        positions.push(x, level, z);
        colors.push(shade * dark, shade * 0.88 * dark, shade * 0.83 * dark, 1);
      }
      if (i === 0) continue;
      for (let layer = 0; layer < 3; layer++) {
        const a = base + i * 4 + layer;
        const b = a - 4;
        indices.push(b, a, a + 1, b, a + 1, b + 1);
      }
    }
  }
  return vertexGeometry(positions, indices, colors);
}

function vertexGeometry(positions, indices, colors) {
  const mesh = geometryData(
    positions,
    new Float32Array(positions.length),
    new Float32Array((positions.length * 2) / 3),
    indices,
  );
  mesh.colors = Float32Array.from(colors);
  return computeVertexNormals(mesh);
}

function glaze(bed, values) {
  const positions = [];
  const colors = [];
  const indices = [];
  const count = 6;
  for (const [site, [cx, cz]] of contacts.entries()) {
    const ice = values[site].thickness;
    if (ice === 0) continue;
    const cornerX = origin[0] + cx * spacing;
    const cornerZ = origin[1] + cz * spacing;
    const start = positions.length / 3;
    for (let j = 0; j <= count; j++)
      for (let i = 0; i <= count; i++) {
        const sx = i / count;
        const sz = j / count;
        const x = cornerX + spacing * sx;
        const z = cornerZ + spacing * sz;
        positions.push(x, bed.sample(x, z).elevation + ice, z);
        const white = 0.84 + 0.1 * Math.cos(147 * x - 68 * z) + 0.065 * Math.sin(17 * x + 26 * z);
        const cleft = Math.exp(-((sx - 0.35 - 0.31 * sz) ** 2) / 0.003);
        colors.push(0.39 * white + 0.11 * cleft, 0.58 * white + 0.15 * cleft, 0.63 * white + 0.14 * cleft, 1);
        if (i < count && j < count) {
          const a = start + i + j * (count + 1);
          const b = a + count + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
  }
  return vertexGeometry(positions, indices, colors);
}

export async function mountIceThermodynamicsFilm() {
  const [warm, insulated] = await Promise.all([makeTake(true), makeTake(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [2.08, 2.0, 2.94], target: [0.01, 0.11, 0.0], fov: 41, near: 0.055, far: 18 },
  });
  engine.scene.background = '#263741';
  engine.lighting.direction.set([-0.56, 0.63, 0.52, 2.1]);
  engine.lighting.radiance.set([1, 0.92, 0.79, 1]);
  engine.lighting.ambient.set([0.44, 0.54, 0.63]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const rock = createMesh(
    engine,
    basaltRock(warm.bed.bed),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.89 }),
  );
  const ice = createMesh(
    engine,
    glaze(
      warm.bed.bed,
      contacts.map((_, i) => warm.ice.sample(i)),
    ),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.34 }),
  );
  const plinth = new PbrMaterial({ color: '#48515a', roughness: 0.82 });
  engine
    .createMesh()
    .setGeometry(toGeometry(roundedBoxGeometry(size[0] + 0.08, 0.17, size[1] + 0.08, 2, 0.072)))
    .setMaterial(plinth)
    .setPosition([0, -0.23, 0]);
  engine
    .createMesh()
    .setGeometry(box(12, 0.12, 11))
    .setMaterial(plinth)
    .setPosition([0, -0.36, 0]);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, font, fontSize, position) =>
    labels.add(new Text({ text, position, font, fontSize, color: '#eadfca', billboard: true, onTop: true }));
  label('Lava melts a frozen channel', title, 0.122, [-1.45, 1.06, -0.63]);
  label('17 mm initial ice · liquid drains into the adjoining basin', note, 0.064, [-1.45, 0.91, -0.63]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.14 });

  const bed = gpu.createTexture({
    size: [columns, rows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const heights = Float32Array.from(
    { length: columns * rows },
    (_, i) => warm.bed.bed.sample(...centre([i % columns, Math.floor(i / columns)])).elevation,
  );
  gpu.queue.writeTexture({ texture: bed }, heights, { bytesPerRow: columns * 4 }, [columns, rows]);
  const water = Water.attach(engine, {
    size,
    height: -0.25,
    segments: 96,
    color: [0.046, 0.178, 0.204],
    waves: [{ amplitude: 0, wavelength: 2, direction: [1, 0] }],
    foamDistance: 0.008,
    whitecaps: 0,
    chop: 0,
    terrain: { heightmap: () => bed, origin, size },
  });
  let current = warm;
  let magmaVisible = true;
  let poolVisible = true;
  const thermal = LavaSurface.attach(engine, {
    source: () => (magmaVisible ? current.lava.surfaceSource(cell) : undefined),
    glow: 5,
  });
  const mirror = ShallowWaterSurface.attach(engine, {
    surface: water,
    source: {
      shape: warm.hydro.shape,
      sample: (x, z, out) => (poolVisible ? current.hydro : insulated.hydro).sample(x, z, out),
    },
  });

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
  const encode = document.createElement('canvas');
  encode.width = width;
  encode.height = height;
  const pixels = encode.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  await waitForPipelines(draw);
  return {
    cue,
    rate,
    checkpoint,
    end,
    firstVent,
    shutVent,
    seed,
    thickness,
    area,
    count: contacts.length,
    iceDensity,
    waterDensity,
    async sample({ editFrame, action, exchange = true, showMagma = true, showPool = true, query = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      current = exchange ? warm : insulated;
      magmaVisible = showMagma;
      poolVisible = showPool;
      const hash = seek(current, frame, action);
      const state = accepted(current);
      const frozen = glaze(current.bed.bed, state.sites);
      ice.root.visible = frozen.indices.length !== 0;
      if (ice.root.visible) ice.setGeometry(frozen);
      water.resetTime();
      draw();
      draw();
      const poolHeight = query ? (await WaveQuery.capture(water)).heightAt(...outlet) : null;
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const color = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(color, width, height), 0, 0);
      return { frame, hash, ...state, poolHeight, image: encode.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      mirror.dispose();
      thermal.dispose();
      water.dispose();
      bed.destroy();
      rock.destroy();
      ice.destroy();
      labels.dispose();
      rgba.destroy();
      readback.destroy();
      for (const { lava, ice } of [warm, insulated]) {
        lava[Symbol.dispose]();
        ice[Symbol.dispose]?.();
      }
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

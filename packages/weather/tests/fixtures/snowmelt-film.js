import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import {
  computeVertexNormals,
  cylinderGeometry,
  planeGeometry,
  sphereGeometry,
  toGeometry,
} from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { LambertMaterial, createMesh } from '@margoengine/materials';
import { TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { Snowpack } from '@margoengine/physics/snowpack';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { Snow } from '@margoengine/weather/snow';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 24;
const checkpoint = 77;
const end = 235;
const secondsPerSecond = 14_400;
const freezing = 273.15;
const waterDensity = 1000;
const columns = 32;
const rows = 24;
const terrainShape = { columns, rows, width: 32, depth: 24, centre: [0, 0] };
const origin = [-16, -12];
const snowOrigin = [-15.5, -11.5];
const size = [32, 24];
const head = [2.5, 0.5];
const pond = [5.5, 0.5];
const survey = [head, pond, [8.5, 0.5], [-12.5, 8.5]];

// Small, idealized headwater bowl. The collection points stand in for mapped upland runoff routes, not a hillslope
// travel-time model. Rocky snow-fed basins and emerging waterways follow the USGS Loch Vale field photo references.
// https://www.usgs.gov/publications/determination-hydrologic-pathways-during-snowmelt-alpine-subalpine-basins-rocky
function elevation(x, z) {
  const along = x - 5.5;
  const across = z - 0.56 * Math.sin(0.29 * x + 0.1);
  const bowl = 0.014 * along ** 2 + 0.027 * across ** 2;
  const shelf = 0.14 * Math.sin(0.88 * x - 0.56 * z) * Math.sin(z * 0.52 + 0.3);
  return -0.86 + bowl + shelf * Math.min(1, bowl);
}

const sites = Array.from({ length: columns * rows }, (_, i) => [
  snowOrigin[0] + (i % columns),
  snowOrigin[1] + Math.floor(i / columns),
]);
const waterEquivalent = Float64Array.from(sites, ([x, z]) => {
  const mask = Math.max(0, 1 - ((x + 6.7) / 8.7) ** 2 - ((z + 1.1) / 10.9) ** 2);
  const drift = 87 + 22 * Math.cos(0.43 * z - x * 0.41) + 8 * Math.sin(0.89 * x + z * 0.33);
  return drift * mask;
});
const inheritedMass = waterEquivalent.reduce((a, b) => a + b, 0); // Each accepted snow column has one square metre.
const outlets = sites.map(([x, z], sourceCell) => ({
  sourceCell,
  position: [head[0] + (x < -5 ? 0 : 1), Math.max(-2.5, Math.min(2.5, Math.floor(z * 0.24) + 0.5))],
}));

function cellGround(elevations, i) {
  // At an exact cell centre the two diagonal vertices carry equal weight.
  const stride = rows + 1;
  const first = (i % columns) * stride + Math.floor(i / columns);
  return 0.5 * (elevations[first + 1] + elevations[first + stride]);
}

async function take(melt) {
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, memory: worldMemory(false) });
  const energy = new SurfaceEnergySolver();
  const terrain = new TerrainBed();
  const pack = await Snowpack.load({
    followTerrain: true,
    inputs: melt ? { topHeat: { field: energy.energyFluxField, stride: 5, weights: [1, -1, -1] } } : undefined,
  });
  world.add(terrain, { ...terrainShape, elevations: elevation });
  world.add(energy, {
    shortwave: 695,
    longwave: 320,
    albedo: 0.56,
    initialTemperature: freezing,
    airTemperature: freezing,
    deepTemperature: freezing,
    initialWater: 0,
    humidity: 0.69,
  });
  world.add(pack, {
    width: columns,
    depth: rows,
    origin: snowOrigin,
    // Establish the same elevations at initialization, before the first accepted TerrainBed port is stepped.
    ground: Float64Array.from(sites, (_, i) => cellGround(terrain.bed.elevations, i)),
    layers: [{ mass: waterEquivalent, density: 260, temperature: freezing }],
    airTemperature: freezing,
    retention: 0,
    secondsPerSecond,
  });
  const hydro = new ShallowWaterSolver('melt-pool', { field: pack.dischargeField, outlets });
  world.add(hydro, { bed: terrain.bed, roughness: 0.027 });
  return { world, pack, terrain, energy, hydro, frame: 0, initial: world.takeSnapshot(), records: new Map() };
}

function accepted(take) {
  const { world, pack, energy, hydro, terrain } = take;
  const coverPort = world.fields.port(pack.coverField.name);
  const dischargePort = world.fields.port(pack.dischargeField.name);
  if (
    coverPort?.region.layout !== 1 ||
    coverPort.region.type !== 'f32' ||
    dischargePort?.region.layout !== 1 ||
    dischargePort.region.type !== 'f64'
  )
    throw new Error('Read the accepted snow depth and discharge registry lanes.');
  const cover = regionWords(world.memory, coverPort.region);
  const drainage = regionWords(world.memory, dischargePort.region);
  const renderedCover = pack.fieldData();
  if (
    cover.length !== 2 * sites.length ||
    drainage.length !== sites.length ||
    cover.some((depth, i) => depth !== renderedCover[i])
  )
    throw new Error('Use all accepted ground and snow depths directly in the Weather surface hook.');
  let mass = 0;
  let depths = 0;
  let area = 0;
  let runoff = 0;
  const terrainVertices = terrain.bed.elevations;
  for (const [i, discharge] of drainage.entries()) {
    const snow = pack.read(i % columns, Math.floor(i / columns));
    mass += snow.mass;
    depths += cover[2 * i + 1];
    area += cover[2 * i + 1] > 0 ? 1 : 0;
    runoff += discharge;
    const ground = cellGround(terrainVertices, i);
    if (
      cover[2 * i] !== Math.fround(ground) ||
      cover[2 * i + 1] !== Math.fround(snow.depth) ||
      discharge !== snow.runoff
    )
      throw new Error(
        `At column ${i}, the registered terrain, depth and discharge ${[cover[2 * i], cover[2 * i + 1], discharge]} differ from ${[Math.fround(ground), Math.fround(snow.depth), snow.runoff]}.`,
      );
  }
  const { netRadiation, sensible, latent } = energy.read();
  return {
    mass,
    depths,
    area,
    runoff,
    heat: netRadiation - sensible - latent,
    water: hydro.volume(),
    budget: hydro.budget,
    surveys: survey.map((position) => hydro.sample(...position)),
    simulatedHours: (world.time * secondsPerSecond) / 3600,
  };
}

function relief(engine, bed) {
  const mesh = planeGeometry(size[0], size[1], columns * 3, rows * 3);
  const colors = new Float32Array((mesh.positions.length / 3) * 4);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    // planeGeometry is in XY with a +Z normal. Rotate to the same XZ plane and +Y normal as TerrainBed.
    const x = mesh.positions[i];
    const z = -mesh.positions[i + 1];
    const y = bed.sample(x, z).elevation;
    mesh.positions[i + 1] = y;
    mesh.positions[i + 2] = z;
    const mix = Math.max(0, Math.min(1, 0.44 + 0.22 * y + 0.31 * Math.cos(0.62 * z - 1.13 * x)));
    const strata =
      0.87 +
      0.075 * Math.sin(0.71 * x + 1.3 * Math.cos(z * 0.58)) +
      0.055 * Math.cos(4.27 * z + 1.2 * x) * Math.sin(2.2 * x - 0.9 * z);
    colors.set(
      [strata * (0.117 + 0.09 * mix), strata * (0.149 + 0.041 * mix), strata * (0.121 + 0.061 * mix), 1],
      (i * 4) / 3,
    );
  }
  mesh.colors = colors;
  const ground = createMesh(engine, computeVertexNormals(mesh), new LambertMaterial({ vertexColors: true }));
  const walls = [];
  const wallNormals = [];
  const wallTriangles = [];
  const wallColors = [];
  const edges = [
    { steps: columns, at: (t) => [origin[0] + t * size[0], -origin[1]], normal: [0, 0, 1] },
    { steps: rows, at: (t) => [-origin[0], -origin[1] - t * size[1]], normal: [1, 0, 0] },
    { steps: columns, at: (t) => [-origin[0] - t * size[0], origin[1]], normal: [0, 0, -1] },
    { steps: rows, at: (t) => [origin[0], origin[1] + t * size[1]], normal: [-1, 0, 0] },
  ];
  for (const { steps, at, normal } of edges) {
    for (let i = 0; i <= steps; i++) {
      const [x, z] = at(i / steps);
      const y = bed.sample(x, z).elevation;
      const row = walls.length / 3;
      walls.push(x, -1, z, x, y, z);
      wallNormals.push(...normal, ...normal);
      wallColors.push(0.065, 0.086, 0.088, 1, 0.158, 0.167, 0.129, 1);
      if (i > 0) wallTriangles.push(row - 2, row, row - 1, row, row + 1, row - 1);
    }
  }
  const side = geometryData(
    Float32Array.from(walls),
    Float32Array.from(wallNormals),
    new Float32Array((2 * walls.length) / 3),
    Uint32Array.from(wallTriangles),
  );
  side.colors = Float32Array.from(wallColors);
  const cutaway = createMesh(engine, side, new LambertMaterial({ vertexColors: true }));
  const foundation = new PbrMaterial({ color: '#435151', roughness: 0.95 });
  engine
    .createMesh()
    .setGeometry(box(32, 0.35, 24))
    .setMaterial(foundation)
    .setPosition([0, -1.16, 0]);
  const rock = toGeometry(sphereGeometry(1, 11, 7));
  const stones = [
    new PbrMaterial({ color: '#565d5d', roughness: 0.94 }),
    new PbrMaterial({ color: '#776c59', roughness: 0.91 }),
  ];
  for (const [i, [x, z]] of [
    [-7, 8.1],
    [-10.1, 6.8],
    [-11.23, 6.35],
    [10.25, -0.1],
    [9.9, 1.41],
    [10.9, 1.51],
    [0.6, -6.1],
    [1.4, -6.41],
  ].entries()) {
    const s = 0.34 + (i % 3) * 0.21;
    engine
      .createMesh()
      .setGeometry(rock)
      .setMaterial(stones[i % 2])
      .setScale([s * 1.36, s * 0.49, s * 1.05])
      .setPosition([x, bed.sample(x, z).elevation + s * 0.24, z])
      .setRotation([0, i * 0.66, 0]);
  }
  const stave = toGeometry(cylinderGeometry(0.075, 0.084, 0.97, 12));
  const collar = toGeometry(cylinderGeometry(0.089, 0.089, 0.048, 12));
  const ash = new PbrMaterial({ color: '#615448', roughness: 0.77 });
  const ivory = new PbrMaterial({ color: '#d8cab0', roughness: 0.74 });
  for (const [x, z] of [
    [-7.2, 2.25],
    [6.25, 2.25],
  ]) {
    const y = bed.sample(x, z).elevation;
    engine
      .createMesh()
      .setGeometry(stave)
      .setMaterial(ash)
      .setPosition([x, y + 0.475, z]);
    for (const mark of [0.19, 0.39, 0.59, 0.79])
      engine
        .createMesh()
        .setGeometry(collar)
        .setMaterial(ivory)
        .setPosition([x, y + mark, z]);
  }
  return [ground, cutaway];
}

export async function mountSnowmeltFilm() {
  const [warm, shaded] = await Promise.all([take(true), take(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [14.5, 16.65, 30.9], target: [-0.45, 0.79, 0.2], fov: 40, near: 0.4, far: 165 },
  });
  engine.scene.background = '#48616c';
  engine.lighting.direction.set([-0.41, 0.66, -0.57, 1.95]);
  engine.lighting.radiance.set([0.99, 0.95, 0.86, 1]);
  engine.lighting.ambient.set([0.57, 0.64, 0.71]);
  const ground = relief(engine, warm.terrain.bed);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.21 });
  const glyphs = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  glyphs.add(
    new Text({
      text: 'Snowmelt fills an alpine pool',
      font: title,
      fontSize: 1.05,
      position: [-19.106, 11.213, 7.15],
      color: '#eddfc6',
      billboard: true,
      onTop: true,
    }),
  );
  glyphs.add(
    new Text({
      text: 'Four hours of snowmelt per second',
      font: note,
      fontSize: 0.61,
      position: [-18.823, 9.823, 7.731],
      color: '#d1d9d6',
      billboard: true,
      onTop: true,
    }),
  );
  let currentSnow = warm;
  let currentWater = warm.hydro;
  let version = 0;
  const snowField = {
    width: columns,
    depth: rows,
    cellSize: 1,
    origin: snowOrigin,
    get version() {
      return version;
    },
    fieldData: () => currentSnow.pack.fieldData(),
  };
  const snowfall = Snow.attach(engine, {
    field: snowField,
    cover: 0,
    depth: 0,
    variation: 0,
    band: 0.155,
    color: [0.8, 0.86, 0.89],
  });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const terrain = gpu.createTexture({
    size: [columns, rows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const surfaceBed = Float32Array.from(sites, ([x, z]) => warm.terrain.bed.sample(x, z).elevation);
  gpu.queue.writeTexture({ texture: terrain }, surfaceBed, { bytesPerRow: columns * 4 }, [columns, rows]);
  const water = Water.attach(engine, {
    size,
    height: -0.9,
    segments: 192,
    color: [0.037, 0.17, 0.19],
    chop: 0,
    foamDistance: 0.027,
    whitecaps: 0,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 6 }],
    terrain: { heightmap: () => terrain, origin, size },
    transparency: 0.09,
  });
  const surface = ShallowWaterSurface.attach(engine, {
    surface: water,
    source: {
      shape: warm.hydro.shape,
      sample: (x, z, out) => currentWater.sample(x, z, out),
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
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  let saved;
  await waitForPipelines(draw);

  function seek(take, frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const point = action === 'restore' ? saved : { frame: 0, snapshot: take.initial };
      take.world.restoreSnapshot(point.snapshot.bytes);
      take.frame = point.frame;
    }
    if (frame > take.frame) take.world.advance((take.frame = frame));
    const snapshot = take.world.takeSnapshot();
    const prior = take.records.get(frame);
    if (prior && (prior.length !== snapshot.bytes.length || prior.some((x, i) => x !== snapshot.bytes[i])))
      throw new Error('Snow, surface heating, and shallow water must restore and re-advance exactly.');
    take.records.set(frame, snapshot.bytes);
    if (action === 'save') saved = { frame, snapshot };
    return snapshot.hash;
  }

  return {
    cue,
    checkpoint,
    end,
    inheritedMass,
    waterDensity,
    async sample({ editFrame, action, mode = 'warm', query = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const take = mode === 'shade' ? shaded : warm;
      const hash = seek(take, frame, action);
      currentSnow = take;
      currentWater = mode === 'snow-only' ? shaded.hydro : take.hydro;
      version++;
      water.resetTime();
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      const pondElevation = query ? (await WaveQuery.capture(water)).heightAt(...pond) : null;
      return { frame, hash, ...accepted(take), pondElevation, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      glyphs.dispose();
      for (const mesh of ground) mesh.destroy();
      surface.dispose();
      snowfall.dispose();
      terrain.destroy();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

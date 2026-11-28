import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { BED_FIELD, BED_LAYOUT, TerrainBed } from '@margoengine/physics/earth';
import { GroundwaterSolver } from '@margoengine/physics/groundwater';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT, ShallowWaterSolver } from '@margoengine/physics/hydro';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const columns = 24;
const rows = 14;
const dx = 0.4;
const count = columns * rows;
const cue = 24;
const rate = 60;
const checkpoint = 96;
const end = 300;
const secondsPerSecond = 120;
const conductivity = 0.00055;
const conductance = 0.004;
const bottom = -1.55;
const specificYield = 0.22;
const relativeResidual = 1e-12;
const size = [columns * dx, rows * dx];
const origin = size.map((value) => -value / 2);
const cell = [-8, 4, 12];
const grid = { columns, rows, width: size[0], depth: size[1], centre: [0, 0] };
const sourceX = 10;
const sourceZ = rows - 1;
const sourceIndex = sourceZ * columns + sourceX;
const centre = (x, z) => [origin[0] + (x + 0.5) * dx, origin[1] + (z + 0.5) * dx];
const points = Array.from({ length: count }, (_, i) => centre(i % columns, Math.floor(i / columns)));
const spring = points[sourceIndex];
// This physical cell centre is also a vertex of the 96-segment render surface.
const pond = centre(sourceX + 5, 10);
const slope = centre(sourceX - 4, sourceZ - 2);

// Original field cutaway inspired by Winter et al. (1998), USGS Circular 1139, Fig. 5.
// https://pubs.usgs.gov/circ/circ1139/htdocs/natural_processes_of_ground.htm
const elevation = (x, z) =>
  0.38 -
  0.045 * x +
  0.68 / (1 + Math.exp(2.9 * (x + 1.2))) +
  0.032 * (z - 1.7) ** 2 +
  0.027 * Math.sin(2.1 * x + 0.6 * z);

async function makeTake(open) {
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, cellSize: 64, memory: worldMemory(false) });
  const terrain = new TerrainBed();
  world.add(terrain, { ...grid, elevations: elevation }, cell);
  const surface = Float64Array.from(points, ([x, z]) => terrain.bed.sample(x, z).elevation);
  const springElevation = surface.slice();
  springElevation[sourceIndex] -= 0.69;
  const springConductance = new Float64Array(count);
  if (open) springConductance[sourceIndex] = conductance;
  const aquifer = await GroundwaterSolver.load({ followTerrain: true });
  world.add(
    aquifer,
    {
      grid,
      bottom,
      surface,
      initialHead: surface.map((y) => y - 0.34),
      specificYield,
      relativeResidual,
      conductivity,
      secondsPerSecond,
      springElevation,
      springConductance,
    },
    cell,
  );
  const hydro = new ShallowWaterSolver('pool', aquifer.shallowInput());
  world.add(hydro, { bed: terrain.bed, roughness: 0.034 }, cell);
  return {
    world,
    terrain,
    aquifer,
    hydro,
    surface,
    springElevation,
    first: world.takeSnapshot(),
    records: new Map(),
    frame: 0,
  };
}

function accepted(take) {
  const { world, aquifer, hydro } = take;
  function words(field, type, layout, length) {
    const port = world.fields.port(field.name);
    if (
      port?.region.type !== type ||
      port.region.layout !== layout ||
      port.region.byteLength !== length * (type === 'f32' ? 4 : 8) ||
      port.cell.some((value, i) => value !== cell[i])
    )
      throw new Error('Read terrain, aquifer and shallow-water state published in the same signed cell.');
    return regionWords(world.memory, port.region);
  }
  words(BED_FIELD, 'f32', BED_LAYOUT, (columns + 1) * (rows + 1));
  const heads = words(aquifer.headField, 'f64', 1, count);
  const outlet = words(aquifer.outletField, 'f64', 1, count);
  const springs = words(aquifer.springField, 'f64', 1, count);
  const seepage = words(aquifer.seepageField, 'f64', 1, count);
  const surface = words(SURFACE_WATER_FIELD, 'f32', SURFACE_WATER_LAYOUT, count * 3);
  let integratedVolume = 0;
  let totalSpring = 0;
  for (let i = 0; i < count; i++) {
    const state = aquifer.read(i % columns, Math.floor(i / columns));
    const water = hydro.sample(...points[i]);
    if (
      heads[i] !== state.head ||
      springs[i] !== state.spring ||
      seepage[i] !== state.seepage ||
      outlet[i] !== springs[i] + seepage[i] ||
      surface[3 * i] !== Math.fround(water.depth)
    )
      throw new Error(
        'The pictured groundwater table, spring outlet and open water must agree with their registered state.',
      );
    integratedVolume += water.depth * dx * dx;
    totalSpring += springs[i];
  }
  return {
    sourceHead: heads[sourceIndex],
    sourceFlow: springs[sourceIndex],
    springHours: (take.frame * secondsPerSecond) / (3600 * rate),
    totalSpring,
    integratedVolume,
    front: Array.from(heads.subarray(sourceZ * columns)),
    sites: [spring, pond, slope].map(([x, z]) => hydro.sample(x, z)),
    ground: aquifer.budget,
    runoff: hydro.budget,
    water: hydro.volume(),
  };
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
  const prior = take.records.get(frame);
  if (prior && (prior.length !== snapshot.bytes.length || prior.some((value, i) => value !== snapshot.bytes[i])))
    throw new Error('The released spring, porous storage, terrain and surface flow must replay byte for byte.');
  take.records.set(frame, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame, snapshot };
  return snapshot.hash;
}

function meshData(positions, indices, colors) {
  const geometry = geometryData(
    positions,
    new Float32Array(positions.length),
    new Float32Array(positions.length / 1.5),
    indices,
  );
  geometry.colors = Float32Array.from(colors);
  return computeVertexNormals(geometry);
}

function relief(bed) {
  const positions = [];
  const indices = [];
  const colors = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const x = origin[0] + i * dx;
      const z = origin[1] + j * dx;
      const sample = bed.sample(x, z);
      positions.push(x, sample.elevation, z);
      const raised = 1 / (1 + Math.exp(4 * (x + 0.5)));
      const gravel = 0.91 + 0.09 * Math.sin(8.8 * x - 0.62 * z) * Math.cos(3.2 * x + 6.17 * z);
      colors.push(
        (0.24 - 0.094 * raised) * gravel,
        (0.19 + 0.022 * raised) * gravel,
        (0.115 - 0.043 * raised) * gravel,
        1,
      );
      if (i < columns && j < rows) {
        const a = i + j * (columns + 1);
        const b = a + columns + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  return meshData(positions, indices, colors);
}

function section(bed, heads) {
  const positions = [];
  const indices = [];
  const colors = [];
  const z = size[1] / 2 - 0.0004;
  const tones = [
    [0.07, 0.092, 0.09],
    [0.14, 0.21, 0.2],
    [0.25, 0.37, 0.33],
    [0.31, 0.27, 0.2],
    [0.34, 0.25, 0.16],
  ];
  // A nearest-row section of the model. The brighter seam is the actual accepted water table.
  const line = [
    { x: origin[0], head: heads[0] },
    ...heads.map((head, i) => ({ x: centre(i, sourceZ)[0], head })),
    { x: size[0] / 2, head: heads.at(-1) },
  ];
  for (const [i, { x, head }] of line.entries()) {
    const top = bed.sample(x, z).elevation;
    const seam = Math.min(head, top - 0.002);
    const bedrock = bottom + 0.24 + 0.05 * Math.sin(1.9 * x);
    const seamFloor = Math.max(bedrock, seam - 0.065);
    const layers = [bottom, bedrock, seamFloor, seam, 0.35 * seam + 0.65 * top, top];
    for (let j = 0; j < tones.length; j++) {
      const a = (i * tones.length + j) * 2;
      const t = 0.92 + 0.1 * Math.cos(5.5 * x + j * 2.7) * Math.sin(3.6 * x - j * 0.4);
      positions.push(x, layers[j], z, x, layers[j + 1], z);
      const tone = tones[j].map((value) => value * t);
      colors.push(...tone, 1, ...tone, 1);
      if (i === 0) continue;
      const b = a - tones.length * 2;
      indices.push(b, a, a + 1, b, a + 1, b + 1);
    }
  }
  return meshData(positions, indices, colors);
}

export async function mountSpringFilm() {
  const [active, sealed] = await Promise.all([makeTake(true), makeTake(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [3.25, 6.0, 11.85], target: [0, -0.12, 0.45], fov: 43, near: 0.1, far: 48 },
  });
  engine.scene.background = '#293b43';
  engine.lighting.direction.set([-0.45, 0.73, 0.46, 1.95]);
  engine.lighting.radiance.set([1, 0.94, 0.81, 1]);
  engine.lighting.ambient.set([0.43, 0.5, 0.52]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const { bed } = active.terrain;
  const material = new SurfaceMaterial({ vertexColors: true, roughness: 0.89 });
  const soil = createMesh(engine, relief(bed), material);
  const display = createMesh(engine, section(bed, accepted(active).front), material);
  const stone = new PbrMaterial({ color: '#475557', roughness: 0.84 });
  engine
    .createMesh()
    .setGeometry(box(34, 0.21, 31))
    .setMaterial(stone)
    .setPosition([0, bottom - 0.34, 0]);
  engine
    .createMesh()
    .setGeometry(box(size[0] + 0.18, 0.25, size[1] + 0.18))
    .setMaterial(stone)
    .setPosition([0, bottom - 0.125, 0]);
  const gauge = new PbrMaterial({ color: '#decaa2', roughness: 0.55 });
  const marker = toGeometry(cylinderGeometry(0.019, 0.019, 0.27, 12));
  const [sx, sz] = spring;
  const springHeight = bed.sample(sx, sz).elevation;
  engine
    .createMesh()
    .setGeometry(marker)
    .setMaterial(gauge)
    .setPosition([sx - 0.13, springHeight + 0.135, sz - 0.13]);
  const text = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (textValue, font, fontSize, position) =>
    text.add(new Text({ text: textValue, font, fontSize, position, color: '#ede1c9', billboard: true, onTop: true }));
  label('From aquifer to spring', title, 0.45, [-5.4, 3.9, -1.2]);
  label('Water table in blue · 2 min of groundwater flow per second', note, 0.25, [-5.38, 3.38, -1.2]);
  label('SPRING', note, 0.16, [sx - 0.75, springHeight + 0.49, sz]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.14 });

  const terrain = gpu.createTexture({
    size: [columns, rows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  gpu.queue.writeTexture({ texture: terrain }, Float32Array.from(active.surface), { bytesPerRow: 4 * columns }, [
    columns,
    rows,
  ]);
  const water = Water.attach(engine, {
    size,
    height: -2,
    segments: 96,
    color: [0.034, 0.2, 0.24],
    chop: 0,
    foamDistance: 0.015,
    whitecaps: 0,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 4 }],
    terrain: { heightmap: () => terrain, origin, size },
  });
  let current = active;
  let surface = active.hydro;
  const binding = ShallowWaterSurface.attach(engine, {
    surface: water,
    source: { shape: active.hydro.shape, sample: (x, z, out) => surface.sample(x, z, out) },
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
  await waitForPipelines(draw);
  return {
    cue,
    rate,
    checkpoint,
    end,
    secondsPerSecond,
    conductance,
    springElevation: active.springElevation[sourceIndex],
    // Maximum possible RHS: cell storage and implicit drain volume below the tallest actual land.
    flowError:
      conductance *
      secondsPerSecond *
      (Math.max(...active.surface) - bottom) *
      (relativeResidual * (1 + (conductance * secondsPerSecond) / (rate * dx * dx * specificYield)) +
        32 * Number.EPSILON),
    async sample({ editFrame, action, open = true, waterVisible = true, query = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      current = open ? active : sealed;
      const hash = seek(current, frame, action);
      const state = accepted(current);
      display.setGeometry(section(current.terrain.bed, state.front));
      surface = waterVisible ? current.hydro : sealed.hydro;
      water.resetTime();
      draw();
      draw();
      const renderedPond = query ? (await WaveQuery.capture(water)).heightAt(...pond) : null;
      const commands = gpu.createCommandEncoder();
      commands.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([commands.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      return { frame, hash, ...state, renderedPond, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      soil.destroy();
      display.destroy();
      binding.dispose();
      water.dispose();
      text.dispose();
      terrain.destroy();
      rgba.destroy();
      readback.destroy();
      for (const { aquifer } of [active, sealed]) aquifer[Symbol.dispose]?.();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

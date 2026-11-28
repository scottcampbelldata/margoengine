import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { BED_FIELD, TerrainBed } from '@margoengine/physics/earth';
import { SURFACE_WATER_FIELD, ShallowWaterSolver } from '@margoengine/physics/hydro';
import { StormVortex, VortexForcing } from '@margoengine/physics/vortices';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 22;
const checkpoint = 210;
const end = 300;
const timeScale = 3600;
const gravity = 9.80665;
const density = 1025;
const columns = 42;
const rows = 24;
const dx = 2000;
const cell = [-4, 2, 7];
const cellSize = 262144;
const dimensions = [columns * dx, rows * dx];
const half = dimensions.map((v) => v / 2);
const grid = { columns, rows, width: dimensions[0], depth: dimensions[1], centre: [0, 0] };
const stormTrack = {
  center: [-81000, -13500],
  translation: [5, 0],
  radius: 23000,
  shape: 1.45,
  pressureDrop: 7800,
  ambientPressure: 101000,
};
const points = (i, j) => [-half[0] + (i + 0.5) * dx, -half[1] + (j + 0.5) * dx];
const sites = [points(21, 15), points(23, 15), points(24, 15), points(25, 18), points(18, 12)];
const weatherGrid = Array.from({ length: 15 }, (_, i) => points(3 + (i % 5) * 4, 4 + Math.floor(i / 5) * 6));
const probes = [...sites, ...weatherGrid].map(([x, z]) => [x, 10, z]);

// SI hydrodynamics. The cutaway shows 2 km per horizontal metre, with ×320 vertical exaggeration.
const horizontalScale = 2000;
const verticalScale = 0.16;
const crop = -12;
const size = dimensions.map((v) => v / horizontalScale);
const origin = size.map((v) => -v / 2);
const inView = (elevation) => Math.max(crop, elevation) * verticalScale;

// An authored headland between two broad sandy bights, with a gently sloping shelf.
// NOAA MDL, “About Storm Surge”, https://vlab.noaa.gov/web/mdl/about-storm-surge
const coast = (z) => 1400 + 2700 * Math.sin(z / 11000) + 2100 * Math.exp(-(((z + 14500) / 6500) ** 2));
function elevation(x, z) {
  const u = x - coast(z);
  if (u < 0) return -Math.min(34, 1.6 * (-u / 1000) ** 0.82);
  return (
    0.00023 * u +
    0.62 * (1 - Math.exp(-u / 2600)) +
    3 * Math.exp(-(((u - 10000) / 6500) ** 2 + ((z + 8000) / 8000) ** 2))
  );
}

async function take(mode) {
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    cellSize,
    memory: worldMemory(false),
  });
  const terrain = new TerrainBed();
  world.add(terrain, { ...grid, elevations: elevation }, cell);
  const vortex = new StormVortex({ kind: 'cyclone', cell, ...stormTrack, latitude: 19.5, inflow: 18 });
  const hydro = new ShallowWaterSolver();
  const coupled = mode !== 'unforced';
  world.add(
    hydro,
    {
      bed: terrain.bed,
      level: 0,
      density,
      timeScale,
      roughness: 0.028,
      sides: { minX: { sea: (time) => (coupled ? vortex.inverseBarometer(-half[0], 0, time, density, gravity) : 0) } },
    },
    cell,
  );
  const weather = await VortexForcing.load({ id: 'shelf-cyclone', water: coupled, timeScale, threads: 1 });
  world.add(
    weather,
    {
      vortex,
      cellSize,
      probes,
      ...(coupled
        ? {
            water: {
              width: columns,
              depth: rows,
              spacing: [dx, dx],
              origin: points(0, 0),
              density,
              windStress: mode === 'wind',
            },
          }
        : {}),
    },
    cell,
  );
  if (coupled) world.couple([hydro.id, weather.id], 'staggered');
  return { world, terrain, hydro, weather, first: world.takeSnapshot(), frame: 0, records: new Map() };
}

function advance(take, frame, action) {
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
    throw new Error('Terrain, the accepted cyclone and water must replay byte for byte.');
  take.records.set(frame, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame, snapshot };
  return snapshot.hash;
}

function accepted(take) {
  const { world, hydro, weather } = take;
  const read = (field, length, type) => {
    const port = world.fields.port(field.name);
    if (
      port?.region.layout !== 1 ||
      port.region.type !== type ||
      port.region.byteLength !== length * (type === 'f32' ? 4 : 8) ||
      port.cell.some((v, i) => v !== cell[i])
    )
      throw new Error('Read the surveyed terrain, weather and water in their shared signed cell.');
    return regionWords(world.memory, port.region);
  };
  read(BED_FIELD, (columns + 1) * (rows + 1), 'f32');
  const water = read(SURFACE_WATER_FIELD, columns * rows * 3, 'f32');
  const field = read(weather.probeField, probes.length * 6, 'f64');
  const air = probes.map((_, i) => {
    const sample = weather.weather(i);
    const row = [...sample.velocity, sample.density, sample.temperature, sample.pressure];
    if (row.some((v, j) => v !== field[i * 6 + j])) throw new Error('Draw the registered wind and pressure readings.');
    return row;
  });
  let footprint = 0;
  const tolerance = 0.005; // Count cells at least 5 mm deep as part of the wet footprint.
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const [x, z] = points(i, j);
      const sample = hydro.sample(x, z);
      const k = (i + j * columns) * 3;
      if (Math.fround(sample.depth) !== water[k]) throw new Error('Render the registered shallow-water grid.');
      if (sample.depth >= tolerance) footprint++;
    }
  return {
    air,
    levels: sites.map(([x, z]) => hydro.sample(x, z)),
    footprint,
    budget: hydro.budget,
    volume: hydro.volume(),
  };
}

function data(positions, indices, colors, baseNormal = [0, 1, 0]) {
  const normals = Float32Array.from(positions, (_, i) => baseNormal[i % 3]);
  const mesh = geometryData(positions, normals, new Float32Array((positions.length / 3) * 2), indices);
  mesh.colors = Float32Array.from(colors);
  return computeVertexNormals(mesh);
}

function coastalRelief(bed) {
  const positions = [];
  const indices = [];
  const colors = [];
  const subsample = 3;
  const nx = columns * subsample;
  const nz = rows * subsample;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = -half[0] + (i * dx) / subsample;
      const z = -half[1] + (j * dx) / subsample;
      const y = bed.sample(x, z).elevation;
      positions.push(x / horizontalScale, inView(y), z / horizontalScale);
      const sand = 0.18 + 0.55 * Math.exp(-((y - 1) ** 2) / 17);
      const dune = Math.min(1, Math.max(0, (y - 2) / 4.8));
      const coarse = 0.91 + 0.085 * Math.sin(x / 1639 + z / 650) * Math.cos(x / 1401 - z / 763);
      colors.push(
        (0.16 + 0.22 * sand - 0.12 * dune) * coarse,
        (0.17 + 0.105 * sand) * coarse,
        (0.109 + 0.047 * sand - 0.021 * dune) * coarse,
        1,
      );
      if (i < nx && j < nz) {
        const a = i + j * (nx + 1);
        const b = a + nx + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  return data(positions, indices, colors);
}

function frontCut(bed, hydro) {
  const positions = [];
  const indices = [];
  const colors = [];
  const z = half[1];
  const count = 3 * columns;
  for (let i = 0; i <= count; i++) {
    const x = -half[0] + (i * dimensions[0]) / count;
    const sample = hydro.sample(x, z - dx / 2);
    const top = inView(bed.sample(x, z).elevation);
    const mid = Math.min(top, (crop + 3 + 0.4 * Math.sin(x / 14000)) * verticalScale);
    const surface = sample.depth > 0 ? Math.max(top, inView(sample.surface)) : top;
    const segments = [
      [crop * verticalScale, mid, [0.11, 0.102, 0.084]],
      [mid, top, [0.23, 0.17, 0.101]],
      [top, surface, [0.045, 0.19, 0.24]],
    ];
    for (const [layer, [low, high, tone]] of segments.entries()) {
      const a = i * segments.length * 2 + layer * 2;
      const density = 0.93 + 0.063 * Math.sin(x / 731 + layer * 3);
      positions.push(x / horizontalScale, low, z / horizontalScale, x / horizontalScale, high, z / horizontalScale);
      colors.push(...tone.map((v) => v * density), 1, ...tone.map((v) => v * density), 1);
      if (i === 0) continue;
      const left = a - segments.length * 2;
      indices.push(left, a, a + 1, left, a + 1, left + 1);
    }
  }
  return data(positions, indices, colors, [0, 0, 1]);
}

function windArrows(reports) {
  const positions = [];
  const indices = [];
  const colors = [];
  for (const [i, [x, z]] of weatherGrid.entries()) {
    const [u, , v, , , press] = reports[i + sites.length];
    const speed = Math.hypot(u, v);
    if (speed === 0) continue;
    const [px, pz] = [x / horizontalScale, z / horizontalScale];
    const ux = u / speed;
    const uz = v / speed;
    const arrowLength = speed / 31;
    const head = Math.min(0.36, 0.29 * arrowLength);
    const y = 1.65;
    const line = [
      [-0.39 * arrowLength, -0.035],
      [-0.39 * arrowLength, 0.035],
      [arrowLength - head, -0.035],
      [arrowLength - head, 0.035],
      [arrowLength - head, -0.17],
      [arrowLength - head, 0.17],
      [arrowLength, 0],
    ];
    const first = positions.length / 3;
    for (const [forward, sideways] of line) {
      positions.push(px + ux * forward - uz * sideways, y, pz + uz * forward + ux * sideways);
      const deficit = (stormTrack.ambientPressure - press) / stormTrack.pressureDrop;
      colors.push(0.34 + 0.29 * deficit, 0.54 + 0.21 * deficit, 0.59 + 0.15 * deficit, 1);
    }
    for (const id of [0, 1, 2, 2, 1, 3, 4, 5, 6]) indices.push(first + id);
  }
  return data(positions, indices, colors);
}

export async function mountCycloneFilm() {
  const [wind, pressure, unforced] = await Promise.all([take('wind'), take('pressure'), take('unforced')]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [16.4, 25.0, 38.0], target: [0, 0.35, 0.0], fov: 42, near: 0.3, far: 140 },
  });
  engine.scene.background = '#263640';
  engine.lighting.direction.set([-0.52, 0.77, 0.37, 1.8]);
  engine.lighting.radiance.set([1, 0.93, 0.79, 1]);
  engine.lighting.ambient.set([0.4, 0.52, 0.63]);
  const rock = new PbrMaterial({ color: '#3f5759', roughness: 0.89 });
  const material = new SurfaceMaterial({ vertexColors: true, roughness: 0.86 });
  const { bed } = wind.terrain;
  const relief = createMesh(engine, coastalRelief(bed), material);
  const cut = createMesh(engine, frontCut(bed, wind.hydro), material);
  let arrows;
  engine
    .createMesh()
    .setGeometry(box(100, 0.5, 90))
    .setMaterial(rock)
    .setPosition([0, crop * verticalScale - 0.71, 0]);
  engine
    .createMesh()
    .setGeometry(box(size[0] + 0.23, 0.4, size[1] + 0.24))
    .setMaterial(rock)
    .setPosition([0, crop * verticalScale - 0.2, 0]);

  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, font, fontSize, position) =>
    labels.add(new Text({ text, font, fontSize, position, color: '#f1e6ce', billboard: true, onTop: true }));
  label('A cyclone approaches the shelf', title, 1.22, [-25.3, 11.0, -5.2]);
  label('Wind at 10 m · 1 hour per second · vertical scale ×320', note, 0.61, [-25.3, 9.42, -5.2]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.18 });

  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const texture = gpu.createTexture({
    size: [columns, rows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const heights = Float32Array.from({ length: columns * rows }, (_, k) => {
    const [x, z] = points(k % columns, Math.floor(k / columns));
    return inView(bed.sample(x, z).elevation);
  });
  gpu.queue.writeTexture({ texture }, heights, { bytesPerRow: columns * 4 }, [columns, rows]);
  const water = Water.attach(engine, {
    size,
    segments: 192,
    height: -2.3,
    color: [0.034, 0.137, 0.194],
    chop: 0,
    whitecaps: 0,
    foamDistance: 0.018,
    waves: [{ amplitude: 0, wavelength: 6, direction: [1, 0] }],
    terrain: { heightmap: () => texture, origin, size },
  });
  let current = wind;
  const mirror = ShallowWaterSurface.attach(engine, {
    surface: water,
    source: {
      shape: { ...grid, width: size[0], depth: size[1] },
      sample(x, z, out) {
        const sample = current.hydro.sample(x * horizontalScale, z * horizontalScale, out);
        const bottom = inView(sample.surface - sample.depth);
        sample.surface = inView(sample.surface);
        sample.depth = sample.surface - bottom;
        sample.velocity[0] *= timeScale / horizontalScale;
        sample.velocity[1] *= timeScale / horizontalScale;
        return sample;
      },
    },
  });
  const rgba = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const staging = gpu.createBuffer({
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
    timeScale,
    verticalScale,
    stormTrack,
    probes,
    async sample({ editFrame, action, mode = 'wind', query = false }) {
      current = { wind, pressure, unforced }[mode];
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hash = advance(current, frame, action);
      const state = accepted(current);
      cut.setGeometry(frontCut(current.terrain.bed, current.hydro));
      const airGeometry = windArrows(state.air);
      if (airGeometry.indices.length > 0) {
        if (arrows) arrows.setGeometry(airGeometry);
        else arrows = createMesh(engine, airGeometry, material);
        arrows.root.visible = true;
      } else if (arrows) arrows.root.visible = false;
      water.resetTime();
      draw();
      draw();
      // This inland survey point is an exact vertex of the 192-segment surface.
      const waterline = query
        ? (await WaveQuery.capture(water)).heightAt(...sites[2].map((v) => v / horizontalScale))
        : null;
      const command = gpu.createCommandEncoder();
      command.copyTextureToBuffer({ texture: rgba }, { buffer: staging, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([command.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const rgba8 = new Uint8ClampedArray(staging.getMappedRange()).slice();
      staging.unmap();
      pixels.putImageData(new ImageData(rgba8, width, height), 0, 0);
      return { frame, hash, ...state, waterline, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      relief.destroy();
      cut.destroy();
      arrows?.destroy();
      mirror.dispose();
      water.dispose();
      texture.destroy();
      labels.dispose();
      rgba.destroy();
      staging.destroy();
      for (const { weather } of [wind, pressure, unforced]) weather[Symbol.dispose]?.();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

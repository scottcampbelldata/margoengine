import { PlantGrowth } from '@margoengine/biomes/growth';
import { EngineKernel, Geometry, PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { RainfallRunoff } from '@margoengine/physics/runoff';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { tubes } from '@margoengine/procedural/lsystem';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const checkpoint = 240;
const end = 480;
const seed = 50728;
const cell = [-8, 3, 5];
const dx = 0.85;
const dz = 0.65;
const soilY = 0.12;
const centres = [-dx / 2, dx / 2];
const origin = [-dx, -dz / 2];
const capacity = 0.012;
const saturation = 0.34;
const irrigation = 0.008;
const wilting = 0.0016;
const full = 0.01;
const dryWood = '#77614b';
const colours = { dry: [109, 86, 63], wet: [64, 46, 36] };
const seasonTime = rate;
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const empty = new Geometry([], [], []);

// Pałubicki et al. (2009) motivates the local light and branch development model,
// https://doi.org/10.1145/1531326.1531364. This generic nursery plant uses authored traits.
const species = {
  productiveSeasons: 8,
  seasonalExtension: 0.43,
  minimumExtension: 0.013,
  internodeLength: 0.22,
  tipRadius: 0.003,
  apicalWeight: 0.65,
  branchingAngle: Math.PI * 0.24,
  phototropism: 0.15,
  gravitropism: 0.1,
  leafShadow: 0.08,
};

async function establish() {
  const runoff = await RainfallRunoff.load();
  const growth = await PlantGrowth.load({
    soil: { field: runoff.soilWaterField, origin, dimensions: [2, 1], size: [dx, dz], wilting, full },
  });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, memory: worldMemory(false), cellSize: 64 });
  // Initial ponding is the already-metered irrigation pulse. HYDRO-02 integrates its subsequent
  // infiltration and overflow, based on Green and Ampt (1911), https://doi.org/10.1017/S0021859600001441.
  world.add(
    runoff,
    {
      nx: 2,
      nz: 1,
      dx,
      dz,
      origin,
      downstream: [-1, -1],
      elevation: [soilY, soilY],
      soilCapacity: capacity,
      initialSaturation: saturation,
      initialDepth: [irrigation, 0],
      conductivity: 0.001,
      suctionHead: 0.06,
      wettingDeficit: 0.34,
      drainage: 0,
      slope: 0.001,
      width: 0.025,
    },
    cell,
  );
  world.add(
    growth,
    {
      plants: centres.map((x) => ({ position: [x, soilY, 0], species, azimuth: 0.2 })),
      voxels: { origin: [-1.25, -0.2, -0.5], dimensions: [20, 16, 8], size: 0.125, shadowDepth: 3 },
      ticksPerSeason: seasonTime,
    },
    cell,
  );
  const first = { frame: 0, snapshot: world.takeSnapshot() };
  return { world, runoff, growth, frame: 0, saved: new Map([[0, first]]), visited: new Map() };
}

function seek(plot, goal, action) {
  if (action === 'restore' || goal < plot.frame) {
    const point = plot.saved.get(action === 'restore' ? goal : 0);
    plot.world.restoreSnapshot(point.snapshot.bytes);
    plot.frame = point.frame;
  }
  if (goal > plot.frame) {
    plot.world.advance(goal);
    plot.frame = goal;
  }
  const snapshot = plot.world.takeSnapshot();
  const prior = plot.visited.get(goal);
  if (
    prior &&
    (snapshot.bytes.length !== prior.length || prior.some((byte, offset) => snapshot.bytes[offset] !== byte))
  )
    throw new Error('Restore the same accepted root-water and branch bytes at the saved seasonal edit.');
  plot.visited.set(goal, snapshot.bytes);
  if (action === 'save') plot.saved.set(goal, { frame: goal, snapshot });
  return snapshot.hash;
}

function recap(nodes) {
  const plots = centres.map(() => ({ count: 0, height: 0, length: 0, branchesPerSeason: Array(8).fill(0) }));
  for (const node of nodes) {
    const plot = plots[node.plant];
    plot.count++;
    plot.height = Math.max(plot.height, node.end[1] - soilY);
    plot.length += Math.hypot(...node.end.map((value, axis) => value - node.start[axis]));
    plot.branchesPerSeason[node.birthSeason - 1]++;
  }
  return plots;
}

function leafForm(nodes, season, young) {
  const positions = [],
    uvs = [],
    indices = [];
  const counters = [0, 0];
  // A curved, elliptical blade with one raised ridge. All petioles start on accepted internodes.
  const margin = [
    [0, 0],
    [0.19, 0.132],
    [0.43, 0.224],
    [0.69, 0.164],
    [0.88, 0.084],
    [1, 0],
    [0.85, -0.081],
    [0.66, -0.164],
    [0.39, -0.215],
    [0.16, -0.113],
  ];
  const outline = [...margin, [0.43, 0]];
  for (const node of nodes) {
    const id = counters[node.plant]++;
    if (season - node.birthSeason < 2 !== young) continue;
    const length = Math.hypot(...node.end.map((value, axis) => value - node.start[axis]));
    if (length < 0.021) continue;
    const blade = Math.min(0.124, 0.041 + length * 0.57) / (1 + 0.09 * node.order);
    for (let leaf = 0; leaf < 3; leaf++) {
      const t = 0.43 + leaf * 0.235;
      const azimuth = (id + leaf * 0.65) * goldenAngle;
      const cx = Math.cos(azimuth);
      const cz = Math.sin(azimuth);
      const rise = 0.19 + 0.31 * Math.cos(azimuth * 2.3);
      const station = node.start.map((value, axis) => value + t * (node.end[axis] - value));
      const first = positions.length / 3;
      const ridge = first + margin.length;
      for (const [i, [along, wide]] of outline.entries()) {
        const arc = rise * along - 0.31 * along * along + (i === margin.length ? 0.055 : 0);
        positions.push(
          station[0] + (cx * along - cz * wide) * blade,
          station[1] + arc * blade,
          station[2] + (cz * along + cx * wide) * blade,
        );
        uvs.push(along, wide + 0.5);
      }
      for (let k = 0; k < margin.length; k++) indices.push(first + k, ridge, first + ((k + 1) % margin.length));
    }
  }
  if (!indices.length) return empty;
  return toGeometry(computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices)));
}

function soilColor(storage) {
  const shade = Math.min(1, storage / capacity);
  return (
    '#' +
    colours.dry
      .map((value, i) =>
        Math.round(value + (colours.wet[i] - value) * shade)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function planters(engine) {
  const larch = new PbrMaterial({ color: dryWood, roughness: 0.68 });
  const remilled = new PbrMaterial({ color: '#927651', roughness: 0.63 });
  const face = new PbrMaterial({ color: '#5a4b3c', roughness: 0.78 });
  const substrate = new PbrMaterial({ color: '#6a6050', roughness: 0.93 });
  const distant = new PbrMaterial({ color: '#667671', roughness: 0.78 });
  const marks = new PbrMaterial({ color: '#d2b781', roughness: 0.68 });
  const ponding = new PbrMaterial({ color: '#4c6255', roughness: 0.22 });
  const wood = new PbrMaterial({ color: '#6e543a', roughness: 0.75 });
  const shade = new PbrMaterial({ color: '#4f772f', roughness: 0.67 });
  const leafTips = new PbrMaterial({ color: '#789946', roughness: 0.57 });
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const rounded = (size, corner, material, position) =>
    part(toGeometry(roundedBoxGeometry(...size, 2, corner)), material, position);
  part(box(15, 0.1, 12), substrate, [0, -0.155, -3.9]);
  rounded([1.87, 0.13, 0.82], 0.021, face, [0, -0.031, 0]);
  for (const x of [-dx - 0.012, 0, dx + 0.012]) {
    rounded([0.03, 0.16, dz + 0.061], 0.007, larch, [x, 0.064, 0]);
    rounded([0.044, 0.016, dz + 0.065], 0.005, remilled, [x, 0.143, 0]);
  }
  for (const z of [-dz / 2 - 0.012, dz / 2 + 0.012]) {
    rounded([1.75, 0.145, 0.031], 0.006, larch, [0, 0.068, z]);
    rounded([1.79, 0.014, 0.042], 0.004, remilled, [0, 0.145, z]);
  }
  // Greenhouse framing stays subdued behind the planting and the twin height sticks.
  for (const x of [-1.55, -0.52, 0.52, 1.55]) rounded([0.028, 2.4, 0.03], 0.004, distant, [x, 1.08, -1.8]);
  rounded([3.6, 0.031, 0.043], 0.004, distant, [0, 0.46, -1.8]);
  const soils = [];
  for (const centre of centres) {
    const soil = new PbrMaterial({ color: soilColor(capacity * saturation), roughness: 0.91 });
    part(box(dx - 0.018, 0.045, dz), soil, [centre, soilY - 0.0225, 0]);
    soils.push(soil);
    const rulerX = centre + 0.293;
    rounded([0.022, 1.02, 0.022], 0.004, face, [rulerX, soilY + 0.509, -0.197]);
    for (let k = 1; k <= 5; k++) part(box(0.032, 0.006, 0.007), marks, [rulerX - 0.01, soilY + k * 0.2, -0.184]);
  }
  const above = part(box(dx - 0.022, 0.003, dz - 0.004), ponding, [centres[0], soilY, 0]);
  return {
    soils,
    above,
    stems: part(empty, wood, [0, 0, 0]),
    oldLeaves: part(empty, shade, [0, 0, 0]),
    youngLeaves: part(empty, leafTips, [0, 0, 0]),
  };
}

export async function mountGrowthFilm() {
  const plot = await establish();
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0.16, 1.38, 2.42], target: [0.01, 0.59, 0], fov: 37, near: 0.05, far: 20 },
  });
  engine.scene.background = '#788a80';
  engine.lighting.direction.set([-0.46, 0.79, 0.43, 1.53]);
  engine.lighting.radiance.set([1, 0.94, 0.82, 1]);
  engine.lighting.ambient.set([0.45, 0.59, 0.65]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const drawables = planters(engine);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize) =>
    labels.add(new Text({ text, position, font, fontSize, color: '#f4e9d5', billboard: true, onTop: true }));
  label('Irrigation changes crown growth', [-0.75, 1.35, -0.19], title, 0.105);
  label('Matched seedlings · one modeled season per second', [-0.74, 1.247, -0.19], notes, 0.05);
  label('8 mm irrigation pulse', [-0.783, -0.025, 0.385], notes, 0.05);
  label('Unwatered control', [0.14, -0.025, 0.385], notes, 0.05);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.18 });
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
  await waitForPipelines(draw);
  return {
    cue,
    before: 30,
    seasonTime,
    checkpoint,
    end,
    seed,
    cell,
    area: dx * dz,
    capacity,
    saturation,
    irrigation,
    wilting,
    full,
    species,
    async sample({ editFrame, action, showGrowth = true, showWater = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hash = seek(plot, frame, action);
      const rows = plot.growth.internodes();
      const graph = plot.growth.toBranches();
      const season = plot.growth.season;
      const branchPort = plot.world.fields.port(plot.growth.branchesField.name);
      const soilPort = plot.world.fields.port(plot.runoff.soilWaterField.name);
      const branchHead = regionWords(plot.world.memory, branchPort.region).slice(0, 2);
      const publishedWater = regionWords(plot.world.memory, soilPort.region);
      const soils = centres.map((_, i) => plot.runoff.read(i, 0));
      const lengths = graph.radii.length;
      for (const [i, row] of rows.entries()) {
        const points = [...row.start, ...row.end];
        if (points.some((point, axis) => Math.fround(point) !== graph.positions[i * 6 + axis]))
          throw new Error('Meshing consumes the accepted internode endpoints, in port order.');
      }
      const stems = lengths ? tubes(graph, { radialSegments: 8, tipScale: 0.67 }) : empty;
      drawables.stems.setGeometry(showGrowth ? stems : empty);
      drawables.oldLeaves.setGeometry(showGrowth ? leafForm(rows, season, false) : empty);
      drawables.youngLeaves.setGeometry(showGrowth ? leafForm(rows, season, true) : empty);
      for (const [i, soil] of drawables.soils.entries())
        soil.set({ color: soilColor(showWater ? soils[i].soilWater : capacity * saturation) });
      const pond = soils[0].depth;
      drawables.above.setPosition([centres[0], showWater && pond >= 0.0002 ? soilY + pond - 0.0015 : -1, 0]);
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const color = new Uint8ClampedArray(output.getMappedRange()).slice();
      output.unmap();
      pixels.putImageData(new ImageData(color, width, height), 0, 0);
      return {
        frame,
        hash,
        season,
        soils,
        head: Array.from(branchHead),
        branchCell: branchPort.cell,
        soilCell: soilPort.cell,
        scion: recap(rows),
        publishedWater: Array.from(publishedWater),
        budget: plot.runoff.budget,
        triangles: stems.indices.length / 3,
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      plot.growth[Symbol.dispose]?.();
      plot.runoff[Symbol.dispose]?.();
      return { errors, validation };
    },
  };
}

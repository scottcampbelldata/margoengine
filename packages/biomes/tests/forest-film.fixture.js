import { ForestEcosystemSolver, forestOrientation } from '@margoengine/biomes/forest';
import { EngineKernel, Geometry, PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Noise, generateGrassMesh, generateRockMesh } from '@margoengine/procedural';
import { generateConiferMesh } from '@margoengine/procedural/conifers';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const yearTicks = 60;
const windYears = 3;
const windStop = yearTicks * windYears;
const end = yearTicks * (windYears + 1);
const seed = 93315;
const cell = [-11, 2, 7];
const halfCount = 3;
const bounds = [-14, -7, 14, 7];
const groupOffset = 12.5;
const windSpeed = 18;
const windReferenceSpeed = 12;
const maxGrowthLean = 0.5;
const windHeight = 6.5;
const young = [
  [-9.75, -3.2, 1.2, 12],
  [-6.3, 1.35, 1.06, 14],
  [-2.75, -2.35, 1.33, 13],
];
// Pacala et al. (1996) motivates stand-level resource competition; Brüchert & Gardiner (2006)
// motivates long-duration wind exposure affecting tree form. These illustrative coefficients and the
// Douglas-fir renderer proxy are authored; the Sitka spruce study does not calibrate a tilt angle.
// https://doi.org/10.2307/2963479 and https://doi.org/10.3732/ajb.93.10.1512
const species = {
  id: 'douglas-fir',
  radius: 2.8,
  growth: 0.67,
  age: 2500,
  seeds: 0,
  shade: 0.45,
  rootCohesion: 1100,
  canopyFuel: 2.6,
};
const founders = [0, groupOffset].flatMap((offset) =>
  young.map(([x, z, radius, age]) => ({ species: species.id, x: x + offset, z, radius, age })),
);
const ambientWind = {
  medium: 'air',
  cell,
  sample(x, _y, _z, time, out) {
    out.velocity[0] = x < 0 && time < windStop / rate ? windSpeed : 0;
    out.velocity[1] = 0;
    out.velocity[2] = 0;
    out.density = 1.225;
    out.temperature = 282;
    return out;
  },
};

async function establish() {
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, memory: worldMemory(false), cellSize: 64 });
  world.add(
    forest,
    {
      plants: founders,
      species: [species],
      bounds,
      cells: [2, 1],
      wind: ambientWind,
      limit: 32,
      ticksPerYear: yearTicks,
      windHeight,
      windReferenceSpeed,
      maxGrowthLean,
      cell,
    },
    cell,
  );
  return {
    world,
    forest,
    frame: 0,
    saved: new Map([[0, { frame: 0, snapshot: world.takeSnapshot() }]]),
    visited: new Map(),
  };
}

function seek(scene, goal, action) {
  if (action === 'restore' || goal < scene.frame) {
    const saved = scene.saved.get(action === 'restore' ? goal : 0);
    scene.world.restoreSnapshot(saved.snapshot.bytes);
    scene.frame = saved.frame;
  }
  if (goal > scene.frame) {
    scene.world.advance(goal);
    scene.frame = goal;
  }
  const snapshot = scene.world.takeSnapshot();
  const previous = scene.visited.get(goal);
  if (previous && (previous.length !== snapshot.bytes.length || previous.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error(
      'Restore complete forest population, accepted annual wind accumulators, and output fields at the edit frame.',
    );
  scene.visited.set(goal, snapshot.bytes);
  if (action === 'save') scene.saved.set(goal, { frame: goal, snapshot });
  return snapshot.hash;
}

const groundNoise = new Noise(seed);
function elevation(x, z) {
  const ramp = 1.72 * Math.exp(-(((x + 7.5) / 7.5) ** 2 + ((z + 3.4) / 12) ** 2));
  const valley = -0.62 * Math.exp(-(((x - 7.4) / 9) ** 2 + ((z + 3.4) / 16) ** 2));
  const ridge = (2.5 + 1.25 * Math.sin(x * 0.22)) * Math.exp(-(((z + 33) / 11) ** 2));
  return ramp + valley + ridge + 0.46 * groundNoise.simplex(x * 0.109, 0, z * 0.109);
}

function slope() {
  const columns = 104;
  const rows = 96;
  const positions = [],
    uvs = [],
    indices = [],
    colors = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const x = -53 + i * (106 / columns);
      const z = -65 + j * (88 / rows);
      positions.push(x, elevation(x, z), z);
      uvs.push(i / columns, j / rows);
      const stone = Math.max(0, groundNoise.simplex(x * 0.24, 11, z * 0.24) + 0.34 * Math.sin(0.7 * x + 0.54 * z));
      const heather = Math.max(0, groundNoise.simplex(x * 0.16, 3, z * 0.19));
      const grain = groundNoise.simplex(x * 0.72, 8, z * 0.72);
      const mist = Math.max(0, (Math.min(60, -z) - 17) / 64);
      colors.push(
        0.128 + 0.082 * stone + 0.074 * heather + 0.021 * grain + 0.11 * mist,
        0.173 + 0.045 * stone + 0.017 * heather + 0.019 * grain + 0.135 * mist,
        0.098 + 0.058 * stone + 0.017 * heather + 0.014 * grain + 0.19 * mist,
        1,
      );
      if (i < columns && j < rows) {
        const a = j * (columns + 1) + i;
        const b = a + columns + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const data = geometryData(positions, new Float32Array(positions.length), uvs, indices);
  data.colors = Float32Array.from(colors);
  return computeVertexNormals(data);
}

const rootY = ({ x, z }) => elevation(x, z) - 0.036;
const identity = [0, 0, 0, 1];

function standView(engine) {
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  createMesh(engine, slope(), new SurfaceMaterial({ vertexColors: true, roughness: 0.92 }));
  const reeds = new PbrMaterial({ color: '#8a8453', roughness: 0.85 });
  const grass = toGeometry(generateGrassMesh(7));
  const gust = new PbrMaterial({ color: '#dcae72', roughness: 0.51 });
  const rock = new PbrMaterial({ color: '#817e6e', roughness: 0.79 });
  const random = new RandomStream(seed, solverNumber('forest-film-ground'));
  for (let i = 0; i < 180; i++) {
    const [x, z] = random.unitF64(0, i).map((v, axis) => (axis === 0 ? -16 + 32 * v : -9 + 18 * v));
    const [t, u] = random.unitF64(0, i, 1);
    const growth = 0.46 + t * 0.66;
    part(grass, reeds, [x, elevation(x, z) - 0.015, z])
      .setRotation([0, u * 2 * Math.PI, 0])
      .setScale([1.6, growth, 1.6]);
  }
  for (const [i, [x, z, scale]] of [
    [-12.3, 4.5, 1.35],
    [-9.7, 5.5, 0.66],
    [10.5, 3.6, 1.8],
    [11.3, 1.6, 0.85],
    [0.4, 4.6, 0.55],
    [-0.6, -11.2, 2.3],
  ].entries())
    part(toGeometry(generateRockMesh(seed + i, 'slab', { detail: 1 })), rock, [x, elevation(x, z), z]).setScale([
      scale,
      scale,
      scale,
    ]);
  const windMarker = part(box(1.8, 0.036, 0.073), gust, [0, 0, 0]);
  const tip = new Geometry([0, 0, -0.26, 0.54, 0, 0, 0, 0, 0.26], [0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 2, 1]);
  const arrowTip = part(tip, gust, [0, 0, 0]);
  const parts = [];
  const bark = new PbrMaterial({ color: '#6a5145', roughness: 0.78 });
  const needles = ['#3d613a', '#315743', '#416246'].map((color) => new PbrMaterial({ color, roughness: 0.73 }));
  const families = new Map();
  function shape(tree, slot) {
    const family = slot % halfCount;
    const key = tree.age * halfCount + family;
    let entry = families.get(key);
    if (!entry) {
      const geometry = generateConiferMesh(species.id, { age: tree.age, detail: 2, seed: seed + 11 * family });
      entry = { trunk: toGeometry(geometry.trunk), canopy: toGeometry(geometry.canopy), form: geometry.form };
      families.set(key, entry);
    }
    return entry;
  }
  for (const [i, init] of founders.entries()) {
    const { trunk, canopy } = shape(init, i);
    parts.push({
      trunk: part(trunk, bark, [init.x, rootY(init), init.z]),
      canopy: part(canopy, needles[i % halfCount], [init.x, rootY(init), init.z]),
    });
  }
  return {
    drawTrees(trees, renderUpright) {
      return trees.map((tree, index) => {
        const { trunk, canopy, form } = shape(tree, index);
        const radial = (2 * tree.radius) / form.crownWidth;
        const physical = forestOrientation(tree);
        const q = renderUpright ? identity : physical;
        const position = [tree.x, rootY(tree), tree.z];
        parts[index].trunk.setGeometry(trunk).setPosition(position).setQuaternion(q).setScale([radial, 1, radial]);
        parts[index].canopy.setGeometry(canopy).setPosition(position).setQuaternion(q).setScale([radial, 1, radial]);
        const [qx, qy, qz, qw] = physical;
        const axis = [2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw)];
        return {
          ...tree,
          height: form.height,
          crownRadius: (form.crownWidth * radial) / 2,
          axis,
          tip: axis.map((v) => v * form.height),
        };
      });
    },
    drawWind(velocity) {
      const x = -7.7;
      const z = 5.28;
      const scale = velocity / windSpeed;
      const y = elevation(x, z) + 0.46;
      windMarker.visible = arrowTip.visible = velocity !== 0;
      windMarker.setPosition([x - 0.9 * scale, y, z]).setScale([Math.max(scale, 0.001), 1, 1]);
      arrowTip.setPosition([x, y, z]);
    },
  };
}

export async function mountForestFilm() {
  const plot = await establish();
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [1.4, 10.1, 25.8], target: [0.25, 4.7, -1], fov: 37, near: 0.15, far: 125 },
  });
  engine.scene.background = '#b3c7cb';
  engine.lighting.direction.set([-0.48, 0.74, 0.44, 1.5]);
  engine.lighting.radiance.set([1, 0.92, 0.77, 1]);
  engine.lighting.ambient.set([0.51, 0.63, 0.74]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const view = standView(engine);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    labels.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('The wind stops. The lean remains.', [-11.8, 12.05, -5], title, 1.24, '#263c3d');
  label('Douglas-fir proxies · one modeled year per second', [-11.8, 10.55, -5], notes, 0.59, '#304748');
  label('Exposed cohort', [-10.8, 0.43, 6.62], title, 0.55, '#f4e9d5');
  label('Sheltered control', [3.8, 0.43, 6.62], title, 0.55, '#f4e9d5');
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.05 });
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
  const patches = [plot.forest.coverField, plot.forest.rootCohesionField, plot.forest.fuelField];
  const surfaceArea = ((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) / 2;
  await waitForPipelines(draw);
  return {
    cue,
    rate,
    yearTicks,
    windStop,
    windYears,
    end,
    halfCount,
    seed,
    cell,
    groupOffset,
    windSpeed,
    windReferenceSpeed,
    maxGrowthLean,
    surfaceArea,
    rootCohesion: species.rootCohesion,
    canopyFuel: species.canopyFuel,
    async sample({ editFrame, action, renderUpright = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hash = seek(plot, frame, action);
      const trees = view.drawTrees(plot.forest.trees(), renderUpright);
      const sampleWind = (x) =>
        ambientWind.sample(x, windHeight, 0, frame / rate, { velocity: [0, 0, 0], density: 1.225, temperature: 282 })
          .velocity;
      const winds = [-7, 7].map(sampleWind);
      view.drawWind(winds[0][0]);
      const ports = patches.map((field) => {
        const port = plot.world.fields.port(field.name);
        return { cell: port.cell, data: Array.from(regionWords(plot.world.memory, port.region)) };
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
      return {
        frame,
        hash,
        trees,
        winds,
        ports,
        annual: plot.forest.year,
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      plot.forest[Symbol.dispose]?.();
      return { errors, validation };
    },
  };
}

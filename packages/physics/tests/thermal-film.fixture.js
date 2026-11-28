import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { Texture } from '@margoengine/materials/texture';
import { HeatConduction, Thermoelasticity } from '@margoengine/physics/thermal';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { lavaGlow } from '@margoengine/weather/lava';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const checkpoint = 540;
const end = 1440;
const seed = 58391;
const cell = [-6, 3, 9];
const dimensions = [10, 4, 2];
const size = [0.036, 0.005, 0.036];
const [nx, ny, nz] = dimensions;
const cells = nx * ny * nz;
const nodes = (nx + 1) * (ny + 1) * (nz + 1);
const extent = dimensions.map((v, i) => v * size[i]);
const reference = 1350;
const ambient = 293.15;
const emissivity = 0.85;
const stefan = 5.670374419e-8;
const radianceWhite = 4700;
const exaggeration = 15;
const couponOffset = [-0.165, 0.1];
const lanes = [0.074, -0.071];

// Constant high-temperature mullite approximations for this technical specimen:
// Hildmann and Schneider (2005), https://doi.org/10.1111/j.1551-2916.2005.00530.x;
// NIST-JANAF, https://webbook.nist.gov/cgi/cbook.cgi?ID=C1302938&Table=on&Type=JANAFS;
// BSEE, Typical Properties of Ceramic Substrate Materials, Table 5.2, https://www.bsee.gov/sites/bsee.gov/files/tap-technical-assessment-program/138aa.pdf
const material = { conductivity: 3.35, heatCapacity: 3.22e6 };
const solidMaterial = {
  youngModulus: 145e9,
  poissonRatio: 0.24,
  expansionCoefficient: 4.5e-6,
  referenceTemperature: reference,
};
const restraints = Array.from({ length: (ny + 1) * (nz + 1) }, (_, i) => ({
  node: [0, i % (ny + 1), Math.floor(i / (ny + 1))],
  displacement: [0, 0, 0],
}));
const cellIndex = ([x, y, z]) => x + nx * (y + ny * z);
const pointIndex = ([x, y, z]) => x + (nx + 1) * (y + (ny + 1) * z);
const faceLayout = [
  [0, false, 1, 2],
  [0, true, 1, 2],
  [1, false, 0, 2],
  [1, true, 0, 2],
  [2, false, 0, 1],
  [2, true, 0, 1],
];
let row = 0;
const atlasWidth = Math.max(...dimensions) + 2;
const faces = faceLayout.map(([axis, high, u, v]) => {
  const top = row;
  row += dimensions[v] + 2;
  return { axis, high, u, v, top, exposed: high && (axis === 0 || axis === 1) };
});
const atlasHeight = row;

async function makeTake(expose) {
  const heat = await HeatConduction.load();
  const solid = await Thermoelasticity.load({
    temperatureField: heat.temperatureField,
    liquidFractionField: heat.liquidFractionField,
  });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, cellSize: 64, memory: worldMemory(false) });
  const radiation = { kind: 'radiation', kelvin: ambient, emissivity };
  world.add(
    heat,
    {
      dimensions,
      cellSize: size,
      materials: material,
      initialTemperature: reference,
      boundaries: expose ? { yMax: radiation, xMax: radiation } : {},
      integration: 'implicit',
    },
    cell,
  );
  world.add(solid, { dimensions, cellSize: size, materials: solidMaterial, restraints }, cell);
  return { world, heat, solid, expose, first: world.takeSnapshot(), frame: 0, records: new Map() };
}

function seek(take, goal, action) {
  if (action === 'restore' || goal < take.frame) {
    const point = action === 'restore' ? take.checkpoint : { frame: 0, snapshot: take.first };
    take.world.restoreSnapshot(point.snapshot.bytes);
    take.frame = point.frame;
  }
  if (goal > take.frame) {
    take.world.advance(goal);
    take.frame = goal;
  }
  const snapshot = take.world.takeSnapshot();
  const previous = take.records.get(goal);
  if (previous && (previous.length !== snapshot.bytes.length || previous.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error('Thermal enthalpy and the coupled solid must replay from the same accepted bytes.');
  take.records.set(goal, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame: goal, snapshot };
  return snapshot.hash;
}

function accepted(take) {
  const { world, heat, solid } = take;
  const get = (field, length) => {
    const port = world.fields.port(field.name);
    if (
      port?.region.type !== 'f64' ||
      port.region.layout !== 1 ||
      port.region.byteLength !== length * Float64Array.BYTES_PER_ELEMENT ||
      port.cell.some((v, i) => v !== cell[i])
    )
      throw new Error('The specimen temperature and geometry must come from accepted fields in the same signed cell.');
    return regionWords(world.memory, port.region);
  };
  const temperature = get(heat.temperatureField, cells);
  const phase = get(heat.liquidFractionField, cells);
  const energy = get(heat.enthalpyField, cells);
  const displacement = get(solid.displacementField, 3 * nodes);
  const stress = get(solid.stressField, 6 * cells);
  const reaction = get(solid.reactionField, 3 * nodes);
  if (phase.some((value) => value !== 0))
    throw new Error('Keep the refractory specimen solid throughout the elastic cutaway.');
  const clamp = restraints.flatMap(({ node }) =>
    Array.from(displacement.subarray(3 * pointIndex(node), 3 * pointIndex(node) + 3)),
  );
  if (clamp.some((value) => value !== 0)) throw new Error('Keep all vertices in the loaded clamp fixed.');
  const tipAt = 3 * pointIndex([nx, ny / 2, nz / 2]);
  return {
    temperature,
    displacement,
    tip: Array.from(displacement.subarray(tipAt, tipAt + 3)),
    enthalpy: energy.reduce((sum, value) => sum + value, 0),
    stress: Math.max(...stress.map(Math.abs)),
    forceBalance: [0, 1, 2].map((axis) => reaction.reduce((sum, value, i) => sum + (i % 3 === axis ? value : 0), 0)),
  };
}

// Radiating surfaces are cooler than the published cell centres. Intersect grey-body
// emissive loss with linear conduction across the outer half cell for the displayed skin.
function surfaceKelvin(center, halfCell) {
  const conductance = material.conductivity / halfCell;
  let lo = ambient;
  let hi = center;
  for (let i = 0; i < 48; i++) {
    const middle = 0.5 * (lo + hi);
    const surface = stefan * emissivity * (middle ** 4 - ambient ** 4);
    if (conductance * (center - middle) > surface) lo = middle;
    else hi = middle;
  }
  return 0.5 * (lo + hi);
}

function emission(temperature, expose) {
  const rgba = new Float32Array(atlasWidth * atlasHeight * 4);
  let power = 0;
  let minimumSkin = Infinity;
  for (const face of faces) {
    const { axis, high, u, v, top } = face;
    for (let j = 0; j < dimensions[v] + 2; j++)
      for (let i = 0; i < dimensions[u] + 2; i++) {
        const cell = [0, 0, 0];
        cell[axis] = high ? dimensions[axis] - 1 : 0;
        cell[u] = Math.max(0, Math.min(dimensions[u] - 1, i - 1));
        cell[v] = Math.max(0, Math.min(dimensions[v] - 1, j - 1));
        const center = temperature[cellIndex(cell)];
        const radiates = face.exposed && expose;
        const skin = radiates ? surfaceKelvin(center, size[axis] / 2) : center;
        const glow = lavaGlow(skin);
        const offset = 4 * (i + atlasWidth * (top + j));
        for (let c = 0; c < 3; c++) rgba[offset + c] = (emissivity * glow[c]) / radianceWhite;
        rgba[offset + 3] = 1;
        if (radiates && i > 0 && j > 0 && i <= dimensions[u] && j <= dimensions[v])
          power += stefan * emissivity * (skin ** 4 - ambient ** 4) * size[u] * size[v];
        minimumSkin = Math.min(minimumSkin, skin);
      }
  }
  return { rgba, power, minimumSkin };
}

function coupon(displacement, lane, deform) {
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  for (const { axis, high, u, v, top } of faces) {
    const first = positions.length / 3;
    const positive = axis === 1 ? !high : high;
    for (let j = 0; j <= dimensions[v]; j++)
      for (let i = 0; i <= dimensions[u]; i++) {
        const node = [0, 0, 0];
        node[axis] = high ? dimensions[axis] : 0;
        node[u] = i;
        node[v] = j;
        const offsets = [couponOffset[0], couponOffset[1], lane - extent[2] / 2];
        const start = 3 * pointIndex(node);
        for (let k = 0; k < 3; k++)
          positions.push(offsets[k] + node[k] * size[k] + (deform ? exaggeration * displacement[start + k] : 0));
        const pale = 0.89 + 0.105 * Math.cos((node[0] + 1) * 3.08 + 1.31 * node[2]);
        colors.push(0.21 * pale, 0.14 * pale, 0.093 * pale, 1);
        uvs.push((i + 1) / atlasWidth, (top + j + 1) / atlasHeight);
        if (i < dimensions[u] && j < dimensions[v]) {
          const a = first + i + j * (dimensions[u] + 1);
          const b = a + dimensions[u] + 1;
          if (positive) indices.push(a, a + 1, b, a + 1, b + 1, b);
          else indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
  }
  const mesh = geometryData(positions, new Float32Array(positions.length), uvs, indices);
  mesh.colors = Float32Array.from(colors);
  return computeVertexNormals(mesh);
}

function bench(engine) {
  const iron = new PbrMaterial({ color: '#40505b', roughness: 0.51, metalness: 1 });
  const backing = new PbrMaterial({ color: '#515b5b', roughness: 0.81 });
  const ceramic = new PbrMaterial({ color: '#8b8b78', roughness: 0.86 });
  const rim = new PbrMaterial({ color: '#bb9a60', roughness: 0.51 });
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const bar = (x, y, z, bevel, material, position) =>
    part(toGeometry(roundedBoxGeometry(x, y, z, 2, bevel)), material, position);
  bar(0.65, 0.043, 0.35, 0.012, backing, [0.008, 0.045, 0]);
  bar(0.052, 0.081, 0.28, 0.008, iron, [-0.196, 0.091, 0.002]);
  for (const lane of lanes) {
    bar(0.041, 0.014, 0.091, 0.004, ceramic, [-0.179, 0.095, lane]);
    bar(0.045, 0.018, 0.091, 0.004, iron, [-0.18, 0.127, lane]);
    bar(0.026, 0.086, 0.018, 0.004, iron, [0.224, 0.109, lane + 0.008]);
    part(box(0.026, 0.002, 0.002), rim, [0.22, couponOffset[1] + extent[1] / 2, lane + 0.018]);
    part(box(0.012, 0.002, 0.002), rim, [0.214, couponOffset[1] + extent[1] / 2 + exaggeration / 2000, lane + 0.018]);
  }
  engine
    .createMesh()
    .setGeometry(box(1.5, 0.05, 0.8))
    .setMaterial(backing)
    .setPosition([0, -0.013, 0]);
}

export async function mountThermalFilm() {
  const takes = await Promise.all([makeTake(true), makeTake(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0.235, 0.29, 0.6], target: [0.014, 0.122, 0.0], fov: 38, near: 0.03, far: 5 },
  });
  engine.scene.background = '#293b45';
  engine.lighting.direction.set([-0.42, 0.66, 0.45, 1.75]);
  engine.lighting.radiance.set([1, 0.94, 0.81, 1]);
  engine.lighting.ambient.set([0.4, 0.52, 0.62]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  bench(engine);
  const models = takes.map((take, i) => {
    const state = accepted(take);
    const data = emission(state.temperature, false).rgba;
    const texture = new Texture(
      { data, width: atlasWidth, height: atlasHeight, format: 'rgba16float' },
      { colorSpace: 'linear', mipmaps: false, flipY: false },
    );
    const material = new SurfaceMaterial({
      roughness: 0.75,
      emissive: [1, 1, 1],
      emissiveMap: texture,
      vertexColors: true,
    });
    const draw = createMesh(engine, coupon(state.displacement, lanes[i], true), material);
    return { texture, data, draw };
  });
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize) =>
    labels.add(new Text({ text, position, font, fontSize, color: '#ecdcc5', billboard: true, onTop: true }));
  label('Cooling bows a kiln specimen', [-0.25, 0.232, -0.07], title, 0.033);
  label('Mullite · 36 cm span · deformation ×15', [-0.25, 0.192, -0.07], notes, 0.017);
  label('Exposed', [-0.22, 0.128, 0.145], notes, 0.014);
  label('Insulated', [-0.22, 0.161, -0.093], notes, 0.014);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.12 });

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
    rate,
    checkpoint,
    end,
    seed,
    ambient,
    reference,
    emissivity,
    stefan,
    radiatingArea: extent[0] * extent[2] + extent[1] * extent[2],
    async sample({ editFrame, action, showDeformation = true, showCooling = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = takes.map((take, i) => {
        const hash = seek(take, frame, action);
        const { temperature, displacement, ...response } = accepted(take);
        const thermal = emission(temperature, take.expose && frame > 0);
        const appearance = showCooling
          ? thermal
          : emission(
              temperature.map(() => reference),
              false,
            );
        models[i].data.set(appearance.rgba);
        models[i].texture.update();
        models[i].draw.setGeometry(coupon(displacement, lanes[i], showDeformation));
        return {
          hash,
          ...response,
          power: thermal.power,
          skin: thermal.minimumSkin,
          minimum: Math.min(...temperature),
          maximum: Math.max(...temperature),
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
      for (const { draw, texture } of models) {
        draw.destroy();
        texture.dispose();
      }
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      for (const { heat, solid } of takes) {
        heat[Symbol.dispose]?.();
        solid[Symbol.dispose]?.();
      }
      return { errors, validation };
    },
  };
}

import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { FALLING_BODY_WORDS, FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 240;
const cue = 20;
const checkpoint = 40;
const end = 64;
const gravity = 9.80665;
const releaseY = 0.32;
const bearing = 0.35;
// Radius, mean chord and mass from Rezgui, Hernández Arroyo & Theunissen (2020), Table 1.
// https://doi.org/10.1017/aer.2020.25
const radius = 0.0368;
const meanChord = 0.0084;
const mass = 0.0001;
const pitch = (-7 * Math.PI) / 180;
const lanes = [-0.174, 0.174];
const origin = [-7, 2, 11];
const air = { medium: 'air', cell: origin, sample: () => ({ velocity: [0, 0, 0], temperature: 288.15, density: 0 }) };
const widths = [0.44, 0.62, 0.83, 1.17, 1.42, 1.49, 1.39, 1.05, 0.03];
const strips = widths.length - 1;
const chords = widths.slice(0, -1).map((value, i) => (value + widths[i + 1]) / 2);
const scale = (meanChord * strips) / chords.reduce((sum, value) => sum + value, 0);

async function take(vacuum) {
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const solver = await FallingSolver.load({ threads: 1 });
  const sections = chords.map((chord, i) => ({
    start: (i * radius) / strips,
    end: ((i + 1) * radius) / strips,
    chord: chord * scale,
    pitch,
  }));
  world.add(
    solver,
    {
      bodies: [
        {
          kind: 'samara',
          mass,
          spinInertia: (mass * radius * radius) / 10,
          position: [0, releaseY, 0],
          axis: [0, 1, 0],
          angle: bearing,
          sections,
        },
      ],
      wind: vacuum ? air : undefined,
    },
    origin,
  );
  return { world, solver, frame: 0, first: world.takeSnapshot(), records: new Map() };
}

function poses(take) {
  const { world, solver } = take;
  const port = world.fields.port(solver.poseField.name);
  if (
    port?.region.type !== 'f64' ||
    port.region.layout !== 1 ||
    port.region.byteLength !== FALLING_BODY_WORDS * Float64Array.BYTES_PER_ELEMENT ||
    port.cell.some((value, i) => value !== origin[i])
  )
    throw new Error('Use the native 13-word accepted falling pose in its signed origin cell.');
  const { position, rotation, velocity, angularVelocity } = solver.pose(0);
  const pose = [...position, ...rotation, ...velocity, ...angularVelocity];
  if (regionWords(world.memory, port.region).some((value, i) => value !== pose[i]))
    throw new Error('The mesh pose differs from the published falling field.');
  return { position, rotation, velocity, angularVelocity };
}

function releaseFrame(take, frame, action) {
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
    throw new Error('Held and replayed body state and published poses must have identical snapshot bytes.');
  take.records.set(frame, snapshot.bytes);
  if (action === 'save') take.checkpoint = { frame, snapshot };
  return { hash: snapshot.hash, ...poses(take) };
}

function wingGeometry() {
  // Original geometry from the asymmetric Acer planforms in Lentink et al. (2009), Fig. 1B.
  // https://doi.org/10.1126/science.1174196
  const positions = [];
  const colors = [];
  const uv = [];
  const indices = [];
  const span = strips * 8;
  const across = 24;
  const layer = (span + 1) * (across + 1);
  for (const side of [1, -1]) {
    for (let i = 0; i <= span; i++) {
      const u = i / span;
      const interval = Math.min(strips - 1, Math.floor(u * strips));
      const ch = scale * (widths[interval] + (widths[interval + 1] - widths[interval]) * (u * strips - interval));
      const mid = 0.0016 * (Math.sin(Math.PI * u) - 0.62 * u);
      for (let j = 0; j <= across; j++) {
        const v = j / across;
        const y = mid + (v - 0.5) * ch;
        const z = Math.sin(pitch) * y + Math.sin(v * Math.PI) * 0.00045 * (1 - 0.55 * u) + side * 0.000095;
        positions.push(u * radius, y, z);
        uv.push(u, v);
        const ribPhase = 10 * u + 1.85 * v + 0.32 * Math.sin(7 * v);
        const rib = Math.max(0, Math.cos(2 * Math.PI * ribPhase)) ** 36;
        const longitudinal = Math.exp(-((v - 0.14 - 0.026 * Math.sin(11 * u)) ** 2) / 0.001);
        const edge = 0.17 * (Math.abs(2 * v - 1) ** 10 + u ** 9);
        const marbling = 0.036 * Math.sin(83 * u + 17 * v) * Math.cos(43 * u - 61 * v);
        const tint = (0.96 - 0.29 * longitudinal - 0.19 * rib - edge + marbling) * (side > 0 ? 1 : 0.79);
        colors.push(0.64 * tint, (0.32 + 0.07 * v) * tint, (0.09 + 0.06 * v) * tint, 1);
        if (i === 0 || j === 0) continue;
        const c = (side > 0 ? 0 : layer) + i * (across + 1) + j;
        const a = c - across - 2;
        const b = c - 1;
        const d = c - across - 1;
        if (side > 0) indices.push(a, b, c, a, c, d);
        else indices.push(a, c, b, a, d, c);
      }
    }
  }
  const data = geometryData(positions, new Float32Array(positions.length), uv, indices);
  data.colors = Float32Array.from(colors);
  return computeVertexNormals(data);
}

function chamber(engine) {
  const frame = new PbrMaterial({ color: '#3f4e4d', roughness: 0.61 });
  const wall = new PbrMaterial({ color: '#182722', roughness: 0.98 });
  const ticks = new PbrMaterial({ color: '#9f9a7f', roughness: 0.76 });
  const faint = new PbrMaterial({ color: '#4a5447', roughness: 0.89 });
  const prop = (size, position, material) =>
    engine
      .createMesh()
      .setGeometry(box(...size))
      .setMaterial(material)
      .setPosition(position);

  prop([0.69, 0.44, 0.018], [0, 0.139, -0.068], wall);
  prop([0.7, 0.015, 0.172], [0, -0.082, -0.014], frame);
  prop([0.7, 0.014, 0.035], [0, 0.363, -0.06], frame);
  prop([0.007, 0.44, 0.014], [0, 0.139, -0.055], frame);
  for (const side of [-1, 1]) {
    const x = side * 0.343;
    prop([0.012, 0.44, 0.03], [x, 0.139, -0.056], frame);
    prop([0.0024, 0.36, 0.001], [x - side * 0.024, 0.14, -0.057], faint);
    prop([0.28, 0.0015, 0.001], [side * 0.174, releaseY, -0.056], faint);
    for (let mark = 0; mark < 19; mark++) {
      const major = mark % 5 === 0;
      const length = major ? 0.025 : 0.01;
      prop(
        [length, major ? 0.0015 : 0.0009, 0.001],
        [x - side * (0.024 + length / 2), -0.04 + 0.02 * mark, -0.055],
        ticks,
      );
    }
  }
}

export async function mountSamaraFilm() {
  const takes = await Promise.all([take(false), take(true)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0, 0.405, 0.725], target: [0, 0.14, 0], fov: 34, near: 0.015, far: 3 },
  });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  engine.scene.background = '#222b29';
  engine.lighting.direction.set([-0.54, 0.79, 0.4, 2.25]);
  engine.lighting.radiance.set([1, 0.94, 0.8, 1]);
  engine.lighting.ambient.set([0.48, 0.52, 0.48]);
  chamber(engine);
  const membrane = wingGeometry();
  const membraneMaterial = new SurfaceMaterial({ vertexColors: true, roughness: 0.51 });
  const seeds = lanes.map(() => {
    const wing = createMesh(engine, membrane, membraneMaterial);
    const seed = engine
      .createMesh()
      .setGeometry(toGeometry(sphereGeometry(0.0042, 18, 10)))
      .setMaterial(new PbrMaterial({ color: '#9b6938', roughness: 0.61 }))
      .setScale([1, 0.69, 0.49]);
    return { wing, seed };
  });
  const font = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const text = TextRenderer.attach(engine);
  for (const [i, label] of ['Still air', 'Zero air density'].entries())
    text.add(
      new Text({
        text: label,
        font,
        fontSize: 0.0145,
        color: '#ece1c1',
        position: [lanes[i] - 0.064, 0.346, -0.048],
        billboard: true,
        onTop: true,
      }),
    );
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.15 });

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
    checkpoint,
    end,
    rate,
    releaseY,
    gravity,
    radius,
    async sample({ editFrame, action }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const model = takes.map((take) => releaseFrame(take, frame, action));
      for (const [i, { position, rotation }] of model.entries()) {
        const centre = [position[0] + lanes[i], position[1], position[2]];
        seeds[i].wing.root.setPosition(centre).setQuaternion(rotation);
        seeds[i].seed.setPosition(centre).setQuaternion(rotation);
      }
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      pixels.putImageData(new ImageData(data, width, height), 0, 0);
      const tips = model.map(({ rotation }) => rotateByQuaternion([radius, 0, 0], rotation));
      return { frame, model, tips, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      for (const { wing } of seeds) wing.destroy();
      for (const { solver } of takes) solver[Symbol.dispose]?.();
      text.dispose();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

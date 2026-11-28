import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { Texture } from '@margoengine/materials/texture';
import { AccretionDiskSolver, KerrGeodesicSolver, kerrCircularOrbit } from '@margoengine/physics/accretion';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const atlasWidth = 512;
const atlasHeight = 64;
const rate = 60;
const cue = 18;
const firstCheckpoint = 33;
const secondCheckpoint = 64;
const end = 96;
const seed = 47389;
const cell = [-17, 3, 9];
const G = 6.6743e-11;
const C = 299792458;
const gravitySeconds = 0.008;
const distance = C * gravitySeconds;
const centralMass = (C ** 3 * gravitySeconds) / G;
const spin = 0.56;
const tracerRadius = 10.5;
const azimuth = 0.58;
const annuli = 32;
const inner = 7;
const outer = 23;
const delta = (outer - inner) / annuli;
const viscosity = 0.72 * distance ** 2;
const TAU = 2 * Math.PI;
const centres = [-27.1, 27.1];
const edges = Array.from({ length: annuli + 1 }, (_, i) => (inner + delta * i) * distance);
const densities = Array.from({ length: annuli }, (_, i) => {
  const r = (edges[i] + edges[i + 1]) / (2 * distance);
  return (
    25 * Math.exp(-((r - 11.4) ** 2) / 7.5) +
    126 * Math.exp(-((r - 15.7) ** 2) / 4) +
    15 * Math.exp(-((r - 20.7) ** 2) / 8)
  );
});

// Local thin-disk viscous transport and dissipation follow Lynden-Bell & Pringle (1974),
// https://doi.org/10.1093/mnras/168.3.603. The visualization uses false-colour surface density,
// one-face heating and an authored passive streak wound by the published annulus phases.
// The independent coordinate tracer follows the circular reference in Bardeen, Press & Teukolsky (1972),
// Eq. 2.16, https://doi.org/10.1086/151796. Display positions use GM/c² and a flat coordinate projection.
async function establish(active) {
  const disk = await AccretionDiskSolver.load();
  const tracer = new KerrGeodesicSolver({ maxPhaseStep: 1 / 64 });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, memory: worldMemory(false) });
  world.add(disk, { centralMass, edges, viscosity: active ? viscosity : 0, initialDensity: densities }, cell);
  world.add(
    tracer,
    { ...kerrCircularOrbit(tracerRadius, spin), centralMass, radius: tracerRadius, spin, azimuth },
    cell,
  );
  return {
    world,
    disk,
    tracer,
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
  if (previous && (previous.length !== snapshot.bytes.length || previous.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error(
      'Restore the complete annulus transport, heating, orbital phase and geodesic state at the edit mark.',
    );
  take.visited.set(goal, snapshot.bytes);
  if (action === 'save') take.saved.set(goal, { frame: goal, snapshot });
  return snapshot.hash;
}

function accept({ world, disk, tracer }) {
  const descriptions = [disk.densityField, disk.heatingField, disk.phaseField, tracer.coordinatesField];
  const ports = descriptions.map((field) => world.fields.port(field.name));
  const [density, heat, phase, coordinates] = ports.map((port) => {
    if (port.region.layout !== 1 || port.region.type !== 'f64')
      throw new Error('Render from the versioned f64 density, heating, phase and tracer fields.');
    return Array.from(regionWords(world.memory, port.region));
  });
  const rings = density.map((_, i) => disk.ring(i));
  if (rings.some((ring, i) => ring.density !== density[i] || ring.heating !== heat[i] || ring.phase !== phase[i]))
    throw new Error('Use the density, heating and phase registered from the same accepted annulus state.');
  const [radius, polar, phi, properTime, horizon] = coordinates;
  const sample = tracer.sample();
  if (
    radius !== sample.radius ||
    polar !== sample.polarAngle ||
    phi !== sample.azimuth ||
    properTime !== sample.properTime ||
    horizon !== sample.horizonOffset
  )
    throw new Error('Use the same accepted Kerr coordinates as the public tracer sample.');
  return { rings, density, heat, phase, coordinates, cells: ports.map((port) => port.cell), budget: disk.budget() };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => a + (b - a) * t;
function emission(out, accepted, showHeating, showPhase) {
  for (let v = 0; v < atlasHeight; v++) {
    const h = clamp(((v + 0.5) * annuli) / atlasHeight - 0.5, 0, annuli - 1);
    const first = Math.floor(h);
    const next = Math.min(first + 1, annuli - 1);
    const portion = h - first;
    const sigma = mix(accepted.density[first], accepted.density[next], portion);
    const local = showHeating ? mix(accepted.heat[first], accepted.heat[next], portion) : 0;
    const from = accepted.phase[first];
    const difference = accepted.phase[next] - from;
    const wrapped = Math.atan2(Math.sin(difference), Math.cos(difference));
    const angle = showPhase ? from + wrapped * portion : 0;
    const heat = Math.sqrt(local / (local + 1.8e15));
    const density = Math.sqrt(sigma / (sigma + 42));
    const edge = Math.min(1, (v + 0.5) / 3, (atlasHeight - v - 0.5) / 4);
    for (let u = 0; u < atlasWidth; u++) {
      const phi = ((u + 0.5) * TAU) / atlasWidth - angle;
      const ridge = Math.exp(-19 * (1 - Math.cos(phi - 0.23)));
      const companion = Math.exp(-8 * (1 - Math.cos(phi - 3.31)));
      const grain = Math.sin(13 * phi + 1.8 * Math.cos(h * 0.48)) * Math.sin(17 * phi + h * 0.6);
      const structure = 0.36 + 0.88 * ridge + 0.29 * companion + 0.07 * grain;
      const start = 4 * (u + v * atlasWidth);
      out[start] = edge * structure * (0.11 * density + 2.15 * heat);
      out[start + 1] = edge * structure * (0.26 * density + 0.56 * heat ** 1.25);
      out[start + 2] = edge * structure * (0.54 * density + 0.15 * heat ** 1.7);
      out[start + 3] = 1;
    }
  }
}

function annulus(centre, low, high, y) {
  const positions = [],
    normals = [],
    uvs = [],
    indices = [];
  const around = 160;
  for (let i = 0; i <= around; i++) {
    const angle = (TAU * i) / around;
    for (const [v, r] of [low, high].entries()) {
      positions.push(centre + r * Math.cos(angle), y, r * Math.sin(angle));
      normals.push(0, 1, 0);
      uvs.push(i / around, v);
    }
    if (i < around) {
      const a = 2 * i;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  return geometryData(positions, new Float32Array(normals), uvs, indices);
}

function appearance(engine) {
  const guide = new PbrMaterial({ color: '#5e9caa', roughness: 0.9 });
  const border = new PbrMaterial({ color: '#45505a', roughness: 0.93 });
  const core = new PbrMaterial({ color: '#252b30', roughness: 0.97 });
  const horizonRadius = 1 + Math.sqrt(1 - spin ** 2);
  const shadow = toGeometry(sphereGeometry(horizonRadius, 50, 24));
  const mark = sphereGeometry(0.56, 36, 18);
  return centres.map((centre) => {
    engine.createMesh().setGeometry(shadow).setMaterial(core).setPosition([centre, 0, 0]);
    engine
      .createMesh()
      .setGeometry(toGeometry(annulus(centre, outer + 1.15, outer + 1.25, 0)))
      .setMaterial(border);
    engine
      .createMesh()
      .setGeometry(toGeometry(annulus(centre, tracerRadius - 0.072, tracerRadius + 0.072, 0.036)))
      .setMaterial(guide);
    const data = new Float32Array(atlasWidth * atlasHeight * 4);
    const texture = new Texture(
      { data, width: atlasWidth, height: atlasHeight, format: 'rgba16float' },
      { colorSpace: 'linear', mipmaps: false, flipY: false },
    );
    const material = new SurfaceMaterial({
      color: '#202631',
      roughness: 0.94,
      emissive: [1, 1, 1],
      emissiveMap: texture,
    });
    const surface = createMesh(engine, annulus(centre, inner, outer, 0), material);
    const tracer = createMesh(
      engine,
      mark,
      new SurfaceMaterial({ color: '#435c64', roughness: 0.49, emissive: [0.16, 0.86, 1], emissiveIntensity: 1.4 }),
    );
    return { centre, surface, tracer, data, texture };
  });
}

function marker(centre, coordinates) {
  const [r, polar, phi] = coordinates;
  return [
    centre + (r / distance) * Math.sin(polar) * Math.cos(phi),
    (r / distance) * Math.cos(polar),
    (r / distance) * Math.sin(polar) * Math.sin(phi),
  ];
}

export async function mountAccretionFilm() {
  const takes = await Promise.all([establish(true), establish(false)]);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0, 67, 77], target: [0, 0, 0], fov: 38, near: 0.2, far: 400 },
  });
  engine.scene.background = '#122131';
  engine.lighting.direction.set([-0.54, 0.73, 0.42, 0.4]);
  engine.lighting.radiance.set([0.88, 0.92, 1, 1]);
  engine.lighting.ambient.set([0.16, 0.22, 0.32]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const draws = appearance(engine);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    labels.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('Viscosity lights an accretion disk', [-48, 13, -24], title, 4.1, '#f6dfc4');
  label('False-colour heat and density · cyan Kerr tracer · GM/c²', [-47.8, 7.4, -24], notes, 2.2, '#bdc6cb');
  label('Viscosity on', [-36.2, 0, 28], notes, 2.37, '#f0ba92');
  label('Zero viscosity', [17.3, 0, 28], notes, 2.37, '#79bfd4');
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.31 });
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
    firstCheckpoint,
    secondCheckpoint,
    end,
    seed,
    cell,
    G,
    centralMass,
    gravitySeconds,
    distance,
    spin,
    tracerRadius,
    azimuth,
    viscosity,
    edges,
    densities,
    centres,
    async sample({ editFrame, action, showHeating = true, showPhase = true, showTracer = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = takes.map((take, i) => {
        const hash = seek(take, frame, action);
        const accepted = accept(take);
        const { centre, data, texture, tracer } = draws[i];
        emission(data, accepted, showHeating, showPhase);
        texture.update();
        const position = marker(centre, accepted.coordinates);
        tracer.root.setPosition(showTracer ? position : [centre, -99, 0]);
        return { hash, ...accepted, position };
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
        states,
        matrix: Array.from(engine.camera.matrix),
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      for (const { surface, texture, tracer } of draws) {
        surface.destroy();
        tracer.destroy();
        texture.dispose();
      }
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      for (const { disk, tracer } of takes) {
        disk[Symbol.dispose]?.();
        tracer[Symbol.dispose]?.();
      }
      return { errors, validation };
    },
  };
}

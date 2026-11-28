import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { computeVertexNormals, geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { CelestialSolver, INSOLATION_FIELD, insolationFromPort, trackSolarRow } from '@margoengine/physics/celestial';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { Noise, generateGrassMesh, generateRockMesh } from '@margoengine/procedural';
import { Shadows } from '@margoengine/shadows';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const cue = 18;
const dawnCheckpoint = 45;
const risingCheckpoint = 185;
const end = 300;
const seed = 83277;
const cell = [-8, 1, 11];
const timeScale = 1800;
const radians = Math.PI / 180;
// Site near Albuquerque, New Mexico. Fixed illustrative epoch: UT1 is approximated by UTC, TT by UTC + 69.184 s.
const site = { latitude: 35.08 * radians, longitude: -106.65 * radians, height: 1600 };
const utc = (Date.UTC(2025, 2, 20, 14, 1) - Date.UTC(2000, 0, 1, 12)) / 1000;
const epoch = { ut1Seconds: utc, ttSeconds: utc + 69.184 };
// Anderson & Mikofski (2020), NREL/TP-5K00-76626 §§2, 4, 6, https://www.nrel.gov/docs/fy20osti/76626.pdf.
// +X is east, +Y is up and -Z is north in the render. Rack pitch is horizontal, across the 5° grade.
const crossAxisSlope = -5 * radians;
const groundCoverageRatio = 0.53;
const aperture = 2.25;
const pitch = aperture / groundCoverageRatio;
const length = 10.4;
const axisHeight = 1.59;
const panelThickness = 0.034;
const centres = [-10.6, 10.6];
// The NREL right-hand tilt is positive when a north-pointing shaft's terrain descends east.
const grade = -Math.tan(crossAxisSlope);
const boundApertures = centres.map((centre) =>
  [-0.5, 0.5].map((j) => [centre + j * pitch, (centre + j * pitch) * grade + axisHeight, 0]),
);

async function establish() {
  const celestial = await CelestialSolver.load();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, seed, memory: worldMemory(false), cellSize: 64 });
  world.add(celestial, { epoch, timeScale }, cell);
  return {
    world,
    celestial,
    frame: 0,
    checkpoints: new Map([[0, { frame: 0, snapshot: world.takeSnapshot() }]]),
    visited: new Map(),
  };
}

function seek(scene, goal, action) {
  if (action === 'restore' || goal < scene.frame) {
    const saved = scene.checkpoints.get(action === 'restore' ? goal : 0);
    scene.world.restoreSnapshot(saved.snapshot.bytes);
    scene.frame = saved.frame;
  }
  if (goal > scene.frame) {
    scene.world.advance(goal);
    scene.frame = goal;
  }
  const snapshot = scene.world.takeSnapshot();
  const prior = scene.visited.get(goal);
  if (prior && (prior.length !== snapshot.bytes.length || prior.some((byte, i) => byte !== snapshot.bytes[i])))
    throw new Error('Restore the complete celestial pose, irradiance and astronomical clock at the selected cut.');
  scene.visited.set(goal, snapshot.bytes);
  if (action === 'save') scene.checkpoints.set(goal, { frame: goal, snapshot });
  return snapshot.hash;
}

const noise = new Noise(seed);
const clamp = (value, a, b) => Math.min(b, Math.max(a, value));
function ground(x, z) {
  const flat = grade * clamp(x, -22, 22);
  const start = Math.max(0, Math.min(1, (-z - 10) / 38));
  const far =
    start *
    ((1.7 + 1.2 * noise.simplex(x * 0.066, 1, z * 0.026)) * (1 + 2.2 * start) +
      3 * Math.sin(x * 0.078 + 1) * Math.sin(z * 0.07));
  return flat + far;
}

function siteTerrain(engine, shadows) {
  const cols = 90;
  const rows = 80;
  const positions = [],
    uv = [],
    indices = [],
    colors = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) {
      const x = -75 + (150 * i) / cols;
      const z = -105 + (146 * j) / rows;
      positions.push(x, ground(x, z), z);
      uv.push(i / cols, j / rows);
      const variety = noise.simplex(0.21 * x, 8.05, 0.23 * z);
      const grain = noise.simplex(0.63 * x, 11, 0.58 * z);
      const far = clamp((-z - 15) / 59, 0, 1);
      const shoulder = clamp((4.3 - Math.abs(x + 0.8)) / 1.5, 0, 1);
      const road = shoulder * clamp((z + 20) / 8, 0, 1);
      colors.push(
        0.34 + 0.04 * variety + 0.025 * grain + 0.07 * road + 0.045 * far,
        0.263 + 0.024 * variety + 0.022 * grain + 0.057 * road + 0.083 * far,
        0.159 + 0.03 * variety + 0.015 * grain + 0.049 * road + 0.162 * far,
        1,
      );
      if (i < cols && j < rows) {
        const a = i + j * (cols + 1);
        const b = a + cols + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const bed = geometryData(positions, new Float32Array(positions.length), uv, indices);
  bed.colors = Float32Array.from(colors);
  const terrain = createMesh(
    engine,
    computeVertexNormals(bed),
    new SurfaceMaterial({ vertexColors: true, roughness: 0.91 }),
  );
  shadows.add(terrain, { castShadow: false });
}

function field(engine, shadows) {
  siteTerrain(engine, shadows);
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const rounded = (dims, corner, material, position) =>
    part(toGeometry(roundedBoxGeometry(...dims, 2, corner)), material, position);
  const grass = toGeometry(generateGrassMesh(5));
  const scrub = new PbrMaterial({ color: '#8a8353', roughness: 0.9 });
  const stone = new PbrMaterial({ color: '#9b8b75', roughness: 0.93 });
  const zinc = new PbrMaterial({ color: '#a6aba4', roughness: 0.53 });
  const concrete = new PbrMaterial({ color: '#a7a79b', roughness: 0.77 });
  const cabinet = new PbrMaterial({ color: '#858e89', roughness: 0.68 });
  const rail = new PbrMaterial({ color: '#777f77', roughness: 0.61 });
  const under = new PbrMaterial({ color: '#626c70', roughness: 0.58 });
  const cellBlue = new PbrMaterial({ color: '#254d68', roughness: 0.32, metalness: 0.07 });
  const grid = new PbrMaterial({ color: '#3d6275', roughness: 0.67 });
  const wire = new PbrMaterial({ color: '#476779', roughness: 0.62 });
  const strip = box(0.014, 0.008, length - 0.012);
  const segment = length / 8;
  const panelFace = box(aperture, panelThickness, length);
  const crossbars = Array.from({ length: 5 }, (_, i) => box(aperture, 0.072, 0.23 - 0.025 * i));
  const joint = toGeometry(cylinderGeometry(0.097, 0.097, 0.28, 20));
  const seeded = new RandomStream(seed, solverNumber('celestial-film-field'));
  for (let i = 0; i < 124; i++) {
    const [a, b] = seeded.unitF64(0, i);
    const x = -26 + 55 * a;
    const z = -10 + 24 * b;
    if (Math.abs(x) < 3 || (Math.min(...centres.map((v) => Math.abs(v - x))) < 5 && Math.abs(z) < 6)) continue;
    const [u, v] = seeded.unitF64(0, i, 1);
    part(grass, scrub, [x, ground(x, z), z])
      .setRotation([0, v * 2 * Math.PI, 0])
      .setScale([1.8, 0.39 + 0.69 * u, 1.8]);
  }
  for (const [i, [x, z, s]] of [
    [-18, 4.6, 0.61],
    [-7.3, 7.8, 0.34],
    [4.1, 9.0, 0.5],
    [17.6, 6.5, 0.63],
    [21.6, 10.8, 1.03],
  ].entries())
    part(toGeometry(generateRockMesh(seed + i, 'slab')), stone, [x, ground(x, z), z]).setScale([s, s, s]);
  for (const x of [-6.4, 6.4]) {
    const z = 7.13;
    const y = ground(x, z);
    rounded([0.95, 0.13, 0.75], 0.025, concrete, [x, y + 0.065, z]);
    rounded([0.69, 1.07, 0.51], 0.037, cabinet, [x, y + 0.642, z]);
    part(box(0.021, 0.2, 0.014), rail, [x + 0.21, y + 0.68, z + 0.26]);
  }
  return boundApertures.map((axes) =>
    axes.map(([x, y]) => {
      const hinge = engine.createMesh().setPosition([x, y, 0]);
      const mounted = (geometry, material, local) => part(geometry, material, local).setParent(hinge);
      const panel = mounted(panelFace, cellBlue, [0, 0, 0]);
      shadows.add(panel);
      const faces = [panel];
      const top = panelThickness / 2 + 0.002;
      const edge = box(0.034, 0.038, length);
      for (const sign of [-1, 1]) faces.push(mounted(edge, zinc, [sign * (aperture / 2 - 0.017), 0.003, 0]));
      for (let i = 1; i < 12; i++) faces.push(mounted(strip, grid, [aperture * (i / 12 - 0.5), top, 0]));
      const seam = box(aperture - 0.064, 0.008, 0.009);
      for (let i = 0; i <= 48; i++) {
        const betweenModules = i % 6 === 0;
        const line = betweenModules ? crossbars[(i / 6) % crossbars.length] : seam;
        const m = betweenModules ? under : wire;
        if (betweenModules) mounted(line, m, [0, -0.054, (i / 48 - 0.5) * length * 0.994]);
        faces.push(mounted(seam, m, [0, top + (betweenModules ? 0.003 : 0), (i / 48 - 0.5) * length * 0.994]));
      }
      mounted(box(0.125, 0.13, length + 0.21), rail, [0, -0.117, 0]);
      for (const z of [-(3 * segment), 0, 3 * segment]) {
        const low = ground(x, z);
        rounded([0.56, 0.15, 0.49], 0.026, concrete, [x, low + 0.064, z]);
        rounded([0.19, axisHeight - 0.11, 0.19], 0.02, zinc, [x, (y + low) / 2 - 0.006, z]);
        part(joint, rail, [x, y - 0.081, z]).setRotation([Math.PI / 2, 0, 0]);
      }
      return { hinge, faces };
    }),
  );
}

function captionAnchor(camera, x, y) {
  const direction = camera.target.map((v, i) => v - camera.position[i]);
  const distance = Math.hypot(...direction);
  const ahead = direction.map((v) => v / distance);
  const side = Math.hypot(ahead[0], ahead[2]);
  const right = [-ahead[2] / side, 0, ahead[0] / side];
  const up = [-right[2] * ahead[1], right[2] * ahead[0] - right[0] * ahead[2], right[0] * ahead[1]];
  const depth = 24;
  const rise = depth * Math.tan((camera.fov * radians) / 2);
  return camera.position.map(
    (v, i) => v + depth * ahead[i] + ((2 * x - 1) * rise * right[i] * width) / height + (1 - 2 * y) * rise * up[i],
  );
}

export async function mountCelestialFilm() {
  const scene = await establish();
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [19, 14.8, 27.2], target: [0, 1.5, 0], fov: 41, near: 0.15, far: 190 },
  });
  engine.scene.background = '#b2c5c7';
  engine.lighting.radiance.set([1, 0.92, 0.76, 1]);
  engine.lighting.ambient.set([0.37, 0.47, 0.61]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (err) => errors.push(String(err));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const shadows = Shadows.attach(engine, {
    bounds: { min: [-24, -5, -17], max: [24, 6, 14] },
    filter: 'hard',
    resolution: 2048,
  });
  const banks = field(engine, shadows);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    labels.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('Backtracking clears the next row', captionAnchor(engine.camera, 0.089, 0.126), title, 1.17, '#243939');
  label(
    '20 March · Albuquerque · 5° cross-axis grade',
    captionAnchor(engine.camera, 0.09, 0.209),
    notes,
    0.53,
    '#304949',
  );
  label('True tracking', [-11.25, ground(-11.25, 7.5) + 0.38, 7.5], title, 0.61, '#f3e8d2');
  label('Slope-aware backtracking', [6.6, ground(6.6, 7.5) + 0.38, 7.5], title, 0.61, '#f3e8d2');
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
  await shadows.ready;
  await waitForPipelines(draw);
  return {
    cue,
    dawnCheckpoint,
    risingCheckpoint,
    end,
    rate,
    seed,
    cell,
    timeScale,
    epoch,
    pitch,
    aperture,
    length,
    panelThickness,
    crossAxisSlope,
    groundCoverageRatio,
    centres: boundApertures,
    async sample({ editFrame, action, receivePanelShadow = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hash = seek(scene, frame, action);
      const port = scene.world.fields.port(INSOLATION_FIELD.name);
      const byPort = insolationFromPort(scene.world.memory, port, site);
      const sun = scene.celestial.insolation(site);
      if (sun.direction.some((v, i) => v !== byPort.direction[i]) || sun.horizontal !== byPort.horizontal)
        throw new Error('Drive the solar farm from the same accepted ephemeris as the insolation port.');
      const [east, north, up] = sun.direction;
      const renderSun = [east, up, -north];
      engine.lighting.direction.set([...renderSun, (sun.directNormal / 1361) * 2.2]);
      const poses = banks.map((bank, ix) => {
        const command = trackSolarRow(sun.direction, { crossAxisSlope, groundCoverageRatio, backtrack: ix === 1 });
        for (const rack of bank) {
          rack.hinge.setRotation([0, 0, -command.rotation]);
          for (const collector of rack.faces) collector.receiveShadow = receivePanelShadow;
        }
        return command;
      });
      await waitForPipelines(draw);
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
        sun,
        poses,
        portCell: port.cell,
        epoch: scene.celestial.epoch,
        renderSun,
        matrix: Array.from(engine.camera.matrix),
        image: encoded.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      scene.celestial[Symbol.dispose]?.();
      return { errors, validation };
    },
  };
}

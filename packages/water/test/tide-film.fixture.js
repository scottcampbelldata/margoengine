import { EngineKernel, Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { CelestialSolver, TIDAL_POTENTIAL_FIELD, localHorizon } from '@margoengine/physics/celestial';
import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { SurgeSolver } from '@margoengine/physics/surge';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const gravity = 9.81;
const timeScale = 3600;
const rate = 8;
const love = 0.693;
const ramp = 7200;
const columns = 48;
const rows = 4;
const dimensions = [1_200_000, 120_000];
const dx = dimensions[0] / columns;
const dz = dimensions[1] / rows;
const site = { latitude: 0.25, longitude: -1.22 };
const shore = [
  [-537_500, 15_000],
  [537_500, 15_000],
];
const sill = [
  [-587_500, 15_000],
  [587_500, 15_000],
];
const cue = 14;
const lunarFrame = 5 * rate;
const westernFrame = 7 * rate;
const easternFrame = 14 * rate;
const turningFrame = 13 * rate;

const horizontalScale = 25_000; // Model scene metres per physical distance are 1:25,000.
const verticalScale = 45; // Readable cutaway scale only. Forces and all reported depths remain in SI metres.
const floor = -7; // Crop the simulated deep floor, below the range of the drawn surface.
const size = dimensions.map((d) => d / horizontalScale);
const origin = size.map((d) => -d / 2);
const width = 768;
const height = 432;
const camera = { position: [0, 22, 47], target: [0, 0.4, 0], fov: 37, near: 0.6, far: 128 };

function makeBed() {
  const heights = new Float64Array((columns + 1) * (rows + 1));
  for (let i = 0; i <= columns; i++) {
    const distance = Math.min(i, columns - i);
    const elevation = distance === 0 ? 0.18 : distance === 1 ? -0.179 : distance === 2 ? -0.25 : -300;
    heights.fill(elevation, i * (rows + 1), (i + 1) * (rows + 1));
  }
  return bedSurface({ columns, rows, width: dimensions[0], depth: dimensions[1], centre: [0, 0] }, heights);
}

function makeTake(bed, tide) {
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const sky = new CelestialSolver();
  const hydro = new ShallowWaterSolver();
  const surge = new SurgeSolver('surge', { tide });
  world
    .add(sky, { timeScale })
    .add(hydro, { bed, level: 0, roughness: 0.022, timeScale })
    .add(surge, { water: hydro, site, love, ramp })
    .couple(['surge', 'water'], 'staggered');
  return { world, hydro, surge, first: world.takeSnapshot(), volume: hydro.volume(), frame: 0, records: new Map() };
}

function pointOnEarth(x, z) {
  const frame = localHorizon(site);
  const point = frame.position.map((r, i) => r + x * frame.east[i] - z * frame.north[i]);
  const rad = Math.hypot(...frame.position) / Math.hypot(...point);
  return point.map((u) => u * rad);
}

function quadrupole(body, gm) {
  // Leading tide-generating potential after removing constant and uniform acceleration. See IERS Conventions (2010),
  // Ch. 6, and NOAA, https://oceanservice.noaa.gov/education/tutorial_tides/tides02_cause.html
  const distance = Math.hypot(...body);
  const points = shore.map(([x, z]) => pointOnEarth(x, z));
  const radius = Math.hypot(...points[0]);
  const [west, east] = points.map((r) => body.reduce((sum, b, i) => sum + b * r[i], 0) / (distance * radius));
  const q = radius / distance;
  const factor = (love * gm) / (gravity * distance);
  // |P'_n(cos θ)| ≤ n(n+1)/2. Sum its series for n≥3 to bound the discarded differential multipoles.
  const tail = (q / (1 - q) ** 3 - q - 3 * q ** 2) * Math.abs(east - west) * factor;
  return { distance, tide: factor * q ** 2 * 1.5 * (east ** 2 - west ** 2), tail };
}

function astronomical(take) {
  const { world, surge } = take;
  const port = world.fields.port(TIDAL_POTENTIAL_FIELD.name);
  if (port?.region.layout !== 1 || port.region.type !== 'f64')
    throw new Error('Use the accepted Earth-fixed Sun and Moon port.');
  const words = Array.from(regionWords(world.memory, port.region));
  const sun = quadrupole(words.slice(0, 3), 1.32712440018e20);
  const moon = quadrupole(words.slice(3, 6), 4.902800066e12);
  const head = surge.potentialAt(...shore[0]) - surge.potentialAt(...shore[1]);
  const growth = Math.tanh((timeScale * world.time) / ramp);
  return { words, sun, moon, head, expected: growth * (sun.tide + moon.tide), bound: growth * (sun.tail + moon.tail) };
}

const bedInView = (sample) => Math.max(floor, sample * verticalScale);

function basin(engine, bed) {
  const positions = [],
    normals = [],
    triangles = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const x = i * dx - dimensions[0] / 2;
      const z = j * dz - dimensions[1] / 2;
      positions.push(x / horizontalScale, bedInView(bed.sample(x, z).elevation), z / horizontalScale);
      normals.push(0, 1, 0);
      if (i < columns && j < rows) {
        const a = j * (columns + 1) + i;
        const b = a + columns + 1;
        triangles.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  const mineral = new PbrMaterial({ color: '#ab8a64', roughness: 0.93 });
  const foundation = new PbrMaterial({ color: '#3e5151', roughness: 0.89 });
  const darkStone = new PbrMaterial({ color: '#67675e', roughness: 0.8 });
  const paint = new PbrMaterial({ color: '#dfd5b8', roughness: 0.66 });
  const ochre = new PbrMaterial({ color: '#b48a3e', roughness: 0.62 });
  engine
    .createMesh()
    .setGeometry(new Geometry(positions, normals, triangles))
    .setMaterial(mineral);
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  part(box(size[0] + 4, 0.55, size[1] + 1.3), foundation, [0, floor - 0.29, 0]);
  for (const side of [-1, 1]) {
    const x = side * (size[0] / 2 + 1.21);
    part(box(2.4, 0.65, size[1] + 1), darkStone, [x, 7.76, 0]);
    part(box(2.4, 14.22, size[1] + 1), foundation, [x, 0.34, 0]);
    part(box(0.38, 10.0, 0.38), darkStone, [side * 21.5, -0.88, -0.64]);
    const tick = toGeometry(cylinderGeometry(0.31, 0.31, 0.12, 16));
    for (const y of [-3.375, -2.25, -1.125, 0, 1.125, 2.25, 3.375]) {
      part(tick, y === 0 ? ochre : paint, [side * 21.5, y, -0.64]);
    }
  }
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    labels.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('A tide across a closed basin', [-22.4, 10.2, -0.4], title, 1.35, '#eee0cb');
  label('Moon and Sun · vertical scale exaggerated · deep floor cropped', [-22.4, 8.65, -0.4], notes, 0.76, '#dbd4c1');
  label('WEST', [-24.1, -8.25, 0], notes, 0.82, '#d0c6a8');
  label('EAST', [20.75, -8.25, 0], notes, 0.82, '#d0c6a8');
  return labels;
}

function waterSection(engine, source) {
  // Draw the exposed face of the same accepted water column where the display crops the basin.
  const mesh = engine.createMesh().setMaterial(new PbrMaterial({ color: '#205667', roughness: 0.83 }));
  const front = -origin[1];
  const sample = { depth: 0, surface: 0, velocity: [0, 0] };
  return () => {
    const positions = [];
    const normals = [];
    const indices = [];
    let left;
    for (let i = 0; i < columns; i++) {
      const x = origin[0] + ((i + 0.5) * size[0]) / columns;
      source.sample(x, front, sample);
      const right = { x, top: sample.surface, bottom: sample.surface - sample.depth, wet: sample.depth > 0.003 };
      if (left && (left.wet || right.wet)) {
        const first = positions.length / 3;
        if (left.wet && right.wet) {
          positions.push(left.x, left.bottom, front, right.x, right.bottom, front);
          positions.push(right.x, right.top, front, left.x, left.top, front);
          normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
          indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        } else {
          const [wet, dry] = left.wet ? [left, right] : [right, left];
          const rise = Math.max(wet.top - wet.bottom, dry.bottom - wet.bottom);
          const edge = wet.x + ((dry.x - wet.x) * (wet.top - wet.bottom)) / rise;
          if (left.wet) positions.push(wet.x, wet.bottom, front, edge, wet.top, front, wet.x, wet.top, front);
          else positions.push(edge, wet.top, front, wet.x, wet.bottom, front, wet.x, wet.top, front);
          normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
          indices.push(first, first + 1, first + 2);
        }
      }
      left = right;
    }
    mesh.setGeometry(new Geometry(positions, normals, indices));
  };
}

export async function setupTideFilm() {
  const bed = makeBed();
  const active = makeTake(bed, true);
  const plain = makeTake(bed, false);
  let selected = active;
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { exactSize: [width, height], backend: 'webgpu', camera });
  engine.scene.background = '#293e45';
  engine.lighting.direction.set([-0.38, 0.65, 0.55, 2.0]);
  engine.lighting.radiance.set([0.98, 0.91, 0.78, 1]);
  engine.lighting.ambient.set([0.46, 0.54, 0.61]);
  const labels = basin(engine, bed);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.16 });
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
  const heights = Float32Array.from({ length: columns * rows }, (_, i) => {
    const x = ((i % columns) + 0.5) * dx - dimensions[0] / 2;
    const z = (Math.floor(i / columns) + 0.5) * dz - dimensions[1] / 2;
    return bedInView(bed.sample(x, z).elevation);
  });
  gpu.queue.writeTexture({ texture: terrain }, heights, { bytesPerRow: columns * 4 }, [columns, rows]);
  const water = Water.attach(engine, {
    height: floor,
    size,
    segments: 192,
    foamDistance: 0.065,
    whitecaps: 0,
    chop: 0,
    terrain: { heightmap: () => terrain, origin, size },
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
    color: [0.032, 0.132, 0.164],
  });
  const source = {
    shape: { columns, rows, width: size[0], depth: size[1], centre: [0, 0] },
    sample(x, z, out) {
      selected.hydro.sample(x * horizontalScale, z * horizontalScale, out);
      const bedHeight = bedInView(out.surface - out.depth);
      out.surface *= verticalScale;
      out.depth = Math.max(0, out.surface - bedHeight);
      out.velocity[0] /= horizontalScale;
      out.velocity[1] /= horizontalScale;
      return out;
    },
  };
  const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
  const updateSection = waterSection(engine, source);
  updateSection();
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
  const ctx = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  let checkpoint;

  function seek(take, frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const saved = action === 'restore' ? checkpoint : { bytes: take.first.bytes, frame: 0 };
      take.world.restoreSnapshot(saved.bytes);
      take.frame = saved.frame;
    }
    if (frame > take.frame) take.world.advance((take.frame = frame));
    const next = take.world.takeSnapshot();
    const before = take.records.get(frame);
    if (before && (before.length !== next.bytes.length || before.some((x, i) => x !== next.bytes[i])))
      throw new Error('Restore the exact astronomical positions, forcing potential and accepted basin water.');
    take.records.set(frame, next.bytes);
    if (action === 'save') checkpoint = { bytes: next.bytes, frame };
    return next.hash;
  }

  async function sample({ editFrame, mode, action, query = false }) {
    const frame = Math.min(easternFrame, Math.max(0, editFrame - cue));
    selected = mode === 'off' ? plain : active;
    const hash = seek(selected, frame, action);
    const { hydro, world } = selected;
    water.resetTime();
    updateSection();
    draw();
    draw();
    const commands = gpu.createCommandEncoder();
    commands.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
    gpu.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8ClampedArray(readback.getMappedRange()).slice();
    readback.unmap();
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    const sampling = query ? await WaveQuery.capture(water) : undefined;
    const displayed = ([x, z]) => {
      const value = sampling?.heightAt(x / horizontalScale, z / horizontalScale);
      return value === undefined ? null : value / verticalScale;
    };
    return {
      hash,
      frame,
      hours: (world.time * timeScale) / 3600,
      astronomy: astronomical(selected),
      shores: shore.map((p) => ({ ...hydro.sample(...p), displayed: displayed(p) })),
      sill: sill.map((p) => ({ depth: hydro.sample(...p).depth, displayed: displayed(p) })),
      current: hydro.sample(0, 0).velocity[0],
      budget: hydro.budget,
      volume: hydro.volume(),
      initialVolume: selected.volume,
      image: encoded.toDataURL('image/png').split(',')[1],
    };
  }

  await waitForPipelines(draw);
  return {
    cue,
    lunarFrame,
    westernFrame,
    turningFrame,
    easternFrame,
    sample,
    async dispose() {
      labels.dispose();
      mirror.dispose();
      terrain.destroy();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

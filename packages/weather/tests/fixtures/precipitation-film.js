import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { Line, Lines } from '@margoengine/lines';
import { FALLING_BODY_WORDS, FallingSolver } from '@margoengine/physics/falling';
import { WakeSolver, wakeRainSource } from '@margoengine/physics/sea';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { WaterWake } from '@margoengine/water/wake';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { PrecipitationField, rainFallSpeed, rainSphere, snowFallSpeed } from '@margoengine/weather/precipitation';
import { travellingGust } from '@margoengine/weather/turbulence';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 240;
const dt = 1 / rate;
const cue = 18;
const flight = 7;
const contact = 17;
const end = 36;
const gravity = 9.81;
const cells = [160, 80];
const cellSize = 0.0045;
const size = cells.map((n) => n * cellSize);
const grid = { cells, cellSize, origin: size.map((extent) => -extent / 2) };
const segments = 240;
const volumeOf = (diameter) => (Math.PI * diameter ** 3) / 6;
const makeWorld = () =>
  new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -gravity, 0], memory: worldMemory(false) });

function atmosphere(cold, gust) {
  const base = new BoundaryLayerWind({
    speed: 0.27,
    referenceHeight: 0.22,
    turbulence: false,
    seaLevelTemperature: cold ? 253.15 : 293.15,
  });
  const wind = gust
    ? travellingGust(base, { origin: [-0.15, 0, 0], start: -0.01, speed: 3, length: 0.4, amplitude: [3.5, 0, 0.4] })
    : base;
  return { base, wind, precipitation: new PrecipitationField({ rate: 24, base: 0.5, wind }) };
}

function snowAggregate(diameter, position, velocity) {
  // A compact equivalent body for the cold optical take. Brown and Francis (1995) mass–size law, SI units.
  // The actual terminal speed comes from Weather's Heymsfield and Westbrook (2010) aggregate law, doi:10.1175/2010JAS3379.1.
  const mass = 0.0185 * diameter ** 1.9;
  const volume = volumeOf(diameter);
  const area = (Math.PI * diameter ** 2) / 4;
  return {
    kind: 'sphere',
    diameter,
    position,
    velocity,
    drag(air) {
      const speed = snowFallSpeed(diameter, air);
      return (2 * (mass - air.density * volume) * air.gravity) / (air.density * area * speed ** 2);
    },
    mass,
  };
}

const paired = [-0.225, 0.31, 0.02];
const jets = [
  { diameter: 0.001, position: paired },
  { diameter: 0.0048, position: paired },
  ...Array.from({ length: 50 }, (_, i) => {
    const stagger = ((i * 47) % 53) / 53;
    return {
      diameter: [0.0012, 0.002, 0.003, 0.0045, 0.0048][i % 5],
      position: [
        -0.291 + (i % 10) * 0.059 + 0.023 * stagger,
        0.14 + 0.24 * stagger,
        -0.136 + Math.floor(i / 10) * 0.063,
      ],
    };
  }),
];

async function airTake(cold, gust) {
  const { base, wind, precipitation } = atmosphere(cold, gust);
  const bodies = jets.map(({ diameter, position }) => {
    const local = base.sample(...position, 0);
    const speed = (cold ? snowFallSpeed : rainFallSpeed)(diameter, local);
    const velocity = [local.velocity[0], -speed, local.velocity[2]];
    return cold ? snowAggregate(diameter, position, velocity) : rainSphere({ diameter, position, velocity });
  });
  const falling = await FallingSolver.load({ rate: 2 });
  const world = makeWorld().add(falling, { bodies, wind });
  return { world, falling, precipitation };
}

function poseRows(air) {
  const port = air.world.fields.port(air.falling.poseField.name);
  if (
    port?.region.layout !== 1 ||
    port.region.type !== 'f64' ||
    port.region.byteLength !== jets.length * FALLING_BODY_WORDS * Float64Array.BYTES_PER_ELEMENT
  )
    throw new Error('Use the accepted K23 layout-1 pose rows for rain and snow.');
  return regionWords(air.world.memory, port.region);
}

function crossings(prior, current) {
  const sources = [];
  for (const [i, { diameter }] of jets.entries()) {
    const row = FALLING_BODY_WORDS * i;
    const radius = diameter / 2;
    const beforeY = prior[row + 1];
    const afterY = current[row + 1];
    if (!(beforeY > radius && afterY <= radius)) continue;
    // First liquid contact on the still-water plane, interpolated within the accepted 240 Hz K23 step.
    const f = (beforeY - radius) / (beforeY - afterY);
    const at = (j) => prior[row + j] + f * (current[row + j] - prior[row + j]);
    sources.push(wakeRainSource({ x: at(0), z: at(2), diameter, fallSpeed: -at(8) }, grid, dt));
  }
  return sources;
}

function flume(engine) {
  const plate = new PbrMaterial({ color: '#656b6b', roughness: 0.8 });
  const enamel = new PbrMaterial({ color: '#303d43', roughness: 0.56 });
  const edge = new PbrMaterial({ color: '#988565', roughness: 0.52 });
  const piece = (dims, position, material) =>
    engine
      .createMesh()
      .setGeometry(box(...dims))
      .setPosition(position)
      .setMaterial(material);
  piece([0.82, 0.039, 0.44], [0, -0.078, 0], plate);
  piece([0.79, 0.064, 0.024], [0, -0.035, 0.19], enamel);
  piece([0.79, 0.064, 0.024], [0, -0.035, -0.19], enamel);
  piece([0.79, 0.006, 0.023], [0, 0.001, 0.19], edge);
  piece([0.79, 0.006, 0.023], [0, 0.001, -0.19], edge);
  for (const side of [-1, 1]) {
    piece([0.025, 0.074, 0.39], [side * 0.372, -0.034, 0], enamel);
    piece([0.024, 0.007, 0.39], [side * 0.372, 0.004, 0], edge);
    piece([0.07, 0.018, 0.074], [side * 0.314, -0.105, 0.124], enamel);
  }
  const glyphs = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const label = new Font({ family: 'Arial, sans-serif', weight: 400 });
  glyphs.add(
    new Text({
      text: 'Precipitation in a crosswind',
      position: [-0.39, 0.481, 0],
      font: title,
      fontSize: 0.035,
      color: '#eae5d7',
      billboard: true,
      onTop: true,
    }),
  );
  const notes = ['Rain · size-resolved fall and capillary rings', 'Snow · equivalent aggregates'].map((text) =>
    glyphs.add(
      new Text({
        text,
        position: [-0.389, 0.433, 0],
        font: label,
        fontSize: 0.021,
        color: '#bac8ca',
        billboard: true,
        onTop: true,
      }),
    ),
  );
  return { glyphs, notes };
}

export async function mountPrecipitationFilm() {
  const [rain, still, snow, wake, mutedWake] = await Promise.all([
    airTake(false, true),
    airTake(false, false),
    airTake(true, true),
    WakeSolver.load(),
    WakeSolver.load(),
  ]);
  let sources = [];
  const wakeParams = { cells, cellSize, depth: 0.075, surfaceTension: 0.073, density: 1000, sponge: 0, rate: 2 };
  const wet = makeWorld().add(wake, { ...wakeParams, sources: () => sources });
  const muted = makeWorld().add(mutedWake, wakeParams);
  const worlds = [rain.world, still.world, snow.world, wet, muted];
  const initial = worlds.map((world) => world.takeSnapshot());
  const accepted = new Map();
  let saved;
  let current = 0;

  function restore(point) {
    for (const [i, world] of worlds.entries()) world.restoreSnapshot(point.snapshots[i].bytes);
    current = point.frame;
  }

  function seek(frame, action) {
    if (action === 'restore') restore(saved);
    else if (frame < current) restore({ frame: 0, snapshots: initial });
    while (current < frame) {
      const before = poseRows(rain).slice();
      current++;
      for (const air of [rain, still, snow]) air.world.advance(current);
      sources = crossings(before, poseRows(rain));
      wet.advance(current);
      muted.advance(current);
    }
    const snapshots = worlds.map((world) => world.takeSnapshot());
    const before = accepted.get(current);
    if (before) {
      for (const [i, { bytes }] of snapshots.entries())
        if (before[i].bytes.length !== bytes.length || bytes.some((x, j) => x !== before[i].bytes[j]))
          throw new Error('Restore all accepted air and surface states byte for byte on the film clock.');
    } else accepted.set(current, snapshots);
    if (action === 'save') saved = { frame, snapshots };
    return snapshots.map(({ hash }) => hash);
  }

  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    exactSize: [width, height],
    antialias: false,
    backend: 'webgpu',
    camera: { position: [0, 0.512, 1.09], target: [0, 0.192, 0], fov: 32, near: 0.04, far: 8 },
  });
  engine.scene.background = '#152930';
  engine.lighting.direction.set([-0.12, 0.52, -0.84, 3.05]);
  engine.lighting.radiance.set([0.96, 0.94, 0.88, 0.94]);
  engine.lighting.ambient.set([0.42, 0.47, 0.53]);
  const { glyphs, notes } = flume(engine);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.08 });
  const water = Water.attach(engine, {
    size,
    height: 0,
    segments,
    whitecaps: 0,
    chop: 0,
    color: [0.044, 0.14, 0.175],
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 0.4 }],
  });
  let drawnWake = wake;
  const waterEffect = WaterWake.attach(engine, { surface: water, wake: { grid, heights: () => drawnWake.heights() } });
  const lines = Lines.attach(engine);
  const drops = lines.add(new Line({ mode: 'segments', color: '#b3d8e8', width: 1.12, opacity: 0.78, visible: false }));
  const flakes = lines.add(new Line({ mode: 'segments', color: '#ecede3', width: 1.9, opacity: 0.86, visible: false }));
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
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
  const png = document.createElement('canvas');
  png.width = width;
  png.height = height;
  const context = png.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  notes[1].visible = false;
  await waitForPipelines(draw);

  return {
    cue,
    flight,
    contact,
    end,
    async sample({ editFrame, mode = 'rain', action, query = false, showParticles = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const hashes = seek(frame, action);
      const air = mode === 'snow' ? snow : mode === 'still' ? still : rain;
      const isSnow = air === snow;
      drawnWake = mode === 'rain' ? wake : mutedWake;
      notes[0].visible = !isSnow;
      notes[1].visible = isSnow;
      const rows = poseRows(air);
      const strokes = [];
      let fallen = 0;
      let deposit = 0;
      // Technical exposure of accepted positions and velocities. No synthetic or repeating particle motion.
      for (const [i, { diameter }] of jets.entries()) {
        const row = i * FALLING_BODY_WORDS;
        const [x, y, z] = rows.subarray(row, row + 3);
        const [vx, vy, vz] = rows.subarray(row + 7, row + 10);
        if (y <= diameter / 2) {
          fallen++;
          if (!isSnow) deposit += volumeOf(diameter);
        } else if (frame > 0) {
          const exposure = 1 / 300;
          strokes.push(x, y, z, x - vx * exposure, y - vy * exposure, z - vz * exposure);
        }
      }
      const line = isSnow ? flakes : drops;
      line.setPositions(strokes);
      drops.visible = showParticles && !isSnow && strokes.length > 0;
      flakes.visible = showParticles && isSnow && strokes.length > 0;
      water.resetTime();
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: rgba }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8ClampedArray(readback.getMappedRange()).slice();
      readback.unmap();
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      const field = drawnWake.heights();
      let peak = 0;
      let peakIndex = 0;
      let volume = 0;
      let trough = 0;
      for (const [i, elevation] of field.entries()) {
        if (elevation > peak) {
          peak = elevation;
          peakIndex = i;
        }
        trough = Math.min(trough, elevation);
        volume += elevation * cellSize ** 2;
      }
      const vertex = (axis, cell) =>
        Math.fround(grid.origin[axis] + (Math.round(((cell + 0.5) * segments) / cells[axis]) * size[axis]) / segments);
      const x = vertex(0, peakIndex % cells[0]);
      const z = vertex(1, Math.floor(peakIndex / cells[0]));
      const drawn = query ? (await WaveQuery.capture(water)).heightAt(x, z) : null;
      const sampled = query ? drawnWake.sample(x, z).height : null;
      const phase = air.precipitation.sample(-0.15, 0.22, 0, frame * dt);
      return {
        frame,
        hashes,
        pair: [air.falling.pose(0), air.falling.pose(1)],
        fallen,
        deposit,
        visible: line.segmentCount,
        surface: { peak, trough, volume, drawn, sampled },
        phase: { rain: phase.rain.rate, snow: phase.snow.rate, speed: phase.snow.fallSpeed },
        image: png.toDataURL('image/png').split(',')[1],
      };
    },
    async dispose() {
      lines.dispose();
      glyphs.dispose();
      waterEffect.dispose();
      rgba.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

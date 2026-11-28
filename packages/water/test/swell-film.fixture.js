import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, sphereGeometry, toGeometry } from '@margoengine/geometry';
import { Physics } from '@margoengine/physics';
import { LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea } from '@margoengine/physics/sea';
import { WAVE_LAYOUT, WAVE_SPECTRUM_FIELD, WaveSolver } from '@margoengine/physics/waves';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const gravity = [0, -9.81, 0];
const density = 1025;
const buoyRadius = 0.52;
const stationX = [-40, 40];
const windEdge = -48;
const windUntil = 160;
const windProbe = -56;
const interval = 4;
const frequencies = { min: 0.19, max: 0.55, count: 7 };
const directions = 8;
const threshold = 0.05;
const cue = 14;
const duration = 236;
const width = 768;
const height = 432;
const camera = { position: [42.7, 1.23, 4.2], target: [40.22, 0.32, 0], fov: 36, near: 0.09, far: 170 };

function makeTake(enabled) {
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(x, _y, _z, t, out) {
      // Westerly gust in a 592 m upwind strip. Both the stations and the buoy sit outside the forcing.
      out.velocity[0] = enabled && x < windEdge && t < windUntil ? 26 : 0;
      out.velocity[1] = out.velocity[2] = 0;
      out.density = 1.225;
      out.temperature = 288;
      return out;
    },
  };
  // One authored frame advances one physical second; rigid buoyancy still steps at 60 Hz.
  const world = new PhysicsWorld({ rate: { num: 1, den: 1 }, gravity, memory: worldMemory(false) });
  const waves = new WaveSolver();
  world.add(waves, {
    cells: [55, 1],
    cellSize: 16,
    centre: [-200, 0],
    depth: 40,
    density,
    wind,
    frequencies,
    directions,
    interval,
    periodic: ['z'],
    physics: 'st4',
  });
  const surface = new SpectralSea({ waves: waves.field, at: [stationX[1], 0], seed: 312, gravity: -gravity[1] });
  let sourceTime = -1;
  function refresh() {
    if (sourceTime === waves.time) return;
    sourceTime = waves.time;
    surface.refresh();
  }
  const sea = {
    density,
    elevation(x, z, t) {
      refresh();
      return surface.elevation(x, z, t);
    },
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(x, y, z, t, out) {
        refresh();
        return surface.water.sample(x, y, z, t, out);
      },
    },
  };
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: 1 / 60 });
  const body = physics.addBody(null, {
    position: [stationX[1], 0, 0],
    // The test's vertical wave gauge is guided; inertia and half-submerged spherical buoyancy determine its height.
    enabledTranslations: [false, true, false],
    lockRotations: true,
    colliders: { shape: 'sphere', radius: buoyRadius, mass: (density * 2 * Math.PI * buoyRadius ** 3) / 3 },
  });
  world
    .add(new RigidSolver(), { physics })
    .add(new LoadSolver(), { sea, bodies: [{ row: body.row, shape: { sphere: buoyRadius } }] });
  world.couple(['waves', 'loads', 'rigid'], 'staggered');
  return {
    world,
    waves,
    surface,
    body,
    physics,
    refresh,
    frame: 0,
    arrival: [null, null],
    snapshots: new Map(),
    initial: world.takeSnapshot(),
  };
}

function gauge(engine) {
  // Compact spherical wave buoy. NOAA QARTOD, Fig. 2-3, shows the survey hull and high-visibility band.
  // https://repository.library.noaa.gov/view/noaa/15486/noaa_15486_DS1.pdf
  const moving = engine.createMesh();
  moving.name = 'Guided spherical wave buoy';
  const paint = (color, roughness = 0.54) => new PbrMaterial({ color, roughness });
  const band = paint('#d6a43e', 0.4),
    shell = paint('#9f593b', 0.37),
    submerged = paint('#6f493a', 0.48),
    iron = paint('#33494c'),
    zinc = paint('#a2aaa0');
  const cylinder = (a, b, h) => toGeometry(cylinderGeometry(a, b, h, 24));
  const part = (geo, material, position, parent = moving) =>
    engine.createMesh(parent).setGeometry(geo).setPosition(position).setMaterial(material);
  // Paint is drawn as adjoining rings of one sphere, preserving its physical dimensions and surface normals.
  const cap = Math.acos(0.205 / buoyRadius);
  const lip = Math.acos(0.053 / buoyRadius);
  for (const [from, to, segments, material] of [
    [0, cap, 14, shell],
    [cap, lip, 5, band],
    [lip, Math.PI, 22, submerged],
  ]) {
    part(toGeometry(sphereGeometry(buoyRadius, 44, segments, 0, 2 * Math.PI, from, to - from)), material, [0, 0, 0]);
  }
  part(cylinder(0.176, 0.19, 0.08), iron, [0, 0.486, 0]);
  part(cylinder(0.14, 0.149, 0.05), band, [0, 0.552, 0]);
  part(cylinder(0.019, 0.026, 0.4), zinc, [0, 0.77, 0]);
  part(toGeometry(sphereGeometry(0.076, 20, 12)), band, [0, 0.98, 0]);
  part(box(0.22, 0.024, 0.028), zinc, [0, 0.86, 0]);
  const fixed = engine.createMesh().setPosition([stationX[1] + 0.92, 0, -0.46]);
  fixed.name = 'Fixed depth staff';
  part(cylinder(0.041, 0.045, 1.42), iron, [0, 0.18, 0], fixed);
  for (const y of [-0.16, 0.04, 0.24, 0.44, 0.64]) part(cylinder(0.046, 0.046, 0.042), zinc, [0, y, 0], fixed);
  return moving;
}

export async function setupSwellFilm() {
  await Physics.load();
  const active = makeTake(true);
  const still = makeTake(false);
  let selected = active;
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#899da1';
  engine.lighting.direction.set([-0.35, 0.36, 0.69, 2.2]);
  engine.lighting.radiance.set([0.98, 0.93, 0.83, 1]);
  engine.lighting.ambient.set([0.49, 0.56, 0.62]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.1 });
  const water = Water.attach(engine, {
    size: [40, 34],
    segments: 120,
    horizon: true,
    whitecaps: 0,
    foamDistance: 0.012,
    chop: 0,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
    sea: { waveComponents: (t, out) => selected.surface.waveComponents(t, out) },
    color: [0.014, 0.084, 0.122],
  });
  const model = gauge(engine);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const texture = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: texture } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const output = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  let checkpoint;

  function seek(take, frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const saved = action === 'restore' ? checkpoint : { bytes: take.initial.bytes, frame: 0, arrival: [null, null] };
      take.world.restoreSnapshot(saved.bytes);
      take.frame = saved.frame;
      take.arrival = saved.arrival.slice();
    }
    while (take.frame < frame) {
      // Check each accepted spectral update, with no render sampling in the dynamics.
      const previous = take.waves.time;
      take.world.advance(++take.frame);
      if (previous === take.waves.time) continue;
      for (const [i, x] of stationX.entries()) {
        if (take.arrival[i] === null && take.waves.significantHeight(x, 0) >= threshold)
          take.arrival[i] = take.waves.time;
      }
    }
    const state = take.world.takeSnapshot();
    const old = take.snapshots.get(frame);
    if (old && (old.length !== state.bytes.length || old.some((b, i) => b !== state.bytes[i])))
      throw new Error('Keep every accepted wave spectrum and guided buoy byte exact across restore and replay.');
    take.snapshots.set(frame, state.bytes);
    if (action === 'save') checkpoint = { bytes: state.bytes, frame, arrival: take.arrival.slice() };
    take.refresh();
    return state.hash;
  }

  function measure(take) {
    const { world, waves, body } = take;
    const field = world.fields.port(WAVE_SPECTRUM_FIELD.name);
    const poses = world.fields.port(BODIES_FIELD.name);
    if (field?.region.layout !== WAVE_LAYOUT || field.region.type !== 'f64' || poses?.region.type !== 'f32')
      throw new Error('Measure the accepted layout-1 spectrum and accepted f32 buoy pose.');
    const { origin, cellSize } = waves.grid;
    const ledger = regionWords(world.memory, field.region);
    const heights = stationX.map((x) => {
      const bins = waves.sample(x, 0).energy;
      const at = Math.floor((x - origin[0]) / cellSize) * bins.length;
      if (!bins.every((value, i) => value === ledger[at + i]))
        throw new Error('Synthesize the same accepted spectrum published in the wave field.');
      return waves.significantHeight(x, 0);
    });
    const positions = regionWords(world.memory, poses.region);
    const pose = Array.from(positions.subarray(BODY_WORDS * body.row, BODY_WORDS * body.row + 3));
    return { heights, pose };
  }

  async function sample({ editFrame, mode, action, query = false }) {
    const frame = Math.min(duration, Math.max(0, editFrame - cue));
    selected = mode === 'still' ? still : active;
    const hash = seek(selected, frame, action);
    const { heights, pose } = measure(selected);
    model.setPosition(mode === 'held-buoy' ? [pose[0], 0, pose[2]] : pose);
    water.resetTime();
    water.setTime(selected.world.time);
    draw();
    draw();
    const commands = gpu.createCommandEncoder();
    commands.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
    gpu.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8ClampedArray(readback.getMappedRange()).slice();
    readback.unmap();
    output.putImageData(new ImageData(pixels, width, height), 0, 0);
    return {
      frame,
      hash,
      pose,
      heights,
      arrival: selected.arrival,
      sourceFriction: selected.waves.frictionVelocity(windProbe, 0),
      buoyFriction: selected.waves.frictionVelocity(stationX[1], 0),
      period: selected.waves.peakPeriod(stationX[1], 0),
      eta: selected.surface.elevation(stationX[1], 0, selected.world.time),
      rendered: query ? (await WaveQuery.capture(water)).heightAt(stationX[1], 0) : undefined,
      image: encoded.toDataURL('image/png').split(',')[1],
    };
  }

  await waitForPipelines(draw);
  return {
    cue,
    duration,
    windUntil,
    stationDistance: stationX[1] - stationX[0],
    frequencies,
    interval,
    sample,
    async dispose() {
      texture.destroy();
      readback.destroy();
      active.physics[Symbol.dispose]();
      still.physics[Symbol.dispose]();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}

import { EngineKernel } from '/packages/core/dist/index.js';
import { BoundaryLayerSolver } from '/packages/physics/dist/boundary-layer.js';
import { FoamSolver, SEA_FOAM_FIELD, SEA_FOAM_LAYOUT } from '/packages/physics/dist/foam.js';
import { SpectralSea } from '/packages/physics/dist/sea.js';
import { WaveSolver } from '/packages/physics/dist/waves.js';
import { PhysicsWorld, regionWords } from '/packages/physics/dist/world.js';
import { Sky } from '/packages/sky/dist/index.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { Water } from '/packages/water/dist/index.js';
import { SeaFoamSurface } from '/packages/water/dist/foam-surface.js';
import { BoundaryLayerWind } from '/packages/weather/dist/boundary-layer.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const fps = 60;
const cue = 18;
const duration = 180;
const size = [720, 428];
const cells = [64, 48];
const spacing = 1;
const origin = cells.map((n) => (-n * spacing) / 2);
const highSea = { height: 4, period: 6, direction: 0 };
const seed = 42;

async function winterSea(withFoam) {
  const world = new PhysicsWorld({ rate: { num: fps, den: 1 }, seed });
  const wind = await BoundaryLayerSolver.load({ id: 'winter-sea-wind' });
  const profile = new BoundaryLayerWind({ speed: 22, roughness: 0.0002, turbulence: false });
  world.add(wind, {
    profile: profile.profile,
    grid: { cells: [2, 4, 2], origin: [-16, 0, -16], spacing: [32, 1, 32] },
  });
  const waves = new WaveSolver();
  world.add(waves, {
    cells: [4, 4],
    cellSize: 24,
    depth: 80,
    frequencies: { count: 24, min: 0.06, max: 0.06 * 1.12 ** 23 },
    directions: 16,
    start: highSea,
    swell: highSea,
    wind,
    interval: 1,
  });
  const foam = withFoam ? await FoamSolver.load() : undefined;
  if (foam) world.add(foam, { waves: waves.field, cells, cellSize: spacing, wind, statistics: 16, windrows: false });
  const sea = new SpectralSea({ waves: waves.field, seed });
  const initial = world.takeSnapshot();
  return { wind, foam, sea, world, initial };
}

function currentRows(take) {
  const port = take.world.fields.port(SEA_FOAM_FIELD.name);
  if (!take.foam) {
    if (port) throw new Error('The physical foam producer must be disabled in the comparison world.');
    return;
  }
  if (!port || port.region.type !== 'f32' || port.region.layout !== SEA_FOAM_LAYOUT)
    throw new Error('Read the accepted layout-1 whitecap field.');
  return regionWords(take.world.memory, port.region);
}

function track(rows) {
  // An interior window leaves margin around the patch for incoming/outgoing fronts.
  let area = 0;
  let whitecaps = 0;
  let xMoment = 0;
  let activeXMoment = 0;
  let cellsWithFoam = 0;
  for (let row = 0; row < cells[1]; row++)
    for (let column = 0; column < cells[0]; column++) {
      const x = origin[0] + (column + 0.5) * spacing;
      const z = origin[1] + (row + 0.5) * spacing;
      if (x < -19 || x > 20 || z < -9 || z > 17 || !rows) continue;
      const at = 2 * (row * cells[0] + column);
      const foam = rows[at];
      const active = rows[at + 1];
      if (!(active >= 0 && active <= foam && foam <= 1)) throw new Error('Accepted coverage must be bounded.');
      if (foam > 0.04) cellsWithFoam++;
      area += foam * spacing ** 2;
      whitecaps += active * spacing ** 2;
      xMoment += foam * x * spacing ** 2;
      activeXMoment += active * x * spacing ** 2;
    }
  return {
    area,
    activeArea: whitecaps,
    residualArea: area - whitecaps,
    centroid: area > 0 ? xMoment / area : 0,
    activeCentroid: whitecaps > 0 ? activeXMoment / whitecaps : 0,
    cellsWithFoam,
  };
}

export async function setupSeaFoam() {
  const takes = { active: await winterSea(true), clear: await winterSea(false) };
  let take = takes.active;
  const sampleSea = {
    waveComponents(t, out) {
      return take.sea.waveComponents(t, out);
    },
  };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:720px;height:428px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: size,
    camera: { position: [-24, 15.2, 21], target: [2, 0.2, -5], fov: 41, near: 0.35, far: 660 },
  });
  Sky.attach(engine, { sunDirection: [-0.6, 0.35, -0.72], timeScale: 0, lighting: { intensity: 3 } });
  const water = Water.attach(engine, {
    sea: sampleSea,
    size: [125, 125],
    segments: 152,
    horizon: true,

    whitecaps: 0,
    chop: 0,
    color: [0.012, 0.12, 0.17],
  });
  Tonemap.attach(engine, { exposure: -0.19 });
  let columns = cells[0];
  const source = {
    get cells() {
      return [columns, cells[1]];
    },
    spacing,
    origin,
    copyCoverage(out) {
      const rows = currentRows(take);
      if (!rows) {
        out.fill(0);
        return;
      }
      if (2 * cells[0] * cells[1] !== rows.length) throw new Error('Match the live foam grid dimensions.');
      for (let z = 0; z < cells[1]; z++)
        for (let x = 0; x < columns; x++) out[z * columns + x] = rows[2 * (z * cells[0] + x)];
    },
  };
  const overlay = SeaFoamSurface.attach(engine, { surface: water, source });
  const device = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const draw = async () => {
    engine.render({ delta: 0 });
    await device.queue.onSubmittedWorkDone();
  };

  let saved;
  const records = new Map();
  const frames = new Map([
    [takes.active, 0],
    [takes.clear, 0],
  ]);
  async function at(shotFrame, mode, action) {
    take = takes[mode];
    const target = Math.max(0, Math.min(duration, shotFrame - cue));
    let frame = frames.get(take);
    if (action === 'restore') {
      take.world.restoreSnapshot(saved.bytes);
      frame = saved.frame;
    } else if (target < frame) {
      take.world.restoreSnapshot(take.initial.bytes);
      frame = 0;
    }
    if (target > frame) take.world.advance(target);
    frames.set(take, target);
    const snapshot = take.world.takeSnapshot();
    const key = mode + ':' + target;
    const original = records.get(key);
    if (original && (original.length !== snapshot.bytes.length || snapshot.bytes.some((x, i) => x !== original[i])))
      throw new Error('Restore and rewind must reproduce the complete accepted sea and foam bytes.');
    records.set(key, snapshot.bytes);
    if (action === 'save') saved = { bytes: snapshot.bytes, frame: target };
    const time = take.world.time;
    water.setTime(time);
    await draw();
    const waveProfile = [-15, -9, 0, 8, 17].map((x) => {
      const { height, normal } = water.sample(x, 0, time);
      return [height, ...normal];
    });
    return { hash: snapshot.hash, time, waveProfile, ...track(currentRows(take)) };
  }

  await at(0, 'active');
  await waitForPipelines(draw);
  return {
    at,
    cue,
    duration,
    async resize(crop) {
      columns = crop ? 8 : cells[0];
      await draw();
    },
    async detach() {
      overlay.dispose();
      await draw();
    },
    async dispose() {
      overlay.dispose();
      takes.active.foam.dispose();
      takes.active.wind[Symbol.dispose]();
      takes.clear.wind[Symbol.dispose]();
      const validation = (await device.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

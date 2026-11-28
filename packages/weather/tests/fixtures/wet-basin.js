import { EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { planeGeometry } from '/packages/geometry/dist/index.js';
import { LambertMaterial, createMesh } from '/packages/materials/dist/index.js';
import { FilmClock } from '/packages/math/dist/clock.js';
import { Lines, Line } from '/packages/lines/dist/index.js';
import { TerrainBed } from '/packages/physics/dist/earth.js';
import { PhysicsWorld, regionWords } from '/packages/physics/dist/world.js';
import { Font, Text, TextRenderer } from '/packages/text/dist/index.js';
import { wetColor } from '/packages/weather/dist/index.js';
import { PrecipitationField } from '/packages/weather/dist/precipitation.js';
import { SurfaceEnergySolver } from '/packages/weather/dist/surface-energy.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const fw = 720;
const fh = 424;
const xNodes = [-9, -4.5, 0, 4.5, 9];
const zNodes = [-4, 0, 4];
const band = { startX: -16, speed: 3.2, halfWidth: 5.35, halfDepth: 1.9, peak: 103 };
const capacity = 0.014;
const dryColor = [0.36, 0.245, 0.147];
const profile = { columns: 32, rows: 16, width: 24, depth: 12, centre: [0, 0] };
const origin = [-12, -6];
function elevation(x, z) {
  const ridge = Math.max(0, -z - 2.1);
  const terrace = 0.16 + 0.115 * Math.cos(0.27 * x + 0.21 * z);
  return terrace + (0.12 + 0.026 * Math.sin(0.54 * x)) * ridge * ridge + 0.012 * z;
}

function mix(a, b, f) {
  return a + f * (b - a);
}

function bilinear(wetness, x, z) {
  const u = Math.min(4, Math.max(0, (x - xNodes[0]) / 4.5));
  const v = Math.min(2, Math.max(0, (z - zNodes[0]) / 4));
  const a = Math.min(3, Math.floor(u));
  const b = Math.min(1, Math.floor(v));
  const i = a + xNodes.length * b;
  return mix(
    mix(wetness[i], wetness[i + 1], u - a),
    mix(wetness[i + xNodes.length], wetness[i + xNodes.length + 1], u - a),
    v - b,
  );
}

export async function mountWetBasin() {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const terrain = new TerrainBed();
  world.add(terrain, { ...profile, elevations: elevation });
  const bed = terrain.bed;
  const rain = new PrecipitationField({
    base: 8,
    seaLevelTemperature: 297,
    source: {
      peak: band.peak,
      rate(x, z, seconds) {
        const rx = (x - band.startX - seconds * band.speed) / band.halfWidth;
        const rz = z / band.halfDepth;
        const interior = Math.max(0, 1 - rx * rx - rz * rz);
        return band.peak * interior * interior;
      },
    },
  });
  // A shallow optical skin on the basin soil, with 14 µm of equivalent liquid capacity.
  const soil = {
    heatCapacity: 90000,
    waterCapacity: capacity,
    initialWater: 0,
    initialTemperature: 297,
    airTemperature: 295,
    deepTemperature: 296,
    humidity: 0.48,
    shortwave: 310,
    aerodynamicResistance: 24,
    surfaceResistance: 16,
  };
  const patches = zNodes.flatMap((z, row) =>
    xNodes.map((x, column) => {
      const position = [x, bed.sample(x, z).elevation, z];
      const solver = new SurfaceEnergySolver({
        id: 'basin-skin-' + row + '-' + column,
        precipitation: { field: rain, position },
      });
      world.add(solver, soil);
      return { solver, position };
    }),
  );
  const survey = { west: xNodes.length, east: xNodes.length + 3, dry: 2 * xNodes.length };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:720px;height:424px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [fw, fh],
    antialias: false,
    camera: { position: [0.47, 9.25, 25.8], target: [0, 1.22, 0], fov: 40, near: 0.35, far: 84 },
  });
  engine.scene.background = '#354e63';
  engine.lighting.direction.set([-0.44, 0.78, 0.46, 1.65]);
  engine.lighting.radiance.set([0.96, 0.92, 0.85, 0.72]);
  engine.lighting.ambient.set([0.58, 0.66, 0.74]);
  const cladding = new PbrMaterial({ color: '#584e49', roughness: 0.92 });
  const foundation = new PbrMaterial({ color: '#424951', roughness: 0.91 });
  engine
    .createMesh()
    .setGeometry(box(24.04, 0.48, 12.055))
    .setPosition([0, -0.29, 0])
    .setMaterial(cladding);
  engine
    .createMesh()
    .setGeometry(box(24.18, 0.24, 12.12))
    .setPosition([0, -0.59, 0])
    .setMaterial(foundation);
  const surface = planeGeometry(profile.width, profile.depth, profile.columns, profile.rows);
  const colors = new Float32Array((surface.positions.length / 3) * 4);
  surface.colors = colors;
  for (let i = 0; i < surface.positions.length; i += 3) {
    const x = surface.positions[i];
    const z = -surface.positions[i + 1];
    const sample = bed.sample(x, z);
    surface.positions.set([x, sample.elevation, z], i);
    surface.normals.set(sample.normal, i);
  }

  function project([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      fw * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5,
      fh * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5,
    ];
  }
  function state() {
    return patches.map(({ solver, position }) => {
      const port = world.fields.port(solver.wetnessField.name);
      const waterFlux = world.fields.port(solver.waterFluxField.name);
      if (
        !port ||
        port.region.type !== 'f64' ||
        port.region.layout !== 1 ||
        !waterFlux ||
        waterFlux.region.layout !== 1
      )
        throw new Error('Select the accepted layout-1 wetness and water flux records.');
      const wetness = regionWords(world.memory, port.region)[0];
      const [evaporation, melt, runoff] = regionWords(world.memory, waterFlux.region);
      const sample = solver.read();
      if (
        wetness !== sample.wetness ||
        evaporation !== sample.evaporation ||
        melt !== sample.melt ||
        runoff !== sample.runoff
      )
        throw new Error('The terrain uses the same state as the SurfaceEnergySolver wetness and flux ports.');
      return { ...sample, rain: rain.sample(...position, world.time).rain.rate };
    });
  }
  function paint(samples) {
    const wetness = samples.map((patch) => patch.wetness);
    for (let i = 0; i < surface.positions.length; i += 3) {
      const [x, y, z] = surface.positions.subarray(i, i + 3);
      const stone = Math.max(0, Math.min(1, (y - 0.42) / 1.7));
      const tint = 1 + 0.085 * Math.cos(0.85 * x + 0.69 * z) * Math.sin(0.59 * z - 0.12 * x);
      const soil = dryColor.map((v, k) => tint * mix(v, [0.21, 0.24, 0.183][k], stone));
      // In the production wet-soil shading, appearance follows water in the accepted skin, even after the rain moves on.
      colors.set([...wetColor(soil, bilinear(wetness, x, z)), 1], (4 * i) / 3);
    }
  }
  paint(state());
  const ground = createMesh(engine, surface, new LambertMaterial({ vertexColors: true }));

  // Cross-section rim, aligned to the front edge of the same physical bed.
  const rim = planeGeometry(profile.width, 1, profile.columns);
  for (let i = 0; i < rim.positions.length; i += 3) {
    const x = rim.positions[i];
    const z = -origin[1];
    const y = rim.positions[i + 1] > 0 ? bed.sample(x, z).elevation : -0.08;
    rim.positions.set([x, y, z], i);
  }
  createMesh(engine, rim, new LambertMaterial({ color: '#635846' }));
  const strokes = Lines.attach(engine);
  const rainLine = strokes.add(
    new Line({ mode: 'segments', color: '#a4d4eb', width: 1.05, opacity: 0.74, visible: false }),
  );
  const glyphs = TextRenderer.attach(engine);
  const heading = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const info = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize, color) =>
    glyphs.add(new Text({ text, position, font, fontSize, color, billboard: true, onTop: true }));
  label('Rain across the basin', [-14.1, 9.0, 0], heading, 1.03, '#e8edef');
  label('Wet soil darkens, then dries', [-14.02, 7.82, 0], info, 0.53, '#bdcfd9');
  const stake = new PbrMaterial({ color: '#c6a476', roughness: 0.65 });
  for (const [name, x] of [
    ['West', -9],
    ['East', 4.5],
  ]) {
    const z = 1.3;
    const y = bed.sample(x, z).elevation;
    engine
      .createMesh()
      .setGeometry(box(0.09, 0.37, 0.09))
      .setPosition([x, y + 0.181, z])
      .setMaterial(stake);
    label(name, [x - 0.3, -1.55, 6.45], info, 0.47, '#bdcfd9');
  }

  // These witnesses visualize local precipitation and its velocity over a 1/60-second shutter.
  // They never feed water or influence the solved ground.
  function rainWitness(time) {
    const segments = [];
    let moment = 0;
    let count = 0;
    for (let row = 0; row < 19; row++) {
      for (let column = 0; column < 57; column++) {
        const seed = ((row * 53 + column * 89 + row * column * 17) % 167) / 167;
        const x = -11.8 + column * 0.42 + 0.13 * seed;
        const z = -3.8 + row * 0.43 + 0.15 * seed;
        const y0 = bed.sample(x, z).elevation;
        const phase = (time * 1.25 + seed) % 1;
        const y = y0 + 0.36 + (1 - phase) * 5.1;
        const sample = rain.sample(x, y, z, time);
        if (sample.rain.rate < 20) continue;
        const [vx, vy, vz] = sample.velocity;
        segments.push(x, y, z, x - vx / 60, y - vy / 60, z - vz / 60);
        count++;
        moment += x;
      }
    }
    return { segments, count, centroid: count > 0 ? moment / count : null };
  }
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const draw = async () => {
    engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(draw);

  const film = new FilmClock({ fps: 60 });
  const start = 18;
  const last = 3540;
  const initial = world.takeSnapshot();
  const snapshots = new Map();
  let current = 0;
  let saved;
  return {
    setup: {
      start,
      last,
      probes: [
        [-9, 0],
        [4.5, 0],
        [-9, 5.5],
      ].map(([x, z]) => project([x, bed.sample(x, z).elevation, z])),
      capacity,
      band,
    },
    async at(shotFrame, displayRain, action) {
      film.frame = shotFrame;
      const goal = Math.max(0, Math.min(last, film.frame - start));
      if (action === 'restore') {
        world.restoreSnapshot(saved.snapshot.bytes);
        current = saved.frame;
      } else if (goal < current) {
        world.restoreSnapshot(initial.bytes);
      }
      world.advance(goal);
      current = goal;
      const snapshot = world.takeSnapshot();
      const before = snapshots.get(goal);
      if (!before) snapshots.set(goal, snapshot.bytes);
      else if (before.length !== snapshot.bytes.length || before.some((value, i) => value !== snapshot.bytes[i]))
        throw new Error('The rainfall and ground snapshots must replay byte for byte.');
      if (action === 'save') saved = { snapshot, frame: goal };
      const samples = state();
      paint(samples);
      ground.setGeometry(surface);
      const witness = rainWitness(world.time);
      rainLine.visible = false;
      await draw();
      if (displayRain && witness.count > 0) {
        rainLine.setPositions(witness.segments);
        rainLine.visible = true;
        await draw();
      }
      await draw();
      return {
        hash: snapshot.hash,
        time: world.time,
        rainCount: witness.count,
        rainCentroid: witness.centroid,
        rainDraws: strokes.stats.drawCalls,
        rainSegments: strokes.stats.segments,
        survey: Object.fromEntries(Object.entries(survey).map(([name, i]) => [name, samples[i]])),
      };
    },
    async dispose() {
      ground.destroy();
      strokes.dispose();
      glyphs.dispose();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}

import { EngineKernel, PbrMaterial } from '@margoengine/core';
import { boxGeometry, computeVertexNormals, geometryData, toGeometry } from '@margoengine/geometry';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { BED_FIELD, TerrainBed, bedFromPort } from '@margoengine/physics/earth';
import { RainfallRunoff } from '@margoengine/physics/runoff';
import { SYNOPTIC_LAYOUT, SYNOPTIC_WORDS, SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { PrecipitationField } from '@margoengine/weather/precipitation';
import { synopticDrive } from '@margoengine/weather/synoptic';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768,
  height = 432;
const nx = 16,
  nz = 8,
  dx = 16000;
const cell = [-5, 2, 11],
  origin = [-120000, -56000];
const displayRate = 60,
  meteorStep = 180,
  scale = displayRate * meteorStep;
const cue = 10,
  first = 7,
  ridge = 20,
  end = 34;
const east = 20,
  backgroundMoisture = 27,
  lapse = 0.0065;
const terrainShape = { columns: nx, rows: nz, width: nx * dx, depth: nz * dx, centre: [0, 0] };
const relief = 14;
const unit = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, weight) => a + (b - a) * weight;

function topography(x, z) {
  const crest = (x - 5000 * Math.sin(z / 29000)) / 23500;
  const foothill = ((x - 60000) / 30000) ** 2 + ((z - 25000) / 40000) ** 2;
  return 40 + 1450 * Math.exp(-(crest * crest + (z / 67000) ** 2)) + 140 * Math.exp(-foothill);
}

function moistureBand(x, z) {
  const along = (x + 76000 + 0.24 * z) / 23000;
  return Math.exp(-(along * along + ((z + 5000) / 38000) ** 2));
}

const centres = Array.from({ length: nx * nz }, (_, i) => [
  origin[0] + dx * (i % nx),
  origin[1] + dx * Math.floor(i / nx),
]);

async function establish(terrainFeedback) {
  const weather = await SynopticWeather.load();
  const runoff = await RainfallRunoff.load();
  const world = new PhysicsWorld({
    rate: { num: displayRate, den: 1 },
    cellSize: 4096,
    memory: worldMemory(false),
    seed: 5289,
  });
  world.add(new TerrainBed(), { ...terrainShape, elevations: topography }, cell);
  const bed = bedFromPort(world.memory, world.fields.port(BED_FIELD.name), terrainShape);
  world.add(
    weather,
    {
      cells: [nx, nz],
      spacing: [dx, dx],
      origin,
      timeScale: scale,
      cellSize: 4096,
      streamfunction: 0,
      meanWind: [east, 0],
      beta: 0,
      coriolis: 0,
      temperature: 289,
      lapseRate: lapse,
      vapour: (x, z) => backgroundMoisture + 26 * moistureBand(x, z),
      cloud: (x, z) => 0.02 * moistureBand(x, z),
      hydrometeors: (x, z) => 0.35 * moistureBand(x, z),
      cloudTime: 620,
      falloutTime: 1440,
      ...(terrainFeedback ? { bed } : {}),
    },
    cell,
  );

  const elevation = centres.map(([x, z]) => bed.sample(x, z).elevation);
  const downstream = elevation.map((height, i) =>
    [i % nx > 0 ? i - 1 : -1, i % nx < nx - 1 ? i + 1 : -1, i - nx, i + nx].reduce(
      (best, n) => (elevation[n] < (best < 0 ? height : elevation[best]) ? n : best),
      -1,
    ),
  );

  // The precipitation adapter internally uses a zero origin. Both source and wind accept the same regional
  // local coordinates; the outer runoff binding places the adapter in the live signed cell.
  const localWind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample: (...args) => weather.wind.sample(...args),
  };
  const precip = new PrecipitationField({ base: 1, source: weather.rainSource(), wind: localWind });
  world.add(
    runoff,
    {
      nx,
      nz,
      dx,
      origin: origin.map((v) => v - dx / 2),
      elevation,
      downstream,
      drainage: 0,
      conductivity: 0,
      width: 1600,
      // Each 1/60 s world tick represents 180 meteorological seconds. Scale source flux and inverse Manning
      // resistance by the same clock ratio. Keep all banked depths and cumulative volumes in physical metres.
      roughness: 0.035 / scale,
      precipitation: {
        medium: 'air',
        cell,
        sample(x, y, z, time) {
          const sample = precip.sample(x, y, z, time * scale);
          return { ...sample, rain: { ...sample.rain, rate: sample.rain.rate * scale } };
        },
      },
    },
    cell,
  );
  world.couple([weather.id, runoff.describe().id], 'staggered');
  const probes = centres.map(([x, z], i) => synopticDrive(weather, () => [x, elevation[i], z]));
  return {
    weather,
    runoff,
    world,
    bed,
    probes,
    elevation,
    frame: 0,
    saved: new Map([[0, world.takeSnapshot()]]),
    visited: new Map(),
  };
}

function exact(actual, expected) {
  if (actual.length !== expected.length || actual.some((value, i) => value !== expected[i]))
    throw new Error('Return every accepted atmospheric, terrain and drainage snapshot byte at this editor frame.');
}

function seek(take, frame, action) {
  const { world, saved, visited } = take;
  if (action === 'restore') {
    const checkpoint = saved.get(frame);
    world.restoreSnapshot(checkpoint.bytes);
    exact(world.takeSnapshot().bytes, checkpoint.bytes);
  } else {
    if (frame < take.frame) world.restoreSnapshot(saved.get(0).bytes);
    if (frame !== take.frame) world.advance(frame);
  }
  take.frame = frame;
  const snapshot = world.takeSnapshot();
  if (visited.has(frame)) exact(snapshot.bytes, visited.get(frame));
  visited.set(frame, snapshot.bytes);
  if (action === 'save') saved.set(frame, snapshot);
  return snapshot.hash;
}

function takeFields(take) {
  const { weather, world, runoff } = take;
  const source = weather.exportPorts(0)[0];
  const atmosphere = world.fields.port(source.field);
  const rain = world.fields.port(runoff.outletField.name);
  const words = regionWords(world.memory, atmosphere.region);
  if (atmosphere.region.layout !== SYNOPTIC_LAYOUT || words.length !== nx * nz * SYNOPTIC_WORDS)
    throw new Error('Read the registered synoptic 12-word regional grid at the accepted frame.');
  const cells = centres.map(([x, z], i) => {
    const sample = weather.sample(x, z);
    const at = i * SYNOPTIC_WORDS;
    const probe = take.probes[i].state;
    const drain = runoff.read(i % nx, Math.floor(i / nx));
    if (sample.precipitation !== words[at + 9] || sample.cloud !== words[at + 7] || sample.vapour !== words[at + 6])
      throw new Error('Use the same accepted column water quantities as the published regional grid.');
    return {
      x,
      z,
      elevation: take.elevation[i],
      air: sample.seaTemperature,
      vapour: sample.vapour,
      cloud: sample.cloud,
      drops: sample.hydrometeors,
      precipitation: sample.precipitation,
      lift: sample.lift,
      temperature: probe.temperature,
      cloudCover: probe.cloud,
      rain: probe.rain,
      snow: probe.snow,
      depth: drain.depth,
      outflow: drain.outflow,
    };
  });
  const peak = cells.reduce((best, row) => (row.precipitation > best.precipitation ? row : best));
  const cold = synopticDrive(weather, () => [peak.x, 4300, peak.z]).state;
  return { cells, cold, weather: weather.budget, runoff: runoff.budget, ports: [atmosphere.cell, rain.cell] };
}

function reliefMesh(engine, bed) {
  const columns = 80,
    rows = 40;
  const positions = [],
    uv = [],
    index = [],
    base = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const x = (-nx * dx) / 2 + (i * nx * dx) / columns,
        z = (-nz * dx) / 2 + (j * nz * dx) / rows;
      const height = bed.sample(x, z).elevation;
      positions.push(x / dx, (relief * height) / dx, z / dx);
      uv.push(i / columns, j / rows);
      const alpine = unit((height - 360) / 1120);
      const contour = 0.5 + 0.5 * Math.sin((height / 92 + 0.06 * Math.sin(z / 16000)) * 2 * Math.PI);
      const warm = Math.sin(x / 17000 + 0.7 * Math.cos(z / 9200)) * 0.025;
      const ink = 1 - 0.07 * contour ** 12;
      base.push([
        x,
        z,
        mix(0.22, 0.44, alpine) * ink + warm,
        mix(0.29, 0.42, alpine) * ink + 0.7 * warm,
        mix(0.195, 0.38, alpine) * ink,
      ]);
      if (i < columns && j < rows) {
        const a = i + j * (columns + 1),
          b = a + columns + 1;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const data = computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uv, index));
  data.colors = new Float32Array(4 * base.length);
  function shade(cells, showRunoff) {
    for (const [i, [x, z, r, g, b]] of base.entries()) {
      const gx = Math.min(nx - 1, Math.max(0, (x - origin[0]) / dx));
      const gz = Math.min(nz - 1, Math.max(0, (z - origin[1]) / dx));
      const ix = Math.floor(gx),
        iz = Math.floor(gz);
      const offset = ix + iz * nx;
      const e = ix < nx - 1 ? 1 : 0,
        n = iz < nz - 1 ? nx : 0;
      const field = (key) =>
        mix(
          mix(cells[offset][key], cells[offset + e][key], gx - ix),
          mix(cells[offset + n][key], cells[offset + n + e][key], gx - ix),
          gz - iz,
        );
      const cloud = 0.26 * field('cloudCover');
      const rain = 0.75 * unit((field('rain') / 0.4) ** 1.5);
      const runoff = showRunoff ? (0.77 - 0.5 * rain) * unit(Math.sqrt((1000 * field('depth')) / 12)) : 0;
      const haze = [r, g, b].map((channel, k) => mix(channel, [0.77, 0.85, 0.84][k], cloud));
      const weather = haze.map((channel, k) => mix(channel, [0.065, 0.43, 0.76][k], rain));
      const visible = weather.map((channel, k) => mix(channel, [0.025, 0.43, 0.38][k], runoff));
      data.colors.set([...visible, 1], 4 * i);
    }
  }
  const solid = new PbrMaterial({ color: '#544d42', roughness: 0.85 });
  engine
    .createMesh()
    .setGeometry(toGeometry(boxGeometry(16.1, 0.43, 8.1)))
    .setMaterial(solid)
    .setPosition([0, -0.23, 0]);
  engine
    .createMesh()
    .setGeometry(toGeometry(boxGeometry(16.75, 0.24, 8.75)))
    .setMaterial(new PbrMaterial({ color: '#354953', roughness: 0.82 }))
    .setPosition([0, -0.55, 0]);
  const material = new SurfaceMaterial({ vertexColors: true, roughness: 0.92 });
  let mesh;
  return {
    update(cells, showRunoff = true) {
      shade(cells, showRunoff);
      if (mesh) mesh.setGeometry(data);
      else mesh = createMesh(engine, data, material);
    },
  };
}

export async function mountSynopticFilm() {
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [-2.1, 11.9, 13.6], target: [0, 0.15, 0.15], fov: 39, near: 0.15, far: 55 },
  });
  engine.scene.background = '#1d2b34';
  engine.lighting.direction.set([-0.69, 0.74, 0.45, 1.55]);
  engine.lighting.radiance.set([1, 0.94, 0.82, 1]);
  engine.lighting.ambient.set([0.41, 0.51, 0.63]);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.09 });
  const takes = await Promise.all([establish(true), establish(false)]);
  const relief = reliefMesh(engine, takes[0].bed);
  relief.update(takeFields(takes[0]).cells);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 700 });
  const sub = new Font({ family: 'Arial, sans-serif', weight: 500 });
  labels.add(
    new Text({
      text: 'An inland rain band crosses the ridge',
      position: [-8.4, 3.37, -3],
      font: title,
      fontSize: 0.42,
      color: '#e1e9e9',
      billboard: true,
      onTop: true,
    }),
  );
  const subtitle = labels.add(
    new Text({
      text: 'Terrain uplift enabled',
      position: [-8.4, 2.94, -3],
      font: sub,
      fontSize: 0.26,
      color: '#b4cdd1',
      billboard: true,
      onTop: true,
    }),
  );
  labels.add(
    new Text({
      text: 'Blue: rain · Teal: runoff storage',
      position: [-7.12, 0.14, 4.65],
      font: sub,
      fontSize: 0.28,
      color: '#c2d6d5',
      billboard: true,
      onTop: true,
    }),
  );
  const receipt = labels.add(
    new Text({
      text: 'West → East',
      position: [2.03, 0.14, 4.65],
      font: sub,
      fontSize: 0.27,
      color: '#c2d6d5',
      billboard: true,
      onTop: true,
    }),
  );
  const gpu = engine.gpu,
    errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
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
    first,
    ridge,
    end,
    meteorStep,
    dx,
    east,
    backgroundMoisture,
    lapse,
    cell,
    nx,
    nz,
    scan() {
      return takes.map((take) => {
        const { world, saved } = take;
        const prior = world.takeSnapshot();
        world.restoreSnapshot(saved.get(0).bytes);
        const all = [];
        for (let tick = 0; tick <= end; tick++) {
          world.advance(tick);
          all.push(takeFields(take));
        }
        world.restoreSnapshot(prior.bytes);
        exact(world.takeSnapshot().bytes, prior.bytes);
        return all;
      });
    },
    async sample({ editFrame, action, hideRunoff = false }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = [];
      for (const [i, take] of takes.entries()) {
        const hash = seek(take, frame, action),
          accepted = takeFields(take);
        relief.update(accepted.cells, !hideRunoff);
        subtitle.text =
          i === 0
            ? 'Terrain uplift enabled · 16 km grid · Relief ×14'
            : 'Terrain uplift off · Same grid, wind and moisture';
        receipt.text = `+${(frame * meteorStep) / 60} min · ${(accepted.runoff.rain / 1e6).toFixed(1)} million m³ rain`;
        await waitForPipelines(draw);
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const rgba = new Uint8ClampedArray(output.getMappedRange()).slice();
        output.unmap();
        pixels.putImageData(new ImageData(rgba, width, height), 0, 0);
        states.push({ hash, ...accepted, image: encoded.toDataURL('image/png').split(',')[1] });
      }
      return { frame, matrix: Array.from(engine.camera.matrix), states };
    },
    async dispose() {
      for (const { weather, runoff } of takes) {
        weather[Symbol.dispose]?.();
        runoff[Symbol.dispose]?.();
      }
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}
